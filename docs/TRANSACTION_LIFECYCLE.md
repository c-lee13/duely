# Transaction lifecycle (Track A SDK → Track B)

How a frontend should submit a write and decide what happened. Framework-agnostic: all of this
is plain TypeScript from `@/lib/chain`. Nothing here is a React hook.

**Golden rule: pass the whole `SubmittedTransaction` to `trackTransaction` / `waitForConfirmation`,
never just `submitted.hash`.** A bare hash can only be checked for identity; the full object lets
the SDK prove the *intended operation* ran (right sender, right contract, the expected event with
the expected arguments). On-chain receipts and events are authoritative; a database row, an HTTP
200 or an optimistic UI is not (CLAUDE.md §5).

## States

`trackTransaction(submitted)` resolves to a `TransactionStatus` whose `state` is one of:

| state        | Meaning                                                                                           | Show the user                          | Final? |
|--------------|---------------------------------------------------------------------------------------------------|----------------------------------------|--------|
| `pending`    | Hash exists, awaiting confirmation.                                                               | "Submitted… (link to explorer)"        | no     |
| `confirmed`  | Mined, succeeded, **and** carried the expected event. `verified: true`.                           | Success                                | yes    |
| `reverted`   | Mined but reverted. Nothing changed on-chain.                                                     | Failed, safe to retry                  | yes    |
| `replaced`   | Cancelled or replaced by a different transaction in the wallet. The operation did **not** run.    | Cancelled/replaced, not done           | yes    |
| `unverified` | Mined "successfully" but does not prove the operation (wrong tx, sender, contract, missing or ambiguous event). | Do **not** show success; investigate | yes    |
| `unknown`    | Could not determine the outcome (`reason`: `timeout`, `rpc_error`, `not_found`). May still land.  | "Still checking…" — never "failed"     | no     |

Every status carries `hash`, `requestedHash`, `explorerUrl` and (when known) `functionName`.
Non-success statuses carry `error: ChainWriteError` (`TX_REVERTED`, `TX_REPLACED`,
`RECEIPT_MISMATCH`, `WAIT_TIMEOUT`, `RPC_ERROR`). `confirmed` additionally carries:

- `blockNumber` (bigint), `receipt`, `events` (all decoded InvoiceAdvance events)
- `event` – the matched expected event with decoded `args` (e.g. `InvoiceSettled.freelancerPaid`)
- `invoiceId` – **decimal string** from the verified event (matches `InvoiceId` in CLAUDE.md §6);
  `null` for reserve/approval operations
- `feeBumpedFrom` – set only if the wallet sped the tx up with an identical call; `hash` is then
  the replacement that was actually mined
- `verified` – `false` only for a bare-hash wait; treat as weaker evidence

`isTerminalStatus(status)` is true for confirmed / reverted / replaced / unverified.

## Recommended flow

```ts
import {
  createWalletClientFromProvider, fundInvoice, trackTransaction, isTerminalStatus,
  serializeSubmittedTransaction, parseSubmittedTransaction,
} from "@/lib/chain"

const wallet = createWalletClientFromProvider(provider, connectedAddress) // the user's wallet

// 1. Submit. Throws ChainWriteError for validation / wrong chain / simulation reverts / user
//    rejection / send failure / duplicate. Nothing is retried for you.
const submitted = await fundInvoice(invoiceId, { wallet })

// 2. Persist BEFORE awaiting, so a reload can resume (the object holds bigints, so use the helper).
localStorage.setItem(`tx:${submitted.hash}`, serializeSubmittedTransaction(submitted))

// 3. Track to a final answer. Never throws on lifecycle outcomes.
const status = await trackTransaction(submitted, { onStatus: setStatus }) // pending, then final

if (status.state === "confirmed") {
  // safe to update UI; POST to the backend with status.hash / status.invoiceId
}
if (isTerminalStatus(status)) localStorage.removeItem(`tx:${submitted.hash}`)
// 'unknown' is NOT terminal: keep the entry and call trackTransaction again later.

// After a page reload:
const resumed = parseSubmittedTransaction(localStorage.getItem(key)!) // validates; throws on tampering
await trackTransaction(resumed, { onStatus: setStatus })
```

- Polling UI instead of one long wait: `getTransactionStatus(submitted)` is a single non-blocking
  look (pending / confirmed / reverted / unverified / unknown). It cannot detect a cancellation or
  replacement; use `trackTransaction` for that.
- Prefer success-or-throw? `waitForConfirmation(submitted)` returns the confirmed status or throws
  the same `ChainWriteError` the status would carry.
