import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  MAX_UINT256,
  advanceAmountFor,
  formatDusd,
  fromTokenAmount,
  parseDusd,
  toTokenAmount,
} from "./amounts"

const B = (n: number | string) => BigInt(n)

describe("dUSD amounts", () => {
  it("parses human amounts to 6-decimal base units", () => {
    assert.equal(parseDusd("1000"), B(1000000000))
    assert.equal(parseDusd("12.5"), B(12500000))
    assert.equal(parseDusd("0.000001"), B(1))
    assert.equal(parseDusd("0"), B(0))
  })

  it("rejects ambiguous or lossy input instead of rounding", () => {
    for (const bad of [
      "0.0000001",
      "-1",
      "1e3",
      ".5",
      "1,000",
      "",
      " 1",
      "1 ",
      "abc",
      "1.",
      "0x10",
    ]) {
      assert.throws(() => parseDusd(bad), RangeError, `should reject "${bad}"`)
    }
    assert.throws(() => parseDusd(1000 as unknown as string), RangeError)
    assert.throws(() => parseDusd((MAX_UINT256 + B(1)).toString()), RangeError)
  })

  it("formats base units without float math", () => {
    assert.equal(formatDusd(B(1000000000)), "1000")
    assert.equal(formatDusd(B(12500000)), "12.5")
    assert.equal(formatDusd(B(1)), "0.000001")
    assert.equal(formatDusd(B(0)), "0")
    assert.equal(
      formatDusd(MAX_UINT256),
      "115792089237316195423570985008687907853269984665640564039457584007913129.639935"
    )
    assert.throws(() => formatDusd(B(-1)), RangeError)
    assert.throws(() => formatDusd(1000 as unknown as bigint), TypeError)
  })

  it("round-trips parse/format", () => {
    for (const v of [
      "0",
      "1",
      "0.000001",
      "999999.999999",
      "1000",
      "123456789.123456",
    ]) {
      assert.equal(formatDusd(parseDusd(v)), v)
    }
  })

  it("converts decimal base-unit strings for JSON strictly", () => {
    assert.equal(toTokenAmount(B(900000000)), "900000000")
    assert.equal(fromTokenAmount("900000000"), B(900000000))
    assert.equal(fromTokenAmount(MAX_UINT256.toString()), MAX_UINT256)
    for (const bad of [
      "1.5",
      "-1",
      "1e9",
      " 1",
      "",
      "0x1",
      "١٢٣",
      (MAX_UINT256 + B(1)).toString(),
    ]) {
      assert.throws(
        () => fromTokenAmount(bad),
        RangeError,
        `should reject "${bad}"`
      )
    }
    assert.throws(() => toTokenAmount(B(-1)), RangeError)
  })

  it("computes the advance as floor(amount * 9000 / 10000)", () => {
    assert.equal(advanceAmountFor(B(1000000000)), B(900000000))
    assert.equal(advanceAmountFor(B(1)), B(0))
    assert.equal(advanceAmountFor(B(19)), B(17))
    assert.equal(advanceAmountFor(B(1234567)), B(1111110))
    assert.equal(advanceAmountFor(B(0)), B(0))
  })

  it("matches the contract's overflow-safe formula, including near uint256 max", () => {
    // InvoiceAdvance._advanceFor: (a / 10000) * 9000 + ((a % 10000) * 9000) / 10000
    const contractFormula = (a: bigint) =>
      (a / B(10000)) * B(9000) + ((a % B(10000)) * B(9000)) / B(10000)
    const samples = [
      B(0),
      B(1),
      B(9999),
      B(10000),
      B(10001),
      B(123456789),
      MAX_UINT256,
      MAX_UINT256 - B(1),
      MAX_UINT256 / B(2),
    ]
    for (const a of samples)
      assert.equal(advanceAmountFor(a), contractFormula(a))
    for (let i = 0; i < 500; i++) {
      const a =
        (BigInt(Math.floor(Math.random() * 2 ** 52)) << B(150)) +
        BigInt(Math.floor(Math.random() * 2 ** 52))
      assert.equal(advanceAmountFor(a), contractFormula(a))
    }
    assert.throws(() => advanceAmountFor(MAX_UINT256 + B(1)), RangeError)
  })
})
