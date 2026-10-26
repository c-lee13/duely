import "./helpers/v2-env" // must stay first: selects the v2 deployment before configuration is read
import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import { createChainAdapter, type AdapterClient } from "@/lib/backend/chain-adapter"
import { activeDeploymentScope } from "@/lib/backend/scope"
import { ChainScopeError } from "@/lib/backend/ports"
import { activeDeployment, contractAddresses } from "@/lib/chain/config"
import { approveAdvance, approveCompletion, ChainWriteError, decodeV2Events, raiseDispute, resolveDispute, submissionGuard, waitForConfirmation, type ChainWriteClient, type WriteContext } from "@/lib/chain"
import { createEvaluatorSignerFromEnv, createSignerFromWallet } from "@/lib/backend/advance-signer"
import { ApiDuelyRepository, type WalletPort } from "@/lib/frontend/api-repository"
import { DomainError } from "@/lib/frontend/errors"
import { TxLog } from "@/lib/frontend/tx-log"
import type { TxProgress } from "@/lib/frontend/tx-runner"
import { settlementProjection, getAdvanceEligibility } from "@/lib/frontend/eligibility"
import { advanceFeeFor, fundingCopy, v2Active } from "@/lib/frontend/protocol-copy"
import { figuresFor } from "@/lib/frontend/api-mappers"
import type { InvoiceDetail } from "@/lib/frontend/domain"
import { A, E18, RL, V2Sim } from "./helpers/v2-sim"

/**
 * V2 integration, through the real SDK, receipt verification, backend chain adapter and browser repository, against an
 * in-memory model of DuelyVault + InvoiceAdvanceV2 (the contracts themselves are covered by the Foundry suite).
 */
const lc = (s: string) => s.toLowerCase()
let sim: V2Sim
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e instanceof DomainError ? e.code : `other:${String(e)}`
  }
  return "none"
}

function publicClientFor(s: V2Sim, account: string) {
  const mined = new Map<string, unknown>()
  const receipt = (hash: `0x${string}`) => {
    if (!mined.has(hash)) mined.set(hash, s.mine(hash))
    return mined.get(hash)
  }
  return {
    getChainId: async () => s.chainId,
    getBlockNumber: async () => s.head,
    readContract: async (p: { address: string; functionName: string; args?: readonly unknown[] }) => s.read(p),
    simulateContract: async (p: { address: string; functionName: string; args?: readonly unknown[] }) => {
      s.check(account, p.address, p.functionName, p.args ?? [])
      return { request: { ...p } }
    },
    getTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
      if (!mined.has(hash)) throw new Error("not found")
      return mined.get(hash)
    },
    getTransaction: async () => ({}),
    waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => receipt(hash),
  } as unknown as ChainWriteClient & AdapterClient
}

