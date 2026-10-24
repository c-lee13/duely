"use client"

import * as React from "react"
import { useParams } from "next/navigation"
import { AlertOctagon, ArrowDown, ArrowLeft, CheckCircle2, Circle, FileText, FileUp, Loader2, Rocket, RotateCcw, Upload, X, XCircle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RoleGate } from "@/components/duely/role-gate"
import { useToast } from "@/components/duely/toast"
import { CriteriaList, EvaluationPanel, FundsBreakdown, InvoiceHeaderCard, PaymentFlow, Timeline, TransactionList } from "@/components/duely/invoice-parts"
import {
  Amount,
  ButtonLink,
  ErrorState,
  formatBytes,
  formatDate,
  PageSkeleton,
  Pill,
  SimulatedTag,
  SubmissionStatusBadge,
} from "@/components/duely/primitives"
import { useAction, useInvoiceBundle } from "@/hooks/use-duely"
import type { AcceptanceCriterion, InvoiceBundle, Session } from "@/lib/frontend/domain"
import { canSubmitEvidence, evaluationFor, getAdvanceEligibility } from "@/lib/frontend/eligibility"
import { EVIDENCE_ACCEPT, EVIDENCE_MAX_BYTES } from "@/lib/mocks/mock-repository"
import { formatToken } from "@/lib/frontend/token"

function Detail({ session, invoiceId }: { session: Session; invoiceId: string }) {
  const q = useInvoiceBundle(invoiceId, session.role)
  if (q.error) {
    return (
      <ErrorState
        title="Couldn't open this job"
        message={q.error}
        onRetry={q.reload}
        action={<ButtonLink href="/freelancer" variant="outline">Back to my work</ButtonLink>}
      />
    )
  }
  if (!q.data) return <PageSkeleton />
  return <Body bundle={q.data} />
}

