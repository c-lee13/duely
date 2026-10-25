import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { decodeFunctionData, type Abi } from "viem"

import {
  advanceAmountFor,
  formatDusd,
  formatToken,
  formatTokenUnits,
  parseDusd,
  parseToken,
  parseTokenUnits,
  tokenDecimals,
} from "./amounts"
import {
  CHAIN_ID,
  contractAddresses,
  deployment as activeDeploymentView,
  paymentTokenInfo,
} from "./config"
import {
  DeploymentConfigError,
  configuredDeploymentKey,
  deploymentFromEntry,
  getActiveDeployment,
  getDeployment,
  getRegisteredToken,
  isDeploymentAvailable,
  parseDeploymentKey,
  setDeploymentOverrideForTests,
  type DeploymentInfo,
} from "./deployments"
import { ChainWriteError } from "./errors"
import { deployment as legacyDusd, paymentTokenAbi } from "./generated/index"
import { getTokenPauseStatus } from "./reads"
import {
  approveToken,
  prepareDepositReserve,
  prepareFundInvoice,
} from "./writes"
import type { WriteContext } from "./writes"
import { ADDR, allowanceKey, createMockChain } from "./test/mock-chain"
import { childEnv } from "./test/child-env"

const B = (n: number | string) => BigInt(n)

const KEYS = ["DUELY_DEPLOYMENT", "NEXT_PUBLIC_DUELY_DEPLOYMENT"] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  setDeploymentOverrideForTests(null)
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  setDeploymentOverrideForTests(null)
})

/** An RLUSD deployment fixture: real token facts, the mock chain's InvoiceAdvance address. */
function rlusdFixture(): DeploymentInfo {
  const dusd = getDeployment("dusd")
  const token = getRegisteredToken("rlusd")
  return {
    ...dusd,
    key: "rlusd",
    token: {
      ...token,
      address: token.address,
    },
  }
}

