import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { MAX_UINT256, advanceAmountFor, parseDusd } from "./amounts"
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
  getReserveSnapshot,
  getTokenBalance,
  getTokenMetadata,
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

      it("escrow and reserve accounting are consistent with every invoice, at one pinned block", async () => {
        const block = await client!.getBlockNumber()
        const pinned = { client, blockNumber: block }
        const [snap, next] = await Promise.all([
          getReserveSnapshot(pinned),
          getNextInvoiceId(pinned),
        ])
        let expectedEscrow = BigInt(0)
        for (let id = BigInt(1); id < next; id++) {
          const inv = await getInvoice(id, pinned)
          // Escrow is held for Funded, Advanced and Disputed invoices only.
          if (["Funded", "Advanced", "Disputed"].includes(inv.statusName)) {
            expectedEscrow += inv.amount
          }
          // An advance is always exactly 90% (floor) of the invoice, or zero.
          if (inv.advanceAmount > BigInt(0)) {
            assert.equal(inv.advanceAmount, advanceAmountFor(inv.amount))
            assert.equal(
              ["Advanced", "Settled", "Disputed"].includes(inv.statusName),
              true,
              `invoice ${id} has an advance but is ${inv.statusName}`
            )
          }
        }
        assert.equal(snap.totalEscrow, expectedEscrow)
        assert.equal(
          snap.reserveBalance + snap.totalEscrow <= snap.contractTokenBalance,
          true,
          "contract must hold at least reserve + escrow"
        )
        assert.equal(snap.solvent, true)
      })

      it("balances and allowances are consistent with the invoice history", async () => {
        const block = await client!.getBlockNumber()
        const pinned = { client, blockNumber: block }
        const next = await getNextInvoiceId(pinned)
        let settledToFreelancer = BigInt(0)
        let clientCreated = BigInt(0)
        for (let id = BigInt(1); id < next; id++) {
          const inv = await getInvoice(id, pinned)
          if (
            inv.statusName === "Settled" &&
            inv.freelancer === EXPECTED.freelancer
          ) {
            settledToFreelancer += inv.amount
          }
          if (inv.statusName === "Created" && inv.client === EXPECTED.client) {
            clientCreated += inv.amount
          }
        }
        // The freelancer received at least every settled invoice (it may hold more).
        assert.equal(
          (await getTokenBalance(EXPECTED.freelancer, pinned)) >=
            settledToFreelancer,
          true
        )
        // Approvals are exact: the client never has more allowance than its unfunded invoices.
        assert.equal(
          (await getEscrowAllowance(EXPECTED.client, pinned)) <= clientCreated,
          true
        )
        assert.equal(
          (await getEscrowAllowance(EXPECTED.client, pinned)) <
            MAX_UINT256 / BigInt(2),
          true,
          "no unlimited approval"
        )
      })

      it("token metadata is the labeled demo token", async () => {
        assert.deepEqual(await getTokenMetadata(opts), {
          name: "Duely Demo USD",
          symbol: "dUSD",
          decimals: 6,
        })
      })

      it("nextInvoiceId is one past the last invoice, and every earlier id decodes", async () => {
        const next = await getNextInvoiceId(opts)
        assert.equal(next >= BigInt(2), true, "at least the smoke-test invoice")
        for (let id = BigInt(1); id < next; id++) {
          assert.equal((await getInvoice(id, opts)).invoiceId, id)
        }
        assert.equal(await findInvoice(next, opts), null)
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
        const missing = (await getNextInvoiceId(opts)) + BigInt(1)
        assert.equal(await findInvoice(missing, opts), null)
        assert.equal(await findInvoice("999999", opts), null)
        await assert.rejects(
          getInvoice(missing, opts),
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
