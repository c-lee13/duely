import type { Hex } from "viem"
import { isAddress, parseEventLogs } from "viem"

import { MAX_UINT256 } from "./amounts"
import { getPublicClient, type ChainReader } from "./client"
import { contractAddresses, paymentTokenInfo, type HexAddress } from "./config"
import { ChainReadError, ChainWriteError, toChainReadError } from "./errors"
import { expectedFor } from "./expected"
import { invoiceAdvanceV2Abi } from "./generated/invoiceAdvanceV2Abi"
import { duelyVaultAbi } from "./generated/duelyVaultAbi"
import { vaultAddress } from "./protocol"
import { getTokenAllowance, getTokenBalance, getTokenPauseStatus, parseInvoiceId, type ReadOptions } from "./reads"
import { submit, type Call, type SubmittedTransaction, type WriteContext } from "./writes"
import { getActiveDeployment } from "./deployments"

/**
 * DuelyVault (ERC-4626 LP vault) and InvoiceAdvanceV2 pull-payment reads and writes. Only meaningful under the v2
 * deployment; every function throws a clear error under v1. Browser-safe: holds no keys.
 *
 * Accounting vocabulary (all token amounts are base units, bigint):
 *   NAV                 totalAssets = vault cash + outstandingPrincipal
 *   cash                RLUSD actually held by the vault
 *   withdrawable        what LPs can pull out right now (keeps utilization <= 80% of NAV)
 *   maxAdvanceNow       the largest advance the vault could fund this block (90%/80%/25% limits all applied)
 *   claimable           proceeds credited to an address inside InvoiceAdvanceV2; NOT a wallet balance until claimed
 */

const ZERO = BigInt(0)

function reader(opts?: ReadOptions): ChainReader {
  return opts?.client ?? getPublicClient()
}

async function guarded<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw toChainReadError(error, action)
  }
}

function addr(value: string, what: string): HexAddress {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new ChainReadError("INVALID_ADDRESS", `${what} is not a valid address`)
  }
  return value as HexAddress
}

function invalid(message: string): ChainWriteError {
  return new ChainWriteError("INVALID_INPUT", message)
}

function assertPositive(value: unknown, what: string): bigint {
  if (typeof value !== "bigint") throw invalid(`${what} must be a bigint (base units)`)
  if (value <= ZERO) throw invalid(`${what} must be greater than zero`)
  if (value > MAX_UINT256) throw invalid(`${what} exceeds uint256`)
  return value
}

// ---- vault reads -----------------------------------------------------------------------------

export interface VaultSnapshot {
  blockNumber: bigint
  /** NAV: cash + outstanding principal. */
  totalAssets: bigint
  totalShares: bigint
  cash: bigint
  outstandingPrincipal: bigint
  /** Cash LPs can withdraw right now. */
  withdrawableLiquidity: bigint
  /** Largest advance the vault could fund right now. */
  maxAdvanceNow: bigint
  utilizationBps: bigint
  totalFeesEarned: bigint
  totalRealizedLosses: bigint
  /** Asset base units for ONE whole share (10^shareDecimals share units). */
  sharePriceAssets: bigint
  shareDecimals: number
  shareSymbol: string
  paused: boolean
  advancesPaused: boolean
  /** Parameters (basis points). */
  feeBps: bigint
  maxAdvanceBps: bigint
  maxUtilizationBps: bigint
  maxInvoiceExposureBps: bigint
}

