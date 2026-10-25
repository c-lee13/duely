import { NextResponse } from "next/server"
import { z } from "zod"
import { errorResponse, rejectCrossOrigin, toErrorResponse } from "@/lib/auth/http"
import type { RequirementsDrafter } from "@/lib/ai/requirements-draft-service"
import { requireUser } from "./access"
import { ApiError } from "./api-error"

/**
 * POST /api/agreements/draft { description }: asks Gemini for a DRAFT of scope, deliverables, acceptance criteria and clarification
 * questions. It only returns text for the client to review. It creates no invoice, stores nothing, signs nothing and moves no money,
 * and the Gemini key never leaves the server. Order: origin -> session -> verified wallet -> body -> throttle -> model.
 */
export interface DraftHandlerContext {
  /** The signed-in user's id, validated with Supabase; null when signed out. */
  userId(): Promise<string | null>
  /** Wallet addresses VERIFIED for this user (unverified claims never count). */
  verifiedAddresses(userId: string): Promise<string[]>
  drafter(): RequirementsDrafter
  /** Injectable clock for tests. */
  now?(): number
}

export const DRAFT_RATE = { max: 8, windowMs: 10 * 60_000 } as const

// Gemini calls cost money: cap each user. In-memory, so per server instance; a cost guard, not a security boundary.
const hits = new Map<string, number[]>()
export function resetDraftRateLimit() {
  hits.clear()
}
function throttled(userId: string, now: number): boolean {
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < DRAFT_RATE.windowMs)
  if (recent.length >= DRAFT_RATE.max) {
    hits.set(userId, recent)
    return true
  }
  recent.push(now)
  hits.set(userId, recent)
  return false
}

// Length is checked by the drafter (and reported with a helpful message), so only the type is enforced here.
const Body = z.object({ description: z.string() }).strict()

export async function handleDraftRequirements(request: Request, ctx: DraftHandlerContext): Promise<Response> {
  const blocked = rejectCrossOrigin(request)
  if (blocked) return blocked
  try {
    const userId = requireUser(await ctx.userId())
    if ((await ctx.verifiedAddresses(userId)).length === 0) throw new ApiError("NO_VERIFIED_WALLET", "Verify your wallet before drafting an agreement.")

    const parsed = Body.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return errorResponse(400, "INVALID_INPUT", "Send the project description as text.")

    const drafter = ctx.drafter()
    if (!drafter.available) return errorResponse(503, "INTEGRATION_UNAVAILABLE", "AI drafting isn't available right now: Gemini is not configured on the server.")

    // Cheap input checks happen inside draft() before any model call, but they would still count here; that is acceptable.
    if (throttled(userId, ctx.now?.() ?? Date.now())) return errorResponse(429, "RATE_LIMITED", "Too many drafts in a short time. Wait a few minutes and try again.")

    const startedAt = Date.now()
    const result = await drafter.draft(parsed.data.description)
    if (result.ok) return NextResponse.json({ draft: result.draft }, { headers: { "Cache-Control": "no-store" } })
    switch (result.stage) {
      case "input":
        return errorResponse(400, "INVALID_INPUT", result.problems[0] ?? "Describe the project in a little more detail.")
      case "unavailable":
        return errorResponse(503, "INTEGRATION_UNAVAILABLE", "AI drafting isn't available right now: Gemini is not configured on the server.")
      case "auth":
        // Operator misconfiguration, not something the user can fix: the key is invalid, revoked or restricted.
        console.error("agreement draft failed: Gemini rejected GEMINI_API_KEY (", result.problems.slice(1).join(" | "), "). Check GEMINI_API_KEY in .env.local / .env and restart the server.")
        return errorResponse(503, "AI_AUTH_FAILED", "AI drafting is misconfigured on the server (the Gemini API key was rejected). You can write the criteria yourself for now.")
      case "generate":
        console.error("agreement draft failed:", result.stage, result.problems.slice(0, 12).join(" | "), `| ${Date.now() - startedAt}ms`)
        return errorResponse(502, "PROVIDER_UNAVAILABLE", "The AI service is busy or unreachable right now. Try again in a moment, or write the criteria yourself.")
      default:
        // The model was unreachable or answered unusably. Nothing from the provider is passed on to the browser; the stage and the
        // validation paths (field names and rule text, no content) go to the server log so the failure can be diagnosed.
        console.error("agreement draft failed:", result.stage, result.problems.slice(0, 12).join(" | "), `| ${Date.now() - startedAt}ms`)
        return errorResponse(502, "DRAFT_FAILED", "The AI couldn't produce a usable draft this time. Try again, or write the criteria yourself.")
    }
  } catch (e) {
    return toErrorResponse(e)
  }
}
