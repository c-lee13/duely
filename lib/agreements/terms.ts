import { keccak256, toBytes } from "viem"
import type { Address, Bytes32 } from "@/lib/frontend/domain"
import type { AgreementTerms, PartyRole, WorkAgreement } from "./types"

/**
 * Validation, canonical encoding and hashing of agreement terms, and the exact text a party signs. Pure: no clock (callers pass
 * `now`), no I/O, no signing, no chain.
 *
 * STATUS: PROPOSED encoding. Like the criteria hash (lib/backend/criteria.ts), the canonical form below is a proposal until the
 * integration owner and counsel confirm it; changing it later would change every terms hash, so it is versioned (`v`).
 */

export const TERMS_ENCODING_VERSION = 1
/** The platform's early-advance percentage (CLAUDE.md: floor(amount * 90 / 100)). Not negotiable per agreement. */
export const EARLY_ADVANCE_PERCENT = 90

export const LIMITS = {
  title: 120,
  scope: 5000,
  itemTitle: 120,
  itemDescription: 2000,
  criterionText: 500,
  deliverables: 50,
  criteria: 100,
  milestones: 20,
  symbol: 12,
  maxDecimals: 36,
} as const

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const UINT_RE = /^(0|[1-9][0-9]*)$/
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
const LEGAL_VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1)

export const isAddress = (v: unknown): v is Address => typeof v === "string" && ADDRESS_RE.test(v)
export const isBytes32 = (v: unknown): v is Bytes32 => typeof v === "string" && BYTES32_RE.test(v)
export const lower = <T extends string>(a: T): T => a.toLowerCase() as T
export const sameAddress = (a: string, b: string) => lower(a) === lower(b)

/** True for a real UTC instant written as ISO-8601 with a trailing Z. Rejects impossible dates such as 2026-02-31. */
export function isIsoUtc(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_UTC_RE.test(v)) return false
  const t = Date.parse(v)
  if (Number.isNaN(t)) return false
  return new Date(t).toISOString().slice(0, 19) === v.slice(0, 19)
}

const text = (s: string) => s.normalize("NFC").trim()
const nonBlank = (v: unknown, max: number): v is string => typeof v === "string" && text(v).length > 0 && text(v).length <= max
const isUint = (v: unknown): v is string => typeof v === "string" && UINT_RE.test(v) && BigInt(v) <= UINT256_MAX
const isPositiveUint = (v: unknown): v is string => isUint(v) && BigInt(v) > BigInt(0)

const KNOWN_TERMS_KEYS = ["title", "scope", "parties", "deliverables", "acceptanceCriteria", "milestones", "projectDeadline", "payment", "legalTerms"]

