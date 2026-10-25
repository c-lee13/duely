import type { AgreementDraft } from "@/lib/frontend/draft-types"

/** Browser-side call to POST /api/agreements/draft. It shares no code with the server module, so no Gemini code ships to the client. */
export type DraftResponse = { ok: true; draft: AgreementDraft } | { ok: false; code: string; message: string }

export async function requestAgreementDraft(description: string, doFetch: typeof fetch = (...a) => fetch(...a)): Promise<DraftResponse> {
  let res: Response
  try {
    res = await doFetch("/api/agreements/draft", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    })
  } catch {
    return { ok: false, code: "NETWORK", message: "Couldn't reach the server. Check your connection and try again." }
  }
  const body = (await res.json().catch(() => null)) as { draft?: AgreementDraft; error?: { code?: string; message?: string } } | null
  if (res.ok && body?.draft?.draft === true) return { ok: true, draft: body.draft }
  const code = body?.error?.code ?? "UNKNOWN"
  const message = body?.error?.message ?? "The AI draft couldn't be generated. Try again."
  return { ok: false, code, message }
}
