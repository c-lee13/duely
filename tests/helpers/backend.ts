import type { PGlite } from "@electric-sql/pglite"
import type { Address, Bytes32 } from "@/lib/frontend/domain"
import { mapAdvanceInsertError, mapEvaluationInsertError } from "@/lib/backend/db-errors"
import type { HandlerContext } from "@/lib/backend/handlers"
import {
  ChainUnavailableError,
  disabledEvaluator,
  unavailableChainAdapter,
  unavailableSigner,
  type AdvanceRequestData,
  type AdvanceSigner,
  type BackendDb,
  type BackendDeps,
  type ChainAdapter,
  type ChainAdvanceFound,
  type ChainAdvanceTxRef,
  type ChainInvoiceCreation,
  type ChainInvoiceRef,
  type ChainInvoiceState,
  type ChainTxStatus,
  type EvaluationData,
  type Evaluator,
  type EvaluatorInput,
  type EvaluatorOutput,
  type InvoiceData,
  type SubmissionData,
} from "@/lib/backend/ports"
import type { DeploymentScope } from "@/lib/shared/deployment-scope"
import { as } from "./db"
import type { FakeObjectStore } from "./evidence"

const INVOICE_SQL =
  "select id, chain_id::int as chain_id, contract_address, token_address, invoice_id::text as invoice_id, client_address, freelancer_address, amount::text as amount, criteria_hash, criteria_version, criteria_count, criteria_canonical, title, description, due_date::text as due_date, onchain_status, advance_amount::text as advance_amount, chain_synced_at::text as chain_synced_at, created_at::text as created_at from invoices"
const SUB_SQL =
  "select id, invoice_uuid, freelancer_user_id, freelancer_address, storage_path, file_name, file_size::int as file_size, mime_type, note, funding_verified_onchain, repository_url, commit_sha, created_at::text as created_at from submissions"
const EVAL_SQL =
  "select id, submission_id, invoice_uuid, criteria_hash, criteria_version, model, prompt_version, state, score, passed, criteria_results, summary, pass_rule, simulated, error_message, created_at::text as created_at, evaluated_at::text as evaluated_at from evaluations"
const ADV_SQL =
  "select a.id, a.invoice_uuid, a.requester_user_id, a.requester_address, a.submission_id, a.evaluation_id, a.status, a.amount::text as amount, a.reason, a.idempotency_key, a.transaction_id, t.tx_hash, t.from_address as tx_from, a.created_at::text as created_at from advance_requests a left join transactions t on t.id = a.transaction_id"

