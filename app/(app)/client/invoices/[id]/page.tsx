"use client"

import * as React from "react"
import { useParams } from "next/navigation"
import { AlertOctagon, ArrowLeft, CheckCircle2, FileText, Lock } from "lucide-react"
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
import { RoleGate } from "@/components/duely/role-gate"
import { useToast } from "@/components/duely/toast"
import {
  CriteriaList,
  EvaluationPanel,
  FundsBreakdown,
  InvoiceHeaderCard,
  PaymentFlow,
  Timeline,
  TransactionList,
} from "@/components/duely/invoice-parts"
import {
  Amount,
  ButtonLink,
  ErrorState,
  formatBytes,
  formatDate,
  PageSkeleton,
  SimulatedTag,
  SubmissionStatusBadge,
} from "@/components/duely/primitives"
import { useAction, useInvoiceBundle } from "@/hooks/use-duely"
import type { InvoiceBundle, Session } from "@/lib/frontend/domain"
import { canClientApprove, canClientDispute, canFund, evaluationFor, settlementProjection } from "@/lib/frontend/eligibility"
import { formatToken, isZero } from "@/lib/frontend/token"

function Detail({ session, invoiceId }: { session: Session; invoiceId: string }) {
  const q = useInvoiceBundle(invoiceId, session.role)
  if (q.error) {
    return (
      <ErrorState
        title="Couldn't open this invoice"
        message={q.error}
        onRetry={q.reload}
        action={<ButtonLink href="/client" variant="outline">Back to invoices</ButtonLink>}
      />
    )
  }
  if (!q.data) return <PageSkeleton />
  return <DetailBody bundle={q.data} />
}

