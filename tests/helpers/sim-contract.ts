import { decodeFunctionData, type Hex } from "viem"
import { contractAddresses } from "@/lib/chain/config"
import { invoiceAdvanceAbi, paymentTokenAbi } from "@/lib/chain/generated"
import { ADDR, EVAL, allowanceKey, createMockChain, eventLog } from "@/lib/chain/test/mock-chain"

/**
 * A tiny simulation of InvoiceAdvance's state transitions on top of the SDK's mock chain, so the browser wallet flows and the
 * backend can be tested against ONE consistent "chain": a transaction sent by the (mock) wallet is mined at once and its effects
 * (status, escrow, reserve, balances, events) are applied exactly as the contract specifies (docs/CONTRACT_SPEC.md).
 *
 * It is a test double: it proves the frontend/backend integration and the contract's documented rules are consumed correctly,
 * not that the Solidity is correct (Foundry and the live runs cover that).
 */
type MockChain = ReturnType<typeof createMockChain>
export const ZERO_HASH = `0x${"00".repeat(32)}` as Hex
const IA = contractAddresses.invoiceAdvance.toLowerCase()
const TOKEN = contractAddresses.paymentToken.toLowerCase()
const lc = (a: string) => a.toLowerCase()

export interface SimOptions {
  /** Hashes that should revert instead of succeed (by function name), e.g. { fundInvoice: true }. */
  revert?: Partial<Record<string, boolean>>
  /** Functions that stay unmined (pending), by name. */
  hold?: Partial<Record<string, boolean>>
}

