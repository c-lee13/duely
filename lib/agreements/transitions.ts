import { computeCriteriaHash } from "@/lib/backend/criteria"
import type { Address } from "@/lib/frontend/domain"
import {
  AGREEMENT_ID_RE,
  SIGNATURE_RE,
  buildSignatureMessage,
  computeTermsHash,
  isAddress,
  isBytes32,
  isIsoUtc,
  lower,
  sameAddress,
  validateTerms,
} from "./terms"
import type {
  AgreementError,
  AgreementErrorCode,
  AgreementEvent,
  AgreementResult,
  AgreementSignature,
  AgreementStatus,
  AgreementTerms,
  AiAdoptionTarget,
  AiDescription,
  AiDescriptionKind,
  PartyRole,
  VerifiedEscrowFunding,
  VerifiedSignature,
  WorkAgreement,
} from "./types"

/**
 * State transitions for a Work Agreement. Every function is pure: it takes a record and returns a NEW, deep-frozen record (or
 * an error), never mutates its input, reads no clock (the caller passes `now`), and does no I/O.
 *
 *   draft ──submitForSignatures──▶ awaiting_signatures ──(second signature)──▶ signed_awaiting_funding ──activateWithFunding──▶ active
 *
 * - `terms` can change only in `draft`. After that, any change is `reviseAgreement`: a NEW version that starts again as a draft,
 *   with no signatures and no funding carried over.
 * - A party's signature is valid only for one version and one terms hash (the signed text names both).
 * - Activation needs BOTH signatures on the same version AND escrow funding read from the chain for exactly these terms.
 * - AI descriptions live beside the terms and never change them, except through `adoptAiDescription` on a draft, by a party.
 */

const fail = (code: AgreementErrorCode, message: string, problems: readonly string[] = []): { ok: false; error: AgreementError } => ({
  ok: false,
  error: { code, message, problems },
})
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

/** Recursively freezes plain data so a stored agreement can't be edited in place by accident. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
  }
  return value
}

const event = (type: AgreementEvent["type"], at: string, by: Address | null, status: AgreementStatus, note?: string): AgreementEvent => ({
  type,
  at,
  by: by === null ? null : lower(by),
  status,
  ...(note ? { note } : {}),
})

const ROLES: readonly PartyRole[] = ["client", "freelancer"]
const roleOf = (terms: AgreementTerms, who: string): PartyRole | null => (ROLES.find((r) => sameAddress(terms.parties[r], who)) ?? null)
export const signatureFor = (a: WorkAgreement, role: PartyRole) => a.signatures.find((s) => s.role === role) ?? null
export const isFullySigned = (a: WorkAgreement) => ROLES.every((r) => signatureFor(a, r) !== null)
/** Terms can be edited in place only while the agreement is a draft. */
export const canEditTerms = (a: WorkAgreement) => a.status === "draft"

function checkNow(now: unknown): AgreementError | null {
  return isIsoUtc(now) ? null : { code: "INVALID_INPUT", message: "A valid UTC time (ISO-8601 ending in Z) is required.", problems: [] }
}

// ---- invariants --------------------------------------------------------------------------------------------------------------

/**
 * Checks that a record is internally consistent for its status. Every transition runs this on its result, and callers should run
 * it on any record loaded from storage: it catches, for example, an `active` record without funding, a signature for another
 * version, or terms that no longer match their hash. Returns the problems (empty = consistent).
 */
