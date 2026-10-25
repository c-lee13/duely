"use client"

import * as React from "react"
import { Check, FileText, HelpCircle, Sparkles, X } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { Pill } from "@/components/duely/primitives"
import { requestAgreementDraft } from "@/lib/frontend/draft-api"
import type { AgreementDraft, DraftOrigin as Origin } from "@/lib/frontend/draft-types"

/** What the client accepted after reviewing and editing. Plain text they own now; still an unsigned draft, never legal terms. */
export interface AcceptedDraft {
  scope: string[]
  outOfScope: string[]
  deliverables: { title: string; description: string }[]
  criteria: { text: string; mandatory: boolean }[]
}

interface Row {
  id: string
  include: boolean
  text: string
  title?: string
  mandatory?: boolean
  origin: Origin
  quote: string | null
  warnings?: string[]
  verification?: string
}

const rowsFrom = (d: AgreementDraft) => ({
  scope: d.scope.inScope.map<Row>((i) => ({ id: i.id, include: i.origin === "requested", text: i.text, origin: i.origin, quote: i.sourceQuote })),
  outOfScope: d.scope.outOfScope.map<Row>((i) => ({ id: i.id, include: i.origin === "requested", text: i.text, origin: i.origin, quote: i.sourceQuote })),
  deliverables: d.deliverables.map<Row>((i) => ({ id: i.id, include: i.origin === "requested", title: i.title, text: i.description, origin: i.origin, quote: i.sourceQuote })),
  criteria: d.acceptanceCriteria.map<Row>((i) => ({
    id: i.id,
    include: i.origin === "requested",
    text: i.text,
    mandatory: i.mandatory,
    origin: i.origin,
    quote: i.sourceQuote,
    warnings: i.warnings,
    verification: i.verification,
  })),
})
type Rows = ReturnType<typeof rowsFrom>
type Group = keyof Rows

const VERIFICATION_LABEL: Record<string, string> = {
  automated_test: "Automated test",
  manual_check: "Manual check",
  code_inspection: "Code inspection",
  measurement: "Measurement",
}

/**
 * "Generate Agreement with AI": asks the server for a draft of the client's description, lets them edit and pick what to keep, and
 * hands the result to the page ONLY when they press Accept. It never creates an invoice, locks criteria, signs or pays. The
 * original description is read-only here and is never changed.
 */
