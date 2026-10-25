import type {
  AdvanceRequest,
  EvaluationRecord,
  InvoiceDetail,
  OnchainInvoiceStatus,
  Submission,
  SubmissionStatus,
  TokenAmount,
} from "./domain"
import { advanceFor, formatToken, gte, isZero, sub } from "./token"

/**
 * UI-side previews of eligibility. The server and contract stay authoritative;
 * the mock repository runs the same checks so mock mode rejects what the
 * backend would reject.
 */

export const PASS_SCORE_THRESHOLD = 80
export const PASS_RULE_TEXT = `Score ≥ ${PASS_SCORE_THRESHOLD} and every mandatory criterion passes (proposed demo policy, pending team confirmation)`

export type AdvanceBlockerCode =
  | "NOT_FUNDED"
  | "ALREADY_ADVANCED"
  | "DISPUTED"
  | "SETTLED"
  | "NO_SUBMISSION"
  | "NOT_EVALUATED"
  | "EVALUATION_FAILED"
  | "STALE_EVALUATION"
  | "INSUFFICIENT_RESERVE"
  | "REQUEST_PENDING"
  | "CHAIN_UNVERIFIED"

export interface AdvanceBlocker {
  code: AdvanceBlockerCode
  message: string
}

export interface AdvanceEligibility {
  eligible: boolean
  amount: TokenAmount
  blockers: AdvanceBlocker[]
}

export function latestOf<T extends { createdAt?: string; evaluatedAt?: string }>(
  items: T[]
): T | undefined {
  return items[0]
}

export function evaluationFor(
  submission: Submission | undefined,
  evaluations: EvaluationRecord[]
): EvaluationRecord | undefined {
  if (!submission) return undefined
  return evaluations.find((e) => e.submissionId === submission.submissionId)
}

export function getAdvanceEligibility(args: {
  invoice: InvoiceDetail
  submissions: Submission[]
  evaluations: EvaluationRecord[]
  advanceRequests: AdvanceRequest[]
  reserveAvailable: TokenAmount
}): AdvanceEligibility {
  const { invoice, submissions, evaluations, advanceRequests, reserveAvailable } = args
  const amount = advanceFor(invoice.amount)
  const blockers: AdvanceBlocker[] = []
  const status = invoice.onchainStatus

  if (status === "Created") {
    blockers.push({ code: "NOT_FUNDED", message: "The client hasn't funded escrow yet." })
  }
  if (status === "Advanced" || !isZero(invoice.advanceAmount)) {
    blockers.push({
      code: "ALREADY_ADVANCED",
      message: "An advance was already paid for this invoice. Only one advance is allowed.",
    })
  }
  if (status === "Disputed") {
    blockers.push({
      code: "DISPUTED",
      message: "The client opened a dispute, so advances and settlement are frozen.",
    })
  }
  if (status === "Settled") {
    blockers.push({ code: "SETTLED", message: "This invoice is already settled." })
  }

  if (advanceRequests.some((r) => r.status === "pending")) {
    blockers.push({ code: "REQUEST_PENDING", message: "An advance request is already being processed." })
  }

  const latestSubmission = submissions[0]
  const latestEvaluation = evaluationFor(latestSubmission, evaluations)

  if (!latestSubmission) {
    blockers.push({ code: "NO_SUBMISSION", message: "Submit evidence of the completed work first." })
  } else if (!latestEvaluation || latestEvaluation.state !== "completed") {
    const olderPass = evaluations.some((e) => e.passed && e.submissionId !== latestSubmission.submissionId)
    blockers.push(
      olderPass
        ? {
            code: "STALE_EVALUATION",
            message:
              "Your latest submission hasn't been evaluated. A passing result on an older submission can't authorize an advance.",
          }
        : { code: "NOT_EVALUATED", message: "Your latest submission hasn't been evaluated yet." }
    )
  } else if (!latestEvaluation.passed) {
    blockers.push({
      code: "EVALUATION_FAILED",
      message: "The latest evaluation didn't pass. Submit improved evidence to be re-evaluated.",
    })
  }

  if (!gte(reserveAvailable, amount)) {
    blockers.push({
      code: "INSUFFICIENT_RESERVE",
      message: `The platform reserve has ${formatToken(reserveAvailable)} available, but this advance needs ${formatToken(amount)}. Try again after the platform tops up the reserve.`,
    })
  }

  return { eligible: blockers.length === 0, amount, blockers }
}

export function canFund(status: OnchainInvoiceStatus) {
  return status === "Created"
}

export function canClientApprove(status: OnchainInvoiceStatus) {
  return status === "Funded" || status === "Advanced"
}

export function canClientDispute(status: OnchainInvoiceStatus) {
  return status === "Funded" || status === "Advanced"
}

export function canSubmitEvidence(status: OnchainInvoiceStatus) {
  return status === "Funded"
}

/** What client approval will move, given the actual advance. */
export function settlementProjection(invoice: InvoiceDetail) {
  const reserveCredit = invoice.advanceAmount
  const toFreelancer = sub(invoice.amount, invoice.advanceAmount)
  return { reserveCredit, toFreelancer }
}

export function deriveSubmissionStatus(
  submissions: Submission[],
  evaluations: EvaluationRecord[]
): SubmissionStatus {
  const latest = submissions[0]
  if (!latest) return "NotSubmitted"
  const evaluation = evaluationFor(latest, evaluations)
  return evaluation?.state === "completed" ? "Evaluated" : "Submitted"
}

export type FreelancerNextStep =
  | "await_funding"
  | "submit_evidence"
  | "await_evaluation"
  | "resubmit"
  | "request_advance"
  | "await_client"
  | "disputed"
  | "paid"

export function freelancerNextStep(
  invoice: InvoiceDetail,
  latestPassed: boolean | undefined
): FreelancerNextStep {
  switch (invoice.onchainStatus) {
    case "Created":
      return "await_funding"
    case "Disputed":
      return "disputed"
    case "Settled":
      return "paid"
    case "Advanced":
      return "await_client"
    case "Funded":
      if (invoice.submissionStatus === "NotSubmitted") return "submit_evidence"
      if (invoice.submissionStatus === "Submitted") return "await_evaluation"
      return latestPassed ? "request_advance" : "resubmit"
  }
}
