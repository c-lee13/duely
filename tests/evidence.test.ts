import { after, before, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import type { PGlite } from "@electric-sql/pglite"
import { createDb, as } from "./helpers/db"
import { bytes, Clock, createPgEvidenceDb, FakeChain, FakeObjectStore, DOWNLOAD_URL_TTL_SECONDS } from "./helpers/evidence"
import {
  ALLOWED_MIME_TYPES,
  buildEvidencePath,
  contentMatchesType,
  EVIDENCE_MAX_BYTES,
  MAX_SUBMISSIONS_PER_INVOICE,
  parseEvidencePath,
  sanitizeFileName,
  UPLOAD_URL_TTL_SECONDS,
  validateFileMeta,
} from "@/lib/evidence/policy"
import {
  createBackendReadUrl,
  EvidenceError,
  getDownloadUrl,
  initUpload,
  registerSubmission,
  type EvidenceDeps,
  type EvidenceErrorCode,
} from "@/lib/evidence/service"
import { TEST_SCOPE } from "./helpers/backend"
import { EVIDENCE_ACCEPT, EVIDENCE_MAX_BYTES as MOCK_MAX } from "@/lib/mocks/mock-repository"

let db: PGlite
let clock: Clock
let store: FakeObjectStore
let chain: FakeChain
let deps: EvidenceDeps

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const U = { freelancer: id(1), client: id(2), stranger: id(3), claimant: id(4), nowallet: id(5), freelancer2: id(6) }
const W = {
  freelancer: "0x" + "b".repeat(40),
  client: "0x" + "a".repeat(40),
  stranger: "0x" + "c".repeat(40),
  freelancer2: "0x" + "f".repeat(40),
  contract: "0x" + "e".repeat(40),
}
const INV = {
  funded: id(101), // client <-> freelancer, cache Funded, criteria complete
  other: id(102), // stranger <-> freelancer2: unrelated to `funded`
  created: id(103), // cache Created
  settled: id(104),
  disputed: id(105),
  incomplete: id(106), // criteria_count 2, one row
  cacheCreatedChainFunded: id(107),
  limit: id(108),
}
const H = "0x" + "1".repeat(64)

async function seedInvoice(invId: string, n: number, status: string, client: string, freelancer: string, criteria = 1, rows = criteria) {
  await db.query(
    `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
     values ($1, 1440002, $2, $2, $3, $4, $5, 1000, $6, $7, 'canon', 'T', $8, $9)`,
    [invId, W.contract, n, client, freelancer, H, criteria, U.client, status]
  )
  for (let i = 0; i < rows; i++) {
    await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1, $2, $3, 'x', true)", [invId, i, `c${i}`])
  }
}

before(async () => {
  db = await createDb()
  for (const [k, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1, $2)", [uid, `${k}@t.invalid`])
  for (const [user, addr] of [[U.freelancer, W.freelancer], [U.client, W.client], [U.stranger, W.stranger], [U.freelancer2, W.freelancer2]] as const) {
    await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1, $2, now(), 'eip191')", [user, addr])
  }
  // `claimant` only CLAIMS the freelancer's wallet; it was never verified.
  await db.query("insert into user_wallets (user_id, address) values ($1, $2)", [U.claimant, W.freelancer])

  await seedInvoice(INV.funded, 1, "Funded", W.client, W.freelancer)
  await seedInvoice(INV.other, 2, "Funded", W.stranger, W.freelancer2)
  await seedInvoice(INV.created, 3, "Created", W.client, W.freelancer)
  await seedInvoice(INV.settled, 4, "Settled", W.client, W.freelancer)
  await seedInvoice(INV.disputed, 5, "Disputed", W.client, W.freelancer)
  await seedInvoice(INV.incomplete, 6, "Funded", W.client, W.freelancer, 2, 1)
  await seedInvoice(INV.cacheCreatedChainFunded, 7, "Created", W.client, W.freelancer)
  await seedInvoice(INV.limit, 8, "Funded", W.client, W.freelancer)
})
after(async () => db.close())

