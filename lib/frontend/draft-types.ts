/**
 * Wire shape of POST /api/agreements/draft, as the browser sees it. Mirrors `RequirementsDraft` in lib/ai/requirements-draft.ts
 * (frontend code must not import lib/ai, even for types); tests/agreement-draft-api.test.ts checks the server type is assignable
 * to this one, so a drift fails the build.
 */
export type DraftOrigin = "requested" | "suggested"

export interface DraftScopeItem {
  id: string
  text: string
  origin: DraftOrigin
  sourceQuote: string | null
  status: "draft"
}

export interface DraftDeliverableItem {
  id: string
  title: string
  description: string
  origin: DraftOrigin
  sourceQuote: string | null
  status: "draft"
}

export interface DraftCriterionItem {
  id: string
  text: string
  mandatory: boolean
  verification: string
  origin: DraftOrigin
  sourceQuote: string | null
  status: "draft"
  warnings: string[]
}

export interface DraftQuestionItem {
  id: string
  question: string
  topic: string
  whyItMatters: string
}

export interface AgreementDraft {
  draft: true
  reviewRequired: true
  status: "ai_draft_requires_review"
  notice: string
  promptVersion: string
  originalDescription: string
  projectSummary: string | null
  scope: { inScope: DraftScopeItem[]; outOfScope: DraftScopeItem[] }
  deliverables: DraftDeliverableItem[]
  acceptanceCriteria: DraftCriterionItem[]
  clarificationQuestions: DraftQuestionItem[]
  commercialMentions: { text: string; note: string }[]
  notes: string[]
  counts: { requested: number; suggested: number }
}
