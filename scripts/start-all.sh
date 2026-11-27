#!/usr/bin/env bash
# Starts every Baska service for local devnet use, in dependency order, and waits for each to be
# healthy. Run inside WSL from anywhere:   bash ~/baska-v2/scripts/start-all.sh
# Logs go to ./logs/*.log. Stop everything with: bash scripts/stop-all.sh
#
# Optional env: RPC_URL (default public devnet; use a Helius/QuickNode URL to avoid 429s),
#               SKIP_KEEPER=1, QUOTES=sim (fake prices instead of Yahoo)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs

RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
export RPC_URL NEXT_PUBLIC_RPC_URL="${NEXT_PUBLIC_RPC_URL:-$RPC_URL}"
[ "$RPC_URL" = "https://api.devnet.solana.com" ] || export RPC_MIN_INTERVAL_MS="${RPC_MIN_INTERVAL_MS:-0}"

wait_for() { # name url timeout_s
  for _ in $(seq 1 "$3"); do curl -sf -o /dev/null "$2" && { echo "  ✓ $1 ready"; return 0; }; sleep 1; done
  echo "  ✗ $1 did not become ready in $3s. See logs/$4" >&2; exit 1
}
port_free() { ! ss -ltn | grep -q ":$1 "; }
for p in 3000 3001 5433 8787 8788; do
  port_free "$p" || { echo "Port $p is in use. Run: bash scripts/stop-all.sh" >&2; exit 1; }
done

echo "1/6 Redis"
redis-cli ping >/dev/null 2>&1 || { sudo -n service redis-server start >/dev/null 2>&1 || redis-server --daemonize yes >/dev/null; }
redis-cli ping >/dev/null && echo "  ✓ redis ready"

echo "2/6 Price updater (real quotes -> on-chain mock oracle)"
setsid nohup npm run oracle >logs/oracle.log 2>&1 &
wait_for "price updater" http://localhost:8788/oracle/health 90 oracle.log

echo "3/6 Database (embedded Postgres, local dev only)"
setsid nohup npm run api:dev-db >logs/db.log 2>&1 &
for _ in $(seq 1 60); do (echo > /dev/tcp/127.0.0.1/5433) 2>/dev/null && break; sleep 1; done
echo "  ✓ database ready"

echo "4/6 API (REST + indexer + faucet) — replays chain history, can take a minute"
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/postgres DB_POOL_MAX=1 \
REDIS_URL=redis://127.0.0.1:6379 CLUSTER=devnet PORT=3001 CORS_ORIGIN=http://localhost:3000 \
FAUCET_KEYPAIR="$PWD/keys/faucet.json" SYMBOLS_FILE="$PWD/deployments/devnet.symbols.json" \
  setsid nohup npm run api >logs/api.log 2>&1 &
wait_for "API" http://localhost:3001/health 180 api.log

if [ "${SKIP_KEEPER:-}" != "1" ]; then
  echo "5/6 Keeper bot"
  KEEPER_KEYPAIR=keys/keeper.json setsid nohup npm run keeper >logs/keeper.log 2>&1 &
  wait_for "keeper" http://localhost:8787/keeper/health 60 keeper.log
else
  echo "5/6 Keeper skipped"
fi

echo "6/6 Web app"
cd app
[ -d node_modules ] || npm install
npm run sync-config >/dev/null
[ -d .next ] || NEXT_TELEMETRY_DISABLED=1 npm run build
NEXT_TELEMETRY_DISABLED=1 setsid nohup npm start >../logs/web.log 2>&1 &
wait_for "web app" http://localhost:3000/markets 60 web.log

cat <<EOF

All services are up:
  Web app        http://localhost:3000
  API            http://localhost:3001   (funds, nav, portfolio, faucet)
  Price updater  http://localhost:8788/oracle/health
  Keeper         http://localhost:8787/keeper/health
Keep this Ubuntu window (or any WSL terminal) open: WSL stops background services when no terminal is attached.
Set your wallet to Devnet, then open http://localhost:3000. Stop with: bash scripts/stop-all.sh
EOF
