import assert from "node:assert/strict"
import fs from "node:fs"
import { describe, it } from "node:test"
import { ApiError } from "@/lib/backend/api-error"
import { checkOnchainEligibility } from "@/lib/backend/advances"
import { figuresFor } from "@/lib/frontend/api-mappers"
import { freelancerNextStep } from "@/lib/frontend/eligibility"
import type { InvoiceDetail, OnchainInvoiceStatus } from "@/lib/frontend/domain"
import { ONCHAIN_INVOICE_STATUSES, TX_ACTIONS } from "@/lib/shared/types"
import type { OnchainStatusDb, TxActionDb } from "@/lib/supabase/database.types"

const state = (onchainStatus: OnchainInvoiceStatus, advanceAmount = BigInt(0)) => ({ onchainStatus, amount: BigInt(1000), advanceAmount, blockNumber: BigInt(1) })
const codeOf = (fn: () => void) => {
  try {
    fn()
  } catch (e) {
    return e instanceof ApiError ? e.code : "other"
  }
  return "ok"
}

describe("status and action alignment with the compiled contract", () => {
  it("the shared status list is the contract's enum, in order, including Cancelled", () => {
    assert.deepEqual([...ONCHAIN_INVOICE_STATUSES], ["Created", "Funded", "Advanced", "Settled", "Disputed", "Cancelled"])
  })

  it("every contract status is a valid database status and a valid UI status (compile-time)", () => {
    const db: OnchainStatusDb[] = [...ONCHAIN_INVOICE_STATUSES]
    const ui: OnchainInvoiceStatus[] = [...db]
    assert.equal(ui.length, 6)
    const actions: TxActionDb[] = [...TX_ACTIONS, "approveWork", "disputeInvoice"]
    assert.equal(actions.length, TX_ACTIONS.length + 2)
  })

  it("the frontend domain re-exports the shared types instead of redefining them (one definition)", () => {
    const src = fs.readFileSync("lib/frontend/domain.ts", "utf8")
    assert.match(src, /from "@\/lib\/shared\/types"/)
    assert.doesNotMatch(src, /export type OnchainInvoiceStatus\s*=/)
    assert.doesNotMatch(src, /export type TxAction\s*=/)
  })

  it("only a Funded invoice with no advance can be advanced; Cancelled is refused with its own code", () => {
    assert.equal(codeOf(() => checkOnchainEligibility(state("Funded"))), "ok")
    assert.equal(codeOf(() => checkOnchainEligibility(state("Created"))), "NOT_FUNDED")
    assert.equal(codeOf(() => checkOnchainEligibility(state("Advanced"))), "ALREADY_ADVANCED")
    assert.equal(codeOf(() => checkOnchainEligibility(state("Disputed"))), "INVOICE_DISPUTED")
    assert.equal(codeOf(() => checkOnchainEligibility(state("Settled"))), "INVOICE_SETTLED")
    assert.equal(codeOf(() => checkOnchainEligibility(state("Cancelled"))), "INVOICE_CANCELLED")
    assert.equal(codeOf(() => checkOnchainEligibility(state("Funded", BigInt(900)))), "ALREADY_ADVANCED")
  })

  it("a cancelled invoice shows no escrow, no payout and no reserve credit", () => {
    assert.deepEqual(figuresFor("Cancelled", "1000", "0", true), { escrowBalance: "0", freelancerReceived: "0", reserveCredited: "0" })
  })

  it("a cancelled invoice is a terminal 'cancelled' step for the freelancer", () => {
    assert.equal(freelancerNextStep({ onchainStatus: "Cancelled", submissionStatus: "NotSubmitted" } as InvoiceDetail, undefined), "cancelled")
  })

  it("every state-changing contract function has a transaction action name (and only those)", () => {
    assert.deepEqual([...TX_ACTIONS].sort(), ["approveAdvance", "approveCompletion", "cancelInvoice", "createInvoice", "depositReserve", "fundInvoice", "raiseDispute", "resolveDispute", "withdrawReserve"])
  })
})