function repoFor(s: V2Sim, account: string, o: { authed?: boolean; walletError?: DomainError } = {}) {
  const publicClient = publicClientFor(s, account)
  const wallet = {
    account: { address: account },
    chain: undefined,
    getChainId: async () => s.chainId,
    writeContract: async (req: { address: string; functionName: string; args: readonly unknown[] }) => {
      if (s.hold) await s.hold
      return s.send(account, req.address, req.functionName, req.args)
    },
  }
  const port: WalletPort = {
    require: async () => {
      if (o.walletError) throw o.walletError
      return { wallet, publicClient, account: lc(account) } as never
    },
    state: async () => ({ available: true, account: lc(account), chainId: s.chainId, expectedChainId: 1449000, ready: true, deployment: { key: "v2", symbol: "RLUSD", decimals: 18, isDemoToken: false } }) as never,
    connect: async () => ({}) as never,
    switchNetwork: async () => ({}) as never,
    watch: () => () => undefined,
  }
  const fetchFake = (async (url: string) => {
    if (String(url).includes("/api/auth/session")) {
      return new Response(JSON.stringify(o.authed === false ? { authenticated: false, wallets: [] } : { authenticated: true, wallets: [lc(account)] }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no" } }), { status: 404 })
  }) as unknown as typeof fetch
  return new ApiDuelyRepository({ fetch: fetchFake, wallet: port, readClient: publicClient as never, txLog: new TxLog(null, () => "v2"), storage: null, sleep: async () => undefined, txTimeoutMs: 5000 })
}

beforeEach(() => {
  submissionGuard.reset()
  sim = new V2Sim()
  sim.balances.set(lc(A.lp), RL(10_000))
  sim.balances.set(lc(A.client), RL(5_000))
})

const steps = (p: TxProgress[]) => p.map((x) => `${x.label}:${x.status}`)

describe("v2 configuration", () => {
  it("is selected through the deployment key: RLUSD, chain 1449000, escrow = InvoiceAdvanceV2, vault present", () => {
    const d = activeDeployment()
    assert.equal(d.key, "v2")
    assert.equal(d.chainId, 1449000)
    assert.equal(d.token.symbol, "RLUSD")
    assert.equal(d.token.isDemoToken, false)
    assert.equal(contractAddresses.invoiceAdvance, "0x2E1598D6DBDa061EB6CafCa5D7AEe1630A04Ba96")
    assert.equal(d.vault?.address, "0x5f8B53B32acab32F8c283CB40a4B7ac04792B6E8")
    assert.equal(v2Active(), true)
    const scope = activeDeploymentScope()
    assert.equal(scope.contractAddress.toLowerCase(), "0x2e1598d6dbda061eb6cafca5d7aee1630a04ba96")
  })
})

describe("LP deposits, shares and withdrawal limits", () => {
  it("deposit approves exactly the amount, then deposits; both steps show verified confirmations in order", async () => {
    const repo = repoFor(sim, A.lp)
    const progress: TxProgress[] = []
    await repo.vault!.deposit(RL(4000).toString(), (p) => progress.push(p))
    assert.deepEqual(steps(progress), [
      "Approve RLUSD for the vault:awaiting_wallet", "Approve RLUSD for the vault:pending", "Approve RLUSD for the vault:confirmed",
      "Deposit to vault:awaiting_wallet", "Deposit to vault:pending", "Deposit to vault:confirmed",
    ])
    assert.deepEqual(sim.sent.map((s) => s.fn), ["approve", "deposit"])
    assert.equal(sim.sent[0].args[1], RL(4000), "exact amount, never unlimited")
    const o = await repo.vault!.getOverview()
    assert.equal(o.totalAssets, RL(4000).toString())
    assert.equal(o.position?.assetValue, RL(4000).toString())
    assert.equal(o.position?.walletBalance, RL(6000).toString())
  })

  it("skips the approval when the allowance already covers the deposit", async () => {
    sim.allowances.set(lc(A.lp), RL(100))
    await repoFor(sim, A.lp).vault!.deposit(RL(100).toString())
    assert.deepEqual(sim.sent.map((s) => s.fn), ["deposit"])
  })

  it("refuses a deposit larger than the wallet balance before the wallet is asked", async () => {
    assert.equal(await codeOf(repoFor(sim, A.lp).vault!.deposit(RL(50_000).toString())), "INSUFFICIENT_BALANCE")
    assert.equal(sim.sent.length, 0)
  })

  it("with advances outstanding, only the liquid part can be withdrawn; over-limit is refused before sending, within-limit works", async () => {
    const repo = repoFor(sim, A.lp)
    await repo.vault!.deposit(RL(4000).toString())
    sim.fund(1, A.client, A.freelancer, RL(1000))
    assert.equal(sim.advance(1), RL(900)) // 900 out of 4,000 NAV
    const o = await repo.vault!.getOverview()
    assert.equal(o.outstandingPrincipal, RL(900).toString())
    assert.equal(o.availableLiquidity, RL(3100).toString())
    assert.equal(o.totalAssets, RL(4000).toString(), "NAV counts outstanding principal at face value")
    assert.equal(o.utilizationBps, 2250)
    // cash 3100 minus ceil(900/4)=225 kept back = 2,875 withdrawable
    assert.equal(o.withdrawableLiquidity, RL(2875).toString())
    assert.equal(o.position?.maxWithdraw, RL(2875).toString())
    const sentBefore = sim.sent.length
    assert.equal(await codeOf(repo.vault!.withdraw(RL(2876).toString())), "TX_FAILED")
    assert.equal(sim.sent.length, sentBefore, "nothing sent for an over-limit withdrawal")
    await repo.vault!.withdraw(RL(2875).toString())
    assert.equal(sim.bal(A.lp), RL(10_000 - 4000 + 2875))
  })

  it("a paused vault refuses deposits", async () => {
    sim.vaultPaused = true
    assert.equal(await codeOf(repoFor(sim, A.lp).vault!.deposit(RL(10).toString())), "INVALID_STATUS")
    assert.equal(sim.sent.length, 0)
  })

  it("unauthenticated visitors can read the vault but cannot transact", async () => {
    sim.cash = RL(1000); sim.totalShares = RL(1000)
    const repo = repoFor(sim, A.lp, { authed: false })
    const o = await repo.vault!.getOverview()
    assert.equal(o.totalAssets, RL(1000).toString())
    assert.equal(o.position, null)
    assert.equal(await codeOf(repo.vault!.deposit(RL(1).toString())), "UNAUTHENTICATED")
    assert.equal(sim.sent.length, 0)
  })

  it("wrong network is reported before any transaction", async () => {
    const repo = repoFor(sim, A.lp, { walletError: new DomainError("WRONG_NETWORK", "Switch MetaMask to XRPL EVM Testnet.") })
    assert.equal(await codeOf(repo.vault!.deposit(RL(1).toString())), "WRONG_NETWORK")
    assert.equal(sim.sent.length, 0)
  })

  it("a reverted deposit is a failure, never success", async () => {
    sim.allowances.set(lc(A.lp), RL(100))
    sim.revertOnMine.add("deposit")
    const progress: TxProgress[] = []
    assert.equal(await codeOf(repoFor(sim, A.lp).vault!.deposit(RL(100).toString(), (p) => progress.push(p))), "TX_FAILED")
    assert.ok(steps(progress).includes("Deposit to vault:failed"))
    assert.ok(!steps(progress).includes("Deposit to vault:confirmed"))
    assert.equal(sim.cash, BigInt(0))
  })
})

describe("success flow: 1,000 escrow -> vault advances 900 -> approval repays 930 -> freelancer claims 70", () => {
  it("every figure the UI shows matches, and the claim is a verified wallet transaction", async () => {
    const lp = repoFor(sim, A.lp)
    await lp.vault!.deposit(RL(4000).toString()) // 900 needs >= 3,600 NAV under the 25% cap
    const priceBefore = BigInt((await lp.vault!.getOverview()).sharePrice)

    sim.fund(1, A.client, A.freelancer, RL(1000))
    assert.equal((await lp.vault!.getOverview()).maxAdvanceNow, RL(1000).toString(), "25% of 4,000 NAV")
    assert.equal(sim.advance(1), RL(900))
    assert.equal(sim.bal(A.freelancer), RL(900), "the advance is paid straight to the freelancer's wallet")

    sim.approveCompletion(1)
    const after = await lp.vault!.getOverview()
    assert.equal(after.totalAssets, RL(4030).toString(), "vault NAV +30 (the fee)")
    assert.equal(after.totalFeesEarned, RL(30).toString())
    assert.equal(after.outstandingPrincipal, "0")
    assert.ok(BigInt(after.sharePrice) > priceBefore, "share price rises with the fee")

    const freelancer = repoFor(sim, A.freelancer)
    const before = await freelancer.claims!.getClaimable()
    assert.equal(before.claimable, RL(70).toString(), "claimable, NOT yet in the wallet")
    assert.equal(before.walletBalance, RL(900).toString())

    const progress: TxProgress[] = []
    await freelancer.claims!.claim((p) => progress.push(p))
    assert.deepEqual(steps(progress), ["Claim proceeds:awaiting_wallet", "Claim proceeds:pending", "Claim proceeds:confirmed"])
    const claimed = await freelancer.claims!.getClaimable()
    assert.equal(claimed.claimable, "0")
    assert.equal(claimed.walletBalance, RL(970).toString(), "advance 900 + claimed 70")
  })

  it("approval without an advance credits the full 1,000 (no fee) to claim", async () => {
    sim.fund(2, A.client, A.freelancer, RL(1000))
    sim.approveCompletion(2)
    assert.equal(sim.fees, BigInt(0))
    assert.equal((await repoFor(sim, A.freelancer).claims!.getClaimable()).claimable, RL(1000).toString())
  })
})

describe("client-win dispute: 1,000 escrow, 900 advanced, operator refunds the client", () => {
  it("client claims the full 1,000; the vault realizes a 900 loss and earns no fee; the freelancer keeps the advance", async () => {
    const lp = repoFor(sim, A.lp)
    await lp.vault!.deposit(RL(4000).toString())
    const priceBefore = BigInt((await lp.vault!.getOverview()).sharePrice)
    sim.fund(1, A.client, A.freelancer, RL(1000))
    sim.advance(1)
    sim.raiseDispute(1)
    sim.resolveDispute(1, false)

    const o = await lp.vault!.getOverview()
    assert.equal(o.totalRealizedLosses, RL(900).toString())
    assert.equal(o.totalFeesEarned, "0")
    assert.equal(o.outstandingPrincipal, "0")
    assert.equal(o.totalAssets, RL(3100).toString())
    assert.ok(BigInt(o.sharePrice) < priceBefore, "the loss lowers the share price")

    const client = repoFor(sim, A.client)
    const owed = await client.claims!.getClaimable()
    assert.equal(owed.claimable, RL(1000).toString())
    await client.claims!.claim()
    assert.equal(sim.bal(A.client), RL(5000 + 1000))
    assert.equal(sim.bal(A.freelancer), RL(900), "an advance already paid is never clawed back")
  })
})

describe("claims: edge cases", () => {
  it("nothing to claim is refused before the wallet", async () => {
    assert.equal(await codeOf(repoFor(sim, A.freelancer).claims!.claim()), "INVALID_STATUS")
    assert.equal(sim.sent.length, 0)
  })

  it("a reverted claim never reports success and the credit stays claimable", async () => {
    sim.claimable.set(lc(A.freelancer), RL(70))
    sim.revertOnMine.add("claim")
    assert.equal(await codeOf(repoFor(sim, A.freelancer).claims!.claim()), "TX_FAILED")
    assert.equal(sim.claimable.get(lc(A.freelancer)), RL(70))
  })

  it("duplicate click while the first claim is still being sent is refused: exactly one transaction", async () => {
    sim.claimable.set(lc(A.freelancer), RL(70))
    let release!: () => void
    sim.hold = new Promise<void>((r) => (release = r))
    const repo = repoFor(sim, A.freelancer)
    const first = repo.claims!.claim()
    const second = codeOf(repo.claims!.claim())
    assert.equal(await second, "DUPLICATE_REQUEST")
    sim.hold = null
    release()
    await first
    assert.equal(sim.sent.filter((s) => s.fn === "claim").length, 1)
    assert.equal(sim.claimable.get(lc(A.freelancer)), BigInt(0))
  })
})

describe("empty vault and insufficient liquidity (backend adapter + eligibility)", () => {
  const scope = () => activeDeploymentScope()
  const adapter = () => createChainAdapter({ scope: scope(), client: publicClientFor(sim, A.evaluator) })

  it("empty vault: the adapter reports 0 available, and eligibility says the vault cannot fund the advance", async () => {
    assert.equal(await adapter().getReserveAvailable(), BigInt(0))
    const inv = invoiceDetail({ amount: RL(1000).toString() })
    const r = getAdvanceEligibility({ invoice: inv, submissions: [sub()], evaluations: [passEval()], advanceRequests: [], reserveAvailable: "0" })
    const blocker = r.blockers.find((b) => b.code === "INSUFFICIENT_RESERVE")
    assert.ok(blocker && /vault/i.test(blocker.message) && !/platform reserve/i.test(blocker.message), blocker?.message)
  })

  it("a 900 advance needs at least 3,600 NAV: 3,599 cannot fund it, 3,600 can", async () => {
    sim.cash = RL(3599); sim.totalShares = RL(3599)
    assert.ok((await adapter().getReserveAvailable()) < RL(900))
    sim.cash = RL(3600); sim.totalShares = RL(3600)
    assert.equal(await adapter().getReserveAvailable(), RL(900))
  })

  it("utilization headroom and pauses reduce what can be advanced", async () => {
    sim.cash = RL(1000); sim.outstanding = RL(3000); sim.totalShares = RL(4000) // 75% utilized: 5% of NAV left
    assert.equal(await adapter().getReserveAvailable(), RL(200))
    sim.advancesPaused = true
    assert.equal(await adapter().getReserveAvailable(), BigInt(0))
  })

  it("reads the V2 invoice (8-field struct) and refuses references to another contract", async () => {
    sim.cash = RL(5000); sim.totalShares = RL(5000)
    sim.fund(7, A.client, A.freelancer, RL(1000)); sim.advance(7)
    const state = await adapter().getInvoiceState({ chainId: 1449000, contractAddress: contractAddresses.invoiceAdvance, invoiceId: BigInt(7) })
    assert.equal(state.onchainStatus, "Advanced")
    assert.equal(state.advanceAmount, RL(900))
    await assert.rejects(adapter().getInvoiceState({ chainId: 1449000, contractAddress: "0x" + "9".repeat(40), invoiceId: BigInt(7) } as never), ChainScopeError)
  })

  it("wrong network RPC is refused by the adapter", async () => {
    sim.chainId = 1
    await assert.rejects(adapter().getReserveAvailable(), ChainScopeError)
  })
})

describe("v2 money previews", () => {
  it("fee is floor(amount * 10%) and the projection repays the vault advance + fee", () => {
    assert.equal(advanceFeeFor(RL(1000).toString()), RL(100).toString())
    const inv = invoiceDetail({ amount: RL(1000).toString(), advanceAmount: RL(900).toString(), onchainStatus: "Advanced" })
    assert.deepEqual(settlementProjection(inv), { reserveCredit: RL(1000).toString(), toFreelancer: "0", fee: RL(100).toString() })
    // A 50% advance rate: 450 advanced, the same 100 fee, 450 left for the freelancer to claim.
    const half = invoiceDetail({ amount: RL(1000).toString(), advanceAmount: RL(450).toString(), advanceShareBps: 5000, onchainStatus: "Advanced" })
    assert.deepEqual(settlementProjection(half), { reserveCredit: RL(550).toString(), toFreelancer: RL(450).toString(), fee: RL(100).toString() })
    const none = settlementProjection(invoiceDetail({ amount: RL(1000).toString() }))
    assert.deepEqual(none, { reserveCredit: "0", toFreelancer: RL(1000).toString(), fee: "0" })
  })

  it("settled-invoice figures: vault repaid 1000, freelancer total 900 (100% rate)", () => {
    const f = figuresFor("Settled", RL(1000).toString(), RL(900).toString(), true)
    assert.equal(f.reserveCredited, RL(1000).toString())
    assert.equal(f.freelancerReceived, RL(900).toString())
    assert.equal(figuresFor("Settled", RL(1000).toString(), "0", true).freelancerReceived, RL(1000).toString())
  })

  it("copy names the vault, never a platform reserve", () => {
    assert.equal(fundingCopy().pull, true)
    assert.match(fundingCopy().source, /vault/)
  })
})

function ctxFor(s: V2Sim, account: string): WriteContext {
  const publicClient = publicClientFor(s, account)
  const wallet = {
    account: { address: account },
    chain: undefined,
    getChainId: async () => s.chainId,
    writeContract: async (req: { address: string; functionName: string; args: readonly unknown[] }) => s.send(account, req.address, req.functionName, req.args),
  }
  return { wallet: wallet as never, publicClient }
}
const EVAL = ("0x" + "22".repeat(32)) as `0x${string}`
const sentBy = () => sim.sent.length

describe("lifecycle under v2: verified by V2 events, with signer permissions enforced", () => {
  beforeEach(() => {
    sim.cash = RL(4000)
    sim.totalShares = RL(4000)
    sim.fund(1, A.client, A.freelancer, RL(1000))
  })

  it("success flow: the evaluator's advance and the client's approval confirm with the right V2 facts", async () => {
    const adv = await approveAdvance(1, EVAL, ctxFor(sim, A.evaluator))
    const advConfirmed = await waitForConfirmation(adv, { publicClient: publicClientFor(sim, A.evaluator) })
    const [paid] = decodeV2Events(advConfirmed.receipt.logs as never)
    assert.equal(paid.event.kind, "AdvancePaid")
    assert.equal(paid.event.kind === "AdvancePaid" && paid.event.amount, RL(900))
    assert.equal(paid.event.kind === "AdvancePaid" && paid.event.fee, RL(30))
    assert.equal(sim.bal(A.freelancer), RL(900))

    const done = await approveCompletion(1, ctxFor(sim, A.client))
    const settled = await waitForConfirmation(done, { publicClient: publicClientFor(sim, A.client) })
    const kinds = decodeV2Events(settled.receipt.logs as never).map((e) => e.event)
    const s = kinds.find((e) => e.kind === "InvoiceSettled")
    assert.ok(s && s.kind === "InvoiceSettled")
    assert.equal(s.vaultPrincipalRepaid + s.vaultFeePaid, RL(930))
    assert.equal(s.freelancerCredited, RL(70))
    assert.equal(sim.claimable.get(lc(A.freelancer)), RL(70))
  })

  it("client-win dispute: client disputes, the operator resolves for the client, vault loss is 900", async () => {
    await waitForConfirmation(await approveAdvance(1, EVAL, ctxFor(sim, A.evaluator)), { publicClient: publicClientFor(sim, A.evaluator) })
    await waitForConfirmation(await raiseDispute(1, ctxFor(sim, A.client)), { publicClient: publicClientFor(sim, A.client) })
    // frozen: ordinary settlement is refused
    const before = sentBy()
    await assert.rejects(approveCompletion(1, ctxFor(sim, A.client)), ChainWriteError)
    assert.equal(sentBy(), before)
    const r = await waitForConfirmation(await resolveDispute(1, false, ctxFor(sim, A.operator)), { publicClient: publicClientFor(sim, A.operator) })
    const resolved = decodeV2Events(r.receipt.logs as never).map((e) => e.event).find((e) => e.kind === "DisputeResolved")
    assert.ok(resolved && resolved.kind === "DisputeResolved")
    assert.equal(resolved.releasedToFreelancer, false)
    assert.equal(resolved.vaultLoss, RL(900))
    assert.equal(sim.claimable.get(lc(A.client)), RL(1000))
    assert.equal(sim.losses, RL(900))
    assert.equal(sim.fees, BigInt(0))
  })

  it("unauthorized signers are refused before anything is sent", async () => {
    const before = sentBy()
    await assert.rejects(approveAdvance(1, EVAL, ctxFor(sim, A.client)), ChainWriteError) // not the evaluator
    await assert.rejects(approveCompletion(1, ctxFor(sim, A.lp)), ChainWriteError) // not the invoice's client
    await assert.rejects(raiseDispute(1, ctxFor(sim, A.freelancer)), ChainWriteError)
    sim.raiseDispute(1)
    await assert.rejects(resolveDispute(1, true, ctxFor(sim, A.client)), ChainWriteError) // not the operator
    assert.equal(sentBy(), before)
  })

  it("advance with an empty vault is refused by the simulation, nothing is sent", async () => {
    sim.cash = BigInt(0)
    sim.totalShares = BigInt(0)
    await assert.rejects(approveAdvance(1, EVAL, ctxFor(sim, A.evaluator)), ChainWriteError)
    assert.equal(sentBy(), 0)
  })

  it("a second advance on the same invoice is refused (no double advance)", async () => {
    await waitForConfirmation(await approveAdvance(1, EVAL, ctxFor(sim, A.evaluator)), { publicClient: publicClientFor(sim, A.evaluator) })
    const before = sentBy()
    submissionGuard.reset()
    await assert.rejects(approveAdvance(1, EVAL, ctxFor(sim, A.evaluator)), ChainWriteError)
    assert.equal(sentBy(), before)
  })

  it("the backend signer pays only with EVALUATOR_ROLE on-chain, and an unrelated key is never accepted", async () => {
    const scope = activeDeploymentScope()
    const ref = { chainId: 1449000, contractAddress: contractAddresses.invoiceAdvance, invoiceId: BigInt(1) }
    const evaluator = createSignerFromWallet({ wallet: ctxFor(sim, A.evaluator).wallet, address: A.evaluator as never, publicClient: publicClientFor(sim, A.evaluator), scope })
    const out = await evaluator.submitApproveAdvance(ref, EVAL)
    assert.match(out.txHash, /^0x[0-9a-f]{64}$/)
    assert.equal(sim.sent.at(-1)?.fn, "approveAdvance")

    // role revoked on-chain: refused with no transaction
    sim.roles.clear()
    submissionGuard.reset()
    sim.fund(2, A.client, A.freelancer, RL(1000))
    const before = sentBy()
    await assert.rejects(evaluator.submitApproveAdvance({ ...ref, invoiceId: BigInt(2) }, EVAL), /EVALUATOR_ROLE/)
    assert.equal(sentBy(), before)

    // a key that isn't this deployment's evaluator address yields the unavailable signer
    const random = "0x" + "ab".repeat(32)
    const s = createEvaluatorSignerFromEnv(scope, { EVALUATOR_PRIVATE_KEY: random })
    assert.equal(s.available, false)
    assert.equal(createEvaluatorSignerFromEnv(scope, {}).available, false)
  })

  it("the adapter confirms an advance only when the V2 AdvancePaid event matches the invoice and evaluation hash", async () => {
    const signer = createSignerFromWallet({ wallet: ctxFor(sim, A.evaluator).wallet, address: A.evaluator as never, publicClient: publicClientFor(sim, A.evaluator), scope: activeDeploymentScope() })
    const ref = { chainId: 1449000, contractAddress: contractAddresses.invoiceAdvance, invoiceId: BigInt(1) }
    const { txHash } = await signer.submitApproveAdvance(ref, EVAL)
    const client = publicClientFor(sim, A.evaluator)
    await client.waitForTransactionReceipt({ hash: txHash })
    const adapter = createChainAdapter({ scope: activeDeploymentScope(), client })
    const txRef = { txHash, from: A.evaluator.toLowerCase() as never, invoiceId: BigInt(1), evaluationHash: EVAL as never, submittedAt: Date.now() }
    const ok = await adapter.getAdvanceTransaction(txRef)
    assert.equal(ok.state, "confirmed")
    assert.equal(ok.state === "confirmed" && ok.paid.amount, RL(900))
    assert.equal(ok.state === "confirmed" && lc(ok.paid.freelancer), lc(A.freelancer))
    const other = await adapter.getAdvanceTransaction({ ...txRef, evaluationHash: ("0x" + "33".repeat(32)) as never })
    assert.notEqual(other.state, "confirmed")
  })
})

// ---- fixtures ------------------------------------------------------------------------------------------------------
function invoiceDetail(o: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    invoiceId: "1", client: lc(A.client) as never, freelancer: lc(A.freelancer) as never, amount: RL(1000).toString(), advanceAmount: "0", advanceShareBps: 10000, criteriaHash: ("0x" + "11".repeat(32)) as never,
    onchainStatus: "Funded", submissionStatus: "Evaluated", title: "t", criteria: [], criteriaVersion: 1, clientName: "c", freelancerName: "f", createdAt: new Date().toISOString(),
    escrowBalance: RL(1000).toString(), freelancerReceived: "0", reserveCredited: "0", financialStatusVerified: true, ...o,
  } as InvoiceDetail
}
const sub = () => ({ submissionId: "s1", invoiceId: "1", fileName: "f", fileSize: 1, mimeType: "x", note: "", storagePath: "", createdAt: new Date().toISOString() })
const passEval = () =>
  ({ evaluationId: "e1", submissionId: "s1", invoiceId: "1", state: "completed", passed: true, score: 95, criteriaResults: [], summary: "", criteriaHash: ("0x" + "11".repeat(32)) as never, criteriaVersion: 1, model: "m", promptVersion: "v", evaluatedAt: new Date().toISOString(), passRule: "r", mandatory: [], simulated: false }) as never
void E18
