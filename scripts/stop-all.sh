#!/usr/bin/env bash
# Stops every Baska service started by start-all.sh (leaves Redis running).
pkill -f "[n]ext-server"; pkill -f "[n]ext start"
pkill -f "[k]eeper/src"; pkill -f "[a]pi/src/index.ts"
pkill -f "[d]ev-db"; pkill -f "[p]rice-updater"
sleep 2
if ss -ltn | grep -qE ":(3000|3001|5433|8787|8788) "; then echo "some ports are still busy"; ss -ltnp | grep -E ":(3000|3001|5433|8787|8788) "; else echo "all Baska services stopped"; fi
