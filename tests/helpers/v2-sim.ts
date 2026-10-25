import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, type Abi, type Hex } from "viem"
import { contractAddresses } from "@/lib/chain/config"
import { activeDeployment } from "@/lib/chain/config"
import { duelyVaultAbi } from "@/lib/chain/generated/duelyVaultAbi"
import { invoiceAdvanceV2Abi } from "@/lib/chain/generated/invoiceAdvanceV2Abi"

/**
 * A small in-memory model of DuelyVault + InvoiceAdvanceV2 for exercising the TypeScript integration (SDK reads/writes,
 * receipt verification, repository). The contracts' own behavior is proven by the Foundry suite; this mirrors only the
 * accounting the UI depends on: NAV = cash + outstanding, 25%/80% advance limits, withdrawals keep utilization <= 80%,
 * fee 3% of the invoice, pull-payment claims. Amounts are 18-decimal base units.
 */
export const E18 = BigInt(10) ** BigInt(18)
export const RL = (n: number) => BigInt(n) * E18
const Z = BigInt(0)
const lc = (s: string) => s.toLowerCase()

export const A = {
  client: "0x8d93eD20e6eD28c34aE0057f441ED97d3e63459E",
  freelancer: "0x02379033ECD642D9A9aA590ABe763D62AEa967F4",
  lp: "0x1111111111111111111111111111111111111111",
  operator: "0x6e83F6Bb6758Ced46e60be88271D72C22B84482E",
  evaluator: "0x276acaB037BB048a682E0E7ad900F3fFDCe65ECb",
} as const

export interface Inv { client: string; freelancer: string; amount: bigint; advance: bigint; fee: bigint; status: number }
// status: 0 Created 1 Funded 2 Advanced 3 Settled 4 Disputed 5 Cancelled

const escrowAddr = () => contractAddresses.invoiceAdvance
const vaultAddr = () => activeDeployment().vault!.address
const tokenAddr = () => contractAddresses.paymentToken

function encodeLog(abi: Abi, address: string, eventName: string, args: Record<string, unknown>, logIndex: number, txHash: Hex) {
  const event = abi.find((x) => x.type === "event" && x.name === eventName) as Extract<Abi[number], { type: "event" }>
  const indexed = event.inputs.filter((i) => i.indexed)
  const plain = event.inputs.filter((i) => !i.indexed)
  const topics = encodeEventTopics({ abi: [event], eventName, args: Object.fromEntries(indexed.map((i) => [i.name, args[i.name!]])) } as never)
  const data = plain.length ? encodeAbiParameters(plain as never, plain.map((i) => args[i.name!]) as never) : "0x"
  return { address, topics: topics as Hex[], data, transactionHash: txHash, logIndex, blockNumber: BigInt(600), blockHash: txHash, transactionIndex: 0, removed: false }
}

export class V2Sim {
  cash = Z
  outstanding = Z
  totalShares = Z
  shares = new Map<string, bigint>()
  fees = Z
  losses = Z
  balances = new Map<string, bigint>()
  allowances = new Map<string, bigint>() // `${owner}` -> allowance granted to the vault
  claimable = new Map<string, bigint>()
  invoices = new Map<number, Inv>()
  /** `${roleId}:${address}` for every account holding a role. Defaults to the deployment's operator and evaluator. */
  roles = new Set<string>([
    `${keccak256(stringToHex("OPERATOR_ROLE"))}:${A.operator.toLowerCase()}`,
    `${keccak256(stringToHex("EVALUATOR_ROLE"))}:${A.evaluator.toLowerCase()}`,
  ])
  vaultPaused = false
  advancesPaused = false
  chainId = 1449000
  head = BigInt(600)
  sent: { from: string; to: string; fn: string; args: readonly unknown[]; hash: Hex }[] = []
  /** hash -> pending request, mined on demand */
  private pending = new Map<string, { from: string; to: string; fn: string; args: readonly unknown[] }>()
  /** Functions whose transaction reverts when mined (simulation passes: a state change between simulate and mine). */
  revertOnMine = new Set<string>()
  /** When set, writeContract waits for this promise before returning (lets a test hold a send open). */
  hold: Promise<void> | null = null
  private n = 0

