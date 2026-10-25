import type { Address, Bytes32, OnchainInvoiceStatus, TokenAmount } from "@/lib/frontend/domain"

/**
 * Work Agreement: the contract between a client and a freelancer for a software-development job. DOMAIN MODEL ONLY.
 *
 * This module is pure data and pure functions. It stores nothing, signs nothing, verifies no signature itself, reads no chain,
 * calls no model, and changes no invoice or payment behaviour. Trusted adapters (outside this module) do those jobs and hand
 * the domain their evidence: a `VerifiedSignature` from a server that recovered the signer, and a `VerifiedEscrowFunding`
 * read from the contract. The domain only decides whether that evidence is enough for the next state.
 *
 * Three layers, kept strictly apart:
 *  1. `terms`           the CONTRACTUAL terms. Editable only while a draft; hashed and frozen once submitted for signature.
 *  2. `signatures`/`funding`   evidence about those exact terms (a specific version and terms hash).
 *  3. `aiDescriptions`  non-binding, model-written suggestions. Never part of `terms`, never hashed, never signed. Text only
 *                       becomes a term when a party explicitly adopts it into a draft.
 *
 * Money follows the repo rule: token amounts are decimal strings of base units, handled with bigint, never floats.
 * Every type is readonly: transitions return new objects and never mutate their inputs.
 */

export const AGREEMENT_STATUSES = ["draft", "awaiting_signatures", "signed_awaiting_funding", "active"] as const
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number]

export type PartyRole = "client" | "freelancer"

/** An ISO-8601 UTC instant such as `2026-12-01T00:00:00.000Z`. Always UTC, always with the `Z`. */
export type IsoUtc = string

export interface AgreementParties {
  /** Pays into escrow and approves the work. */
  readonly client: Address
  /** Delivers the work and is paid from escrow. */
  readonly freelancer: Address
}

export interface Deliverable {
  /** Stable within the agreement: lower-case letters, digits, `-` and `_`. */
  readonly id: string
  readonly title: string
  readonly description: string
}

/** An acceptance criterion agreed in advance. These are the frozen criteria the AI later evaluates against. */
export interface AgreementCriterion {
  readonly id: string
  readonly text: string
  /** A mandatory criterion must be verified for a pass. */
  readonly mandatory: boolean
  /**
   * Share of the 100 evaluation points. Optional, but all-or-none: if any criterion has a weight, every one must, as positive
   * integers totalling exactly 100 (the scoring engine's rule). Weights are part of the signed terms.
   */
  readonly weight?: number
}

export interface Milestone {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly dueAt: IsoUtc
  /** Share of the total payment for this milestone, in token base units. The milestone amounts add up to the total exactly. */
  readonly amount: TokenAmount
  /** Every deliverable belongs to exactly one milestone. */
  readonly deliverableIds: readonly string[]
  /** Every acceptance criterion belongs to exactly one milestone. */
  readonly criterionIds: readonly string[]
}

export interface PaymentTerms {
  readonly chainId: number
  readonly token: { readonly address: Address; readonly symbol: string; readonly decimals: number }
  /** The whole contract amount, in base units. Escrowed in full before work starts. */
  readonly totalAmount: TokenAmount
  /** Escrow of the full amount is how every Duely agreement is paid. Not optional, recorded so the term is explicit. */
  readonly escrow: { readonly fullAmountUpfront: true }
  /** The platform's early-advance option. The percentage is fixed by platform policy, not negotiated per agreement. */
  readonly earlyAdvance: { readonly enabled: boolean; readonly percent: 90 }
}

export interface LegalTerms {
  /** Identifier of the legal terms text the parties are agreeing to, e.g. `duely-terms-2026-11`. */
  readonly version: string
  /** Keccak-256 of that exact text when available, so the version can't silently change meaning. */
  readonly contentHash: Bytes32 | null
}

/** Everything the parties agree to, and nothing else. There is deliberately no AI-written field in here. */
export interface AgreementTerms {
  readonly title: string
  /** The statement of work, written (or explicitly adopted) by a party. */
  readonly scope: string
  readonly parties: AgreementParties
  readonly deliverables: readonly Deliverable[]
  readonly acceptanceCriteria: readonly AgreementCriterion[]
  readonly milestones: readonly Milestone[]
  readonly projectDeadline: IsoUtc
  readonly payment: PaymentTerms
  readonly legalTerms: LegalTerms
}

// ---- signatures --------------------------------------------------------------------------------------------------------------

/**
 * Evidence that `signer` signed `message` with an EIP-191 wallet signature. Produced ONLY by a trusted server-side verifier
 * that recovered the address (see lib/auth/wallet-verify.ts for the pattern). The domain never checks a signature itself.
 */