export function AgreementDraftPanel({
  description,
  onAccept,
  onDiscard,
  generate = requestAgreementDraft,
}: {
  description: string
  onAccept: (accepted: AcceptedDraft) => void
  onDiscard: () => void
  generate?: typeof requestAgreementDraft
}) {
  const [state, setState] = React.useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; draft: AgreementDraft; rows: Rows }>({ kind: "loading" })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    generate(description).then((r) => {
      if (cancelled) return
      setState(r.ok ? { kind: "ready", draft: r.draft, rows: rowsFrom(r.draft) } : { kind: "error", message: r.message })
    })
    return () => {
      cancelled = true
    }
    // The description is captured when the panel opens; editing the field afterwards does not silently re-run (and re-bill) the model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  function update(group: Group, id: string, patch: Partial<Row>) {
    setState((s) => (s.kind === "ready" ? { ...s, rows: { ...s.rows, [group]: s.rows[group].map((r) => (r.id === id ? { ...r, ...patch } : r)) } } : s))
  }

  if (state.kind === "loading") {
    return (
      <Card aria-busy="true">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4" aria-hidden /> Drafting with AI…
          </CardTitle>
          <CardDescription role="status">Reading your description and drafting scope, deliverables and criteria. This can take a few seconds.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-5/6" />
        </CardContent>
      </Card>
    )
  }

  if (state.kind === "error") {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Couldn&apos;t generate a draft</AlertTitle>
        <AlertDescription>
          <p>{state.message}</p>
          <p className="mt-1">Your description is unchanged. You can retry, or write the acceptance criteria yourself.</p>
          <div className="mt-3 flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => (setState({ kind: "loading" }), setAttempt((n) => n + 1))}>
              Try again
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
              Close
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    )
  }

  const { draft, rows } = state
  const chosen = (g: Group) => rows[g].filter((r) => r.include && r.text.trim())
  const total = (["scope", "outOfScope", "deliverables", "criteria"] as Group[]).reduce((n, g) => n + chosen(g).length, 0)

  function accept() {
    onAccept({
      scope: chosen("scope").map((r) => r.text.trim()),
      outOfScope: chosen("outOfScope").map((r) => r.text.trim()),
      deliverables: chosen("deliverables").map((r) => ({ title: (r.title ?? "").trim() || "Deliverable", description: r.text.trim() })),
      criteria: chosen("criteria").map((r) => ({ text: r.text.trim(), mandatory: !!r.mandatory })),
    })
  }

  return (
    <Card aria-label="AI-generated agreement draft">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2">
            <FileText className="size-4" aria-hidden /> Agreement draft
          </CardTitle>
          <Pill tone="warning">Unsigned AI draft</Pill>
        </div>
        <CardDescription>{draft.notice}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <Alert>
          <AlertTitle>Not an agreement</AlertTitle>
          <AlertDescription>
            This is unsigned and not legally approved. Nothing is created, locked, signed or paid by accepting it. Items you accept are copied into the form below, where you can keep editing until you create the invoice. Money, dates and legal terms are not drafted here.
          </AlertDescription>
        </Alert>

        <div>
          <p className="mb-1 font-medium">Your original description (unchanged)</p>
          <p className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-muted-foreground">{draft.originalDescription}</p>
        </div>

        {draft.projectSummary && (
          <div>
            <p className="mb-1 font-medium">AI summary</p>
            <p className="text-muted-foreground">{draft.projectSummary}</p>
          </div>
        )}

        {draft.commercialMentions.length > 0 && (
          <Alert>
            <AlertTitle>You mentioned money, timing or legal terms</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {draft.commercialMentions.map((m) => (
                  <li key={m.text}>&ldquo;{m.text}&rdquo;</li>
                ))}
              </ul>
              <p className="mt-1">These were not turned into requirements. Set them in the invoice itself or agree them directly with the freelancer.</p>
            </AlertDescription>
          </Alert>
        )}

        <p className="text-muted-foreground">
          <Pill tone="info">You asked for this</Pill> items quote your description. <Pill tone="neutral">AI suggestion</Pill> items are the AI&apos;s own ideas and start unchecked. Check what you want to keep and edit any text.
        </p>

        <Section title="In scope" group="scope" rows={rows.scope} update={update} empty="No scope items were drafted." />
        <Section title="Out of scope" group="outOfScope" rows={rows.outOfScope} update={update} empty="Nothing was marked out of scope." />
        <Section title="Deliverables" group="deliverables" rows={rows.deliverables} update={update} empty="No deliverables were drafted." />
        <Section title="Acceptance criteria" group="criteria" rows={rows.criteria} update={update} empty="No acceptance criteria could be drafted. Answer the questions below or write your own." />

        <div>
          <p className="mb-2 flex items-center gap-1.5 font-medium">
            <HelpCircle className="size-4" aria-hidden /> Questions to clarify
          </p>
          {draft.clarificationQuestions.length === 0 ? (
            <p className="text-muted-foreground">The AI had no open questions.</p>
          ) : (
            <ul className="space-y-2">
              {draft.clarificationQuestions.map((q) => (
                <li key={q.id} className="rounded-lg border p-3">
                  <p>{q.question}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{q.whyItMatters}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Answer these by adding detail to your description and generating again, or by editing the criteria.</p>
        </div>

        {draft.notes.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {draft.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button type="button" variant="outline" onClick={onDiscard}>
            <X /> Discard draft
          </Button>
          <Button type="button" onClick={accept} disabled={total === 0}>
            <Check /> Accept {total} selected item{total === 1 ? "" : "s"} into the form
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Section({
  title,
  group,
  rows,
  update,
  empty,
}: {
  title: string
  group: Group
  rows: Row[]
  update: (group: Group, id: string, patch: Partial<Row>) => void
  empty: string
}) {
  return (
    <div>
      <p className="mb-2 font-medium">{title}</p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-2.5 size-4 shrink-0 accent-[var(--primary)]"
                  checked={r.include}
                  aria-label={`Keep: ${r.title ?? r.text}`}
                  onChange={(e) => update(group, r.id, { include: e.target.checked })}
                />
                <div className="min-w-0 flex-1 space-y-2">
                  {r.title !== undefined && <Input aria-label="Deliverable title" value={r.title} onChange={(e) => update(group, r.id, { title: e.target.value })} />}
                  <Textarea aria-label={`${title} text`} rows={2} value={r.text} onChange={(e) => update(group, r.id, { text: e.target.value })} />
                  <div className="flex flex-wrap items-center gap-2">
                    {r.origin === "requested" ? <Pill tone="info">You asked for this</Pill> : <Pill tone="neutral">AI suggestion</Pill>}
                    {r.verification && <Pill tone="neutral">{VERIFICATION_LABEL[r.verification] ?? r.verification}</Pill>}
                    {r.mandatory !== undefined && (
                      <label className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={r.mandatory} onChange={(e) => update(group, r.id, { mandatory: e.target.checked })} />
                        Mandatory
                      </label>
                    )}
                  </div>
                  {r.quote && <p className="text-xs text-muted-foreground">From your description: &ldquo;{r.quote}&rdquo;</p>}
                  {r.warnings?.map((w) => (
                    <p key={w} className="text-xs text-amber-700 dark:text-amber-400">
                      {w}
                    </p>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