export function validateAgreementInvariants(a: WorkAgreement): string[] {
  const p: string[] = []
  if (!AGREEMENT_ID_RE.test(a.agreementId)) p.push("The agreement id is invalid.")
  if (!Number.isInteger(a.version) || a.version < 1) p.push("The version must be a positive whole number.")
  if (a.version === 1 && a.supersedes !== null) p.push("Version 1 can't supersede anything.")
  if (a.version > 1 && (a.supersedes === null || a.supersedes.version !== a.version - 1)) p.push("A later version must supersede the version directly before it.")

  // AI text is never contractual
  for (const d of a.aiDescriptions) if (d.nonBinding !== true) p.push(`AI description "${d.id}" must be marked non-binding.`)
  const unknownTermKeys = Object.keys(a.terms).filter((k) => !["title", "scope", "parties", "deliverables", "acceptanceCriteria", "milestones", "projectDeadline", "payment", "legalTerms"].includes(k))
  if (unknownTermKeys.length) p.push(`Terms contain fields that aren't contractual: ${unknownTermKeys.join(", ")}.`)

  if (a.status === "draft") {
    if (a.termsHash !== null) p.push("A draft has no terms hash yet.")
    if (a.signatures.length > 0) p.push("A draft can't carry signatures.")
    if (a.funding !== null) p.push("A draft can't carry funding.")
    return p
  }

  // everything past draft: frozen terms with a matching hash
  const problems = validateTerms(a.terms)
  if (problems.length) p.push(`The terms are not valid: ${problems.join(" ")}`)
  let recomputed: string | null = null
  try {
    recomputed = computeTermsHash(a.terms)
  } catch {
    p.push("The terms can't be hashed.")
  }
  if (a.termsHash === null || !isBytes32(a.termsHash)) p.push("The terms hash is missing.")
  else if (recomputed !== null && lower(a.termsHash) !== recomputed) p.push("The terms no longer match their hash: signed terms were altered.")

  // signatures: at most one per role, each bound to THIS version, hash and message
  const seen = new Set<PartyRole>()
  for (const s of a.signatures) {
    if (seen.has(s.role)) p.push(`There is more than one ${s.role} signature.`)
    seen.add(s.role)
    if (s.agreementId !== a.agreementId || s.version !== a.version) p.push(`The ${s.role} signature is for a different agreement version.`)
    if (a.termsHash === null || lower(s.termsHash) !== lower(a.termsHash)) p.push(`The ${s.role} signature is for different terms.`)
    if (s.legalTermsVersion !== a.terms.legalTerms.version) p.push(`The ${s.role} signature is for a different legal terms version.`)
    if (!sameAddress(s.signer, a.terms.parties[s.role])) p.push(`The ${s.role} signature isn't from the ${s.role}'s wallet.`)
    if (s.message !== buildSignatureMessage(a, s.role)) p.push(`The ${s.role} signature isn't over this version's signing text.`)
    if (!SIGNATURE_RE.test(s.signature)) p.push(`The ${s.role} signature is malformed.`)
  }

  const signedBoth = ROLES.every((r) => seen.has(r))
  if (a.status === "awaiting_signatures") {
    if (signedBoth) p.push("Both parties have signed, so the agreement should be awaiting funding.")
    if (a.funding !== null) p.push("Funding can't be recorded before both signatures.")
  } else {
    if (!signedBoth) p.push(`An agreement that is ${a.status} needs both signatures on this version.`)
    if (a.status === "signed_awaiting_funding" && a.funding !== null) p.push("This agreement is still awaiting funding.")
    if (a.status === "active") {
      if (a.funding === null) p.push("An active agreement needs verified escrow funding.")
      else p.push(...fundingProblems(a, a.funding))
    }
  }
  return p
}

function checked(a: WorkAgreement): AgreementResult {
  const problems = validateAgreementInvariants(a)
  return problems.length ? fail("INVARIANT_VIOLATION", "The resulting agreement would be inconsistent.", problems) : ok(deepFreeze(a))
}

// ---- draft -------------------------------------------------------------------------------------------------------------------

/**
 * Starts version 1 as a draft. A draft may be incomplete: only the parties are checked here (valid, distinct, and the creator is
 * one of them). The full rules run when it is submitted for signature.
 */
export function createDraft(input: { agreementId: string; terms: AgreementTerms; createdBy: Address; now: string }): AgreementResult {
  const bad = checkNow(input.now)
  if (bad) return { ok: false, error: bad }
  if (typeof input.agreementId !== "string" || !AGREEMENT_ID_RE.test(input.agreementId)) return fail("INVALID_INPUT", "The agreement id is invalid (letters, digits, _ and -, up to 64 characters).")
  const parties = input.terms?.parties
  if (!parties || !isAddress(parties.client) || !isAddress(parties.freelancer)) return fail("INVALID_TERMS", "Both parties need valid wallet addresses.")
  if (sameAddress(parties.client, parties.freelancer)) return fail("INVALID_TERMS", "The client and the freelancer must be different wallets.")
  if (!isAddress(input.createdBy) || roleOf(input.terms, input.createdBy) === null) return fail("NOT_A_PARTY", "Only the client or the freelancer can start an agreement.")
  const unknown = Object.keys(input.terms).filter((k) => !["title", "scope", "parties", "deliverables", "acceptanceCriteria", "milestones", "projectDeadline", "payment", "legalTerms"].includes(k))
  if (unknown.length) return fail("INVALID_TERMS", "Terms may only contain contractual fields.", unknown.map((k) => `Unknown field "${k}".`))
  return checked({
    agreementId: input.agreementId,
    version: 1,
    status: "draft",
    terms: input.terms,
    termsHash: null,
    supersedes: null,
    signatures: [],
    funding: null,
    aiDescriptions: [],
    createdAt: input.now,
    updatedAt: input.now,
    events: [event("created", input.now, input.createdBy, "draft")],
  })
}

