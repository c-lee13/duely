import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  encodeFunctionData,
  isAddress,
  isHex,
  size,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem"

import { MAX_UINT256 } from "./amounts"
import { getPublicClient } from "./client"
import {
  CHAIN_ID,
  contractAddresses,
  explorerTxUrl,
  paymentTokenInfo,
  type HexAddress,
} from "./config"
import {
  activeDeploymentIdentity,
  type DeploymentIdentity,
} from "./deployments"
import { expectedFor, type ExpectedReceipt } from "./expected"
import {
  ChainReadError,
  ChainWriteError,
  redactUrls,
  type ChainWriteErrorCode,
} from "./errors"
import { invoiceAdvanceAbi, paymentTokenAbi } from "./generated"
import { duelyVaultAbi, escrowAbi, isV2 } from "./protocol"
import { tokenPauseAbi } from "./token-pause"
import {
  INVOICE_STATUSES,
  getEscrowAllowance,
  getInvoice,
  getTokenAllowance,
  getTokenBalance,
  getTokenPauseStatus,
  hasRole,
  parseInvoiceId,
  type InvoiceDetails,
  type ReadOptions,
} from "./reads"

/**
 * Typed write layer for InvoiceAdvance and the payment token. Framework-agnostic and browser-safe:
 * it holds no keys and no server credentials. The CALLER supplies a viem WalletClient already
 * connected to the right account:
 *   - Track B (browser): a wallet client for the user's connected wallet, e.g.
 *     `createWalletClientFromProvider(window.ethereum, address)` from ./client, or the client
 *     wagmi's `useWalletClient` returns.
 *   - A7 (server): `createServerWalletClient(account)` from ./server for the evaluator/operator.
 *
 * Every operation: validates inputs -> checks wallet and RPC are on chain 1449000 (never
 * switches networks) -> blocks identical pending submissions -> runs preflight reads -> simulates
 * -> submits exactly once -> returns the tx hash. Nothing is retried automatically (writes are
 * not idempotent); use `waitForConfirmation(submitted)` and chain state, not a blind retry, to
 * learn the outcome. Amounts are `bigint` base units.
 *
 * Limits worth knowing:
 *   - The pending-submission guard is process-local memory. It stops double-clicks and repeated
 *     calls within one runtime, NOT duplicates across servers/tabs/restarts. A7 and Track B must
 *     still enforce durable idempotency in the database (CLAUDE.md §8).
 *   - Transport retries: viem hard-codes `retryCount: 0` for `eth_sendTransaction` and
 *     `eth_sendRawTransaction` (the only send paths `writeContract` uses), so any viem wallet
 *     client sends exactly once whatever its transport `retryCount` is. This is verified for the
 *     installed viem by a canary test (writes.hardening.test.ts) that fails if an upgrade changes
 *     it. The SDK cannot see inside a wallet extension/connector or a non-viem client, which
 *     could still retry internally; `createWalletClientFromProvider` also sets `retryCount: 0`
 *     as defense in depth.
 */

// ---- types -----------------------------------------------------------------------------------

/** The slice of viem's WalletClient the SDK needs. The wallet must carry an account. */
export type ChainWalletClient = Pick<
  WalletClient,
  "account" | "chain" | "getChainId" | "writeContract"
>

/** The slice of viem's PublicClient the SDK needs for preflight, simulation and confirmation. */
export type ChainWriteClient = Pick<
  PublicClient,
  | "readContract"
  | "getBlockNumber"
  | "simulateContract"
  | "getChainId"
  | "getTransaction"
  | "getTransactionReceipt"
  | "waitForTransactionReceipt"
>

export interface WriteContext {
  /** Signs and sends. Its account is the transaction sender. */
  wallet: ChainWalletClient
  /** Reads, simulates and confirms. Defaults to the shared public-RPC client. */
  publicClient?: ChainWriteClient
}

export type { ExpectedReceipt }

export interface SubmittedTransaction {
  hash: Hex
  functionName: string
  from: Address
  chainId: number
  /** Pass the whole object to waitForConfirmation / trackTransaction so the receipt is verified against it. */
  expected: ExpectedReceipt
  /** When the wallet returned the hash (ms since epoch). */
  submittedAt: number
  /** Link to the transaction on the block explorer. */
  explorerUrl: string
  /**
   * The deployment (dUSD or RLUSD) this was submitted under. Tracking it under another active
   * deployment fails with DEPLOYMENT_MISMATCH. Absent only on legacy (version 1) records.
   */
  deployment?: DeploymentIdentity
}

