#!/usr/bin/env bash
# Minimal on-chain lifecycle smoke test: mint -> approve -> create -> fund -> deposit reserve
# -> advance -> settle, verifying chain state after every step (state is read back from the RPC
# after each confirmed receipt).
#
# Signing uses Foundry keystores; there are no raw private keys. Each keystore password is read
# once (hidden prompt on the terminal, or from a file named by *_PASSWORD_FILE) and kept in shell
# variables. cast only accepts a regular password file (not a pipe or /dev/fd), so for each call
# the password is written to a 0600 file inside a private 0700 temp directory and deleted right
# after the call (and by an exit trap). It is never placed on a command line or printed.
#
# Usage:
#   ./script/smoke.sh --check   read-only: keystore addresses == env addresses, chain id, balances
#   ./script/smoke.sh           full lifecycle (sends transactions!)
#
# Env (see .env.example):
#   always:  XRPL_EVM_RPC_URL CHAIN_ID DEPLOYER_ADDRESS OPERATOR_ADDRESS CLIENT_ADDRESS
#            EVALUATOR_ADDRESS FREELANCER_ADDRESS
#   full run also: TOKEN_ADDRESS CONTRACT_ADDRESS
#   optional: DEPLOYER_ACCOUNT (duely-deployer) CLIENT_ACCOUNT (duely-client)
#             EVALUATOR_ACCOUNT (duely-evaluator) KEYSTORE_DIR (~/.foundry/keystores)
#             SMOKE_RESERVE_DEPOSIT (base units, default 1000000000 = 1,000 dUSD)
#             DEPLOYER_PASSWORD_FILE CLIENT_PASSWORD_FILE EVALUATOR_PASSWORD_FILE
#   The deployer keystore signs token-owner (mint) and operator (reserve) transactions, so
#   OPERATOR_ADDRESS must equal DEPLOYER_ADDRESS.
set -euo pipefail

MODE=full
case "${1:-}" in
  --check) MODE=check ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

required="XRPL_EVM_RPC_URL CHAIN_ID DEPLOYER_ADDRESS OPERATOR_ADDRESS CLIENT_ADDRESS EVALUATOR_ADDRESS FREELANCER_ADDRESS"
[ "$MODE" = full ] && required="$required TOKEN_ADDRESS CONTRACT_ADDRESS"
for v in $required; do
  [ -n "${!v:-}" ] || { echo "missing env: $v" >&2; exit 2; }
done
if [ "$CHAIN_ID" = "1440000" ]; then echo "refusing mainnet" >&2; exit 2; fi

RPC="$XRPL_EVM_RPC_URL"
TOKEN="${TOKEN_ADDRESS:-}"
IA="${CONTRACT_ADDRESS:-}"
KEYSTORE_DIR="${KEYSTORE_DIR:-$HOME/.foundry/keystores}"
DEPLOYER_ACCOUNT="${DEPLOYER_ACCOUNT:-duely-deployer}"
CLIENT_ACCOUNT="${CLIENT_ACCOUNT:-duely-client}"
EVALUATOR_ACCOUNT="${EVALUATOR_ACCOUNT:-duely-evaluator}"
AMOUNT=1000000000     # 1,000 dUSD (6 decimals)
ADVANCE=900000000     # floor(AMOUNT * 9000 / 10000)
RESERVE_DEPOSIT="${SMOKE_RESERVE_DEPOSIT:-1000000000}"   # base units; default 1,000 dUSD (mint + reserve deposit)
MIN_GAS_WEI=2000000000000000   # 0.002 XRP per signer, comfortably above the smoke-test gas

lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
num() { awk '{print $1}'; }

expect() { # name actual expected
  if [ "$2" != "$3" ]; then echo "FAIL  $1: got $2, expected $3" >&2; exit 1; fi
  echo "  ok  $1 = $2"
}

# ---- keystore signing -------------------------------------------------------------------

PW_deployer=""; PW_client=""; PW_evaluator=""