/** Every vault figure read at ONE block, so the numbers are mutually consistent. */
export async function getVaultSnapshot(opts?: ReadOptions): Promise<VaultSnapshot> {
  const client = reader(opts)
  const vault = vaultAddress()
  const blockNumber =
    opts?.blockNumber ?? (await guarded("getBlockNumber", () => client.getBlockNumber({ cacheTime: 0 })))
  const base = { address: vault, abi: duelyVaultAbi, blockNumber } as const
  const info = getActiveDeployment().vault!
  const one = BigInt(10) ** BigInt(info.shareDecimals)
  const read = <N extends string>(functionName: N, args?: readonly unknown[]) =>
    client.readContract({ ...base, functionName, args } as never) as Promise<never>
  const [
    totalAssets, totalShares, outstandingPrincipal, withdrawableLiquidity, maxAdvanceNow, utilizationBps,
    totalFeesEarned, totalRealizedLosses, sharePriceAssets, paused, advancesPaused,
    feeBps, maxAdvanceBps, maxUtilizationBps, maxInvoiceExposureBps, cash,
  ] = (await guarded("vault snapshot", () =>
    Promise.all([
      read("totalAssets"), read("totalSupply"), read("outstandingPrincipal"), read("withdrawableLiquidity"),
      read("maxAdvanceNow"), read("utilizationBps"), read("totalFeesEarned"), read("totalRealizedLosses"),
      read("convertToAssets", [one]), read("paused"), read("advancesPaused"),
      read("FEE_BPS"), read("MAX_ADVANCE_BPS"), read("MAX_UTILIZATION_BPS"), read("MAX_INVOICE_EXPOSURE_BPS"),
      getTokenBalance(vault, { client, blockNumber }),
    ])
  )) as unknown as [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean,
    bigint, bigint, bigint, bigint, bigint,
  ]
  return {
    blockNumber, totalAssets, totalShares, cash, outstandingPrincipal, withdrawableLiquidity, maxAdvanceNow,
    utilizationBps, totalFeesEarned, totalRealizedLosses, sharePriceAssets,
    shareDecimals: info.shareDecimals, shareSymbol: info.shareSymbol, paused, advancesPaused,
    feeBps, maxAdvanceBps, maxUtilizationBps, maxInvoiceExposureBps,
  }
}

export interface LpPosition {
  blockNumber: bigint
  account: HexAddress
  shares: bigint
  /** Redemption value of all shares at the current share price. */
  assetValue: bigint
  /** Most this account can withdraw right now (limited by vault liquidity). */
  maxWithdraw: bigint
  maxRedeem: bigint
  /** The account's wallet balance of the payment token (NOT its claimable proceeds). */
  walletBalance: bigint
  /** Allowance the account has granted to the vault. */
  vaultAllowance: bigint
}

export async function getLpPosition(account: string, opts?: ReadOptions): Promise<LpPosition> {
  const owner = addr(account, "account")
  const client = reader(opts)
  const vault = vaultAddress()
  const blockNumber =
    opts?.blockNumber ?? (await guarded("getBlockNumber", () => client.getBlockNumber({ cacheTime: 0 })))
  const base = { address: vault, abi: duelyVaultAbi, blockNumber } as const
  const pinned = { client, blockNumber }
  const [shares, maxWithdraw, maxRedeem, walletBalance, vaultAllowance] = await guarded("LP position", () =>
    Promise.all([
      client.readContract({ ...base, functionName: "balanceOf", args: [owner] }),
      client.readContract({ ...base, functionName: "maxWithdraw", args: [owner] }),
      client.readContract({ ...base, functionName: "maxRedeem", args: [owner] }),
      getTokenBalance(owner, pinned),
      getTokenAllowance(owner, vault, pinned),
    ])
  )
  const assetValue = shares === ZERO ? ZERO : await guarded("convertToAssets", () =>
    client.readContract({ ...base, functionName: "convertToAssets", args: [shares] })
  )
  return { blockNumber, account: owner, shares, assetValue, maxWithdraw, maxRedeem, walletBalance, vaultAllowance }
}

/** Shares minted for `assets` and redemption value of `shares`, from the vault's own preview functions. */
export async function previewDeposit(assets: bigint, opts?: ReadOptions): Promise<bigint> {
  return guarded("previewDeposit", () =>
    reader(opts).readContract({ address: vaultAddress(), abi: duelyVaultAbi, functionName: "previewDeposit", args: [assets], blockNumber: opts?.blockNumber })
  )
}

export interface VaultAdvanceRecord {
  freelancer: HexAddress
  invoiceAmount: bigint
  principal: bigint
  fee: bigint
  principalRepaid: bigint
  feeEarned: bigint
  loss: bigint
  /** Raw enum: 0 None, 1 Open, 2 Repaid, 3 Lost (see DuelyVault). */
  status: number
}

