import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { contractAddresses } from "./config"
import {
  getDeployment,
  getRegisteredToken,
  setDeploymentOverrideForTests,
  type DeploymentInfo,
} from "./deployments"
import { ChainWriteError } from "./errors"
import {
  parseSubmittedTransaction,
  serializeSubmittedTransaction,
  trackTransaction,
  waitForConfirmation,
} from "./lifecycle"
import { ADDR, allowanceKey, createMockChain } from "./test/mock-chain"
import { fundInvoice, submissionGuard } from "./writes"

afterEach(() => setDeploymentOverrideForTests(null))

function rlusdFixture(): DeploymentInfo {
  return {
    ...getDeployment("dusd"),
    key: "rlusd",
    token: getRegisteredToken("rlusd"),
  }
}

async function submittedFund() {
  submissionGuard.reset()
  const chain = createMockChain()
  chain.state.allowances.set(
    allowanceKey(ADDR.client, contractAddresses.invoiceAdvance),
    BigInt(1000000000)
  )
  const submitted = await fundInvoice(1, {
    wallet: chain.walletFor(ADDR.client),
    publicClient: chain.publicClient,
  })
  return { chain, submitted }
}

function rejectsMismatch(fn: () => unknown, pattern: RegExp) {
  assert.throws(
    fn,
    (e: unknown) =>
      e instanceof ChainWriteError &&
      e.code === "DEPLOYMENT_MISMATCH" &&
      pattern.test(e.message)
  )
}

describe("deployment identity on submitted and serialized transactions", () => {
  it("every submitted transaction records the deployment it was sent under", async () => {
    const { submitted } = await submittedFund()
    assert.deepEqual(submitted.deployment, {
      key: "dusd",
      invoiceAdvance: contractAddresses.invoiceAdvance,
      paymentToken: contractAddresses.paymentToken,
    })
  })

  it("serializes as version 2 with the deployment and round-trips under the same deployment", async () => {
    const { submitted } = await submittedFund()
    const json = serializeSubmittedTransaction(submitted)
    const stored = JSON.parse(json)
    assert.equal(stored.version, 2)
    assert.equal(stored.deployment.key, "dusd")
    const parsed = parseSubmittedTransaction(json)
    assert.equal(parsed.hash, submitted.hash)
    assert.deepEqual(parsed.deployment, submitted.deployment)
  })

  it("restoring a dUSD transaction under RLUSD fails explicitly", async () => {
    const { submitted } = await submittedFund()
    const json = serializeSubmittedTransaction(submitted)
    setDeploymentOverrideForTests(rlusdFixture())
    rejectsMismatch(
      () => parseSubmittedTransaction(json),
      /belongs to deployment "dusd".*active deployment is "rlusd"/
    )
  })

  it("restoring an RLUSD transaction under dUSD fails explicitly", async () => {
    setDeploymentOverrideForTests(rlusdFixture())
    const { submitted } = await submittedFund()
    const json = serializeSubmittedTransaction(submitted)
    assert.equal(JSON.parse(json).deployment.key, "rlusd")
    setDeploymentOverrideForTests(null)
    rejectsMismatch(
      () => parseSubmittedTransaction(json),
      /belongs to deployment "rlusd".*active deployment is "dusd"/
    )
  })

  it("same key but different contract addresses is rejected too", async () => {
    const { submitted } = await submittedFund()
    const stored = JSON.parse(serializeSubmittedTransaction(submitted))
    stored.deployment.invoiceAdvance = ADDR.stranger
    rejectsMismatch(
      () => parseSubmittedTransaction(JSON.stringify(stored)),
      /contract addresses differ/
    )
  })

  it("a malformed deployment block is rejected as malformed", async () => {
    const { submitted } = await submittedFund()
    const base = JSON.parse(serializeSubmittedTransaction(submitted))
    for (const bad of [
      undefined,
      null,
      "dusd",
      { key: "usdc", invoiceAdvance: ADDR.stranger, paymentToken: ADDR.client },
      { key: "dusd", invoiceAdvance: "0x1234", paymentToken: ADDR.client },
    ]) {
      const copy = { ...base, deployment: bad }
      assert.throws(
        () => parseSubmittedTransaction(JSON.stringify(copy)),
        (e: unknown) =>
          e instanceof ChainWriteError && e.code === "INVALID_INPUT"
      )
    }
  })

  it("legacy version 1 records restore under dUSD but are refused under RLUSD", async () => {
    const { submitted } = await submittedFund()
    const v1 = JSON.parse(serializeSubmittedTransaction(submitted))
    v1.version = 1
    delete v1.deployment
    const json = JSON.stringify(v1)
    const parsed = parseSubmittedTransaction(json)
    assert.equal(parsed.deployment?.key, "dusd")
    setDeploymentOverrideForTests(rlusdFixture())
    rejectsMismatch(
      () => parseSubmittedTransaction(json),
      /predates deployment tracking.*"rlusd"/
    )
  })

  it("an in-memory transaction from another deployment is not tracked either", async () => {
    const { chain, submitted } = await submittedFund()
    setDeploymentOverrideForTests(rlusdFixture())
    await assert.rejects(
      trackTransaction(submitted, { publicClient: chain.publicClient }),
      (e: unknown) =>
        e instanceof ChainWriteError && e.code === "DEPLOYMENT_MISMATCH"
    )
    await assert.rejects(
      waitForConfirmation(submitted, { publicClient: chain.publicClient }),
      (e: unknown) =>
        e instanceof ChainWriteError && e.code === "DEPLOYMENT_MISMATCH"
    )
  })
})
