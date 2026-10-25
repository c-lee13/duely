import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Address, Bytes32 } from "@/lib/frontend/domain"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import type { Database } from "@/lib/supabase/database.types"
import { createSupabaseObjectStore, getSessionUserId } from "@/lib/evidence/server"
import { mapAdvanceInsertError, mapEvaluationInsertError } from "./db-errors"
import { createGeminiEvaluatorFromEnv } from "@/lib/ai/evaluation-service"
import { demoEvaluator, resolveEvaluatorMode } from "./demo-evaluator"
import { activeDeploymentScope } from "./scope"
import { createEvaluatorSignerFromEnv } from "./advance-signer"
import { createChainAdapter } from "./chain-adapter"
import type { DeploymentScope } from "@/lib/shared/deployment-scope"
import type { HandlerContext } from "./handlers"
import {
  disabledEvaluator,
  type AdvanceRequestData,
  type AdvanceSigner,
  type BackendDb,
  type BackendDeps,
  type ChainAdapter,
  type CriterionData,
  type EvaluationData,
  type Evaluator,
  type InvoiceData,
  type SubmissionData,
} from "./ports"

type Admin = SupabaseClient<Database>

const INVOICE_COLS =
  "id, chain_id, contract_address, token_address, invoice_id::text, client_address, freelancer_address, amount::text, criteria_hash, criteria_version, criteria_count, criteria_canonical, title, description, due_date, onchain_status, advance_amount::text, chain_synced_at, created_at"
const SUBMISSION_COLS =
  "id, invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size, mime_type, note, funding_verified_onchain, created_at"
const EVALUATION_COLS =
  "id, submission_id, invoice_uuid, criteria_hash, criteria_version, model, prompt_version, state, score, passed, criteria_results, summary, pass_rule, simulated, error_message, created_at, evaluated_at"
const ADVANCE_COLS =
  "id, invoice_uuid, requester_user_id, requester_address, submission_id, evaluation_id, status, amount::text, reason, idempotency_key, transaction_id, created_at"

/**
 * Service-role database access. Only called after the services have authenticated the user and authorized the action.
 * uint256 columns are selected as text (`col::text`): PostgREST would otherwise return a lossy JSON number.
 */
