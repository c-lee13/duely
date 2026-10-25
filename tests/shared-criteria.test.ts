import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { keccak256, toBytes } from "viem"
import * as backend from "@/lib/backend/criteria"
import { criteriaDigest, mockCriteriaDigest } from "@/lib/frontend/criteria-digest"
import * as shared from "@/lib/shared/criteria"
import { createInvoice } from "@/lib/chain/writes"
import { ADDR, createMockChain } from "@/lib/chain/test/mock-chain"

/**
 * Deterministic test vectors for the canonical criteria encoding. These values are FROZEN: if one changes, every
 * invoice already committed on-chain would stop verifying. They were also reproduced independently with
 * `cast keccak '<canonical string>'` (Foundry), which matches the hashes below byte for byte.
 */
const V1 = [
  { id: "c1", text: "Logo delivered", mandatory: true },
  { id: "c2", text: "Source files included", mandatory: false },
]
const V1_STRING = '{"v":1,"criteria":[{"id":"c1","text":"Logo delivered","mandatory":true},{"id":"c2","text":"Source files included","mandatory":false}]}'
const V1_HASH = "0x798688a068be344ed04c1e6bcdfdf9e8a1f5c6da80d7bd0050671c166a3f3160"

const V2 = [{ id: "x", text: "café — résumé \u{1F680}", mandatory: true }] // decomposed é, em dash, emoji
const V2_STRING = '{"v":1,"criteria":[{"id":"x","text":"café — résumé 🚀","mandatory":true}]}'
const V2_HASH = "0xb0735c9f2ddced01290b724e7eb3059a48676d3250659e93d25836419e83e5ae"

const V3 = [
  { id: "a", text: "  padded  ", mandatory: true },
  { id: "b", text: 'Quote " and backslash \\ and newline\n', mandatory: false },
]
const V3_HASH = "0x749334b6cfbdecd5a35b0fa78654c39c6644e5063abeea6915671fb55186e4fe"

describe("shared criteria hash: frozen vectors", () => {
  it("vector 1: exact canonical string and Keccak-256", () => {
    assert.equal(shared.canonicalCriteriaString(V1), V1_STRING)
    assert.equal(shared.computeCriteriaHash(V1), V1_HASH)
    assert.equal(keccak256(toBytes(V1_STRING)), V1_HASH, "hash = keccak256 over the UTF-8 bytes of the canonical string")
  })

  it("vector 2: Unicode is NFC-normalized before hashing (decomposed and precomposed agree)", () => {
    assert.equal(shared.canonicalCriteriaString(V2), V2_STRING)
    assert.equal(shared.computeCriteriaHash(V2), V2_HASH)
    const precomposed = [{ id: "x", text: "café — résumé \u{1F680}", mandatory: true }]
    assert.equal(shared.computeCriteriaHash(precomposed), V2_HASH)
  })

  it("vector 3: surrounding whitespace is trimmed; quotes, backslashes and newlines are JSON-escaped", () => {
    assert.equal(shared.computeCriteriaHash(V3), V3_HASH)
    assert.equal(shared.computeCriteriaHash([{ ...V3[0], text: "padded" }, V3[1]]), V3_HASH)
  })

  it("order, text, id and the mandatory flag are all part of the commitment", () => {
    const h = shared.computeCriteriaHash(V1)
    assert.notEqual(shared.computeCriteriaHash([V1[1], V1[0]]), h, "order matters")
    assert.notEqual(shared.computeCriteriaHash([{ ...V1[0], mandatory: false }, V1[1]]), h)
    assert.notEqual(shared.computeCriteriaHash([{ ...V1[0], text: "Logo delivered!" }, V1[1]]), h)
    assert.notEqual(shared.computeCriteriaHash([{ ...V1[0], id: "c9" }, V1[1]]), h)
  })

  it("input key order and extra fields cannot change the hash", () => {
    const shuffled = V1.map((c) => ({ mandatory: c.mandatory, text: c.text, id: c.id, extra: "ignored" }))
    assert.equal(shared.computeCriteriaHash(shuffled), V1_HASH)
  })

  it("is a lower-case 0x-prefixed 32-byte hex and never the zero hash the contract rejects", () => {
    for (const v of [V1, V2, V3]) {
      const h = shared.computeCriteriaHash(v)
      assert.match(h, /^0x[0-9a-f]{64}$/)
      assert.notEqual(h, "0x" + "0".repeat(64))
    }
  })
})

describe("there is exactly one implementation", () => {
  it("the backend module re-exports the shared functions (same references)", () => {
    assert.equal(backend.computeCriteriaHash, shared.computeCriteriaHash)
    assert.equal(backend.canonicalCriteriaString, shared.canonicalCriteriaString)
    assert.equal(backend.normalizeCriteria, shared.normalizeCriteria)
    assert.equal(backend.CRITERIA_ENCODING_VERSION, 1)
  })

  it("the frontend digest equals the shared hash for the same criteria (the browser commits what the server verifies)", () => {
    assert.equal(criteriaDigest(1, V1), V1_HASH)
    assert.equal(mockCriteriaDigest(7, V1), V1_HASH, "the criteria version is stored next to the hash, not hashed")
  })

  it("metadataHash is the same bytes as the criteria hash", () => {
    assert.equal(shared.computeMetadataHash(V1), V1_HASH)
  })
})

describe("compatible with the contract and the SDK", () => {
  it("the SDK's createInvoice accepts the hash as metadataHash and encodes it unchanged in the transaction", async () => {
    const chain = createMockChain()
    const submitted = await createInvoice(
      { freelancer: ADDR.freelancer, amount: BigInt(1000), metadataHash: shared.computeMetadataHash(V1) },
      { wallet: chain.walletFor(ADDR.client), publicClient: chain.publicClient }
    )
    const sent = chain.sent[chain.sent.length - 1]
    assert.ok(sent.data.toLowerCase().includes(V1_HASH.slice(2)), "the exact 32 bytes are in the calldata")
    assert.equal(submitted.expected.args.metadataHash, V1_HASH)
  })
})