beforeEach(async () => {
  // Fresh state per test: submissions are immutable by trigger, so the fixture reset disables it briefly.
  await db.query("alter table submissions disable trigger submissions_immutable")
  await db.query("delete from submissions")
  await db.query("alter table submissions enable trigger submissions_immutable")
  await db.query("update invoices set onchain_status = case id when $1 then 'Created' when $2 then 'Settled' when $3 then 'Disputed' when $4 then 'Created' else 'Funded' end", [INV.created, INV.settled, INV.disputed, INV.cacheCreatedChainFunded])
  clock = new Clock()
  store = new FakeObjectStore(clock)
  chain = new FakeChain()
  deps = { scope: TEST_SCOPE, db: createPgEvidenceDb(db), objects: store, chain, requireChainVerification: false }
})

async function rejects(p: Promise<unknown>, code: EvidenceErrorCode, label = "") {
  await assert.rejects(p, (e: unknown) => e instanceof EvidenceError && e.code === code, `${label} expected ${code}`)
}

/** Full happy path as the real browser would do it: authorize, upload to the signed URL, register. */
async function submit(opts: { user?: string; invoice?: string; data?: Uint8Array; name?: string; mime?: string; note?: string } = {}) {
  const user = opts.user ?? U.freelancer
  const invoice = opts.invoice ?? INV.funded
  const data = opts.data ?? bytes.pdf
  const name = opts.name ?? "proof.pdf"
  const mime = opts.mime ?? "application/pdf"
  const grant = await initUpload(deps, { userId: user, invoiceId: invoice, fileName: name, fileSize: data.length, mimeType: mime })
  store.upload(grant.uploadToken, data, mime)
  const reg = await registerSubmission(deps, { userId: user, invoiceId: invoice, storagePath: grant.path, fileName: name, note: opts.note })
  return { grant, reg }
}

const submissionCount = async (inv = INV.funded) => (await db.query<{ c: number }>("select count(*)::int c from submissions where invoice_uuid = $1", [inv])).rows[0].c

describe("authorized freelancer upload", () => {
  it("authorizes, uploads to a server-chosen path, and records metadata taken from the stored object", async () => {
    const { grant, reg } = await submit({ note: "  see section 2  " })
    assert.deepEqual(parseEvidencePath(grant.path)?.invoiceId, INV.funded)
    assert.equal(parseEvidencePath(grant.path)?.userId, U.freelancer)
    assert.match(grant.path, /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/)
    assert.equal(grant.maxBytes, EVIDENCE_MAX_BYTES)
    assert.equal(grant.expiresInSeconds, UPLOAD_URL_TTL_SECONDS)
    assert.equal(reg.duplicate, false)
    const row = (await db.query<Record<string, unknown>>("select * from submissions where id = $1", [reg.submission.id])).rows[0]
    assert.equal(row.invoice_uuid, INV.funded)
    assert.equal(row.freelancer_user_id, U.freelancer)
    assert.equal(row.freelancer_address, W.freelancer, "address comes from the invoice, not the browser")
    assert.equal(row.storage_path, grant.path)
    assert.equal(Number(row.file_size), bytes.pdf.length, "size comes from the stored object")
    assert.equal(row.mime_type, "application/pdf")
    assert.equal(row.note, "see section 2")
    assert.equal(row.funding_verified_onchain, false, "no chain adapter: not claimed as verified")
  })

  it("accepts every allowed file type with matching content", async () => {
    const cases: Array<[string, string, Uint8Array]> = [
      ["a.png", "image/png", bytes.png],
      ["a.jpg", "image/jpeg", bytes.jpg],
      ["a.jpeg", "image/jpeg", bytes.jpg],
      ["a.zip", "application/zip", bytes.zip],
      ["a.zip", "application/x-zip-compressed", bytes.zip],
      ["a.md", "text/markdown", bytes.text],
      ["a.txt", "text/plain", bytes.text],
    ]
    for (const [name, mime, data] of cases) {
      const { reg } = await submit({ invoice: INV.limit, name, mime, data })
      assert.equal(reg.submission.mime_type, mime, name)
      await db.query("alter table submissions disable trigger submissions_immutable")
      await db.query("delete from submissions where invoice_uuid = $1", [INV.limit])
      await db.query("alter table submissions enable trigger submissions_immutable")
      store.objects.clear()
    }
  })

  it("records funding as on-chain verified only when a chain adapter confirmed it", async () => {
    chain.result = { status: "verified", onchainStatus: "Funded" }
    const { reg } = await submit()
    assert.equal(reg.submission.funding_verified_onchain, true)
    assert.equal(chain.calls >= 1, true)
  })

  it("never lets the browser's file name into the storage path, and stores only a sanitized display name", async () => {
    const { grant, reg } = await submit({ name: "../../etc/passwd.pdf" })
    assert.ok(!grant.path.includes("passwd") && !grant.path.includes(".."))
    assert.equal(reg.submission.file_name, "passwd.pdf")
    assert.equal(sanitizeFileName("..\\..\\win\\evil\u0000.pdf"), "evil.pdf")
    assert.equal(sanitizeFileName("///"), "evidence")
    assert.ok(sanitizeFileName("a".repeat(500)).length <= 200)
  })
})

