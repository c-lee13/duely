import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { DEFAULT_AMOUNT_DUSD, MAX_AMOUNT_DUSD, parseArgs } from "./args"

const B = (n: number | string) => BigInt(n)

describe("argument parsing: safe by default", () => {
  it("defaults to the read-only preflight with no flags", () => {
    const args = parseArgs([])
    assert.equal(args.mode, "preflight")
    assert.equal(args.yes, false)
    assert.equal(args.checkSigners, false)
    assert.equal(args.amountDusd, DEFAULT_AMOUNT_DUSD)
    assert.equal(args.amount, B(100000000))
    assert.equal(args.reportPath, undefined)
  })

  it("broadcasts only with an explicit --execute", () => {
    assert.equal(parseArgs(["--execute"]).mode, "execute")
    assert.equal(
      parseArgs(["--amount", "5", "--check-signers"]).mode,
      "preflight"
    )
    assert.equal(parseArgs(["--report", "out.json"]).mode, "preflight")
    assert.equal(parseArgs(["--yes", "--execute"]).yes, true)
  })

  it("rejects unknown flags and near-misses instead of ignoring them", () => {
    for (const bad of [
      "--exec",
      "--execute=true",
      "execute",
      "-x",
      "--force",
      "--mint",
    ]) {
      assert.throws(() => parseArgs([bad]), /unknown argument/, bad)
    }
  })

  it("--yes and --check-signers are only valid with the right mode", () => {
    assert.throws(() => parseArgs(["--yes"]), /--yes only makes sense/)
    assert.throws(
      () => parseArgs(["--execute", "--check-signers"]),
      /preflight option/
    )
  })

  it("--amount is strict dUSD in base-unit-safe form, capped for a test", () => {
    assert.equal(parseArgs(["--amount", "0.5"]).amount, B(500000))
    assert.equal(parseArgs(["--amount", "0.000001"]).amount, B(1))
    assert.equal(parseArgs(["--amount", MAX_AMOUNT_DUSD]).amount, B(1000000000))
    for (const bad of [
      "0",
      "0.0",
      "-1",
      "abc",
      "1e2",
      "0.0000001",
      ".5",
      "1,5",
      "",
      " 1",
      "1000.000001",
      "99999",
    ]) {
      assert.throws(
        () => parseArgs(["--amount", bad]),
        /--amount/,
        JSON.stringify(bad)
      )
    }
  })

  it("flags that need a value fail when it is missing or is another flag", () => {
    assert.throws(() => parseArgs(["--amount"]), /needs a value/)
    assert.throws(() => parseArgs(["--report"]), /needs a value/)
    assert.throws(() => parseArgs(["--amount", "--execute"]), /needs a value/)
  })

  it("--help is recognised", () => {
    assert.equal(parseArgs(["--help"]).help, true)
    assert.equal(parseArgs(["-h"]).help, true)
  })
})
