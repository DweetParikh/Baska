/**
 * Idempotent devnet/localnet seeding (guide section 7 / Prompt E). Safe to re-run: it reuses
 * whatever already exists on-chain and only creates what's missing.
 *
 *   ADMIN_KEYPAIR   deployer/admin wallet (default ~/.config/solana/id.json); needs SOL
 *   RPC_URL         default https://api.devnet.solana.com
 *   CLUSTER         label used for deployments/<cluster>.json (default devnet)
 *   SEED_DEPOSIT_USDC   initial deposit per fund (default 1000, 0 to skip)
 *
 * Creates: mock USDC (mint authority = faucet key), 14 mock stock mints + MockPriceFeeds
 * (authority = oracle key), the mock-DEX liquidity accounts, the 4 demo funds, and an
 * initial deposit per fund. Service keys (faucet / keeper / oracle) are generated into keys/.
 * Writes deployments/<cluster>.json (+ .symbols.json) for the API, keeper, updater and frontend.
 */
import { BN } from "@anchor-lang/core";
import {
  createMint,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { toRawPrice } from "./quotes";
import { FUNDS, STOCKS, STOCK_DECIMALS } from "./registry";
import {
  adminKeypairPath,
  CLUSTER,
  Deployment,
  env,
  loadDeployment,
  loadKeypairFile,
  loadOrCreateKey,
  log,
  makeProgram,
  pk,
  RPC_URL,
  saveDeployment,
  sendV0WithAlt,
} from "./lib";

const USDC = 1_000_000n;
const SEED_DEPOSIT = BigInt(env("SEED_DEPOSIT_USDC", "1000")) * USDC;
const LIQ_USDC_TARGET = 50_000_000n * USDC;
const LIQ_STOCK_TARGET = 500_000n * 10n ** BigInt(STOCK_DECIMALS);

async function main() {
  const admin = loadKeypairFile(adminKeypairPath());
  const faucet = loadOrCreateKey("faucet");
  const keeper = loadOrCreateKey("keeper");
  const oracle = loadOrCreateKey("oracle");
  const { conn, program, provider } = makeProgram(admin);
  const oracleProgram = makeProgram(oracle, conn).program;
  const faucetProgram = makeProgram(faucet, conn);

  log(`cluster=${CLUSTER} rpc=${RPC_URL}`);
  log(`admin=${admin.publicKey.toBase58()} balance=${(await conn.getBalance(admin.publicKey)) / 1e9} SOL`);

  const info = await conn.getAccountInfo(program.programId);
  if (!info?.executable) throw new Error(`program ${program.programId.toBase58()} is not deployed on ${RPC_URL}`);

  const prev = loadDeployment();

  // ---------------------------------------------------------------- service keys
  const ensureSol = async (to: PublicKey, minSol: number, label: string) => {
    const need = Math.ceil(minSol * 1e9) - (await conn.getBalance(to));
    if (need <= 0) return;
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports: need })));
    log(`funded ${label} with ${need / 1e9} SOL`);
  };
  await ensureSol(faucet.publicKey, 0.5, "faucet");
  await ensureSol(keeper.publicKey, 0.2, "keeper");
  await ensureSol(oracle.publicKey, 0.3, "oracle");

  const ata = async (mint: PublicKey, owner: PublicKey, off = false) =>
    (await getOrCreateAssociatedTokenAccount(conn, admin, mint, owner, off)).address;
  const exists = async (k: PublicKey) => (await conn.getAccountInfo(k)) !== null;

  // ---------------------------------------------------------------- config + USDC
  const [configKey] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [liqAuth] = PublicKey.findProgramAddressSync([Buffer.from("mock_liquidity")], program.programId);
  let cfg = await program.account.globalConfig.fetchNullable(configKey);
  let usdcMint: PublicKey;
  if (cfg) {
    usdcMint = cfg.usdcMint;
    log(`config exists (usdc mint ${usdcMint.toBase58()})`);
    if (!cfg.keeper.equals(keeper.publicKey)) log(`WARNING: config.keeper is ${cfg.keeper.toBase58()}, not keys/keeper.json (${keeper.publicKey.toBase58()})`);
  } else {
    usdcMint = prev?.usdcMint && (await exists(pk(prev.usdcMint))) ? pk(prev.usdcMint) : await createMint(conn, admin, faucet.publicKey, null, 6);
    await program.methods
      .initializeConfig(keeper.publicKey, admin.publicKey, 100)
      .accounts({ admin: admin.publicKey, config: configKey, usdcMint, systemProgram: SystemProgram.programId })
      .rpc();
    log(`initialized config; mock USDC mint ${usdcMint.toBase58()}`);
  }
  const usdcInfo = await getMint(conn, usdcMint);
  if (!usdcInfo.mintAuthority?.equals(faucet.publicKey)) {
    throw new Error(`USDC mint authority is ${usdcInfo.mintAuthority?.toBase58()}, not the faucet key; the faucet and seeding cannot mint`);
  }
  const mintUsdc = async (to: PublicKey, amount: bigint) =>
    mintTo(conn, faucet, usdcMint, to, faucet, amount); // faucet pays + signs

  // ---------------------------------------------------------------- stocks + feeds
  const stocks: Deployment["stocks"] = [];
  for (const s of STOCKS) {
    const old = prev?.stocks.find((x) => x.symbol === s.symbol);
    let mint = old && (await exists(pk(old.mint))) ? pk(old.mint) : null;
    if (!mint) mint = await createMint(conn, admin, admin.publicKey, null, STOCK_DECIMALS);
    let feed = old && (await exists(pk(old.feed))) ? pk(old.feed) : null;
    if (!feed) {
      const kp = Keypair.generate();
      await program.methods
        .initMockFeed(new BN(toRawPrice(s.baseUsd).toString()), -8, new BN(0))
        .accounts({ authority: oracle.publicKey, feed: kp.publicKey, systemProgram: SystemProgram.programId })
        .signers([oracle, kp])
        .rpc();
      feed = kp.publicKey;
    }
    stocks.push({ symbol: s.symbol, mint: mint.toBase58(), decimals: STOCK_DECIMALS, feed: feed.toBase58(), baseUsd: s.baseUsd });
  }
  log(`stocks ready: ${stocks.length}`);

  const base: Deployment = {
    cluster: CLUSTER,
    rpcUrl: RPC_URL,
    programId: program.programId.toBase58(),
    config: configKey.toBase58(),
    usdcMint: usdcMint.toBase58(),
    liquidityAuthority: liqAuth.toBase58(),
    service: { admin: admin.publicKey.toBase58(), keeper: keeper.publicKey.toBase58(), oracle: oracle.publicKey.toBase58(), faucet: faucet.publicKey.toBase58() },
    stocks,
    funds: prev?.funds ?? [],
    updatedAt: "",
  };
  saveDeployment(base);

  // ---------------------------------------------------------------- mock DEX liquidity
  const liqUsdc = await ata(usdcMint, liqAuth, true);
  if ((await getAccount(conn, liqUsdc)).amount < LIQ_USDC_TARGET / 2n) await mintUsdc(liqUsdc, LIQ_USDC_TARGET);
  for (const s of stocks) {
    const a = await ata(pk(s.mint), liqAuth, true);
    if ((await getAccount(conn, a)).amount < LIQ_STOCK_TARGET / 2n) await mintTo(conn, admin, pk(s.mint), a, admin, LIQ_STOCK_TARGET);
  }
  log("mock liquidity funded");

  // ---------------------------------------------------------------- price refresh helper
  const refreshPrices = async () => {
    const ixs = await Promise.all(
      STOCKS.map((s) =>
        oracleProgram.methods
          .setMockPrice(new BN(toRawPrice(s.baseUsd).toString()), new BN(0))
          .accounts({ authority: oracle.publicKey, feed: pk(stocks.find((x) => x.symbol === s.symbol)!.feed) })
          .instruction()
      )
    );
    for (let i = 0; i < ixs.length; i += 6) {
      await oracleProgram.provider.sendAndConfirm(new Transaction().add(...ixs.slice(i, i + 6)));
    }
  };

  // ---------------------------------------------------------------- funds
  const funds: Deployment["funds"] = [];
  for (const def of FUNDS) {
    const idBuf = new BN(def.id).toArrayLike(Buffer, "le", 8);
    const [fundKey] = PublicKey.findProgramAddressSync([Buffer.from("fund"), idBuf], program.programId);
    const comps = def.components.map((c) => ({ ...c, stock: stocks.find((s) => s.symbol === c.symbol)! }));

    if (!(await exists(fundKey))) {
      const vaults: PublicKey[] = [];
      for (const c of comps) vaults.push(await ata(pk(c.stock.mint), fundKey, true));
      const name = Buffer.alloc(32);
      name.write(def.name);
      const ix = await program.methods
        .createFund(
          new BN(def.id),
          Array.from(name),
          50, // 0.5% annual management fee
          new BN((1n * USDC).toString()), // min deposit $1
          new BN((1_000_000n * USDC).toString()), // demo TVL cap $1M
          500,
          comps.map((c) => ({ priceFeed: pk(c.stock.feed), targetWeightBps: c.bps }))
        )
        .accounts({ admin: admin.publicKey, fund: fundKey, usdcMint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
        .remainingAccounts(comps.flatMap((c, i) => [
          { pubkey: pk(c.stock.mint), isWritable: false, isSigner: false },
          { pubkey: vaults[i], isWritable: false, isSigner: false },
        ]))
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .instruction();
      const sig = await sendV0WithAlt(conn, admin, [ix], [], comps.flatMap((c, i) => [pk(c.stock.mint), vaults[i]]));
      log(`created fund ${def.id} "${def.name}"`, { sig });
    }

    const f = await program.account.fund.fetch(fundKey);
    const vaults: PublicKey[] = f.components.slice(0, f.numComponents).map((c: any) => c.vault);
    funds.push({
      id: def.id,
      name: def.name,
      address: fundKey.toBase58(),
      shareMint: f.shareMint.toBase58(),
      usdcVault: f.usdcVault.toBase58(),
      components: comps.map((c, i) => ({ symbol: c.symbol, mint: c.stock.mint, vault: vaults[i].toBase58(), priceFeed: c.stock.feed, targetBps: c.bps })),
    });
  }
  saveDeployment({ ...base, funds });
  log(`funds ready: ${funds.map((f) => `${f.id}:${f.name}`).join(", ")}`);

  // ---------------------------------------------------------------- initial deposits
  if (SEED_DEPOSIT > 0n) {
    const adminUsdc = await ata(usdcMint, admin.publicKey);
    for (const f of funds) {
      const shareMint = pk(f.shareMint);
      if ((await getMint(conn, shareMint)).supply > 1_000n) continue; // already has real shares
      await refreshPrices();
      if ((await getAccount(conn, adminUsdc)).amount < SEED_DEPOSIT) await mintUsdc(adminUsdc, SEED_DEPOSIT);
      const adminShares = await ata(shareMint, admin.publicKey);
      const sig = await program.methods
        .deposit(new BN(SEED_DEPOSIT.toString()), new BN(0))
        .accounts({
          user: admin.publicKey,
          fund: pk(f.address),
          usdcMint,
          shareMint,
          usdcVault: pk(f.usdcVault),
          userUsdc: adminUsdc,
          userShares: adminShares,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(f.components.flatMap((c) => [
          { pubkey: pk(c.vault), isWritable: false, isSigner: false },
          { pubkey: pk(c.priceFeed), isWritable: false, isSigner: false },
        ]))
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc();
      log(`seed deposit into fund ${f.id}: $${SEED_DEPOSIT / USDC}`, { sig });
    }
  }

  log(`\nDone. Wrote deployments/${CLUSTER}.json. Next: run the price updater (scripts/price-updater.ts) so oracles never go stale.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