describe("unauthorized users", () => {
  it("no session: every operation is UNAUTHENTICATED", async () => {
    await rejects(initUpload(deps, { userId: null, invoiceId: INV.funded, fileName: "a.pdf", fileSize: 10, mimeType: "application/pdf" }), "UNAUTHENTICATED")
    await rejects(registerSubmission(deps, { userId: null, invoiceId: INV.funded, storagePath: "x" }), "UNAUTHENTICATED")
    await rejects(getDownloadUrl(deps, { userId: null, submissionId: id(9) }), "UNAUTHENTICATED")
  })

  it("a user with no verified wallet, or only an unverified CLAIM on the freelancer's address, is refused", async () => {
    for (const user of [U.nowallet, U.claimant]) {
      await rejects(initUpload(deps, { userId: user, invoiceId: INV.funded, fileName: "a.pdf", fileSize: 10, mimeType: "application/pdf" }), "NO_VERIFIED_WALLET", user)
    }
  })

  it("an unrelated wallet gets NOT_FOUND (the invoice's existence is not revealed)", async () => {
    await rejects(initUpload(deps, { userId: U.stranger, invoiceId: INV.funded, fileName: "a.pdf", fileSize: 10, mimeType: "application/pdf" }), "NOT_FOUND")
    await rejects(initUpload(deps, { userId: U.stranger, invoiceId: id(999), fileName: "a.pdf", fileSize: 10, mimeType: "application/pdf" }), "NOT_FOUND", "nonexistent looks identical")
  })

  it("the invoice's CLIENT is a party but not the freelancer: FORBIDDEN", async () => {
    await rejects(initUpload(deps, { userId: U.client, invoiceId: INV.funded, fileName: "a.pdf", fileSize: 10, mimeType: "application/pdf" }), "FORBIDDEN")
  })

  it("cannot register someone else's upload: the client or a stranger cannot use the freelancer's path", async () => {
    const grant = await initUpload(deps, { userId: U.freelancer, invoiceId: INV.funded, fileName: "a.pdf", fileSize: 12, mimeType: "application/pdf" })
    store.upload(grant.uploadToken, bytes.pdf, "application/pdf")
    for (const user of [U.client, U.stranger]) {
      await rejects(registerSubmission(deps, { userId: user, invoiceId: INV.funded, storagePath: grant.path }), "INVALID_PATH", user)
    }
    assert.equal(await submissionCount(), 0)
  })
})

