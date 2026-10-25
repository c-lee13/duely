import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  stringToHex,
  type Abi,
  type Hex,
} from "viem"

import { CHAIN_ID, contractAddresses } from "./config"
import {
  getActiveDeployment,
  getDeployment,
  setDeploymentOverrideForTests,
} from "./deployments"
import { ChainWriteError } from "./errors"
import { EXPECTED_EVENTS } from "./expected"
import { duelyVaultAbi } from "./generated/duelyVaultAbi"
import { invoiceAdvanceV2Abi } from "./generated/invoiceAdvanceV2Abi"
import { getTransactionStatus, parseSubmittedTransaction, serializeSubmittedTransaction } from "./lifecycle"
import { vaultAddress } from "./protocol"
import { getInvoice } from "./reads"
import {
  approveVaultAllowance,
  claimProceeds,
  decodeV2Events,
  depositToVault,
  getClaimable,
  getLpPosition,
  getVaultSnapshot,
  quoteAdvance,
  redeemFromVault,
  withdrawFromVault,
} from "./vault"
import { submissionGuard, type ChainWriteClient, type WriteContext } from "./writes"
import type { ChainReader } from "./client"

const B = (n: number | string | bigint) => BigInt(n)
const E18 = B(10) ** B(18)
const RL = (n: number) => B(n) * E18 // whole RLUSD in base units (18 decimals)
const ZERO = B(0)

const LP = "0x8d93eD20e6eD28c34aE0057f441ED97d3e63459E" as const
const FREELANCER = "0x02379033ECD642D9A9aA590ABe763D62AEa967F4" as const
const STRANGER = "0x1111111111111111111111111111111111111111" as const
const EVAL = ("0x" + "22".repeat(32)) as Hex
const TX = ("0x" + "ab".repeat(32)) as Hex

beforeEach(() => {
  submissionGuard.reset()
  setDeploymentOverrideForTests(getDeployment("v2"))
})
afterEach(() => {
  setDeploymentOverrideForTests(null)
  submissionGuard.reset()
})

// ---- fake chain ----------------------------------------------------------------------------------

type Reads = Record<string, unknown | ((args: readonly unknown[]) => unknown)>