function Body({ bundle }: { bundle: InvoiceBundle }) {
  const toast = useToast()
  const { invoice, submissions, evaluations, advanceRequests, timeline, transactions, reserveAvailable } = bundle
  const latest = submissions[0]
  const latestEval = evaluationFor(latest, evaluations)
  const eligibility = getAdvanceEligibility({ invoice, submissions, evaluations, advanceRequests, reserveAvailable })
  const [confirmAdvance, setConfirmAdvance] = React.useState(false)

  const retryEval = useAction((repo) => repo.requestEvaluation(latest!.submissionId))
  const advance = useAction((repo) => repo.requestAdvance(invoice.invoiceId))
  const evaluating = latestEval?.state === "running"
  const lastRequest = advanceRequests[0]

  async function onAdvance() {
    const r = await advance.run()
    setConfirmAdvance(false)
    if (!r.ok) return toast({ tone: "error", title: "Advance request failed", description: r.error })
    if (r.value.status === "paid")
      toast({ tone: "success", title: "Advance paid (simulated)", description: `${formatToken(eligibility.amount)} sent from the platform reserve.` })
    else if (r.value.status === "denied") toast({ tone: "warning", title: "Advance denied", description: r.value.reason })
    else toast({ tone: "error", title: "Advance transaction failed", description: r.value.reason })
  }

  const showUpload = canSubmitEvidence(invoice.onchainStatus)
  const passed = latestEval?.state === "completed" ? latestEval.passed : undefined

  return (
    <div className="space-y-6">
      <ButtonLink href="/freelancer" variant="ghost" size="sm" className="-ml-2">
        <ArrowLeft /> My work
      </ButtonLink>
      <InvoiceHeaderCard
        invoice={invoice}
        perspective="freelancer"
        badges={<SubmissionStatusBadge status={invoice.submissionStatus} passed={passed} />}
      />

      {invoice.onchainStatus === "Created" && (
        <Alert>
          <AlertTitle>Waiting for the client to fund escrow</AlertTitle>
          <AlertDescription>You can submit evidence once the full amount is locked.</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {showUpload && <EvidenceForm invoiceId={invoice.invoiceId} hasPrevious={!!latest} disabled={evaluating} criteria={invoice.criteria} />}

          {latest && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileUp className="size-4" aria-hidden /> Latest submission
                </CardTitle>
                <CardDescription>Only your latest submission can authorize an advance.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{latest.fileName}</p>
                <p className="text-muted-foreground">
                  {formatBytes(latest.fileSize)} · {formatDate(latest.createdAt, true)}
                </p>
                {latest.note && <p className="pt-2">“{latest.note}”</p>}
              </CardContent>
            </Card>
          )}

          <EvaluationPanel
            evaluation={latestEval}
            nextStep={
              latestEval?.state === "completed" ? (
                <NextStep
                  passed={latestEval.passed}
                  eligible={eligibility.eligible}
                  amount={eligibility.amount}
                  firstBlocker={eligibility.blockers[0]?.message}
                  invoiceStatus={invoice.onchainStatus}
                />
              ) : undefined
            }
          />
          {latestEval?.state === "error" && (
            <Button variant="outline" onClick={() => retryEval.run()} disabled={retryEval.pending}>
              <RotateCcw /> {retryEval.pending ? "Evaluating…" : "Run evaluation again"}
            </Button>
          )}
          {latest && !latestEval && (
            <Alert>
              <AlertTitle>Not evaluated yet</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>This submission hasn&apos;t been evaluated.</p>
                <Button size="sm" onClick={() => retryEval.run()} disabled={retryEval.pending}>
                  {retryEval.pending ? "Evaluating…" : "Run simulated evaluation"}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <CriteriaList invoice={invoice} />
        </div>

        <div className="space-y-6">
          <AdvanceCard
            eligible={eligibility.eligible}
            amount={eligibility.amount}
            blockers={eligibility.blockers.map((b) => b.message)}
            pending={advance.pending}
            invoiceStatus={invoice.onchainStatus}
            advanceAmount={invoice.advanceAmount}
            lastRequest={lastRequest}
            onRequest={() => setConfirmAdvance(true)}
            reserveAvailable={reserveAvailable}
          />
          <PaymentFlow invoice={invoice} transactions={transactions} />
          <FundsBreakdown invoice={invoice} reserveAvailable={reserveAvailable} />
          <Card>
            <CardHeader>
              <CardTitle>Payment timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <Timeline events={timeline} />
            </CardContent>
          </Card>
        </div>
      </div>

      {transactions.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Transactions</h2>
            <SimulatedTag />
          </div>
          <TransactionList transactions={transactions} />
        </section>
      )}

      <AlertDialog open={confirmAdvance} onOpenChange={(o) => !o && !advance.pending && setConfirmAdvance(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Request your 90% advance?</AlertDialogTitle>
            <AlertDialogDescription>
              The platform reserve will pay you {formatToken(eligibility.amount)} now. When the client approves, escrow refunds the reserve that amount and you receive the remaining {formatToken((BigInt(invoice.amount) - BigInt(eligibility.amount)).toString())}. If the client disputes, the advance isn&apos;t clawed back but the rest stays frozen. Simulated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={advance.pending}>Cancel</AlertDialogCancel>
            <Button onClick={onAdvance} disabled={advance.pending}>
              {advance.pending ? "Waiting for confirmation…" : "Request advance"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function NextStep({
  passed,
  eligible,
  amount,
  firstBlocker,
  invoiceStatus,
}: {
  passed: boolean
  eligible: boolean
  amount: string
  firstBlocker?: string
  invoiceStatus: string
}) {
  if (!passed)
    return (
      <Alert variant="destructive">
        <XCircle />
        <AlertTitle>Next step: submit improved evidence</AlertTitle>
        <AlertDescription>
          The AI recommends this work doesn&apos;t yet meet the criteria. Address the criteria marked &quot;Not met&quot; and submit again. No advance is available until a later submission passes.
        </AlertDescription>
      </Alert>
    )
  if (invoiceStatus === "Advanced" || invoiceStatus === "Settled")
    return (
      <Alert>
        <CheckCircle2 />
        <AlertTitle>{invoiceStatus === "Settled" ? "Invoice settled" : "Advance already taken"}</AlertTitle>
        <AlertDescription>
          {invoiceStatus === "Settled" ? "The client approved and escrow has paid out." : "The remainder is paid when the client approves."}
        </AlertDescription>
      </Alert>
    )
  if (eligible)
    return (
      <Alert>
        <Rocket />
        <AlertTitle>Next step: you can request an advance</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            The AI recommends a pass. Requesting is your choice: <Amount value={amount} /> (90%) would be paid from the platform reserve. Nothing is paid until you request it and it confirms.
          </p>
          <a href="#advance" className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline">
            Go to advance request <ArrowDown className="size-3.5" aria-hidden />
          </a>
        </AlertDescription>
      </Alert>
    )
  return (
    <Alert>
      <CheckCircle2 />
      <AlertTitle>The AI recommends a pass, but an advance isn&apos;t available yet</AlertTitle>
      <AlertDescription>{firstBlocker ?? "See the advance card for details."}</AlertDescription>
    </Alert>
  )
}

function AdvanceCard(props: {
  eligible: boolean
  amount: string
  blockers: string[]
  pending: boolean
  invoiceStatus: string
  advanceAmount: string
  lastRequest?: { status: string; reason?: string }
  onRequest: () => void
  reserveAvailable: string
}) {
  const paid = props.invoiceStatus === "Advanced" || props.invoiceStatus === "Settled" || props.invoiceStatus === "Disputed"
  const wasPaid = props.advanceAmount !== "0"
  return (
    <Card id="advance" className={`scroll-mt-20 ${props.eligible ? "ring-2 ring-advance/40" : ""}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="size-4" aria-hidden /> Early advance
        </CardTitle>
        <CardDescription>90% of the invoice, rounded down, paid from the platform reserve after a passing evaluation.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground">Advance amount</span>
          <Amount value={wasPaid ? props.advanceAmount : props.amount} className="text-lg" />
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground">Reserve available</span>
          <Amount value={props.reserveAvailable} />
        </div>

        {wasPaid && paid ? (
          <Pill tone="success" icon={CheckCircle2}>
            Advance paid (simulated)
          </Pill>
        ) : props.pending || props.lastRequest?.status === "pending" ? (
          <Pill tone="warning">Pending — waiting for simulated confirmation</Pill>
        ) : (
          <>
            <Button size="lg" className="w-full" disabled={!props.eligible} onClick={props.onRequest}>
              <Rocket /> Request 90% advance
            </Button>
            {!props.eligible && props.blockers.length > 0 && (
              <ul className="space-y-1.5 rounded-lg bg-muted/60 p-3" aria-label="Why the advance isn't available">
                {props.blockers.map((b) => (
                  <li key={b} className="flex gap-2 text-muted-foreground">
                    <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {b}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {props.lastRequest && (props.lastRequest.status === "denied" || props.lastRequest.status === "failed") && (
          <Alert variant="destructive">
            <AlertOctagon />
            <AlertTitle>Last request {props.lastRequest.status}</AlertTitle>
            <AlertDescription>{props.lastRequest.reason}</AlertDescription>
          </Alert>
        )}
        <p className="text-xs text-muted-foreground">
          You must request this yourself; passing the AI check alone never triggers a payment.
        </p>
      </CardContent>
    </Card>
  )
}

function EvidenceForm({ invoiceId, hasPrevious, disabled, criteria }: { invoiceId: string; hasPrevious: boolean; disabled: boolean; criteria: AcceptanceCriterion[] }) {
  const toast = useToast()
  const [file, setFile] = React.useState<File | null>(null)
  const [note, setNote] = React.useState("")
  const [outcome, setOutcome] = React.useState<"pass" | "fail">("pass")
  const [fileError, setFileError] = React.useState<string | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const [phase, setPhase] = React.useState<"idle" | "uploading" | "evaluating">("idle")
  const [done, setDone] = React.useState<{ fileName: string } | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const submit = useAction(async (repo) => {
    if (!file) throw new Error("Choose a file to upload.")
    setPhase("uploading")
    const sub = await repo.submitEvidence({
      invoiceId,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      note,
      simulatedOutcome: outcome,
    })
    // Evaluation failures are visible and retryable on the evaluation panel.
    setPhase("evaluating")
    await repo.requestEvaluation(sub.submissionId).catch((e) => {
      toast({ tone: "error", title: "Evaluation didn't finish", description: e instanceof Error ? e.message : undefined })
    })
    return sub
  })

  function pick(f: File | undefined | null) {
    setFileError(null)
    setDone(null)
    if (!f) return
    if (f.size > EVIDENCE_MAX_BYTES) return setFileError(`${f.name} is ${formatBytes(f.size)}. The limit is 25 MB.`)
    if (f.type && !EVIDENCE_ACCEPT.includes(f.type)) return setFileError("Use a PDF, PNG, JPG, ZIP, Markdown or text file.")
    setFile(f)
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return setFileError("Choose a file to upload.")
    setDone(null)
    const r = await submit.run()
    setPhase("idle")
    if (r.ok) {
      setDone({ fileName: file.name })
      setFile(null)
      setNote("")
      toast({ tone: "success", title: "Evidence submitted (simulated upload)", description: "Simulated AI evaluation finished." })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="size-4" aria-hidden /> {hasPrevious ? "Submit new evidence" : "Submit evidence"}
        </CardTitle>
        <CardDescription>
          Upload proof that the work meets the criteria. In the demo the file is not actually uploaded; only its name and size are used.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              pick(e.dataTransfer.files[0])
            }}
            className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${dragging ? "border-primary bg-primary/5" : ""}`}
          >
            <input
              ref={inputRef}
              id="evidence"
              type="file"
              className="sr-only"
              accept=".pdf,.png,.jpg,.jpeg,.zip,.md,.txt"
              onChange={(e) => pick(e.target.files?.[0])}
              aria-describedby="evidence-help evidence-err"
            />
            <Upload className="mx-auto mb-2 size-6 text-muted-foreground" aria-hidden />
            <p className="hidden text-sm text-muted-foreground sm:block">Drag and drop a file here, or</p>
            <p className="text-sm text-muted-foreground sm:hidden">Pick a file from your device</p>
            <Button type="button" variant="outline" size="lg" className="mt-3 w-full sm:w-auto" onClick={() => inputRef.current?.click()} disabled={disabled || submit.pending}>
              {file ? "Choose a different file" : "Choose file"}
            </Button>
            <p id="evidence-help" className="mt-3 text-xs text-muted-foreground">
              PDF, PNG, JPG, ZIP, Markdown or text · up to 25 MB
            </p>
          </div>
          <div aria-live="polite">
            {file && (
              <ul aria-label="Attachments" className="rounded-xl border">
                <li className="flex items-center gap-3 p-3">
                  <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(file.size)} · ready to submit</p>
                  </div>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${file.name}`} onClick={() => setFile(null)} disabled={submit.pending}>
                    <X />
                  </Button>
                </li>
              </ul>
            )}
          </div>
          {fileError && (
            <p id="evidence-err" role="alert" className="text-sm text-destructive">
              {fileError}
            </p>
          )}

          <section aria-label="Acceptance criteria checklist" className="space-y-2">
            <p className="text-sm font-medium">The AI will check your evidence against these criteria</p>
            <ol className="space-y-1.5">
              {criteria.map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-sm">
                  <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">{c.text}</span>
                  <Pill tone={c.mandatory ? "info" : "neutral"}>{c.mandatory ? "Mandatory" : "Optional"}</Pill>
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted-foreground">
              The AI only recommends whether the work satisfies these criteria. It does not decide payment.
            </p>
          </section>

          <div className="space-y-1.5">
            <Label htmlFor="note">Note for the reviewer (optional)</Label>
            <Textarea id="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Point to where each criterion is met" />
          </div>

          <fieldset className="space-y-2 rounded-lg border border-dashed border-warning/50 p-3">
            <legend className="flex items-center gap-1.5 px-1 text-xs font-medium">
              Demo only <SimulatedTag>Simulated evaluator</SimulatedTag>
            </legend>
            <p className="text-xs text-muted-foreground">Pick the result the simulated AI returns, so you can demo both outcomes. The real evaluator has no such switch.</p>
            <div className="flex gap-4 text-sm">
              {(["pass", "fail"] as const).map((o) => (
                <label key={o} className="flex items-center gap-2">
                  <input type="radio" name="outcome" className="accent-[var(--primary)]" checked={outcome === o} onChange={() => setOutcome(o)} />
                  {o === "pass" ? "AI passes" : "AI fails"}
                </label>
              ))}
            </div>
          </fieldset>

          {submit.error && (
            <Alert variant="destructive">
              <AlertOctagon />
              <AlertTitle>Couldn&apos;t submit</AlertTitle>
              <AlertDescription>{submit.error}</AlertDescription>
            </Alert>
          )}

          {done && !submit.pending && (
            <Alert role="status">
              <CheckCircle2 />
              <AlertTitle>Evidence submitted (simulated)</AlertTitle>
              <AlertDescription>{done.fileName} was submitted and the simulated AI evaluation finished. See the result below.</AlertDescription>
            </Alert>
          )}

          <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={disabled || submit.pending}>
            {submit.pending ? (
              <>
                <Loader2 className="animate-spin" /> {phase === "evaluating" ? "Evaluating…" : "Uploading…"}
              </>
            ) : disabled ? (
              "Evaluation in progress…"
            ) : (
              "Submit evidence"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

export default function FreelancerInvoicePage() {
  const { id } = useParams<{ id: string }>()
  return <RoleGate role="freelancer">{(session) => <Detail session={session} invoiceId={id} />}</RoleGate>
}
