#!/usr/bin/env bash
# Runs every end-to-end case against a local anvil chain (chain ID 10143, so anvil
# applies Monad's gas rules). Starts anvil and the provider server, cleans up after.
set -uo pipefail
cd "$(dirname "$0")/.."
RPC=http://127.0.0.1:8545
PROVIDER=0x5193400000000000000000000000000000000402
# Dedicated port so a dev server on 3001 is never touched.
PORT=3901
SERVER_URL=http://localhost:$PORT
LOGS=$(mktemp -d)
FAILED=0

port_pids() { ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u; }

# npx/tsx spawn a child node process, so stop the server by the port it listens on.
stop_server() {
  local pids
  pids=$(port_pids $PORT)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  while [ -n "$(port_pids $PORT)" ]; do sleep 0.2; done
}

cleanup() {
  stop_server
  [ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null
}
trap cleanup EXIT

for p in $PORT 8545; do
  [ -n "$(port_pids $p)" ] && { echo "port $p is already in use; stop that process first"; exit 1; }
done

anvil --chain-id 10143 --block-time 0.4 --silent >"$LOGS/anvil.log" 2>&1 &
ANVIL_PID=$!
until cast block-number --rpc-url $RPC >/dev/null 2>&1; do sleep 0.2; done
DEPLOYER=$(cast rpc eth_accounts --rpc-url $RPC | grep -o '0x[0-9a-fA-F]\{40\}' | head -1)

# Each server run gets a fresh contract, so session IDs (and their storage slots) restart at 1.
start_server() {
  stop_server
  local contract
  contract=$(forge create src/Sip402.sol:Sip402 --rpc-url $RPC --unlocked --from "$DEPLOYER" --broadcast 2>&1 |
    grep -o 'Deployed to: 0x[0-9a-fA-F]*' | grep -o '0x.*')
  (cd server && exec env PROVIDER_ADDRESS=$PROVIDER CONTRACT_ADDRESS="$contract" RPC_URL=$RPC PORT=$PORT "$@" \
    npx tsx src/index.ts >"$LOGS/server.log" 2>&1) &
  # Wait for this server specifically: /info must report the contract just deployed.
  local tries=0
  until curl -sf $SERVER_URL/info 2>/dev/null | grep -qi "${contract#0x}"; do
    sleep 0.2
    tries=$((tries + 1))
    [ $tries -gt 150 ] && { echo "server did not start:"; cat "$LOGS/server.log"; exit 1; }
  done
  echo "== server: contract $contract $*"
}

run() {
  local dir=$1 script=$2
  shift 2
  local out
  out=$(cd "$dir" && env RPC_URL=$RPC SERVER_URL=$SERVER_URL NEXT_PUBLIC_SERVER_URL=$SERVER_URL "$@" \
    timeout 180 npx tsx "$script" 2>&1)
  if echo "$out" | grep -qE "SESSION OK|E2E OK"; then
    printf '  pass  %s %s\n' "$script" "$*"
  else
    printf '  FAIL  %s %s\n' "$script" "$*"
    echo "$out" | grep -vE '^\s+at ' | tail -8 | sed 's/^/        /'
    FAILED=1
  fi
}

start_server
run server scripts/e2e-local.ts
run server scripts/e2e-local.ts STOP_AFTER=2
run server scripts/e2e-local.ts OFF_TIER=1
run web scripts/session-local.mts
run web scripts/session-local.mts STOP_AFTER=3
run web scripts/session-local.mts SIPS=10
# Session 7 on a fresh contract straddles a storage page boundary (+8,000 gas).
run web scripts/session-local.mts STOP_IN_FLIGHT=1
run web scripts/session-local.mts STOP_IN_FLIGHT=5
run web scripts/session-local.mts PAUSE_AT=3 RESUME_AFTER_MS=1500
run web scripts/session-local.mts PAUSE_AT=4 CANCEL_AFTER_MS=1500
# The full demo flow: start, pause, resume, cancel, refund.
run web scripts/session-local.mts PAUSE_AT=3 RESUME_AFTER_MS=1500 STOP_AFTER=6
# Price tiers: full answer, cancel mid-stream, cap reached, demo flow.
run web scripts/session-local.mts TIER=smart
run web scripts/session-local.mts TIER=smart STOP_IN_FLIGHT=4
run web scripts/session-local.mts TIER=pro SIPS=10
run web scripts/session-local.mts TIER=pro PAUSE_AT=2 RESUME_AFTER_MS=1500 STOP_AFTER=5

start_server STREAM_IDLE_TIMEOUT_MS=3000
run web scripts/session-local.mts PAUSE_AT=2 RESUME_AFTER_MS=1500
run web scripts/session-local.mts PAUSE_AT=2 EXPECT_EXPIRED=1

[ $FAILED = 0 ] && echo "ALL E2E PASSED" || { echo "E2E FAILURES (logs in $LOGS)"; exit 1; }