/** Every business rule for terms that are about to be signed. Returns the list of problems (empty = valid). */
export function validateTerms(terms: AgreementTerms, now?: string): string[] {
  const p: string[] = []
  const t = terms as unknown as Record<string, unknown>
  if (typeof t !== "object" || t === null) return ["Terms are required."]
  // Nothing outside the known contractual fields: this is what keeps (for example) an AI summary from riding along in the terms.
  for (const k of Object.keys(t)) if (!KNOWN_TERMS_KEYS.includes(k)) p.push(`Unknown field "${k}" is not part of an agreement's terms.`)

  if (!nonBlank(terms.title, LIMITS.title)) p.push(`The title is required (up to ${LIMITS.title} characters).`)
  if (!nonBlank(terms.scope, LIMITS.scope)) p.push(`The scope of work is required (up to ${LIMITS.scope} characters).`)

  // parties
  const parties = terms.parties
  if (!parties || !isAddress(parties.client)) p.push("The client must be a valid wallet address.")
  if (!parties || !isAddress(parties.freelancer)) p.push("The freelancer must be a valid wallet address.")
  if (parties && isAddress(parties.client) && isAddress(parties.freelancer) && sameAddress(parties.client, parties.freelancer)) {
    p.push("The client and the freelancer must be different wallets.")
  }

  // ids and items
  const ids = (label: string, list: ReadonlyArray<{ id: string }>) => {
    const seen = new Set<string>()
    for (const x of list) {
      if (typeof x.id !== "string" || !ID_RE.test(x.id)) p.push(`${label} id ${JSON.stringify(x.id)} is invalid (lower-case letters, digits, - and _; up to 40 characters).`)
      else if (seen.has(x.id)) p.push(`${label} id "${x.id}" is used more than once.`)
      else seen.add(x.id)
    }
    return seen
  }
  const deliverables = Array.isArray(terms.deliverables) ? terms.deliverables : []
  const criteria = Array.isArray(terms.acceptanceCriteria) ? terms.acceptanceCriteria : []
  const milestones = Array.isArray(terms.milestones) ? terms.milestones : []
  if (deliverables.length < 1 || deliverables.length > LIMITS.deliverables) p.push(`Between 1 and ${LIMITS.deliverables} deliverables are required.`)
  if (criteria.length < 1 || criteria.length > LIMITS.criteria) p.push(`Between 1 and ${LIMITS.criteria} acceptance criteria are required.`)
  if (milestones.length < 1 || milestones.length > LIMITS.milestones) p.push(`Between 1 and ${LIMITS.milestones} milestones are required.`)
  const deliverableIds = ids("Deliverable", deliverables)
  const criterionIds = ids("Criterion", criteria)
  const milestoneIds = ids("Milestone", milestones)
  void milestoneIds
  for (const d of deliverables) {
    if (!nonBlank(d.title, LIMITS.itemTitle)) p.push(`Deliverable "${d.id}" needs a title.`)
    if (!nonBlank(d.description, LIMITS.itemDescription)) p.push(`Deliverable "${d.id}" needs a description.`)
  }
  for (const c of criteria) {
    if (!nonBlank(c.text, LIMITS.criterionText)) p.push(`Criterion "${c.id}" needs text (up to ${LIMITS.criterionText} characters).`)
    if (typeof c.mandatory !== "boolean") p.push(`Criterion "${c.id}" must say whether it is mandatory.`)
  }

  // weights: all or none, positive integers totalling 100
  const weighted = criteria.filter((c) => c.weight !== undefined)
  if (weighted.length > 0) {
    if (weighted.length !== criteria.length) p.push("Either every criterion has a weight or none does.")
    else if (criteria.some((c) => !Number.isInteger(c.weight) || (c.weight as number) < 1)) p.push("Criterion weights must be positive whole numbers.")
    else {
      const total = criteria.reduce((sum, c) => sum + (c.weight as number), 0)
      if (total !== 100) p.push(`Criterion weights must total exactly 100 (they total ${total}).`)
    }
  }

  // payment
  const pay = terms.payment
  let total: bigint | null = null
  if (!pay) p.push("Payment terms are required.")
  else {
    if (!Number.isInteger(pay.chainId) || pay.chainId < 1) p.push("The payment chain id must be a positive whole number.")
    if (!pay.token || !isAddress(pay.token.address)) p.push("The payment token must be a valid address.")
    if (!pay.token || !nonBlank(pay.token.symbol, LIMITS.symbol)) p.push("The payment token needs a symbol.")
    if (!pay.token || !Number.isInteger(pay.token.decimals) || pay.token.decimals < 0 || pay.token.decimals > LIMITS.maxDecimals) p.push("The payment token's decimals must be a whole number from 0 to 36.")
    if (!isPositiveUint(pay.totalAmount)) p.push("The total amount must be a positive whole number of token base units (a decimal string).")
    else total = BigInt(pay.totalAmount)
    if (!pay.escrow || pay.escrow.fullAmountUpfront !== true) p.push("The full amount must be escrowed up front.")
    if (!pay.earlyAdvance || typeof pay.earlyAdvance.enabled !== "boolean" || pay.earlyAdvance.percent !== EARLY_ADVANCE_PERCENT) {
      p.push(`The early advance must state whether it is enabled and is fixed at ${EARLY_ADVANCE_PERCENT}%.`)
    }
  }

  // milestones: amounts, assignments, dates
  let sum = BigInt(0)
  let amountsOk = true
  const claimedDeliverables = new Map<string, number>()
  const claimedCriteria = new Map<string, number>()
  let previous: number | null = null
  for (const m of milestones) {
    if (!nonBlank(m.title, LIMITS.itemTitle)) p.push(`Milestone "${m.id}" needs a title.`)
    if (!nonBlank(m.description, LIMITS.itemDescription)) p.push(`Milestone "${m.id}" needs a description.`)
    if (!isPositiveUint(m.amount)) {
      p.push(`Milestone "${m.id}" needs a positive amount (a decimal string of base units).`)
      amountsOk = false
    } else sum += BigInt(m.amount)
    const dIds = Array.isArray(m.deliverableIds) ? m.deliverableIds : []
    const cIds = Array.isArray(m.criterionIds) ? m.criterionIds : []
    if (dIds.length < 1) p.push(`Milestone "${m.id}" needs at least one deliverable.`)
    if (cIds.length < 1) p.push(`Milestone "${m.id}" needs at least one acceptance criterion.`)
    for (const d of dIds) {
      if (!deliverableIds.has(d)) p.push(`Milestone "${m.id}" refers to an unknown deliverable "${d}".`)
      claimedDeliverables.set(d, (claimedDeliverables.get(d) ?? 0) + 1)
    }
    for (const c of cIds) {
      if (!criterionIds.has(c)) p.push(`Milestone "${m.id}" refers to an unknown criterion "${c}".`)
      claimedCriteria.set(c, (claimedCriteria.get(c) ?? 0) + 1)
    }
    if (!isIsoUtc(m.dueAt)) p.push(`Milestone "${m.id}" needs a due date in UTC (ISO-8601 ending in Z).`)
    else {
      const due = Date.parse(m.dueAt)
      if (previous !== null && due <= previous) p.push(`Milestone "${m.id}" must be due after the milestone before it.`)
      previous = due
    }
  }
  for (const d of deliverableIds) if ((claimedDeliverables.get(d) ?? 0) !== 1) p.push(`Deliverable "${d}" must belong to exactly one milestone.`)
  for (const c of criterionIds) if ((claimedCriteria.get(c) ?? 0) !== 1) p.push(`Criterion "${c}" must belong to exactly one milestone.`)
  if (total !== null && amountsOk && milestones.length > 0 && sum !== total) p.push(`Milestone amounts total ${sum.toString()} but the contract total is ${total.toString()}.`)

  // deadlines
  if (!isIsoUtc(terms.projectDeadline)) p.push("The project deadline must be a UTC time (ISO-8601 ending in Z).")
  else {
    const deadline = Date.parse(terms.projectDeadline)
    const last = milestones.length ? milestones[milestones.length - 1] : undefined
    if (last && isIsoUtc(last.dueAt) && Date.parse(last.dueAt) > deadline) p.push("No milestone may be due after the project deadline.")
    if (now !== undefined) {
      if (!isIsoUtc(now)) p.push("The current time given for validation isn't a valid UTC time.")
      else if (deadline <= Date.parse(now)) p.push("The project deadline must be in the future.")
      else if (milestones.length && isIsoUtc(milestones[0].dueAt) && Date.parse(milestones[0].dueAt) <= Date.parse(now)) p.push("The first milestone must be due in the future.")
    }
  }

  // legal terms
  const legal = terms.legalTerms
  if (!legal || typeof legal.version !== "string" || !LEGAL_VERSION_RE.test(legal.version)) p.push("A legal terms version is required (letters, digits, . _ - up to 64 characters).")
  if (legal && legal.contentHash !== null && !isBytes32(legal.contentHash)) p.push("The legal terms content hash must be a 32-byte hex value or null.")
  return p
}

