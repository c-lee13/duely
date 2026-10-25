import assert from "node:assert/strict"
import fs from "node:fs"
import { afterEach, describe, it } from "node:test"
import { decodeFunctionData } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createEvaluatorSignerFromEnv, createSignerFromWallet, describeSignerAvailability } from "@/lib/backend/advance-signer"
import { activeDeploymentScope } from "@/lib/backend/scope"
import { ChainScopeError, type ChainInvoiceRef } from "@/lib/backend/ports"
import { contractAddresses } from "@/lib/chain/config"
import { getDeployment, setDeploymentOverrideForTests } from "@/lib/chain/deployments"
import { invoiceAdvanceAbi } from "@/lib/chain/generated"
import { submissionGuard } from "@/lib/chain/writes"
import { ADDR, EVAL, createMockChain } from "@/lib/chain/test/mock-chain"

/**
 * The server-side evaluator signer. The mock chain evaluates InvoiceAdvance's real rules (role, status, reserve) on
 * eth_call, so a signer that would revert on the real contract fails here before anything is "sent".
 */
const scope = activeDeploymentScope()
const IA = contractAddresses.invoiceAdvance
const ref = (id: number | bigint, over: Partial<ChainInvoiceRef> = {}): ChainInvoiceRef => ({ chainId: scope.chainId, contractAddress: IA, invoiceId: BigInt(id), ...over })

function signerOn(address: string = ADDR.evaluator, options: Parameters<typeof createMockChain>[0] = {}) {
  submissionGuard.reset() // the SDK's duplicate guard is process-wide by design
  const chain = createMockChain(options)
  const signer = createSignerFromWallet({ wallet: chain.walletFor(address), address: address as `0x${string}`, publicClient: chain.publicClient, scope })
  return { chain, signer }
}

afterEach(() => setDeploymentOverrideForTests(null))

describe("createSignerFromWallet: what it signs and what it refuses", () => {
  it("sends approveAdvance(invoiceId, evaluationHash) from the evaluator and returns the hash without claiming confirmation", async () => {
    const { chain, signer } = signerOn()
    const out = await signer.submitApproveAdvance(ref(2), EVAL)
    assert.match(out.txHash, /^0x[0-9a-f]{64}$/)
    assert.equal(out.from.toLowerCase(), ADDR.evaluator.toLowerCase())
    assert.equal(chain.sent.length, 1)
    const tx = chain.sent[0]
    assert.equal(tx.to.toLowerCase(), IA.toLowerCase())
    assert.equal(tx.from.toLowerCase(), ADDR.evaluator.toLowerCase())
    const decoded = decodeFunctionData({ abi: invoiceAdvanceAbi, data: tx.data })
    assert.equal(decoded.functionName, "approveAdvance")
    assert.deepEqual(decoded.args, [BigInt(2), EVAL])
    assert.equal(chain.rpc.filter((r) => r.method === "eth_getTransactionReceipt").length, 0, "the signer never waits for or reads a receipt")
  })

  it("refuses an invoice reference from another deployment, before reading or sending anything", async () => {
    const { chain, signer } = signerOn()
    for (const bad of [ref(2, { contractAddress: ("0x" + "9".repeat(40)) as `0x${string}` }), ref(2, { chainId: 1 }), ref(2, { chainId: 0 })]) {
      await assert.rejects(signer.submitApproveAdvance(bad, EVAL), ChainScopeError)
    }
    assert.equal(chain.sent.length, 0)
    assert.equal(chain.rpc.length, 0)
  })

  it("refuses when the account does not hold EVALUATOR_ROLE on-chain right now", async () => {
    const { chain, signer } = signerOn(ADDR.client) // a real account, but not the evaluator
    await assert.rejects(signer.submitApproveAdvance(ref(2), EVAL), /EVALUATOR_ROLE/)
    assert.equal(chain.sent.length, 0)
  })

  it("never broadcasts a call the contract would reject: wrong status, missing invoice, insufficient reserve", async () => {
    for (const [label, id, setup] of [
      ["Created (unfunded)", 1, () => undefined],
      ["already Advanced", 3, () => undefined],
      ["Settled", 5, () => undefined],
      ["Disputed", 4, () => undefined],
      ["missing", 999, () => undefined],
    ] as const) {
      void setup
      const { chain, signer } = signerOn()
      await assert.rejects(signer.submitApproveAdvance(ref(id), EVAL), /approveAdvance not sent/, label)
      assert.equal(chain.sent.length, 0, label)
    }
    const { chain, signer } = signerOn()
    chain.state.reserve = BigInt(1) // far below the 90% advance
    await assert.rejects(signer.submitApproveAdvance(ref(2), EVAL), /INSUFFICIENT|InsufficientReserve|SIMULATION/)
    assert.equal(chain.sent.length, 0)
  })

  it("blocks an identical in-process duplicate until the first is mined (no double broadcast from one process)", async () => {
    const { chain, signer } = signerOn()
    await signer.submitApproveAdvance(ref(2), EVAL)
    await assert.rejects(signer.submitApproveAdvance(ref(2), EVAL), /DUPLICATE_SUBMISSION/)
    assert.equal(chain.sent.length, 1)
  })

  it("a send failure is an error (never retried, never reported as success) and its message holds no RPC URL", async () => {
    const { chain, signer } = signerOn()
    chain.send.mode = "fail"
    await assert.rejects(signer.submitApproveAdvance(ref(2), EVAL), (e: Error) => {
      assert.match(e.message, /approveAdvance not sent/)
      assert.doesNotMatch(e.message, /https?:\/\/|wallet-node|KEY/)
      return true
    })
    assert.equal(chain.send.attempts, 1, "exactly one attempt: no automatic retry")
    assert.equal(chain.sent.length, 0)
  })
})