/** Replaces top-level term fields of a DRAFT. Once submitted, terms are frozen: use `reviseAgreement`. */
export function updateDraftTerms(a: WorkAgreement, patch: Partial<AgreementTerms>, by: Address, now: string): AgreementResult {
  const bad = checkNow(now)
  if (bad) return { ok: false, error: bad }
  if (a.status !== "draft") return fail("TERMS_FROZEN", "These terms are frozen. Changing them needs a new agreement version.")
  if (!isAddress(by) || roleOf(a.terms, by) === null) return fail("NOT_A_PARTY", "Only the client or the freelancer can edit the draft.")
  const terms = { ...a.terms, ...patch } as AgreementTerms
  if (!terms.parties || !isAddress(terms.parties.client) || !isAddress(terms.parties.freelancer) || sameAddress(terms.parties.client, terms.parties.freelancer)) {
    return fail("INVALID_TERMS", "Both parties need valid, different wallet addresses.")
  }
  if (roleOf(terms, by) === null) return fail("NOT_A_PARTY", "You can't edit a draft in a way that removes yourself from it.")
  return checked({ ...a, terms, updatedAt: now })
}

/** Freezes the terms (computes their hash) and opens signing. Runs every business rule on the terms. */
export function submitForSignatures(a: WorkAgreement, by: Address, now: string): AgreementResult {
  const bad = checkNow(now)
  if (bad) return { ok: false, error: bad }
  if (a.status !== "draft") return fail("INVALID_TRANSITION", `Only a draft can be submitted for signatures (this is ${a.status}).`)
  if (!isAddress(by) || roleOf(a.terms, by) === null) return fail("NOT_A_PARTY", "Only the client or the freelancer can submit the agreement for signatures.")
  const problems = validateTerms(a.terms, now)
  if (problems.length) return fail("INVALID_TERMS", "The terms aren't ready to be signed.", problems)
  return checked({
    ...a,
    status: "awaiting_signatures",
    termsHash: computeTermsHash(a.terms),
    updatedAt: now,
    events: [...a.events, event("submitted", now, by, "awaiting_signatures")],
  })
}

// ---- signatures --------------------------------------------------------------------------------------------------------------

/**
 * Records one party's signature. `signature` must be evidence from a trusted verifier that the wallet really signed, and its
 * `message` must be exactly the text for THIS version and terms hash, so a signature for another version, other terms or the
 * other party's role can never be applied here. When the second party signs, the agreement moves to `signed_awaiting_funding`.
 */
