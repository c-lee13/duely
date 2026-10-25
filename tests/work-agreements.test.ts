import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { computeCriteriaHash } from "@/lib/backend/criteria"
import {
  EARLY_ADVANCE_PERCENT,
  activateWithFunding,
  addAiDescription,
  adoptAiDescription,
  buildSignatureMessage,
  canEditTerms,
  canonicalTermsString,
  computeTermsHash,
  createDraft,
  deepFreeze,
  dismissAiDescription,
  isFullySigned,
  recordSignature,
  reviseAgreement,
  signatureFor,
  submitForSignatures,
  updateDraftTerms,
  validateAgreementInvariants,
  validateTerms,
  type AgreementResult,
  type AgreementTerms,
  type VerifiedEscrowFunding,
  type VerifiedSignature,
  type WorkAgreement,
} from "@/lib/agreements"

const CLIENT = "0x" + "a".repeat(40)
const FREELANCER = "0x" + "b".repeat(40)
const STRANGER = "0x" + "c".repeat(40)
const TOKEN = "0x" + "d".repeat(40)
const CONTRACT = "0x" + "e".repeat(40)
const T0 = "2026-11-01T12:00:00.000Z"
const T1 = "2026-11-01T12:05:00.000Z"
const T2 = "2026-11-01T12:10:00.000Z"
const T3 = "2026-11-01T12:20:00.000Z"
const SIG = "0x" + "1".repeat(130)

const terms = (over: Partial<AgreementTerms> = {}): AgreementTerms => ({
  title: "Landing page for Brightleaf",
  scope: "Design and build a responsive marketing landing page with a contact form, delivered as a Next.js project.",
  parties: { client: CLIENT as never, freelancer: FREELANCER as never },
  deliverables: [
    { id: "site", title: "Landing page", description: "Responsive page with hero, features and contact sections." },
    { id: "docs", title: "Handover notes", description: "README with setup and deployment steps." },
  ],
  acceptanceCriteria: [
    { id: "hero", text: "Includes a hero section with a headline and a button.", mandatory: true, weight: 40 },
    { id: "contact", text: "Includes a working contact form.", mandatory: true, weight: 40 },
    { id: "readme", text: "README explains how to run the project.", mandatory: false, weight: 20 },
  ],
  milestones: [
    { id: "m1", title: "Build", description: "Page and form.", dueAt: "2026-12-01T00:00:00.000Z", amount: "700", deliverableIds: ["site"], criterionIds: ["hero", "contact"] },
    { id: "m2", title: "Handover", description: "Docs.", dueAt: "2026-12-15T00:00:00.000Z", amount: "300", deliverableIds: ["docs"], criterionIds: ["readme"] },
  ],
  projectDeadline: "2026-12-20T00:00:00.000Z",
  payment: { chainId: 1440002, token: { address: TOKEN as never, symbol: "DEMO", decimals: 18 }, totalAmount: "1000", escrow: { fullAmountUpfront: true }, earlyAdvance: { enabled: true, percent: 90 } },
  legalTerms: { version: "duely-terms-2026-11", contentHash: null },
  ...over,
})

const must = <T>(r: AgreementResult<T>): T => {
  assert.ok(r.ok, r.ok ? "" : `${r.error.code}: ${r.error.message} ${r.error.problems.join(" | ")}`)
  return r.value
}
const code = (r: AgreementResult<unknown>) => {
  assert.ok(!r.ok, "expected an error")
  return r.error.code
}

const draft = (t = terms()) => must(createDraft({ agreementId: "agr-1", terms: t, createdBy: CLIENT as never, now: T0 }))
const awaiting = (t = terms()) => must(submitForSignatures(draft(t), CLIENT as never, T0))
const sigFor = (a: WorkAgreement, role: "client" | "freelancer", over: Partial<VerifiedSignature> = {}): VerifiedSignature => ({
  role,
  signer: (role === "client" ? CLIENT : FREELANCER) as never,
  message: buildSignatureMessage(a, role) as string,
  signature: SIG as never,
  verifiedAt: T1,
  ...over,
})
const signedBy = (a: WorkAgreement, ...roles: Array<"client" | "freelancer">) => roles.reduce((acc, r) => must(recordSignature(acc, sigFor(acc, r), T1)), a)
const fullySigned = (t = terms()) => signedBy(awaiting(t), "client", "freelancer")
const fundingFor = (a: WorkAgreement, over: Partial<VerifiedEscrowFunding> = {}): VerifiedEscrowFunding => ({
  source: "chain",
  chainId: a.terms.payment.chainId,
  contract: CONTRACT as never,
  invoiceId: "42",
  token: a.terms.payment.token.address,
  client: a.terms.parties.client,
  freelancer: a.terms.parties.freelancer,
  amount: a.terms.payment.totalAmount,
  criteriaHash: computeCriteriaHash(a.terms.acceptanceCriteria),
  onchainStatus: "Funded",
  blockNumber: "123456",
  readAt: T2,
  ...over,
})
const active = (t = terms()) => {
  const a = fullySigned(t)
  return must(activateWithFunding(a, fundingFor(a), T3))
}
const ai = { id: "ai-1", kind: "scope_suggestion" as const, text: "A friendlier scope written by a model.", model: "gemini-test", promptVersion: "v1", generatedAt: T0 }

// ================================================================================================================================