/** BackendDb over the REAL schema (all migrations applied), run as the service_role database role. */
export function createPgBackendDb(db: PGlite): BackendDb {
  const q = <T extends object>(sql: string, params: unknown[] = []) => as(db, "service_role", null, () => db.query<T>(sql, params))
  const one = async <T extends object>(sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0] ?? null
  const guarded = async <T,>(fn: () => Promise<T>, map: (code: string | undefined, msg: string) => Error | null): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw map(undefined, msg) ?? e
    }
  }
  return {
    async verifiedAddresses(userId) {
      return (await q<{ address: Address }>("select address from user_wallets where user_id = $1 and verified_at is not null", [userId])).rows.map((r) => r.address)
    },
    getInvoice: (id) => one<InvoiceData>(`${INVOICE_SQL} where id = $1`, [id]),
    async listInvoicesForWallets(addresses) {
      if (addresses.length === 0) return []
      return (await q<InvoiceData>(`${INVOICE_SQL} where client_address = any($1) or freelancer_address = any($1) order by created_at desc, id desc`, [addresses])).rows
    },
    async listInvoicesInScope(scope, limit) {
      return (await q<InvoiceData>(`${INVOICE_SQL} where chain_id = $1 and contract_address = $2 order by created_at desc, id desc limit $3`, [scope.chainId, scope.contractAddress.toLowerCase(), limit])).rows
    },
    async findInvoicesByOnchainId(onchainId, addresses) {
      if (addresses.length === 0) return []
      return (await q<InvoiceData>(`${INVOICE_SQL} where invoice_id = $1::numeric and (client_address = any($2) or freelancer_address = any($2))`, [onchainId, addresses])).rows
    },
    async listSubmissionsForInvoices(ids) {
      if (ids.length === 0) return []
      return (await q<SubmissionData>(`${SUB_SQL} where invoice_uuid = any($1::uuid[]) order by created_at desc, id desc`, [ids])).rows
    },
    async listEvaluationsForInvoices(ids) {
      if (ids.length === 0) return []
      return (await q<EvaluationData>(`${EVAL_SQL} where invoice_uuid = any($1::uuid[]) order by created_at desc, id desc`, [ids])).rows
    },
    async getCriteria(id) {
      return (await q<{ position: number; criterion_key: string; text: string; mandatory: boolean }>("select position, criterion_key, text, mandatory from invoice_criteria where invoice_uuid = $1 order by position", [id])).rows
    },
    async listSubmissions(id) {
      return (await q<SubmissionData>(`${SUB_SQL} where invoice_uuid = $1 order by created_at desc, id desc`, [id])).rows
    },
    getSubmission: (id) => one<SubmissionData>(`${SUB_SQL} where id = $1`, [id]),
    async listEvaluations(id) {
      return (await q<EvaluationData>(`${EVAL_SQL} where invoice_uuid = $1 order by created_at desc, id desc`, [id])).rows
    },
    findLiveEvaluation: (id) => one<EvaluationData>(`${EVAL_SQL} where submission_id = $1 and state in ('running','completed')`, [id]),
    createRunningEvaluation: (r) =>
      guarded(async () => {
        const row = await one<{ id: string }>(
          "insert into evaluations (submission_id, invoice_uuid, criteria_hash, criteria_version, model, prompt_version, pass_rule, simulated, state) values ($1,$2,$3,$4,$5,$6,$7,$8,'running') returning id",
          [r.submission_id, r.invoice_uuid, r.criteria_hash, r.criteria_version, r.model, r.prompt_version, r.pass_rule, r.simulated]
        )
        return (await one<EvaluationData>(`${EVAL_SQL} where id = $1`, [row!.id]))!
      }, mapEvaluationInsertError),
    async finalizeEvaluation(id, r) {
      await q(
        "update evaluations set state='completed', model=$2, prompt_version=$3, simulated=$4, score=$5, passed=$6, criteria_results=$7::jsonb, summary=$8, evaluated_at=now() where id=$1 and state='running'",
        [id, r.model, r.prompt_version, r.simulated, r.score, r.passed, JSON.stringify(r.criteria_results), r.summary]
      )
      return (await one<EvaluationData>(`${EVAL_SQL} where id = $1`, [id]))!
    },
    async failEvaluation(id, message) {
      await q("update evaluations set state='error', error_message=$2 where id=$1 and state='running'", [id, message])
    },
    findLiveAdvance: (id) => one<AdvanceRequestData>(`${ADV_SQL} where a.invoice_uuid = $1 and a.status in ('pending','paid')`, [id]),
    findAdvanceByKey: (u, k) => one<AdvanceRequestData>(`${ADV_SQL} where a.requester_user_id = $1 and a.idempotency_key = $2`, [u, k]),
    async listAdvanceRequests(id) {
      return (await q<AdvanceRequestData>(`${ADV_SQL} where a.invoice_uuid = $1 order by a.created_at desc`, [id])).rows
    },
    createAdvanceRequest: (r) =>
      guarded(async () => {
        const row = await one<{ id: string }>(
          "insert into advance_requests (invoice_uuid, requester_user_id, requester_address, submission_id, evaluation_id, amount, idempotency_key, status) values ($1,$2,$3,$4,$5,$6::numeric,$7,'pending') returning id",
          [r.invoice_uuid, r.requester_user_id, r.requester_address, r.submission_id, r.evaluation_id, r.amount, r.idempotency_key]
        )
        return (await one<AdvanceRequestData>(`${ADV_SQL} where a.id = $1`, [row!.id]))!
      }, mapAdvanceInsertError),
    async attachPendingTransaction(a) {
      const tx = await one<{ id: string }>(
        "insert into transactions (invoice_uuid, chain_id, action, status, from_address, amount, tx_hash) values ($1,$2,'approveAdvance','pending',$3,$4::numeric,$5) returning id",
        [a.invoiceId, a.chainId, a.from, a.amount, a.txHash]
      )
      await q("update advance_requests set transaction_id = $2 where id = $1", [a.requestId, tx!.id])
      return (await one<AdvanceRequestData>(`${ADV_SQL} where a.id = $1`, [a.requestId]))!
    },
    async failAdvanceRequest(id, reason) {
      await q("update advance_requests set status='failed', reason=$2 where id=$1 and status='pending'", [id, reason])
    },
    getAdvanceRequest: (id) => one<AdvanceRequestData>(`${ADV_SQL} where a.id = $1`, [id]),
    async listPendingAdvances(invoiceId) {
      return (await q<AdvanceRequestData>(`${ADV_SQL} where a.invoice_uuid = $1 and a.status = 'pending'`, [invoiceId])).rows
    },
    async recordAdvanceConfirmed(a) {
      // Same three conditional steps as the Supabase adapter, in the same order.
      await q(
        "update transactions set status='confirmed', block_number=$2, block_hash=$3, log_index=$4, receipt=$5::jsonb, confirmed_at=now(), error=null where id=$1 and status='pending'",
        [a.transactionId, a.blockNumber.toString(), a.blockHash, a.logIndex, JSON.stringify(a.receipt)]
      )
      await q("update advance_requests set status='paid' where id=$1 and status='pending'", [a.requestId])
      if (a.cache) {
        await q("update invoices set onchain_status=$2, advance_amount=$3::numeric, chain_synced_at=now(), chain_synced_block=$4 where id=$1", [a.invoiceId, a.cache.status, a.advanceAmount, a.cache.blockNumber.toString()])
      }
      return (await one<AdvanceRequestData>(`${ADV_SQL} where a.id = $1`, [a.requestId]))!
    },
    async recordAdvanceFailed(a) {
      if (a.transactionId) await q("update transactions set status='failed', error=$2 where id=$1 and status='pending'", [a.transactionId, a.reason])
      await q("update advance_requests set status='failed', reason=$2 where id=$1 and status='pending'", [a.requestId, a.reason])
    },
    async noteAdvanceReview(requestId, reason) {
      await q("update advance_requests set reason=$2 where id=$1 and status='pending'", [requestId, reason])
    },
    async attachRecoveredTransaction(a) {
      const tx = await one<{ id: string }>(
        "insert into transactions (invoice_uuid, chain_id, action, status, from_address, amount, tx_hash) values ($1,$2,'approveAdvance','pending',$3,$4::numeric,$5) returning id",
        [a.invoiceId, a.chainId, a.from, a.amount, a.txHash]
      )
      await q("update advance_requests set transaction_id = $2 where id = $1", [a.requestId, tx!.id])
      return (await one<AdvanceRequestData>(`${ADV_SQL} where a.id = $1`, [a.requestId]))!
    },
    async registerInvoice(a) {
      const r = await one<{ o_id: string; o_created: boolean }>(
        "select * from public.register_invoice($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::date,$14,$15,$16,$17)",
        [a.chainId, a.contractAddress, a.tokenAddress, a.invoiceId, a.client, a.freelancer, a.amount, a.criteriaHash, a.canonical, JSON.stringify(a.criteria), a.title, a.description, a.dueDate, a.createTxHash, a.userId, a.status, a.blockNumber]
      )
      return { id: r!.o_id, created: r!.o_created }
    },
  }
}

