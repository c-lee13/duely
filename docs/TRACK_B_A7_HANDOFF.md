# Track B / A7 handoff: dual-token chain SDK (dUSD and RLUSD)

Status: both deployments are live and verified on XRPL EVM Testnet (chain 1449000). dUSD is the
default. RLUSD completed two full on-chain settlements (A6.6.4b). Full detail: `docs/CHAIN_SDK_HANDOFF.md`
and `docs/TRANSACTION_LIFECYCLE.md`.

## 1. Choose the deployment (configuration only)

| Variable                                                        | Where                      | Value                                                                             |
| --------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| `DUELY_DEPLOYMENT`                                              | server                     | `dusd` (default) or `rlusd`                                                       |
| `NEXT_PUBLIC_DUELY_DEPLOYMENT`                                  | browser, set at build time | must equal the server value, else `DeploymentConfigError` (`DEPLOYMENT_MISMATCH`) |
| `NEXT_PUBLIC_XRPL_EVM_RPC_URL`, `NEXT_PUBLIC_XRPL_EVM_CHAIN_ID` | browser                    | public RPC, `1449000`                                                             |
| `XRPL_EVM_RPC_URL`                                              | server only                | authenticated RPC (secret)                                                        |
| `NEXT_PUBLIC_CONTRACT_ADDRESS`, `NEXT_PUBLIC_TOKEN_ADDRESS`     | optional diagnostics       | if set, must match the selected deployment; the generated manifest always wins    |

The evaluator signing key is yours to supply server-side (never `NEXT_PUBLIC_*`). No source change is
needed to switch tokens. An unknown value or a server/browser disagreement throws; nothing falls back silently.

## 2. Addresses

|                   | dUSD (default)                               | RLUSD                                        |
| ----------------- | -------------------------------------------- | -------------------------------------------- |
| InvoiceAdvance    | `0x328fc0DbF3d1F704B065192f4bFC7583bfA550E0` | `0x1B972ec6B1B5E0b592010e7484beF0accC382792` |
| Token             | `0x5ff7b6ae08c37868303e7A815308Af476421506c` | `0x27b57a9D0b8d24EB97259c4E2279e45255e016f3` |
| Symbol / decimals | dUSD / **6**                                 | RLUSD / **18**                               |
| `isDemoToken`     | true (label it a demo token)                 | false (issuer token; never call it a demo)   |
| Admin / operator  | `0x6e83F6Bb6758Ced46e60be88271D72C22B84482E` | same                                         |
| Evaluator         | `0x276acaB037BB048a682E0E7ad900F3fFDCe65ECb` | same                                         |
| Explorer          | https://explorer.testnet.xrplevm.org         | same                                         |

Operational state: RLUSD reserve is funded with 5 RLUSD (operator's own). dUSD reserve is 10,000 dUSD.
Amounts cross JSON as base-unit decimal strings (`toTokenAmount` / `fromTokenAmount`); never floats.

## 3. SDK APIs to use (all from `@/lib/chain`)

- Config (live views of the selection): `paymentTokenInfo` (`symbol`, `decimals`, `isDemoToken`, `kind`),
  `contractAddresses`, `activeDeployment()`, `explorerTxUrl`.
- Amounts: `parseToken` / `formatToken` (active token's decimals), `advanceAmountFor` (identical 90% floor math
  at 6 and 18 decimals), `parseTokenUnits` / `formatTokenUnits` for explicit decimals. `parseDusd` / `formatDusd`
  are aliases; do not hard-code decimals or the string "dUSD".
- Reads: `getInvoice`, `getReserveSnapshot`, `getTokenBalance`, `getTokenPauseStatus`, `hasRole`, `waitForBlock`.
  Pass `blockNumber` to pin a coherent snapshot (verification must read at the receipt block).
- Writes (client wallet): `createInvoice`, `approveEscrowAllowance`, `fundInvoice`, `approveCompletion`,
  `raiseDispute`. Server (A7): `approveAdvance` as the EVALUATOR_ROLE signer only.
- Readiness (read-only): `prepareFundInvoice`, `prepareDepositReserve` (both report `tokenPaused`).
- Lifecycle: `trackTransaction`, `waitForConfirmation`, `serializeSubmittedTransaction`, `parseSubmittedTransaction`.

## 4. Requirements for the integration

1. **Pending vs paid:** show `paid` only when `trackTransaction` returns `confirmed` (receipt plus the expected event).
   Never mark an advance paid from an HTTP 200 or a database row.
2. **Never auto-retry** a non-idempotent write after `SEND_FAILED`, `unknown`, `replaced` or `WAIT_TIMEOUT`; reconcile
   from chain state first. Persist an operation record with a unique key before sending (see "Backend operations that
   need durable idempotency" in the SDK handoff); the SDK's in-memory guard is per process.
3. **Stored transactions carry their deployment.** `serializeSubmittedTransaction` writes version 2 with the deployment
   key and addresses; restoring or tracking one under the other deployment throws `DEPLOYMENT_MISMATCH`. Version 1
   records (dUSD era) restore only while dUSD is active.
4. **Pause handling (RLUSD):** map `TOKEN_PAUSED` to a retry-later message; nothing is lost and nothing was sent.
   Funding, advance and settlement all fail while the issuer has the token paused.
5. **Issuer risk (RLUSD):** the issuer can pause, claw back and upgrade the token; one testnet EOA holds those roles.
   Clawback from the contract would leave it undercollateralised. This is documented, not mitigated.
6. **Do not mint or move RLUSD** from application code; we cannot mint it. Test balances come from the issuer's
   faucet-like contract.
7. **Error codes** to handle: `INVALID_INPUT`, `WRONG_CHAIN`, `UNAUTHORIZED_SIGNER`, `INSUFFICIENT_ALLOWANCE`,
   `INSUFFICIENT_BALANCE`, `TOKEN_PAUSED`, `DEPLOYMENT_MISMATCH`, `SIMULATION_REVERTED`, `USER_REJECTED`,
   `DUPLICATE_SUBMISSION`, `SEND_FAILED`, `TX_REVERTED`, `TX_REPLACED`, `RECEIPT_MISMATCH`, `WAIT_TIMEOUT`.
8. **Metadata hash:** the on-chain `metadataHash` is the agreement commitment (criteria included); one shared
   Keccak-256 encoding is required across frontend, backend and contract (CLAUDE.md section 6).

## 5. Verifying locally

`npm run test:chain` (offline), `npm run chain:integration` (read-only preflight), and the live commands in the SDK
handoff. Live-run JSON reports (`*-run*.json`) are gitignored; never commit them.
