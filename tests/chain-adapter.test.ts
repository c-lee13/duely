import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { createChainAdapter, createChainFundingVerifier, type AdapterClient } from "@/lib/backend/chain-adapter"
import { activeDeploymentScope } from "@/lib/backend/scope"
import { ChainInvoiceNotFoundError, ChainScopeError, type ChainAdvanceTxRef, type ChainInvoiceRef } from "@/lib/backend/ports"
import { contractAddresses } from "@/lib/chain/config"
import { ADDR, EVAL, META, createMockChain, eventLog } from "@/lib/chain/test/mock-chain"
import { initUpload, EvidenceError, type EvidenceDeps, type InvoiceForEvidence } from "@/lib/evidence/service"
import { Clock, FakeObjectStore, createPgEvidenceDb } from "./helpers/evidence"
import { createDb } from "./helpers/db"
import { computeEvaluationHash } from "@/lib/shared/evaluation-hash"

/**
 * The backend chain adapter over the Track A SDK, driven by the SDK's own mock chain (a viem client on a mock
 * transport that evaluates InvoiceAdvance's rules). Nothing here touches a real RPC.
 */
const scope = activeDeploymentScope() // the configured default deployment (dUSD in the test environment)
const IA = contractAddresses.invoiceAdvance
const ref = (id: number | bigint, over: Partial<ChainInvoiceRef> = {}): ChainInvoiceRef => ({ chainId: scope.chainId, contractAddress: IA, invoiceId: BigInt(id), ...over })

function adapterOn(options: Parameters<typeof createMockChain>[0] = {}) {
  const chain = createMockChain(options)
  return { chain, adapter: createChainAdapter({ scope, client: chain.publicClient as unknown as AdapterClient }) }
}

const H = (n: number) => "0x" + n.toString(16).padStart(64, "0")

afterEach(() => undefined)

