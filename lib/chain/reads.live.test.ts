import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseDusd } from "./amounts"
import { createChainPublicClient, type ChainReader } from "./client"
import { CHAIN_ID, contractAddresses } from "./config"
import { ChainReadError } from "./errors"
import {
  ROLE_IDS,
  findInvoice,
  getEscrowAllowance,
  getInvoice,
  getNextInvoiceId,
  getOnchainRoleIds,
  getPaymentTokenAddress,
  getReserveBalance,
  getReserveSnapshot,
  getTokenBalance,
  getTokenMetadata,
  getTotalEscrow,
  hasRole,
} from "./reads"

/**
 * Live, read-only validation against XRPL EVM Testnet (invoice #1 from the A5 smoke test).
 * Opt in with CHAIN_LIVE=1. The server RPC case additionally needs XRPL_EVM_RPC_URL; it is used
 * but never printed. No transactions are sent.
 */
const LIVE = process.env.CHAIN_LIVE === "1"

const EXPECTED = {
  invoiceAdvance: "0x328fc0DbF3d1F704B065192f4bFC7583bfA550E0",
  paymentToken: "0x5ff7b6ae08c37868303e7A815308Af476421506c",
  client: "0x8d93eD20e6eD28c34aE0057f441ED97d3e63459E",
  freelancer: "0x02379033ECD642D9A9aA590ABe763D62AEa967F4",
  operator: "0x6e83F6Bb6758Ced46e60be88271D72C22B84482E",
  evaluator: "0x276acaB037BB048a682E0E7ad900F3fFDCe65ECb",
}

const targets: { label: string; client: ChainReader | undefined }[] = [
  { label: "public RPC", client: createChainPublicClient() },
  {
    label: "server RPC (XRPL_EVM_RPC_URL)",
    client: process.env.XRPL_EVM_RPC_URL
      ? createChainPublicClient(process.env.XRPL_EVM_RPC_URL)
      : undefined,
  },
]

for (const { label, client } of targets) {
  describe(
    `live: ${label}`,
    {
      skip: !LIVE
        ? "set CHAIN_LIVE=1"
        : !client
          ? "XRPL_EVM_RPC_URL not set"
          : false,
    },
    () => {
      const opts = { client }

      it("is connected to chain 1449000", async () => {
        assert.equal((await client!.getBlockNumber()) > BigInt(0), true)
        assert.equal(CHAIN_ID, 1449000)
      })

      it("config addresses match the deployment and the contract's paymentToken()", async () => {
        assert.equal(contractAddresses.invoiceAdvance, EXPECTED.invoiceAdvance)
        assert.equal(contractAddresses.paymentToken, EXPECTED.paymentToken)
        assert.equal(await getPaymentTokenAddress(opts), EXPECTED.paymentToken)
      })

      it("invoice #1 is Settled with the expected parties and amounts", async () => {
        const inv = await getInvoice(1, opts)
        assert.equal(inv.client, EXPECTED.client)
        assert.equal(inv.freelancer, EXPECTED.freelancer)
        assert.equal(inv.amount, parseDusd("1000"))
        assert.equal(inv.advanceAmount, parseDusd("900"))
        assert.equal(inv.status, 3)
        assert.equal(inv.statusName, "Settled")
        assert.notEqual(inv.metadataHash, "0x" + "00".repeat(32))
        assert.notEqual(inv.evaluationHash, "0x" + "00".repeat(32))
      })

      it("reserve is 10,000 dUSD, escrow is 0, and the contract is solvent", async () => {
        assert.equal(await getReserveBalance(opts), parseDusd("10000"))
        assert.equal(await getTotalEscrow(opts), BigInt(0))
        const snap = await getReserveSnapshot(opts)
        assert.equal(snap.reserveBalance, parseDusd("10000"))
        assert.equal(snap.totalEscrow, BigInt(0))
        assert.equal(snap.contractTokenBalance, parseDusd("10000"))
        assert.equal(snap.solvent, true)
      })

      it("freelancer holds 1,000 dUSD; client and operator hold 0; client allowance is spent", async () => {
        assert.equal(
          await getTokenBalance(EXPECTED.freelancer, opts),
          parseDusd("1000")
        )
        assert.equal(await getTokenBalance(EXPECTED.client, opts), BigInt(0))
        assert.equal(await getTokenBalance(EXPECTED.operator, opts), BigInt(0))
        assert.equal(await getEscrowAllowance(EXPECTED.client, opts), BigInt(0))
      })

      it("token metadata is the labeled demo token", async () => {
        assert.deepEqual(await getTokenMetadata(opts), {
          name: "Duely Demo USD",
          symbol: "dUSD",
          decimals: 6,
        })
      })

      it("nextInvoiceId is 2 after the single smoke-test invoice", async () => {
        assert.equal(await getNextInvoiceId(opts), BigInt(2))
      })

      it("roles match the deployment, and the static role ids equal the contract getters", async () => {
        assert.equal(await hasRole("admin", EXPECTED.operator, opts), true)
        assert.equal(await hasRole("operator", EXPECTED.operator, opts), true)
        assert.equal(await hasRole("evaluator", EXPECTED.evaluator, opts), true)
        assert.equal(await hasRole("evaluator", EXPECTED.operator, opts), false)
        assert.equal(await hasRole("operator", EXPECTED.evaluator, opts), false)
        assert.equal(await hasRole("admin", EXPECTED.evaluator, opts), false)
        for (const role of ["admin", "operator", "evaluator"] as const) {
          assert.equal(await hasRole(role, EXPECTED.client, opts), false)
        }
        assert.deepEqual(await getOnchainRoleIds(opts), ROLE_IDS)
      })

      it("nonexistent and invalid invoice IDs are reported distinctly", async () => {
        assert.equal(await findInvoice(2, opts), null)
        assert.equal(await findInvoice("999999", opts), null)
        await assert.rejects(
          getInvoice(2, opts),
          (e) => e instanceof ChainReadError && e.code === "INVOICE_NOT_FOUND"
        )
        await assert.rejects(
          getInvoice(0, opts),
          (e) => e instanceof ChainReadError && e.code === "INVALID_INVOICE_ID"
        )
      })
    }
  )
}