describe("terms validation", () => {
  it("accepts a complete, consistent set of terms", () => {
    assert.deepEqual(validateTerms(terms(), T0), [])
  })

  const bad = (label: string, t: AgreementTerms, re: RegExp, now: string | undefined = T0) =>
    it(label, () => {
      const problems = validateTerms(t, now)
      assert.ok(problems.some((p) => re.test(p)), `${re} not found in: ${problems.join(" | ")}`)
    })

  bad("rejects the same wallet as both parties", terms({ parties: { client: CLIENT as never, freelancer: CLIENT.toUpperCase().replace("0X", "0x") as never } }), /different wallets/)
  bad("rejects a malformed party address", terms({ parties: { client: "0x123" as never, freelancer: FREELANCER as never } }), /client must be a valid wallet/)
  bad("requires a scope", terms({ scope: "   " }), /scope of work is required/)
  bad("requires a title", terms({ title: "" }), /title is required/)
  bad("requires deliverables", terms({ deliverables: [] }), /deliverables are required/)
  bad("requires acceptance criteria", terms({ acceptanceCriteria: [] }), /acceptance criteria are required/)
  bad("requires milestones", terms({ milestones: [] }), /milestones are required/)
  bad("rejects duplicate ids", terms({ deliverables: [{ id: "site", title: "a", description: "b" }, { id: "site", title: "c", description: "d" }] }), /"site" is used more than once/)
  bad("rejects ids with unsafe characters", terms({ acceptanceCriteria: [{ id: "Bad Id!", text: "x", mandatory: true }] }), /invalid/)

  bad("requires every deliverable to be in exactly one milestone", terms({ milestones: [terms().milestones[0], { ...terms().milestones[1], deliverableIds: ["site", "docs"] }] }), /Deliverable "site" must belong to exactly one milestone/)
  bad("rejects a deliverable no milestone covers", terms({ milestones: [{ ...terms().milestones[0], deliverableIds: ["site"] }, { ...terms().milestones[1], deliverableIds: ["site"] }] }), /Deliverable "docs" must belong to exactly one milestone/)
  bad("rejects a criterion no milestone covers", terms({ milestones: [{ ...terms().milestones[0], criterionIds: ["hero"] }, terms().milestones[1]] }), /Criterion "contact" must belong to exactly one milestone/)
  bad("rejects a milestone referring to something that doesn't exist", terms({ milestones: [{ ...terms().milestones[0], criterionIds: ["hero", "contact", "ghost"] }, terms().milestones[1]] }), /unknown criterion "ghost"/)
  bad("every milestone needs a deliverable and a criterion", terms({ milestones: [terms().milestones[0], { ...terms().milestones[1], deliverableIds: [], criterionIds: [] }] }), /needs at least one deliverable/)

  bad("milestone amounts must add up to the total exactly", terms({ milestones: [{ ...terms().milestones[0], amount: "701" }, terms().milestones[1]] }), /total 1001 but the contract total is 1000/)
  bad("amounts must be plain decimal strings (no leading zeros)", terms({ payment: { ...terms().payment, totalAmount: "01000" } }), /positive whole number/)
  bad("amounts can't be negative, fractional or non-numeric", terms({ payment: { ...terms().payment, totalAmount: "-5" } }), /positive whole number/)
  bad("amounts can't be fractional", terms({ milestones: [{ ...terms().milestones[0], amount: "700.5" }, terms().milestones[1]] }), /needs a positive amount/)
  bad("amounts can't be zero", terms({ milestones: [{ ...terms().milestones[0], amount: "0" }, terms().milestones[1]] }), /needs a positive amount/)
  bad("amounts can't exceed uint256", terms({ payment: { ...terms().payment, totalAmount: "1" + "0".repeat(78) } }), /positive whole number/)
  bad("the early advance is fixed by platform policy", terms({ payment: { ...terms().payment, earlyAdvance: { enabled: true, percent: 80 as never } } }), new RegExp(`fixed at ${EARLY_ADVANCE_PERCENT}%`))
  bad("escrow must cover the full amount up front", terms({ payment: { ...terms().payment, escrow: { fullAmountUpfront: false as never } } }), /escrowed in full|escrowed up front/)
  bad("the token needs a valid address, symbol and decimals", terms({ payment: { ...terms().payment, token: { address: "nope" as never, symbol: "", decimals: 99 } } }), /token must be a valid address/)

  bad("weights are all-or-none", terms({ acceptanceCriteria: [{ id: "a", text: "x", mandatory: true, weight: 100 }, { id: "b", text: "y", mandatory: false }] }), /every criterion has a weight or none/)
  bad("weights must total 100", terms({ acceptanceCriteria: [{ id: "hero", text: "x", mandatory: true, weight: 40 }, { id: "contact", text: "y", mandatory: true, weight: 40 }, { id: "readme", text: "z", mandatory: false, weight: 10 }] }), /total exactly 100 \(they total 90\)/)
  bad("weights must be positive whole numbers", terms({ acceptanceCriteria: [{ id: "hero", text: "x", mandatory: true, weight: 50.5 }, { id: "contact", text: "y", mandatory: true, weight: 49.5 }, { id: "readme", text: "z", mandatory: false, weight: 0 }] }), /positive whole numbers/)

  bad("milestone dates must increase", terms({ milestones: [{ ...terms().milestones[0], dueAt: "2026-12-15T00:00:00.000Z" }, { ...terms().milestones[1], dueAt: "2026-12-01T00:00:00.000Z" }] }), /due after the milestone before it/)
  bad("no milestone may be due after the project deadline", terms({ projectDeadline: "2026-12-10T00:00:00.000Z" }), /after the project deadline/)
  bad("dates must be UTC ISO-8601", terms({ projectDeadline: "2026-12-20" }), /project deadline must be a UTC time/)
  bad("impossible dates are rejected", terms({ projectDeadline: "2026-02-31T00:00:00.000Z" }), /project deadline must be a UTC time/)
  bad("a deadline in the past is rejected when submitting", terms(), /deadline must be in the future/, "2027-01-01T00:00:00.000Z")
  bad("the first milestone must still be in the future", terms(), /first milestone must be due in the future/, "2026-12-02T00:00:00.000Z")

  bad("requires a legal terms version", terms({ legalTerms: { version: "", contentHash: null } }), /legal terms version is required/)
  bad("the legal content hash must be 32 bytes or null", terms({ legalTerms: { version: "v1", contentHash: "0x12" as never } }), /content hash/)

  bad("rejects any field outside the contractual terms (nowhere for AI text to hide)", { ...terms(), aiSummary: "model-written text" } as unknown as AgreementTerms, /Unknown field "aiSummary"/)
})