function DetailBody({ bundle }: { bundle: InvoiceBundle }) {
  const toast = useToast()
  const { invoice, submissions, evaluations, timeline, transactions, reserveAvailable } = bundle
  const [confirm, setConfirm] = React.useState<null | "approve" | "dispute">(null)

  const fund = useAction((repo) => repo.fundInvoice(invoice.invoiceId))
  const approve = useAction((repo) => repo.approveInvoice(invoice.invoiceId))
  const dispute = useAction((repo) => repo.disputeInvoice(invoice.invoiceId))

  const latest = submissions[0]
  const latestEval = evaluationFor(latest, evaluations)
  const proj = settlementProjection(invoice)
  const hasAdvance = !isZero(invoice.advanceAmount)
  const busy = fund.pending || approve.pending || dispute.pending
  const failure = fund.error ?? approve.error ?? dispute.error

  async function onFund() {
    const r = await fund.run()
    if (r.ok) toast({ tone: "success", title: "Escrow funded (simulated)", description: `${formatToken(invoice.amount)} locked. No real tokens moved.` })
    else toast({ tone: "error", title: "Funding failed", description: r.error })
  }
  async function onApprove() {
    const r = await approve.run()
    setConfirm(null)
    if (r.ok)
      toast({
        tone: "success",
        title: "Invoice settled (simulated)",
        description: hasAdvance
          ? `${formatToken(proj.reserveCredit)} credited to the reserve, ${formatToken(proj.toFreelancer)} paid to the freelancer.`
          : `${formatToken(proj.toFreelancer)} paid to the freelancer.`,
      })
    else toast({ tone: "error", title: "Approval failed", description: r.error })
  }
  async function onDispute() {
    const r = await dispute.run()
    setConfirm(null)
    if (r.ok) toast({ tone: "warning", title: "Dispute opened (simulated)", description: "Settlement is frozen. No refund or clawback happens automatically." })
    else toast({ tone: "error", title: "Dispute failed", description: r.error })
  }

  return (
    <div className="space-y-6">
      <ButtonLink href="/client" variant="ghost" size="sm" className="-ml-2">
        <ArrowLeft /> All invoices
      </ButtonLink>
      <InvoiceHeaderCard
        invoice={invoice}
        perspective="client"
        badges={<SubmissionStatusBadge status={invoice.submissionStatus} passed={latestEval?.state === "completed" ? latestEval.passed : undefined} />}
      />

      {failure && (
        <Alert variant="destructive">
          <AlertOctagon />
          <AlertTitle>That didn&apos;t go through</AlertTitle>
          <AlertDescription>{failure} Nothing changed; you can try again.</AlertDescription>
        </Alert>
      )}

      {/* Decision area */}
      <Card className={invoice.onchainStatus === "Disputed" ? "ring-2 ring-destructive/40" : undefined}>
        <CardHeader>
          <CardTitle>Your decision</CardTitle>
          <CardDescription>
            Financial status comes from the (simulated) contract. Evidence and the AI recommendation are off-chain and don&apos;t move money.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canFund(invoice.onchainStatus) && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Escrow isn&apos;t funded yet. The freelancer can&apos;t submit evidence until you lock <Amount value={invoice.amount} />.
              </p>
              <Button size="lg" onClick={onFund} disabled={busy}>
                <Lock /> {fund.pending ? "Funding (simulated)…" : "Fund escrow (simulated)"}
              </Button>
            </div>
          )}

          {invoice.onchainStatus === "Funded" && !latest && (
            <p className="text-sm text-muted-foreground">Waiting for the freelancer to submit evidence. You can still approve or dispute.</p>
          )}
          {invoice.onchainStatus === "Advanced" && (
            <Alert>
              <CheckCircle2 />
              <AlertTitle>90% advance paid from the reserve</AlertTitle>
              <AlertDescription>
                The freelancer received <Amount value={invoice.advanceAmount} />. Approving credits that amount back to the reserve and pays them the remaining <Amount value={proj.toFreelancer} />.
              </AlertDescription>
            </Alert>
          )}
          {invoice.onchainStatus === "Disputed" && (
            <Alert variant="destructive">
              <AlertOctagon />
              <AlertTitle>Settlement is frozen</AlertTitle>
              <AlertDescription>
                Escrow stays locked and the invoice can&apos;t be approved. {hasAdvance ? <>The <Amount value={invoice.advanceAmount} /> advance isn&apos;t clawed back; the platform bears that risk. </> : null}
                No automatic refund or arbitration exists. Resolution is handled manually outside this demo.
              </AlertDescription>
            </Alert>
          )}
          {invoice.onchainStatus === "Settled" && (
            <Alert>
              <CheckCircle2 />
              <AlertTitle>Settled</AlertTitle>
              <AlertDescription>
                {hasAdvance ? (
                  <>Escrow credited <Amount value={invoice.reserveCredited} /> to the reserve and paid <Amount value={proj.toFreelancer} /> to the freelancer.</>
                ) : (
                  <>No advance was taken, so escrow paid the full <Amount value={invoice.amount} /> to the freelancer.</>
                )}
              </AlertDescription>
            </Alert>
          )}

          {(canClientApprove(invoice.onchainStatus) || canClientDispute(invoice.onchainStatus)) && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button size="lg" onClick={() => setConfirm("approve")} disabled={busy}>
                <CheckCircle2 /> Approve work
              </Button>
              <Button size="lg" variant="destructive" onClick={() => setConfirm("dispute")} disabled={busy}>
                <AlertOctagon /> Dispute
              </Button>
            </div>
          )}
          {busy && (
            <p className="text-sm text-muted-foreground" role="status">
              Simulated transaction pending… This is shown as confirmed only after the simulated confirmation.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {latest ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="size-4" aria-hidden /> Latest submission
                </CardTitle>
                <CardDescription>
                  {submissions.length} submission{submissions.length === 1 ? "" : "s"} · evidence is stored privately (simulated path)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="font-medium">{latest.fileName}</p>
                <p className="text-muted-foreground">
                  {formatBytes(latest.fileSize)} · submitted {formatDate(latest.createdAt, true)}
                </p>
                {latest.note && <p className="pt-2">“{latest.note}”</p>}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="text-sm text-muted-foreground">No evidence has been submitted yet.</CardContent>
            </Card>
          )}
          <EvaluationPanel evaluation={latestEval} />
          <CriteriaList invoice={invoice} />
        </div>

        <div className="space-y-6">
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

      <AlertDialog open={confirm === "approve"} onOpenChange={(o) => !o && !approve.pending && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve and settle this invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              {hasAdvance ? (
                <>
                  Escrow will credit {formatToken(proj.reserveCredit)} back to the reserve and pay {formatToken(proj.toFreelancer)} to {invoice.freelancerName}. This can&apos;t be undone and ends dispute options.
                </>
              ) : (
                <>
                  Escrow will pay the full {formatToken(proj.toFreelancer)} to {invoice.freelancerName}. This can&apos;t be undone and ends dispute options.
                </>
              )}{" "}
              Simulated; no real tokens move.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approve.pending}>Cancel</AlertDialogCancel>
            <Button onClick={onApprove} disabled={approve.pending}>
              {approve.pending ? "Confirming…" : "Approve & settle"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "dispute"} onOpenChange={(o) => !o && !dispute.pending && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open a dispute?</AlertDialogTitle>
            <AlertDialogDescription>
              Settlement freezes and escrow stays locked.{" "}
              {hasAdvance ? `The ${formatToken(invoice.advanceAmount)} advance isn't clawed back. ` : ""}
              There is no automatic refund or arbitration in this MVP; resolution is manual. Simulated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispute.pending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={onDispute} disabled={dispute.pending}>
              {dispute.pending ? "Confirming…" : "Open dispute"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default function ClientInvoicePage() {
  const { id } = useParams<{ id: string }>()
  return <RoleGate role="client">{(session) => <Detail session={session} invoiceId={id} />}</RoleGate>
}
