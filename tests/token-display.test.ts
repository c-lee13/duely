import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { getDeployment, getRegisteredToken, setDeploymentOverrideForTests } from "@/lib/chain/deployments"
import { advanceFor, formatToken, MOCK_TOKEN, parseTokenInput, tokenDisplay, tokenNotice, tokens } from "@/lib/frontend/token"

afterEach(() => setDeploymentOverrideForTests(null))

const rlusd = () => setDeploymentOverrideForTests({ ...getDeployment("dusd"), key: "rlusd", token: getRegisteredToken("rlusd") })

describe("the UI token follows the active deployment (no hard-coded DEMO token)", () => {
  it("live mode on dUSD: dUSD, 6 decimals, a demo token", () => {
    const t = tokenDisplay("api")
    assert.deepEqual({ s: t.symbol, d: t.decimals, demo: t.isDemoToken, sim: t.simulated }, { s: "dUSD", d: 6, demo: true, sim: false })
  })

  it("live mode on RLUSD: RLUSD, 18 decimals, NOT a demo token", () => {
    rlusd()
    const t = tokenDisplay("api")
    assert.deepEqual({ s: t.symbol, d: t.decimals, demo: t.isDemoToken, sim: t.simulated }, { s: "RLUSD", d: 18, demo: false, sim: false })
  })

  it("mock mode is always the simulated DEMO token, whatever deployment is configured", () => {
    for (const setup of [() => undefined, rlusd]) {
      setup()
      assert.equal(tokenDisplay("mock"), MOCK_TOKEN)
      assert.equal(MOCK_TOKEN.symbol, "DEMO")
      assert.equal(MOCK_TOKEN.simulated, true)
    }
  })

  it("amounts are scaled by the deployment's decimals (1 dUSD = 10^6, 1 RLUSD = 10^18)", () => {
    const dusd = tokenDisplay("api")
    assert.equal(parseTokenInput("1000", dusd), "1000000000")
    assert.equal(formatToken("1000000000", { token: dusd }), "1,000 dUSD")
    rlusd()
    const r = tokenDisplay("api")
    assert.equal(parseTokenInput("1", r), "1000000000000000000")
    assert.equal(parseTokenInput("0.9", r), "900000000000000000")
    assert.equal(formatToken("900000000000000000", { token: r }), "0.9 RLUSD")
    assert.equal(formatToken("1000000000000000000", { token: r, symbol: false }), "1")
    assert.equal(tokens(2, r), "2000000000000000000")
  })

  it("rejects more fractional digits than the token has", () => {
    assert.equal(parseTokenInput("1.0000001", tokenDisplay("api")), null) // dUSD: 7 > 6
    rlusd()
    assert.notEqual(parseTokenInput("1.0000001", tokenDisplay("api")), null) // RLUSD allows 18
    assert.equal(parseTokenInput("0." + "1".repeat(19), tokenDisplay("api")), null)
  })

  it("a dUSD amount is never read as RLUSD: the same base units mean different things per deployment", () => {
    const base = "1000000000" // 1,000 dUSD (6 decimals)
    assert.equal(formatToken(base, { token: tokenDisplay("api") }), "1,000 dUSD")
    rlusd()
    assert.equal(formatToken(base, { token: tokenDisplay("api"), maxFraction: 18 }), "0.000000001 RLUSD")
  })

  it("the 90% advance is identical integer math at both precisions", () => {
    assert.equal(advanceFor("1000000000"), "900000000")
    assert.equal(advanceFor("1000000000000000000"), "900000000000000000")
    assert.equal(advanceFor("11"), "9")
  })

  it("the notice never calls dUSD or the mock RLUSD, and never calls RLUSD a demo token", () => {
    assert.match(tokenNotice(tokenDisplay("api")), /dUSD is a demo token.*not USDC or RLUSD/)
    assert.match(tokenNotice(MOCK_TOKEN), /simulated/i)
    rlusd()
    const n = tokenNotice(tokenDisplay("api"))
    assert.match(n, /RLUSD is the issuer's/)
    assert.doesNotMatch(n, /demo token/i)
  })

  it("no source file still imports the removed DEMO_TOKEN constant", () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".next", "contracts"].includes(e.name)) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name) && !p.endsWith("token-display.test.ts") && /\bDEMO_TOKEN\b/.test(fs.readFileSync(p, "utf8"))) hits.push(p)
      }
    }
    for (const d of ["app", "components", "hooks", "lib", "scripts", "tests"]) walk(path.resolve(process.cwd(), d))
    assert.deepEqual(hits, [])
  })
})