export type SignerRole = "client" | "operator" | "evaluator" | "token-holder"

/** Who must sign each operation (enforced on-chain; the SDK reports violations clearly). */
export const WRITE_REQUIREMENTS = {
  createInvoice: "client",
  cancelInvoice: "client",
  approveToken: "token-holder",
  fundInvoice: "client",
  depositReserve: "operator",
  withdrawReserve: "operator",
  approveAdvance: "evaluator",
  approveCompletion: "client",
  raiseDispute: "client",
  resolveDispute: "operator",
} as const satisfies Record<string, SignerRole>

type InvoiceAdvanceWriteName = Extract<
  (typeof invoiceAdvanceAbi)[number],
  { type: "function"; stateMutability: "nonpayable" }
>["name"]
type VaultWriteName = Extract<
  (typeof duelyVaultAbi)[number],
  { type: "function"; stateMutability: "nonpayable" }
>["name"]
type TokenWriteName = Extract<
  (typeof paymentTokenAbi)[number],
  { type: "function"; stateMutability: "nonpayable" }
>["name"]

// Token errors are added to the decode ABI so reverts bubbling up from SafeERC20 are readable.
// Under v2 the escrow ABI is InvoiceAdvanceV2's, and DuelyVault's errors are added because vault reverts
// (InsufficientLiquidity, ExceedsUtilizationLimit, ...) bubble up through the escrow call.
function invoiceAdvanceDecodeAbi(): Abi {
  return [
    ...escrowAbi(),
    ...(isV2() ? duelyVaultAbi.filter((item) => item.type === "error") : []),
    ...paymentTokenAbi.filter((item) => item.type === "error"),
    ...tokenPauseAbi.filter((item) => item.type === "error"),
  ] as Abi
}

// Token calls are simulated against this ABI, so a paused token's revert decodes as EnforcedPause.
const TOKEN_CALL_ABI = [
  ...paymentTokenAbi,
  ...tokenPauseAbi.filter((item) => item.type === "error"),
] as Abi

// ---- validation ------------------------------------------------------------------------------

function invalid(message: string): ChainWriteError {
  return new ChainWriteError("INVALID_INPUT", message)
}

/**
 * Accepts all-lowercase addresses and correctly checksummed (EIP-55) addresses. A mixed-case
 * address with a wrong checksum is rejected: it is almost certainly a typo, and the funds
 * (advance, settlement, approvals) would go somewhere unrecoverable.
 */
function assertAddress(value: unknown, what: string): HexAddress {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw invalid(
      `${what} is not a valid address (bad format or EIP-55 checksum)`
    )
  }
  if (value.toLowerCase() === zeroAddress) {
    throw invalid(`${what} must not be the zero address`)
  }
  return value as HexAddress
}

function assertAmount(value: unknown, what: string): bigint {
  if (typeof value !== "bigint")
    throw invalid(`${what} must be a bigint (base units)`)
  if (value <= BigInt(0)) throw invalid(`${what} must be greater than zero`)
  if (value > MAX_UINT256) throw invalid(`${what} exceeds uint256`)
  return value
}

function assertId(value: bigint | number | string): bigint {
  try {
    return parseInvoiceId(value)
  } catch {
    throw invalid("invoice ID must be a positive integer up to uint256")
  }
}

function assertBytes32(value: unknown, what: string): Hex {
  if (
    typeof value !== "string" ||
    !isHex(value, { strict: true }) ||
    size(value) !== 32
  ) {
    throw invalid(`${what} must be a 32-byte hex string`)
  }
  if (value === zeroHash) throw invalid(`${what} must not be zero`)
  return value
}

// ---- error mapping ---------------------------------------------------------------------------

type Phase = "simulate" | "send"

function describeRevert(
  name: string | undefined,
  args: readonly unknown[]
): string {
  if (!name) return "unknown reason"
  if (name === "InvalidStatus" && args.length === 2) {
    const status = Number(args[1])
    return `InvalidStatus: invoice is ${INVOICE_STATUSES[status] ?? status}`
  }
  if (name === "InsufficientLiquidity" && args.length === 2) {
    return `InsufficientLiquidity: required ${String(args[0])}, available ${String(args[1])} (base units)`
  }
  if (name === "InsufficientReserve" && args.length === 2) {
    return `InsufficientReserve: required ${String(args[0])}, available ${String(args[1])} (base units)`
  }
  return name
}

