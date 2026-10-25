import "server-only"
import type { PublicClient } from "viem"
import {
  EXPECTED_EVENTS,
  ChainReadError,
  activeDeploymentIdentity,
  explorerTxUrl,
  getAvailableReserve,
  hasRole,
  getInvoice,
  getPaymentTokenAddress,
  getTransactionStatus,
  invoiceAdvanceAbi,
  trackTransaction,
  decodeInvoiceAdvanceEvents,
  type ChainWriteClient,
  type SubmittedTransaction,
  type TransactionStatus,
} from "@/lib/chain"
import { activeDeployment } from "@/lib/chain/config"
import { getServerPublicClient } from "@/lib/chain/server"
import type { Address, Bytes32 } from "@/lib/frontend/domain"
import type { ChainFundingVerifier } from "@/lib/evidence/service"
import { invoiceInScope, type DeploymentScope } from "@/lib/shared/deployment-scope"
import {
  ChainInvoiceNotFoundError,
  ChainScopeError,
  type ChainAdapter,
  type ChainAdvanceFound,
  type ChainAdvanceTxRef,
  type ChainInvoiceCreation,
  type ChainInvoiceRef,
  type ChainInvoiceState,
  type ChainTxStatus,
} from "./ports"

/** The viem client surface the adapter needs: the SDK's read/write-context client plus event scanning. */
export type AdapterClient = ChainWriteClient & Pick<PublicClient, "getLogs" | "getTransaction">

/** How far back crash recovery scans for an AdvancePaid event. XRPL EVM testnet blocks are a few seconds apart. */
export const RECOVERY_LOOKBACK_BLOCKS = BigInt(5000)

const ZERO_ADDRESS = ("0x" + "0".repeat(40)) as Address
const ZERO_HASH = ("0x" + "0".repeat(64)) as Bytes32
const lower = (s: string) => s.toLowerCase()
/** Every address leaving the adapter is lower-case: that is the application and database convention (the SDK returns EIP-55). */
const addr = (s: string) => s.toLowerCase() as Address

/**
 * The backend's ONLY reader of the chain. It is a thin adapter over the Track A SDK (lib/chain): every read goes to the
 * configured deployment's InvoiceAdvance, reads that belong together are pinned to one block, and a reference that points
 * at another chain/contract/token is refused with ChainScopeError instead of being read. RPC failures propagate as errors
 * (the services turn them into 502 CHAIN_ERROR); nothing here ever substitutes a cached or mock answer.
 */
