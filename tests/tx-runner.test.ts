import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { contractAddresses } from "@/lib/chain/config"
import { getDeployment, getRegisteredToken, setDeploymentOverrideForTests } from "@/lib/chain/deployments"
import { parseSubmittedTransaction } from "@/lib/chain/lifecycle"
import { ADDR, allowanceKey, createMockChain, eventLog } from "@/lib/chain/test/mock-chain"
import { fundInvoice, submissionGuard } from "@/lib/chain/writes"
import type { Address } from "@/lib/frontend/domain"
import { DomainError } from "@/lib/frontend/errors"
import { TxLog } from "@/lib/frontend/tx-log"
import { runTransaction, type TxProgress } from "@/lib/frontend/tx-runner"

const IA = contractAddresses.invoiceAdvance
const AMOUNT = BigInt(1000000000)

class MemoryStorage {
  data = new Map<string, string>()
  getItem(k: string) {
    return this.data.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.data.set(k, v)
  }
}

function setup(options: Parameters<typeof createMockChain>[0] = {}) {
  submissionGuard.reset()
  const chain = createMockChain(options)
  chain.state.allowances.set(allowanceKey(ADDR.client, IA), AMOUNT)
  const ctx = { wallet: chain.walletFor(ADDR.client), publicClient: chain.publicClient }
  const storage = new MemoryStorage()
  const log = new TxLog(storage)
  const progress: TxProgress[] = []
  const fundedLog = () => eventLog("invoiceAdvance", "InvoiceFunded", { invoiceId: BigInt(1), client: ADDR.client, amount: AMOUNT })
  const run = (over: Partial<Parameters<typeof runTransaction>[0]> = {}) =>
    runTransaction({
      label: "Fund escrow",
      action: "fundInvoice",
      from: ADDR.client.toLowerCase() as Address,
      invoiceId: "1",
      ctx,
      submit: () => fundInvoice(1, ctx),
      log,
      onProgress: (p) => progress.push(p),
      timeoutMs: 2000,
      ...over,
    })
  return { chain, ctx, storage, log, progress, run, fundedLog }
}

afterEach(() => setDeploymentOverrideForTests(null))

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e instanceof DomainError ? e.code : `other:${String(e)}`
  }
  return "none"
}