- Tracking has no cancellation handle. On unmount, stop caring about the result; the default wait
  is 120 s (`timeoutMs`) and then yields `unknown/timeout`.

## Rules for Track B

1. **Never resubmit on `unknown`, `replaced`, or a send failure** without checking chain state
   first. A new `createInvoice` makes a second invoice; a second deposit moves funds twice.
2. **`unknown` is not failure.** `timeout`/`rpc_error`/`not_found` mean "we don't know yet".
3. **Only `confirmed` means done.** `unverified` and `replaced` must never render as success, even
   if an explorer shows a successful transaction.
4. **Use `status.invoiceId` after `createInvoice`**, not a guess. `getInvoiceIdFromReceipt` refuses
   to choose between multiple `InvoiceCreated` events (throws `RECEIPT_MISMATCH`); a verified
   confirmation already matched the exact client, freelancer, amount and metadata hash.
5. **Links:** use `submitted.explorerUrl` / `status.explorerUrl`, or `explorerTxUrl(hash)`,
   `explorerAddressUrl(address)`, `explorerBlockUrl(n)`. They validate input and throw `TypeError`
   on malformed values; use the `tryExplorer*Url` variants (return `null`) in render paths.
6. **Durable idempotency is yours.** The SDK's `submissionGuard` is in-memory, per process: it
   stops double-clicks and repeated calls (until the tx is mined, 5-minute cap) but not duplicates
   across tabs, servers or restarts. A7/Track B must keep a database record per
   (chainId, contract, invoiceId, action) (CLAUDE.md §8).
7. Show amounts with `formatDusd`; the token is a **demo token**, never "USDC".
8. **After `confirmed`, read state AT the receipt block, never at "latest".** An RPC is often
   several nodes behind a load balancer, and viem caches `getBlockNumber` per client for ~4 s, so a
   plain read right after a confirmation can come from a block *before* your transaction (or mix
   blocks across reads). A real run hit this: a verified settlement was followed by a read showing
   the pre-settlement reserve and escrow (state of the previous block), while the invoice read
   showed `Settled`. Do this instead:

   ```ts
   const status = await trackTransaction(submitted)
   if (status.state === "confirmed") {
     await waitForBlock(status.blockNumber)                       // fresh head, waits if the RPC is behind
     const at = { blockNumber: status.blockNumber }               // pin EVERY related read to the same block
     const [invoice, reserve, balance] = await Promise.all([
       getInvoice(invoiceId, at), getReserveSnapshot(at), getTokenBalance(address, at),
     ])
   }
   ```

   A pinned read either returns the state at that block or errors (`header not found` from a node
   that is behind: retry shortly). A mismatch there is real; a mismatch from unpinned reads may not be.
   Never treat a failed or inconclusive *state read* as a failed *transaction*: the confirmed receipt
   with its verified event is the proof of what happened.

## Operation → evidence

What each operation must emit for `confirmed` (single source of truth: `EXPECTED_EVENTS`; checked
against the ABI and `docs/CONTRACT_SPEC.md` §6 by tests):

| Operation            | Event (contract)                 | Matched arguments                              |
|----------------------|----------------------------------|------------------------------------------------|
| `createInvoice`      | `InvoiceCreated` (InvoiceAdvance)| client, freelancer, amount, metadataHash (exactly one match required) |
| `cancelInvoice`      | `InvoiceCancelled`               | invoiceId                                      |
| `fundInvoice`        | `InvoiceFunded`                  | invoiceId, client                              |
| `approveAdvance`     | `AdvancePaid`                    | invoiceId, evaluationHash                      |
| `approveCompletion`  | `InvoiceSettled`                 | invoiceId                                      |
| `raiseDispute`       | `InvoiceDisputed`                | invoiceId, client                              |
| `resolveDispute`     | `DisputeResolved`                | invoiceId, releasedToFreelancer                |
| `depositReserve`     | `ReserveDeposited`               | operator, amount                               |
| `withdrawReserve`    | `ReserveWithdrawn`               | operator, amount                               |
| token `approve*`     | `Approval` (dUSD)                | owner, spender, value                          |

The receipt must also be sent by the submitting account and addressed to that contract.

## Known limits

- viem recognises a replacement only for a transaction it saw pending; if the RPC never indexed
  the original you get `unknown/timeout`, not `replaced`. Both mean "don't assume success".
- Wallet extensions/connectors may retry internally where the SDK cannot see (viem itself sends
  once; see the canary test in `writes.hardening.test.ts`).
- Verified on mocks and read-only calls; no write has gone through a live wallet yet.
