import { redactUrls } from "../../lib/chain/errors"
import type {
  ConfirmedTransaction,
  TransactionStatus,
} from "../../lib/chain/lifecycle"
import type { SubmittedTransaction } from "../../lib/chain/writes"
import type { Signer } from "./plan"

export interface RunStep {
  id: string
  label: string
  signer: Signer
  /** Sends the transaction through the SDK. Called at most once. */
  submit: () => Promise<SubmittedTransaction>
  /** Optional live-state checks after confirmation. Throw to fail the step. */
  verify?: (confirmed: ConfirmedTransaction) => Promise<void>
}

export interface StepRecord {
  id: string
  label: string
  signer: Signer
  functionName: string
  hash: string
  state: string
  blockNumber: string | null
  explorerUrl: string
  invoiceId: string | null
  /** The decoded event that proved this step from its receipt (independent of any state reads). */
  evidence: { eventName: string; args: Record<string, string> } | null
}

/**
 * Why the live-state check after a CONFIRMED transaction did not pass:
 *  - "unavailable": no consistent snapshot at the receipt block could be read (RPC behind or erroring)
 *  - "mismatch":    a consistent snapshot at the receipt block definitively disagreed with the plan
 * Either way the transaction itself is final and receipt-verified.
 */
export type VerificationKind = "unavailable" | "mismatch"

export class VerificationError extends Error {
  readonly kind: VerificationKind

  constructor(kind: VerificationKind, message: string) {
    super(message)
    this.name = "VerificationError"
    this.kind = kind
  }
}

export interface RunFailure {
  stepId: string
  label: string
  /**
   * A TransactionStatus state (reverted, replaced, unverified, unknown), "not_submitted", or one
   * of "verification_failed" / "verification_unavailable", which mean the transaction WAS
   * confirmed and only the follow-up state check did not pass.
   */
  state: string
  message: string
  hash?: string
  explorerUrl?: string
  /** True when the transaction is confirmed on-chain with its verified event. */
  transactionConfirmed: boolean
}

export interface RunOutcome {
  records: StepRecord[]
  failure?: RunFailure
}

export interface RunDeps {
  track: (submitted: SubmittedTransaction) => Promise<TransactionStatus>
  log?: (line: string) => void
}

function describe(error: unknown): string {
  return redactUrls(error instanceof Error ? error.message : String(error))
}

/**
 * Runs steps strictly in order and stops at the first problem. Each step is submitted exactly
 * once; there is no retry of any kind, because a repeated state-changing transaction can move
 * funds twice. A step only succeeds when its transaction is `confirmed` with the verified
 * expected event (and its optional live-state check passes). reverted, replaced, unverified and
 * unknown all stop the run.
 */
export async function runSteps(
  steps: RunStep[],
  deps: RunDeps
): Promise<RunOutcome> {
  const log = deps.log ?? (() => undefined)
  const records: StepRecord[] = []

  for (const step of steps) {
    log(`-> [${step.signer}] ${step.label}`)
    let submitted: SubmittedTransaction
    try {
      submitted = await step.submit()
    } catch (error) {
      return {
        records,
        failure: {
          stepId: step.id,
          label: step.label,
          state: "not_submitted",
          message: describe(error),
          transactionConfirmed: false,
        },
      }
    }
    log(`   submitted ${submitted.hash}`)

    let status: TransactionStatus
    try {
      status = await deps.track(submitted)
    } catch (error) {
      return {
        records,
        failure: {
          stepId: step.id,
          label: step.label,
          state: "unknown",
          message: describe(error),
          hash: submitted.hash,
          explorerUrl: submitted.explorerUrl,
          transactionConfirmed: false,
        },
      }
    }

    if (status.state !== "confirmed") {
      const message =
        "error" in status
          ? status.error.message
          : `unexpected state ${status.state}`
      return {
        records,
        failure: {
          stepId: step.id,
          label: step.label,
          state: status.state,
          message,
          hash: status.hash,
          explorerUrl: status.explorerUrl,
          transactionConfirmed: false,
        },
      }
    }

    records.push({
      id: step.id,
      label: step.label,
      signer: step.signer,
      functionName: submitted.functionName,
      hash: status.hash,
      state: status.state,
      blockNumber: status.blockNumber.toString(10),
      explorerUrl: status.explorerUrl,
      invoiceId: status.invoiceId,
      evidence: status.event
        ? {
            eventName: status.event.eventName,
            args: Object.fromEntries(
              Object.entries(status.event.args).map(([k, v]) => [k, String(v)])
            ),
          }
        : null,
    })
    log(`   confirmed in block ${status.blockNumber} ${status.explorerUrl}`)

    if (step.verify) {
      try {
        await step.verify(status)
      } catch (error) {
        // The transaction is confirmed and recorded above; only the follow-up state check failed.
        const unavailable =
          error instanceof VerificationError && error.kind === "unavailable"
        return {
          records,
          failure: {
            stepId: step.id,
            label: step.label,
            state: unavailable
              ? "verification_unavailable"
              : "verification_failed",
            message: describe(error),
            hash: status.hash,
            explorerUrl: status.explorerUrl,
            transactionConfirmed: true,
          },
        }
      }
    }
  }
  return { records }
}

export type OutcomeKind = "passed" | "stopped" | "confirmed_unverified"

/**
 * How a run ends, for the exit code and the wording:
 *  - passed:               exit 0
 *  - stopped:              exit 1, a transaction was not submitted, reverted, replaced, unverified or unknown
 *  - confirmed_unverified: exit 3, every transaction up to the last one is confirmed on-chain, but the
 *                          live-state check could not be completed or disagreed. This is NOT a failed
 *                          transaction and must never be described as one.
 */
export function classifyOutcome(outcome: RunOutcome): {
  kind: OutcomeKind
  exitCode: number
} {
  const failure = outcome.failure
  if (!failure) return { kind: "passed", exitCode: 0 }
  if (failure.transactionConfirmed) {
    return { kind: "confirmed_unverified", exitCode: 3 }
  }
  return { kind: "stopped", exitCode: 1 }
}