/** @internal Used by lifecycle.ts; deliberately not part of the public index. */
export function mapWriteError(
  error: unknown,
  label: string,
  phase: Phase
): ChainWriteError {
  if (error instanceof ChainWriteError) return error
  if (error instanceof ChainReadError) {
    if (error.code === "INVOICE_NOT_FOUND") {
      return new ChainWriteError(
        "INVOICE_NOT_FOUND",
        `${label}: invoice does not exist`
      )
    }
    return new ChainWriteError("RPC_ERROR", `${label}: ${error.message}`)
  }

  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) {
      return new ChainWriteError(
        "USER_REJECTED",
        `${label}: the wallet user rejected the request`
      )
    }
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError)
    // Viem reports generic JSON-RPC faults (e.g. -32603) raised during writeContract as
    // "reverted". After a successful simulation that is a send failure, not a contract rejection.
    if (phase === "send") {
      const detail =
        revert instanceof ContractFunctionRevertedError &&
        revert.data?.errorName
          ? `reverted at send time: ${revert.data.errorName}`
          : redactUrls(error.shortMessage)
      return new ChainWriteError(
        "SEND_FAILED",
        `${label}: sending failed (${detail}). Not retried; the transaction may or may not have been broadcast, so check the account's recent transactions before submitting again.`
      )
    }
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName
      const args = (revert.data?.args ?? []) as readonly unknown[]
      let code: ChainWriteErrorCode = "SIMULATION_REVERTED"
      if (
        name === "AccessControlUnauthorizedAccount" ||
        name === "NotInvoiceClient" ||
        name === "NotInvoiceFreelancer"
      ) {
        code = "UNAUTHORIZED_SIGNER"
      } else if (name === "InvoiceNotFound") code = "INVOICE_NOT_FOUND"
      else if (name === "ERC20InsufficientAllowance")
        code = "INSUFFICIENT_ALLOWANCE"
      else if (name === "ERC20InsufficientBalance")
        code = "INSUFFICIENT_BALANCE"
      else if (name === "EnforcedPause") code = "TOKEN_PAUSED"
      return new ChainWriteError(
        code,
        `${label} would revert: ${describeRevert(name, args)}`,
        {
          revertName: name,
        }
      )
    }
    return new ChainWriteError(
      "RPC_ERROR",
      `${label}: ${redactUrls(error.shortMessage)}`
    )
  }

  const message = error instanceof Error ? error.message : String(error)
  return new ChainWriteError(
    phase === "send" ? "SEND_FAILED" : "RPC_ERROR",
    `${label}: ${redactUrls(message)}`
  )
}

// ---- pending-submission guard ----------------------------------------------------------------

interface PendingSubmission {
  startedAt: number
  label: string
  /** Set once the wallet returned a hash; the entry then lasts until the tx is mined. */
  hash?: Hex
  /** A send failed in a way that may have still broadcast the transaction. */
  ambiguous?: boolean
}

interface GuardState {
  byKey: Map<string, PendingSubmission>
  keyByHash: Map<string, string>
}

// Stored on globalThis so separate bundles/HMR copies of this module in one runtime share it.
const GUARD_SLOT = "__duelyChainPendingSubmissions"

function guardState(): GuardState {
  const g = globalThis as unknown as Record<string, GuardState | undefined>
  let state = g[GUARD_SLOT]
  if (!state) {
    state = { byKey: new Map(), keyByHash: new Map() }
    g[GUARD_SLOT] = state
  }
  return state
}

/**
 * Process-local guard against resubmitting an identical write (same chain, sender, contract and
 * calldata) while an earlier one is still pending. An entry is released when the transaction is
 * mined (confirmed by `waitForConfirmation`, or noticed lazily via its receipt on the next
 * identical call), when the attempt fails before anything was sent, or after `ttlMs` so a caller
 * that never confirms cannot lock itself out forever.
 *
 * This is NOT durable idempotency: it does not survive restarts and is not shared between
 * servers, serverless instances or browser tabs. A7 must still persist one operation record per
 * (chainId, contract, invoiceId, action) in the database (CLAUDE.md §8).
 */
export const submissionGuard = {
  /** Longest an unconfirmed entry blocks resubmission. Default 5 minutes. */
  ttlMs: 5 * 60 * 1000,
  /** Clock (injectable for tests). */
  now: (): number => Date.now(),
  /** Number of entries currently held. */
  size: (): number => guardState().byKey.size,
  /** Drops every entry: for tests, or after manually verifying on-chain state. */
  clear(): void {
    const state = guardState()
    state.byKey.clear()
    state.keyByHash.clear()
  },
  /** clear() and restore the default ttl and clock. */
  reset(): void {
    submissionGuard.clear()
    submissionGuard.ttlMs = 5 * 60 * 1000
    submissionGuard.now = () => Date.now()
  },
}

