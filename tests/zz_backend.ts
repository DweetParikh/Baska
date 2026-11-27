// Backend integration: embedded Postgres (PGlite) + Redis + indexer + snapshotter + REST API,
// driven by real on-chain activity. File name sorts after baska.ts so the shared validator
// already has config + history to backfill from.
import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { MockFeedProvider, PriceQuote } from "../keeper/src/chain";
import { buildApp } from "../api/src/app";
import { MemoryCache, RedisCache, Cache } from "../api/src/cache";
import { fromBase6, toBase6 } from "../api/src/convert";
import { createDb, Db } from "../api/src/db";
import { Faucet } from "../api/src/faucet";
import { startEmbeddedPostgres, EmbeddedPostgres } from "../api/src/embeddedDb";
import { Indexer } from "../api/src/indexer";
import { CachedMarketData } from "../api/src/prices";
import { readLiveHoldings, Snapshotter } from "../api/src/snapshots";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const idl = require("../target/idl/baska_vault.json");
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider) as any;
const conn = provider.connection;
const admin = (provider.wallet as anchor.Wallet).payer;

const USDC = 1_000_000n;
const FUND_ID = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const testLog = (level: string, msg: string, extra?: Record<string, unknown>) => {
  if (level !== "info") console.log(`      [indexer ${level}] ${msg} ${JSON.stringify(extra ?? {})}`);
};
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];

