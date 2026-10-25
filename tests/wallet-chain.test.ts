import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { EIP1193Provider } from "viem"
import { DomainError } from "@/lib/frontend/errors"
import { connectWallet, readWalletState, requireWallet, switchToExpectedChain, watchWallet } from "@/lib/frontend/wallet-chain"
import { createMockChain } from "@/lib/chain/test/mock-chain"

/** A scriptable EIP-1193 provider (what window.ethereum is) that records every request. */
class FakeWallet {
  accounts: string[]
  chain: string
  requests: { method: string; params?: unknown }[] = []
  known = new Set(["0x1"]) // chains MetaMask already has
  listeners = new Map<string, Set<() => void>>()
  rejectNext: { code: number } | null = null
  constructor(accounts: string[] = [], chain = "0x1") {
    this.accounts = accounts
    this.chain = chain
  }
  async request({ method, params }: { method: string; params?: unknown }) {
    this.requests.push({ method, params })
    if (this.rejectNext) {
      const e = Object.assign(new Error("User rejected the request."), this.rejectNext)
      this.rejectNext = null
      throw e
    }
    switch (method) {
      case "eth_accounts":
        return this.accounts
      case "eth_requestAccounts":
        if (this.accounts.length === 0) this.accounts = ["0xAbCd000000000000000000000000000000000001"]
        return this.accounts
      case "eth_chainId":
        return this.chain
      case "wallet_switchEthereumChain": {
        const id = (params as [{ chainId: string }])[0].chainId
        if (!this.known.has(id)) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 })
        this.chain = id
        return null
      }
      case "wallet_addEthereumChain": {
        const id = (params as [{ chainId: string }])[0].chainId
        this.known.add(id)
        this.chain = id
        return null
      }
      default:
        throw new Error(`unexpected ${method}`)
    }
  }
  on(event: string, l: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(l)
  }
  removeListener(event: string, l: () => void) {
    this.listeners.get(event)?.delete(l)
  }
  emit(event: string) {
    this.listeners.get(event)?.forEach((l) => l())
  }
  asProvider() {
    return this as unknown as EIP1193Provider
  }
}

const XRPL = "0x161c28" // 1449000
const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e instanceof DomainError ? e.code : "other"
  }
  return "none"
}

describe("wallet state (read without prompting)", () => {
  it("no wallet installed", async () => {
    const s = await readWalletState(null)
    assert.deepEqual({ a: s.available, ready: s.ready, account: s.account }, { a: false, ready: false, account: null })
  })

  it("reads account and chain with eth_accounts/eth_chainId only, never eth_requestAccounts", async () => {
    const w = new FakeWallet(["0xAbCd000000000000000000000000000000000001"], XRPL)
    const s = await readWalletState(w.asProvider())
    assert.equal(s.account, "0xabcd000000000000000000000000000000000001") // normalised to lower-case
    assert.equal(s.chainId, 1449000)
    assert.equal(s.expectedChainId, 1449000)
    assert.equal(s.ready, true)
    assert.deepEqual(w.requests.map((r) => r.method).sort(), ["eth_accounts", "eth_chainId"])
  })

  it("not ready when connected on the wrong chain, or on the right chain but not connected", async () => {
    assert.equal((await readWalletState(new FakeWallet(["0xAbCd000000000000000000000000000000000001"], "0x1").asProvider())).ready, false)
    assert.equal((await readWalletState(new FakeWallet([], XRPL).asProvider())).ready, false)
  })

  it("reports the configured deployment (symbol/decimals), never one taken from the wallet", async () => {
    const s = await readWalletState(new FakeWallet([], XRPL).asProvider())
    assert.deepEqual({ k: s.deployment.key, sym: s.deployment.symbol, d: s.deployment.decimals }, { k: "dusd", sym: "dUSD", d: 6 })
  })
})

