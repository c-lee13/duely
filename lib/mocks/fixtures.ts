/**
 * Deterministic demo seed. Built by replaying scenarios through the simulated
 * ledger, so every balance is consistent with the transitions that produced it.
 * All names, wallets and amounts are fictional demo-token values.
 */
import type { CreateInvoiceInput } from "@/lib/frontend/domain"
import { tokens } from "@/lib/frontend/token"
import { ACTORS } from "./actors"
import { simulateEvaluation } from "./evaluator"
import {
  MOCK_SCHEMA_VERSION,
  addSubmission,
  addTimeline,
  approveAdvance,
  approveWork,
  createInvoice,
  depositReserve,
  disputeInvoice,
  findInvoice,
  fundInvoice,
  nextId,
  storeEvaluation,
  type MockState,
} from "./ledger"
import { advanceFor } from "@/lib/frontend/token"

const C = ACTORS.client.wallet
const F = ACTORS.freelancer.wallet
const F2 = ACTORS.otherFreelancer.wallet
const P = ACTORS.platform.wallet

/** Fixed timestamps: day offset from 2026-10-01 plus hour. */
function at(day: number, hour = 10, minute = 0): string {
  const d = new Date(Date.UTC(2026, 9, 1 + day, hour, minute))
  return d.toISOString()
}

function emptyState(): MockState {
  const genesis = {
    [C.toLowerCase()]: tokens(20_000),
    [P.toLowerCase()]: tokens(20_000),
    [F.toLowerCase()]: "0",
    [F2.toLowerCase()]: "0",
  }
  return {
    schemaVersion: MOCK_SCHEMA_VERSION,
    role: "client",
    settings: { failNextTransaction: false },
    invoices: [],
    submissions: [],
    simulatedOutcomes: {},
    evaluations: [],
    advanceRequests: [],
    transactions: [],
    timeline: [],
    wallets: genesis,
    reserve: "0",
    totalSupply: tokens(40_000),
    counters: { invoice: 0, submission: 0, evaluation: 0, tx: 0, event: 0, request: 0 },
  }
}

function submitAndEvaluate(
  s: MockState,
  invoiceId: string,
  file: { name: string; size: number; type: string; note: string },
  outcome: "pass" | "fail",
  submittedAt: string,
  evaluatedAt: string
) {
  const submission = addSubmission(
    s,
    findInvoice(s, invoiceId).freelancer,
    { invoiceId, fileName: file.name, fileSize: file.size, mimeType: file.type, note: file.note },
    submittedAt
  )
  s.simulatedOutcomes[submission.submissionId] = outcome
  storeEvaluation(
    s,
    simulateEvaluation({
      evaluationId: `eval-${nextId(s, "evaluation")}`,
      invoice: findInvoice(s, invoiceId),
      submission,
      outcome,
      at: evaluatedAt,
    })
  )
}

function requestAndPayAdvance(s: MockState, invoiceId: string, when: string) {
  const invoice = findInvoice(s, invoiceId)
  const requestId = `adv-${nextId(s, "request")}`
  addTimeline(s, {
    invoiceId,
    at: when,
    kind: "advance_requested",
    layer: "offchain",
    title: "Freelancer requested a 90% advance",
    description: "Explicit request after a passing evaluation. The platform checked eligibility before signing.",
    amount: advanceFor(invoice.amount),
  })
  approveAdvance(s, P, invoiceId, { at: when })
  const tx = s.transactions[s.transactions.length - 1]
  s.advanceRequests.push({
    requestId,
    invoiceId,
    status: "paid",
    amount: advanceFor(invoice.amount),
    createdAt: when,
    transactionId: tx.id,
  })
}

const SAMPLE_FILES = {
  deck: { name: "pitch-deck-final.pdf", size: 4_812_330, type: "application/pdf", note: "Final 18-slide deck with speaker notes and editable source." },
  dashboard: { name: "analytics-dashboard-walkthrough.zip", size: 12_440_112, type: "application/zip", note: "Dashboard build, screenshots and deployment notes." },
  onboarding: { name: "onboarding-flows-v2.pdf", size: 7_120_004, type: "application/pdf", note: "All five onboarding screens with prototype link." },
  landing: { name: "landing-page-handoff.zip", size: 9_310_552, type: "application/zip", note: "Responsive build, Lighthouse report and deployment URL." },
  apiDocs: { name: "api-docs-draft.md", size: 48_220, type: "text/markdown", note: "First pass at the reference docs." },
  video: { name: "explainer-cut-final.png", size: 2_204_118, type: "image/png", note: "Storyboard frames and final render link." },
}

function inv(
  title: string,
  freelancer: typeof F,
  whole: number,
  description: string,
  criteria: Array<[string, boolean]>,
  dueDate?: string
): CreateInvoiceInput {
  return {
    title,
    freelancer,
    amount: tokens(whole),
    description,
    dueDate,
    criteria: criteria.map(([text, mandatory]) => ({ text, mandatory })),
  }
}