describe("runTransaction: only a verified outcome is a result", () => {
  it("awaiting wallet -> pending (with hash and explorer link) -> confirmed, logged and returned", async () => {
    const t = setup()
    // The moment the wallet returns a hash, the chain "mines" it with the expected event.
    const results: string[] = []
    const out = await t.run({
      onProgress: (p) => {
        t.progress.push(p)
        results.push(p.status)
        if (p.status === "pending") t.chain.mine(p.txHash!, "success", [t.fundedLog()])
      },
    })
    assert.deepEqual(results, ["awaiting_wallet", "pending", "confirmed"])
    const pending = t.progress.find((p) => p.status === "pending")!
    assert.match(pending.txHash ?? "", /^0x[0-9a-f]{64}$/)
    assert.equal(pending.explorerUrl, `https://explorer.testnet.xrplevm.org/tx/${pending.txHash}`)
    assert.equal(out.state, "confirmed")
    assert.equal(out.verified, true)
    assert.equal(out.invoiceId, "1")
    const entry = t.log.find(pending.txHash!)!
    assert.deepEqual({ s: entry.status, a: entry.action, i: entry.invoiceId, b: entry.blockNumber }, { s: "confirmed", a: "fundInvoice", i: "1", b: "501" })
  })

  it("a pending transaction that never confirms is TX_UNCONFIRMED (never success, never 'failed'), and is logged as unknown", async () => {
    const t = setup()
    assert.equal(await codeOf(t.run({ timeoutMs: 60 })), "TX_UNCONFIRMED")
    const last = t.progress.at(-1)!
    assert.equal(last.status, "unknown")
    assert.match(last.error ?? "", /Do not send it twice/)
    assert.equal(t.log.list()[0].status, "unknown")
    assert.ok(!t.progress.some((p) => p.status === "confirmed"))
  })

  it("a reverted transaction is TX_FAILED and logged failed; nothing is reported done", async () => {
    const t = setup()
    const res = t.run({
      onProgress: (p) => {
        t.progress.push(p)
        if (p.status === "pending") t.chain.mine(p.txHash!, "reverted", [])
      },
    })
    assert.equal(await codeOf(res), "TX_FAILED")
    assert.equal(t.progress.at(-1)!.status, "failed")
    assert.equal(t.log.list()[0].status, "failed")
    assert.match(t.log.list()[0].error ?? "", /Nothing was changed/)
  })

  it("a 'successful' receipt WITHOUT the expected event is not a success", async () => {
    const t = setup()
    const res = t.run({
      onProgress: (p) => {
        t.progress.push(p)
        if (p.status === "pending") t.chain.mine(p.txHash!, "success", []) // mined, but no InvoiceFunded
      },
    })
    assert.equal(await codeOf(res), "TX_FAILED")
    assert.ok(!t.progress.some((p) => p.status === "confirmed"))
    assert.equal(t.log.list()[0].status, "failed")
  })

  it("a wallet rejection is USER_REJECTED and leaves no log entry and no hash", async () => {
    const t = setup()
    t.chain.send.mode = "reject"
    assert.equal(await codeOf(t.run()), "USER_REJECTED")
    assert.deepEqual(t.progress.map((p) => p.status), ["awaiting_wallet", "failed"])
    assert.equal(t.log.list().length, 0)
  })

  it("a send failure is TX_UNCONFIRMED (it may have been broadcast), is not retried, and holds no RPC URL", async () => {
    const t = setup()
    t.chain.send.mode = "fail"
    await assert.rejects(t.run(), (e: DomainError) => {
      assert.equal(e.code, "TX_UNCONFIRMED")
      assert.doesNotMatch(e.message, /https?:\/\//)
      return true
    })
    assert.equal(t.chain.send.attempts, 1)
    assert.equal(t.log.list().length, 0)
  })

  it("a wallet on the wrong chain is WRONG_NETWORK before anything is sent", async () => {
    submissionGuard.reset()
    const chain = createMockChain()
    chain.state.allowances.set(allowanceKey(ADDR.client, IA), AMOUNT)
    const ctx = { wallet: chain.walletFor(ADDR.client, { chainId: 1 }), publicClient: chain.publicClient }
    const code = await codeOf(runTransaction({ label: "Fund escrow", action: "fundInvoice", from: ADDR.client as Address, ctx, submit: () => fundInvoice(1, ctx) }))
    assert.equal(code, "WRONG_NETWORK")
    assert.equal(chain.sent.length, 0)
  })

  it("the SDK's pre-flight failures keep their reason: missing allowance and a paused token", async () => {
    const t = setup()
    t.chain.state.allowances.clear()
    assert.equal(await codeOf(t.run()), "INSUFFICIENT_BALANCE")
    const p = setup({ tokenPaused: true })
    assert.equal(await codeOf(p.run()), "TOKEN_PAUSED") // the issuer's pause is surfaced as such, not as a generic failure
    assert.equal(p.chain.sent.length, 0)
  })

  it("an in-browser double click cannot submit an identical transaction twice", async () => {
    const t = setup()
    const first = t.run({
      onProgress: (p) => {
        if (p.status === "pending") t.chain.mine(p.txHash!, "success", [t.fundedLog()])
      },
    })
    assert.equal(await codeOf(t.run()), "DUPLICATE_REQUEST")
    await first
    assert.equal(t.chain.sent.length, 1)
  })
})

describe("transaction log", () => {
  it("survives a reload: a new log over the same storage sees the entry, and tracking can resume from it", async () => {
    const t = setup()
    await t
      .run({
        onProgress: (p) => {
          if (p.status === "pending") t.chain.mine(p.txHash!, "success", [t.fundedLog()])
        },
      })
      .catch(() => undefined)
    const reloaded = new TxLog(t.storage)
    const entry = reloaded.list(ADDR.client)[0]
    assert.equal(entry.action, "fundInvoice")
    const restored = parseSubmittedTransaction(entry.serialized)
    assert.equal(restored.hash, entry.hash)
    assert.equal(restored.functionName, "fundInvoice")
    assert.equal(restored.deployment?.key, "dusd")
  })

  it("is scoped to the active deployment: a dUSD entry is invisible under RLUSD and cannot be restored there", async () => {
    const t = setup()
    await t.run({ timeoutMs: 40 }).catch(() => undefined)
    const dusdEntry = t.log.list()[0]
    assert.ok(dusdEntry)
    setDeploymentOverrideForTests({ ...getDeployment("dusd"), key: "rlusd", token: getRegisteredToken("rlusd") })
    const underRlusd = new TxLog(t.storage)
    assert.deepEqual(underRlusd.list(), [])
    assert.throws(() => parseSubmittedTransaction(dusdEntry.serialized), (e: Error) => /deployment/i.test(e.message))
  })

  it("filters by wallet, is newest-first, updates entries in place, and survives corrupted storage", () => {
    const storage = new MemoryStorage()
    const log = new TxLog(storage)
    const mk = (n: number, from: string) => ({ hash: ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`, label: `t${n}`, action: "fundInvoice" as const, from: from as Address, createdAt: n, status: "pending" as const, serialized: "{}" })
    log.add(mk(1, ADDR.client))
    log.add(mk(2, ADDR.operator))
    log.add(mk(3, ADDR.client))
    assert.deepEqual(log.list(ADDR.client).map((e) => e.label), ["t3", "t1"])
    log.update(mk(1, "").hash, { status: "confirmed", blockNumber: "9" })
    assert.equal(log.find(mk(1, "").hash)?.status, "confirmed")
    storage.setItem("duely.txlog.v1:dusd", "{not json")
    assert.deepEqual(new TxLog(storage).list(), [])
    assert.doesNotThrow(() => new TxLog(null).add(mk(9, ADDR.client)))
  })
})