describe("createEvaluatorSignerFromEnv: key handling", () => {
  const withEvaluator = (address: string) => {
    const base = getDeployment("dusd")
    setDeploymentOverrideForTests({ ...base, roles: { ...base.roles, evaluator: address as `0x${string}` } })
  }

  it("no key, a malformed key, or a key for the wrong account all yield the explicit UNAVAILABLE signer (no mock, no fallback)", () => {
    const own = privateKeyToAccount(generatePrivateKey())
    withEvaluator(own.address)
    for (const env of [{}, { EVALUATOR_PRIVATE_KEY: "" }, { EVALUATOR_PRIVATE_KEY: "not-a-key" }, { EVALUATOR_PRIVATE_KEY: "0x1234" }, { EVALUATOR_PRIVATE_KEY: generatePrivateKey() }]) {
      const s = createEvaluatorSignerFromEnv(scope, env)
      assert.equal(s.available, false)
      assert.equal(s.address, null)
    }
  })

  it("the deployment's own evaluator key makes the signer available, with that address", () => {
    const key = generatePrivateKey()
    const account = privateKeyToAccount(key)
    withEvaluator(account.address)
    const chain = createMockChain()
    const s = createEvaluatorSignerFromEnv(scope, { EVALUATOR_PRIVATE_KEY: key }, { publicClient: chain.publicClient })
    assert.equal(s.available, true)
    assert.equal(s.address, account.address)
  })

  it("describeSignerAvailability reports why, without leaking the key", () => {
    const key = generatePrivateKey()
    withEvaluator(privateKeyToAccount(key).address)
    assert.equal(describeSignerAvailability({}), "no-key")
    assert.equal(describeSignerAvailability({ EVALUATOR_PRIVATE_KEY: "zz" }), "malformed-key")
    assert.equal(describeSignerAvailability({ EVALUATOR_PRIVATE_KEY: generatePrivateKey() }), "wrong-account")
    assert.equal(describeSignerAvailability({ EVALUATOR_PRIVATE_KEY: key }), "ready-to-check")
  })

  it("the key is not retrievable from the signer, not serialized, and not in any error message", async () => {
    const key = generatePrivateKey()
    const account = privateKeyToAccount(key)
    withEvaluator(account.address)
    const chain = createMockChain()
    const s = createEvaluatorSignerFromEnv(scope, { EVALUATOR_PRIVATE_KEY: key }, { publicClient: chain.publicClient, walletFor: () => chain.walletFor(account.address) })
    assert.ok(!JSON.stringify(s).includes(key.slice(2)))
    assert.ok(!Object.values(s).some((v) => typeof v === "string" && v.includes(key.slice(2))))
    submissionGuard.reset()
    await assert.rejects(s.submitApproveAdvance(ref(1), EVAL), (e: Error) => {
      assert.ok(!e.message.includes(key.slice(2)))
      return true
    })
  })
})

describe("secrets stay on the server", () => {
  const read = (p: string) => fs.readFileSync(p, "utf8")

  it("the signer module is server-only, and only the backend wiring imports it", () => {
    assert.match(read("lib/backend/advance-signer.ts"), /^import "server-only"/)
    const importers: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".next", "contracts", ".git"].includes(e.name)) continue
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name) && /advance-signer/.test(read(p)) && !p.startsWith("./tests/") && !p.endsWith("advance-signer.ts")) importers.push(p)
      }
    }
    walk(".")
    assert.deepEqual(importers, ["./lib/backend/server.ts"])
  })

  it("no NEXT_PUBLIC_ variable can carry the key, and the key variable is only read by the signer module", () => {
    for (const f of [".env.example", "lib/backend/advance-signer.ts"]) assert.doesNotMatch(read(f), /NEXT_PUBLIC_[A-Z_]*PRIVATE_KEY/, f)
    const readers: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".next", "contracts", ".git", "tests", "docs"].includes(e.name)) continue
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx|mjs)$/.test(e.name) && /EVALUATOR_PRIVATE_KEY/.test(read(p))) readers.push(p)
      }
    }
    walk(".")
    // the signer module reads it; the integration scripts' own keystores/docs may name it in text only
    assert.ok(readers.includes("./lib/backend/advance-signer.ts"))
    assert.ok(!readers.some((p) => p.startsWith("./app") || p.startsWith("./components") || p.startsWith("./hooks") || p.startsWith("./lib/frontend")))
  })

  it("the signer never logs", () => {
    assert.doesNotMatch(read("lib/backend/advance-signer.ts"), /console\./)
  })
})