export async function getVaultAdvance(invoiceId: bigint | number | string, opts?: ReadOptions): Promise<VaultAdvanceRecord> {
  const id = parseInvoiceId(invoiceId)
  const r = await guarded(`getAdvance(${id})`, () =>
    reader(opts).readContract({ address: vaultAddress(), abi: duelyVaultAbi, functionName: "getAdvance", args: [id], blockNumber: opts?.blockNumber })
  )
  return { ...r }
}

// ---- escrow pull-payment reads ---------------------------------------------------------------

/** Proceeds credited to `account` inside InvoiceAdvanceV2 and not yet claimed. Not part of any wallet balance. */
export async function getClaimable(account: string, opts?: ReadOptions): Promise<bigint> {
  const owner = addr(account, "account")
  return guarded("claimable", () =>
    reader(opts).readContract({ address: contractAddresses.invoiceAdvance, abi: invoiceAdvanceV2Abi, functionName: "claimable", args: [owner], blockNumber: opts?.blockNumber })
  )
}

export interface EscrowTotals {
  totalEscrow: bigint
  totalClaimable: bigint
}

export async function getEscrowTotals(opts?: ReadOptions): Promise<EscrowTotals> {
  const base = { address: contractAddresses.invoiceAdvance, abi: invoiceAdvanceV2Abi, blockNumber: opts?.blockNumber } as const
  const client = reader(opts)
  const [totalEscrow, totalClaimable] = await guarded("escrow totals", () =>
    Promise.all([client.readContract({ ...base, functionName: "totalEscrow" }), client.readContract({ ...base, functionName: "totalClaimable" })])
  )
  return { totalEscrow, totalClaimable }
}

export interface AdvanceQuote {
  advance: bigint
  fee: bigint
  /** What the vault gets back at settlement: advance + fee. */
  vaultRepayment: bigint
  /** What the freelancer can claim after settlement: amount - advance - fee. */
  freelancerRemainder: bigint
}

/** The contract's own pure quote for a client slider (default 10000 = 90% advance; fixed 1000 bps fee). Never recompute this client-side. */
export async function quoteAdvance(amount: bigint, advanceShareBps: bigint = BigInt(10000), opts?: ReadOptions): Promise<AdvanceQuote> {
  const [advance, fee, vaultRepayment, freelancerRemainder] = await guarded("quoteAdvance", () =>
    reader(opts).readContract({ address: contractAddresses.invoiceAdvance, abi: invoiceAdvanceV2Abi, functionName: "quoteAdvance", args: [amount, advanceShareBps], blockNumber: opts?.blockNumber })
  )
  return { advance, fee, vaultRepayment, freelancerRemainder }
}

// ---- writes ----------------------------------------------------------------------------------

function vaultCall(functionName: "deposit" | "withdraw" | "redeem", args: readonly unknown[], label: string, expected: Call["expected"], preflight?: Call["preflight"]): Call {
  return { address: vaultAddress(), abi: duelyVaultAbi as never, functionName, args, label, expected, preflight }
}

async function assertVaultOpen(client: ChainReader, label: string): Promise<void> {
  const paused = await client.readContract({ address: vaultAddress(), abi: duelyVaultAbi, functionName: "paused" })
  if (paused) {
    throw new ChainWriteError("SIMULATION_REVERTED", `${label} would revert: EnforcedPause: the vault is paused`, { revertName: "EnforcedPause" })
  }
}