export function simulatedContract(getChain: () => MockChain, opts: SimOptions = {}) {
  const sent: { fn: string; from: string; args: readonly unknown[]; hash: string }[] = []
  const autoMine = (tx: { hash: string; from: string; to: string; data: Hex }) => {
    const chain = getChain()
    const s = chain.state
    const bal = (a: string) => s.balances.get(lc(a)) ?? BigInt(0)
    const setBal = (a: string, v: bigint) => s.balances.set(lc(a), v)

    if (lc(tx.to) === TOKEN) {
      const d = decodeFunctionData({ abi: paymentTokenAbi, data: tx.data }) as { functionName: string; args: readonly unknown[] }
      sent.push({ fn: d.functionName, from: tx.from, args: d.args, hash: tx.hash })
      if (opts.hold?.[d.functionName]) return null
      if (opts.revert?.[d.functionName]) return { status: "reverted" as const, logs: [] }
      if (d.functionName === "approve") {
        const [spender, value] = d.args as [string, bigint]
        s.allowances.set(allowanceKey(tx.from, spender), value)
        return { status: "success" as const, logs: [eventLog("paymentToken", "Approval", { owner: tx.from, spender, value })] }
      }
      return null
    }
    if (lc(tx.to) !== IA) return null
    const d = decodeFunctionData({ abi: invoiceAdvanceAbi, data: tx.data }) as { functionName: string; args: readonly unknown[] }
    sent.push({ fn: d.functionName, from: tx.from, args: d.args, hash: tx.hash })
    if (opts.hold?.[d.functionName]) return null
    if (opts.revert?.[d.functionName]) return { status: "reverted" as const, logs: [] }
    const pull = (from: string, amount: bigint) => {
      s.allowances.set(allowanceKey(from, IA), (s.allowances.get(allowanceKey(from, IA)) ?? BigInt(0)) - amount)
      setBal(from, bal(from) - amount)
    }
    const settle = (id: bigint) => {
      const inv = s.invoices.get(id)!
      const repaid = inv.advanceAmount
      const freelancerPaid = inv.amount - inv.advanceAmount
      s.escrow -= inv.amount
      s.reserve += repaid
      setBal(inv.freelancer, bal(inv.freelancer) + freelancerPaid)
      inv.status = 3
      return eventLog("invoiceAdvance", "InvoiceSettled", { invoiceId: id, reserveRepaid: repaid, freelancerPaid })
    }

    switch (d.functionName) {
      case "createInvoice": {
        const [freelancer, amount, metadataHash] = d.args as [string, bigint, Hex]
        const id = s.nextInvoiceId
        s.nextInvoiceId = id + BigInt(1)
        s.invoices.set(id, { freelancer, client: tx.from, amount, advanceAmount: BigInt(0), metadataHash, evaluationHash: ZERO_HASH, status: 0 } as never)
        return { status: "success" as const, logs: [eventLog("invoiceAdvance", "InvoiceCreated", { invoiceId: id, freelancer, client: tx.from, amount, metadataHash })] }
      }
      case "fundInvoice": {
        const id = d.args[0] as bigint
        const inv = s.invoices.get(id)!
        pull(tx.from, inv.amount)
        s.escrow += inv.amount
        inv.status = 1
        return { status: "success" as const, logs: [eventLog("invoiceAdvance", "InvoiceFunded", { invoiceId: id, client: tx.from, amount: inv.amount })] }
      }
      case "approveAdvance": {
        const [id, evaluationHash] = d.args as [bigint, Hex]
        const inv = s.invoices.get(id)!
        const advance = (inv.amount * BigInt(9000)) / BigInt(10000)
        s.reserve -= advance
        setBal(inv.freelancer, bal(inv.freelancer) + advance)
        inv.advanceAmount = advance
        inv.evaluationHash = evaluationHash
        inv.status = 2
        return { status: "success" as const, logs: [eventLog("invoiceAdvance", "AdvancePaid", { invoiceId: id, freelancer: inv.freelancer, amount: advance, evaluationHash })] }
      }
      case "approveCompletion": {
        const id = d.args[0] as bigint
        return { status: "success" as const, logs: [settle(id)] }
      }
      case "raiseDispute": {
        const id = d.args[0] as bigint
        const inv = s.invoices.get(id)!
        inv.status = 4
        return { status: "success" as const, logs: [eventLog("invoiceAdvance", "InvoiceDisputed", { invoiceId: id, client: tx.from, advanceAlreadyPaid: inv.advanceAmount })] }
      }
      case "resolveDispute": {
        const [id, release] = d.args as [bigint, boolean]
        const inv = s.invoices.get(id)!
        if (release) {
          return { status: "success" as const, logs: [eventLog("invoiceAdvance", "DisputeResolved", { invoiceId: id, releasedToFreelancer: true, unrecoveredAdvance: BigInt(0) }), settle(id)] }
        }
        // Refund: the client gets the whole escrow back, the invoice becomes Cancelled, an advance is NOT clawed back (reserve loss).
        s.escrow -= inv.amount
        setBal(inv.client, bal(inv.client) + inv.amount)
        inv.status = 5
        return {
          status: "success" as const,
          logs: [
            eventLog("invoiceAdvance", "DisputeResolved", { invoiceId: id, releasedToFreelancer: false, unrecoveredAdvance: inv.advanceAmount }),
            eventLog("invoiceAdvance", "InvoiceCancelled", { invoiceId: id }),
          ],
        }
      }
      case "depositReserve": {
        const amount = d.args[0] as bigint
        pull(tx.from, amount)
        s.reserve += amount
        return { status: "success" as const, logs: [eventLog("invoiceAdvance", "ReserveDeposited", { operator: tx.from, amount })] }
      }
      default:
        return null
    }
  }
  return { autoMine, sent }
}

/** A mock chain wired to the simulated contract, with the standard cast funded: client, operator and freelancer holding tokens. */
export function createSimulatedChain(opts: SimOptions & { balances?: Record<string, bigint>; tokenPaused?: boolean } = {}) {
  const holder: { chain?: MockChain } = {} // the mining callback needs the chain that is created with it
  const sim = simulatedContract(() => holder.chain!, opts)
  const chain = createMockChain({ autoMine: sim.autoMine, tokenPaused: opts.tokenPaused })
  holder.chain = chain
  // Start from an EMPTY ledger: no pre-made invoices, empty reserve and escrow.
  chain.state.invoices.clear()
  chain.state.nextInvoiceId = BigInt(1)
  chain.state.reserve = BigInt(0)
  chain.state.escrow = BigInt(0)
  chain.state.allowances.clear()
  chain.state.balances.clear()
  for (const [a, v] of Object.entries(opts.balances ?? {})) chain.state.balances.set(lc(a), v)
  return { chain, sim }
}

export { ADDR, EVAL }