  bal = (a: string) => this.balances.get(lc(a)) ?? Z
  sharesOf = (a: string) => this.shares.get(lc(a)) ?? Z
  get nav() { return this.cash + this.outstanding }
  ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b
  get withdrawable() { const lock = this.ceilDiv(this.outstanding, BigInt(4)); return this.cash > lock ? this.cash - lock : Z }
  assetsOf = (s: bigint) => (this.totalShares === Z ? Z : (s * this.nav) / this.totalShares)
  get maxAdvanceNow() {
    if (this.vaultPaused || this.advancesPaused) return Z
    const cap = (this.nav * BigInt(2500)) / BigInt(10000)
    const maxOut = (this.nav * BigInt(8000)) / BigInt(10000)
    const head = this.outstanding >= maxOut ? Z : maxOut - this.outstanding
    return [this.cash, cap, head].reduce((m, x) => (x < m ? x : m))
  }
  maxWithdraw(a: string) { const v = this.assetsOf(this.sharesOf(a)); return v < this.withdrawable ? v : this.withdrawable }
  maxRedeem(a: string) {
    const s = this.sharesOf(a); const v = this.assetsOf(s)
    return v <= this.withdrawable ? s : v === Z ? Z : (s * this.withdrawable) / v
  }
  get utilizationBps() { return this.nav === Z ? Z : (this.outstanding * BigInt(10000)) / this.nav }
  quote(amount: bigint) {
    const advance = (amount * BigInt(9000)) / BigInt(10000)
    const fee = (amount * BigInt(300)) / BigInt(10000)
    return { advance, fee, repay: advance + fee, remainder: amount - advance - fee }
  }

  // ---- "other actors": advance, settle, resolve (not driven through the UI) ----
  fund(id: number, client: string, freelancer: string, amount: bigint) {
    this.invoices.set(id, { client, freelancer, amount, advance: Z, fee: Z, status: 1 })
  }
  advance(id: number): bigint {
    const inv = this.invoices.get(id)!
    const q = this.quote(inv.amount)
    if (this.vaultPaused || this.advancesPaused || q.advance > this.maxAdvanceNow) throw new Error("InsufficientLiquidity")
    this.cash -= q.advance; this.outstanding += q.advance
    this.balances.set(lc(inv.freelancer), this.bal(inv.freelancer) + q.advance)
    Object.assign(inv, { advance: q.advance, fee: q.fee, status: 2 })
    return q.advance
  }
  approveCompletion(id: number) {
    const inv = this.invoices.get(id)!
    if (inv.advance === Z) { this.credit(inv.freelancer, inv.amount) }
    else {
      this.cash += inv.advance + inv.fee; this.outstanding -= inv.advance; this.fees += inv.fee
      this.credit(inv.freelancer, inv.amount - inv.advance - inv.fee)
    }
    inv.status = 3
  }
  raiseDispute(id: number) { this.invoices.get(id)!.status = 4 }
  resolveDispute(id: number, release: boolean) {
    const inv = this.invoices.get(id)!
    if (release) return this.approveCompletion(id)
    if (inv.advance > Z) { this.outstanding -= inv.advance; this.losses += inv.advance }
    this.credit(inv.client, inv.amount)
    inv.status = 5
  }
  private credit(to: string, amt: bigint) { this.claimable.set(lc(to), (this.claimable.get(lc(to)) ?? Z) + amt) }

  // ---- reads ----
  read = (p: { address: string; functionName: string; args?: readonly unknown[] }): unknown => {
    const a = lc(p.address); const arg0 = p.args?.[0] as never
    if (a === lc(tokenAddr())) {
      if (p.functionName === "balanceOf") return lc(String(arg0)) === lc(vaultAddr()) ? this.cash : this.bal(arg0)
      if (p.functionName === "allowance") return this.allowances.get(lc(String(p.args![0]))) ?? Z
      if (p.functionName === "paused") return false
    }
    if (a === lc(vaultAddr())) {
      const m: Record<string, () => unknown> = {
        totalAssets: () => this.nav, totalSupply: () => this.totalShares, outstandingPrincipal: () => this.outstanding,
        withdrawableLiquidity: () => this.withdrawable, maxAdvanceNow: () => this.maxAdvanceNow, utilizationBps: () => this.utilizationBps,
        totalFeesEarned: () => this.fees, totalRealizedLosses: () => this.losses,
        convertToAssets: () => this.assetsOf(arg0), paused: () => this.vaultPaused, advancesPaused: () => this.advancesPaused,
        FEE_BPS: () => BigInt(300), MAX_ADVANCE_BPS: () => BigInt(9000), MAX_UTILIZATION_BPS: () => BigInt(8000), MAX_INVOICE_EXPOSURE_BPS: () => BigInt(2500),
        balanceOf: () => this.sharesOf(arg0), maxWithdraw: () => this.maxWithdraw(arg0), maxRedeem: () => this.maxRedeem(arg0),
      }
      if (m[p.functionName]) return m[p.functionName]()
    }
    if (a === lc(escrowAddr())) {
      if (p.functionName === "claimable") return this.claimable.get(lc(String(arg0))) ?? Z
      if (p.functionName === "totalEscrow") return [...this.invoices.values()].filter((i) => i.status === 1 || i.status === 2 || i.status === 4).reduce((s, i) => s + i.amount, Z)
      if (p.functionName === "totalClaimable") return [...this.claimable.values()].reduce((s, x) => s + x, Z)
      if (p.functionName === "getInvoice") {
        const i = this.invoices.get(Number(arg0))
        if (!i) throw new Error("InvoiceNotFound")
        return { freelancer: i.freelancer, client: i.client, amount: i.amount, advanceAmount: i.advance, advanceFee: i.fee, metadataHash: ("0x" + "11".repeat(32)) as Hex, evaluationHash: ("0x" + "22".repeat(32)) as Hex, status: i.status }
      }
      if (p.functionName === "hasRole") return this.roles.has(`${String(p.args![0])}:${lc(String(p.args![1]))}`)
    }
    throw new Error(`unexpected read ${p.address} ${p.functionName}`)
  }

