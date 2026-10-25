import { advanceAmountFor, formatDusd } from "../../lib/chain/amounts"
import { paymentTokenInfo } from "../../lib/chain/config"

/**
 * Pure planning logic for the live integration run: given a snapshot of on-chain state, decide
 * which transactions are needed, what must be true after each, and what blocks the run. No I/O,
 * so it is unit-tested offline.
 */

export type Signer = "client" | "evaluator" | "operator"

export type StepId =
  | "createInvoice"
  | "approveEscrow"
  | "fundInvoice"
  | "operatorApprove"
  | "depositReserve"
  | "approveAdvance"
  | "approveCompletion"

export type InvoiceStatusName =
  "Created" | "Funded" | "Advanced" | "Settled" | "Disputed" | "Cancelled"

/** Absolute on-chain values expected after a step. Unset fields are not checked. */
export interface Checkpoint {
  invoiceStatus?: InvoiceStatusName
  advanceAmount?: bigint
  reserve?: bigint
  escrow?: bigint
  clientDusd?: bigint
  freelancerDusd?: bigint
  contractDusd?: bigint
  clientAllowance?: bigint
  operatorAllowance?: bigint
}

export interface PlanStep {
  id: StepId
  label: string
  signer: Signer
  checkpoint: Checkpoint
}

export interface Snapshot {
  amount: bigint
  reserveBalance: bigint
  totalEscrow: bigint
  contractDusd: bigint
  clientDusd: bigint
  clientAllowance: bigint
  operatorDusd: bigint
  freelancerDusd: bigint
  /** Native XRP balances in wei. */
  gasBalance: Record<Signer, bigint>
  /** Wei per gas. */
  gasPrice: bigint
  /**
   * When the reserve has to be funded, deposit up to this much (never less than the advance). The
   * reserve is funded once and then reused: a settled invoice repays its advance, so later runs
   * find enough reserve and deposit nothing. Unset = deposit only the exact shortfall.
   */
  reserveTarget?: bigint
  /** True when the payment token is pausable and currently paused (nothing can move). */
  tokenPaused?: boolean
}

export interface Plan {
  amount: bigint
  advance: bigint
  /** Minimum extra reserve needed so the advance can be paid (0 if already enough). */
  reserveShortfall: bigint
  /** What the operator actually deposits: 0 if the reserve already covers the advance, else up to the target. */
  reserveDeposit: bigint
  steps: PlanStep[]
  txCountBySigner: Record<Signer, number>
  totalTransactions: number
  /** Native XRP (wei) each signer should hold for its transactions, with a safety margin. */
  gasRequired: Record<Signer, bigint>
  blockers: string[]
  /** Net effect of the whole run, as absolute values. */
  final: Checkpoint
}

/** Conservative gas per transaction (real usage is far lower) and a price-spike margin of 3/2. */
export const GAS_PER_TX = BigInt(400000)
const MARGIN_NUM = BigInt(3)
const MARGIN_DEN = BigInt(2)