export function recordSignature(a: WorkAgreement, signature: VerifiedSignature, now: string): AgreementResult {
  const bad = checkNow(now)
  if (bad) return { ok: false, error: bad }
  if (a.status === "draft") return fail("INVALID_TRANSITION", "The agreement must be submitted for signatures first.")
  if (a.status !== "awaiting_signatures") return fail("INVALID_TRANSITION", `This agreement is already ${a.status}; it can't take more signatures.`)
  if (!signature || (signature.role !== "client" && signature.role !== "freelancer")) return fail("INVALID_INPUT", "The signature must name the signer's role.")
  if (!isAddress(signature.signer) || !sameAddress(signature.signer, a.terms.parties[signature.role])) {
    return fail("NOT_A_PARTY", `The signature isn't from the ${signature.role}'s wallet.`)
  }
  if (typeof signature.signature !== "string" || !SIGNATURE_RE.test(signature.signature)) return fail("INVALID_SIGNATURE", "The signature is malformed.")
  if (!isIsoUtc(signature.verifiedAt)) return fail("INVALID_SIGNATURE", "The signature needs a verification time in UTC.")
  if (signatureFor(a, signature.role)) return fail("ALREADY_SIGNED", `The ${signature.role} has already signed this version.`)
  if (signature.message !== buildSignatureMessage(a, signature.role)) {
    return fail("WRONG_MESSAGE", "This signature is not over this agreement version and its exact terms. It may be for an older version.")
  }
  const record: AgreementSignature = {
    role: signature.role,
    signer: lower(signature.signer),
    message: signature.message,
    signature: signature.signature,
    verifiedAt: signature.verifiedAt,
    method: "eip191",
    agreementId: a.agreementId,
    version: a.version,
    termsHash: a.termsHash as AgreementSignature["termsHash"],
    legalTermsVersion: a.terms.legalTerms.version,
  }
  const signatures = [...a.signatures, record]
  const both = ROLES.every((r) => signatures.some((s) => s.role === r))
  const status: AgreementStatus = both ? "signed_awaiting_funding" : "awaiting_signatures"
  return checked({
    ...a,
    status,
    signatures,
    updatedAt: now,
    events: [...a.events, event("signed", now, record.signer, "awaiting_signatures", record.role), ...(both ? [event("fully_signed", now, null, status)] : [])],
  })
}

// ---- activation --------------------------------------------------------------------------------------------------------------

function fundingProblems(a: WorkAgreement, f: VerifiedEscrowFunding): string[] {
  const p: string[] = []
  const t = a.terms
  if (f.source !== "chain") p.push("Funding must be read from the chain, not taken from a database or a browser.")
  if (f.onchainStatus !== "Funded") p.push(`The on-chain invoice is ${f.onchainStatus}, not Funded.`)
  if (f.chainId !== t.payment.chainId) p.push("The funding is on a different chain than the agreement.")
  if (!isAddress(f.contract)) p.push("The escrow contract address is invalid.")
  if (!isAddress(f.token) || !sameAddress(f.token, t.payment.token.address)) p.push("The funding is in a different token than the agreement.")
  if (!isAddress(f.client) || !sameAddress(f.client, t.parties.client)) p.push("The on-chain client isn't the agreement's client.")
  if (!isAddress(f.freelancer) || !sameAddress(f.freelancer, t.parties.freelancer)) p.push("The on-chain freelancer isn't the agreement's freelancer.")
  if (f.amount !== t.payment.totalAmount) p.push(`The escrowed amount ${String(f.amount)} isn't exactly the agreed total ${t.payment.totalAmount}.`)
  if (typeof f.invoiceId !== "string" || !/^(0|[1-9][0-9]*)$/.test(f.invoiceId)) p.push("The on-chain invoice id is invalid.")
  if (typeof f.blockNumber !== "string" || !/^(0|[1-9][0-9]*)$/.test(f.blockNumber)) p.push("The block number is invalid.")
  if (!isBytes32(f.criteriaHash) || lower(f.criteriaHash) !== lower(computeCriteriaHash(t.acceptanceCriteria))) {
    p.push("The on-chain invoice was created for different acceptance criteria than this agreement's.")
  }
  if (!isIsoUtc(f.readAt)) p.push("The funding evidence needs a read time in UTC.")
  return p
}

/**
 * The only way to `active`. Needs, together: the agreement signed by BOTH parties on this exact version, and escrow funding read
 * from the chain that matches these terms exactly (chain, token, parties, the full amount, the criteria hash, status Funded),
 * read after the last signature so it can't be stale evidence from before signing. `latestVersion`, when the caller knows it,
 * stops an older version from activating after a newer one exists.
 */
