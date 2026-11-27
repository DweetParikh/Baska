import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  RPC_URL: z.string().default("http://127.0.0.1:8899"),
  REDIS_URL: z.string().optional(),
  PORT: z.coerce.number().int().default(3001),
  CLUSTER: z.enum(["localnet", "devnet", "mainnet-beta"]).default("localnet"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().int().default(5 * 60_000),
  /** Postgres pool size. The embedded dev DB (PGlite) only serves 1 connection: set this to 1 there. */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  BACKFILL_INTERVAL_MS: z.coerce.number().int().default(30_000),
  PRICE_CACHE_TTL_S: z.coerce.number().int().default(8),
  /** Skip NAV snapshots when any oracle is older than this (market closed / feed down). */
  MAX_PRICE_AGE_S: z.coerce.number().int().default(50),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().default(120),
  /** Path to the mock-USDC mint authority keypair. Setting it enables POST /faucet (never on mainnet). */
  FAUCET_KEYPAIR: z.string().optional(),
  FAUCET_AMOUNT_USDC: z.coerce.number().int().positive().default(1000),
  FAUCET_COOLDOWN_S: z.coerce.number().int().default(3600),
  /** JSON file {"<mint>": "AAPL", ...} used to label fund components. */
  SYMBOLS_FILE: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    throw new Error(`Invalid environment: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}