describe("canonical terms and their hash", () => {
  it("is deterministic and a 32-byte hash", () => {
    const h = computeTermsHash(terms())
    assert.match(h, /^0x[0-9a-f]{64}$/)
    assert.equal(computeTermsHash(terms()), h)
    assert.equal(computeTermsHash(JSON.parse(JSON.stringify(terms()))), h)
  })

  it("does not depend on object key order, address case, surrounding whitespace or Unicode form", () => {
    const base = computeTermsHash(terms())
    const reordered = terms()
    const shuffled = { legalTerms: reordered.legalTerms, payment: reordered.payment, projectDeadline: reordered.projectDeadline, milestones: reordered.milestones, acceptanceCriteria: reordered.acceptanceCriteria, deliverables: reordered.deliverables, parties: reordered.parties, scope: reordered.scope, title: reordered.title }
    assert.equal(computeTermsHash(shuffled as AgreementTerms), base)
    assert.equal(computeTermsHash(terms({ parties: { client: CLIENT.toUpperCase().replace("0X", "0x") as never, freelancer: FREELANCER as never } })), base)
    assert.equal(computeTermsHash(terms({ title: "  Landing page for Brightleaf \n" })), base)
    assert.equal(computeTermsHash(terms({ title: "Café", scope: terms().scope })), computeTermsHash(terms({ title: "Café" })))
    assert.equal(computeTermsHash(terms({ projectDeadline: "2026-12-20T00:00:00Z" })), base, "equivalent instants hash the same")
  })

  it("changes when ANY contractual term changes", () => {
    const base = computeTermsHash(terms())
    const t = terms()
    const variants: Array<[string, AgreementTerms]> = [
      ["title", terms({ title: "Other" })],
      ["scope", terms({ scope: t.scope + "!" })],
      ["freelancer", terms({ parties: { client: CLIENT as never, freelancer: STRANGER as never } })],
      ["deliverable text", terms({ deliverables: [{ ...t.deliverables[0], description: "different" }, t.deliverables[1]] })],
      ["criterion text", terms({ acceptanceCriteria: [{ ...t.acceptanceCriteria[0], text: "changed" }, ...t.acceptanceCriteria.slice(1)] })],
      ["criterion mandatory", terms({ acceptanceCriteria: [{ ...t.acceptanceCriteria[0], mandatory: false }, ...t.acceptanceCriteria.slice(1)] })],
      ["criterion weight", terms({ acceptanceCriteria: [{ ...t.acceptanceCriteria[0], weight: 30 }, { ...t.acceptanceCriteria[1], weight: 50 }, t.acceptanceCriteria[2]] })],
      ["milestone date", terms({ milestones: [{ ...t.milestones[0], dueAt: "2026-12-02T00:00:00.000Z" }, t.milestones[1]] })],
      ["milestone split", terms({ milestones: [{ ...t.milestones[0], amount: "600" }, { ...t.milestones[1], amount: "400" }] })],
      ["deadline", terms({ projectDeadline: "2026-12-21T00:00:00.000Z" })],
      ["total", terms({ payment: { ...t.payment, totalAmount: "1001" }, milestones: [{ ...t.milestones[0], amount: "701" }, t.milestones[1]] })],
      ["token", terms({ payment: { ...t.payment, token: { ...t.payment.token, address: STRANGER as never } } })],
      ["chain", terms({ payment: { ...t.payment, chainId: 1 } })],
      ["advance", terms({ payment: { ...t.payment, earlyAdvance: { enabled: false, percent: 90 } } })],
      ["legal version", terms({ legalTerms: { version: "duely-terms-2027-01", contentHash: null } })],
      ["legal content", terms({ legalTerms: { version: t.legalTerms.version, contentHash: ("0x" + "9".repeat(64)) as never } })],
      ["milestone order", terms({ milestones: [t.milestones[1], t.milestones[0]] })],
    ]
    const seen = new Set([base])
    for (const [label, v] of variants) {
      const h = computeTermsHash(v)
      assert.ok(!seen.has(h), `changing the ${label} must change the hash`)
      seen.add(h)
    }
  })

  it("contains only contractual fields", () => {
    const s = canonicalTermsString(terms())
    for (const never of ["status", "signature", "aiDescriptions", "updatedAt", "model", "promptVersion"]) assert.ok(!s.includes(never), never)
    assert.match(s, /"schema":"duely-work-agreement-terms","v":1/)
  })
})

describe("draft -> awaiting_signatures", () => {
  it("starts as version 1 in draft with no hash, signatures or funding", () => {
    const a = draft()
    assert.equal(a.status, "draft")
    assert.equal(a.version, 1)
    assert.equal(a.termsHash, null)
    assert.equal(a.supersedes, null)
    assert.deepEqual(a.signatures, [])
    assert.equal(a.funding, null)
    assert.equal(a.events[0].type, "created")
    assert.ok(canEditTerms(a))
  })

  it("only a party can start one, and the parties must be valid and different", () => {
    assert.equal(code(createDraft({ agreementId: "x", terms: terms(), createdBy: STRANGER as never, now: T0 })), "NOT_A_PARTY")
    assert.equal(code(createDraft({ agreementId: "x", terms: terms({ parties: { client: CLIENT as never, freelancer: CLIENT as never } }), createdBy: CLIENT as never, now: T0 })), "INVALID_TERMS")
    assert.equal(code(createDraft({ agreementId: "bad id!", terms: terms(), createdBy: CLIENT as never, now: T0 })), "INVALID_INPUT")
    assert.equal(code(createDraft({ agreementId: "x", terms: terms(), createdBy: CLIENT as never, now: "yesterday" })), "INVALID_INPUT")
    assert.equal(code(createDraft({ agreementId: "x", terms: { ...terms(), aiSummary: "x" } as never, createdBy: CLIENT as never, now: T0 })), "INVALID_TERMS")
  })

  it("a draft may be incomplete and is edited in place", () => {
    const a = draft(terms({ scope: "", deliverables: [] }))
    const b = must(updateDraftTerms(a, { scope: "Now written.", deliverables: terms().deliverables }, FREELANCER as never, T1))
    assert.equal(b.terms.scope, "Now written.")
    assert.equal(b.version, 1)
    assert.equal(b.updatedAt, T1)
    assert.equal(code(updateDraftTerms(a, { scope: "x" }, STRANGER as never, T1)), "NOT_A_PARTY")
    assert.equal(code(updateDraftTerms(a, { parties: { client: CLIENT as never, freelancer: CLIENT as never } }, CLIENT as never, T1)), "INVALID_TERMS", "the same wallet can't be both parties")
  })

  it("a draft can't be edited so that the editor is no longer a party", () => {
    assert.equal(code(updateDraftTerms(draft(), { parties: { client: STRANGER as never, freelancer: FREELANCER as never } }, CLIENT as never, T1)), "NOT_A_PARTY")
  })

  it("submitting runs every rule, then freezes the terms with their hash", () => {
    assert.equal(code(submitForSignatures(draft(terms({ scope: "" })), CLIENT as never, T0)), "INVALID_TERMS")
    const a = awaiting()
    assert.equal(a.status, "awaiting_signatures")
    assert.equal(a.termsHash, computeTermsHash(a.terms))
    assert.equal(a.events.at(-1)?.type, "submitted")
    assert.equal(canEditTerms(a), false)
    assert.deepEqual(a.signatures, [])
  })

  it("lists every problem when terms aren't ready", () => {
    const r = submitForSignatures(draft(terms({ scope: "", deliverables: [], projectDeadline: "soon" })), CLIENT as never, T0)
    assert.ok(!r.ok)
    assert.ok(r.error.problems.length >= 3)
  })

  it("only a party can submit, and only from draft", () => {
    assert.equal(code(submitForSignatures(draft(), STRANGER as never, T0)), "NOT_A_PARTY")
    assert.equal(code(submitForSignatures(awaiting(), CLIENT as never, T0)), "INVALID_TRANSITION")
  })
})