export function createSupabaseBackendDb(admin: Admin): BackendDb {
  const fail = (e: { message: string }): never => {
    throw new Error(e.message)
  }
  // Rows come back typed loosely because of the ::text casts.
  const rows = <T,>(data: unknown) => (data ?? []) as T[]

  async function withTxHash(requests: AdvanceRequestData[]): Promise<AdvanceRequestData[]> {
    const ids = requests.map((r) => r.transaction_id).filter((x): x is string => !!x)
    if (ids.length === 0) return requests.map((r) => ({ ...r, tx_hash: null }))
    const { data, error } = await admin.from("transactions").select("id, tx_hash, from_address").in("id", ids)
    if (error) fail(error)
    const byId = new Map((data ?? []).map((t) => [t.id, t]))
    return requests.map((r) => {
      const t = r.transaction_id ? byId.get(r.transaction_id) : undefined
      return { ...r, tx_hash: (t?.tx_hash as Bytes32 | null | undefined) ?? null, tx_from: (t?.from_address as Address | null | undefined) ?? null }
    })
  }

  return {
    async verifiedAddresses(userId) {
      const { data, error } = await admin.from("user_wallets").select("address").eq("user_id", userId).not("verified_at", "is", null)
      if (error) fail(error)
      return (data ?? []).map((r) => r.address as Address)
    },
    async getInvoice(id) {
      const { data, error } = await admin.from("invoices").select(INVOICE_COLS).eq("id", id).maybeSingle()
      if (error) fail(error)
      return (data as unknown as InvoiceData | null) ?? null
    },
    async listInvoicesForWallets(addresses) {
      if (addresses.length === 0) return []
      // Addresses come from user_wallets (lower-case 0x + 40 hex, enforced by a domain), so interpolation is safe.
      const list = addresses.join(",")
      const { data, error } = await admin
        .from("invoices")
        .select(INVOICE_COLS)
        .or(`client_address.in.(${list}),freelancer_address.in.(${list})`)
        .order("created_at", { ascending: false })
      if (error) fail(error)
      return rows<InvoiceData>(data)
    },
    async listInvoicesInScope(scope, limit) {
      const { data, error } = await admin
        .from("invoices")
        .select(INVOICE_COLS)
        .eq("chain_id", scope.chainId)
        .eq("contract_address", scope.contractAddress.toLowerCase() as Address)
        .order("created_at", { ascending: false })
        .limit(limit)
      if (error) fail(error)
      return rows<InvoiceData>(data)
    },
    async findInvoicesByOnchainId(onchainId, addresses) {
      if (addresses.length === 0) return []
      const list = addresses.join(",")
      const { data, error } = await admin
        .from("invoices")
        .select(INVOICE_COLS)
        .eq("invoice_id", onchainId)
        .or(`client_address.in.(${list}),freelancer_address.in.(${list})`)
      if (error) fail(error)
      return rows<InvoiceData>(data)
    },
    async listSubmissionsForInvoices(ids) {
      if (ids.length === 0) return []
      const { data, error } = await admin.from("submissions").select(SUBMISSION_COLS).in("invoice_uuid", ids).order("created_at", { ascending: false }).order("id", { ascending: false })
      if (error) fail(error)
      return rows<SubmissionData>(data)
    },
    async listEvaluationsForInvoices(ids) {
      if (ids.length === 0) return []
      const { data, error } = await admin.from("evaluations").select(EVALUATION_COLS).in("invoice_uuid", ids).order("created_at", { ascending: false }).order("id", { ascending: false })
      if (error) fail(error)
      return rows<EvaluationData>(data)
    },
    async getCriteria(invoiceId) {
      const { data, error } = await admin
        .from("invoice_criteria")
        .select("position, criterion_key, text, mandatory")
        .eq("invoice_uuid", invoiceId)
        .order("position")
      if (error) fail(error)
      return rows<CriterionData>(data)
    },
    async listSubmissions(invoiceId) {
      const { data, error } = await admin
        .from("submissions")
        .select(SUBMISSION_COLS)
        .eq("invoice_uuid", invoiceId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
      if (error) fail(error)
      return rows<SubmissionData>(data)
    },
    async getSubmission(id) {
      const { data, error } = await admin.from("submissions").select(SUBMISSION_COLS).eq("id", id).maybeSingle()
      if (error) fail(error)
      return (data as SubmissionData | null) ?? null
    },
    async listEvaluations(invoiceId) {
      const { data, error } = await admin
        .from("evaluations")
        .select(EVALUATION_COLS)
        .eq("invoice_uuid", invoiceId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
      if (error) fail(error)
      return rows<EvaluationData>(data)
    },
    async findLiveEvaluation(submissionId) {
      const { data, error } = await admin
        .from("evaluations")
        .select(EVALUATION_COLS)
        .eq("submission_id", submissionId)
        .in("state", ["running", "completed"])
        .maybeSingle()
      if (error) fail(error)
      return (data as EvaluationData | null) ?? null
    },
    async createRunningEvaluation(row) {
      const { data, error } = await admin.from("evaluations").insert({ ...row, state: "running" }).select(EVALUATION_COLS).single()
      if (error) throw mapEvaluationInsertError(error.code, error.message) ?? new Error(error.message)
      return data as EvaluationData
    },
    async finalizeEvaluation(id, r) {
      const { data, error } = await admin
        .from("evaluations")
        .update({ state: "completed", model: r.model, prompt_version: r.prompt_version, simulated: r.simulated, score: r.score, passed: r.passed, criteria_results: r.criteria_results, summary: r.summary, evaluated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("state", "running")
        .select(EVALUATION_COLS)
        .single()
      if (error) fail(error)
      return data as EvaluationData
    },
    async failEvaluation(id, message) {
      const { error } = await admin.from("evaluations").update({ state: "error", error_message: message }).eq("id", id).eq("state", "running")
      if (error) fail(error)
    },
    async findLiveAdvance(invoiceId) {
      const { data, error } = await admin.from("advance_requests").select(ADVANCE_COLS).eq("invoice_uuid", invoiceId).in("status", ["pending", "paid"]).maybeSingle()
      if (error) fail(error)
      return data ? (await withTxHash([data as unknown as AdvanceRequestData]))[0] : null
    },
    async findAdvanceByKey(userId, key) {
      const { data, error } = await admin.from("advance_requests").select(ADVANCE_COLS).eq("requester_user_id", userId).eq("idempotency_key", key).maybeSingle()
      if (error) fail(error)
      return data ? (await withTxHash([data as unknown as AdvanceRequestData]))[0] : null
    },
    async listAdvanceRequests(invoiceId) {
      const { data, error } = await admin.from("advance_requests").select(ADVANCE_COLS).eq("invoice_uuid", invoiceId).order("created_at", { ascending: false })
      if (error) fail(error)
      return withTxHash(rows<AdvanceRequestData>(data))
    },
    async createAdvanceRequest(row) {
      const { data, error } = await admin.from("advance_requests").insert({ ...row, status: "pending" }).select(ADVANCE_COLS).single()
      if (error) throw mapAdvanceInsertError(error.code, error.message) ?? new Error(error.message)
      return (await withTxHash([data as unknown as AdvanceRequestData]))[0]
    },
    async attachPendingTransaction(a) {
      const { data: tx, error: txError } = await admin
        .from("transactions")
        .insert({ invoice_uuid: a.invoiceId, chain_id: a.chainId, action: "approveAdvance", status: "pending", from_address: a.from, amount: a.amount, tx_hash: a.txHash })
        .select("id")
        .single()
      if (txError) fail(txError)
      const { data, error } = await admin
        .from("advance_requests")
        .update({ transaction_id: tx!.id })
        .eq("id", a.requestId)
        .select(ADVANCE_COLS)
        .single()
      if (error) fail(error)
      return { ...(data as unknown as AdvanceRequestData), tx_hash: a.txHash }
    },
    async failAdvanceRequest(id, reason) {
      const { error } = await admin.from("advance_requests").update({ status: "failed", reason }).eq("id", id).eq("status", "pending")
      if (error) fail(error)
    },
    async getAdvanceRequest(id) {
      const { data, error } = await admin.from("advance_requests").select(ADVANCE_COLS).eq("id", id).maybeSingle()
      if (error) fail(error)
      return data ? (await withTxHash([data as unknown as AdvanceRequestData]))[0] : null
    },
    async listPendingAdvances(invoiceId) {
      const { data, error } = await admin.from("advance_requests").select(ADVANCE_COLS).eq("invoice_uuid", invoiceId).eq("status", "pending")
      if (error) fail(error)
      return withTxHash(rows<AdvanceRequestData>(data))
    },
    async recordAdvanceConfirmed(a) {
      // Three conditional steps (PostgREST has no multi-statement transaction); each is a no-op when already applied, so a crash
      // between them is repaired by the next reconcile. Order matters: the proof (transaction) first, the claim (paid) second.
      const now = new Date().toISOString()
      const tx = await admin
        .from("transactions")
        .update({ status: "confirmed", block_number: Number(a.blockNumber), block_hash: a.blockHash, log_index: a.logIndex, receipt: a.receipt, confirmed_at: now, error: null })
        .eq("id", a.transactionId)
        .eq("status", "pending")
      if (tx.error) fail(tx.error)
      const req = await admin.from("advance_requests").update({ status: "paid" }).eq("id", a.requestId).eq("status", "pending")
      if (req.error) fail(req.error)
      if (a.cache) {
        const inv = await admin
          .from("invoices")
          .update({ onchain_status: a.cache.status, advance_amount: a.advanceAmount, chain_synced_at: now, chain_synced_block: Number(a.cache.blockNumber) })
          .eq("id", a.invoiceId)
        if (inv.error) fail(inv.error)
      }
      const { data, error } = await admin.from("advance_requests").select(ADVANCE_COLS).eq("id", a.requestId).single()
      if (error) fail(error)
      return (await withTxHash([data as unknown as AdvanceRequestData]))[0]
    },
    async recordAdvanceFailed(a) {
      if (a.transactionId) {
        const tx = await admin.from("transactions").update({ status: "failed", error: a.reason.slice(0, 500) }).eq("id", a.transactionId).eq("status", "pending")
        if (tx.error) fail(tx.error)
      }
      const { error } = await admin.from("advance_requests").update({ status: "failed", reason: a.reason.slice(0, 500) }).eq("id", a.requestId).eq("status", "pending")
      if (error) fail(error)
    },
    async noteAdvanceReview(requestId, reason) {
      const { error } = await admin.from("advance_requests").update({ reason: reason.slice(0, 500) }).eq("id", requestId).eq("status", "pending")
      if (error) fail(error)
    },
    async attachRecoveredTransaction(a) {
      const { data: tx, error: txError } = await admin
        .from("transactions")
        .insert({ invoice_uuid: a.invoiceId, chain_id: a.chainId, action: "approveAdvance", status: "pending", from_address: a.from, amount: a.amount, tx_hash: a.txHash })
        .select("id")
        .single()
      if (txError) fail(txError)
      const { data, error } = await admin.from("advance_requests").update({ transaction_id: tx!.id }).eq("id", a.requestId).select(ADVANCE_COLS).single()
      if (error) fail(error)
      return (await withTxHash([data as unknown as AdvanceRequestData]))[0]
    },
    async registerInvoice(a) {
      const { data, error } = await admin.rpc("register_invoice", {
        p_chain_id: a.chainId,
        p_contract: a.contractAddress,
        p_token: a.tokenAddress,
        p_invoice_id: a.invoiceId,
        p_client: a.client,
        p_freelancer: a.freelancer,
        p_amount: a.amount,
        p_criteria_hash: a.criteriaHash,
        p_canonical: a.canonical,
        p_criteria: a.criteria,
        p_title: a.title,
        p_description: a.description,
        p_due: a.dueDate,
        p_create_tx: a.createTxHash,
        p_user: a.userId,
        p_status: a.status,
        p_block: a.blockNumber,
      })
      if (error) fail(error)
      const row = data?.[0]
      if (!row) throw new Error("register_invoice returned no row")
      return { id: row.o_id, created: row.o_created }
    },
  }
}

// ---- Wiring ---------------------------------------------------------------------------------------------------

/**
 * Chain adapter slot. No compiled ABI, contract address or chain config exists yet (integration owner / Track A), so
 * this is the "unavailable" adapter: invoice registration and advances answer 503 INTEGRATION_UNAVAILABLE instead of
 * pretending. Replace with a viem-backed reader of the deployed contract once those artifacts exist.
 */
export function getChainAdapter(scope: DeploymentScope = activeDeploymentScope()): ChainAdapter {
  return createChainAdapter({ scope })
}

/** Protected signer slot. Same rule: no signer integration yet, so advances cannot be broadcast. */
export function getAdvanceSigner(scope: DeploymentScope = activeDeploymentScope()): AdvanceSigner {
  return createEvaluatorSignerFromEnv(scope)
}

/** DUELY_EVALUATOR_MODE: "gemini" = the real evaluator, "demo" = deterministic and simulated (never in production), otherwise off. */
export function getEvaluator(): Evaluator {
  const mode = resolveEvaluatorMode(process.env)
  if (mode === "gemini") return createGeminiEvaluatorFromEnv(process.env)
  return mode === "demo" ? demoEvaluator : disabledEvaluator
}

export function getBackendDeps(): BackendDeps {
  const admin = createSupabaseAdminClient()
  const scope = activeDeploymentScope()
  return {
    scope,
    // POST /api/advances waits (bounded) for the receipt so a normal confirmation is reported as paid in the same response.
    confirmWaitMs: 15_000,
    db: createSupabaseBackendDb(admin),
    objects: createSupabaseObjectStore(admin),
    chain: getChainAdapter(scope),
    signer: getAdvanceSigner(scope),
    evaluator: getEvaluator(),
  }
}

export const handlerContext: HandlerContext = { userId: getSessionUserId, deps: getBackendDeps }