function dropEntry(key: string, entry: PendingSubmission): void {
  const state = guardState()
  if (state.byKey.get(key) !== entry) return
  state.byKey.delete(key)
  if (entry.hash) state.keyByHash.delete(entry.hash.toLowerCase())
}

/** @internal Used by lifecycle.ts; deliberately not part of the public index. */
export function releaseByHash(hash: string): void {
  const state = guardState()
  const key = state.keyByHash.get(hash.toLowerCase())
  if (!key) return
  const entry = state.byKey.get(key)
  if (entry) dropEntry(key, entry)
  else state.keyByHash.delete(hash.toLowerCase())
}

async function isStillPending(
  entry: PendingSubmission,
  client: ChainWriteClient
): Promise<boolean> {
  if (submissionGuard.now() - entry.startedAt >= submissionGuard.ttlMs)
    return false
  // No hash yet: still being submitted, or a send failed ambiguously. Hold until the ttl.
  if (!entry.hash) return true
  try {
    await client.getTransactionReceipt({ hash: entry.hash })
    return false // mined (success or revert): the contract's own state checks take over
  } catch {
    // TransactionReceiptNotFoundError means still pending. Any other failure means we cannot
    // tell, so fail closed (the ttl bounds the lock).
    return true
  }
}

function duplicateError(
  entry: PendingSubmission,
  label: string
): ChainWriteError {
  if (entry.hash) {
    return new ChainWriteError(
      "DUPLICATE_SUBMISSION",
      `${label}: an identical transaction from this account is still pending (${entry.hash}). Wait for it with waitForConfirmation instead of resubmitting.`,
      { txHash: entry.hash }
    )
  }
  if (entry.ambiguous) {
    return new ChainWriteError(
      "DUPLICATE_SUBMISSION",
      `${label}: an earlier identical attempt failed while sending and may have been broadcast. Resubmission is blocked for up to ${Math.round(submissionGuard.ttlMs / 1000)}s; check the account's recent transactions first.`
    )
  }
  return new ChainWriteError(
    "DUPLICATE_SUBMISSION",
    `${label}: an identical transaction from this account is already being submitted`
  )
}

/** Claims the key or throws DUPLICATE_SUBMISSION. Everything after the last await is synchronous. */
async function acquire(
  key: string,
  label: string,
  client: ChainWriteClient
): Promise<PendingSubmission> {
  const state = guardState()
  // Opportunistic cleanup of expired entries so the map cannot grow without bound.
  for (const [k, e] of state.byKey) {
    if (submissionGuard.now() - e.startedAt >= submissionGuard.ttlMs)
      dropEntry(k, e)
  }
  for (;;) {
    const existing = state.byKey.get(key)
    if (!existing) break
    if (await isStillPending(existing, client))
      throw duplicateError(existing, label)
    if (state.byKey.get(key) === existing) {
      dropEntry(key, existing)
      break
    }
    // Another caller replaced it while we were checking: re-evaluate against the new entry.
  }
  const entry: PendingSubmission = { startedAt: submissionGuard.now(), label }
  state.byKey.set(key, entry)
  return entry
}

// ---- core ------------------------------------------------------------------------------------

export interface Call {
  address: HexAddress
  abi: Abi
  functionName:
    | InvoiceAdvanceWriteName
    | TokenWriteName
    | VaultWriteName
    | "claim"
  args: readonly unknown[]
  label: string
  /** The on-chain evidence this call must produce, given the sender. */
  expected: (account: HexAddress) => ExpectedReceipt
  /** Read-only checks that give clearer errors than a bare revert. Must not send anything. */
  preflight?: (client: ChainWriteClient, account: HexAddress) => Promise<void>
}