describe("wrong invoice and hostile paths", () => {
  it("a freelancer cannot start an upload for an invoice that is not theirs", async () => {
    await rejects(initUpload(deps, { userId: U.freelancer, invoiceId: INV.other, fileName: "a.pdf", fileSize: 10, mimeType: "application/pdf" }), "NOT_FOUND")
    await rejects(initUpload(deps, { userId: U.freelancer, invoiceId: "not-a-uuid", fileName: "a.pdf", fileSize: 10, mimeType: "application/pdf" }), "NOT_FOUND")
  })

  it("a path issued for one invoice cannot be registered against another", async () => {
    const grant = await initUpload(deps, { userId: U.freelancer, invoiceId: INV.funded, fileName: "a.pdf", fileSize: 12, mimeType: "application/pdf" })
    store.upload(grant.uploadToken, bytes.pdf, "application/pdf")
    await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.limit, storagePath: grant.path }), "INVALID_PATH")
    await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.other, storagePath: grant.path }), "INVALID_PATH")
    assert.equal(await submissionCount(INV.limit) + (await submissionCount(INV.other)), 0)
  })

  it("rejects traversal and malformed storage paths before touching storage or the database", async () => {
    const good = buildEvidencePath({ invoiceId: INV.funded, userId: U.freelancer, objectId: id(77), ext: "pdf" })
    const hostile = [
      `../${good}`,
      `${INV.funded}/../${U.client}/${id(77)}.pdf`,
      `${INV.funded}/${U.freelancer}/../../${INV.other}/${id(77)}.pdf`,
      `/${good}`,
      `${good}/`,
      `${good}%2e%2e`,
      `${INV.funded}%2f${U.freelancer}%2f${id(77)}.pdf`,
      `${INV.funded}/${U.freelancer}/${id(77)}.pdf\u0000.exe`,
      `${INV.funded}/${U.freelancer}/${id(77)}.exe`,
      `${INV.funded}/${U.freelancer}/${id(77)}.PDF`,
      `${INV.funded}/${U.freelancer}/sub/${id(77)}.pdf`,
      `${INV.funded}/${U.freelancer}/evil.pdf`,
      good.toUpperCase(),
      ` ${good}`,
      "",
      "evidence/x",
      "a".repeat(500),
    ]
    for (const p of hostile) {
      assert.equal(parseEvidencePath(p), null, JSON.stringify(p))
      await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: p }), "INVALID_PATH", JSON.stringify(p))
    }
    assert.ok(parseEvidencePath(good), "the well-formed path is accepted by the parser")
    assert.equal(parseEvidencePath(42 as unknown as string), null)
  })

  it("a well-formed path that was never uploaded is UPLOAD_NOT_FOUND, and nothing is recorded", async () => {
    const p = buildEvidencePath({ invoiceId: INV.funded, userId: U.freelancer, objectId: id(88), ext: "pdf" })
    await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: p }), "UPLOAD_NOT_FOUND")
    assert.equal(await submissionCount(), 0)
  })

  it("a signed upload token cannot write to any path but its own, or overwrite an existing object", async () => {
    const a = await initUpload(deps, { userId: U.freelancer, invoiceId: INV.funded, fileName: "a.pdf", fileSize: 12, mimeType: "application/pdf" })
    store.upload(a.uploadToken, bytes.pdf, "application/pdf")
    assert.throws(() => store.upload(a.uploadToken, bytes.pdf, "application/pdf"), /already used/)
    store.putRaw(a.path, bytes.pdf, "application/pdf")
    const b = await initUpload(deps, { userId: U.freelancer, invoiceId: INV.funded, fileName: "b.pdf", fileSize: 12, mimeType: "application/pdf" })
    assert.notEqual(a.path, b.path, "every grant gets its own random path")
  })
})

