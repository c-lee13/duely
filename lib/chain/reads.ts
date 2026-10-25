import { isAddress, keccak256, stringToHex, zeroHash, type Hex } from "viem"

import { MAX_UINT256 } from "./amounts"
import { getPublicClient, type ChainReader } from "./client"
import { contractAddresses, type HexAddress } from "./config"
import { ChainReadError, toChainReadError } from "./errors"
import { invoiceAdvanceAbi, mockUsdcAbi } from "./generated"

/**
 * Read-only SDK over InvoiceAdvance and MockUSDC. No wallet or signing is involved; on-chain
 * state is authoritative (CLAUDE.md §5). Every helper takes optional `{ client, blockNumber }`:
 * pass a client for tests or for the server RPC (see ./server), and a blockNumber to pin reads.
 * Failures surface as sanitized `ChainReadError`s (see ./errors).
 */

export interface ReadOptions {
  /** Defaults to the shared public-RPC client. */
  client?: ChainReader
  /**
   * Pin the read to a block (default: latest). An unpinned read is served by whichever node
   * answers at that moment, so several unpinned reads can reflect different blocks. To read a
   * consistent view of state right after a transaction, wait for the receipt's block with
   * `waitForBlock` and then pass that same `blockNumber` to every read.
   */
  blockNumber?: bigint
}

// ---- types -----------------------------------------------------------------------------------

/** Enum order of InvoiceAdvance.InvoiceStatus (docs/CONTRACT_SPEC.md §3). */
export const INVOICE_STATUSES = [
  "Created",
  "Funded",
  "Advanced",
  "Settled",
  "Disputed",
  "Cancelled",
] as const
export type InvoiceStatusName = (typeof INVOICE_STATUSES)[number]

export interface InvoiceDetails {
  invoiceId: bigint
  client: HexAddress
  freelancer: HexAddress
  /** Base units. */
  amount: bigint
  /** Base units; 0 until an advance is paid, then stays recorded. */
  advanceAmount: bigint
  metadataHash: Hex
  /** Zero hash until an advance is paid. */
  evaluationHash: Hex
  /** Raw enum value as returned by the contract. */
  status: number
  statusName: InvoiceStatusName
}

export interface ReserveSnapshot {
  blockNumber: bigint
  reserveBalance: bigint
  availableReserve: bigint
  totalEscrow: bigint
  /** dUSD actually held by InvoiceAdvance. */
  contractTokenBalance: bigint
  /** contractTokenBalance >= reserveBalance + totalEscrow (spec §8). Surplus is unallocated. */
  solvent: boolean
}

export interface TokenMetadata {
  name: string
  symbol: string
  decimals: number
}

/** Roles of InvoiceAdvance; ids are the contract's public constants. */
export type RoleName = "admin" | "operator" | "evaluator"

export const ROLE_IDS: Readonly<Record<RoleName, Hex>> = {
  admin: zeroHash, // DEFAULT_ADMIN_ROLE
  operator: keccak256(stringToHex("OPERATOR_ROLE")),
  evaluator: keccak256(stringToHex("EVALUATOR_ROLE")),
}

// ---- helpers ---------------------------------------------------------------------------------

function readerOf(opts?: ReadOptions): ChainReader {
  return opts?.client ?? getPublicClient()
}

async function guarded<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw toChainReadError(error, action)
  }
}

function assertAddress(value: string, what: string): HexAddress {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new ChainReadError(
      "INVALID_ADDRESS",
      `${what} is not a valid address`
    )
  }
  return value as HexAddress
}

/**
 * Validates an invoice ID (decimal string per CLAUDE.md `InvoiceId`, bigint, or safe integer).
 * IDs start at 1 and are uint256; 0, negatives, fractions, signs and exponents are rejected.
 */
export function parseInvoiceId(id: bigint | number | string): bigint {
  let parsed: bigint | undefined
  if (typeof id === "bigint") parsed = id
  else if (typeof id === "number" && Number.isSafeInteger(id))
    parsed = BigInt(id)
  else if (typeof id === "string" && /^\d+$/.test(id)) parsed = BigInt(id)

  if (parsed === undefined || parsed < BigInt(1) || parsed > MAX_UINT256) {
    throw new ChainReadError(
      "INVALID_INVOICE_ID",
      "invoice ID must be a positive integer up to uint256"
    )
  }
  return parsed
}

function statusName(status: number): InvoiceStatusName {
  const name = INVOICE_STATUSES[status]
  if (!name) {
    throw new ChainReadError(
      "UNEXPECTED_RESPONSE",
      `contract returned unknown invoice status ${status}`
    )
  }
  return name
}

// ---- invoices --------------------------------------------------------------------------------

/** `nextInvoiceId()`: the ID the next created invoice will receive (IDs start at 1). */
export async function getNextInvoiceId(opts?: ReadOptions): Promise<bigint> {
  return guarded("nextInvoiceId", () =>
    readerOf(opts).readContract({
      address: contractAddresses.invoiceAdvance,
      abi: invoiceAdvanceAbi,
      functionName: "nextInvoiceId",
      blockNumber: opts?.blockNumber,
    })
  )
}