describe("chain adapter: invoice state reads", () => {
  it("reads status, amounts, parties and commitments from the contract, pinned to one block", async () => {
    const { chain, adapter } = adapterOn()
    const s = await adapter.getInvoiceState(ref(2)) // Funded in the mock
    assert.equal(s.onchainStatus, "Funded")
    assert.equal(s.amount, BigInt(1000000000))
    assert.equal(s.advanceAmount, BigInt(0))
    assert.equal(s.client?.toLowerCase(), ADDR.client.toLowerCase())
    assert.equal(s.freelancer?.toLowerCase(), ADDR.freelancer.toLowerCase())
    assert.equal(s.criteriaHash, META)
    assert.equal(s.blockNumber, BigInt(500))
    const advanced = await adapter.getInvoiceState(ref(3))
    assert.equal(advanced.onchainStatus, "Advanced")
    assert.equal(advanced.advanceAmount, BigInt(900000000))
    assert.equal(advanced.evaluationHash, EVAL)
    assert.ok(chain.rpc.some((r) => r.method === "eth_chainId"), "the RPC's chain id is verified before reading")
  })

  it("reports every contract status by name, including Disputed and Settled", async () => {
    const { adapter } = adapterOn()
    assert.deepEqual(
      await Promise.all([1, 2, 3, 4, 5].map(async (i) => (await adapter.getInvoiceState(ref(i))).onchainStatus)),
      ["Created", "Funded", "Advanced", "Disputed", "Settled"]
    )
  })

  it("a missing invoice is ChainInvoiceNotFoundError, not an outage", async () => {
    const { adapter } = adapterOn()
    await assert.rejects(adapter.getInvoiceState(ref(999)), ChainInvoiceNotFoundError)
  })

  it("an RPC failure propagates as an error whose message never contains the RPC URL", async () => {
    const { adapter } = adapterOn({ failCallsFor: ["getInvoice"] })
    await assert.rejects(adapter.getInvoiceState(ref(2)), (e: Error) => {
      assert.ok(!(e instanceof ChainInvoiceNotFoundError) && !(e instanceof ChainScopeError))
      assert.doesNotMatch(e.message, /secret-node|TOP-SECRET|https?:\/\//)
      return true
    })
  })

  it("refuses a reference from another deployment before any read", async () => {
    const { chain, adapter } = adapterOn()
    const before = chain.rpc.length
    for (const bad of [
      ref(2, { contractAddress: ("0x" + "9".repeat(40)) as `0x${string}` }),
      ref(2, { chainId: 1 }),
      ref(2, { chainId: 0 }),
    ]) {
      await assert.rejects(adapter.getInvoiceState(bad), ChainScopeError)
      await assert.rejects(adapter.findAdvancePaid(bad), ChainScopeError)
    }
    assert.equal(chain.rpc.length, before, "no RPC call was made for an out-of-scope reference")
  })

  it("refuses to read when the RPC is on a different chain", async () => {
    const { adapter } = adapterOn({ rpcChainId: 1 })
    await assert.rejects(adapter.getInvoiceState(ref(2)), ChainScopeError)
    await assert.rejects(adapter.getReserveAvailable(), ChainScopeError)
  })

  it("reads the available reserve, and surfaces an RPC failure", async () => {
    assert.equal(await adapterOn().adapter.getReserveAvailable(), BigInt(10000000000))
    await assert.rejects(adapterOn({ failCallsFor: ["availableReserve"] }).adapter.getReserveAvailable())
  })
})

describe("funding verification (evidence gate)", () => {
  const invoiceRow = (over: Partial<InvoiceForEvidence> = {}): InvoiceForEvidence => ({
    id: "00000000-0000-4000-8000-000000000001",
    client_address: ADDR.client.toLowerCase() as `0x${string}`,
    freelancer_address: ADDR.freelancer.toLowerCase() as `0x${string}`,
    onchain_status: "Funded", // a CACHE: must never be what decides
    criteria_count: 1,
    chain_id: scope.chainId,
    contract_address: IA,
    invoice_id: "2",
    ...over,
  })

  it("verifies a Funded invoice from the chain, and an unfunded one as Created", async () => {
    const { adapter } = adapterOn()
    const verifier = createChainFundingVerifier(adapter)
    assert.deepEqual(await verifier.verify(invoiceRow({ invoice_id: "2" })), { status: "verified", onchainStatus: "Funded" })
    assert.deepEqual(await verifier.verify(invoiceRow({ invoice_id: "1" })), { status: "verified", onchainStatus: "Created" })
  })

  it("is 'unavailable' (never 'funded') for: RPC failure, missing invoice, wrong deployment, dev fixture, and mismatching parties", async () => {
    const down = createChainFundingVerifier(adapterOn({ failCallsFor: ["getInvoice"] }).adapter)
    assert.deepEqual(await down.verify(invoiceRow()), { status: "unavailable" })
    const ok = createChainFundingVerifier(adapterOn().adapter)
    assert.deepEqual(await ok.verify(invoiceRow({ invoice_id: "999" })), { status: "unavailable" })
    assert.deepEqual(await ok.verify(invoiceRow({ contract_address: ("0x" + "9".repeat(40)) as `0x${string}` })), { status: "unavailable" })
    assert.deepEqual(await ok.verify(invoiceRow({ chain_id: 0 })), { status: "unavailable" })
    assert.deepEqual(await ok.verify(invoiceRow({ freelancer_address: ADDR.stranger.toLowerCase() as `0x${string}` })), { status: "unavailable" })
    assert.deepEqual(await ok.verify(invoiceRow({ client_address: ADDR.stranger.toLowerCase() as `0x${string}` })), { status: "unavailable" })
  })

  it("end to end with the evidence service: unfunded escrow is refused even when the database cache says Funded", async () => {
    const db = await createDb()
    try {
      const U = { c: "00000000-0000-4000-8000-0000000000a1", f: "00000000-0000-4000-8000-0000000000a2" }
      for (const [k, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, `${k}@t.invalid`])
      await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1,$2,now(),'eip191')", [U.f, ADDR.freelancer.toLowerCase()])
      const seed = async (invUuid: string, onchainId: number) => {
        await db.query(
          `insert into invoices (id, chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount, criteria_hash, criteria_count, criteria_canonical, title, registered_by, onchain_status)
           values ($1,$2,$3,$4,$5::numeric,$6,$7,1000,$8,1,'c','T',$9,'Funded')`,
          [invUuid, scope.chainId, IA.toLowerCase(), scope.tokenAddress, onchainId, ADDR.client.toLowerCase(), ADDR.freelancer.toLowerCase(), META, U.c]
        )
        await db.query("insert into invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory) values ($1,0,'c1','x',true)", [invUuid])
      }
      const created = "00000000-0000-4000-8000-0000000000b1" // chain: Created (unfunded) though the cache says Funded
      const funded = "00000000-0000-4000-8000-0000000000b2" // chain: Funded
      await seed(created, 1)
      await seed(funded, 2)
      const deps: EvidenceDeps = {
        scope,
        db: createPgEvidenceDb(db),
        objects: new FakeObjectStore(new Clock()),
        chain: createChainFundingVerifier(adapterOn().adapter),
        requireChainVerification: true,
      }
      const upload = (invoiceId: string) => initUpload(deps, { userId: U.f, invoiceId, fileName: "a.txt", fileSize: 10, mimeType: "text/plain" })
      await assert.rejects(upload(created), (e: EvidenceError) => e.code === "NOT_FUNDED")
      assert.ok((await upload(funded)).path, "a chain-funded invoice is accepted")
      // And when the chain can't be read, evidence is refused rather than trusting the cache.
      const downDeps = { ...deps, chain: createChainFundingVerifier(adapterOn({ failCallsFor: ["getInvoice"] }).adapter) }
      await assert.rejects(initUpload(downDeps, { userId: U.f, invoiceId: funded, fileName: "b.txt", fileSize: 10, mimeType: "text/plain" }), (e: EvidenceError) => e.code === "CHAIN_UNAVAILABLE")
    } finally {
      await db.close()
    }
  })
})

