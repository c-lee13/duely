import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { EIP1193Provider } from "viem"
import { DomainError } from "@/lib/frontend/errors"
import { setPrivyLogout, setPrivyWalletAccessor } from "@/lib/privy/active-wallet"
import {
  hybridWalletPort,
  notifyPrivyWalletChange,
  signInHybrid,
  signOutHybrid,
} from "@/lib/privy/wallet-port"

const XRPL = "0x161c28" // 1449000
const EMBEDDED_ADDRESS = "0xaBcD000000000000000000000000000000000001"
const INJECTED_ADDRESS = "0xDeAd000000000000000000000000000000000002"

interface MockProviderOpts {
  address: string
  chain?: string
  signature?: string
  rejectSign?: boolean
}

function mockProvider(opts: MockProviderOpts): { provider: EIP1193Provider; requests: { method: string; params?: unknown }[] } {
  const requests: { method: string; params?: unknown }[] = []
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      requests.push({ method, params })
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [opts.address]
        case "eth_chainId":
          return opts.chain ?? XRPL
        case "personal_sign":
          if (opts.rejectSign) throw Object.assign(new Error("rejected"), { code: 4001 })
          return opts.signature ?? "0xdeadbeef"
        default:
          throw new Error(`unexpected ${method}`)
      }
    },
    on: () => undefined,
    removeListener: () => undefined,
  } as unknown as EIP1193Provider
  return { provider, requests }
}

type FetchCall = { url: string; init?: RequestInit }

function mockFetch(responder: (call: FetchCall) => Response | Promise<Response>): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const call: FetchCall = { url, init }
    calls.push(call)
    return responder(call)
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init })

describe("hybrid WalletPort — Privy snapshot active", () => {
  let restoreFetch: () => void = () => undefined
  let logoutCalls = 0

  beforeEach(() => {
    logoutCalls = 0
    setPrivyLogout(async () => {
      logoutCalls += 1
    })
  })
  afterEach(() => {
    restoreFetch()
    setPrivyWalletAccessor(() => null)
    setPrivyLogout(null)
    // Clean up any test-provided injected provider.
    delete (globalThis as { ethereum?: unknown }).ethereum
  })

  it("state() reads chainId and account from the Privy provider, not window.ethereum", async () => {
    const { provider } = mockProvider({ address: EMBEDDED_ADDRESS, chain: XRPL })
    setPrivyWalletAccessor(() => ({
      address: EMBEDDED_ADDRESS.toLowerCase() as `0x${string}`,
      getProvider: async () => provider,
      switchChain: async () => undefined,
    }))
    // Even if there is an injected provider, Privy wins when its accessor returns a snapshot.
    ;(globalThis as { ethereum?: EIP1193Provider }).ethereum = mockProvider({ address: INJECTED_ADDRESS, chain: "0x1" }).provider
    const s = await hybridWalletPort.state()
    assert.equal(s.account?.toLowerCase(), EMBEDDED_ADDRESS.toLowerCase())
    assert.equal(s.chainId, 1449000)
    assert.equal(s.ready, true)
    assert.equal(s.expectedChainId, 1449000)
  })

  it("switchNetwork() delegates to the Privy wallet's switchChain and returns post-switch state", async () => {
    let switched = -1
    const { provider } = mockProvider({ address: EMBEDDED_ADDRESS, chain: XRPL })
    setPrivyWalletAccessor(() => ({
      address: EMBEDDED_ADDRESS.toLowerCase() as `0x${string}`,
      getProvider: async () => provider,
      switchChain: async (chainId: number) => {
        switched = chainId
      },
    }))
    await hybridWalletPort.switchNetwork()
    assert.equal(switched, 1449000)
  })

  it("signInHybrid signs the server-issued challenge via the Privy provider and posts to /verify", async () => {
    const { provider, requests } = mockProvider({ address: EMBEDDED_ADDRESS, chain: XRPL, signature: "0xabc" })
    setPrivyWalletAccessor(() => ({
      address: EMBEDDED_ADDRESS.toLowerCase() as `0x${string}`,
      getProvider: async () => provider,
      switchChain: async () => undefined,
    }))

    const f = mockFetch(async ({ url }) => {
      if (url.endsWith("/api/auth/wallet/challenge")) {
        return json({ nonce: "nonce-1", message: "sign me" })
      }
      if (url.endsWith("/api/auth/wallet/verify")) {
        return json({ userId: "user-1", wallets: [EMBEDDED_ADDRESS.toLowerCase()] })
      }
      return json({ error: { code: "UNEXPECTED" } }, { status: 500 })
    })
    restoreFetch = f.restore

    const result = await signInHybrid()
    assert.equal(result.userId, "user-1")
    assert.deepEqual(result.wallets, [EMBEDDED_ADDRESS.toLowerCase()])

    // Challenge body carries the EMBEDDED address, not any injected one.
    const challengeBody = JSON.parse(String(f.calls[0].init?.body))
    assert.equal(challengeBody.address.toLowerCase(), EMBEDDED_ADDRESS.toLowerCase())

    // personal_sign used Privy's provider with hex-encoded message + address.
    const signCall = requests.find((r) => r.method === "personal_sign")
    assert.ok(signCall, "personal_sign was called on the Privy provider")
    const [messageHex, signerAddress] = signCall.params as [string, string]
    assert.ok(messageHex.startsWith("0x"), "message was hex-encoded")
    assert.equal(signerAddress.toLowerCase(), EMBEDDED_ADDRESS.toLowerCase())

    // Verify payload includes the server-issued nonce and the Privy signature.
    const verifyBody = JSON.parse(String(f.calls[1].init?.body))
    assert.equal(verifyBody.nonce, "nonce-1")
    assert.equal(verifyBody.signature, "0xabc")
  })

  it("signInHybrid maps a signature rejection to USER_REJECTED", async () => {
    const { provider } = mockProvider({ address: EMBEDDED_ADDRESS, rejectSign: true })
    setPrivyWalletAccessor(() => ({
      address: EMBEDDED_ADDRESS.toLowerCase() as `0x${string}`,
      getProvider: async () => provider,
      switchChain: async () => undefined,
    }))
    const f = mockFetch(async ({ url }) => {
      if (url.endsWith("/api/auth/wallet/challenge")) return json({ nonce: "n", message: "m" })
      return json({ error: { code: "SHOULD_NOT_REACH" } }, { status: 500 })
    })
    restoreFetch = f.restore
    await assert.rejects(signInHybrid(), (e: unknown) => e instanceof DomainError && e.code === "USER_REJECTED")
  })

  it("signInHybrid surfaces a /verify failure as UNAUTHENTICATED with the server's apiCode", async () => {
    const { provider } = mockProvider({ address: EMBEDDED_ADDRESS })
    setPrivyWalletAccessor(() => ({
      address: EMBEDDED_ADDRESS.toLowerCase() as `0x${string}`,
      getProvider: async () => provider,
      switchChain: async () => undefined,
    }))
    const f = mockFetch(async ({ url }) => {
      if (url.endsWith("/api/auth/wallet/challenge")) return json({ nonce: "n", message: "m" })
      return json({ error: { code: "SIGNATURE_INVALID", message: "bad sig" } }, { status: 401 })
    })
    restoreFetch = f.restore
    await assert.rejects(signInHybrid(), (e: unknown) => {
      if (!(e instanceof DomainError)) return false
      return e.code === "UNAUTHENTICATED" && e.apiCode === "SIGNATURE_INVALID"
    })
  })

  it("signOutHybrid drops the Privy session before calling the server signout", async () => {
    const order: string[] = []
    setPrivyLogout(async () => {
      order.push("privy")
    })
    const f = mockFetch(async ({ url }) => {
      if (url.endsWith("/api/auth/signout")) {
        order.push("server")
        return json({})
      }
      return json({ error: { code: "UNEXPECTED" } }, { status: 500 })
    })
    restoreFetch = f.restore
    await signOutHybrid()
    assert.deepEqual(order, ["privy", "server"])
  })

  it("notifyPrivyWalletChange fans out to every registered watch listener", () => {
    let a = 0
    let b = 0
    const un1 = hybridWalletPort.watch(() => a++)
    const un2 = hybridWalletPort.watch(() => b++)
    notifyPrivyWalletChange()
    assert.equal(a, 1)
    assert.equal(b, 1)
    un1()
    notifyPrivyWalletChange()
    assert.equal(a, 1)
    assert.equal(b, 2)
    un2()
  })
})

