import "server-only"
import { createGeminiRequirementsDrafter } from "@/lib/ai/requirements-draft-service"
import { getSessionUserId } from "@/lib/evidence/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { createSupabaseBackendDb } from "./server"
import type { DraftHandlerContext } from "./requirements-draft-handler"

/** Production wiring for POST /api/agreements/draft. Only the session lookup and wallet check touch Supabase; nothing is written. */
export const draftHandlerContext: DraftHandlerContext = {
  userId: getSessionUserId,
  verifiedAddresses: (userId) => createSupabaseBackendDb(createSupabaseAdminClient()).verifiedAddresses(userId),
  drafter: () => createGeminiRequirementsDrafter(),
}