describe("connect and switch network", () => {
  it("connectWallet prompts, then reads the state", async () => {
    const w = new FakeWallet([], XRPL)
    const s = await connectWallet(w.asProvider())
    assert.equal(s.ready, true)
    assert.ok(w.requests.some((r) => r.method === "eth_requestAccounts"))
  })

  it("a refused connection is USER_REJECTED, not a crash", async () => {
    const w = new FakeWallet([], XRPL)
    w.rejectNext = { code: 4001 }
    assert.equal(await code(connectWallet(w.asProvider())), "USER_REJECTED")
  })

  it("no wallet at all is NO_WALLET", async () => {
    assert.equal(await code(connectWallet(null)), "NO_WALLET")
    assert.equal(await code(switchToExpectedChain(null)), "NO_WALLET")
  })

  it("switches to XRPL EVM Testnet when the wallet knows it", async () => {
    const w = new FakeWallet(["0xAbCd000000000000000000000000000000000001"], "0x1")
    w.known.add(XRPL)
    const s = await switchToExpectedChain(w.asProvider())
    assert.equal(s.chainId, 1449000)
    assert.ok(!w.requests.some((r) => r.method === "wallet_addEthereumChain"))
  })

  it("adds the network (with the right id, currency, RPC and explorer) when the wallet does not know it", async () => {
    const w = new FakeWallet(["0xAbCd000000000000000000000000000000000001"], "0x1")
    const s = await switchToExpectedChain(w.asProvider())
    assert.equal(s.ready, true)
    const add = w.requests.find((r) => r.method === "wallet_addEthereumChain")
    const p = (add?.params as [Record<string, unknown>])[0]
    assert.equal(p.chainId, XRPL)
    assert.deepEqual(p.nativeCurrency, { name: "XRP", symbol: "XRP", decimals: 18 })
    assert.deepEqual(p.blockExplorerUrls, ["https://explorer.testnet.xrplevm.org"])
    assert.match((p.rpcUrls as string[])[0], /^https:\/\/rpc\.testnet\.xrplevm\.org/)
    assert.doesNotMatch(JSON.stringify(p), /quiknode|secret|key/i, "only the public RPC is ever given to a wallet")
  })

  it("declining the switch is USER_REJECTED", async () => {
    const w = new FakeWallet(["0xAbCd000000000000000000000000000000000001"], "0x1")
    w.known.add(XRPL)
    w.rejectNext = { code: 4001 }
    assert.equal(await code(switchToExpectedChain(w.asProvider())), "USER_REJECTED")
  })
})

describe("requireWallet: the gate in front of every transaction", () => {
  const ACCOUNT = "0xabcd000000000000000000000000000000000001"
  const publicClient = createMockChain().publicClient

  it("passes when connected, on the right chain and on the expected account (case-insensitive)", async () => {
    const w = new FakeWallet([ACCOUNT], XRPL)
    const ctx = await requireWallet({ provider: w.asProvider(), expectedAccount: ACCOUNT.toUpperCase().replace("0X", "0x"), publicClient })
    assert.equal(ctx.account, ACCOUNT)
    assert.ok(ctx.wallet)
  })

  it("refuses with a specific reason: no wallet, not connected, wrong network, wrong account", async () => {
    assert.equal(await code(requireWallet({ provider: null })), "NO_WALLET")
    assert.equal(await code(requireWallet({ provider: new FakeWallet([], XRPL).asProvider() })), "WALLET_NOT_CONNECTED")
    assert.equal(await code(requireWallet({ provider: new FakeWallet([ACCOUNT], "0x1").asProvider() })), "WRONG_NETWORK")
    const other = new FakeWallet([ACCOUNT], XRPL)
    assert.equal(await code(requireWallet({ provider: other.asProvider(), expectedAccount: "0x" + "9".repeat(40) })), "WRONG_ACCOUNT")
  })

  it("the wrong-account message names the required and the selected account so the user can switch", async () => {
    const w = new FakeWallet([ACCOUNT], XRPL)
    await assert.rejects(requireWallet({ provider: w.asProvider(), expectedAccount: "0x" + "9".repeat(40) }), (e: Error) => {
      assert.match(e.message, new RegExp("9".repeat(40)))
      assert.match(e.message, new RegExp(ACCOUNT))
      return true
    })
  })

  it("never prompts: only read requests are made while checking", async () => {
    const w = new FakeWallet([ACCOUNT], XRPL)
    await requireWallet({ provider: w.asProvider(), publicClient })
    assert.ok(w.requests.every((r) => ["eth_accounts", "eth_chainId"].includes(r.method)))
  })
})

describe("watchWallet", () => {
  it("notifies on account and network changes and stops after unsubscribe", () => {
    const w = new FakeWallet([], XRPL)
    let n = 0
    const off = watchWallet(() => n++, w.asProvider())
    w.emit("accountsChanged")
    w.emit("chainChanged")
    assert.equal(n, 2)
    off()
    w.emit("accountsChanged")
    assert.equal(n, 2)
  })

  it("is a no-op without a wallet", () => {
    assert.doesNotThrow(() => watchWallet(() => undefined, null)())
  })
})