keystore_path() { # role
  case "$1" in
    deployer) echo "$KEYSTORE_DIR/$DEPLOYER_ACCOUNT" ;;
    client) echo "$KEYSTORE_DIR/$CLIENT_ACCOUNT" ;;
    evaluator) echo "$KEYSTORE_DIR/$EVALUATOR_ACCOUNT" ;;
  esac
}

load_password() { # role
  local role="$1" fileenv label
  fileenv="$(echo "$role" | tr '[:lower:]' '[:upper:]')_PASSWORD_FILE"
  label="$(basename "$(keystore_path "$role")")"
  [ -f "$(keystore_path "$role")" ] || { echo "keystore not found: $label" >&2; exit 2; }
  if [ -n "${!fileenv:-}" ]; then
    # read returns non-zero at EOF without a trailing newline; the value is still assigned
    IFS= read -r "PW_$role" < "${!fileenv}" || true
  else
    [ -r /dev/tty ] || { echo "no terminal for password prompt; set $fileenv" >&2; exit 2; }
    IFS= read -r -s -p "Keystore password for $label: " "PW_$role" < /dev/tty
    echo >&2
  fi
  local pwvar="PW_$role"
  [ -n "${!pwvar}" ] || { echo "empty password for $label" >&2; exit 2; }
}

PWDIR="$(umask 077; mktemp -d)"
trap 'rm -rf "$PWDIR"' EXIT

with_signer() { # role, then a full command; appends keystore flags
  local role="$1"; shift
  local pwvar="PW_$role" pwfile="$PWDIR/pw" rc=0
  (umask 077; printf '%s' "${!pwvar}" > "$pwfile")
  "$@" --keystore "$(keystore_path "$role")" --password-file "$pwfile" || rc=$?
  rm -f "$pwfile"
  return $rc
}

signer_address() { with_signer "$1" cast wallet address; }

# ---- chain helpers ----------------------------------------------------------------------

callu() { cast call --rpc-url "$RPC" "$@" | num; }
bal() { callu "$TOKEN" 'balanceOf(address)(uint256)' "$1"; }
reserve() { callu "$IA" 'reserveBalance()(uint256)'; }
escrow() { callu "$IA" 'totalEscrow()(uint256)'; }

send() { # role, then cast send args; prints tx hash/block, fails on reverted receipt
  local role="$1"; shift
  local out
  out=$(with_signer "$role" cast send --rpc-url "$RPC" --json "$@")
  python3 -I -c '
import json,sys
r=json.loads(sys.argv[1])
ok=str(r.get("status")) in ("0x1","1")
print("  tx  %s  block %s  %s" % (r["transactionHash"], int(str(r["blockNumber"]),0), "success" if ok else "REVERTED"))
sys.exit(0 if ok else 1)' "$out"
}

invoice_field() { # id, index -> field of getInvoice tuple (0 freelancer,1 client,2 amount,3 advance,6 status)
  cast call --rpc-url "$RPC" "$IA" \
    'getInvoice(uint256)((address,address,uint256,uint256,bytes32,bytes32,uint8))' "$1" \
    | python3 -I -c '
import sys
t=sys.stdin.read().strip().strip("()")
print([p.strip().split(" ")[0] for p in t.split(", ")][int(sys.argv[1])])' "$2"
}

# ---- preflight (read-only) ---------------------------------------------------------------

echo "== preflight (read-only)"
expect "chain id" "$(cast chain-id --rpc-url "$RPC")" "$CHAIN_ID"
echo "  block $(cast block-number --rpc-url "$RPC")"

[ "$(lower "$OPERATOR_ADDRESS")" = "$(lower "$DEPLOYER_ADDRESS")" ] \
  || { echo "FAIL  OPERATOR_ADDRESS must equal DEPLOYER_ADDRESS (deployer keystore signs operator txs)" >&2; exit 1; }
[ "$(lower "$FREELANCER_ADDRESS")" != "$(lower "$CLIENT_ADDRESS")" ] \
  || { echo "FAIL  FREELANCER_ADDRESS must differ from CLIENT_ADDRESS" >&2; exit 1; }