describe("hybrid WalletPort — Privy not active (external wallet path)", () => {
  let restoreFetch: () => void = () => undefined

  beforeEach(() => {
    setPrivyWalletAccessor(() => null)
    setPrivyLogout(null)
  })
  afterEach(() => {
    restoreFetch()
    delete (globalThis as { ethereum?: unknown }).ethereum
  })

  it("signInHybrid falls back to window.ethereum and uses the injected address", async () => {
    const { provider, requests } = mockProvider({ address: INJECTED_ADDRESS, chain: XRPL, signature: "0xfeed" })
    ;(globalThis as { ethereum?: EIP1193Provider }).ethereum = provider

    const f = mockFetch(async ({ url }) => {
      if (url.endsWith("/api/auth/wallet/challenge")) return json({ nonce: "nonce-x", message: "sign" })
      if (url.endsWith("/api/auth/wallet/verify")) return json({ userId: "u", wallets: [INJECTED_ADDRESS.toLowerCase()] })
      return json({ error: { code: "UNEXPECTED" } }, { status: 500 })
    })
    restoreFetch = f.restore

    const result = await signInHybrid()
    assert.equal(result.userId, "u")

    // Injected flow uses eth_requestAccounts (prompts); Privy flow does not.
    assert.ok(requests.some((r) => r.method === "eth_requestAccounts"), "injected path prompts for accounts")

    const challengeBody = JSON.parse(String(f.calls[0].init?.body))
    assert.equal(challengeBody.address.toLowerCase(), INJECTED_ADDRESS.toLowerCase())
  })

  it("signInHybrid without any wallet surfaces NO_WALLET", async () => {
    await assert.rejects(signInHybrid(), (e: unknown) => e instanceof DomainError && e.code === "NO_WALLET")
  })
})