describe("deployment selection", () => {
  it("defaults to dUSD and matches the historical constants exactly", () => {
    assert.equal(configuredDeploymentKey(), "dusd")
    assert.equal(CHAIN_ID, 1449000)
    assert.equal(
      contractAddresses.invoiceAdvance,
      legacyDusd.contracts.invoiceAdvance.address
    )
    assert.equal(
      contractAddresses.paymentToken,
      legacyDusd.contracts.paymentToken.address
    )
    assert.equal(paymentTokenInfo.symbol, "dUSD")
    assert.equal(paymentTokenInfo.decimals, 6)
    assert.equal(paymentTokenInfo.isDemoToken, true)
    assert.equal(activeDeploymentView.roles.operator, legacyDusd.roles.operator)
    assert.equal(
      activeDeploymentView.contracts.paymentToken.name,
      legacyDusd.contracts.paymentToken.name
    )
  })

  it("accepts DUELY_DEPLOYMENT=dusd and the browser variable", () => {
    process.env.DUELY_DEPLOYMENT = "dusd"
    assert.equal(configuredDeploymentKey(), "dusd")
    delete process.env.DUELY_DEPLOYMENT
    process.env.NEXT_PUBLIC_DUELY_DEPLOYMENT = "dusd"
    assert.equal(configuredDeploymentKey(), "dusd")
  })

  it("rejects unknown keys instead of guessing", () => {
    for (const bad of ["usdc", "RLUSD", "dUSD", " rlusd", "rlusd "]) {
      assert.throws(
        () => parseDeploymentKey(bad),
        (e: unknown) =>
          e instanceof DeploymentConfigError && e.code === "UNKNOWN_DEPLOYMENT"
      )
    }
    process.env.DUELY_DEPLOYMENT = "nonsense"
    assert.throws(() => contractAddresses.invoiceAdvance, DeploymentConfigError)
  })

  it("rejects a server/browser disagreement", () => {
    process.env.DUELY_DEPLOYMENT = "dusd"
    process.env.NEXT_PUBLIC_DUELY_DEPLOYMENT = "rlusd"
    assert.throws(
      () => getActiveDeployment(),
      (e: unknown) =>
        e instanceof DeploymentConfigError && e.code === "DEPLOYMENT_MISMATCH"
    )
    process.env.NEXT_PUBLIC_DUELY_DEPLOYMENT = "dusd"
    assert.equal(getActiveDeployment().key, "dusd")
  })

  it("a registered but undeployed token fails explicitly and never falls back to dUSD", () => {
    const entry = {
      key: "rlusd",
      status: "not_deployed",
      token: getRegisteredToken("rlusd"),
    }
    assert.throws(
      () => deploymentFromEntry("rlusd", entry),
      (e: unknown) =>
        e instanceof DeploymentConfigError &&
        e.code === "DEPLOYMENT_NOT_DEPLOYED" &&
        /rlusd/.test(e.message)
    )
    const t = getRegisteredToken("rlusd")
    assert.equal(t.symbol, "RLUSD")
    assert.equal(t.decimals, 18)
    assert.equal(t.address, "0x27b57a9D0b8d24EB97259c4E2279e45255e016f3")
    assert.equal(t.isDemoToken, false)
  })

  it("RLUSD is deployed with its own InvoiceAdvance and is never confused with dUSD", () => {
    assert.equal(isDeploymentAvailable("rlusd"), true)
    process.env.DUELY_DEPLOYMENT = "rlusd"
    assert.equal(
      contractAddresses.invoiceAdvance,
      "0x1B972ec6B1B5E0b592010e7484beF0accC382792"
    )
    assert.equal(
      contractAddresses.paymentToken,
      "0x27b57a9D0b8d24EB97259c4E2279e45255e016f3"
    )
    assert.equal(paymentTokenInfo.symbol, "RLUSD")
    assert.equal(paymentTokenInfo.decimals, 18)
    assert.equal(paymentTokenInfo.isDemoToken, false)
    delete process.env.DUELY_DEPLOYMENT
    assert.equal(paymentTokenInfo.symbol, "dUSD") // default unchanged
    assert.equal(
      contractAddresses.invoiceAdvance,
      "0x328fc0DbF3d1F704B065192f4bFC7583bfA550E0"
    )
  })

  it("a fresh process follows DUELY_DEPLOYMENT with no test seam", () => {
    const entry = fileURLToPath(new URL("./index.ts", import.meta.url))
    const register = fileURLToPath(
      new URL("./test/register.mjs", import.meta.url)
    )
    const script = `import * as sdk from ${JSON.stringify(entry)}; console.log(sdk.contractAddresses.invoiceAdvance, sdk.paymentTokenInfo.symbol)`
    const run = (env: Record<string, string>) =>
      spawnSync(
        process.execPath,
        ["--import", register, "--input-type=module", "-e", script],
        {
          encoding: "utf8",
          env: childEnv({ PATH: process.env.PATH, ...env }),
        }
      )
    const dusd = run({})
    assert.equal(dusd.status, 0, dusd.stderr)
    assert.match(dusd.stdout, /0x328fc0DbF3d1F704B065192f4bFC7583bfA550E0 dUSD/)
    const rlusd = run({ DUELY_DEPLOYMENT: "rlusd" })
    assert.equal(rlusd.status, 0, rlusd.stderr)
    assert.match(
      rlusd.stdout,
      /0x1B972ec6B1B5E0b592010e7484beF0accC382792 RLUSD/
    )
    const bad = run({ DUELY_DEPLOYMENT: "usdc" })
    assert.notEqual(bad.status, 0)
    assert.doesNotMatch(bad.stdout, /0x328fc0/i, "no silent fallback")
    const mismatch = run({
      DUELY_DEPLOYMENT: "dusd",
      NEXT_PUBLIC_DUELY_DEPLOYMENT: "rlusd",
    })
    assert.notEqual(mismatch.status, 0)
  })

  it("switching the deployment changes every token-specific value together", () => {
    setDeploymentOverrideForTests(rlusdFixture())
    assert.equal(paymentTokenInfo.symbol, "RLUSD")
    assert.equal(paymentTokenInfo.decimals, 18)
    assert.equal(paymentTokenInfo.isDemoToken, false)
    assert.equal(paymentTokenInfo.kind, "external")
    assert.equal(
      contractAddresses.paymentToken,
      "0x27b57a9D0b8d24EB97259c4E2279e45255e016f3"
    )
    assert.equal(
      activeDeploymentView.contracts.paymentToken.address,
      contractAddresses.paymentToken
    )
    assert.equal(tokenDecimals(), 18)
    setDeploymentOverrideForTests(null)
    assert.equal(paymentTokenInfo.symbol, "dUSD")
    assert.equal(tokenDecimals(), 6)
  })
})