async function assertReady(
  ctx: WriteContext,
  client: ChainWriteClient,
  label: string
): Promise<HexAddress> {
  const { wallet } = ctx
  const account = wallet.account
  if (!account) {
    throw new ChainWriteError(
      "NO_ACCOUNT",
      `${label}: the wallet client has no account; connect a wallet and pass its client`
    )
  }
  if (wallet.chain && wallet.chain.id !== CHAIN_ID) {
    throw new ChainWriteError(
      "WRONG_CHAIN",
      `${label}: wallet client is configured for chain ${wallet.chain.id}, expected ${CHAIN_ID}`
    )
  }
  let walletChainId: number
  let rpcChainId: number
  try {
    ;[walletChainId, rpcChainId] = await Promise.all([
      wallet.getChainId(),
      client.getChainId(),
    ])
  } catch (error) {
    throw mapWriteError(error, label, "simulate")
  }
  if (walletChainId !== CHAIN_ID) {
    throw new ChainWriteError(
      "WRONG_CHAIN",
      `${label}: the wallet is on chain ${walletChainId}; switch it to XRPL EVM Testnet (${CHAIN_ID}). The SDK never switches networks for you.`
    )
  }
  if (rpcChainId !== CHAIN_ID) {
    throw new ChainWriteError(
      "WRONG_CHAIN",
      `${label}: the RPC endpoint is on chain ${rpcChainId}, expected ${CHAIN_ID}`
    )
  }
  return account.address as HexAddress
}

/** @internal Shared with ./vault (v2 claim and LP operations); deliberately not part of the public index. */
export async function submit(
  ctx: WriteContext,
  call: Call
): Promise<SubmittedTransaction> {
  const { wallet } = ctx
  const client = ctx.publicClient ?? getPublicClient()
  const account = await assertReady(ctx, client, call.label)

  const calldata = encodeFunctionData({
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
  } as never)
  const key = `${CHAIN_ID}:${account.toLowerCase()}:${call.address.toLowerCase()}:${calldata}`
  const entry = await acquire(key, call.label, client)
  try {
    if (call.preflight) {
      try {
        await call.preflight(client, account)
      } catch (error) {
        throw mapWriteError(error, call.label, "simulate")
      }
    }

    const params = {
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
      account: wallet.account,
    }
    let request: unknown
    try {
      request = (await client.simulateContract(params as never)).request
    } catch (error) {
      throw mapWriteError(error, call.label, "simulate")
    }

    let hash: Hex
    try {
      hash = await wallet.writeContract(request as never)
    } catch (error) {
      throw mapWriteError(error, call.label, "send")
    }

    // From here the transaction exists: keep blocking identical submissions until it is mined.
    entry.hash = hash
    guardState().keyByHash.set(hash.toLowerCase(), key)
    return {
      hash,
      functionName: call.functionName,
      from: account as Address,
      chainId: CHAIN_ID,
      expected: call.expected(account),
      submittedAt: Date.now(),
      explorerUrl: explorerTxUrl(hash),
      deployment: activeDeploymentIdentity(),
    }
  } catch (error) {
    if (!entry.hash) {
      if (error instanceof ChainWriteError && error.code === "SEND_FAILED") {
        // The wallet may or may not have broadcast it: hold the lock until the ttl.
        entry.ambiguous = true
      } else {
        dropEntry(key, entry) // nothing was sent (validation, simulation, user rejection)
      }
    }
    throw error
  }
}

function invoiceAdvanceCall(
  functionName: InvoiceAdvanceWriteName,
  args: readonly unknown[],
  label: string,
  expected: Call["expected"],
  preflight?: Call["preflight"]
): Call {
  return {
    address: contractAddresses.invoiceAdvance,
    abi: invoiceAdvanceDecodeAbi(),
    functionName,
    args,
    label,
    expected,
    preflight,
  }
}

// ---- client operations -----------------------------------------------------------------------

export interface CreateInvoiceInput {
  freelancer: string
  /** Base units, > 0. */
  amount: bigint
  /** 32-byte hash of the canonical invoice terms (see CLAUDE.md hashing rule). Non-zero. */
  metadataHash: string
}

/** `createInvoice(freelancer, amount, metadataHash)`; signer becomes the invoice client. */
export async function createInvoice(
  input: CreateInvoiceInput,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  const freelancer = assertAddress(input.freelancer, "freelancer")
  const amount = assertAmount(input.amount, "amount")
  const metadataHash = assertBytes32(input.metadataHash, "metadataHash")
  if (
    freelancer.toLowerCase() ===
      contractAddresses.invoiceAdvance.toLowerCase() ||
    freelancer.toLowerCase() === contractAddresses.paymentToken.toLowerCase()
  ) {
    throw invalid("freelancer must not be the InvoiceAdvance or token contract")
  }
  if (ctx.wallet.account?.address.toLowerCase() === freelancer.toLowerCase()) {
    throw invalid("freelancer must differ from the client (the signing wallet)")
  }
  return submit(
    ctx,
    invoiceAdvanceCall(
      "createInvoice",
      [freelancer, amount, metadataHash],
      "createInvoice",
      (account) =>
        expectedFor("createInvoice", {
          client: account,
          freelancer,
          amount,
          metadataHash,
        })
    )
  )
}