describe("signed terms are frozen", () => {
  it("terms can't be edited once submitted, signed or active", () => {
    for (const a of [awaiting(), signedBy(awaiting(), "client"), fullySigned(), active()]) {
      assert.equal(code(updateDraftTerms(a, { title: "Sneaky change" }, CLIENT as never, T3)), "TERMS_FROZEN", a.status)
      assert.equal(code(adoptAiDescription(must(addAiDescription(a, ai, T3)), { id: "ai-1", target: { field: "scope" }, by: CLIENT as never }, T3)), "TERMS_FROZEN", a.status)
    }
  })

  it("results are deep-frozen, so a stored agreement can't be edited in place", () => {
    const a = awaiting()
    assert.throws(() => ((a.terms as { title: string }).title = "x"))
    assert.throws(() => (a.signatures as unknown as unknown[]).push({}))
    assert.throws(() => ((a as { status: string }).status = "active"))
    assert.throws(() => ((a.terms.milestones[0] as { amount: string }).amount = "1"))
  })

  it("no transition mutates its input", () => {
    const a = deepFreeze(awaiting())
    const before = JSON.stringify(a)
    must(recordSignature(a, sigFor(a, "client"), T1))
    reviseAgreement(a, { title: "New" }, CLIENT as never, T1)
    addAiDescription(a, ai, T1)
    assert.equal(JSON.stringify(a), before)
  })
})

describe("signatures", () => {
  it("each party signs explicitly, in either order, and the second signature moves it to signed_awaiting_funding", () => {
    for (const order of [["client", "freelancer"], ["freelancer", "client"]] as const) {
      const a0 = awaiting()
      const a1 = must(recordSignature(a0, sigFor(a0, order[0]), T1))
      assert.equal(a1.status, "awaiting_signatures")
      assert.equal(a1.signatures.length, 1)
      assert.equal(isFullySigned(a1), false)
      const a2 = must(recordSignature(a1, sigFor(a1, order[1]), T2))
      assert.equal(a2.status, "signed_awaiting_funding")
      assert.ok(isFullySigned(a2))
      assert.deepEqual(a2.events.map((e) => e.type).slice(-2), ["signed", "fully_signed"])
    }
  })

  it("the stored record is explicit about who signed what, bound to version and hash", () => {
    const a = fullySigned()
    for (const role of ["client", "freelancer"] as const) {
      const s = signatureFor(a, role)!
      assert.equal(s.role, role)
      assert.equal(s.signer, (role === "client" ? CLIENT : FREELANCER).toLowerCase())
      assert.equal(s.agreementId, "agr-1")
      assert.equal(s.version, 1)
      assert.equal(s.termsHash, a.termsHash)
      assert.equal(s.legalTermsVersion, "duely-terms-2026-11")
      assert.equal(s.method, "eip191")
      assert.equal(s.message, buildSignatureMessage(a, role))
    }
  })

  it("the signing text names the agreement, version, terms hash, legal version, chain, role and signer and says it moves no funds", () => {
    const a = awaiting()
    const m = buildSignatureMessage(a, "client")!
    for (const part of ["Agreement: agr-1", "Version: 1", `Terms hash: ${a.termsHash}`, "Legal terms version: duely-terms-2026-11", "Chain ID: 1440002", "Role: client", `Signer: ${CLIENT}`, "does not move funds"]) assert.ok(m.includes(part), part)
    assert.notEqual(m, buildSignatureMessage(a, "freelancer"))
    assert.equal(buildSignatureMessage(draft(), "client"), null, "nothing to sign for a draft")
  })

  it("rejects a signature before the agreement is submitted", () => {
    const d = draft()
    assert.equal(code(recordSignature(d, { role: "client", signer: CLIENT as never, message: "anything", signature: SIG as never, verifiedAt: T1 }, T1)), "INVALID_TRANSITION")
  })

  it("rejects a signer who isn't the party for that role", () => {
    const a = awaiting()
    assert.equal(code(recordSignature(a, sigFor(a, "client", { signer: STRANGER as never }), T1)), "NOT_A_PARTY")
    assert.equal(code(recordSignature(a, sigFor(a, "client", { signer: FREELANCER as never }), T1)), "NOT_A_PARTY", "the freelancer can't sign as the client")
    assert.equal(code(recordSignature(a, sigFor(a, "freelancer", { signer: CLIENT as never }), T1)), "NOT_A_PARTY")
  })

  it("rejects a malformed signature or verification time", () => {
    const a = awaiting()
    for (const signature of ["0x12", "nope", "0x" + "z".repeat(130), SIG + "00"]) assert.equal(code(recordSignature(a, sigFor(a, "client", { signature: signature as never }), T1)), "INVALID_SIGNATURE", signature)
    assert.equal(code(recordSignature(a, sigFor(a, "client", { verifiedAt: "yesterday" }), T1)), "INVALID_SIGNATURE")
    assert.equal(code(recordSignature(a, { ...sigFor(a, "client"), role: "admin" as never }, T1)), "INVALID_INPUT")
  })

  it("rejects a second signature from the same role", () => {
    const a = signedBy(awaiting(), "client")
    assert.equal(code(recordSignature(a, sigFor(a, "client"), T2)), "ALREADY_SIGNED")
  })

  it("rejects a signature over the wrong text: another version, other terms, another agreement, or the other role", () => {
    const a = awaiting()
    const m = buildSignatureMessage(a, "client")!
    for (const wrong of [m.replace("Version: 1", "Version: 2"), m.replace(a.termsHash!, "0x" + "0".repeat(64)), m.replace("agr-1", "agr-2"), buildSignatureMessage(a, "freelancer")!, m.replace("Chain ID: 1440002", "Chain ID: 1"), m + " ", ""]) {
      assert.equal(code(recordSignature(a, sigFor(a, "client", { message: wrong }), T1)), "WRONG_MESSAGE")
    }
  })

  it("a signature for an old version can never be applied to the new one", () => {
    const v1 = fullySigned()
    const v2 = must(submitForSignatures(must(reviseAgreement(v1, { title: "Revised title" }, CLIENT as never, T2)), CLIENT as never, T2))
    assert.equal(code(recordSignature(v2, { ...signatureFor(v1, "client")! }, T3)), "WRONG_MESSAGE")
    assert.equal(code(recordSignature(v2, sigFor(v1, "client"), T3)), "WRONG_MESSAGE")
  })

  it("no more signatures once both have signed", () => {
    for (const a of [fullySigned(), active()]) assert.equal(code(recordSignature(a, sigFor(a, "client"), T3)), "INVALID_TRANSITION")
  })
})