function fakeChain(reads: Reads, tokenReads: Reads = {}) {
  const calls: { address: string; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }[] = []
  const reader = {
    getBlockNumber: async () => B(500),
    readContract: async (p: { address: string; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      calls.push(p)
      const table = p.address.toLowerCase() === contractAddresses.paymentToken.toLowerCase() ? tokenReads : reads
      if (!(p.functionName in table)) throw new Error(`unexpected read ${p.address} ${p.functionName}`)
      const v = table[p.functionName]
      return typeof v === "function" ? (v as (a: readonly unknown[]) => unknown)(p.args ?? []) : v
    },
  }
  return { reader: reader as unknown as ChainReader, calls }
}

function writeCtx(account: string, reads: Reads, tokenReads: Reads = {}) {
  const sent: { address: string; functionName: string; args: readonly unknown[] }[] = []
  const { reader } = fakeChain(reads, tokenReads)
  const publicClient = {
    ...reader,
    getChainId: async () => CHAIN_ID,
    simulateContract: async (p: { address: string; functionName: string; args: readonly unknown[] }) => ({ request: p }),
    getTransactionReceipt: async () => {
      throw new Error("not found")
    },
  } as unknown as ChainWriteClient
  const wallet = {
    account: { address: account },
    chain: undefined,
    getChainId: async () => CHAIN_ID,
    writeContract: async (req: { address: string; functionName: string; args: readonly unknown[] }) => {
      sent.push(req)
      return TX
    },
  } as unknown as WriteContext["wallet"]
  return { ctx: { wallet, publicClient } as WriteContext, sent }
}

const TOKEN_OK: Reads = {
  paused: false,
  allowance: RL(10_000),
  balanceOf: RL(10_000),
}

// ---- log helpers ---------------------------------------------------------------------------------

function log(abi: Abi, address: string, eventName: string, args: Record<string, unknown>, logIndex = 0) {
  const event = abi.find((x) => x.type === "event" && x.name === eventName) as Extract<Abi[number], { type: "event" }>
  const indexed = event.inputs.filter((i) => i.indexed)
  const plain = event.inputs.filter((i) => !i.indexed)
  const topics = encodeEventTopics({ abi: [event], eventName, args: Object.fromEntries(indexed.map((i) => [i.name, args[i.name!]])) } as never)
  const data = plain.length ? encodeAbiParameters(plain as never, plain.map((i) => args[i.name!]) as never) : "0x"
  return { address, topics: topics as Hex[], data, transactionHash: TX, logIndex, blockNumber: B(500), blockHash: TX, transactionIndex: 0, removed: false }
}
const escrowLog = (name: string, args: Record<string, unknown>, i = 0) => log(invoiceAdvanceV2Abi as Abi, contractAddresses.invoiceAdvance, name, args, i)

// ---- deployment selection --------------------------------------------------------------------------

describe("v2 deployment selection", () => {
  it("v2 is RLUSD with the V2 escrow in invoiceAdvance.address and the vault alongside", () => {
    const d = getActiveDeployment()
    assert.equal(d.key, "v2")
    assert.equal(d.protocol, "v2")
    assert.equal(d.chainId, 1449000)
    assert.equal(d.token.symbol, "RLUSD")
    assert.equal(d.token.isDemoToken, false)
    assert.equal(d.token.decimals, 18)
    assert.equal(contractAddresses.invoiceAdvance, "0x2E1598D6DBDa061EB6CafCa5D7AEe1630A04Ba96")
    assert.equal(vaultAddress(), "0x5f8B53B32acab32F8c283CB40a4B7ac04792B6E8")
    assert.equal(d.vault?.shareDecimals, 24)
    assert.equal(d.roles.evaluator, "0x276acaB037BB048a682E0E7ad900F3fFDCe65ECb")
  })

  it("v1 deployments have protocol v1, no vault, and vaultAddress() throws", () => {
    for (const key of ["dusd", "rlusd"] as const) {
      const d = getDeployment(key)
      assert.equal(d.protocol, "v1")
      assert.equal(d.vault, undefined)
    }
    setDeploymentOverrideForTests(getDeployment("rlusd"))
    assert.throws(() => vaultAddress(), (e) => e instanceof ChainWriteError)
  })
})

// ---- reads -----------------------------------------------------------------------------------------

describe("v2 reads", () => {
  it("getInvoice decodes the 8-field V2 struct (including advanceFee) and its status", async () => {
    const { reader, calls } = fakeChain({
      getInvoice: () => ({
        freelancer: FREELANCER,
        client: LP,
        amount: RL(1000),
        advanceAmount: RL(900),
        advanceFee: RL(27),
        metadataHash: ("0x" + "11".repeat(32)) as Hex,
        evaluationHash: EVAL,
        status: 2,
      }),
    })
    const inv = await getInvoice(7, { client: reader })
    assert.equal(inv.advanceAmount, RL(900))
    assert.equal(inv.advanceFee, RL(27))
    assert.equal(inv.statusName, "Advanced")
    assert.equal(calls[0].address, contractAddresses.invoiceAdvance)
  })

  it("getVaultSnapshot reads everything at one pinned block and reports NAV, utilization and limits", async () => {
    const { reader, calls } = fakeChain(
      {
        totalAssets: RL(4000), totalSupply: B(4000) * B(10) ** B(24), outstandingPrincipal: RL(900),
        withdrawableLiquidity: RL(2200), maxAdvanceNow: RL(900), utilizationBps: B(2250),
        totalFeesEarned: RL(30), totalRealizedLosses: ZERO, convertToAssets: () => RL(1),
        paused: false, advancesPaused: false, FEE_BPS: B(300), MAX_ADVANCE_BPS: B(9000),
        MAX_UTILIZATION_BPS: B(8000), MAX_INVOICE_EXPOSURE_BPS: B(2500),
      },
      { balanceOf: RL(3100) }
    )
    const snap = await getVaultSnapshot({ client: reader })
    assert.equal(snap.blockNumber, B(500))
    assert.equal(snap.totalAssets, RL(4000))
    assert.equal(snap.cash + snap.outstandingPrincipal, snap.totalAssets) // NAV = cash + outstanding
    assert.equal(snap.sharePriceAssets, RL(1))
    assert.equal(snap.shareSymbol, "dvRLUSD")
    assert.equal(snap.maxInvoiceExposureBps, B(2500))
    assert.ok(calls.length > 5 && calls.every((c) => c.blockNumber === B(500)), "every read pinned to the same block")
  })

  it("getLpPosition keeps wallet balance, vault shares and withdrawable amounts apart", async () => {
    const { reader } = fakeChain(
      { balanceOf: B(1000) * B(10) ** B(24), maxWithdraw: RL(400), maxRedeem: B(400) * B(10) ** B(24), convertToAssets: RL(1000) },
      { balanceOf: RL(50), allowance: RL(7) }
    )
    const p = await getLpPosition(LP, { client: reader })
    assert.equal(p.assetValue, RL(1000))
    assert.equal(p.maxWithdraw, RL(400)) // restricted below the position value
    assert.equal(p.walletBalance, RL(50))
    assert.equal(p.vaultAllowance, RL(7))
  })

  it("claimable and quoteAdvance come straight from the contract", async () => {
    const { reader } = fakeChain({
      claimable: (a: readonly unknown[]) => (String(a[0]).toLowerCase() === FREELANCER.toLowerCase() ? RL(70) : ZERO),
      quoteAdvance: (a: readonly unknown[]) => [(a[0] as bigint * B(9)) / B(10), (a[0] as bigint * B(27)) / B(1000), (a[0] as bigint * B(927)) / B(1000), (a[0] as bigint * B(73)) / B(1000)],
    })
    assert.equal(await getClaimable(FREELANCER, { client: reader }), RL(70))
    assert.equal(await getClaimable(STRANGER, { client: reader }), ZERO)
    const q = await quoteAdvance(RL(1000), { client: reader })
    assert.equal(q.advance, RL(900))
    assert.equal(q.fee + q.advance, q.vaultRepayment)
    assert.equal(q.advance + q.fee + q.freelancerRemainder, RL(1000))
  })
})

// ---- writes ----------------------------------------------------------------------------------------

describe("v2 writes", () => {
  it("depositToVault sends deposit(assets, signer) after checking allowance and balance", async () => {
    const { ctx, sent } = writeCtx(LP, { paused: false }, TOKEN_OK)
    const tx = await depositToVault(RL(4000), ctx)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].address, vaultAddress())
    assert.equal(sent[0].functionName, "deposit")
    assert.deepEqual(sent[0].args, [RL(4000), LP])
    assert.equal(tx.expected.contract, "duelyVault")
  })

  it("depositToVault refuses without allowance, without balance, when the vault is paused and when the token is paused", async () => {
    const reject = async (reads: Reads, token: Reads, code: string) => {
      const { ctx, sent } = writeCtx(LP, reads, token)
      await assert.rejects(depositToVault(RL(100), ctx), (e) => e instanceof ChainWriteError && e.code === code)
      assert.equal(sent.length, 0, `nothing sent for ${code}`)
      submissionGuard.reset()
    }
    await reject({ paused: false }, { ...TOKEN_OK, allowance: RL(1) }, "INSUFFICIENT_ALLOWANCE")
    await reject({ paused: false }, { ...TOKEN_OK, balanceOf: RL(1) }, "INSUFFICIENT_BALANCE")
    await reject({ paused: true }, TOKEN_OK, "SIMULATION_REVERTED")
    await reject({ paused: false }, { ...TOKEN_OK, paused: true }, "TOKEN_PAUSED")
  })

  it("approveVaultAllowance approves exactly the amount to the vault", async () => {
    const { ctx, sent } = writeCtx(LP, {}, {})
    const tx = await approveVaultAllowance(RL(25), ctx)
    assert.equal(sent[0].address, contractAddresses.paymentToken)
    assert.deepEqual(sent[0].args, [vaultAddress(), RL(25)])
    assert.equal(tx.expected.contract, "paymentToken")
    await assert.rejects(approveVaultAllowance(ZERO, ctx), (e) => e instanceof ChainWriteError && e.code === "INVALID_INPUT")
  })

  it("LP withdrawal limits: withdraw/redeem above what liquidity allows is refused before sending", async () => {
    const reads = { paused: false, maxWithdraw: RL(400), maxRedeem: B(400) * B(10) ** B(24) }
    {
      const { ctx, sent } = writeCtx(LP, reads)
      await assert.rejects(
        withdrawFromVault(RL(401), ctx),
        (e) => e instanceof ChainWriteError && e.code === "SIMULATION_REVERTED" && e.revertName === "ERC4626ExceededMaxWithdraw" && /utilization/.test(e.message)
      )
      assert.equal(sent.length, 0)
    }
    {
      const { ctx, sent } = writeCtx(LP, reads)
      await assert.rejects(redeemFromVault(B(401) * B(10) ** B(24), ctx), (e) => e instanceof ChainWriteError && e.revertName === "ERC4626ExceededMaxRedeem")
      assert.equal(sent.length, 0)
    }
    {
      const { ctx, sent } = writeCtx(LP, reads)
      await withdrawFromVault(RL(400), ctx) // exactly the limit passes
      assert.deepEqual(sent[0].args, [RL(400), LP, LP])
    }
  })

  it("claimProceeds: refuses when nothing is credited, otherwise sends claim(recipient)", async () => {
    {
      const { ctx, sent } = writeCtx(STRANGER, { claimable: ZERO })
      await assert.rejects(claimProceeds(FREELANCER, ctx), (e) => e instanceof ChainWriteError && e.revertName === "NothingToClaim")
      assert.equal(sent.length, 0)
    }
    const { ctx, sent } = writeCtx(STRANGER, { claimable: RL(70) })
    const tx = await claimProceeds(FREELANCER, ctx)
    assert.equal(sent[0].functionName, "claim")
    assert.deepEqual(sent[0].args, [FREELANCER])
    // a third party may trigger it, but the evidence names the recipient the money goes to
    assert.deepEqual(tx.expected.args, { recipient: FREELANCER, caller: STRANGER })
  })
})

