import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { advanceFor, formatToken, parseTokenInput, type TokenDisplay } from "../lib/frontend/token"

const RLUSD: TokenDisplay = { symbol: "RLUSD", name: "RLUSD", decimals: 18, isDemoToken: false, simulated: false }
const BPS = BigInt(10000)
const p = (t: string) => BigInt(parseTokenInput(t, RLUSD) ?? "-1")

// Mirrors the vault's documented checks (docs/VAULT_IMPLEMENTATION_SPEC.md §4.1/§4.5) with the contract constants unchanged.
const src = readFileSync("contracts/src/DuelyVault.sol", "utf8")
const constant = (name: string) => BigInt(new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(src)![1].replace(/_/g, ""))
const MAX_ADVANCE_BPS = constant("MAX_ADVANCE_BPS")
const MAX_UTILIZATION_BPS = constant("MAX_UTILIZATION_BPS")
const MAX_EXPOSURE_BPS = constant("MAX_INVOICE_EXPOSURE_BPS")
const FEE_BPS = constant("FEE_BPS")

describe("1 RLUSD demo with 4 RLUSD of LP liquidity (18 decimals, existing limits)", () => {
  const invoice = p("1.00")
  const nav = p("4.00")
  const advance = (invoice * MAX_ADVANCE_BPS) / BPS
  const fee = (invoice * FEE_BPS) / BPS

  it("parses fractional RLUSD exactly", () => {
    assert.equal(invoice, BigInt("1000000000000000000"))
    assert.equal(p("0.9"), BigInt("900000000000000000"))
    assert.equal(parseTokenInput("0.0000000000000000001", RLUSD), null) // >18 decimals is rejected, never rounded
    assert.equal(formatToken(advance.toString(), { token: RLUSD }), "0.9 RLUSD")
  })

  it("advance 0.90, fee 0.10, vault repaid 1.00, freelancer remainder 0.00 (100% slider)", () => {
    assert.equal(advance, p("0.90"))
    assert.equal(advanceFor(invoice.toString()), p("0.90").toString())
    assert.equal(fee, p("0.10"))
    assert.equal(advance + fee, p("1.00"))
    assert.equal(invoice - advance - fee, p("0.00"))
  })

  it("passes both vault limits at 4.00 NAV and fails below 3.60", () => {
    const ok = (n: bigint) => advance * BPS <= n * MAX_EXPOSURE_BPS && advance * BPS <= n * MAX_UTILIZATION_BPS
    assert.ok(ok(nav))
    assert.ok(ok(p("3.60")))
    assert.ok(!ok(p("3.59")))
    assert.ok(nav - advance >= advance) // cash covers the advance
  })

  it("the limits are read from the unchanged contract source", () => {
    assert.deepEqual([MAX_ADVANCE_BPS, MAX_UTILIZATION_BPS, MAX_EXPOSURE_BPS, FEE_BPS], [BigInt(9000), BigInt(8000), BigInt(2500), BigInt(1000)])
  })
})
