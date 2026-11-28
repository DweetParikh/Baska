#!/usr/bin/env bash
# Runs the whole Baska backend in ONE container (Railway / Render / Fly / any Docker host):
# price updater + keeper + API. The Next.js app stays on Vercel.
#
# Required env:
#   ORACLE_KEY_JSON   contents of keys/oracle.json  (the JSON array, e.g. [12,34,...])
# Recommended:
#   KEEPER_KEY_JSON   contents of keys/keeper.json  (omit to run without the keeper)
#   FAUCET_KEY_JSON   contents of keys/faucet.json  (omit to disable the USDC faucet)
#   RPC_URL           Helius / QuickNode devnet URL (public devnet RPC rate-limits hard)
#   CORS_ORIGIN       your frontend origin(s), comma-separated, e.g. https://baskaonchain.vercel.app
# Optional:
#   DATABASE_URL      a real Postgres (Neon/Supabase). If unset, an embedded Postgres runs inside
#                     the container; it is rebuilt from chain history on every restart.
#   REDIS_URL         if unset the API uses an in-process cache (fine for a single instance).
set -euo pipefail
cd "$(dirname "$0")/.."

# ---- service keys from env -> keys/*.json (keys/ is gitignored and never baked into the image)
mkdir -p keys
write_key() { # name VAR required
  local val="${!2:-}"
  if [ -z "$val" ]; then
    [ "$3" = required ] && { echo "Missing env $2 (paste the contents of keys/$1.json)" >&2; exit 1; }
    return 1
  fi
  printf '%s' "$val" > "keys/$1.json" && chmod 600 "keys/$1.json"
}
write_key oracle ORACLE_KEY_JSON required
HAVE_KEEPER=1; write_key keeper KEEPER_KEY_JSON optional || HAVE_KEEPER=0
HAVE_FAUCET=1; write_key faucet FAUCET_KEY_JSON optional || HAVE_FAUCET=0

export CLUSTER="${CLUSTER:-devnet}"
export RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
[ "$RPC_URL" = "https://api.devnet.solana.com" ] || export RPC_MIN_INTERVAL_MS="${RPC_MIN_INTERVAL_MS:-0}"
export CORS_ORIGIN="${CORS_ORIGIN:-https://baskaonchain.vercel.app}"
API_PORT="${PORT:-3001}"   # the host assigns PORT; only the API may use it

# ---- database
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL not set: starting embedded Postgres (data is rebuilt from chain on restart)"
  env -u PORT npm run api:dev-db &
  for _ in $(seq 1 60); do (echo > /dev/tcp/127.0.0.1/5433) 2>/dev/null && break; sleep 1; done
  export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres DB_POOL_MAX=1
else
  echo "Applying Prisma migrations to DATABASE_URL"
  ./node_modules/.bin/prisma migrate deploy --config ./api/prisma.config.ts   # the repo's Prisma 7, never npx latest
fi

# ---- services (internal health ports 8788 / 8787; only the API is public)
PORT=8788 npm run oracle &
if [ "$HAVE_KEEPER" = 1 ] && [ "${SKIP_KEEPER:-}" != 1 ]; then
  PORT=8787 KEEPER_KEYPAIR="$PWD/keys/keeper.json" npm run keeper &
else
  echo "Keeper not started (no KEEPER_KEY_JSON or SKIP_KEEPER=1)"
fi
FAUCET_ENV=()
[ "$HAVE_FAUCET" = 1 ] && FAUCET_ENV=(FAUCET_KEYPAIR="$PWD/keys/faucet.json")
env PORT="$API_PORT" SYMBOLS_FILE="$PWD/deployments/$CLUSTER.symbols.json" "${FAUCET_ENV[@]}" npm run api &

# If any service dies, exit so the host restarts the container (a dead oracle = OracleStale in ~60s).
wait -n
echo "A Baska service exited; stopping so the platform restarts the container" >&2
exit 1