export function createChainAdapter(opts: { scope: DeploymentScope; client?: AdapterClient }): ChainAdapter {
  const { scope } = opts
  const client = (): AdapterClient => opts.client ?? (getServerPublicClient() as unknown as AdapterClient)

  function assertRefInScope(ref: ChainInvoiceRef) {
    if (!invoiceInScope({ chain_id: ref.chainId, contract_address: ref.contractAddress }, scope) || ref.chainId === 0) {
      throw new ChainScopeError()
    }
  }

  async function assertClientChain(c: AdapterClient) {
    const id = await c.getChainId()
    if (id !== scope.chainId) throw new ChainScopeError(`The RPC reports chain ${id}, not ${scope.chainId}.`)
  }

  function submittedFor(ref: ChainAdvanceTxRef): SubmittedTransaction {
    const spec = EXPECTED_EVENTS.approveAdvance
    return {
      hash: ref.txHash,
      functionName: "approveAdvance",
      from: ref.from,
      chainId: scope.chainId,
      expected: { contract: spec.contract, eventName: spec.eventName, args: { invoiceId: ref.invoiceId, evaluationHash: ref.evaluationHash } },
      submittedAt: ref.submittedAt,
      explorerUrl: explorerTxUrl(ref.txHash),
      deployment: activeDeploymentIdentity(),
    }
  }

  function toTxStatus(status: TransactionStatus, ref: ChainAdvanceTxRef): ChainTxStatus {
    switch (status.state) {
      case "pending":
        return { state: "pending" }
      case "unknown":
        return { state: "unknown", reason: status.reason }
      case "reverted":
        return { state: "reverted", blockNumber: status.blockNumber, reason: status.error.message }
      case "replaced":
        return { state: "replaced", reason: status.error.message }
      case "unverified":
        return { state: "unverified", reason: status.error.message }
      case "confirmed": {
        // `verified` + the matched event prove "this transaction, from this sender, to this contract, emitted AdvancePaid for
        // this invoice and evaluation hash". The payout facts (who, how much) are read from that same decoded event.
        const paid = status.events.find(
          (e) => e.eventName === "AdvancePaid" && e.args.invoiceId === ref.invoiceId && lower(e.args.evaluationHash) === lower(ref.evaluationHash)
        )
        if (!status.verified || !status.event || !paid || paid.eventName !== "AdvancePaid") {
          return { state: "unverified", reason: "The receipt did not carry the expected AdvancePaid event." }
        }
        return {
          state: "confirmed",
          blockNumber: status.blockNumber,
          blockHash: status.receipt.blockHash as Bytes32,
          logIndex: paid.logIndex ?? 0,
          paid: {
            invoiceId: paid.args.invoiceId,
            freelancer: addr(paid.args.freelancer),
            amount: paid.args.amount,
            evaluationHash: paid.args.evaluationHash as Bytes32,
          },
        }
      }
    }
  }

  const notCreated = (status: ChainInvoiceCreation["status"], chainId: number, contract: Address): ChainInvoiceCreation => ({
    status,
    chainId,
    contractAddress: contract,
    tokenAddress: ZERO_ADDRESS,
    invoiceId: BigInt(0),
    creator: ZERO_ADDRESS,
    freelancer: ZERO_ADDRESS,
    amount: BigInt(0),
    criteriaHash: ZERO_HASH,
    blockNumber: BigInt(0),
  })

  return {
    available: true,

    async getInvoiceCreation(txHash) {
      const c = client()
      await assertClientChain(c)
      const status = await getTransactionStatus(txHash, { publicClient: c })
      const contract = activeDeployment().invoiceAdvance.address as Address
      switch (status.state) {
        case "pending":
          return notCreated("pending", scope.chainId, contract)
        case "reverted":
          return notCreated("reverted", scope.chainId, contract)
        case "unknown":
          if (status.reason === "not_found") return notCreated("not_found", scope.chainId, contract)
          throw new Error(`transaction lookup failed (${status.reason})`)
        case "replaced":
        case "unverified":
          return notCreated("not_found", scope.chainId, contract)
        case "confirmed": {
          const receipt = status.receipt
          // The transaction must have been SENT TO this deployment's InvoiceAdvance; anything else is another deployment (or contract).
          if (!receipt.to || lower(receipt.to) !== lower(scope.contractAddress)) throw new ChainScopeError()
          const token = await getPaymentTokenAddress({ client: c })
          if (lower(token) !== lower(scope.tokenAddress)) throw new ChainScopeError()
          const created = decodeInvoiceAdvanceEvents(receipt).filter((e) => e.eventName === "InvoiceCreated")
          // Exactly one InvoiceCreated, created BY the transaction's sender: a batched or relayed call is not a registration we can attribute.
          if (created.length !== 1 || created[0].eventName !== "InvoiceCreated") return notCreated("not_found", scope.chainId, contract)
          const e = created[0].args
          if (lower(e.client) !== lower(receipt.from)) return notCreated("not_found", scope.chainId, contract)
          return {
            status: "confirmed",
            chainId: scope.chainId,
            contractAddress: addr(receipt.to),
            tokenAddress: addr(token),
            invoiceId: e.invoiceId,
            creator: addr(receipt.from),
            freelancer: addr(e.freelancer),
            amount: e.amount,
            criteriaHash: e.metadataHash as Bytes32,
            blockNumber: receipt.blockNumber,
          }
        }
      }
    },

    async getInvoiceState(ref): Promise<ChainInvoiceState> {
      assertRefInScope(ref)
      const c = client()
      await assertClientChain(c)
      // One block for the whole read, so the status, amounts and hashes belong together.
      const blockNumber = await c.getBlockNumber()
      let inv
      try {
        inv = await getInvoice(ref.invoiceId, { client: c, blockNumber })
      } catch (e) {
        if (e instanceof ChainReadError && e.code === "INVOICE_NOT_FOUND") throw new ChainInvoiceNotFoundError()
        throw e
      }
      return {
        onchainStatus: inv.statusName,
        amount: inv.amount,
        advanceAmount: inv.advanceAmount,
        blockNumber,
        client: addr(inv.client),
        freelancer: addr(inv.freelancer),
        criteriaHash: inv.metadataHash as Bytes32,
        evaluationHash: inv.evaluationHash as Bytes32,
      }
    },

    async getReserveAvailable() {
      const c = client()
      await assertClientChain(c)
      return getAvailableReserve({ client: c })
    },

    async getAdvanceTransaction(ref, o) {
      const c = client()
      await assertClientChain(c)
      const submitted = submittedFor(ref)
      const waitMs = o?.waitMs ?? 0
      const status =
        waitMs > 0
          ? await trackTransaction(submitted, { publicClient: c, timeoutMs: waitMs })
          : await getTransactionStatus(submitted, { publicClient: c })
      return toTxStatus(status, ref)
    },

    async hasRole(role, address) {
      const c = client()
      await assertClientChain(c)
      return hasRole(role, address, { client: c })
    },

    async findAdvancePaid(ref): Promise<ChainAdvanceFound | null> {
      assertRefInScope(ref)
      const c = client()
      await assertClientChain(c)
      const head = await c.getBlockNumber()
      const deployBlock = BigInt(activeDeployment().invoiceAdvance.deployBlock)
      const floor = head > RECOVERY_LOOKBACK_BLOCKS ? head - RECOVERY_LOOKBACK_BLOCKS : BigInt(0)
      const event = invoiceAdvanceAbi.find((x) => x.type === "event" && x.name === "AdvancePaid")
      if (!event || event.type !== "event") throw new Error("AdvancePaid is missing from the ABI")
      const logs = await c.getLogs({
        address: scope.contractAddress as Address,
        event,
        args: { invoiceId: ref.invoiceId },
        fromBlock: floor > deployBlock ? floor : deployBlock,
        toBlock: head,
      })
      const log = logs[0]
      if (!log || !log.transactionHash) return null
      const tx = await c.getTransaction({ hash: log.transactionHash })
      return {
        txHash: log.transactionHash as Bytes32,
        from: addr(tx.from),
        blockNumber: log.blockNumber ?? BigInt(0),
        evaluationHash: (log.args as { evaluationHash: Bytes32 }).evaluationHash,
      }
    },
  }
}

/**
 * Funding check for evidence upload, on top of the same adapter. It says "verified" only with a status read from the
 * chain for THIS deployment; every failure (RPC down, wrong deployment, missing invoice, a party that doesn't match
 * what we registered, a dev fixture that was never on-chain) is "unavailable", which the evidence service refuses
 * whenever chain verification is required. It never reports funding it did not read.
 */
export function createChainFundingVerifier(chain: ChainAdapter): ChainFundingVerifier {
  return {
    async verify(invoice) {
      if (!chain.available || invoice.chain_id === 0) return { status: "unavailable" }
      try {
        const state = await chain.getInvoiceState({
          chainId: invoice.chain_id,
          contractAddress: invoice.contract_address,
          invoiceId: BigInt(invoice.invoice_id),
        })
        if (state.freelancer !== undefined && lower(state.freelancer) !== lower(invoice.freelancer_address)) return { status: "unavailable" }
        if (state.client !== undefined && lower(state.client) !== lower(invoice.client_address)) return { status: "unavailable" }
        return { status: "verified", onchainStatus: state.onchainStatus }
      } catch {
        return { status: "unavailable" }
      }
    },
  }
}