// ---- Fakes -----------------------------------------------------------------------------------------------------

export class FakeChainAdapter implements ChainAdapter {
  available = true
  calls = { creation: 0, state: 0, reserve: 0, tx: 0, found: 0 }
  /** What a look at the broadcast approveAdvance reports (default: not mined yet). */
  advanceTx: ChainTxStatus | Error = { state: "pending" }
  lastTxRef: ChainAdvanceTxRef | null = null
  lastTxWaitMs: number | undefined
  found: ChainAdvanceFound | null | Error = null
  /** On-chain role holders by role, lower-case addresses. */
  roles: Record<"operator" | "evaluator" | "admin", Set<string>> = { operator: new Set(), evaluator: new Set(), admin: new Set() }
  async hasRole(role: "operator" | "evaluator" | "admin", address: Address): Promise<boolean> {
    return this.roles[role].has(address.toLowerCase())
  }
  async getAdvanceTransaction(ref: ChainAdvanceTxRef, opts?: { waitMs?: number }): Promise<ChainTxStatus> {
    this.calls.tx++
    this.lastTxRef = ref
    this.lastTxWaitMs = opts?.waitMs
    if (this.advanceTx instanceof Error) throw this.advanceTx
    return this.advanceTx
  }
  async findAdvancePaid(_ref: ChainInvoiceRef): Promise<ChainAdvanceFound | null> {
    void _ref
    this.calls.found++
    if (this.found instanceof Error) throw this.found
    return this.found
  }
  creation: ChainInvoiceCreation | Error = new ChainUnavailableError()
  state: ChainInvoiceState | Error = new ChainUnavailableError()
  reserve: bigint | Error = BigInt(0)
  async getInvoiceCreation(): Promise<ChainInvoiceCreation> {
    this.calls.creation++
    if (this.creation instanceof Error) throw this.creation
    return this.creation
  }
  async getInvoiceState(_ref?: ChainInvoiceRef): Promise<ChainInvoiceState> {
    void _ref
    this.calls.state++
    if (this.state instanceof Error) throw this.state
    return this.state
  }
  async getReserveAvailable(): Promise<bigint> {
    this.calls.reserve++
    if (this.reserve instanceof Error) throw this.reserve
    return this.reserve
  }
}