  // ---- writes ----
  /** Throws what a simulation would revert with. */
  check(from: string, to: string, fn: string, args: readonly unknown[]) {
    if (fn === "deposit") {
      if (this.vaultPaused) throw new Error("EnforcedPause")
      if ((this.allowances.get(lc(from)) ?? Z) < (args[0] as bigint)) throw new Error("ERC20InsufficientAllowance")
      if (this.bal(from) < (args[0] as bigint)) throw new Error("ERC20InsufficientBalance")
    }
    if (fn === "withdraw" && (args[0] as bigint) > this.maxWithdraw(from)) throw new Error("ERC4626ExceededMaxWithdraw")
    if (fn === "redeem" && (args[0] as bigint) > this.maxRedeem(from)) throw new Error("ERC4626ExceededMaxRedeem")
    if (fn === "claim" && (this.claimable.get(lc(String(args[0]))) ?? Z) === Z) throw new Error("NothingToClaim")
    const inv = this.invoices.get(Number(args[0]))
    const hasRole = (name: string) => this.roles.has(`${keccak256(stringToHex(name))}:${lc(from)}`)
    if (fn === "approveAdvance") {
      if (!hasRole("EVALUATOR_ROLE")) throw new Error("AccessControlUnauthorizedAccount")
      if (!inv || inv.status !== 1) throw new Error("InvalidStatus")
      if (this.quote(inv.amount).advance > this.maxAdvanceNow) throw new Error("InsufficientLiquidity")
    }
    if (fn === "approveCompletion" || fn === "raiseDispute") {
      if (!inv || lc(inv.client) !== lc(from)) throw new Error("NotInvoiceClient")
      if (inv.status !== 1 && inv.status !== 2) throw new Error("InvalidStatus")
    }
    if (fn === "resolveDispute") {
      if (!hasRole("OPERATOR_ROLE")) throw new Error("AccessControlUnauthorizedAccount")
      if (!inv || inv.status !== 4) throw new Error("InvalidStatus")
    }
  }

  send(from: string, to: string, fn: string, args: readonly unknown[]): Hex {
    const hash = ("0x" + (++this.n).toString(16).padStart(64, "0")) as Hex
    this.sent.push({ from, to, fn, args, hash })
    this.pending.set(hash, { from, to, fn, args })
    return hash
  }