describe("transaction reads: invoice creation", () => {
  const CREATE = H(0xc1)
  const created = (over: Record<string, unknown> = {}) =>
    eventLog("invoiceAdvance", "InvoiceCreated", { invoiceId: BigInt(6), freelancer: ADDR.freelancer, client: ADDR.client, amount: BigInt(1000000000), metadataHash: META, ...over })

  it("a confirmed createInvoice yields the creator, parties, amount, token and committed hash, taken from the event and receipt", async () => {
    const { chain, adapter } = adapterOn()
    chain.setReceipt(CREATE, chain.receiptJson(CREATE, ADDR.client, IA, "success", [created()]))
    const c = await adapter.getInvoiceCreation(CREATE as `0x${string}`)
    assert.equal(c.status, "confirmed")
    assert.equal(c.invoiceId, BigInt(6))
    assert.equal(c.creator.toLowerCase(), ADDR.client.toLowerCase())
    assert.equal(c.freelancer.toLowerCase(), ADDR.freelancer.toLowerCase())
    assert.equal(c.amount, BigInt(1000000000))
    assert.equal(c.criteriaHash, META)
    assert.equal(c.tokenAddress.toLowerCase(), contractAddresses.paymentToken.toLowerCase())
    assert.equal(c.contractAddress.toLowerCase(), IA.toLowerCase())
  })

  it("not mined yet is 'pending'; unknown hash is 'not_found'; a reverted transaction is 'reverted'", async () => {
    const { chain, adapter } = adapterOn()
    const pendingHash = H(0xc2)
    chain.rpcTxs.set(pendingHash, chain.rpcTxFor(pendingHash, { from: ADDR.client, to: IA, data: "0x" }, 1))
    assert.equal((await adapter.getInvoiceCreation(pendingHash as `0x${string}`)).status, "pending")
    assert.equal((await adapter.getInvoiceCreation(H(0xc3) as `0x${string}`)).status, "not_found")
    const rev = H(0xc4)
    chain.setReceipt(rev, chain.receiptJson(rev, ADDR.client, IA, "reverted", []))
    assert.equal((await adapter.getInvoiceCreation(rev as `0x${string}`)).status, "reverted")
  })

  it("refuses a transaction sent to another contract (another deployment)", async () => {
    const { chain, adapter } = adapterOn()
    const other = H(0xc5)
    chain.setReceipt(other, chain.receiptJson(other, ADDR.client, "0x" + "9".repeat(40), "success", [created()]))
    await assert.rejects(adapter.getInvoiceCreation(other as `0x${string}`), ChainScopeError)
  })

  it("will not attribute a batched or relayed creation: two InvoiceCreated events, or an event client that isn't the sender", async () => {
    const { chain, adapter } = adapterOn()
    const two = H(0xc6)
    chain.setReceipt(two, chain.receiptJson(two, ADDR.client, IA, "success", [created(), created({ invoiceId: BigInt(7) })]))
    assert.equal((await adapter.getInvoiceCreation(two as `0x${string}`)).status, "not_found")
    const relayed = H(0xc7)
    chain.setReceipt(relayed, chain.receiptJson(relayed, ADDR.operator, IA, "success", [created()]))
    assert.equal((await adapter.getInvoiceCreation(relayed as `0x${string}`)).status, "not_found")
    const none = H(0xc8)
    chain.setReceipt(none, chain.receiptJson(none, ADDR.client, IA, "success", []))
    assert.equal((await adapter.getInvoiceCreation(none as `0x${string}`)).status, "not_found")
  })

  it("an RPC that cannot answer is an error, never a guess", async () => {
    const { adapter } = adapterOn({ rpcChainId: 1 })
    await assert.rejects(adapter.getInvoiceCreation(H(0xc9) as `0x${string}`), ChainScopeError)
  })
})