describe("file type restrictions", () => {
  const init = (mimeType: string, fileName = "a.pdf", fileSize = 100) =>
    initUpload(deps, { userId: U.freelancer, invoiceId: INV.funded, fileName, fileSize, mimeType })

  it("refuses types outside the allow-list at the authorization step", async () => {
    for (const mime of ["application/x-msdownload", "text/html", "image/svg+xml", "application/javascript", "application/x-sh", "application/octet-stream", "", "image/gif"]) {
      await rejects(init(mime), "UNSUPPORTED_TYPE", mime || "(empty)")
    }
  })

  it("refuses a file whose name extension contradicts its declared type", async () => {
    await rejects(init("application/pdf", "malware.exe"), "UNSUPPORTED_TYPE")
    await rejects(init("image/png", "photo.pdf"), "UNSUPPORTED_TYPE")
    await rejects(init("text/plain", "page.html"), "UNSUPPORTED_TYPE")
  })

  it("the bucket itself rejects a disallowed content type even with a valid signed URL", async () => {
    const g = await init("application/pdf")
    assert.throws(() => store.upload(g.uploadToken, bytes.exe, "application/x-msdownload"), /mime type not supported/)
  })

  it("rejects a spoofed file: an executable labelled application/pdf fails the content check, is deleted, and is never recorded", async () => {
    const g = await init("application/pdf")
    store.upload(g.uploadToken, bytes.exe, "application/pdf")
    await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: g.path }), "CONTENT_MISMATCH")
    assert.equal(store.objects.has(g.path), false, "the rejected object is removed")
    assert.equal(await submissionCount(), 0)
  })

  it("rejects mismatched real content (a PNG uploaded as a PDF) and text with NUL bytes", async () => {
    const g1 = await init("application/pdf")
    store.upload(g1.uploadToken, bytes.png, "application/pdf")
    await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: g1.path }), "CONTENT_MISMATCH")
    const g2 = await init("text/plain", "a.txt")
    store.upload(g2.uploadToken, new Uint8Array([0x68, 0x69, 0x00, 0x01]), "text/plain")
    await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: g2.path }), "CONTENT_MISMATCH")
  })

  it("rejects an object whose stored MIME differs from the one the path was issued for", async () => {
    const g = await init("application/pdf")
    store.putRaw(g.path, bytes.png, "image/png")
    await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: g.path }), "UNSUPPORTED_TYPE")
    assert.equal(store.objects.has(g.path), false)
  })

  it("content sniffing recognises each allowed format and nothing else", () => {
    assert.ok(contentMatchesType("application/pdf", bytes.pdf))
    assert.ok(contentMatchesType("image/png", bytes.png))
    assert.ok(contentMatchesType("image/jpeg", bytes.jpg))
    assert.ok(contentMatchesType("application/zip", bytes.zip))
    assert.ok(contentMatchesType("text/markdown", bytes.text))
    assert.ok(!contentMatchesType("application/pdf", bytes.exe))
    assert.ok(!contentMatchesType("application/pdf", new Uint8Array()))
    assert.ok(!contentMatchesType("image/svg+xml", new TextEncoder().encode("<svg onload=alert(1)>")))
    assert.ok(!contentMatchesType("text/plain", new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0x80, 0x80, 0x80, 0x80])))
  })
})

describe("size limit (25 MB)", () => {
  const init = (fileSize: number) => initUpload(deps, { userId: U.freelancer, invoiceId: INV.funded, fileName: "a.pdf", fileSize, mimeType: "application/pdf" })

  it("exactly 25 MB is allowed; one byte more is FILE_TOO_LARGE; empty and fractional sizes are invalid", async () => {
    await init(EVIDENCE_MAX_BYTES)
    await rejects(init(EVIDENCE_MAX_BYTES + 1), "FILE_TOO_LARGE")
    await rejects(init(0), "INVALID_FILE")
    await rejects(init(-5), "INVALID_FILE")
    await rejects(init(1.5), "INVALID_FILE")
    await rejects(init(Number.NaN), "INVALID_FILE")
  })

  it("the bucket enforces the limit at upload time, whatever the browser claimed", async () => {
    const g = await init(100)
    assert.throws(() => store.upload(g.uploadToken, bytes.pdf, "application/pdf", EVIDENCE_MAX_BYTES + 1), /exceeds maximum/)
  })

  it("an oversized object that slips past the bucket is rejected, deleted and not recorded (size comes from storage, not the request)", async () => {
    const g = await init(100) // browser claimed 100 bytes
    store.putRaw(g.path, bytes.pdf, "application/pdf", EVIDENCE_MAX_BYTES + 1)
    await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: g.path }), "FILE_TOO_LARGE")
    assert.equal(store.objects.has(g.path), false)
    assert.equal(await submissionCount(), 0)
  })

  it("an empty stored object is rejected", async () => {
    const g = await init(100)
    store.putRaw(g.path, new Uint8Array(), "application/pdf", 0)
    await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: g.path }), "INVALID_FILE")
  })

  it("the documented limit equals the policy constant used everywhere", () => {
    assert.equal(EVIDENCE_MAX_BYTES, 26214400)
    assert.throws(() => validateFileMeta({ fileName: "a.pdf", fileSize: EVIDENCE_MAX_BYTES + 1, mimeType: "application/pdf" }), /25 MB/)
  })
})