export function activateWithFunding(a: WorkAgreement, funding: VerifiedEscrowFunding, now: string, opts: { latestVersion?: number } = {}): AgreementResult {
  const bad = checkNow(now)
  if (bad) return { ok: false, error: bad }
  if (opts.latestVersion !== undefined && opts.latestVersion > a.version) return fail("SUPERSEDED", `Version ${opts.latestVersion} of this agreement replaces this version.`)
  if (a.status === "active") return fail("INVALID_TRANSITION", "This agreement is already active.")
  if (a.status !== "signed_awaiting_funding") {
    return fail("INVALID_TRANSITION", a.status === "awaiting_signatures" ? "Both parties must sign this version before it can be funded and activated." : `A ${a.status} agreement can't be activated.`)
  }
  const existing = validateAgreementInvariants(a)
  if (existing.length) return fail("INVARIANT_VIOLATION", "The agreement is inconsistent and can't be activated.", existing)
  if (!funding || typeof funding !== "object") return fail("FUNDING_NOT_VERIFIED", "Verified escrow funding is required.")
  if (funding.source !== "chain" || funding.onchainStatus !== "Funded") {
    return fail("FUNDING_NOT_VERIFIED", "Activation needs escrow funding that was read from the chain and is in the Funded state.", fundingProblems(a, funding))
  }
  const problems = fundingProblems(a, funding)
  if (problems.length) return fail("FUNDING_MISMATCH", "The escrow funding doesn't match this agreement.", problems)
  const lastSigned = Math.max(...a.signatures.map((s) => Date.parse(s.verifiedAt)))
  if (Date.parse(funding.readAt) < lastSigned) return fail("STALE_FUNDING_EVIDENCE", "The funding was read before the agreement was fully signed. Read it again.")
  return checked({
    ...a,
    status: "active",
    funding,
    updatedAt: now,
    events: [...a.events, event("activated", now, null, "active")],
  })
}

// ---- revisions ---------------------------------------------------------------------------------------------------------------

/**
 * Changes to terms that have left draft are a NEW VERSION: a draft with the next version number that points back at the version
 * it replaces. It has no signatures and no funding: both parties must sign the new version, and escrow must be funded for it.
 * The previous record is returned untouched by every other function and is never edited.
 */
export function reviseAgreement(a: WorkAgreement, patch: Partial<AgreementTerms>, by: Address, now: string): AgreementResult {
  const bad = checkNow(now)
  if (bad) return { ok: false, error: bad }
  if (a.status === "draft") return fail("INVALID_TRANSITION", "A draft can be edited directly. Revisions are for terms that were already submitted.")
  if (!isAddress(by) || roleOf(a.terms, by) === null) return fail("NOT_A_PARTY", "Only the client or the freelancer can revise the agreement.")
  const terms = { ...a.terms, ...patch } as AgreementTerms
  if (!terms.parties || !isAddress(terms.parties.client) || !isAddress(terms.parties.freelancer) || sameAddress(terms.parties.client, terms.parties.freelancer)) {
    return fail("INVALID_TERMS", "Both parties need valid, different wallet addresses.")
  }
  if (roleOf(terms, by) === null) return fail("NOT_A_PARTY", "A revision can't remove the person making it.")
  let unchanged = false
  try {
    unchanged = a.termsHash !== null && computeTermsHash(terms) === lower(a.termsHash)
  } catch {
    unchanged = false
  }
  if (unchanged) return fail("NO_CHANGES", "That revision doesn't change any term.")
  return checked({
    agreementId: a.agreementId,
    version: a.version + 1,
    status: "draft",
    terms,
    termsHash: null,
    supersedes: { version: a.version, termsHash: a.termsHash as NonNullable<WorkAgreement["termsHash"]> },
    signatures: [],
    funding: null,
    // The AI notes come along as notes only; they were never part of the terms.
    aiDescriptions: a.aiDescriptions,
    createdAt: now,
    updatedAt: now,
    events: [event("revised", now, by, "draft", `supersedes version ${a.version}`)],
  })
}

// ---- AI descriptions (kept apart from the terms) ---------------------------------------------------------------------------------

const AI_KINDS: readonly AiDescriptionKind[] = ["scope_suggestion", "deliverable_suggestion", "criterion_suggestion", "plain_language_summary"]

/**
 * Attaches a model-written description. Allowed at any status because it never touches the terms, the terms hash, the version or
 * any signature: it is stored beside them, always marked non-binding.
 */