/** `cancelInvoice(id)`: client only, only while Created (unfunded). */
export async function cancelInvoice(
  invoiceId: bigint | number | string,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  const id = assertId(invoiceId)
  return submit(
    ctx,
    invoiceAdvanceCall("cancelInvoice", [id], `cancelInvoice(${id})`, () =>
      expectedFor("cancelInvoice", { invoiceId: id })
    )
  )
}

/**
 * `fundInvoice(id)`: client only. Escrows the full invoice amount. Requires the client to have
 * approved at least that amount to InvoiceAdvance (see `approveEscrowAllowance`); this function
 * never approves on its own and reports INSUFFICIENT_ALLOWANCE / INSUFFICIENT_BALANCE first.
 */
export async function fundInvoice(
  invoiceId: bigint | number | string,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  const id = assertId(invoiceId)
  return submit(
    ctx,
    invoiceAdvanceCall(
      "fundInvoice",
      [id],
      `fundInvoice(${id})`,
      (account) =>
        expectedFor("fundInvoice", { invoiceId: id, client: account }),
      async (client, account) => {
        const invoice = await getInvoice(id, { client })
        if (invoice.client.toLowerCase() !== account.toLowerCase()) {
          throw new ChainWriteError(
            "UNAUTHORIZED_SIGNER",
            `fundInvoice(${id}) would revert: only the invoice client can fund it`,
            { revertName: "NotInvoiceClient" }
          )
        }
        if (invoice.status !== 0) {
          throw new ChainWriteError(
            "SIMULATION_REVERTED",
            `fundInvoice(${id}) would revert: InvalidStatus: invoice is ${invoice.statusName}`,
            { revertName: "InvalidStatus" }
          )
        }
        await assertTokenCovers(
          client,
          account,
          invoice.amount,
          `fundInvoice(${id})`
        )
      }
    )
  )
}

/** `approveCompletion(id)`: client only. Settles; repays any advance from escrow into reserve. */
export async function approveCompletion(
  invoiceId: bigint | number | string,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  const id = assertId(invoiceId)
  return submit(
    ctx,
    invoiceAdvanceCall(
      "approveCompletion",
      [id],
      `approveCompletion(${id})`,
      () => expectedFor("approveCompletion", { invoiceId: id })
    )
  )
}

/** `raiseDispute(id)`: client only, Funded or Advanced. Freezes ordinary settlement/advances. */
export async function raiseDispute(
  invoiceId: bigint | number | string,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  const id = assertId(invoiceId)
  return submit(
    ctx,
    invoiceAdvanceCall("raiseDispute", [id], `raiseDispute(${id})`, (account) =>
      expectedFor("raiseDispute", { invoiceId: id, client: account })
    )
  )
}

// ---- token approvals -------------------------------------------------------------------------

export interface ApproveTokenInput {
  spender: string
  /** Base units, > 0. Use `revokeTokenApproval` for 0. */
  amount: bigint
  /** Must be true to approve MAX_UINT256; the SDK never does this implicitly. */
  allowUnlimited?: boolean
}

function approveCall(spender: HexAddress, amount: bigint, label: string): Call {
  return {
    address: contractAddresses.paymentToken,
    abi: TOKEN_CALL_ABI,
    functionName: "approve",
    args: [spender, amount],
    label,
    expected: (account) =>
      expectedFor("approve", { owner: account, spender, value: amount }),
  }
}

/** dUSD `approve(spender, amount)` for exactly `amount`. Unlimited approvals need an explicit flag. */
export async function approveToken(
  input: ApproveTokenInput,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  const spender = assertAddress(input.spender, "spender")
  const amount = assertAmount(input.amount, "amount")
  if (amount === MAX_UINT256 && input.allowUnlimited !== true) {
    throw invalid(
      "refusing an unlimited approval; pass allowUnlimited: true to confirm it"
    )
  }
  return submit(ctx, approveCall(spender, amount, "approve"))
}

/** Approves exactly `amount` dUSD to InvoiceAdvance (needed before `fundInvoice`/`depositReserve`). */
export function approveEscrowAllowance(
  amount: bigint,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  return approveToken(
    { spender: contractAddresses.invoiceAdvance, amount },
    ctx
  )
}