describe("generic amount helpers", () => {
  it("parse and format with explicit decimals", () => {
    assert.equal(parseTokenUnits("1000", 6), B(1_000_000_000))
    assert.equal(parseTokenUnits("1000", 18), B("1000000000000000000000"))
    assert.equal(parseTokenUnits("0.000001", 6), B(1))
    assert.throws(() => parseTokenUnits("0.0000001", 6), RangeError)
    assert.throws(() => parseTokenUnits("1e3", 18), RangeError)
    assert.throws(() => parseTokenUnits("-1", 18), RangeError)
    assert.equal(formatTokenUnits(B("1500000000000000000"), 18), "1.5")
    assert.equal(formatTokenUnits(B(1_500_000), 6), "1.5")
  })

  it("legacy dUSD aliases are the active-token helpers", () => {
    assert.equal(parseDusd, parseToken)
    assert.equal(formatDusd, formatToken)
    assert.equal(parseDusd("12.5"), B(12_500_000))
    setDeploymentOverrideForTests(rlusdFixture())
    assert.equal(parseToken("12.5"), B("12500000000000000000"))
    assert.equal(formatToken(B("12500000000000000000")), "12.5")
    assert.throws(() => parseToken("0.0000000000000000001"), /RLUSD/)
  })

  it("the 90% advance is exact for both tokens", () => {
    const cases: [number, string][] = [
      [6, "1000"],
      [18, "1000"],
      [6, "0.000011"],
      [18, "0.000000000000000011"],
    ]
    for (const [decimals, human] of cases) {
      const amount = parseTokenUnits(human, decimals)
      assert.equal(advanceAmountFor(amount), (amount * B(90)) / B(100))
    }
    assert.equal(advanceAmountFor(parseTokenUnits("1000", 6)), B(900_000_000))
    assert.equal(
      advanceAmountFor(parseTokenUnits("1000", 18)),
      parseTokenUnits("900", 18)
    )
    assert.equal(advanceAmountFor(B(11)), B(9)) // floors: 9.9
    assert.equal(advanceAmountFor(B(1)), B(0))
  })
})

describe("RLUSD pause handling", () => {
  function setup(tokenPaused?: boolean) {
    const chain = createMockChain({ tokenPaused })
    const owner = ADDR.client
    chain.state.allowances.set(
      allowanceKey(owner, contractAddresses.invoiceAdvance),
      B(1_000_000_000)
    )
    const ctx = (who: string): WriteContext => ({
      wallet: chain.walletFor(who),
      publicClient: chain.publicClient,
    })
    return { chain, ctx }
  }

  it("a token without paused() (MockUSDC) is 'unsupported', not an error", async () => {
    const { chain } = setup()
    assert.deepEqual(
      await getTokenPauseStatus({ client: chain.publicClient }),
      { supported: false, paused: false }
    )
  })

  it("a node that reverts with no data (a real MockUSDC) is also 'unsupported'", async () => {
    const chain = createMockChain({ tokenPauseRevertsEmpty: true })
    assert.deepEqual(
      await getTokenPauseStatus({ client: chain.publicClient }),
      {
        supported: false,
        paused: false,
      }
    )
  })

  it("reports pausable tokens as paused or running", async () => {
    for (const paused of [false, true]) {
      const { chain } = setup(paused)
      assert.deepEqual(
        await getTokenPauseStatus({ client: chain.publicClient }),
        { supported: true, paused }
      )
    }
  })

  it("a paused token blocks readiness with a clear reason", async () => {
    const { chain } = setup(true)
    const opts = { client: chain.publicClient }
    const fund = await prepareFundInvoice(1, ADDR.client, opts)
    assert.equal(fund.ready, false)
    assert.equal(fund.tokenPaused, true)
    assert.match(fund.blockers.join(" "), /paused by its issuer/)
    const dep = await prepareDepositReserve(B(100), ADDR.operator, opts)
    assert.equal(dep.tokenPaused, true)
    assert.match(dep.blockers.join(" "), /paused by its issuer/)

    const running = setup(false)
    const ok = await prepareFundInvoice(1, ADDR.client, {
      client: running.chain.publicClient,
    })
    assert.equal(ok.tokenPaused, false)
    assert.equal(ok.ready, true)
  })

  it("EnforcedPause from a simulation becomes TOKEN_PAUSED and nothing is sent", async () => {
    const { chain, ctx } = setup(true)
    await assert.rejects(
      approveToken(
        { spender: contractAddresses.invoiceAdvance, amount: B(5) },
        ctx(ADDR.client)
      ),
      (e: unknown) =>
        e instanceof ChainWriteError &&
        e.code === "TOKEN_PAUSED" &&
        e.revertName === "EnforcedPause"
    )
    assert.equal(chain.sent.length, 0)
  })
})

describe("RLUSD (18 decimals) through the write SDK", () => {
  it("approves an 18-decimal amount to the RLUSD token address", async () => {
    setDeploymentOverrideForTests(rlusdFixture())
    const chain = createMockChain()
    const amount = parseToken("1000")
    const result = await approveToken(
      { spender: contractAddresses.invoiceAdvance, amount },
      { wallet: chain.walletFor(ADDR.client), publicClient: chain.publicClient }
    )
    assert.ok(result.hash)
    const tx = chain.sent[chain.sent.length - 1]
    assert.equal(
      tx.to.toLowerCase(),
      "0x27b57a9d0b8d24eb97259c4e2279e45255e016f3"
    )
    const decoded = decodeFunctionData({
      abi: paymentTokenAbi as Abi,
      data: tx.data,
    }) as { functionName: string; args: readonly unknown[] }
    assert.equal(decoded.functionName, "approve")
    assert.equal(decoded.args[1], B("1000000000000000000000"))
  })
})