describe("retrieval and signed download URLs", () => {
  it("the client and the freelancer get a signed URL that downloads the stored bytes", async () => {
    const { reg } = await submit()
    for (const user of [U.freelancer, U.client]) {
      const g = await getDownloadUrl(deps, { userId: user, submissionId: reg.submission.id })
      assert.deepEqual(store.fetchDownload(g.url), bytes.pdf)
      assert.equal(g.fileName, "proof.pdf")
      assert.equal(g.mimeType, "application/pdf")
    }
  })

  it("asks for a lifetime of at most 60 seconds", async () => {
    const { reg } = await submit()
    const g = await getDownloadUrl(deps, { userId: U.client, submissionId: reg.submission.id })
    assert.equal(store.lastDownloadTtl, DOWNLOAD_URL_TTL_SECONDS)
    assert.ok(DOWNLOAD_URL_TTL_SECONDS <= 60)
    assert.ok(Date.parse(g.expiresAt) - clock.now() <= 60_000)
  })

  it("unrelated users, unverified claimants, wallet-less users and signed-out callers cannot download", async () => {
    const { reg } = await submit()
    await rejects(getDownloadUrl(deps, { userId: U.stranger, submissionId: reg.submission.id }), "NOT_FOUND", "stranger")
    await rejects(getDownloadUrl(deps, { userId: U.freelancer2, submissionId: reg.submission.id }), "NOT_FOUND", "other invoice's freelancer")
    await rejects(getDownloadUrl(deps, { userId: U.claimant, submissionId: reg.submission.id }), "NO_VERIFIED_WALLET", "unverified claim")
    await rejects(getDownloadUrl(deps, { userId: U.nowallet, submissionId: reg.submission.id }), "NO_VERIFIED_WALLET", "no wallet")
    await rejects(getDownloadUrl(deps, { userId: null, submissionId: reg.submission.id }), "UNAUTHENTICATED", "signed out")
  })

  it("nonexistent and malformed submission ids look identical to an unauthorized one", async () => {
    await rejects(getDownloadUrl(deps, { userId: U.client, submissionId: id(424242) }), "NOT_FOUND")
    await rejects(getDownloadUrl(deps, { userId: U.client, submissionId: "../../etc/passwd" }), "NOT_FOUND")
  })

  it("a signed URL stops working when it expires; a fresh request mints a new working one", async () => {
    const { reg } = await submit()
    const first = await getDownloadUrl(deps, { userId: U.client, submissionId: reg.submission.id })
    assert.deepEqual(store.fetchDownload(first.url), bytes.pdf)
    clock.advance(DOWNLOAD_URL_TTL_SECONDS + 1)
    assert.throws(() => store.fetchDownload(first.url), /expired/)
    const second = await getDownloadUrl(deps, { userId: U.client, submissionId: reg.submission.id })
    assert.notEqual(second.url, first.url, "URLs are minted per request and never reused")
    assert.deepEqual(store.fetchDownload(second.url), bytes.pdf)
  })

  it("a signed upload URL also expires", async () => {
    const g = await initUpload(deps, { userId: U.freelancer, invoiceId: INV.funded, fileName: "a.pdf", fileSize: 12, mimeType: "application/pdf" })
    clock.advance(UPLOAD_URL_TTL_SECONDS + 1)
    assert.throws(() => store.upload(g.uploadToken, bytes.pdf, "application/pdf"), /expired/)
    await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: g.path }), "UPLOAD_NOT_FOUND")
  })

  it("protected backend code can mint a read URL without a user session, and bad ids are refused", async () => {
    const { reg } = await submit()
    const g = await createBackendReadUrl(deps, reg.submission.id)
    assert.deepEqual(store.fetchDownload(g.url), bytes.pdf)
    await rejects(createBackendReadUrl(deps, id(555)), "NOT_FOUND")
    await rejects(createBackendReadUrl(deps, "nope"), "NOT_FOUND")
  })

  it("a stored path that is not one of our server-generated shapes is refused at download time", async () => {
    const { reg } = await submit()
    await db.query("alter table submissions disable trigger submissions_immutable")
    await db.query("update submissions set storage_path = '../../secret.pdf' where id = $1", [reg.submission.id])
    await db.query("alter table submissions enable trigger submissions_immutable")
    await rejects(getDownloadUrl(deps, { userId: U.client, submissionId: reg.submission.id }), "INVALID_PATH")
  })
})

