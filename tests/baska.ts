import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import {
  createMint,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { MockFeedProvider, sendSwap, snapshotFund } from "../keeper/src/chain";
import { currentDrift, planSwap } from "../keeper/src/plan";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const idl = require("../target/idl/baska_vault.json");

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider) as any;
const conn = provider.connection;
const admin = (provider.wallet as anchor.Wallet).payer;

const USDC = 1_000_000n;
/** Advance the Surfpool network clock by `seconds` (surfnet_timeTravel cheatcode). */
async function timeTravel(seconds: number) {
  const nowOf = async () => (await conn.getBlockTime(await conn.getSlot())) ?? 0;
  const before = await nowOf();
  await fetch(conn.rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_timeTravel",
      params: [{ absoluteTimestamp: (before + seconds) * 1000 }], // ms
    }),
  });
  const after = await nowOf();
  // Block time is slot-quantised, so only require "clearly advanced".
  expect(after - before, "network clock should advance").to.be.at.least(Math.floor(seconds * 0.6));
}

const pda = (seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const fundPda = (id: number) => pda([Buffer.from("fund"), new BN(id).toArrayLike(Buffer, "le", 8)]);

async function expectErr(p: Promise<unknown>, name: string) {
  try {
    await p;
  } catch (e: any) {
    const msg = `${e?.message ?? ""} ${(e?.logs ?? []).join(" ")} ${e?.error?.errorCode?.code ?? ""}`;
    expect(msg, `expected error ${name}, got: ${msg}`).to.include(name);
    return;
  }
  expect.fail(`expected error ${name} but the call succeeded`);
}

describe("baska_vault", () => {
  const config = pda([Buffer.from("config")]);
  const stocks = [
    { sym: "mAAPL", dec: 9, price: 200n, mint: PublicKey.default, feed: Keypair.generate() },
    { sym: "mMU", dec: 6, price: 50n, mint: PublicKey.default, feed: Keypair.generate() },
  ];
  let usdcMint: PublicKey;
  const user = Keypair.generate();
  const userAcct: Record<string, PublicKey> = {};

  const expo = -8;
  const px = (usd: bigint) => new BN((usd * 100_000_000n).toString());

  type F = {
    id: number;
    key: PublicKey;
    shareMint: PublicKey;
    usdcVault: PublicKey;
    vaults: PublicKey[];
  };
  const funds: Record<number, F> = {};

  async function ata(mint: PublicKey, owner: PublicKey, offCurve = false) {
    return (await getOrCreateAssociatedTokenAccount(conn, admin, mint, owner, offCurve)).address;
  }

  async function refreshFeeds() {
    for (const s of stocks) {
      await program.methods
        .setMockPrice(px(s.price), new BN(0))
        .accounts({ authority: admin.publicKey, feed: s.feed.publicKey })
        .rpc();
    }
  }

  async function makeFund(id: number, maxTvl = 1_000_000_000_000) {
    const key = fundPda(id);
    const vaults = [];
    for (const s of stocks) vaults.push(await ata(s.mint, key, true));
    const remaining = stocks.flatMap((s, i) => [
      { pubkey: s.mint, isWritable: false, isSigner: false },
      { pubkey: vaults[i], isWritable: false, isSigner: false },
    ]);
    const name = Buffer.alloc(32);
    name.write(`Test Fund ${id}`);
    await program.methods
      .createFund(
        new BN(id),
        Array.from(name),
        50,
        new BN(Number(USDC)), // min deposit $1
        new BN(maxTvl),
        500,
        stocks.map((s) => ({ priceFeed: s.feed.publicKey, targetWeightBps: 5000 }))
      )
      .accounts({
        admin: admin.publicKey,
        fund: key,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remaining)
      .rpc();
    const f = await program.account.fund.fetch(key);
    funds[id] = { id, key, shareMint: f.shareMint, usdcVault: f.usdcVault, vaults };
    // user accounts for this fund's share mint
    userAcct[`shares${id}`] = await ata(f.shareMint, user.publicKey);
    return funds[id];
  }

  const oracleAccts = (f: F) =>
    stocks.flatMap((s, i) => [
      { pubkey: f.vaults[i], isWritable: false, isSigner: false },
      { pubkey: s.feed.publicKey, isWritable: false, isSigner: false },
    ]);

  const baseAccts = (f: F) => ({
    user: user.publicKey,
    fund: f.key,
    usdcMint,
    shareMint: f.shareMint,
    usdcVault: f.usdcVault,
    userUsdc: userAcct.usdc,
    userShares: userAcct[`shares${f.id}`],
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  async function deposit(f: F, usdc: bigint, minShares = 0) {
    return program.methods
      .deposit(new BN(usdc.toString()), new BN(minShares))
      .accounts(baseAccts(f))
      .remainingAccounts(oracleAccts(f))
      .signers([user])
      .rpc();
  }
  async function redeemUsdc(f: F, shares: bigint) {
    return program.methods
      .redeemUsdc(new BN(shares.toString()), new BN(0))
      .accounts(baseAccts(f))
      .remainingAccounts(oracleAccts(f))
      .signers([user])
      .rpc();
  }
  async function redeemInKind(f: F, shares: bigint) {
    const rem = [];
    for (let i = 0; i < stocks.length; i++) {
      rem.push(
        { pubkey: stocks[i].mint, isWritable: false, isSigner: false },
        { pubkey: f.vaults[i], isWritable: true, isSigner: false },
        { pubkey: userAcct[stocks[i].sym], isWritable: true, isSigner: false }
      );
    }
    return program.methods
      .redeemInKind(new BN(shares.toString()))
      .accounts(baseAccts(f))
      .remainingAccounts(rem)
      .signers([user])
      .rpc();
  }

  const bal = async (a: PublicKey) => (await getAccount(conn, a)).amount;
  const supply = async (m: PublicKey) => (await getMint(conn, m)).supply;

  /** Off-chain NAV (USD6), same formula as the program. */
  async function nav(f: F) {
    let n = await bal(f.usdcVault);
    for (let i = 0; i < stocks.length; i++) {
      const s = stocks[i];
      const b = await bal(f.vaults[i]);
      // balance * price(1e8 scaled) * 10^(expo+6-dec)
      n += (b * (s.price * 100_000_000n)) / 10n ** BigInt(-(expo + 6 - s.dec));
    }
    return n;
  }

  before(async () => {
    await conn.confirmTransaction(await conn.requestAirdrop(user.publicKey, 5 * LAMPORTS_PER_SOL));
    usdcMint = await createMint(conn, admin, admin.publicKey, null, 6);
    for (const s of stocks) {
      s.mint = await createMint(conn, admin, admin.publicKey, null, s.dec);
      await program.methods
        .initMockFeed(px(s.price), expo, new BN(0))
        .accounts({ authority: admin.publicKey, feed: s.feed.publicKey })
        .signers([s.feed])
        .rpc();
      userAcct[s.sym] = await ata(s.mint, user.publicKey);
    }
    userAcct.usdc = await ata(usdcMint, user.publicKey);
    await mintTo(conn, admin, usdcMint, userAcct.usdc, admin, 100_000n * USDC);

    await program.methods
      .initializeConfig(admin.publicKey, admin.publicKey, 100)
      .accounts({ admin: admin.publicKey, config, usdcMint, systemProgram: SystemProgram.programId })
      .rpc();
  });

  it("creates a fund with dead shares and validated components", async () => {
    const f = await makeFund(1);
    expect(await supply(f.shareMint)).to.equal(1_000n);
    const acct = await program.account.fund.fetch(f.key);
    expect(acct.numComponents).to.equal(2);
    expect(acct.components[0].decimals).to.equal(9);
  });

  it("rejects target weights that do not sum to 10,000 bps", async () => {
    const key = fundPda(99);
    const vaults = [await ata(stocks[0].mint, key, true), await ata(stocks[1].mint, key, true)];
    const remaining = stocks.flatMap((s, i) => [
      { pubkey: s.mint, isWritable: false, isSigner: false },
      { pubkey: vaults[i], isWritable: false, isSigner: false },
    ]);
    await expectErr(
      program.methods
        .createFund(new BN(99), Array(32).fill(0), 50, new BN(Number(USDC)), new BN(1e12), 500,
          stocks.map((s) => ({ priceFeed: s.feed.publicKey, targetWeightBps: 4000 })))
        .accounts({ admin: admin.publicKey, fund: key, usdcMint, tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId })
        .remainingAccounts(remaining)
        .rpc(),
      "InvalidWeights"
    );
  });

  it("first deposit mints 1:1, second is proportional to NAV", async () => {
    const f = funds[1];
    await refreshFeeds();
    await deposit(f, 100n * USDC);
    expect(await bal(userAcct.shares1)).to.equal(100n * USDC);

    // Fund now holds 0.5 mAAPL (= $100): NAV $200, supply 100e6 + dead.
    await mintTo(conn, admin, stocks[0].mint, f.vaults[0], admin, 500_000_000n);
    await refreshFeeds();
    const navBefore = await nav(f);
    const supBefore = await supply(f.shareMint);
    expect(navBefore).to.equal(200n * USDC);

    const before = await bal(userAcct.shares1);
    await deposit(f, 100n * USDC);
    const minted = (await bal(userAcct.shares1)) - before;
    expect(minted).to.equal((100n * USDC * supBefore) / navBefore);
  });

  it("a price rise lowers shares minted per USDC", async () => {
    const f = funds[1];
    stocks[0].price = 400n; // AAPL doubles
    await refreshFeeds();
    const navBefore = await nav(f);
    const supBefore = await supply(f.shareMint);
    const before = await bal(userAcct.shares1);
    await deposit(f, 50n * USDC);
    const minted = (await bal(userAcct.shares1)) - before;
    expect(minted).to.equal((50n * USDC * supBefore) / navBefore);
  });

  it("enforces min deposit, slippage guard and TVL cap", async () => {
    const f = funds[1];
    await refreshFeeds();
    await expectErr(deposit(f, USDC / 2n), "DepositTooSmall");
    await expectErr(deposit(f, 10n * USDC, Number.MAX_SAFE_INTEGER), "SlippageExceeded");
    const small = await makeFund(3, 150_000_000); // $150 cap
    await deposit(small, 100n * USDC);
    await expectErr(deposit(small, 100n * USDC), "TvlCapExceeded");
  });

  it("redeem_usdc pays floor(shares * NAV / supply) from idle USDC", async () => {
    const f = funds[1];
    await refreshFeeds();
    const shares = 10n * USDC;
    const n = await nav(f);
    const sup = await supply(f.shareMint);
    const usdcBefore = await bal(userAcct.usdc);
    await redeemUsdc(f, shares);
    expect((await bal(userAcct.usdc)) - usdcBefore).to.equal((shares * n) / sup);
  });

  it("redeem_usdc fails when idle buffer is too small or shares exceed balance", async () => {
    const f = funds[1];
    await refreshFeeds();
    const mine = await bal(userAcct.shares1);
    // Redeeming everything needs more USDC than is idle (value is partly in mAAPL).
    await expectErr(redeemUsdc(f, mine), "InsufficientIdleUsdc");
    await expectErr(redeemUsdc(f, mine + 1n), "");
  });

  it("redeem_in_kind returns pro-rata of every vault, even while paused", async () => {
    const f = funds[1];
    await program.methods.setPaused(true).accounts({ admin: admin.publicKey, config, fund: f.key }).rpc();
    await refreshFeeds();
    await expectErr(deposit(f, 10n * USDC), "FundPaused");
    await expectErr(redeemUsdc(f, USDC), "FundPaused");

    const shares = 20n * USDC;
    const sup = await supply(f.shareMint);
    const idle = await bal(f.usdcVault);
    const aapl = await bal(f.vaults[0]);
    const uBefore = await bal(userAcct.usdc);
    const aBefore = await bal(userAcct.mAAPL);
    await redeemInKind(f, shares);
    expect((await bal(userAcct.usdc)) - uBefore).to.equal((idle * shares) / sup);
    expect((await bal(userAcct.mAAPL)) - aBefore).to.equal((aapl * shares) / sup);

    await program.methods.setPaused(false).accounts({ admin: admin.publicKey, config, fund: f.key }).rpc();
  });

  it("only the admin can pause", async () => {
    const f = funds[1];
    await expectErr(
      program.methods.setPaused(true)
        .accounts({ admin: user.publicKey, config, fund: f.key })
        .signers([user])
        .rpc(),
      "Unauthorized"
    );
  });

  it("resists share-inflation via direct donation", async () => {
    const f = await makeFund(2);
    await refreshFeeds();
    await deposit(f, 1n * USDC); // attacker-minimum deposit
    // attacker donates 1,000 USDC straight into the vault
    await transfer(conn, user, userAcct.usdc, f.usdcVault, user, 1_000n * USDC);
    const before = await bal(userAcct.shares2);
    await deposit(f, 1_999n * USDC); // victim
    const victim = (await bal(userAcct.shares2)) - before;
    expect(victim > 0n).to.equal(true);
    // victim's claim on NAV is within 0.1% of what they put in
    const claim = (victim * (await nav(f))) / (await supply(f.shareMint));
    expect(claim >= (1_999n * USDC * 999n) / 1000n).to.equal(true);
  });

  describe("execute_swap (devnet mock DEX)", () => {
    const liquidityAuthority = pda([Buffer.from("mock_liquidity")]);
    const liq: Record<string, PublicKey> = {};
    const FEE_BPS = 10n;
    let f: F;

    const swap = (
      dir: "buy" | "sell",
      idx: number,
      amountIn: bigint,
      minOut = 0n,
      opts: { signer?: Keypair; componentVault?: PublicKey } = {}
    ) => {
      const keeper = opts.signer ?? admin;
      const b = program.methods
        .executeSwap(
          dir === "buy" ? { buy: {} } : { sell: {} },
          idx,
          new BN(amountIn.toString()),
          new BN(minOut.toString())
        )
        .accounts({
          keeper: keeper.publicKey,
          fund: f.key,
          usdcMint,
          usdcVault: f.usdcVault,
          componentMint: stocks[idx].mint,
          componentVault: opts.componentVault ?? f.vaults[idx],
          liquidityAuthority,
          liquidityUsdc: liq.usdc,
          liquidityStock: liq[stocks[idx].sym],
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .remainingAccounts(oracleAccts(f));
      return opts.signer ? b.signers([opts.signer]).rpc() : b.rpc();
    };

    /** Mirrors the program: oracle price (raw = usd * 1e8, expo -8), then 10 bps fee. */
    const quoteBuy = (usdcIn: bigint, idx: number) => {
      const s = stocks[idx];
      const gross = (usdcIn * 10n ** BigInt(s.dec + 2)) / (s.price * 100_000_000n);
      return (gross * (10_000n - FEE_BPS)) / 10_000n;
    };
    const quoteSell = (units: bigint, idx: number) => {
      const s = stocks[idx];
      const gross = (units * s.price * 100_000_000n) / 10n ** BigInt(s.dec + 2);
      return (gross * (10_000n - FEE_BPS)) / 10_000n;
    };

    before(async () => {
      liq.usdc = await ata(usdcMint, liquidityAuthority, true);
      await mintTo(conn, admin, usdcMint, liq.usdc, admin, 1_000_000n * USDC);
      for (const s of stocks) {
        liq[s.sym] = await ata(s.mint, liquidityAuthority, true);
        await mintTo(conn, admin, s.mint, liq[s.sym], admin, 1_000_000n * 10n ** BigInt(s.dec));
      }
      f = await makeFund(4);
      await refreshFeeds();
      await deposit(f, 1_000n * USDC);
    });

    it("buy: deploys idle USDC into an underweight component at the oracle price", async () => {
      await refreshFeeds();
      const idleBefore = await bal(f.usdcVault);
      const out = quoteBuy(500n * USDC, 0);
      await swap("buy", 0, 500n * USDC);
      expect(await bal(f.vaults[0])).to.equal(out);
      expect(idleBefore - (await bal(f.usdcVault))).to.equal(500n * USDC);
    });

    it("rejects a buy that pushes a component further over its target weight", async () => {
      await refreshFeeds();
      await expectErr(swap("buy", 0, 100n * USDC), "SwapIncreasesDrift");
    });

    it("rejects a swap below the caller's minimum output", async () => {
      await refreshFeeds();
      await expectErr(swap("buy", 1, 100n * USDC, 10n ** 18n), "SlippageExceeded");
    });

    it("only the configured keeper can swap", async () => {
      await refreshFeeds();
      await expectErr(swap("buy", 1, 100n * USDC, 0n, { signer: user }), "Unauthorized");
    });

    it("rejects a component vault that does not match the component index", async () => {
      await refreshFeeds();
      await expectErr(swap("buy", 1, 100n * USDC, 0n, { componentVault: f.vaults[0] }), "VaultMismatch");
    });

    it("buy: completes the rebalance into the second component", async () => {
      await refreshFeeds();
      const out = quoteBuy(450n * USDC, 1);
      const before = await bal(f.vaults[1]);
      await swap("buy", 1, 450n * USDC);
      expect((await bal(f.vaults[1])) - before).to.equal(out);
    });

    it("sell: trims an overweight component back to cash; selling an underweight one is rejected", async () => {
      stocks[0].price = 800n; // AAPL doubles again -> overweight
      await refreshFeeds();
      const units = (await bal(f.vaults[0])) / 10n;
      const idleBefore = await bal(f.usdcVault);
      await swap("sell", 0, units);
      expect((await bal(f.usdcVault)) - idleBefore).to.equal(quoteSell(units, 0));

      // MU is now underweight: selling it would increase drift.
      const muUnits = (await bal(f.vaults[1])) / 10n;
      await expectErr(swap("sell", 1, muUnits), "SwapIncreasesDrift");
    });

    it("is blocked while the fund is paused", async () => {
      await program.methods.setPaused(true).accounts({ admin: admin.publicKey, config, fund: f.key }).rpc();
      await refreshFeeds();
      await expectErr(swap("buy", 1, 10n * USDC), "FundPaused");
      await program.methods.setPaused(false).accounts({ admin: admin.publicKey, config, fund: f.key }).rpc();
    });

    it("keeps share accounting consistent: redeem_in_kind after swaps pays pro-rata of the new vaults", async () => {
      const shares = 100n * USDC;
      const sup = await supply(f.shareMint);
      const aapl = await bal(f.vaults[0]);
      const before = await bal(userAcct.mAAPL);
      await redeemInKind(f, shares);
      expect((await bal(userAcct.mAAPL)) - before).to.equal((aapl * shares) / sup);
    });

    it("keeper parity: planner output is always accepted by the program and converges to target", async () => {
      const kf = await makeFund(5);
      f = kf; // helpers above read `f`
      await refreshFeeds();
      await deposit(kf, 1_000n * USDC);

      const market = new MockFeedProvider(program);
      const plan = {
        minIdleUsdc: 10n * USDC,
        maxTradeUsdc: 5_000n * USDC,
        driftToleranceBps: 500,
        slippageBps: 50,
        venueFeeBps: 10,
      };
      const run = async () => {
        const sent: string[] = [];
        for (let i = 0; i < 8; i++) {
          await refreshFeeds();
          const snap = await snapshotFund(conn, program, market, kf.key);
          const w = planSwap(snap.state, plan);
          if (!w) break;
          await sendSwap(program, usdcMint, snap, w); // would throw if the program rejected it
          sent.push(`${w.kind}:${w.index}`);
        }
        return sent;
      };

      // 1) initial deployment of idle cash
      const first = await run();
      expect(first.slice(0, 2)).to.deep.equal(["buy:0", "buy:1"]);
      let snap = await snapshotFund(conn, program, market, kf.key);
      expect(currentDrift(snap.state) <= 30n, `drift ${currentDrift(snap.state)}`).to.equal(true);

      // 2) price shock: AAPL x2 -> keeper trims it, then redeploys the proceeds
      stocks[0].price *= 2n;
      const second = await run();
      expect(second[0]).to.equal("sell:0");
      expect(second).to.include("buy:1");
      snap = await snapshotFund(conn, program, market, kf.key);
      expect(currentDrift(snap.state) <= 60n, `drift ${currentDrift(snap.state)}`).to.equal(true);
    });
  });

  it("stale oracle blocks deposit/redeem_usdc but not redeem_in_kind", async function () {
    const f = funds[1];
    await refreshFeeds();
    await timeTravel(150); // well past the 60s staleness window
    await expectErr(deposit(f, 10n * USDC), "OracleStale");
    await expectErr(redeemUsdc(f, USDC), "OracleStale");
    const before = await bal(userAcct.shares1);
    await redeemInKind(f, USDC);
    expect(before - (await bal(userAcct.shares1))).to.equal(USDC);
  });
});