// ---- receipts: only the right event from the right contract confirms ----------------------------------

describe("v2 receipt verification", () => {
  const receipt = (from: string, to: string, logs: unknown[], status = "success") =>
    ({ transactionHash: TX, from, to, status, logs, blockNumber: B(500), blockHash: TX, transactionIndex: 0, gasUsed: B(1), cumulativeGasUsed: B(1), effectiveGasPrice: B(1), logsBloom: "0x", type: "eip1559", contractAddress: null }) as never

  const statusFor = async (tx: Awaited<ReturnType<typeof claimProceeds>>, rc: never) =>
    getTransactionStatus(tx, { publicClient: { getTransactionReceipt: async () => rc, getTransaction: async () => ({}) } as unknown as ChainWriteClient })

  it("a claim is confirmed only by ProceedsClaimed from the escrow naming the recipient and caller", async () => {
    const { ctx } = writeCtx(STRANGER, { claimable: RL(70) })
    const tx = await claimProceeds(FREELANCER, ctx)
    const good = receipt(STRANGER, contractAddresses.invoiceAdvance, [escrowLog("ProceedsClaimed", { recipient: FREELANCER, caller: STRANGER, amount: RL(70) })])
    assert.equal((await statusFor(tx, good)).state, "confirmed")
    const wrongRecipient = receipt(STRANGER, contractAddresses.invoiceAdvance, [escrowLog("ProceedsClaimed", { recipient: LP, caller: STRANGER, amount: RL(70) })])
    assert.equal((await statusFor(tx, wrongRecipient)).state, "unverified")
    const noEvent = receipt(STRANGER, contractAddresses.invoiceAdvance, [])
    assert.equal((await statusFor(tx, noEvent)).state, "unverified")
    assert.equal((await statusFor(tx, receipt(STRANGER, contractAddresses.invoiceAdvance, [], "reverted"))).state, "reverted")
  })

  it("a vault deposit is confirmed by the vault's Deposit event, not by one from another address", async () => {
    const { ctx } = writeCtx(LP, { paused: false }, TOKEN_OK)
    const tx = await depositToVault(RL(4000), ctx)
    const ev = (address: string) => log(duelyVaultAbi as Abi, address, "Deposit", { sender: LP, owner: LP, assets: RL(4000), shares: B(4000) * B(10) ** B(24) })
    assert.equal((await statusFor(tx as never, receipt(LP, vaultAddress(), [ev(vaultAddress())]))).state, "confirmed")
    assert.equal((await statusFor(tx as never, receipt(LP, vaultAddress(), [ev(STRANGER)]))).state, "unverified")
  })

  it("v2 submissions survive serialization (page reload) with their deployment identity", async () => {
    const { ctx } = writeCtx(STRANGER, { claimable: RL(1) })
    const tx = await claimProceeds(FREELANCER, ctx)
    const back = parseSubmittedTransaction(serializeSubmittedTransaction(tx))
    assert.deepEqual(back.expected, tx.expected)
    assert.equal(back.deployment?.key, "v2")
    // ...and cannot be tracked under a different deployment
    setDeploymentOverrideForTests(getDeployment("rlusd"))
    await assert.rejects(getTransactionStatus(back, { publicClient: {} as ChainWriteClient }), (e) => e instanceof ChainWriteError && e.code === "DEPLOYMENT_MISMATCH")
  })

  it("the expected-event table names real V2 events", () => {
    for (const key of ["claim", "vaultDeposit", "vaultWithdraw", "vaultRedeem"] as const) {
      const abi = (EXPECTED_EVENTS[key].contract === "duelyVault" ? duelyVaultAbi : invoiceAdvanceV2Abi) as Abi
      assert.ok(abi.some((x) => x.type === "event" && x.name === EXPECTED_EVENTS[key].eventName), key)
    }
    assert.equal(keccak256(stringToHex("x")).length, 66) // keep imports honest
  })
})