  /** Applies a mined transaction and returns its receipt (reverted when scripted to). */
  mine(hash: Hex) {
    const tx = this.pending.get(hash)
    if (!tx) throw new Error("unknown tx")
    this.head += BigInt(1)
    const base = { transactionHash: hash, blockHash: hash, blockNumber: this.head, from: tx.from, to: tx.to, transactionIndex: 0, gasUsed: BigInt(1), cumulativeGasUsed: BigInt(1), effectiveGasPrice: BigInt(1), logsBloom: "0x", type: "eip1559", contractAddress: null }
    if (this.revertOnMine.has(tx.fn)) return { ...base, status: "reverted", logs: [] }
    const logs: ReturnType<typeof encodeLog>[] = []
    const owner = tx.from
    switch (tx.fn) {
      case "approve": {
        this.allowances.set(lc(owner), tx.args[1] as bigint)
        logs.push(encodeLog([{ type: "event", name: "Approval", inputs: [{ indexed: true, name: "owner", type: "address" }, { indexed: true, name: "spender", type: "address" }, { indexed: false, name: "value", type: "uint256" }] }] as unknown as Abi, tokenAddr(), "Approval", { owner, spender: tx.args[0], value: tx.args[1] }, 0, hash))
        break
      }
      case "deposit": {
        const assets = tx.args[0] as bigint
        const minted = this.totalShares === Z ? assets * BigInt(10) ** BigInt(6) : (assets * this.totalShares) / this.nav
        this.allowances.set(lc(owner), (this.allowances.get(lc(owner)) ?? Z) - assets)
        this.balances.set(lc(owner), this.bal(owner) - assets)
        this.cash += assets; this.totalShares += minted; this.shares.set(lc(owner), this.sharesOf(owner) + minted)
        logs.push(encodeLog(duelyVaultAbi as Abi, vaultAddr(), "Deposit", { sender: owner, owner, assets, shares: minted }, 0, hash))
        break
      }
      case "withdraw":
      case "redeem": {
        const assets = tx.fn === "withdraw" ? (tx.args[0] as bigint) : this.assetsOf(tx.args[0] as bigint)
        const burned = tx.fn === "redeem" ? (tx.args[0] as bigint) : (assets * this.totalShares) / this.nav
        this.cash -= assets; this.totalShares -= burned; this.shares.set(lc(owner), this.sharesOf(owner) - burned)
        this.balances.set(lc(owner), this.bal(owner) + assets)
        logs.push(encodeLog(duelyVaultAbi as Abi, vaultAddr(), "Withdraw", { sender: owner, receiver: owner, owner, assets, shares: burned }, 0, hash))
        break
      }
      case "claim": {
        const recipient = String(tx.args[0]); const amount = this.claimable.get(lc(recipient)) ?? Z
        this.claimable.set(lc(recipient), Z); this.balances.set(lc(recipient), this.bal(recipient) + amount)
        logs.push(encodeLog(invoiceAdvanceV2Abi as Abi, escrowAddr(), "ProceedsClaimed", { recipient, caller: owner, amount }, 0, hash))
        break
      }
      case "approveAdvance": {
        const id = Number(tx.args[0]); const inv = this.invoices.get(id)!
        const amount = this.advance(id)
        logs.push(encodeLog(invoiceAdvanceV2Abi as Abi, escrowAddr(), "AdvancePaid", { invoiceId: BigInt(id), freelancer: inv.freelancer, amount, fee: inv.fee, evaluationHash: tx.args[1] }, 0, hash))
        break
      }
      case "approveCompletion": {
        const id = Number(tx.args[0]); const inv = this.invoices.get(id)!
        const q = inv.advance === Z ? { repay: Z, fee: Z, remainder: inv.amount } : { repay: inv.advance + inv.fee, fee: inv.fee, remainder: inv.amount - inv.advance - inv.fee }
        this.approveCompletion(id)
        logs.push(encodeLog(invoiceAdvanceV2Abi as Abi, escrowAddr(), "InvoiceSettled", { invoiceId: BigInt(id), vaultPrincipalRepaid: inv.advance, vaultFeePaid: q.fee, freelancerCredited: q.remainder }, 0, hash))
        logs.push(encodeLog(invoiceAdvanceV2Abi as Abi, escrowAddr(), "ProceedsCredited", { invoiceId: BigInt(id), recipient: inv.freelancer, amount: q.remainder }, 1, hash))
        break
      }
      case "raiseDispute": {
        const id = Number(tx.args[0]); const inv = this.invoices.get(id)!
        this.raiseDispute(id)
        logs.push(encodeLog(invoiceAdvanceV2Abi as Abi, escrowAddr(), "InvoiceDisputed", { invoiceId: BigInt(id), client: inv.client, advanceAlreadyPaid: inv.advance }, 0, hash))
        break
      }
      case "resolveDispute": {
        const id = Number(tx.args[0]); const release = tx.args[1] as boolean; const inv = this.invoices.get(id)!
        const loss = !release && inv.advance > Z ? inv.advance : Z
        this.resolveDispute(id, release)
        logs.push(encodeLog(invoiceAdvanceV2Abi as Abi, escrowAddr(), "DisputeResolved", { invoiceId: BigInt(id), releasedToFreelancer: release, vaultLoss: loss }, 0, hash))
        break
      }
      default:
        throw new Error(`unsupported fn ${tx.fn}`)
    }
    return { ...base, status: "success", logs }
  }
}