// ---- canonical encoding and hash -----------------------------------------------------------------------------------------------

const normDate = (s: string) => {
  const t = Date.parse(s)
  return Number.isNaN(t) ? s : new Date(t).toISOString()
}

/**
 * The canonical text of the terms: fixed key order, no whitespace, arrays in their stated order, strings NFC-normalised and
 * trimmed, addresses lower-cased, instants normalised to `toISOString()`. Only contractual fields are included: never AI text,
 * signatures, status or timestamps of the record.
 */
export function canonicalTermsString(terms: AgreementTerms): string {
  return JSON.stringify({
    schema: "duely-work-agreement-terms",
    v: TERMS_ENCODING_VERSION,
    title: text(terms.title),
    scope: text(terms.scope),
    parties: { client: lower(terms.parties.client), freelancer: lower(terms.parties.freelancer) },
    deliverables: terms.deliverables.map((d) => ({ id: d.id, title: text(d.title), description: text(d.description) })),
    acceptanceCriteria: terms.acceptanceCriteria.map((c) => ({ id: c.id, text: text(c.text), mandatory: c.mandatory === true, weight: c.weight ?? null })),
    milestones: terms.milestones.map((m) => ({
      id: m.id,
      title: text(m.title),
      description: text(m.description),
      dueAt: normDate(m.dueAt),
      amount: m.amount,
      deliverableIds: [...m.deliverableIds],
      criterionIds: [...m.criterionIds],
    })),
    projectDeadline: normDate(terms.projectDeadline),
    payment: {
      chainId: terms.payment.chainId,
      token: { address: lower(terms.payment.token.address), symbol: text(terms.payment.token.symbol), decimals: terms.payment.token.decimals },
      totalAmount: terms.payment.totalAmount,
      escrowFullAmountUpfront: terms.payment.escrow.fullAmountUpfront === true,
      earlyAdvance: { enabled: terms.payment.earlyAdvance.enabled === true, percent: terms.payment.earlyAdvance.percent },
    },
    legalTerms: { version: terms.legalTerms.version, contentHash: terms.legalTerms.contentHash === null ? null : lower(terms.legalTerms.contentHash) },
  })
}

export function computeTermsHash(terms: AgreementTerms): Bytes32 {
  return keccak256(toBytes(canonicalTermsString(terms))) as Bytes32
}

// ---- what a party signs --------------------------------------------------------------------------------------------------------

/**
 * The exact EIP-191 text a party signs for THIS version and THESE terms. It names the agreement, version, terms hash, legal terms
 * version, chain, role and signer, so a signature can never be reused for another version, another party or other terms.
 * Returns null for a draft (there is nothing fixed to sign yet). Building this text signs nothing.
 */
export function buildSignatureMessage(agreement: Pick<WorkAgreement, "agreementId" | "version" | "termsHash" | "terms">, role: PartyRole): string | null {
  if (agreement.termsHash === null) return null
  const signer = lower(agreement.terms.parties[role])
  return [
    "Duely Work Agreement",
    `I agree to the terms of this agreement as its ${role}.`,
    "",
    `Agreement: ${agreement.agreementId}`,
    `Version: ${agreement.version}`,
    `Terms hash: ${lower(agreement.termsHash)}`,
    `Legal terms version: ${agreement.terms.legalTerms.version}`,
    `Chain ID: ${agreement.terms.payment.chainId}`,
    `Role: ${role}`,
    `Signer: ${signer}`,
    "",
    "Signing this message does not move funds and sends no transaction.",
  ].join("\n")
}

export const AGREEMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/