/**
 * `getInvoice(id)`. Throws ChainReadError: INVALID_INVOICE_ID for malformed IDs,
 * INVOICE_NOT_FOUND when the contract reverts InvoiceNotFound, RPC_ERROR for provider failures.
 */
export async function getInvoice(
  invoiceId: bigint | number | string,
  opts?: ReadOptions
): Promise<InvoiceDetails> {
  const id = parseInvoiceId(invoiceId)
  const invoice = await guarded(`getInvoice(${id})`, () =>
    readerOf(opts).readContract({
      address: contractAddresses.invoiceAdvance,
      abi: invoiceAdvanceAbi,
      functionName: "getInvoice",
      args: [id],
      blockNumber: opts?.blockNumber,
    })
  )
  return {
    invoiceId: id,
    client: invoice.client,
    freelancer: invoice.freelancer,
    amount: invoice.amount,
    advanceAmount: invoice.advanceAmount,
    metadataHash: invoice.metadataHash,
    evaluationHash: invoice.evaluationHash,
    status: invoice.status,
    statusName: statusName(invoice.status),
  }
}

/** Like getInvoice but returns null when the invoice does not exist. Other errors still throw. */
export async function findInvoice(
  invoiceId: bigint | number | string,
  opts?: ReadOptions
): Promise<InvoiceDetails | null> {
  try {
    return await getInvoice(invoiceId, opts)
  } catch (error) {
    if (error instanceof ChainReadError && error.code === "INVOICE_NOT_FOUND") {
      return null
    }
    throw error
  }
}

// ---- reserve and escrow ----------------------------------------------------------------------

/** `reserveBalance()`: operator-owned reserve liquidity, base units. */
export async function getReserveBalance(opts?: ReadOptions): Promise<bigint> {
  return guarded("reserveBalance", () =>
    readerOf(opts).readContract({
      address: contractAddresses.invoiceAdvance,
      abi: invoiceAdvanceAbi,
      functionName: "reserveBalance",
      blockNumber: opts?.blockNumber,
    })
  )
}

/** `availableReserve()`: same quantity as reserveBalance per the spec; exposed separately. */
export async function getAvailableReserve(opts?: ReadOptions): Promise<bigint> {
  return guarded("availableReserve", () =>
    readerOf(opts).readContract({
      address: contractAddresses.invoiceAdvance,
      abi: invoiceAdvanceAbi,
      functionName: "availableReserve",
      blockNumber: opts?.blockNumber,
    })
  )
}

/** `totalEscrow()`: client escrow liabilities of funded, unsettled invoices, base units. */
export async function getTotalEscrow(opts?: ReadOptions): Promise<bigint> {
  return guarded("totalEscrow", () =>
    readerOf(opts).readContract({
      address: contractAddresses.invoiceAdvance,
      abi: invoiceAdvanceAbi,
      functionName: "totalEscrow",
      blockNumber: opts?.blockNumber,
    })
  )
}

/** Reserve, escrow and held tokens, all read at one block so the solvency check is consistent. */
export async function getReserveSnapshot(
  opts?: ReadOptions
): Promise<ReserveSnapshot> {
  const client = readerOf(opts)
  // cacheTime: 0 matters: viem caches getBlockNumber per client for a polling interval (4 s), and
  // pinning a snapshot to a cached head can silently pick a block that is already one or more
  // blocks old (for example the head seen by the previous step's check).
  const blockNumber =
    opts?.blockNumber ??
    (await guarded("getBlockNumber", () =>
      client.getBlockNumber({ cacheTime: 0 })
    ))
  const pinned: ReadOptions = { client, blockNumber }
  const [reserveBalance, availableReserve, totalEscrow, contractTokenBalance] =
    await Promise.all([
      getReserveBalance(pinned),
      getAvailableReserve(pinned),
      getTotalEscrow(pinned),
      getTokenBalance(contractAddresses.invoiceAdvance, pinned),
    ])
  return {
    blockNumber,
    reserveBalance,
    availableReserve,
    totalEscrow,
    contractTokenBalance,
    solvent: contractTokenBalance >= reserveBalance + totalEscrow,
  }
}

/** `paymentToken()` as configured in the deployed InvoiceAdvance. */
export async function getPaymentTokenAddress(
  opts?: ReadOptions
): Promise<HexAddress> {
  return guarded("paymentToken", () =>
    readerOf(opts).readContract({
      address: contractAddresses.invoiceAdvance,
      abi: invoiceAdvanceAbi,
      functionName: "paymentToken",
      blockNumber: opts?.blockNumber,
    })
  )
}

// ---- token -----------------------------------------------------------------------------------

/** MockUSDC `name()`, `symbol()`, `decimals()`. */
export async function getTokenMetadata(
  opts?: ReadOptions
): Promise<TokenMetadata> {
  const client = readerOf(opts)
  const base = {
    address: contractAddresses.paymentToken,
    abi: mockUsdcAbi,
    blockNumber: opts?.blockNumber,
  } as const
  const [name, symbol, decimals] = await guarded("token metadata", () =>
    Promise.all([
      client.readContract({ ...base, functionName: "name" }),
      client.readContract({ ...base, functionName: "symbol" }),
      client.readContract({ ...base, functionName: "decimals" }),
    ])
  )
  return { name, symbol, decimals }
}