export interface VerifiedSignature {
  readonly role: PartyRole
  readonly signer: Address
  /** The exact text that was signed. Must equal `buildSignatureMessage(...)` for this agreement version. */
  readonly message: string
  /** 0x + 130 hex characters. */
  readonly signature: `0x${string}`
  readonly verifiedAt: IsoUtc
}

/** An explicit, stored signature, bound to one agreement version and terms hash. */
export interface AgreementSignature extends VerifiedSignature {
  readonly method: "eip191"
  readonly agreementId: string
  readonly version: number
  readonly termsHash: Bytes32
  readonly legalTermsVersion: string
}

// ---- funding -----------------------------------------------------------------------------------------------------------------

/**
 * Escrow state READ FROM THE CONTRACT by a trusted chain adapter. Never a database cache and never a browser claim
 * (CLAUDE.md: on-chain financial state is authoritative).
 */
export interface VerifiedEscrowFunding {
  readonly source: "chain"
  readonly chainId: number
  readonly contract: Address
  /** The on-chain invoice id (uint256, decimal string). */
  readonly invoiceId: string
  readonly token: Address
  readonly client: Address
  readonly freelancer: Address
  readonly amount: TokenAmount
  /** The criteria hash committed on-chain for this invoice. */
  readonly criteriaHash: Bytes32
  readonly onchainStatus: OnchainInvoiceStatus
  readonly blockNumber: string
  readonly readAt: IsoUtc
}

// ---- AI-written descriptions (non-binding) -------------------------------------------------------------------------------

export type AiDescriptionKind = "scope_suggestion" | "deliverable_suggestion" | "criterion_suggestion" | "plain_language_summary"

export type AiAdoptionTarget =
  | { readonly field: "title" }
  | { readonly field: "scope" }
  | { readonly field: "deliverable"; readonly id: string }
  | { readonly field: "milestone"; readonly id: string }
  | { readonly field: "criterion"; readonly id: string }

/**
 * Text written by a model. It is a suggestion or an explanatory summary: it carries no contractual weight, is excluded from the
 * terms hash and from what is signed, and can change or be dismissed without creating a new agreement version.
 */
export interface AiDescription {
  readonly id: string
  readonly kind: AiDescriptionKind
  readonly text: string
  readonly model: string
  readonly promptVersion: string
  readonly generatedAt: IsoUtc
  /** Always true: this text is not part of the agreement. */
  readonly nonBinding: true
  readonly status: "suggestion" | "adopted" | "dismissed"
  /** Set when a party explicitly copied this text into a draft's terms. */
  readonly adopted?: { readonly target: AiAdoptionTarget; readonly by: Address; readonly at: IsoUtc }
}

// ---- the agreement -----------------------------------------------------------------------------------------------------------

export type AgreementEventType = "created" | "revised" | "submitted" | "signed" | "fully_signed" | "activated"

export interface AgreementEvent {
  readonly type: AgreementEventType
  readonly at: IsoUtc
  readonly by: Address | null
  /** The status after this event. */
  readonly status: AgreementStatus
  readonly note?: string
}

export interface WorkAgreement {
  /** Stable across versions of the same agreement. */
  readonly agreementId: string
  /** 1 for a new agreement; each revision of signed terms is a new, higher version. */
  readonly version: number
  readonly status: AgreementStatus
  readonly terms: AgreementTerms
  /** Hash of the canonical terms, set when submitted for signature; null while a draft. */
  readonly termsHash: Bytes32 | null
  /** The version this one replaces, if it is a revision. */
  readonly supersedes: { readonly version: number; readonly termsHash: Bytes32 } | null
  /** At most one per role, each bound to this version and terms hash. */
  readonly signatures: readonly AgreementSignature[]
  /** Set only on activation. */
  readonly funding: VerifiedEscrowFunding | null
  /** Non-binding, separate from `terms`. */
  readonly aiDescriptions: readonly AiDescription[]
  readonly createdAt: IsoUtc
  readonly updatedAt: IsoUtc
  readonly events: readonly AgreementEvent[]
}

// ---- results -----------------------------------------------------------------------------------------------------------------

export type AgreementErrorCode =
  | "INVALID_INPUT"
  | "INVALID_TERMS"
  | "INVALID_TRANSITION"
  | "TERMS_FROZEN"
  | "NOT_A_PARTY"
  | "WRONG_MESSAGE"
  | "INVALID_SIGNATURE"
  | "ALREADY_SIGNED"
  | "FUNDING_NOT_VERIFIED"
  | "FUNDING_MISMATCH"
  | "STALE_FUNDING_EVIDENCE"
  | "SUPERSEDED"
  | "NO_CHANGES"
  | "UNKNOWN_AI_DESCRIPTION"
  | "INVARIANT_VIOLATION"

export interface AgreementError {
  readonly code: AgreementErrorCode
  readonly message: string
  /** Specific problems, for example every failing term rule. */
  readonly problems: readonly string[]
}

export type AgreementResult<T = WorkAgreement> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AgreementError }