export function buildSeedState(): MockState {
  const s = emptyState()

  // Platform prefunds the reserve from its own demo-token wallet.
  depositReserve(s, P, tokens(6_000), { at: at(0, 9) })

  // #1 — Settled WITH advance: 900 from reserve, then 900 credited back + 100 to freelancer.
  createInvoice(s, C, inv("Investor pitch deck", F, 1_000, "18-slide seed-round pitch deck with a consistent visual system.", [
    ["Deck has 15–20 slides covering problem, solution, market, traction and ask", true],
    ["Uses the Northwind brand colors and typography", true],
    ["Editable source file is included", false],
  ], at(10)), { at: at(0, 11) })
  fundInvoice(s, C, "1", { at: at(0, 12) })
  submitAndEvaluate(s, "1", SAMPLE_FILES.deck, "pass", at(3, 15), at(3, 15, 2))
  requestAndPayAdvance(s, "1", at(3, 16))
  approveWork(s, C, "1", { at: at(5, 10) })

  // #2 — Settled WITHOUT advance (other freelancer): full 800 from escrow.
  createInvoice(s, C, inv("Analytics dashboard", F2, 800, "Internal KPI dashboard with weekly revenue and retention charts.", [
    ["Dashboard shows weekly revenue and retention", true],
    ["Includes a short handoff document", false],
  ]), { at: at(2, 9) })
  fundInvoice(s, C, "2", { at: at(2, 10) })
  submitAndEvaluate(s, "2", SAMPLE_FILES.dashboard, "pass", at(6, 11), at(6, 11, 2))
  approveWork(s, C, "2", { at: at(7, 9) })

  // #3 — Disputed AFTER advance: settlement frozen, advance not clawed back.
  createInvoice(s, C, inv("Mobile onboarding flows", F, 1_500, "Five onboarding screens for the iOS app, delivered as a clickable prototype.", [
    ["All five onboarding screens are designed", true],
    ["Clickable prototype link is provided", true],
    ["Accessibility notes for color contrast", false],
  ], at(20)), { at: at(4, 9) })
  fundInvoice(s, C, "3", { at: at(4, 10) })
  submitAndEvaluate(s, "3", SAMPLE_FILES.onboarding, "pass", at(9, 14), at(9, 14, 2))
  requestAndPayAdvance(s, "3", at(9, 15))
  disputeInvoice(s, C, "3", { at: at(11, 16) })

  // #4 — Advanced, awaiting client approval: approving credits 1,800 to reserve and pays 200.
  createInvoice(s, C, inv("Marketing landing page", F, 2_000, "Responsive landing page built in Next.js and deployed to staging.", [
    ["Page is responsive from 360px to 1440px", true],
    ["Lighthouse performance score of 90 or higher", true],
    ["Contact form sends submissions to the shared inbox", true],
  ], at(25)), { at: at(7, 9) })
  fundInvoice(s, C, "4", { at: at(7, 10) })
  submitAndEvaluate(s, "4", SAMPLE_FILES.landing, "pass", at(16, 13), at(16, 13, 2))
  requestAndPayAdvance(s, "4", at(16, 14))

  // #5 — Funded, evaluation FAILED: advance blocked until improved evidence passes.
  createInvoice(s, C, inv("Public API documentation", F, 1_200, "Reference documentation for the public REST API, with runnable examples.", [
    ["Every public endpoint is documented with request and response examples", true],
    ["Authentication section explains API keys and rate limits", true],
    ["Changelog page is included", false],
  ], at(30)), { at: at(11, 9) })
  fundInvoice(s, C, "5", { at: at(11, 10) })
  submitAndEvaluate(s, "5", SAMPLE_FILES.apiDocs, "fail", at(19, 17), at(19, 17, 2))

  // #6 — Funded, evaluation PASSED, but reserve is too small for the 5,400 advance.
  createInvoice(s, C, inv("Product explainer video", F, 6_000, "90-second animated explainer video with voice-over.", [
    ["Final video is 75–100 seconds long", true],
    ["Voice-over follows the approved script", true],
    ["Delivered in 1080p and 4K", false],
  ], at(28)), { at: at(14, 9) })
  fundInvoice(s, C, "6", { at: at(14, 10) })
  submitAndEvaluate(s, "6", SAMPLE_FILES.video, "pass", at(21, 12), at(21, 12, 2))

  // #7 — Fresh happy path: funded 1,000, no evidence yet.
  createInvoice(s, C, inv("Brand identity refresh", F, 1_000, "Refresh the Northwind logo, color palette and typography, with a short brand guide.", [
    ["Primary logo delivered in SVG and PNG", true],
    ["Color palette with accessible contrast pairs", true],
    ["Two-page brand usage guide", false],
  ], at(35)), { at: at(19, 9) })
  fundInvoice(s, C, "7", { at: at(19, 10) })

  // #8 — Created but not funded yet.
  createInvoice(s, C, inv("Logo animation", F, 500, "Five-second animated logo sting for video intros.", [
    ["Animation is 4–6 seconds long", true],
    ["Exported as MP4 and Lottie JSON", true],
  ]), { at: at(21, 15) })

  return s
}