/** dUSD `approve(spender, 0)`. */
export async function revokeTokenApproval(
  spender: string,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  const address = assertAddress(spender, "spender")
  return submit(ctx, approveCall(address, BigInt(0), "approve(0)"))
}

async function assertTokenCovers(
  client: ChainWriteClient,
  account: HexAddress,
  required: bigint,
  label: string
): Promise<void> {
  const [allowance, balance] = await Promise.all([
    getEscrowAllowance(account, { client }),
    getTokenBalance(account, { client }),
  ])
  if (allowance < required) {
    throw new ChainWriteError(
      "INSUFFICIENT_ALLOWANCE",
      `${label}: ${paymentTokenInfo.symbol} allowance to InvoiceAdvance is ${allowance} but ${required} is required (base units); approve it with approveEscrowAllowance first`,
      { revertName: "ERC20InsufficientAllowance" }
    )
  }
  if (balance < required) {
    throw new ChainWriteError(
      "INSUFFICIENT_BALANCE",
      `${label}: ${paymentTokenInfo.symbol} balance is ${balance} but ${required} is required (base units)`,
      { revertName: "ERC20InsufficientBalance" }
    )
  }
}

// ---- operator operations ---------------------------------------------------------------------

/**
 * `depositReserve(amount)`: OPERATOR_ROLE only. Requires the operator to have approved at least
 * `amount` to InvoiceAdvance; never approves automatically.
 */
export async function depositReserve(
  amount: bigint,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  const value = assertAmount(amount, "amount")
  return submit(
    ctx,
    invoiceAdvanceCall(
      "depositReserve",
      [value],
      "depositReserve",
      (account) =>
        expectedFor("depositReserve", { operator: account, amount: value }),
      async (client, account) => {
        await assertOperator(client, account, "depositReserve")
        await assertTokenCovers(client, account, value, "depositReserve")
      }
    )
  )
}

/** `withdrawReserve(amount)`: OPERATOR_ROLE only; cannot touch client escrow. */
export async function withdrawReserve(
  amount: bigint,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  const value = assertAmount(amount, "amount")
  return submit(
    ctx,
    invoiceAdvanceCall(
      "withdrawReserve",
      [value],
      "withdrawReserve",
      (account) =>
        expectedFor("withdrawReserve", { operator: account, amount: value })
    )
  )
}

/**
 * `resolveDispute(id, releaseToFreelancer)`: OPERATOR_ROLE only, Disputed invoices only.
 * `true` settles to the freelancer; `false` refunds the client (a prior advance stays a reserve loss).
 */
export async function resolveDispute(
  invoiceId: bigint | number | string,
  releaseToFreelancer: boolean,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  const id = assertId(invoiceId)
  if (typeof releaseToFreelancer !== "boolean") {
    throw invalid("releaseToFreelancer must be a boolean")
  }
  return submit(
    ctx,
    invoiceAdvanceCall(
      "resolveDispute",
      [id, releaseToFreelancer],
      `resolveDispute(${id}, ${releaseToFreelancer})`,
      () =>
        expectedFor("resolveDispute", {
          invoiceId: id,
          releasedToFreelancer: releaseToFreelancer,
        })
    )
  )
}

async function assertOperator(
  client: ChainWriteClient,
  account: HexAddress,
  label: string
): Promise<void> {
  if (!(await hasRole("operator", account, { client }))) {
    throw new ChainWriteError(
      "UNAUTHORIZED_SIGNER",
      `${label} would revert: ${account} does not hold OPERATOR_ROLE`,
      { revertName: "AccessControlUnauthorizedAccount" }
    )
  }
}

// ---- evaluator operation ---------------------------------------------------------------------

/**
 * `approveAdvance(id, evaluationHash)`: EVALUATOR_ROLE only (the server-side signer, A7). The
 * contract cannot verify the AI result or the freelancer's request; the caller must have done
 * that. Pays exactly floor(90%) from reserve, once.
 */
export async function approveAdvance(
  invoiceId: bigint | number | string,
  evaluationHash: string,
  ctx: WriteContext
): Promise<SubmittedTransaction> {
  const id = assertId(invoiceId)
  const hash = assertBytes32(evaluationHash, "evaluationHash")
  return submit(
    ctx,
    invoiceAdvanceCall(
      "approveAdvance",
      [id, hash],
      `approveAdvance(${id})`,
      () =>
        expectedFor("approveAdvance", { invoiceId: id, evaluationHash: hash })
    )
  )
}