[ "$(lower "$EVALUATOR_ADDRESS")" != "$(lower "$OPERATOR_ADDRESS")" ] \
  || { echo "FAIL  EVALUATOR_ADDRESS must differ from OPERATOR_ADDRESS" >&2; exit 1; }

load_password deployer; load_password client; load_password evaluator
expect "deployer keystore ($DEPLOYER_ACCOUNT) == DEPLOYER_ADDRESS" "$(lower "$(signer_address deployer)")" "$(lower "$DEPLOYER_ADDRESS")"
expect "client keystore ($CLIENT_ACCOUNT) == CLIENT_ADDRESS" "$(lower "$(signer_address client)")" "$(lower "$CLIENT_ADDRESS")"
expect "evaluator keystore ($EVALUATOR_ACCOUNT) == EVALUATOR_ADDRESS" "$(lower "$(signer_address evaluator)")" "$(lower "$EVALUATOR_ADDRESS")"
CLIENT="$CLIENT_ADDRESS"; OPERATOR="$OPERATOR_ADDRESS"; EVALUATOR="$EVALUATOR_ADDRESS"

low=0
for pair in "deployer/operator:$DEPLOYER_ADDRESS" "client:$CLIENT_ADDRESS" "evaluator:$EVALUATOR_ADDRESS"; do
  name="${pair%%:*}"; addr="${pair#*:}"
  wei=$(cast balance --rpc-url "$RPC" "$addr")
  # wei balances exceed bash's 64-bit integers above ~9.2 XRP, so compare in python
  if python3 -I -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else 1)' "$wei" "$MIN_GAS_WEI"; then
    s="ok"
  else
    s="LOW (need >= 0.002 XRP)"; low=1
  fi
  echo "  $s  $name $addr  $(cast from-wei "$wei") XRP"
done
echo "  freelancer $FREELANCER_ADDRESS  $(cast from-wei "$(cast balance --rpc-url "$RPC" "$FREELANCER_ADDRESS")") XRP (needs none)"

if [ "$MODE" = check ]; then
  if [ "$low" = 1 ]; then echo "CHECK FAILED: fund the wallets marked LOW" >&2; exit 1; fi
  echo "CHECK PASSED (read-only; no transactions sent)"
  exit 0
fi
[ "$low" = 0 ] || { echo "FAIL  fund the wallets marked LOW before the smoke test" >&2; exit 1; }

expect "token decimals" "$(callu "$TOKEN" 'decimals()(uint8)')" 6
expect "paymentToken" "$(lower "$(cast call --rpc-url "$RPC" "$IA" 'paymentToken()(address)')")" "$(lower "$TOKEN")"
OPERATOR_ROLE=$(cast keccak OPERATOR_ROLE); EVALUATOR_ROLE=$(cast keccak EVALUATOR_ROLE)
expect "operator role" "$(cast call --rpc-url "$RPC" "$IA" 'hasRole(bytes32,address)(bool)' "$OPERATOR_ROLE" "$OPERATOR")" true
expect "evaluator role" "$(cast call --rpc-url "$RPC" "$IA" 'hasRole(bytes32,address)(bool)' "$EVALUATOR_ROLE" "$EVALUATOR")" true
expect "token owner == deployer" "$(lower "$(cast call --rpc-url "$RPC" "$TOKEN" 'owner()(address)')")" "$(lower "$DEPLOYER_ADDRESS")"
echo "  client=$CLIENT operator=$OPERATOR evaluator=$EVALUATOR freelancer=$FREELANCER_ADDRESS"

CLIENT_BAL0=$(bal "$CLIENT"); OP_BAL0=$(bal "$OPERATOR"); FL_BAL0=$(bal "$FREELANCER_ADDRESS")
RES0=$(reserve); ESC0=$(escrow)

echo "== 1. mint demo USD to client and operator (token owner = deployer)"
send deployer "$TOKEN" 'mint(address,uint256)' "$CLIENT" "$AMOUNT"
expect "client balance" "$(bal "$CLIENT")" "$((CLIENT_BAL0 + AMOUNT))"
send deployer "$TOKEN" 'mint(address,uint256)' "$OPERATOR" "$RESERVE_DEPOSIT"
expect "operator balance" "$(bal "$OPERATOR")" "$((OP_BAL0 + RESERVE_DEPOSIT))"
CLIENT_BAL1=$((CLIENT_BAL0 + AMOUNT))