// ---- the two financial outcomes, as seen through decoded events -------------------------------------------

/** Replays decoded events into balances the way the UI/reconciler must (each log key counted once). */
function ledger(events: ReturnType<typeof decodeV2Events>) {
  const seen = new Set<string>()
  const t = { vaultRepaid: ZERO, vaultFee: ZERO, vaultLoss: ZERO, advanced: ZERO, credited: new Map<string, bigint>(), claimed: new Map<string, bigint>() }
  for (const { key, event: e } of events) {
    if (seen.has(key)) continue
    seen.add(key)
    if (e.kind === "AdvancePaid") t.advanced += e.amount
    if (e.kind === "InvoiceSettled") { t.vaultRepaid += e.vaultPrincipalRepaid; t.vaultFee += e.vaultFeePaid }
    if (e.kind === "DisputeResolved") t.vaultLoss += e.vaultLoss
    if (e.kind === "ProceedsCredited") t.credited.set(e.recipient, (t.credited.get(e.recipient) ?? ZERO) + e.amount)
    if (e.kind === "ProceedsClaimed") t.claimed.set(e.recipient, (t.claimed.get(e.recipient) ?? ZERO) + e.amount)
  }
  return t
}

describe("v2 financial outcomes via decoded events", () => {
  it("success flow: 1,000 escrow -> 900 advance -> approve repays 930 to the vault -> freelancer claims 70", () => {
    const logs = [
      escrowLog("AdvancePaid", { invoiceId: B(1), freelancer: FREELANCER, amount: RL(900), fee: RL(30), evaluationHash: EVAL }, 0),
      escrowLog("InvoiceSettled", { invoiceId: B(1), vaultPrincipalRepaid: RL(900), vaultFeePaid: RL(30), freelancerCredited: RL(70) }, 1),
      escrowLog("ProceedsCredited", { invoiceId: B(1), recipient: FREELANCER, amount: RL(70) }, 2),
      escrowLog("ProceedsClaimed", { recipient: FREELANCER, caller: FREELANCER, amount: RL(70) }, 3),
    ]
    const t = ledger(decodeV2Events(logs))
    assert.equal(t.advanced, RL(900))
    assert.equal(t.vaultRepaid + t.vaultFee, RL(930)) // vault NAV +30
    assert.equal(t.vaultFee, RL(30))
    assert.equal(t.credited.get(FREELANCER), RL(70))
    assert.equal(t.claimed.get(FREELANCER), RL(70))
    assert.equal(t.advanced + (t.claimed.get(FREELANCER) ?? ZERO), RL(970)) // freelancer total
    assert.equal(t.vaultLoss, ZERO)
  })

  it("client-win dispute: 900 already advanced, client claims the full 1,000, vault realizes a 900 loss and no fee", () => {
    const logs = [
      escrowLog("AdvancePaid", { invoiceId: B(2), freelancer: FREELANCER, amount: RL(900), fee: RL(30), evaluationHash: EVAL }, 0),
      escrowLog("DisputeResolved", { invoiceId: B(2), releasedToFreelancer: false, vaultLoss: RL(900) }, 1),
      escrowLog("ProceedsCredited", { invoiceId: B(2), recipient: LP, amount: RL(1000) }, 2),
      escrowLog("ProceedsClaimed", { recipient: LP, caller: LP, amount: RL(1000) }, 3),
    ]
    const t = ledger(decodeV2Events(logs))
    assert.equal(t.vaultLoss, RL(900))
    assert.equal(t.vaultFee, ZERO)
    assert.equal(t.claimed.get(LP), RL(1000))
    assert.equal(t.advanced, RL(900)) // the freelancer keeps it; never clawed back
  })

  it("duplicate processing: the same receipt decoded and replayed twice is counted once", () => {
    const logs = [
      escrowLog("InvoiceSettled", { invoiceId: B(1), vaultPrincipalRepaid: RL(900), vaultFeePaid: RL(30), freelancerCredited: RL(70) }, 1),
      escrowLog("ProceedsCredited", { invoiceId: B(1), recipient: FREELANCER, amount: RL(70) }, 2),
    ]
    const once = decodeV2Events(logs)
    const twice = [...decodeV2Events(logs), ...decodeV2Events(logs)]
    assert.deepEqual(once.map((e) => e.key), ["" + TX + ":1", "" + TX + ":2"])
    assert.deepEqual(ledger(twice).vaultRepaid, ledger(once).vaultRepaid)
    assert.equal(ledger(twice).credited.get(FREELANCER), RL(70))
  })

  it("ignores logs from other contracts, including a look-alike with the same event shape", () => {
    const fake = log(invoiceAdvanceV2Abi as Abi, STRANGER, "ProceedsClaimed", { recipient: LP, caller: LP, amount: RL(999) })
    assert.deepEqual(decodeV2Events([fake]), [])
  })
})
