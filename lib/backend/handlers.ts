import { NextResponse } from "next/server"
import type { ZodType } from "zod"
import { errorResponse, rejectCrossOrigin, toErrorResponse } from "@/lib/auth/http"
import { getAdvanceStatus, requestAdvance } from "./advances"
import { listOperatorInvoices } from "./operator"
import { evaluateSubmission, type EvaluateResult } from "./evaluation"
import { getInvoiceDetail, listInvoices, registerInvoice } from "./invoices"
import type { BackendDeps } from "./ports"
import { AdvanceBody, AdvanceRefParam, CreateInvoiceBody, EvaluateBody, IdempotencyKey, InvoiceRefParam } from "./schemas"

/**
 * HTTP layer for the Phase 4 endpoints. Route files are one-line wrappers, so tests can drive these handlers with an
 * injected session and dependencies. Order: origin (POST) -> body validation -> session/authorization (in the services).
 */
export interface HandlerContext {
  /** The signed-in user's id, validated with Supabase; null when signed out. */
  userId(): Promise<string | null>
  deps(): BackendDeps
}

const NO_STORE = { "Cache-Control": "no-store" }
const ok = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: NO_STORE })

async function readBody<T>(request: Request, schema: ZodType<T>): Promise<{ data: T } | { response: Response }> {
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { response: errorResponse(400, "INVALID_INPUT", `Invalid request: ${first?.path.join(".") || "body"} ${first?.message ?? "is invalid"}.`) }
  }
  return { data: parsed.data }
}

/** POST /api/invoices */
export async function handleCreateInvoice(request: Request, ctx: HandlerContext): Promise<Response> {
  const blocked = rejectCrossOrigin(request)
  if (blocked) return blocked
  const body = await readBody(request, CreateInvoiceBody)
  if ("response" in body) return body.response
  try {
    const { invoice, created } = await registerInvoice(ctx.deps(), { userId: await ctx.userId(), ...body.data })
    return ok(invoice, created ? 201 : 200)
  } catch (e) {
    return toErrorResponse(e)
  }
}

/** GET /api/invoices: the caller's own invoices. */
export async function handleListInvoices(_request: Request, ctx: HandlerContext): Promise<Response> {
  try {
    return ok(await listInvoices(ctx.deps(), { userId: await ctx.userId() }))
  } catch (e) {
    return toErrorResponse(e)
  }
}

/** GET /api/invoices/:id */
export async function handleGetInvoice(_request: Request, ctx: HandlerContext, params: { id: string }): Promise<Response> {
  const p = InvoiceRefParam.safeParse(params)
  if (!p.success) return errorResponse(404, "NOT_FOUND", "Invoice not found.")
  try {
    return ok(await getInvoiceDetail(ctx.deps(), { userId: await ctx.userId(), invoiceId: p.data.id }))
  } catch (e) {
    return toErrorResponse(e)
  }
}

/** POST /api/evaluate */
/** EvaluationResult (CLAUDE.md §6) plus the audit metadata persisted with it. */
export function evaluationBody(r: EvaluateResult) {
  const e = r.evaluation
  return {
    invoiceId: r.invoiceId,
    submissionId: e.submissionId,
    score: e.score,
    passed: e.passed,
    criteriaResults: e.criteriaResults?.map(({ criterion, passed, reason }) => ({ criterion, passed, reason })) ?? [],
    summary: e.summary,
    evaluationId: e.evaluationId,
    criteriaHash: e.criteriaHash,
    criteriaVersion: e.criteriaVersion,
    model: e.model,
    promptVersion: e.promptVersion,
    passRule: e.passRule,
    simulated: e.simulated,
    evaluatedAt: e.evaluatedAt,
    duplicate: r.duplicate,
  }
}

export async function handleEvaluate(request: Request, ctx: HandlerContext): Promise<Response> {
  const blocked = rejectCrossOrigin(request)
  if (blocked) return blocked
  const body = await readBody(request, EvaluateBody)
  if ("response" in body) return body.response
  try {
    const r = await evaluateSubmission(ctx.deps(), { userId: await ctx.userId(), submissionId: body.data.submissionId })
    return ok(evaluationBody(r), r.duplicate ? 200 : 201)
  } catch (e) {
    return toErrorResponse(e)
  }
}

/** POST /api/advances (optional `Idempotency-Key` header) */
export async function handleAdvance(request: Request, ctx: HandlerContext): Promise<Response> {
  const blocked = rejectCrossOrigin(request)
  if (blocked) return blocked
  const body = await readBody(request, AdvanceBody)
  if ("response" in body) return body.response
  const rawKey = request.headers.get("idempotency-key")
  const key = rawKey === null ? undefined : IdempotencyKey.safeParse(rawKey)
  if (key && !key.success) return errorResponse(400, "INVALID_INPUT", "Idempotency-Key must be 8-200 characters (letters, digits, . _ : -).")
  try {
    const r = await requestAdvance(ctx.deps(), { userId: await ctx.userId(), invoiceId: body.data.invoiceId, idempotencyKey: key?.data })
    // 202: accepted and awaiting on-chain confirmation. 200: an existing request was returned.
    return ok(r, r.duplicate ? 200 : 202)
  } catch (e) {
    return toErrorResponse(e)
  }
}

/** GET /api/advances/:id: a freelancer/client of the invoice polls one advance; it is settled against the chain first. */
export async function handleGetAdvance(_request: Request, ctx: HandlerContext, params: { id: string }): Promise<Response> {
  const p = AdvanceRefParam.safeParse(params)
  if (!p.success) return errorResponse(404, "NOT_FOUND", "Advance request not found.")
  try {
    return ok(await getAdvanceStatus(ctx.deps(), { userId: await ctx.userId(), requestId: p.data.id }))
  } catch (e) {
    return toErrorResponse(e)
  }
}

/** GET /api/operator/invoices: advances outstanding and disputes, for a wallet that holds OPERATOR_ROLE on-chain. */
export async function handleOperatorInvoices(_request: Request, ctx: HandlerContext): Promise<Response> {
  try {
    return ok(await listOperatorInvoices(ctx.deps(), { userId: await ctx.userId() }))
  } catch (e) {
    return toErrorResponse(e)
  }
}