echo "== 2. client approves escrow allowance"
send client "$TOKEN" 'approve(address,uint256)' "$IA" "$AMOUNT"
expect "client allowance" "$(callu "$TOKEN" 'allowance(address,address)(uint256)' "$CLIENT" "$IA")" "$AMOUNT"

echo "== 3. client creates invoice"
ID=$(callu "$IA" 'nextInvoiceId()(uint256)')
META=$(cast keccak "duely-smoke-$(date +%s)-$ID")
send client "$IA" 'createInvoice(address,uint256,bytes32)' "$FREELANCER_ADDRESS" "$AMOUNT" "$META"
expect "nextInvoiceId" "$(callu "$IA" 'nextInvoiceId()(uint256)')" "$((ID + 1))"
expect "invoice client" "$(lower "$(invoice_field "$ID" 1)")" "$(lower "$CLIENT")"
expect "invoice freelancer" "$(lower "$(invoice_field "$ID" 0)")" "$(lower "$FREELANCER_ADDRESS")"
expect "invoice amount" "$(invoice_field "$ID" 2)" "$AMOUNT"
expect "invoice status (Created=0)" "$(invoice_field "$ID" 6)" 0

echo "== 4. client funds escrow"
send client "$IA" 'fundInvoice(uint256)' "$ID"
expect "invoice status (Funded=1)" "$(invoice_field "$ID" 6)" 1
expect "totalEscrow" "$(escrow)" "$((ESC0 + AMOUNT))"
expect "reserveBalance unchanged" "$(reserve)" "$RES0"
expect "client balance" "$(bal "$CLIENT")" "$((CLIENT_BAL1 - AMOUNT))"

echo "== 5. operator (deployer keystore) deposits reserve"
send deployer "$TOKEN" 'approve(address,uint256)' "$IA" "$RESERVE_DEPOSIT"
send deployer "$IA" 'depositReserve(uint256)' "$RESERVE_DEPOSIT"
expect "reserveBalance" "$(reserve)" "$((RES0 + RESERVE_DEPOSIT))"
expect "totalEscrow unchanged" "$(escrow)" "$((ESC0 + AMOUNT))"

echo "== 6. evaluator approves advance (90%)"
EVAL=$(cast keccak "duely-smoke-eval-$ID")
send evaluator "$IA" 'approveAdvance(uint256,bytes32)' "$ID" "$EVAL"
expect "invoice status (Advanced=2)" "$(invoice_field "$ID" 6)" 2
expect "invoice advanceAmount" "$(invoice_field "$ID" 3)" "$ADVANCE"
expect "freelancer balance" "$(bal "$FREELANCER_ADDRESS")" "$((FL_BAL0 + ADVANCE))"
expect "reserveBalance" "$(reserve)" "$((RES0 + RESERVE_DEPOSIT - ADVANCE))"
expect "totalEscrow unchanged by advance" "$(escrow)" "$((ESC0 + AMOUNT))"

echo "== 7. client approves completion"
send client "$IA" 'approveCompletion(uint256)' "$ID"
expect "invoice status (Settled=3)" "$(invoice_field "$ID" 6)" 3
expect "freelancer balance (full invoice)" "$(bal "$FREELANCER_ADDRESS")" "$((FL_BAL0 + AMOUNT))"
expect "reserveBalance (advance repaid)" "$(reserve)" "$((RES0 + RESERVE_DEPOSIT))"
expect "totalEscrow" "$(escrow)" "$ESC0"

echo "== solvency"
HELD=$(bal "$IA")
if [ "$HELD" -lt "$(( $(reserve) + $(escrow) ))" ]; then echo "FAIL  held < reserve+escrow" >&2; exit 1; fi
echo "  ok  token balance $HELD >= reserve + escrow"
echo "SMOKE TEST PASSED (invoice $ID)"