export class FakeSigner implements AdvanceSigner {
  available = true
  address: Address | null = ("0x" + "5".repeat(40)) as Address
  calls = 0
  fail = false
  /** The evaluation hash and reference of the most recent broadcast. */
  lastEvaluationHash: Bytes32 | null = null
  lastRef: ChainInvoiceRef | null = null
  /** The hash returned by the most recent broadcast. Every broadcast gets a unique hash, like a real chain. */
  hash: Bytes32 = ("0x" + "00".repeat(32)) as Bytes32
  async submitApproveAdvance(ref?: ChainInvoiceRef, evaluationHash?: Bytes32) {
    this.calls++
    this.lastRef = ref ?? null
    this.lastEvaluationHash = evaluationHash ?? null
    if (this.fail) throw new Error("rpc: nonce too low")
    this.hash = ("0x" + this.calls.toString(16).padStart(64, "0")) as Bytes32
    return { txHash: this.hash, from: ("0x" + "5".repeat(40)) as Address }
  }
}

/** A scripted evaluator standing in for a future real one (mode "live"): lets tests control the output. */
export class ScriptedEvaluator implements Evaluator {
  mode: Evaluator["mode"] = "live"
  calls = 0
  lastInput: EvaluatorInput | null = null
  output: (i: EvaluatorInput) => EvaluatorOutput = (i) => ({
    model: "scripted-model",
    promptVersion: "scripted-v1",
    simulated: false,
    score: 95,
    criteriaResults: i.criteria.map((c) => ({ criterion: c.text, passed: true, reason: "ok" })),
    summary: "All criteria met.",
  })
  async evaluate(i: EvaluatorInput) {
    this.calls++
    this.lastInput = i
    return this.output(i)
  }
}

export interface Harness {
  deps: BackendDeps
  chain: FakeChainAdapter
  signer: FakeSigner
  evaluator: ScriptedEvaluator
  store: FakeObjectStore
}

/** The fake deployment every Track B test file seeds its invoices under (chain 1440002, contract 0xeee…, token 0xddd…). */
export const TEST_SCOPE: DeploymentScope = {
  chainId: 1440002,
  contractAddress: "0x" + "e".repeat(40),
  tokenAddress: "0x" + "d".repeat(40),
  key: "test",
  symbol: "TEST",
  decimals: 18,
}

export const unavailableDeps = (db: PGlite, store: FakeObjectStore): BackendDeps => ({
  scope: TEST_SCOPE,
  db: createPgBackendDb(db),
  objects: store,
  chain: unavailableChainAdapter,
  signer: unavailableSigner,
  evaluator: disabledEvaluator,
})

export function ctx(userId: string | null, deps: BackendDeps): HandlerContext {
  return { userId: async () => userId, deps: () => deps }
}

/** Sends a real Request through an HTTP handler. Defaults to a same-origin POST with JSON. */
export async function http(
  handler: (request: Request, ctx: HandlerContext, ...rest: never[]) => Promise<Response>,
  c: HandlerContext,
  opts: { body?: unknown; method?: string; origin?: string | null; headers?: Record<string, string>; raw?: string } = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) }
  if (opts.origin !== null) headers.origin = opts.origin ?? "http://localhost:3000"
  const res = await handler(
    new Request("http://localhost:3000/api/test", {
      method: opts.method ?? "POST",
      headers,
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    }),
    c
  )
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, json, headers: res.headers }
}