describe("transaction reads: approveAdvance", () => {
  const EVALUATION = computeEvaluationHash({ evaluationId: "e1", submissionId: "s1", criteriaHash: META, score: 95 })
  const txRef = (over: Partial<ChainAdvanceTxRef> = {}): ChainAdvanceTxRef => ({
    txHash: H(0xa1) as `0x${string}`,
    from: ADDR.evaluator as `0x${string}`,
    invoiceId: BigInt(2),
    evaluationHash: EVALUATION,
    submittedAt: 1,
    ...over,
  })
  const paid = (over: Record<string, unknown> = {}) =>
    eventLog("invoiceAdvance", "AdvancePaid", { invoiceId: BigInt(2), freelancer: ADDR.freelancer, amount: BigInt(900000000), evaluationHash: EVALUATION, ...over })

  it("confirmed: mined, from the evaluator, to this contract, with the expected AdvancePaid, and the payout facts are decoded", async () => {
    const { chain, adapter } = adapterOn()
    const r = txRef()
    chain.setReceipt(r.txHash, chain.receiptJson(r.txHash, ADDR.evaluator, IA, "success", [paid()]))
    const s = await adapter.getAdvanceTransaction(r)
    assert.equal(s.state, "confirmed")
    if (s.state !== "confirmed") return
    assert.equal(s.paid.invoiceId, BigInt(2))
    assert.equal(s.paid.amount, BigInt(900000000))
    assert.equal(s.paid.freelancer.toLowerCase(), ADDR.freelancer.toLowerCase())
    assert.equal(s.paid.evaluationHash, EVALUATION)
    assert.equal(s.blockNumber, BigInt(501))
    assert.equal(s.logIndex, 0)
  })

  it("pending (known, not mined) and unknown (not found) are not final", async () => {
    const { chain, adapter } = adapterOn()
    const r = txRef({ txHash: H(0xa2) as `0x${string}` })
    chain.rpcTxs.set(r.txHash, chain.rpcTxFor(r.txHash, { from: ADDR.evaluator, to: IA, data: "0x" }, 1))
    assert.equal((await adapter.getAdvanceTransaction(r)).state, "pending")
    const unknown = await adapter.getAdvanceTransaction(txRef({ txHash: H(0xa3) as `0x${string}` }))
    assert.equal(unknown.state, "unknown")
  })

  it("reverted is reverted", async () => {
    const { chain, adapter } = adapterOn()
    const r = txRef({ txHash: H(0xa4) as `0x${string}` })
    chain.setReceipt(r.txHash, chain.receiptJson(r.txHash, ADDR.evaluator, IA, "reverted", []))
    assert.equal((await adapter.getAdvanceTransaction(r)).state, "reverted")
  })

  it("unverified, never confirmed: wrong sender, wrong contract, no event, or an event for a different evaluation hash", async () => {
    const { chain, adapter } = adapterOn()
    const cases: [string, string, string | null, ReturnType<typeof paid>[]][] = [
      ["wrong sender", ADDR.stranger, IA, [paid()]],
      ["wrong contract", ADDR.evaluator, "0x" + "9".repeat(40), [paid()]],
      ["no event", ADDR.evaluator, IA, []],
      ["different evaluation hash", ADDR.evaluator, IA, [paid({ evaluationHash: H(0xbad) })]],
      ["different invoice", ADDR.evaluator, IA, [paid({ invoiceId: BigInt(3) })]],
    ]
    let n = 0xb0
    for (const [label, from, to, logs] of cases) {
      const r = txRef({ txHash: H(n++) as `0x${string}` })
      chain.setReceipt(r.txHash, chain.receiptJson(r.txHash, from, to, "success", logs))
      const s = await adapter.getAdvanceTransaction(r)
      assert.notEqual(s.state, "confirmed", label)
      assert.equal(s.state, "unverified", label)
    }
  })

  it("a bounded wait (waitMs) still returns a state instead of hanging when nothing is mined", async () => {
    const { adapter } = adapterOn()
    const s = await adapter.getAdvanceTransaction(txRef({ txHash: H(0xa9) as `0x${string}` }), { waitMs: 50 })
    assert.ok(["unknown", "pending"].includes(s.state))
  })

  it("an RPC on another chain is refused", async () => {
    const { adapter } = adapterOn({ rpcChainId: 1 })
    await assert.rejects(adapter.getAdvanceTransaction(txRef()), ChainScopeError)
  })
})

describe("crash recovery: finding an AdvancePaid event", () => {
  it("finds the payout transaction and its sender from the chain's events, and nothing for a different invoice", async () => {
    const { chain, adapter } = adapterOn()
    const hash = H(0xd1)
    const EVALUATION = H(0xe1)
    chain.rpcTxs.set(hash, chain.rpcTxFor(hash, { from: ADDR.evaluator, to: IA, data: "0x" }, 1))
    chain.addLog(eventLog("invoiceAdvance", "AdvancePaid", { invoiceId: BigInt(2), freelancer: ADDR.freelancer, amount: BigInt(900000000), evaluationHash: EVALUATION }), hash)
    const found = await adapter.findAdvancePaid(ref(2))
    assert.ok(found)
    assert.equal(found?.txHash, hash)
    assert.equal(found?.from.toLowerCase(), ADDR.evaluator.toLowerCase())
    assert.equal(found?.evaluationHash, EVALUATION)
    assert.equal(await adapter.findAdvancePaid(ref(4)), null)
  })
})
