# Baska

On-chain mutual funds of tokenized stocks on Solana. Users deposit USDC into a fund vault and receive
fund shares; the vault holds a basket of tokens. Share price = NAV of the basket. **No promised yield.**

> **Status: devnet demo.** Real tokenized stocks and Pyth equity feeds don't exist on devnet, so the
> demo uses mock tokens, an admin-writable `MockPriceFeed` (prices are **simulated**) and a mock DEX.
> There is no Pyth reader or Jupiter/Sunrise swap yet, so this is **not mainnet-ready**.

## Layout

| Path | What |
|---|---|
| `programs/baska_vault` | Anchor 1.2 program: funds, deposit, `redeem_usdc`, `redeem_in_kind`, `execute_swap` (mock DEX), pause, mock oracle |
| `tests/` | TypeScript integration tests (Surfpool): program, swaps, keeper parity, backend |
| `keeper/` | Rebalancing bot + pure planner (unit-tested) |
| `api/` | Fastify + Prisma + Redis: event indexer, NAV snapshots, REST API, faucet |
| `scripts/` | `seed-devnet`, `price-updater`, `smoke-devnet` |
| `app/` | Next.js frontend (wallet-adapter, TanStack Query, Recharts) |
| `deployments/` | Generated addresses per cluster (public keys only) |

Service keys (`faucet`, `keeper`, `oracle`) are generated into `keys/` (gitignored). Back them up.

## Running on devnet (order matters)

Tooling: Node 20+, Rust, Anchor 1.2.1 (`avm`), Solana CLI, Redis. On Windows use WSL2 (Ubuntu 24.04).

```bash
npm install && (cd app && npm install)
anchor build
anchor deploy --provider.cluster devnet --provider.wallet <admin.json>   # admin = upgrade authority

ADMIN_KEYPAIR=<admin.json> npm run seed          # mints, feeds, liquidity, 4 funds, seed deposits (idempotent)
npm run oracle                                   # REQUIRED: keeps mock prices < 60s old
npm run api:generate                             # Prisma client (not committed)
npm run api:dev-db                               # local-only embedded Postgres; use a real Postgres elsewhere
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres DB_POOL_MAX=1 \
  REDIS_URL=redis://127.0.0.1:6379 CLUSTER=devnet FAUCET_KEYPAIR=keys/faucet.json \
  SYMBOLS_FILE=deployments/devnet.symbols.json npm run api
KEEPER_KEYPAIR=keys/keeper.json npm run keeper   # deploys idle USDC, rebalances

cd app && npm run sync-config && npm run build && npm start     # http://localhost:3000
```

**Use a dedicated RPC** (Helius / QuickNode free tier) for anything beyond a demo: the public devnet
RPC rate-limits hard. Set `RPC_URL`, `NEXT_PUBLIC_RPC_URL` and `RPC_MIN_INTERVAL_MS=0`.

If the price updater stops, deposits, USDC withdrawals and swaps fail with `OracleStale` after ~60s.
`redeem_in_kind` needs no price and always works.

## Tests

```bash
anchor test --skip-build                 # 40 integration tests on Surfpool (program, swaps, keeper, backend)
cargo test -p baska_vault --lib       # 14 unit tests (math, oracle rules)
npm run test:keeper                      # planner unit tests
cd app && npm run check:devnet           # headless: the UI's tx builders against devnet
```

Not covered by any automated test: signing through a real browser wallet.

## Known limits

- Mock oracle and mock DEX only; mainnet needs a Pyth reader and a Jupiter/Sunrise CPI (see TODOs).
- All assets in a fund must share one token program (SPL Token or Token-2022).
- Positions track program deposits/redeems only; shares moved by plain token transfers aren't reflected.
- The admin UI can pause/unpause; creating funds is done by the seed script.
- Tokenized securities can carry eligibility/jurisdiction restrictions. Get legal advice before mainnet.