export function buildPlan(s: Snapshot): Plan {
  const zero = BigInt(0)
  const advance = advanceAmountFor(s.amount)
  const shortfall =
    s.reserveBalance >= advance ? zero : advance - s.reserveBalance
  const deposit =
    shortfall === zero
      ? zero
      : (s.reserveTarget !== undefined && s.reserveTarget > advance
          ? s.reserveTarget
          : advance) - s.reserveBalance
  const reserveAfterTopUp = s.reserveBalance + deposit
  const needsClientApproval = s.clientAllowance < s.amount

  const steps: PlanStep[] = []
  steps.push({
    id: "createInvoice",
    label: `Create invoice for ${formatDusd(s.amount)} ${paymentTokenInfo.symbol}`,
    signer: "client",
    checkpoint: {
      invoiceStatus: "Created",
      reserve: s.reserveBalance,
      escrow: s.totalEscrow,
      clientDusd: s.clientDusd,
    },
  })
  if (needsClientApproval) {
    steps.push({
      id: "approveEscrow",
      label: `Approve exactly ${formatDusd(s.amount)} ${paymentTokenInfo.symbol} to InvoiceAdvance`,
      signer: "client",
      checkpoint: { clientAllowance: s.amount },
    })
  }
  steps.push({
    id: "fundInvoice",
    label: "Fund the invoice escrow",
    signer: "client",
    checkpoint: {
      invoiceStatus: "Funded",
      escrow: s.totalEscrow + s.amount,
      clientDusd: s.clientDusd - s.amount,
      reserve: s.reserveBalance,
    },
  })
  if (deposit > zero) {
    steps.push({
      id: "operatorApprove",
      label: `Operator approves ${formatDusd(deposit)} ${paymentTokenInfo.symbol} for the reserve deposit`,
      signer: "operator",
      checkpoint: { operatorAllowance: deposit },
    })
    steps.push({
      id: "depositReserve",
      label: `Operator deposits ${formatDusd(deposit)} ${paymentTokenInfo.symbol} into the reserve`,
      signer: "operator",
      checkpoint: { reserve: reserveAfterTopUp },
    })
  }
  steps.push({
    id: "approveAdvance",
    label: `Evaluator approves the 90% advance (${formatDusd(advance)} ${paymentTokenInfo.symbol})`,
    signer: "evaluator",
    checkpoint: {
      invoiceStatus: "Advanced",
      advanceAmount: advance,
      reserve: reserveAfterTopUp - advance,
      escrow: s.totalEscrow + s.amount,
      freelancerDusd: s.freelancerDusd + advance,
    },
  })
  const final: Checkpoint = {
    invoiceStatus: "Settled",
    advanceAmount: advance,
    reserve: reserveAfterTopUp,
    escrow: s.totalEscrow,
    clientDusd: s.clientDusd - s.amount,
    freelancerDusd: s.freelancerDusd + s.amount,
    contractDusd: s.contractDusd + deposit,
  }
  steps.push({
    id: "approveCompletion",
    label:
      "Client approves completion (settles; the advance is repaid into the reserve)",
    signer: "client",
    checkpoint: final,
  })

  const txCountBySigner: Record<Signer, number> = {
    client: 0,
    evaluator: 0,
    operator: 0,
  }
  for (const step of steps) txCountBySigner[step.signer] += 1
  const gasFor = (n: number) =>
    (BigInt(n) * GAS_PER_TX * s.gasPrice * MARGIN_NUM) / MARGIN_DEN
  const gasRequired: Record<Signer, bigint> = {
    client: gasFor(txCountBySigner.client),
    evaluator: gasFor(txCountBySigner.evaluator),
    operator: gasFor(txCountBySigner.operator),
  }

  const blockers: string[] = []
  if (advance === zero) {
    blockers.push("the amount is too small: the 90% advance would be zero")
  }
  if (s.clientDusd < s.amount) {
    blockers.push(
      `client holds ${formatDusd(s.clientDusd)} ${paymentTokenInfo.symbol} but needs ${formatDusd(s.amount)} ${paymentTokenInfo.symbol} to fund the invoice. This script never mints or transfers funds; ${
        paymentTokenInfo.kind === "mock"
          ? `the ${paymentTokenInfo.symbol} token owner must mint ${formatDusd(s.amount - s.clientDusd)} ${paymentTokenInfo.symbol} to the client first.`
          : `${paymentTokenInfo.symbol} is issuer-controlled and cannot be minted by us: fund the client from a wallet that already holds it, or use a smaller --amount.`
      }`
    )
  }
  if (deposit > zero && s.operatorDusd < deposit) {
    blockers.push(
      `the reserve holds ${formatDusd(s.reserveBalance)} ${paymentTokenInfo.symbol}, ${formatDusd(shortfall)} ${paymentTokenInfo.symbol} short of the advance, and the operator holds only ${formatDusd(s.operatorDusd)} ${paymentTokenInfo.symbol} to deposit ${formatDusd(deposit)} ${paymentTokenInfo.symbol} into it (this script never transfers or replenishes funds)`
    )
  }
  if (s.tokenPaused) {
    blockers.push(
      `${paymentTokenInfo.symbol} is paused by its issuer: no transfer or approval can succeed until it is unpaused`
    )
  }
  for (const signer of ["client", "evaluator", "operator"] as const) {
    if (
      txCountBySigner[signer] > 0 &&
      s.gasBalance[signer] < gasRequired[signer]
    ) {
      blockers.push(
        `${signer} needs native XRP for gas (have ${s.gasBalance[signer]} wei, want at least ${gasRequired[signer]} wei for ${txCountBySigner[signer]} transaction(s))`
      )
    }
  }

  return {
    amount: s.amount,
    advance,
    reserveShortfall: shortfall,
    reserveDeposit: deposit,
    steps,
    txCountBySigner,
    totalTransactions: steps.length,
    gasRequired,
    blockers,
    final,
  }
}