describe("duplicates and limits", () => {
  it("registering the same path again returns the same submission and creates no second row", async () => {
    const { grant, reg } = await submit()
    const again = await registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: grant.path })
    assert.equal(again.duplicate, true)
    assert.equal(again.submission.id, reg.submission.id)
    assert.equal(await submissionCount(), 1)
  })

  it("two simultaneous registrations of one upload produce exactly one submission", async () => {
    const g = await initUpload(deps, { userId: U.freelancer, invoiceId: INV.funded, fileName: "a.pdf", fileSize: 12, mimeType: "application/pdf" })
    store.upload(g.uploadToken, bytes.pdf, "application/pdf")
    const [a, b] = await Promise.all([
      registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: g.path }),
      registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: g.path }),
    ])
    assert.equal(a.submission.id, b.submission.id)
    assert.equal(await submissionCount(), 1)
  })

  it("a retry still succeeds after the invoice has moved on (it is the same, already-accepted submission)", async () => {
    const { grant, reg } = await submit()
    await db.query("update invoices set onchain_status = 'Advanced' where id = $1", [INV.funded])
    const again = await registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: grant.path })
    assert.equal(again.submission.id, reg.submission.id)
    await db.query("update invoices set onchain_status = 'Funded' where id = $1", [INV.funded])
  })

  it("a genuinely new upload is a NEW submission (resubmitting after a failed evaluation is allowed)", async () => {
    const one = await submit()
    const two = await submit({ data: bytes.png, name: "v2.png", mime: "image/png" })
    assert.notEqual(one.reg.submission.id, two.reg.submission.id)
    assert.equal(await submissionCount(), 2)
  })

  it("the database itself rejects a duplicate storage path", async () => {
    const { grant } = await submit()
    const err = await as(db, "service_role", null, async () => {
      try {
        await db.query(
          "insert into submissions (invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type) values ($1,$2,$3,$4,'x',1,'text/plain')",
          [INV.funded, U.freelancer, W.freelancer, grant.path]
        )
        return null
      } catch (e) {
        return (e as Error).message
      }
    })
    assert.match(err ?? "NO ERROR", /duplicate key/)
  })

  it(`an invoice accepts at most ${MAX_SUBMISSIONS_PER_INVOICE} submissions`, async () => {
    for (let i = 0; i < MAX_SUBMISSIONS_PER_INVOICE; i++) await submit({ invoice: INV.limit })
    await rejects(initUpload(deps, { userId: U.freelancer, invoiceId: INV.limit, fileName: "a.pdf", fileSize: 12, mimeType: "application/pdf" }), "SUBMISSION_LIMIT")
  })

  it("caps unfinished uploads per invoice and user", async () => {
    for (let i = 0; i < 20; i++) {
      const g = await initUpload(deps, { userId: U.freelancer, invoiceId: INV.funded, fileName: "a.pdf", fileSize: 12, mimeType: "application/pdf" })
      store.upload(g.uploadToken, bytes.pdf, "application/pdf")
    }
    await rejects(initUpload(deps, { userId: U.freelancer, invoiceId: INV.funded, fileName: "a.pdf", fileSize: 12, mimeType: "application/pdf" }), "TOO_MANY_UPLOADS")
  })
})