async function waitFor<T>(fn: () => Promise<T | null | false>, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

describe("backend: conversions, cache, price service", () => {
  it("6-decimal conversions round-trip", () => {
    for (const v of [0n, 1n, 999_999n, 1_000_000n, 123_456_789n, -42_000_001n]) {
      expect(toBase6(fromBase6(v))).to.equal(v);
    }
    expect(fromBase6(1_500_000n)).to.equal("1.500000");
    expect(toBase6("2.5")).to.equal(2_500_000n);
  });

  it("price service serves repeat reads from cache within the TTL, preserving publishTime", async () => {
    let calls = 0;
    const quote: PriceQuote = { price: 12345n, expo: -8, conf: 7n, publishTime: 1_700_000_000 };
    const svc = new CachedMarketData({ getPrices: async (f) => (calls++, f.map(() => quote)) }, new MemoryCache(), 5);
    const feeds = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const a = await svc.getPrices(feeds);
    const b = await svc.getPrices(feeds);
    expect(calls).to.equal(1);
    expect(b).to.deep.equal(a);
    expect(b[0].publishTime).to.equal(1_700_000_000);
    // partial miss only fetches the missing feed
    await svc.getPrices([feeds[0], Keypair.generate().publicKey]);
    expect(calls).to.equal(2);
  });
});

describe("backend: indexer + snapshots + REST API (live validator)", function () {
  this.timeout(180_000);

  let pg: EmbeddedPostgres;
  let db: Db;
  let cache: Cache;
  let usingRedis = false;
  let indexer: Indexer;
  let snapshotter: Snapshotter;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const user = Keypair.generate();
  let usdcMint: PublicKey;
  const stocks = [
    { sym: "mAAPL", dec: 9, usd: 200n, mint: PublicKey.default, feed: Keypair.generate(), vault: PublicKey.default },
    { sym: "mMU", dec: 6, usd: 50n, mint: PublicKey.default, feed: Keypair.generate(), vault: PublicKey.default },
  ];
  let fundKey: PublicKey;
  let shareMint: PublicKey;
  let usdcVault: PublicKey;
  let userUsdc: PublicKey;
  let userShares: PublicKey;
  let sharesBeforeRedeem = 0n;
  let expectedTvl = 0n;
  const REDEEM_SHARES = 20n * USDC;

  const px = (usd: bigint) => new BN((usd * 100_000_000n).toString());
  const ata = async (mint: PublicKey, owner: PublicKey, off = false) =>
    (await getOrCreateAssociatedTokenAccount(conn, admin, mint, owner, off)).address;
  const refreshFeeds = async () => {
    for (const s of stocks)
      await program.methods.setMockPrice(px(s.usd), new BN(0)).accounts({ authority: admin.publicKey, feed: s.feed.publicKey }).rpc();
  };
  const oracle = () =>
    stocks.flatMap((s) => [
      { pubkey: s.vault, isWritable: false, isSigner: false },
      { pubkey: s.feed.publicKey, isWritable: false, isSigner: false },
    ]);
  const accts = () => ({
    user: user.publicKey,
    fund: fundKey,
    usdcMint,
    shareMint,
    usdcVault,
    userUsdc,
    userShares,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  before(async () => {
    // --- infrastructure under test
    pg = await startEmbeddedPostgres(5544);
    db = createDb(pg.url, { maxConnections: 1 });
    const redis = new RedisCache("redis://127.0.0.1:6379", `baska:test:${Date.now()}:`);
    usingRedis = await redis.ping();
    cache = usingRedis ? redis : new MemoryCache();
    console.log(`      (cache backend: ${cache.kind})`);

    // --- chain setup (reuses config from baska.ts when present)
    const configKey = pda([Buffer.from("config")]);
    const existing = await program.account.globalConfig.fetchNullable(configKey);
    if (existing) {
      usdcMint = existing.usdcMint;
    } else {
      usdcMint = await createMint(conn, admin, admin.publicKey, null, 6);
      await program.methods
        .initializeConfig(admin.publicKey, admin.publicKey, 100)
        .accounts({ admin: admin.publicKey, config: configKey, usdcMint, systemProgram: SystemProgram.programId })
        .rpc();
    }
    await conn.confirmTransaction(await conn.requestAirdrop(user.publicKey, 3 * LAMPORTS_PER_SOL));
    userUsdc = await ata(usdcMint, user.publicKey);
    await mintTo(conn, admin, usdcMint, userUsdc, admin, 10_000n * USDC);

    fundKey = pda([Buffer.from("fund"), new BN(FUND_ID).toArrayLike(Buffer, "le", 8)]);
    for (const s of stocks) {
      s.mint = await createMint(conn, admin, admin.publicKey, null, s.dec);
      await program.methods
        .initMockFeed(px(s.usd), -8, new BN(0))
        .accounts({ authority: admin.publicKey, feed: s.feed.publicKey })
        .signers([s.feed])
        .rpc();
      s.vault = await ata(s.mint, fundKey, true);
    }
    const name = Buffer.alloc(32);
    name.write("Backend Test Fund");
    await program.methods
      .createFund(
        new BN(FUND_ID),
        Array.from(name),
        50,
        new BN(Number(USDC)),
        new BN(1e12),
        500,
        stocks.map((s) => ({ priceFeed: s.feed.publicKey, targetWeightBps: 5000 }))
      )
      .accounts({ admin: admin.publicKey, fund: fundKey, usdcMint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .remainingAccounts(stocks.flatMap((s) => [
        { pubkey: s.mint, isWritable: false, isSigner: false },
        { pubkey: s.vault, isWritable: false, isSigner: false },
      ]))
      .rpc();
    const f = await program.account.fund.fetch(fundKey);
    shareMint = f.shareMint;
    usdcVault = f.usdcVault;
    userShares = await ata(shareMint, user.publicKey);

    // --- backend wiring (mirrors api/src/index.ts)
    const market = new CachedMarketData(new MockFeedProvider(program), cache, 8);
    snapshotter = new Snapshotter({ db, conn, program, market, maxPriceAgeSecs: 50 });
    const symbols = Object.fromEntries(stocks.map((s) => [s.mint.toBase58(), s.sym]));
    indexer = new Indexer({ db, conn, program, symbols, log: testLog, onFundActivity: (id) => snapshotter.snapshotFund(id) });
    app = await buildApp({
      db,
      cache,
      cluster: "localnet",
      corsOrigin: "http://localhost:3000",
      rateLimitPerMin: 10_000,
      liveHoldings: (addr) => readLiveHoldings({ conn, program, market }, addr),
    });
    indexer.start();
  });

  after(async () => {
    await indexer?.stop();
    snapshotter?.stop();
    await app?.close();
    await cache?.close();
    await db?.$disconnect();
    await pg?.stop();
  });

  it("indexes live deposits and redemptions into Tx + Position rows", async () => {
    await refreshFeeds();
    for (const amt of [100n, 50n]) {
      await program.methods.deposit(new BN((amt * USDC).toString()), new BN(0)).accounts(accts()).remainingAccounts(oracle()).signers([user]).rpc();
    }
    sharesBeforeRedeem = (await getAccount(conn, userShares)).amount;
    await refreshFeeds();
    await program.methods.redeemUsdc(new BN(REDEEM_SHARES.toString()), new BN(0)).accounts(accts()).remainingAccounts(oracle()).signers([user]).rpc();

    const w = user.publicKey.toBase58();
    await waitFor(async () => (await db.tx.count({ where: { wallet: w } })) === 3, "3 indexed txs");

    const txs = await db.tx.findMany({ where: { wallet: w }, orderBy: { ts: "asc" } });
    expect(txs.map((t) => t.kind).sort()).to.deep.equal(["deposit", "deposit", "redeem"]);

    // INVARIANT: indexed shares == on-chain share token balance.
    const onchain = (await getAccount(conn, userShares)).amount;
    const pos = await db.position.findUniqueOrThrow({ where: { wallet_fundId: { wallet: w, fundId: FUND_ID } } });
    expect(toBase6(pos.shares)).to.equal(onchain);

    // Weighted-average cost basis: burning X% of shares removes X% of basis.
    // TVL after the redeem: 150 in, minus floor(shares * NAV / supply) out. Supply includes the
    // 1,000 dead shares, so shares are worth slightly less than $1 each (not exactly 130.000000).
    const usdcOut = (REDEEM_SHARES * 150n * USDC) / (sharesBeforeRedeem + 1_000n);
    expectedTvl = 150n * USDC - usdcOut;
    const expectedCost = (150n * USDC * (sharesBeforeRedeem - REDEEM_SHARES)) / sharesBeforeRedeem;
    expect(toBase6(pos.costBasis)).to.equal(expectedCost);
  });

  it("creates the fund + labelled components from chain state", async () => {
    const f = await db.fund.findUniqueOrThrow({ where: { id: FUND_ID }, include: { components: true } });
    expect(f.address).to.equal(fundKey.toBase58());
    expect(f.name).to.equal("Backend Test Fund");
    expect(f.components.map((c) => c.symbol).sort()).to.deep.equal(["mAAPL", "mMU"]);
    expect(f.components.every((c) => c.weightBps === 5000)).to.equal(true);
  });

  it("records NAV snapshots on activity", async () => {
    const snaps = await waitFor(async () => {
      const s = await db.navSnapshot.findMany({ where: { fundId: FUND_ID }, orderBy: { ts: "asc" } });
      return s.length >= 3 ? s : null;
    }, "NAV snapshots");
    const last = snaps[snaps.length - 1];
    // No swaps happened, so the fund holds only idle USDC: NAV/share just under $1 (dead shares).
    const nps = Number(last.navPerShare.toFixed(6));
    expect(nps).to.be.within(0.99, 1.0);
    expect(toBase6(last.tvlUsd)).to.equal(expectedTvl);
  });

  it("is idempotent: re-processing the whole history changes nothing", async () => {
    // Only backfill advances the cursor (the live listener deliberately doesn't, so a dropped
    // websocket message can never be skipped). The first pass therefore also catches up on history
    // the live listener never saw: here, the other test suites' funds.
    await indexer.backfill();
    const before = { tx: await db.tx.count(), pos: await db.position.count(), funds: await db.fund.count() };
    expect(before.tx).to.be.at.least(3);
    // From here on, re-processing (including txs the live listener already handled) must be a no-op.
    await indexer.backfill();
    await indexer.backfill();
    const after = { tx: await db.tx.count(), pos: await db.position.count(), funds: await db.fund.count() };
    expect(after).to.deep.equal(before);
    const pos = await db.position.findUniqueOrThrow({ where: { wallet_fundId: { wallet: user.publicKey.toBase58(), fundId: FUND_ID } } });
    expect(toBase6(pos.shares)).to.equal((await getAccount(conn, userShares)).amount);
  });

  it("rebuilds identical state from chain history after a wipe (backfill from scratch)", async () => {
    const w = user.publicKey.toBase58();
    const snapshot = async () => ({
      txs: (await db.tx.findMany({ where: { wallet: w }, orderBy: { id: "asc" } })).map((t) => `${t.id}|${t.kind}|${t.usdc}|${t.shares}`),
      pos: (await db.position.findMany({ where: { wallet: w } })).map((p) => `${p.fundId}|${p.shares}|${p.costBasis}`),
    });
    const before = await snapshot();
    expect(before.txs, "precondition: live indexing produced rows").to.have.length(3);
    expect(before.pos).to.have.length(1);

    await indexer.stop();
    await db.navSnapshot.deleteMany();
    await db.tx.deleteMany();
    await db.position.deleteMany();
    await db.fundComponent.deleteMany();
    await db.fund.deleteMany();
    await db.indexerState.deleteMany();

    const replay = new Indexer({ db, conn, program, log: testLog });
    const handled = await replay.backfill();
    expect(handled).to.be.greaterThan(3);
    expect(await snapshot()).to.deep.equal(before);
    // cursor persisted: a second run has nothing new to do
    expect(await replay.backfill()).to.equal(0);

    // restore labels + resume live indexing for the API tests below
    await db.fundComponent.updateMany({ where: { mint: stocks[0].mint.toBase58() }, data: { symbol: "mAAPL" } });
    await db.fundComponent.updateMany({ where: { mint: stocks[1].mint.toBase58() }, data: { symbol: "mMU" } });
    await snapshotter.snapshotFund(FUND_ID);
    indexer.start();
  });

  describe("REST API", () => {
    const get = async (url: string) => {
      const r = await app.inject({ method: "GET", url });
      return { status: r.statusCode, body: r.json() as any };
    };

    it("GET /health", async () => {
      const r = await get("/health");
      expect(r.status).to.equal(200);
      expect(r.body).to.include({ ok: true, db: true });
      expect(r.body.cache.kind).to.equal(cache.kind);
      expect(r.body.indexer.lastSlot).to.be.a("string");
    });

    it("GET /funds lists the fund with NAV, TVL, components", async () => {
      const { status, body } = await get("/funds");
      expect(status).to.equal(200);
      const f = body.funds.find((x: any) => x.id === FUND_ID);
      expect(f.name).to.equal("Backend Test Fund");
      expect(f.navPerShare).to.match(/^0\.9\d{5}$|^1\.000000$/);
      expect(f.tvlUsd).to.equal(fromBase6(expectedTvl));
      expect(f.components.map((c: any) => c.symbol).sort()).to.deep.equal(["mAAPL", "mMU"]);
      expect(f.performance).to.deep.equal({ "1d": null, "7d": null, "30d": null }); // not enough history yet
    });

    it("computes 1D/7D/30D performance from historical snapshots", async () => {
      const latest = await db.navSnapshot.findFirstOrThrow({ where: { fundId: FUND_ID }, orderBy: { ts: "desc" } });
      const mk = (nav: string, daysAgo: number) =>
        db.navSnapshot.create({
          data: { fundId: FUND_ID, navPerShare: nav, tvlUsd: "10.000000", totalShares: "20.000000", ts: new Date(Date.now() - daysAgo * 86_400_000) },
        });
      const pct = (base: number) => (Number(latest.navPerShare.toFixed(6)) / base - 1) * 100;
      const perf = async () => (await get("/funds")).body.funds.find((x: any) => x.id === FUND_ID).performance;

      // Only 2 days of history: 1D is computable, 7D / 30D are "not enough history" (null), never a guess.
      await mk("0.500000", 2);
      let p = await perf();
      expect(p["1d"]).to.be.closeTo(pct(0.5), 0.01);
      expect(p["7d"]).to.equal(null);
      expect(p["30d"]).to.equal(null);

      // Add an 8-day-old point: 7D now uses it, 1D still uses the newest snapshot older than a day.
      await mk("0.250000", 8);
      p = await perf();
      expect(p["1d"]).to.be.closeTo(pct(0.5), 0.01);
      expect(p["7d"]).to.be.closeTo(pct(0.25), 0.01);
      expect(p["30d"]).to.equal(null);
    });

    it("GET /funds/:id includes live holdings (target vs actual) and explorer links", async () => {
      await refreshFeeds();
      const { status, body } = await get(`/funds/${FUND_ID}`);
      expect(status).to.equal(200);
      expect(body.holdings.navUsd).to.equal(fromBase6(expectedTvl));
      expect(body.holdings.idleUsdc).to.equal(fromBase6(expectedTvl));
      const aapl = body.holdings.components.find((c: any) => c.symbol === "mAAPL");
      expect(aapl).to.include({ targetBps: 5000, actualBps: 0, balance: "0" });
      expect(body.links.fund).to.include(fundKey.toBase58());
    });

    it("GET /funds/:id/nav returns an ascending series for the range", async () => {
      const day = await get(`/funds/${FUND_ID}/nav?range=1d`);
      expect(day.status).to.equal(200);
      expect(day.body.points.length).to.be.greaterThan(0);
      const all = await get(`/funds/${FUND_ID}/nav?range=all`);
      expect(all.body.points.length).to.be.greaterThan(day.body.points.length); // includes the 2-day-old point
      const ts = all.body.points.map((p: any) => Date.parse(p.ts));
      expect([...ts].sort((a, b) => a - b)).to.deep.equal(ts);
    });

    it("GET /portfolio/:wallet reports shares, value and P&L from NAV x shares vs cost basis", async () => {
      const { status, body } = await get(`/portfolio/${user.publicKey.toBase58()}`);
      expect(status).to.equal(200);
      const p = body.positions.find((x: any) => x.fundId === FUND_ID);
      const onchain = (await getAccount(conn, userShares)).amount;
      expect(p.shares).to.equal(fromBase6(onchain));
      const value = (onchain * toBase6(p.navPerShare)) / 1_000_000n;
      expect(p.valueUsd).to.equal(fromBase6(value));
      expect(p.pnlUsd).to.equal(fromBase6(value - toBase6(p.costBasis)));
      expect(body.totals.valueUsd).to.equal(p.valueUsd);
    });

    it("GET /portfolio/:wallet/txs paginates newest first", async () => {
      const w = user.publicKey.toBase58();
      const page1 = await get(`/portfolio/${w}/txs?limit=2`);
      expect(page1.body.txs).to.have.length(2);
      expect(page1.body.txs[0].kind).to.equal("redeem");
      expect(page1.body.nextBefore).to.be.a("string");
      const page2 = await get(`/portfolio/${w}/txs?limit=2&before=${encodeURIComponent(page1.body.nextBefore)}`);
      expect(page2.body.txs).to.have.length(1);
      expect(page2.body.txs[0].kind).to.equal("deposit");
      expect(page2.body.nextBefore).to.equal(null);
    });

    it("unknown wallets get an empty portfolio, not an error", async () => {
      const { status, body } = await get(`/portfolio/${Keypair.generate().publicKey.toBase58()}`);
      expect(status).to.equal(200);
      expect(body.positions).to.deep.equal([]);
      expect(body.totals.valueUsd).to.equal("0.000000");
    });

    it("validates input: 400 for bad params, 404 for unknown funds", async () => {
      expect((await get("/funds/abc")).status).to.equal(400);
      expect((await get("/funds/-1")).status).to.equal(400);
      expect((await get("/funds/9999")).status).to.equal(404);
      expect((await get(`/funds/${FUND_ID}/nav?range=forever`)).status).to.equal(400);
      expect((await get("/portfolio/not-a-wallet")).status).to.equal(400);
      expect((await get(`/portfolio/${user.publicKey.toBase58()}/txs?limit=0`)).status).to.equal(400);
    });

    it("rate-limits abusive clients", async () => {
      const limited = await buildApp({ db, cache: new MemoryCache(), cluster: "localnet", corsOrigin: "*", rateLimitPerMin: 3 });
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await limited.inject({ method: "GET", url: "/funds" })).statusCode);
      await limited.close();
      expect(codes).to.deep.equal([200, 200, 200, 429, 429]);
    });

    it("POST /faucet mints mock USDC once per cooldown; absent unless configured", async () => {
      const mkApp = (faucet?: Faucet) =>
        buildApp({ db, cache, cluster: "localnet", corsOrigin: "*", rateLimitPerMin: 10_000, faucet });
      const faucet = new Faucet({ conn, payer: admin, usdcMint, amount: 250n * USDC, cooldownSecs: 60, cache });
      await faucet.assertCanMint();
      const withFaucet = await mkApp(faucet);
      const without = await mkApp();

      const wallet = Keypair.generate().publicKey;
      const post = (a: typeof withFaucet, w: string) => a.inject({ method: "POST", url: "/faucet", payload: { wallet: w } });

      const r1 = await post(withFaucet, wallet.toBase58());
      expect(r1.statusCode, r1.body).to.equal(200);
      expect(r1.json().amountUsdc).to.equal("250.000000");
      const bal = (await getAccount(conn, new PublicKey(r1.json().tokenAccount))).amount;
      expect(bal).to.equal(250n * USDC);

      const r2 = await post(withFaucet, wallet.toBase58());
      expect(r2.statusCode).to.equal(429);
      expect(r2.json().error).to.equal("cooldown");

      expect((await post(withFaucet, "nope")).statusCode).to.equal(400);
      expect((await post(without, wallet.toBase58())).statusCode).to.equal(404); // disabled by default
      // a key that is not the mint authority is refused at startup, not at first request
      let threw = false;
      try {
        await new Faucet({ conn, payer: Keypair.generate(), usdcMint, amount: USDC, cooldownSecs: 1, cache }).assertCanMint();
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
      await withFaucet.close();
      await without.close();
    });

    it("sends CORS headers for the configured origin", async () => {
      const r = await app.inject({ method: "GET", url: "/funds", headers: { origin: "http://localhost:3000" } });
      expect(r.headers["access-control-allow-origin"]).to.equal("http://localhost:3000");
    });
  });
});