// ---- preparation (read-only; never submits) ---------------------------------------------------

export interface AllowanceStatus {
  owner: HexAddress
  spender: HexAddress
  required: bigint
  current: bigint
  sufficient: boolean
  /** Extra allowance needed; 0 when sufficient. */
  shortfall: bigint
}

/** Compares a dUSD allowance to a required amount. Spender defaults to InvoiceAdvance. */
export async function getAllowanceStatus(
  owner: string,
  required: bigint,
  opts?: ReadOptions & { spender?: string }
): Promise<AllowanceStatus> {
  const ownerAddress = assertAddress(owner, "owner")
  const spender = assertAddress(
    opts?.spender ?? contractAddresses.invoiceAdvance,
    "spender"
  )
  if (typeof required !== "bigint" || required < BigInt(0)) {
    throw invalid("required must be a non-negative bigint")
  }
  const current = await getTokenAllowance(ownerAddress, spender, opts)
  const sufficient = current >= required
  return {
    owner: ownerAddress,
    spender,
    required,
    current,
    sufficient,
    shortfall: sufficient ? BigInt(0) : required - current,
  }
}

export interface FundInvoiceReadiness {
  invoice: InvoiceDetails
  allowance: AllowanceStatus
  balance: bigint
  /** True when the token supports pausing and is paused (RLUSD issuer control). */
  tokenPaused: boolean
  ready: boolean
  /** Human-readable reasons `fundInvoice` would currently fail. */
  blockers: string[]
}

/** Read-only: can `account` fund this invoice right now, and if not, why? Sends nothing. */
export async function prepareFundInvoice(
  invoiceId: bigint | number | string,
  account: string,
  opts?: ReadOptions
): Promise<FundInvoiceReadiness> {
  const id = assertId(invoiceId)
  const owner = assertAddress(account, "account")
  const invoice = await getInvoice(id, opts)
  const [allowance, balance, pause] = await Promise.all([
    getAllowanceStatus(owner, invoice.amount, opts),
    getTokenBalance(owner, opts),
    getTokenPauseStatus(opts),
  ])
  const blockers: string[] = []
  if (pause.paused) {
    blockers.push(`${paymentTokenInfo.symbol} is paused by its issuer`)
  }
  if (invoice.client.toLowerCase() !== owner.toLowerCase()) {
    blockers.push("account is not the invoice client")
  }
  if (invoice.status !== 0)
    blockers.push(`invoice status is ${invoice.statusName}, expected Created`)
  if (!allowance.sufficient) {
    blockers.push(
      `approve ${allowance.shortfall} more base units of ${paymentTokenInfo.symbol} to InvoiceAdvance`
    )
  }
  if (balance < invoice.amount)
    blockers.push(
      `${paymentTokenInfo.symbol} balance is below the invoice amount`
    )
  return {
    invoice,
    allowance,
    balance,
    tokenPaused: pause.paused,
    ready: blockers.length === 0,
    blockers,
  }
}

export interface DepositReserveReadiness {
  isOperator: boolean
  allowance: AllowanceStatus
  balance: bigint
  /** True when the token supports pausing and is paused (RLUSD issuer control). */
  tokenPaused: boolean
  ready: boolean
  blockers: string[]
}

/** Read-only: can `account` deposit `amount` into the reserve right now? Sends nothing. */
export async function prepareDepositReserve(
  amount: bigint,
  account: string,
  opts?: ReadOptions
): Promise<DepositReserveReadiness> {
  const value = assertAmount(amount, "amount")
  const owner = assertAddress(account, "account")
  const [isOperator, allowance, balance, pause] = await Promise.all([
    hasRole("operator", owner, opts),
    getAllowanceStatus(owner, value, opts),
    getTokenBalance(owner, opts),
    getTokenPauseStatus(opts),
  ])
  const blockers: string[] = []
  if (pause.paused) {
    blockers.push(`${paymentTokenInfo.symbol} is paused by its issuer`)
  }
  if (!isOperator) blockers.push("account does not hold OPERATOR_ROLE")
  if (!allowance.sufficient) {
    blockers.push(
      `approve ${allowance.shortfall} more base units of ${paymentTokenInfo.symbol} to InvoiceAdvance`
    )
  }
  if (balance < value)
    blockers.push(
      `${paymentTokenInfo.symbol} balance is below the deposit amount`
    )
  return {
    isOperator,
    allowance,
    balance,
    tokenPaused: pause.paused,
    ready: blockers.length === 0,
    blockers,
  }
}
