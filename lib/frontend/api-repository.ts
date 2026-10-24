/**
 * ApiDuelyRepository — placeholder for Phase 2–5.
 *
 * Will call the endpoints in CLAUDE.md §8 (`/api/invoices`, `/api/submissions`,
 * `/api/evaluate`, `/api/advances`) and the wagmi/viem wallet adapter for
 * client-signed transactions (createInvoice, fundInvoice, approveWork,
 * disputeInvoice). Not wired yet: every method fails loudly rather than
 * pretending to succeed.
 */
import { DomainError } from "./errors"
import type { DuelyRepository } from "./repository"

function notYet(method: string): never {
  throw new DomainError(
    "NOT_IMPLEMENTED",
    `API mode isn't available yet (${method}). Set NEXT_PUBLIC_DATA_MODE=mock to use the demo.`
  )
}

export class ApiDuelyRepository implements DuelyRepository {
  readonly mode = "api" as const

  getSession = async () => notYet("getSession")
  listInvoices = async () => notYet("listInvoices")
  getInvoice = async () => notYet("getInvoice → GET /api/invoices/:id")
  createInvoice = async () => notYet("createInvoice → wallet tx + POST /api/invoices")
  fundInvoice = async () => notYet("fundInvoice → wallet tx")
  submitEvidence = async () => notYet("submitEvidence → POST /api/submissions")
  getEvaluation = async () => notYet("getEvaluation")
  requestEvaluation = async () => notYet("requestEvaluation → POST /api/evaluate")
  requestAdvance = async () => notYet("requestAdvance → POST /api/advances")
  approveInvoice = async () => notYet("approveInvoice → wallet tx")
  disputeInvoice = async () => notYet("disputeInvoice → wallet tx")
  getTimeline = async () => notYet("getTimeline")
  listTransactions = async () => notYet("listTransactions")
  getBalances = async () => notYet("getBalances")
  depositReserve = async () => notYet("depositReserve → platform wallet tx")
  subscribe() {
    return () => {}
  }
}