/** MockUSDC `balanceOf(account)`, base units. */
export async function getTokenBalance(
  account: string,
  opts?: ReadOptions
): Promise<bigint> {
  const address = assertAddress(account, "account")
  return guarded("balanceOf", () =>
    readerOf(opts).readContract({
      address: contractAddresses.paymentToken,
      abi: mockUsdcAbi,
      functionName: "balanceOf",
      args: [address],
      blockNumber: opts?.blockNumber,
    })
  )
}

/** MockUSDC `allowance(owner, spender)`, base units. */
export async function getTokenAllowance(
  owner: string,
  spender: string,
  opts?: ReadOptions
): Promise<bigint> {
  const ownerAddress = assertAddress(owner, "owner")
  const spenderAddress = assertAddress(spender, "spender")
  return guarded("allowance", () =>
    readerOf(opts).readContract({
      address: contractAddresses.paymentToken,
      abi: mockUsdcAbi,
      functionName: "allowance",
      args: [ownerAddress, spenderAddress],
      blockNumber: opts?.blockNumber,
    })
  )
}

/** Allowance a client has granted to InvoiceAdvance (needed before `fundInvoice`). */
export async function getEscrowAllowance(
  owner: string,
  opts?: ReadOptions
): Promise<bigint> {
  return getTokenAllowance(owner, contractAddresses.invoiceAdvance, opts)
}

// ---- block synchronisation -------------------------------------------------------------------

export interface WaitForBlockOptions {
  client?: ChainReader
  /** Give up after this long (default 60 s). */
  timeoutMs?: number
  /** Delay between polls (default 1 s). */
  pollMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable clock for tests. */
  now?: () => number
}

/**
 * Resolves with the chain head once the RPC reports a block >= `minBlock`. Use it before reading
 * state that must include a transaction you already hold a receipt for: a load-balanced or lagging
 * RPC can answer with an older head than the one that produced the receipt. The head is always
 * fetched fresh (never from viem's client cache). Provider errors while polling are treated as
 * transient. On timeout it throws RPC_BEHIND (or the last provider error), never a stale answer.
 */
export async function waitForBlock(
  minBlock: bigint,
  opts?: WaitForBlockOptions
): Promise<bigint> {
  if (typeof minBlock !== "bigint" || minBlock < BigInt(0)) {
    throw new ChainReadError(
      "UNEXPECTED_RESPONSE",
      "minBlock must be a non-negative bigint"
    )
  }
  const client = readerOf(opts)
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const pollMs = opts?.pollMs ?? 1_000
  const sleep =
    opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const now = opts?.now ?? (() => Date.now())
  const deadline = now() + timeoutMs

  let lastHead: bigint | undefined
  let lastError: ChainReadError | undefined
  for (;;) {
    try {
      lastHead = await client.getBlockNumber({ cacheTime: 0 })
      lastError = undefined
      if (lastHead >= minBlock) return lastHead
    } catch (error) {
      lastError = toChainReadError(error, "getBlockNumber")
    }
    if (now() >= deadline) break
    await sleep(pollMs)
  }
  if (lastError && lastHead === undefined) throw lastError
  throw new ChainReadError(
    "RPC_BEHIND",
    `the RPC did not reach block ${minBlock} within ${timeoutMs} ms (last head ${lastHead ?? "unknown"}${lastError ? `; last error: ${lastError.message}` : ""})`
  )
}

// ---- roles -----------------------------------------------------------------------------------

/** `hasRole(role, account)` for admin / operator / evaluator. */
export async function hasRole(
  role: RoleName,
  account: string,
  opts?: ReadOptions
): Promise<boolean> {
  const roleId = ROLE_IDS[role]
  if (!roleId) {
    throw new ChainReadError("UNEXPECTED_RESPONSE", `unknown role "${role}"`)
  }
  const address = assertAddress(account, "account")
  return guarded(`hasRole(${role})`, () =>
    readerOf(opts).readContract({
      address: contractAddresses.invoiceAdvance,
      abi: invoiceAdvanceAbi,
      functionName: "hasRole",
      args: [roleId, address],
      blockNumber: opts?.blockNumber,
    })
  )
}

/** Role ids as reported by the contract getters; use to confirm ROLE_IDS against the deployment. */
export async function getOnchainRoleIds(
  opts?: ReadOptions
): Promise<Record<RoleName, Hex>> {
  const client = readerOf(opts)
  const base = {
    address: contractAddresses.invoiceAdvance,
    abi: invoiceAdvanceAbi,
    blockNumber: opts?.blockNumber,
  } as const
  const [admin, operator, evaluator] = await guarded("role ids", () =>
    Promise.all([
      client.readContract({ ...base, functionName: "DEFAULT_ADMIN_ROLE" }),
      client.readContract({ ...base, functionName: "OPERATOR_ROLE" }),
      client.readContract({ ...base, functionName: "EVALUATOR_ROLE" }),
    ])
  )
  return { admin, operator, evaluator }
}
