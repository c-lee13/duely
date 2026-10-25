# Chain SDK handoff (Track A → Track B)

Everything Track B needs to talk to the deployed Duely contracts from TypeScript. The SDK lives in
`lib/chain/` and is plain TypeScript on [viem](https://viem.sh): **no React, no wagmi, no UI**.
Companion doc for the transaction state machine: [`TRANSACTION_LIFECYCLE.md`](./TRANSACTION_LIFECYCLE.md).

- **Network:** XRPL EVM Testnet, chain ID `1449000`. Explorer: https://explorer.testnet.xrplevm.org
- **Contracts** (source of truth: `contracts/deployments/xrpl-evm-testnet.json`, already wired into the SDK):
  - InvoiceAdvance `0x328fc0DbF3d1F704B065192f4bFC7583bfA550E0`
  - Duely Demo USD (`dUSD`, 6 decimals) `0x5ff7b6ae08c37868303e7A815308Af476421506c`
- **dUSD is a demo token.** Never call it USDC or RLUSD in UI copy (CLAUDE.md §9).
- Import everything from `@/lib/chain` (browser-safe). Server-only helpers are in `@/lib/chain/server`.

## What is exported

| Area | Exports |
|---|---|
| Config | `CHAIN_ID`, `xrplEvmTestnet` (viem-compatible chain), `contractAddresses`, `paymentTokenInfo`, `publicRpcUrl`, `getChainEnvIssues()` |
| Explorer links | `explorerTxUrl`, `explorerAddressUrl`, `explorerBlockUrl` (throw on bad input); `tryExplorerTxUrl`, `tryExplorerAddressUrl` (return `null`, use in render paths) |
| Amounts (bigint) | `parseDusd("12.5")`, `formatDusd(12500000n)`, `advanceAmountFor(amount)`, `toTokenAmount`/`fromTokenAmount` (JSON decimal strings), `DUSD_DECIMALS` |
| Clients | `getPublicClient()`, `createChainPublicClient(url?)`, `createWalletClientFromProvider(provider, account)` |
| Reads | `waitForBlock`, `getInvoice`, `findInvoice`, `getNextInvoiceId`, `getReserveBalance`, `getAvailableReserve`, `getTotalEscrow`, `getReserveSnapshot`, `getTokenMetadata`, `getTokenBalance`, `getTokenAllowance`, `getEscrowAllowance`, `hasRole`, `getPaymentTokenAddress`, `getOnchainRoleIds`, `ROLE_IDS`, `parseInvoiceId`, `INVOICE_STATUSES` |
| Writes | `createInvoice`, `cancelInvoice`, `approveEscrowAllowance`, `approveToken`, `revokeTokenApproval`, `fundInvoice`, `approveCompletion`, `raiseDispute`, `depositReserve`, `withdrawReserve`, `resolveDispute`, `approveAdvance` |
| Readiness checks | `prepareFundInvoice`, `prepareDepositReserve`, `getAllowanceStatus` (read-only, never send) |
| Lifecycle | `trackTransaction`, `getTransactionStatus`, `waitForConfirmation`, `isTerminalStatus`, `serializeSubmittedTransaction`, `parseSubmittedTransaction`, `getInvoiceIdFromReceipt`, `decodeInvoiceAdvanceEvents`, `submissionGuard` |
| Errors | `ChainReadError` (reads), `ChainWriteError` (writes; `.code`), `redactUrls` |
| ABIs | `invoiceAdvanceAbi`, `mockUsdcAbi` (generated, `as const`; regenerate with `npm run chain:abi`) |

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_XRPL_EVM_RPC_URL` | browser + server | **Public** RPC (`https://rpc.testnet.xrplevm.org`). Never put an authenticated URL here. |
| `NEXT_PUBLIC_XRPL_EVM_CHAIN_ID` | browser + server | `1449000` (diagnostic only). |
| `NEXT_PUBLIC_CONTRACT_ADDRESS`, `NEXT_PUBLIC_TOKEN_ADDRESS` | browser + server | Diagnostic only. The manifest always wins; `getChainEnvIssues()` lists any mismatch. |
| `XRPL_EVM_RPC_URL` | **server only** | Authenticated QuickNode URL (secret). Read only by `lib/chain/server.ts`. |
| Evaluator/operator signing key | **server only (A7)** | Not defined by Track A. Must be a server-side secret (env/KMS/keystore), never `NEXT_PUBLIC_*`, never logged. Pass a viem `Account` to `createServerWalletClient`. |

The live integration script and tooling additionally read `CHAIN_ID`, `CLIENT_ADDRESS`,
`EVALUATOR_ADDRESS`, `OPERATOR_ADDRESS`, `FREELANCER_ADDRESS`, optional `TOKEN_ADDRESS` /
`CONTRACT_ADDRESS`, keystore names (`CLIENT_ACCOUNT`, `EVALUATOR_ACCOUNT`, `DEPLOYER_ACCOUNT`),
`KEYSTORE_DIR` and `CLIENT_PASSWORD_FILE` / `EVALUATOR_PASSWORD_FILE` / `DEPLOYER_PASSWORD_FILE`.
See `.env.example`. Never commit `.env`.

## Reading state (no wallet needed)

```ts
import { getInvoice, findInvoice, getTokenBalance, getEscrowAllowance, getReserveSnapshot,
         formatDusd, ChainReadError } from "@/lib/chain"

const invoice = await getInvoice("1")            // id: bigint | number | decimal string
// { invoiceId, client, freelancer, amount, advanceAmount, metadataHash, evaluationHash,
//   status: 3, statusName: "Settled" }  -- amounts are bigint base units
const maybe = await findInvoice(99)              // null if it does not exist

const balance = await getTokenBalance(address)   // bigint
formatDusd(balance)                              // "1000" -> render with a demo-token label
const allowance = await getEscrowAllowance(address)
const reserve = await getReserveSnapshot()       // reserve, escrow, contract balance, solvent, all at one block

try { await getInvoice(0) } catch (e) {
  if (e instanceof ChainReadError) e.code        // INVALID_INVOICE_ID | INVOICE_NOT_FOUND | RPC_ERROR ...
}
```

**Reading right after a transaction.** Do not read "latest" immediately after a confirmation: the
RPC may be a block behind, and viem caches the chain head per client for ~4 s. Call
`waitForBlock(status.blockNumber)` and pin every related read to `{ blockNumber: status.blockNumber }`
(see rule 8 in [`TRANSACTION_LIFECYCLE.md`](./TRANSACTION_LIFECYCLE.md)). A failed state read is not a
failed transaction.

On the server, pass the QuickNode-backed client: `getInvoice(id, { client: getServerPublicClient() })`
(from `@/lib/chain/server`). Status enum: `Created, Funded, Advanced, Settled, Disputed, Cancelled`.

## Connecting a browser wallet

Track B owns the connect UI. Once you have an EIP-1193 provider and the connected account:

```ts
import { createWalletClientFromProvider } from "@/lib/chain"
const wallet = createWalletClientFromProvider(window.ethereum, connectedAddress)
```

- The SDK **never switches networks and never connects**. If the wallet is on another chain every
  write rejects with `WRONG_CHAIN`; show a "switch to XRPL EVM Testnet" prompt and let the user do it.
- Any viem `WalletClient` that carries an account also works (for example one derived from wagmi
  later); viem itself sends transactions exactly once.

## Create, fund and settle an invoice

All writes take `{ wallet }` as the last argument and return a `SubmittedTransaction` (hash, link,
and the evidence to verify). They validate input, check the chain, simulate, and send once.

```ts
import { createInvoice, approveEscrowAllowance, fundInvoice, approveCompletion, parseDusd,
         prepareFundInvoice, trackTransaction } from "@/lib/chain"

const amount = parseDusd("1000")                        // strict: >6 decimals is rejected, never rounded

// 1. CLIENT creates the invoice. metadataHash = keccak256 of the canonical agreement (CLAUDE.md §6).
const created = await trackTransaction(await createInvoice({ freelancer, amount, metadataHash }, { wallet }))
if (created.state !== "confirmed") return handle(created)
const invoiceId = created.invoiceId!                     // decimal string, verified against the event

// 2. CLIENT approves exactly the amount, then funds (fundInvoice never approves for you).
const ready = await prepareFundInvoice(invoiceId, clientAddress)  // { ready, blockers[] } read-only
await trackTransaction(await approveEscrowAllowance(amount, { wallet }))
await trackTransaction(await fundInvoice(invoiceId, { wallet }))

// 3. (backend/evaluator advances 90%: see below)

// 4. CLIENT settles. Disputing instead: raiseDispute(invoiceId, { wallet }).
await trackTransaction(await approveCompletion(invoiceId, { wallet }))
```

## Tracking pending and confirmed transactions

`trackTransaction(submitted, { onStatus })` returns a typed status and never throws on lifecycle
outcomes: `pending → confirmed | reverted | replaced | unverified | unknown`. **Pass the whole
`SubmittedTransaction`, not just its hash**, so the receipt is verified against the operation.
Only `confirmed` means done; `unknown` means "still checking", never "failed", and never resubmit.
Full state table and rules: [`TRANSACTION_LIFECYCLE.md`](./TRANSACTION_LIFECYCLE.md).

## Resuming after a page reload

```ts
import { serializeSubmittedTransaction, parseSubmittedTransaction, trackTransaction,
         isTerminalStatus } from "@/lib/chain"

localStorage.setItem(key, serializeSubmittedTransaction(submitted))      // right after submitting
// ... reload ...
const status = await trackTransaction(parseSubmittedTransaction(localStorage.getItem(key)!), { onStatus })
if (isTerminalStatus(status)) localStorage.removeItem(key)               // 'unknown' is NOT terminal
```

Stored data is untrusted: `parseSubmittedTransaction` validates every field and throws
`INVALID_INPUT` on anything inconsistent. The in-memory duplicate guard does not survive a reload,
so keep your own "transaction in flight" flag in the UI.

## Who may call what (enforced on-chain)

| Function | Signer | Notes |
|---|---|---|
| `createInvoice` | any wallet (becomes the **client**) | freelancer must differ from the client |
| `cancelInvoice` | invoice **client** | only while `Created` |
| `approveEscrowAllowance` / `approveToken` | any dUSD holder | exact amounts; unlimited needs `allowUnlimited: true` |
| `fundInvoice` | invoice **client** | needs allowance and balance ≥ amount |
| `approveCompletion`, `raiseDispute` | invoice **client** | `Funded`/`Advanced` only |
| `approveAdvance` | **evaluator** (`EVALUATOR_ROLE`, server-side) | once per invoice, pays floor(90%) from the reserve |
| `depositReserve`, `withdrawReserve`, `resolveDispute` | **operator** (`OPERATOR_ROLE`) | operator also needs dUSD + allowance for deposits |

`WRITE_REQUIREMENTS` exports this table. A wrong signer fails at simulation with
`UNAUTHORIZED_SIGNER` before anything is sent. The browser never holds the evaluator or operator key.

## Backend operations that need durable idempotency (A7 / Track B)

The SDK's `submissionGuard` is **in-memory, per process**: it blocks double-clicks and repeated
calls until a transaction is mined (5-minute cap) but not duplicates across tabs, servers, serverless
instances or restarts. Persist an operation record in the database **before** sending, with a unique key:

| Operation | Unique key | Why |
|---|---|---|
| `approveAdvance` (server-signed) | `(chainId, contract, invoiceId, "advance")` | A repeat would revert, but concurrent requests must still share one send (CLAUDE.md §8). |
| Any other server-signed write (`resolveDispute`, reserve ops) | `(chainId, contract, action, target)` | Reserve deposits/withdrawals are **not** protected by the contract against repeats. |
| Registering a client-created invoice (`POST /api/invoices`) | `txHash` and `invoiceId` | The client's tx may be reported twice; verify the receipt and event, then upsert. |
| Marking an advance/settlement "paid" | `txHash` | Only after `status.state === "confirmed"` (receipt + event), never from an HTTP 200. |

Before signing `approveAdvance`, the backend must itself verify what the contract cannot: an
authenticated freelancer request, a persisted passing evaluation, and chain state `Funded`.
After `SEND_FAILED`, `unknown` or `replaced`, reconcile from chain state before retrying.

## Error handling cheat sheet (`ChainWriteError.code`)

| Code | Meaning | Suggested handling |
|---|---|---|
| `INVALID_INPUT` | Bad address/amount/ID/hash | Fix the input; nothing was sent |
| `WRONG_CHAIN`, `NO_ACCOUNT` | Wallet on another chain / no account | Ask the user to switch or connect |
| `UNAUTHORIZED_SIGNER` | Wrong role or not the invoice client | Explain who must act |
| `INSUFFICIENT_ALLOWANCE`, `INSUFFICIENT_BALANCE` | Token prerequisites missing | Offer `approveEscrowAllowance`; never auto-approve |
| `SIMULATION_REVERTED`, `INVOICE_NOT_FOUND` | Would fail on-chain (message names the reason) | Show the reason; nothing was sent |
| `USER_REJECTED` | User declined in the wallet | Quietly reset |
| `DUPLICATE_SUBMISSION` | Identical tx still pending (`error.txHash`) | Track that hash instead |
| `SEND_FAILED` | Wallet/RPC failed to send; it may still have been broadcast | Check recent transactions before retrying |
| `TX_REVERTED`, `TX_REPLACED`, `RECEIPT_MISMATCH`, `WAIT_TIMEOUT` | See the lifecycle doc | Do not show success |

## Verifying the SDK against the live contracts

```bash
npm run test:chain                    # 235 offline tests (SDK + integration script logic)
npm run chain:integration             # read-only preflight against the live testnet (sends nothing)
npm run chain:integration -- --execute --amount 100   # broadcasts 5 transactions (see below)
```

The integration script drives a NEW invoice through create → approve → fund → advance → settle using
only the public SDK APIs, tracks each transaction to a verified confirmation, stops at the first
problem, never retries, and never mints or transfers funds. After each confirmed transaction it
checks the live state **at that transaction's receipt block** (waiting for the RPC to reach it), so a
lagging RPC cannot make a completed settlement look like a failure. Exit codes: `0` passed, `1`
blocked or a transaction was not confirmed, `3` every transaction up to the last is confirmed but the
follow-up state check could not be completed or disagreed (re-run the read-only preflight). **Prerequisite for `--execute`:** the
client wallet needs the invoice amount in dUSD; only the token owner can mint it (the preflight
prints the exact `cast` command). Keystore passwords are read from a hidden prompt or a mode-600
`*_PASSWORD_FILE`.

## Rehearsing on a local fork (no live transactions)

The `--execute` path is rehearsed end to end against a **local fork** of the testnet: the real
contracts run at their real addresses, impersonated accounts sign (no keys), and nothing reaches the
live chain.

```bash
anvil --fork-url https://rpc.testnet.xrplevm.org --chain-id 1449000 --port 8560 --auto-impersonate
npm run chain:rehearse -- --scenario normal          # 5 transactions: create, approve, fund, advance, settle
npm run chain:rehearse -- --scenario topup           # 7 transactions: reserve too small, operator tops it up
npm run chain:rehearse -- --scenario bad-evaluator   # wrong signer: must stop safely at the advance
```

It refuses to run unless the node on `127.0.0.1:8560` answers `anvil_nodeInfo`. Its fork-only setup
(minting dUSD as the token owner, withdrawing reserve as the operator) is never part of the real script.
All three scenarios passed when this was written.

## Known limits

- Verified against mocks, read-only calls on the live testnet, and a local fork of it; the write path
  has not yet run through a live wallet. The `--execute` run above is the first live end-to-end proof.
- Replacement detection depends on the RPC having seen the original transaction pending.
- The advance is paid to the freelancer address recorded at `createInvoice`; it cannot change.
- Nothing here is production-grade: demo token, testnet, trusted evaluator/operator roles.
