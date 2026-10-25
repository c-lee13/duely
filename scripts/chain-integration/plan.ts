import { advanceAmountFor, formatDusd } from "../../lib/chain/amounts"

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
}

export interface Plan {
  amount: bigint
  advance: bigint
  /** Extra reserve the operator must deposit so the advance can be paid (0 if already enough). */
  reserveShortfall: bigint
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
  const reserveAfterTopUp = s.reserveBalance + shortfall
  const needsClientApproval = s.clientAllowance < s.amount

  const steps: PlanStep[] = []
  steps.push({
    id: "createInvoice",
    label: `Create invoice for ${formatDusd(s.amount)} dUSD`,
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
      label: `Approve exactly ${formatDusd(s.amount)} dUSD to InvoiceAdvance`,
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
  if (shortfall > zero) {
    steps.push({
      id: "operatorApprove",
      label: `Operator approves ${formatDusd(shortfall)} dUSD for the reserve top-up`,
      signer: "operator",
      checkpoint: { operatorAllowance: shortfall },
    })
    steps.push({
      id: "depositReserve",
      label: `Operator deposits ${formatDusd(shortfall)} dUSD into the reserve`,
      signer: "operator",
      checkpoint: { reserve: reserveAfterTopUp },
    })
  }
  steps.push({
    id: "approveAdvance",
    label: `Evaluator approves the 90% advance (${formatDusd(advance)} dUSD)`,
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
    contractDusd: s.contractDusd + shortfall,
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
      `client holds ${formatDusd(s.clientDusd)} dUSD but needs ${formatDusd(s.amount)} dUSD to fund the invoice. This script never mints or transfers funds; the dUSD token owner must mint ${formatDusd(s.amount - s.clientDusd)} dUSD to the client first.`
    )
  }
  if (shortfall > zero && s.operatorDusd < shortfall) {
    blockers.push(
      `the reserve holds ${formatDusd(s.reserveBalance)} dUSD, ${formatDusd(shortfall)} dUSD short of the advance, and the operator holds only ${formatDusd(s.operatorDusd)} dUSD to top it up`
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
    steps,
    txCountBySigner,
    totalTransactions: steps.length,
    gasRequired,
    blockers,
    final,
  }
}