/** Approves exactly `amount` of the payment token to DuelyVault (needed before `depositToVault`). */
export async function approveVaultAllowance(amount: bigint, ctx: WriteContext): Promise<SubmittedTransaction> {
  const value = assertPositive(amount, "amount")
  const spender = vaultAddress()
  return submit(ctx, {
    address: contractAddresses.paymentToken,
    abi: [
      { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
    ] as never,
    functionName: "approve",
    args: [spender, value],
    label: "approve(vault)",
    expected: (account) => expectedFor("approve", { owner: account, spender, value }),
  })
}

/** `deposit(assets, receiver = signer)`. Requires a prior exact allowance to the vault; never approves on its own. */
export async function depositToVault(assets: bigint, ctx: WriteContext): Promise<SubmittedTransaction> {
  const value = assertPositive(assets, "assets")
  return submit(
    ctx,
    vaultCall("deposit", [value, ctx.wallet.account?.address], "deposit", (account) =>
      expectedFor("vaultDeposit", { sender: account, owner: account, assets: value }),
      async (client, account) => {
        await assertVaultOpen(client, "deposit")
        const pause = await getTokenPauseStatus({ client })
        if (pause.paused) {
          throw new ChainWriteError("TOKEN_PAUSED", `deposit would revert: ${paymentTokenInfo.symbol} is paused by its issuer`, { revertName: "EnforcedPause" })
        }
        const [allowance, balance] = await Promise.all([
          getTokenAllowance(account, vaultAddress(), { client }),
          getTokenBalance(account, { client }),
        ])
        if (allowance < value) {
          throw new ChainWriteError("INSUFFICIENT_ALLOWANCE", `deposit: ${paymentTokenInfo.symbol} allowance to the vault is ${allowance} but ${value} is required (base units); approve it first`, { revertName: "ERC20InsufficientAllowance" })
        }
        if (balance < value) {
          throw new ChainWriteError("INSUFFICIENT_BALANCE", `deposit: ${paymentTokenInfo.symbol} balance is ${balance} but ${value} is required (base units)`, { revertName: "ERC20InsufficientBalance" })
        }
      }
    )
  )
}

async function assertWithdrawable(client: ChainReader, owner: HexAddress, fn: "maxWithdraw" | "maxRedeem", requested: bigint, label: string): Promise<void> {
  await assertVaultOpen(client, label)
  const max = await client.readContract({ address: vaultAddress(), abi: duelyVaultAbi, functionName: fn, args: [owner] })
  if (requested > max) {
    throw new ChainWriteError(
      "SIMULATION_REVERTED",
      `${label} would revert: ${fn === "maxWithdraw" ? "ERC4626ExceededMaxWithdraw" : "ERC4626ExceededMaxRedeem"}: requested ${requested} but at most ${max} can be taken out right now (base units). Funds out on advances, and the 80% utilization limit, restrict withdrawals until invoices settle.`,
      { revertName: fn === "maxWithdraw" ? "ERC4626ExceededMaxWithdraw" : "ERC4626ExceededMaxRedeem" }
    )
  }
}

/** `withdraw(assets, receiver = signer, owner = signer)`: take out a fixed RLUSD amount, subject to vault liquidity. */
export async function withdrawFromVault(assets: bigint, ctx: WriteContext): Promise<SubmittedTransaction> {
  const value = assertPositive(assets, "assets")
  const self = ctx.wallet.account?.address
  return submit(
    ctx,
    vaultCall("withdraw", [value, self, self], "withdraw", (account) =>
      expectedFor("vaultWithdraw", { sender: account, receiver: account, owner: account, assets: value }),
      (client, account) => assertWithdrawable(client, account, "maxWithdraw", value, "withdraw")
    )
  )
}

/** `redeem(shares, receiver = signer, owner = signer)`: burn shares for their current RLUSD value, subject to liquidity. */
export async function redeemFromVault(shares: bigint, ctx: WriteContext): Promise<SubmittedTransaction> {
  const value = assertPositive(shares, "shares")
  const self = ctx.wallet.account?.address
  return submit(
    ctx,
    vaultCall("redeem", [value, self, self], "redeem", (account) =>
      expectedFor("vaultRedeem", { sender: account, receiver: account, owner: account, shares: value }),
      (client, account) => assertWithdrawable(client, account, "maxRedeem", value, "redeem")
    )
  )
}

/**
 * `claim(recipient)` on InvoiceAdvanceV2: moves credited proceeds to `recipient` (permissionless to call, always
 * pays the recipient). The signer is the caller; pass the signer's own address to claim for yourself.
 */
export async function claimProceeds(recipient: string, ctx: WriteContext): Promise<SubmittedTransaction> {
  const to = addr(recipient, "recipient")
  return submit(ctx, {
    address: contractAddresses.invoiceAdvance,
    abi: invoiceAdvanceV2Abi as never,
    functionName: "claim",
    args: [to],
    label: "claim",
    expected: (account) => expectedFor("claim", { recipient: to, caller: account }),
    preflight: async (client) => {
      const owed = await getClaimable(to, { client })
      if (owed === ZERO) {
        throw new ChainWriteError("SIMULATION_REVERTED", "claim would revert: NothingToClaim: no proceeds are credited to this address", { revertName: "NothingToClaim" })
      }
    },
  })
}

// ---- event decoding (idempotent) --------------------------------------------------------------

export type V2ActivityEvent =
  | { kind: "AdvancePaid"; invoiceId: bigint; freelancer: HexAddress; amount: bigint; fee: bigint }
  | { kind: "InvoiceSettled"; invoiceId: bigint; vaultPrincipalRepaid: bigint; vaultFeePaid: bigint; freelancerCredited: bigint }
  | { kind: "DisputeResolved"; invoiceId: bigint; releasedToFreelancer: boolean; vaultLoss: bigint }
  | { kind: "ProceedsCredited"; invoiceId: bigint; recipient: HexAddress; amount: bigint }
  | { kind: "ProceedsClaimed"; recipient: HexAddress; caller: HexAddress; amount: bigint }

export interface DecodedV2Event {
  /** Unique per log: replaying the same receipt/log range yields the same keys, so callers can de-duplicate by it. */
  key: string
  txHash: Hex
  logIndex: number
  blockNumber: bigint
  event: V2ActivityEvent
}

/**
 * Decodes the V2 escrow's financial events from logs. Pure and idempotent: the same logs always give the same
 * `key`s (`txHash:logIndex`), so processing a receipt twice (page reload, retry, reorg re-scan) can be de-duplicated
 * by the caller instead of crediting an outcome twice.
 */
export function decodeV2Events(
  logs: readonly { address: string; data: Hex; topics: readonly Hex[]; transactionHash: Hex | null; logIndex: number | null; blockNumber: bigint | null }[]
): DecodedV2Event[] {
  const escrow = contractAddresses.invoiceAdvance.toLowerCase()
  const own = logs.filter((l) => l.address.toLowerCase() === escrow && l.transactionHash !== null && l.logIndex !== null)
  const parsed = parseEventLogs({ abi: invoiceAdvanceV2Abi, logs: own as never })
  const out: DecodedV2Event[] = []
  for (const log of parsed as unknown as { eventName: string; args: Record<string, never>; transactionHash: Hex; logIndex: number; blockNumber: bigint }[]) {
    const a = log.args as Record<string, never>
    let event: V2ActivityEvent | null = null
    switch (log.eventName) {
      case "AdvancePaid": event = { kind: "AdvancePaid", invoiceId: a.invoiceId, freelancer: a.freelancer, amount: a.amount, fee: a.fee }; break
      case "InvoiceSettled": event = { kind: "InvoiceSettled", invoiceId: a.invoiceId, vaultPrincipalRepaid: a.vaultPrincipalRepaid, vaultFeePaid: a.vaultFeePaid, freelancerCredited: a.freelancerCredited }; break
      case "DisputeResolved": event = { kind: "DisputeResolved", invoiceId: a.invoiceId, releasedToFreelancer: a.releasedToFreelancer as boolean, vaultLoss: a.vaultLoss }; break
      case "ProceedsCredited": event = { kind: "ProceedsCredited", invoiceId: a.invoiceId, recipient: a.recipient, amount: a.amount }; break
      case "ProceedsClaimed": event = { kind: "ProceedsClaimed", recipient: a.recipient, caller: a.caller, amount: a.amount }; break
    }
    if (event) out.push({ key: `${log.transactionHash}:${log.logIndex}`, txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber, event })
  }
  return out
}