describe("invoice eligibility and funding", () => {
  const init = (invoiceId: string) => initUpload(deps, { userId: U.freelancer, invoiceId, fileName: "a.pdf", fileSize: 12, mimeType: "application/pdf" })

  it("refuses an unfunded invoice and a closed one", async () => {
    await rejects(init(INV.created), "NOT_FUNDED")
    await rejects(init(INV.settled), "INVOICE_CLOSED")
    await rejects(init(INV.disputed), "INVOICE_CLOSED")
  })

  it("the on-chain status wins over the database cache when an adapter is available", async () => {
    chain.result = { status: "verified", onchainStatus: "Created" }
    await rejects(init(INV.funded), "NOT_FUNDED", "cache says Funded but chain says Created")
    chain.result = { status: "verified", onchainStatus: "Funded" }
    const g = await init(INV.cacheCreatedChainFunded)
    assert.ok(g.path, "cache says Created but the chain says Funded")
    chain.result = { status: "verified", onchainStatus: "Settled" }
    await rejects(init(INV.funded), "INVOICE_CLOSED")
  })

  it("fails closed when verification is required and the chain cannot be read", async () => {
    deps.requireChainVerification = true
    await rejects(init(INV.funded), "CHAIN_UNAVAILABLE", "adapter unavailable")
    chain.result = "throw"
    await rejects(init(INV.funded), "CHAIN_UNAVAILABLE", "adapter errors")
    chain.result = { status: "verified", onchainStatus: "Funded" }
    assert.ok((await init(INV.funded)).path)
  })

  it("a chain adapter that errors is never treated as 'funded', even when verification is optional", async () => {
    chain.result = "throw"
    await rejects(init(INV.funded), "CHAIN_UNAVAILABLE")
  })

  it("refuses an invoice whose frozen criteria are not fully recorded (service check and DB trigger)", async () => {
    await rejects(init(INV.incomplete), "CRITERIA_INCOMPLETE")
    const err = await as(db, "service_role", null, async () => {
      try {
        await db.query(
          "insert into submissions (invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type) values ($1,$2,$3,'p','x',1,'text/plain')",
          [INV.incomplete, U.freelancer, W.freelancer]
        )
        return null
      } catch (e) {
        return (e as Error).message
      }
    })
    assert.match(err ?? "NO ERROR", /criteria are incomplete/)
  })

  it("registering re-checks eligibility: an invoice that closes between upload and registration is refused", async () => {
    const g = await init(INV.funded)
    store.upload(g.uploadToken, bytes.pdf, "application/pdf")
    await db.query("update invoices set onchain_status = 'Disputed' where id = $1", [INV.funded])
    await rejects(registerSubmission(deps, { userId: U.freelancer, invoiceId: INV.funded, storagePath: g.path }), "INVOICE_CLOSED")
    await db.query("update invoices set onchain_status = 'Funded' where id = $1", [INV.funded])
  })
})

describe("policy consistency", () => {
  it("the policy's allow-list and size limit match the mock demo's constants and the bucket configuration", async () => {
    assert.deepEqual([...ALLOWED_MIME_TYPES].sort(), [...EVIDENCE_ACCEPT].sort())
    assert.equal(EVIDENCE_MAX_BYTES, MOCK_MAX)
    const b = (await db.query<{ file_size_limit: string; allowed_mime_types: string[]; public: boolean }>("select file_size_limit, allowed_mime_types, public from storage.buckets where id = 'evidence'")).rows[0]
    assert.equal(b.public, false)
    assert.equal(Number(b.file_size_limit), EVIDENCE_MAX_BYTES)
    assert.deepEqual([...b.allowed_mime_types].sort(), [...ALLOWED_MIME_TYPES].sort())
  })

  it("the database refuses a submission with a MIME type outside the allow-list", async () => {
    const err = await as(db, "service_role", null, async () => {
      try {
        await db.query(
          "insert into submissions (invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type) values ($1,$2,$3,'p-html','x',1,'text/html')",
          [INV.funded, U.freelancer, W.freelancer]
        )
        return null
      } catch (e) {
        return (e as Error).message
      }
    })
    assert.match(err ?? "NO ERROR", /submissions_mime_type_allowed/)
  })
})