export function addAiDescription(
  a: WorkAgreement,
  input: { id: string; kind: AiDescriptionKind; text: string; model: string; promptVersion: string; generatedAt: string },
  now: string
): AgreementResult {
  const bad = checkNow(now)
  if (bad) return { ok: false, error: bad }
  const problems: string[] = []
  if (typeof input.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.id)) problems.push("The description id is invalid.")
  else if (a.aiDescriptions.some((d) => d.id === input.id)) problems.push(`A description with id "${input.id}" already exists.`)
  if (!AI_KINDS.includes(input.kind)) problems.push("The description kind is not recognised.")
  if (typeof input.text !== "string" || input.text.trim() === "" || input.text.length > 5000) problems.push("The description text is required (up to 5000 characters).")
  if (typeof input.model !== "string" || input.model.trim() === "") problems.push("The model name is required.")
  if (typeof input.promptVersion !== "string" || input.promptVersion.trim() === "") problems.push("The prompt version is required.")
  if (!isIsoUtc(input.generatedAt)) problems.push("The generation time must be a UTC time.")
  if (problems.length) return fail("INVALID_INPUT", "The AI description isn't valid.", problems)
  const description: AiDescription = {
    id: input.id,
    kind: input.kind,
    text: input.text,
    model: input.model,
    promptVersion: input.promptVersion,
    generatedAt: input.generatedAt,
    nonBinding: true,
    status: "suggestion",
  }
  return checked({ ...a, aiDescriptions: [...a.aiDescriptions, description], updatedAt: now })
}

export function dismissAiDescription(a: WorkAgreement, id: string, now: string): AgreementResult {
  const bad = checkNow(now)
  if (bad) return { ok: false, error: bad }
  const d = a.aiDescriptions.find((x) => x.id === id)
  if (!d) return fail("UNKNOWN_AI_DESCRIPTION", "No such AI description.")
  if (d.status === "adopted") return fail("INVALID_TRANSITION", "An adopted description is already part of the terms; it can't be dismissed.")
  return checked({ ...a, aiDescriptions: a.aiDescriptions.map((x) => (x.id === id ? { ...x, status: "dismissed" as const } : x)), updatedAt: now })
}

/**
 * The only way AI-written text becomes a contractual term: a party explicitly copies it, verbatim, into a field of a DRAFT.
 * The description is then marked adopted, with who did it and when. After submission the terms are frozen like any others.
 */
export function adoptAiDescription(a: WorkAgreement, input: { id: string; target: AiAdoptionTarget; by: Address }, now: string): AgreementResult {
  const bad = checkNow(now)
  if (bad) return { ok: false, error: bad }
  if (a.status !== "draft") return fail("TERMS_FROZEN", "These terms are frozen. Changing them needs a new agreement version.")
  if (!isAddress(input.by) || roleOf(a.terms, input.by) === null) return fail("NOT_A_PARTY", "Only the client or the freelancer can adopt a suggestion into the terms.")
  const d = a.aiDescriptions.find((x) => x.id === input.id)
  if (!d) return fail("UNKNOWN_AI_DESCRIPTION", "No such AI description.")
  if (d.status === "adopted") return fail("INVALID_TRANSITION", "This description was already adopted.")
  const t = input.target
  const terms = a.terms
  let next: AgreementTerms
  switch (t?.field) {
    case "title":
      next = { ...terms, title: d.text }
      break
    case "scope":
      next = { ...terms, scope: d.text }
      break
    case "deliverable":
      if (!terms.deliverables.some((x) => x.id === t.id)) return fail("INVALID_INPUT", `There is no deliverable "${t.id}".`)
      next = { ...terms, deliverables: terms.deliverables.map((x) => (x.id === t.id ? { ...x, description: d.text } : x)) }
      break
    case "milestone":
      if (!terms.milestones.some((x) => x.id === t.id)) return fail("INVALID_INPUT", `There is no milestone "${t.id}".`)
      next = { ...terms, milestones: terms.milestones.map((x) => (x.id === t.id ? { ...x, description: d.text } : x)) }
      break
    case "criterion":
      if (!terms.acceptanceCriteria.some((x) => x.id === t.id)) return fail("INVALID_INPUT", `There is no criterion "${t.id}".`)
      next = { ...terms, acceptanceCriteria: terms.acceptanceCriteria.map((x) => (x.id === t.id ? { ...x, text: d.text } : x)) }
      break
    default:
      return fail("INVALID_INPUT", "Choose which term the suggestion should replace.")
  }
  const adopted: AiDescription = { ...d, status: "adopted", adopted: { target: t, by: lower(input.by), at: now } }
  return checked({ ...a, terms: next, aiDescriptions: a.aiDescriptions.map((x) => (x.id === d.id ? adopted : x)), updatedAt: now })
}