describe("activation needs both signatures AND verified funding", () => {
  it("activates with both signatures on this version and matching on-chain funding", () => {
    const signed = fullySigned()
    const a = must(activateWithFunding(signed, fundingFor(signed), T3))
    assert.equal(a.status, "active")
    assert.equal(a.funding?.onchainStatus, "Funded")
    assert.equal(a.funding?.amount, "1000")
    assert.equal(a.events.at(-1)?.type, "activated")
    assert.equal(a.version, 1)
    assert.deepEqual(validateAgreementInvariants(a), [])
  })

  it("can't activate with no signatures, one signature, or from draft", () => {
    for (const a of [draft(), awaiting(), signedBy(awaiting(), "client"), signedBy(awaiting(), "freelancer")]) {
      assert.equal(code(activateWithFunding(a, fundingFor(a), T3)), "INVALID_TRANSITION", a.status)
    }
  })

  it("can't activate twice", () => {
    const a = active()
    assert.equal(code(activateWithFunding(a, fundingFor(a), T3)), "INVALID_TRANSITION")
  })

  it("funding must be read from the chain and be in the Funded state", () => {
    const a = fullySigned()
    assert.equal(code(activateWithFunding(a, fundingFor(a, { source: "database" as never }), T3)), "FUNDING_NOT_VERIFIED")
    for (const status of ["Created", "Advanced", "Disputed", "Settled"] as const) assert.equal(code(activateWithFunding(a, fundingFor(a, { onchainStatus: status }), T3)), "FUNDING_NOT_VERIFIED", status)
    assert.equal(code(activateWithFunding(a, undefined as never, T3)), "FUNDING_NOT_VERIFIED")
    assert.equal(code(activateWithFunding(a, null as never, T3)), "FUNDING_NOT_VERIFIED")
  })

  it("the funding must match the agreement exactly", () => {
    const a = fullySigned()
    const cases: Array<[string, Partial<VerifiedEscrowFunding>, RegExp]> = [
      ["amount one too low", { amount: "999" }, /isn't exactly the agreed total/],
      ["amount one too high", { amount: "1001" }, /isn't exactly the agreed total/],
      ["amount with a leading zero", { amount: "01000" }, /isn't exactly the agreed total/],
      ["different chain", { chainId: 1 }, /different chain/],
      ["different token", { token: STRANGER as never }, /different token/],
      ["different client", { client: STRANGER as never }, /client isn't the agreement's client/],
      ["different freelancer", { freelancer: STRANGER as never }, /freelancer isn't the agreement's freelancer/],
      ["different criteria on-chain", { criteriaHash: ("0x" + "7".repeat(64)) as never }, /different acceptance criteria/],
      ["bad invoice id", { invoiceId: "abc" }, /invoice id is invalid/],
      ["bad block number", { blockNumber: "-1" }, /block number is invalid/],
      ["bad contract address", { contract: "0x1" as never }, /contract address is invalid/],
    ]
    for (const [label, over, re] of cases) {
      const r = activateWithFunding(a, fundingFor(a, over), T3)
      assert.ok(!r.ok && r.error.code === "FUNDING_MISMATCH" && r.error.problems.some((p) => re.test(p)), `${label}: ${JSON.stringify(r)}`)
    }
  })

  it("funding addresses are compared case-insensitively", () => {
    const a = fullySigned()
    const f = fundingFor(a, { client: CLIENT.toUpperCase().replace("0X", "0x") as never, token: TOKEN.toUpperCase().replace("0X", "0x") as never })
    assert.equal(must(activateWithFunding(a, f, T3)).status, "active")
  })

  it("evidence read before the last signature is stale", () => {
    const a = fullySigned()
    assert.equal(code(activateWithFunding(a, fundingFor(a, { readAt: "2026-11-01T11:00:00.000Z" }), T3)), "STALE_FUNDING_EVIDENCE")
  })

  it("an older version can't activate once a newer one exists", () => {
    const a = fullySigned()
    assert.equal(code(activateWithFunding(a, fundingFor(a), T3, { latestVersion: 2 })), "SUPERSEDED")
    assert.equal(must(activateWithFunding(a, fundingFor(a), T3, { latestVersion: 1 })).status, "active")
  })

  it("the funding is bound to the criteria in the agreement's own terms: escrow created for other criteria can't activate it", () => {
    const v1 = fullySigned()
    assert.equal(fundingFor(v1).criteriaHash, computeCriteriaHash(v1.terms.acceptanceCriteria))
    const changed = terms().acceptanceCriteria.map((c, i) => (i === 0 ? { ...c, text: "A different first criterion." } : c))
    const v2d = must(reviseAgreement(v1, { acceptanceCriteria: changed }, CLIENT as never, T2))
    const v2 = must(submitForSignatures(v2d, CLIENT as never, T2))
    const signed = signedBy(must(recordSignature(v2, sigFor(v2, "client", { verifiedAt: T2 }), T2)), "freelancer")
    const stale = activateWithFunding(signed, fundingFor(v1, { readAt: T3 }), T3)
    assert.ok(!stale.ok && stale.error.code === "FUNDING_MISMATCH" && stale.error.problems.some((p) => /different acceptance criteria/.test(p)))
    assert.equal(must(activateWithFunding(signed, fundingFor(signed, { readAt: T3 }), T3)).status, "active")
  })

  it("a failed activation leaves the agreement exactly as it was", () => {
    const a = fullySigned()
    const before = JSON.stringify(a)
    activateWithFunding(a, fundingFor(a, { amount: "1" }), T3)
    assert.equal(JSON.stringify(a), before)
    assert.equal(a.status, "signed_awaiting_funding")
  })
})

describe("changes to signed terms need a new version", () => {
  it("revising creates the next version as a draft, with no signatures or funding carried over", () => {
    for (const a of [awaiting(), signedBy(awaiting(), "client"), fullySigned(), active()]) {
      const v2 = must(reviseAgreement(a, { projectDeadline: "2026-12-30T00:00:00.000Z" }, FREELANCER as never, T3))
      assert.equal(v2.agreementId, a.agreementId)
      assert.equal(v2.version, 2)
      assert.equal(v2.status, "draft")
      assert.equal(v2.termsHash, null)
      assert.deepEqual(v2.signatures, [])
      assert.equal(v2.funding, null)
      assert.deepEqual(v2.supersedes, { version: 1, termsHash: a.termsHash })
      assert.equal(v2.terms.projectDeadline, "2026-12-30T00:00:00.000Z")
      assert.equal(v2.events.at(-1)?.type, "revised")
    }
  })

  it("the earlier version is left exactly as it was", () => {
    const v1 = active()
    const before = JSON.stringify(v1)
    must(reviseAgreement(v1, { title: "Changed" }, CLIENT as never, T3))
    assert.equal(JSON.stringify(v1), before)
    assert.equal(v1.status, "active")
    assert.equal(v1.terms.title, "Landing page for Brightleaf")
  })

  it("the new version must be re-signed by both parties before it can be funded and activated", () => {
    const v1 = active()
    const v2 = must(submitForSignatures(must(reviseAgreement(v1, { title: "Changed" }, CLIENT as never, T3)), CLIENT as never, T3))
    assert.equal(code(activateWithFunding(v2, fundingFor(v2), T3)), "INVALID_TRANSITION")
    const one = must(recordSignature(v2, sigFor(v2, "client", { verifiedAt: T3 }), T3))
    assert.equal(code(activateWithFunding(one, fundingFor(one), T3)), "INVALID_TRANSITION")
    const both = must(recordSignature(one, sigFor(one, "freelancer", { verifiedAt: T3 }), T3))
    assert.equal(must(activateWithFunding(both, fundingFor(both, { readAt: T3 }), T3)).version, 2)
  })

  it("a revision that changes nothing is refused", () => {
    const a = awaiting()
    assert.equal(code(reviseAgreement(a, {}, CLIENT as never, T1)), "NO_CHANGES")
    assert.equal(code(reviseAgreement(a, { title: "  Landing page for Brightleaf  " }, CLIENT as never, T1)), "NO_CHANGES")
  })

  it("a draft is edited directly, and only a party can revise", () => {
    assert.equal(code(reviseAgreement(draft(), { title: "x" }, CLIENT as never, T1)), "INVALID_TRANSITION")
    assert.equal(code(reviseAgreement(awaiting(), { title: "x" }, STRANGER as never, T1)), "NOT_A_PARTY")
    assert.equal(code(reviseAgreement(awaiting(), { parties: { client: STRANGER as never, freelancer: FREELANCER as never } }, CLIENT as never, T1)), "NOT_A_PARTY")
  })

  it("versions chain: each supersedes the one before", () => {
    const v1 = awaiting()
    const v2 = must(reviseAgreement(v1, { title: "Two" }, CLIENT as never, T1))
    const v3 = must(reviseAgreement(must(submitForSignatures(v2, CLIENT as never, T1)), { title: "Three" }, CLIENT as never, T2))
    assert.deepEqual([v1.version, v2.version, v3.version], [1, 2, 3])
    assert.equal(v3.supersedes?.version, 2)
    assert.equal(v3.supersedes?.termsHash, computeTermsHash(v2.terms))
  })
})

describe("AI-written descriptions stay separate from agreed terms", () => {
  it("can be attached at any status without changing the terms, hash, version, signatures or status", () => {
    for (const a of [draft(), awaiting(), signedBy(awaiting(), "client"), fullySigned(), active()]) {
      const b = must(addAiDescription(a, ai, T3))
      assert.equal(b.status, a.status)
      assert.equal(b.version, a.version)
      assert.equal(b.termsHash, a.termsHash)
      assert.deepEqual(b.terms, a.terms)
      assert.deepEqual(b.signatures, a.signatures)
      assert.equal(b.aiDescriptions.length, 1)
      assert.equal(b.aiDescriptions[0].nonBinding, true)
      assert.equal(b.aiDescriptions[0].status, "suggestion")
    }
  })

  it("never enters the terms hash or the signed text", () => {
    const a = awaiting()
    const b = must(addAiDescription(a, { ...ai, text: "UNIQUE-AI-TEXT-12345" }, T1))
    assert.equal(computeTermsHash(b.terms), a.termsHash)
    assert.ok(!canonicalTermsString(b.terms).includes("UNIQUE-AI-TEXT-12345"))
    assert.ok(!buildSignatureMessage(b, "client")!.includes("UNIQUE-AI-TEXT-12345"))
    assert.equal(buildSignatureMessage(b, "client"), buildSignatureMessage(a, "client"))
  })

  it("signatures stay valid after AI text is added or dismissed", () => {
    const a = signedBy(awaiting(), "client")
    const b = must(dismissAiDescription(must(addAiDescription(a, ai, T2)), "ai-1", T3))
    assert.equal(b.status, "awaiting_signatures")
    assert.equal(signatureFor(b, "client")?.message, buildSignatureMessage(b, "client"))
    assert.deepEqual(validateAgreementInvariants(b), [])
  })

  it("is always recorded with its model, prompt version and time, and validated", () => {
    const a = must(addAiDescription(draft(), ai, T1))
    assert.deepEqual(a.aiDescriptions[0], { ...ai, nonBinding: true, status: "suggestion" })
    const a0 = draft()
    for (const bad of [{ ...ai, id: "" }, { ...ai, kind: "legal_advice" as never }, { ...ai, text: "  " }, { ...ai, text: "x".repeat(5001) }, { ...ai, model: "" }, { ...ai, promptVersion: "" }, { ...ai, generatedAt: "now" }]) {
      assert.equal(code(addAiDescription(a0, bad, T1)), "INVALID_INPUT")
    }
    assert.equal(code(addAiDescription(a, ai, T1)), "INVALID_INPUT", "duplicate id")
  })

  it("only becomes a term when a party explicitly adopts it into a draft, verbatim, and that is recorded", () => {
    const d = must(addAiDescription(draft(), { ...ai, text: "AI scope text." }, T1))
    assert.equal(d.terms.scope.includes("AI scope text."), false)
    const adopted = must(adoptAiDescription(d, { id: "ai-1", target: { field: "scope" }, by: FREELANCER as never }, T2))
    assert.equal(adopted.terms.scope, "AI scope text.")
    assert.equal(adopted.aiDescriptions[0].status, "adopted")
    assert.deepEqual(adopted.aiDescriptions[0].adopted, { target: { field: "scope" }, by: FREELANCER.toLowerCase(), at: T2 })
    assert.notEqual(computeTermsHash({ ...d.terms, scope: "x".repeat(30) }), computeTermsHash(adopted.terms))
  })

  it("can be adopted into the title, a deliverable, a milestone or a criterion", () => {
    const base = must(addAiDescription(draft(), { ...ai, text: "Adopted text" }, T1))
    const cases: Array<[Parameters<typeof adoptAiDescription>[1]["target"], (a: WorkAgreement) => string]> = [
      [{ field: "title" }, (a) => a.terms.title],
      [{ field: "deliverable", id: "docs" }, (a) => a.terms.deliverables[1].description],
      [{ field: "milestone", id: "m1" }, (a) => a.terms.milestones[0].description],
      [{ field: "criterion", id: "hero" }, (a) => a.terms.acceptanceCriteria[0].text],
    ]
    for (const [target, read] of cases) assert.equal(read(must(adoptAiDescription(base, { id: "ai-1", target, by: CLIENT as never }, T2))), "Adopted text")
  })

  it("adoption is refused for non-parties, unknown targets, unknown or already-handled descriptions", () => {
    const d = must(addAiDescription(draft(), ai, T1))
    assert.equal(code(adoptAiDescription(d, { id: "ai-1", target: { field: "scope" }, by: STRANGER as never }, T2)), "NOT_A_PARTY")
    assert.equal(code(adoptAiDescription(d, { id: "nope", target: { field: "scope" }, by: CLIENT as never }, T2)), "UNKNOWN_AI_DESCRIPTION")
    assert.equal(code(adoptAiDescription(d, { id: "ai-1", target: { field: "criterion", id: "ghost" }, by: CLIENT as never }, T2)), "INVALID_INPUT")
    assert.equal(code(adoptAiDescription(d, { id: "ai-1", target: { field: "bogus" } as never, by: CLIENT as never }, T2)), "INVALID_INPUT")
    const once = must(adoptAiDescription(d, { id: "ai-1", target: { field: "scope" }, by: CLIENT as never }, T2))
    assert.equal(code(adoptAiDescription(once, { id: "ai-1", target: { field: "title" }, by: CLIENT as never }, T3)), "INVALID_TRANSITION")
    assert.equal(code(dismissAiDescription(once, "ai-1", T3)), "INVALID_TRANSITION", "an adopted description is already part of the terms")
  })

  it("dismissing marks a description dismissed and leaves the terms alone", () => {
    const d = must(dismissAiDescription(must(addAiDescription(draft(), ai, T1)), "ai-1", T2))
    assert.equal(d.aiDescriptions[0].status, "dismissed")
    assert.deepEqual(d.terms, terms())
    assert.equal(code(dismissAiDescription(d, "missing", T3)), "UNKNOWN_AI_DESCRIPTION")
  })

  it("AI text can't ride into the terms through a patch", () => {
    const r = updateDraftTerms(draft(), { aiSummary: "model text" } as never, CLIENT as never, T1)
    assert.equal(code(r), "INVARIANT_VIOLATION")
    const r2 = createDraft({ agreementId: "x", terms: { ...terms(), aiSummary: "model text" } as never, createdBy: CLIENT as never, now: T0 })
    assert.equal(code(r2), "INVALID_TERMS")
  })

  it("AI notes carry over a revision as notes only", () => {
    const v1 = must(addAiDescription(awaiting(), ai, T1))
    const v2 = must(reviseAgreement(v1, { title: "Changed" }, CLIENT as never, T2))
    assert.equal(v2.aiDescriptions.length, 1)
    assert.equal(v2.aiDescriptions[0].nonBinding, true)
  })
})

describe("record integrity (loaded or tampered records are caught)", () => {
  const tamper = (a: WorkAgreement, f: (x: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(a)) as Record<string, unknown>
    f(copy)
    return validateAgreementInvariants(copy as unknown as WorkAgreement)
  }
  const has = (problems: string[], re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `${re} not in ${problems.join(" | ")}`)

  it("every legitimate state passes", () => {
    for (const a of [draft(), awaiting(), signedBy(awaiting(), "client"), fullySigned(), active()]) assert.deepEqual(validateAgreementInvariants(a), [], a.status)
  })

  it("detects terms changed after signing", () => {
    has(tamper(fullySigned(), (x) => ((x.terms as { title: string }).title = "Altered after signing")), /no longer match their hash/)
    has(tamper(active(), (x) => ((x.terms as { payment: { totalAmount: string } }).payment.totalAmount = "1")), /no longer match their hash|not valid/)
  })

  it("detects an active agreement with no funding or funding that doesn't match", () => {
    has(tamper(active(), (x) => (x.funding = null)), /needs verified escrow funding/)
    has(tamper(active(), (x) => ((x.funding as { amount: string }).amount = "1")), /isn't exactly the agreed total/)
    has(tamper(active(), (x) => ((x.funding as { onchainStatus: string }).onchainStatus = "Created")), /not Funded/)
  })

  it("detects activation or funding without both signatures", () => {
    has(tamper(fullySigned(), (x) => (x.signatures = (x.signatures as unknown[]).slice(0, 1))), /needs both signatures/)
    has(tamper(active(), (x) => (x.signatures = [])), /needs both signatures/)
    has(tamper(awaiting(), (x) => (x.funding = { source: "chain" })), /Funding can't be recorded before both signatures/)
  })

  it("detects signatures for another version, hash, signer, legal version or text", () => {
    has(tamper(fullySigned(), (x) => ((x.signatures as Array<{ version: number }>)[0].version = 9)), /different agreement version/)
    has(tamper(fullySigned(), (x) => ((x.signatures as Array<{ termsHash: string }>)[0].termsHash = "0x" + "0".repeat(64))), /different terms/)
    has(tamper(fullySigned(), (x) => ((x.signatures as Array<{ signer: string }>)[0].signer = STRANGER)), /isn't from the/)
    has(tamper(fullySigned(), (x) => ((x.signatures as Array<{ legalTermsVersion: string }>)[0].legalTermsVersion = "other")), /different legal terms version/)
    has(tamper(fullySigned(), (x) => ((x.signatures as Array<{ message: string }>)[0].message = "I agree to something else")), /isn't over this version's signing text/)
    has(tamper(fullySigned(), (x) => (x.signatures = [...(x.signatures as unknown[]), (x.signatures as unknown[])[0]])), /more than one/)
  })

  it("detects a draft that carries a hash, signatures or funding", () => {
    const d = draft()
    has(tamper(d, (x) => (x.termsHash = "0x" + "1".repeat(64))), /draft has no terms hash/)
    has(tamper(d, (x) => (x.signatures = [{}])), /draft can't carry signatures/)
    has(tamper(d, (x) => (x.funding = {})), /draft can't carry funding/)
  })

  it("detects AI text marked binding or smuggled into the terms", () => {
    has(tamper(must(addAiDescription(awaiting(), ai, T1)), (x) => ((x.aiDescriptions as Array<{ nonBinding: boolean }>)[0].nonBinding = false)), /non-binding/)
    has(tamper(awaiting(), (x) => ((x.terms as Record<string, unknown>).aiSummary = "model text")), /aren't contractual|Unknown field/)
  })

  it("detects bad version chains", () => {
    has(tamper(draft(), (x) => (x.supersedes = { version: 1, termsHash: "0x" + "1".repeat(64) })), /Version 1 can't supersede/)
    has(tamper(draft(), (x) => (x.version = 3)), /supersede the version directly before it/)
  })
})

describe("the four states and nothing else", () => {
  it("walks draft -> awaiting_signatures -> signed_awaiting_funding -> active in order", () => {
    const seen: string[] = []
    let a = draft()
    seen.push(a.status)
    a = must(submitForSignatures(a, CLIENT as never, T0))
    seen.push(a.status)
    a = must(recordSignature(a, sigFor(a, "client"), T1))
    seen.push(a.status)
    a = must(recordSignature(a, sigFor(a, "freelancer"), T1))
    seen.push(a.status)
    a = must(activateWithFunding(a, fundingFor(a), T3))
    seen.push(a.status)
    assert.deepEqual(seen, ["draft", "awaiting_signatures", "awaiting_signatures", "signed_awaiting_funding", "active"])
    assert.deepEqual(a.events.map((e) => e.type), ["created", "submitted", "signed", "signed", "fully_signed", "activated"])
  })

  it("there is no way to skip a state", () => {
    assert.equal(code(activateWithFunding(draft(), fundingFor(awaiting()), T3)), "INVALID_TRANSITION")
    assert.equal(code(activateWithFunding(awaiting(), fundingFor(awaiting()), T3)), "INVALID_TRANSITION")
    assert.equal(code(recordSignature(draft(), sigFor(awaiting(), "client"), T1)), "INVALID_TRANSITION")
  })

  it("every timestamp must be a real UTC instant", () => {
    for (const bad of ["", "2026-11-01", "2026-11-01T12:00:00", "2026-02-31T12:00:00Z", "tomorrow"]) {
      assert.equal(code(submitForSignatures(draft(), CLIENT as never, bad)), "INVALID_INPUT", bad)
    }
  })
})

describe("scope: domain only", () => {
  const dir = path.resolve("lib/agreements")
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))
  const code = (f: string) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("imports only viem, shared types and the existing criteria hash", () => {
    const allowed = [/^viem$/, /^@\/lib\/frontend\/domain$/, /^@\/lib\/backend\/criteria$/, /^\.\/(types|terms|transitions)$/]
    for (const f of files) {
      for (const m of code(f).matchAll(/from "([^"]+)"/g)) assert.ok(allowed.some((re) => re.test(m[1])), `${f} imports ${m[1]}`)
    }
  })

  it("does no I/O, reads no clock, signs nothing and calls no model, chain, database or wallet", () => {
    for (const f of files) {
      assert.doesNotMatch(code(f), /\bfetch\(|process\.env|Date\.now\(|new Date\(\)|Math\.random|crypto\.randomUUID|node:fs|child_process|signMessage|signTypedData|walletClient|privateKey|sendTransaction|writeContract|readContract|createPublicClient|@google\/genai|supabase|gemini/i, f)
    }
  })

  it("is not wired into invoices, payments, the evaluator or the frontend", () => {
    for (const f of ["lib/backend/invoices.ts", "lib/backend/advances.ts", "lib/backend/evaluation.ts", "lib/backend/handlers.ts", "lib/backend/server.ts", "lib/evidence/service.ts", "lib/ai/evaluation-service.ts", "lib/frontend/api-repository.ts", "lib/mocks/mock-repository.ts"]) {
      assert.doesNotMatch(fs.readFileSync(f, "utf8"), /lib\/agreements|@\/lib\/agreements/, f)
    }
    assert.equal(fs.readdirSync("supabase/migrations").filter((m) => /agreement/i.test(m)).length, 0, "no migration")
  })
})
