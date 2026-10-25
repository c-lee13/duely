"use client"

import * as React from "react"
import { useParams } from "next/navigation"
import { AlertOctagon, ArrowLeft, CheckCircle2, ExternalLink, FileText, GitBranch, Lock } from "lucide-react"
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
import { GithubEvaluationPanel } from "@/components/duely/github-evaluation"
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
import { useAction, useInvoiceBundle, usePollWhile, useRepository } from "@/hooks/use-duely"
import { TxProgressPanel, useTxProgress } from "@/components/duely/tx-progress"
import type { InvoiceBundle, Session } from "@/lib/frontend/domain"
import { canClientApprove, canClientDispute, canFund, evaluationFor, settlementProjection } from "@/lib/frontend/eligibility"
import { isGithubEvaluation } from "@/lib/frontend/github-evaluation"
import { githubLinks, shortSha } from "@/lib/frontend/github-input"
import { formatToken, isZero } from "@/lib/frontend/token"
import { fundingCopy } from "@/lib/frontend/protocol-copy"

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
  return <DetailBody bundle={q.data} reload={q.reload} />
}

function DetailBody({ bundle, reload }: { bundle: InvoiceBundle; reload: () => void }) {
  const fc = fundingCopy()
  const toast = useToast()
  const { invoice, submissions, evaluations, timeline, transactions, reserveAvailable } = bundle
  const live = useRepository().mode === "api"
  const [confirm, setConfirm] = React.useState<null | "approve" | "dispute">(null)

  const progress = useTxProgress()
  const sim = live ? "" : " (simulated)"
  const fund = useAction((repo) => repo.fundInvoice(invoice.invoiceId, progress.onProgress))
  const approve = useAction((repo) => repo.approveInvoice(invoice.invoiceId, progress.onProgress))
  const dispute = useAction((repo) => repo.disputeInvoice(invoice.invoiceId, progress.onProgress))
  // A wallet transaction that is still unconfirmed is re-checked against the chain until it is final.
  usePollWhile(live && transactions.some((t) => t.status === "pending"), reload, 5000)

  const latest = submissions[0]
  const latestEval = evaluationFor(latest, evaluations)
  const latestGithub = latest ? githubLinks(latest.repositoryUrl, latest.commitSha) : null
  const proj = settlementProjection(invoice)
  const hasAdvance = !isZero(invoice.advanceAmount)
  const busy = fund.pending || approve.pending || dispute.pending
  const failure = fund.error ?? approve.error ?? dispute.error

  async function onFund() {
    progress.reset()
    const r = await fund.run()
    if (r.ok) toast({ tone: "success", title: `Escrow funded${sim}`, description: live ? `${formatToken(invoice.amount)} locked in escrow, confirmed on-chain.` : `${formatToken(invoice.amount)} locked. No real tokens moved.` })
    else toast({ tone: "error", title: "Funding not completed", description: r.error })
    reload()
  }
  async function onApprove() {
    progress.reset()
    const r = await approve.run()
    setConfirm(null)
    reload()
    if (r.ok)
      toast({
        tone: "success",
        title: `Invoice settled${sim}`,
        description: hasAdvance
          ? fc.pull
            ? `${formatToken(proj.reserveCredit)} repaid to the vault (advance + fee); ${formatToken(proj.toFreelancer)} credited to the freelancer to claim.`
            : `${formatToken(proj.reserveCredit)} credited to the reserve, ${formatToken(proj.toFreelancer)} paid to the freelancer.`
          : fc.pull
            ? `${formatToken(proj.toFreelancer)} credited to the freelancer to claim.`
            : `${formatToken(proj.toFreelancer)} paid to the freelancer.`,
      })
    else toast({ tone: "error", title: "Approval not completed", description: r.error })
  }
  async function onDispute() {
    progress.reset()
    const r = await dispute.run()
    setConfirm(null)
    reload()
    if (r.ok) toast({ tone: "warning", title: `Dispute opened${sim}`, description: live ? "Settlement is frozen until the operator resolves it. An advance already paid is not clawed back." : "Settlement is frozen. No refund or clawback happens automatically." })
    else toast({ tone: "error", title: "Dispute not completed", description: r.error })
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

      {/* Decision area: simulated in mock mode; in live mode every button is a wallet transaction that shows as done only once confirmed. */}
      <Card className={invoice.onchainStatus === "Disputed" ? "ring-2 ring-destructive/40" : undefined}>
        <CardHeader>
          <CardTitle>Your decision</CardTitle>
          <CardDescription>
            {live ? "Financial status is read from the contract. " : "Financial status comes from the (simulated) contract. "}Evidence and the AI recommendation are off-chain and don&apos;t move money.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canFund(invoice.onchainStatus) && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Escrow isn&apos;t funded yet. The freelancer can&apos;t submit evidence until you lock <Amount value={invoice.amount} />.
              </p>
              <Button size="lg" onClick={onFund} disabled={busy}>
                <Lock /> {fund.pending ? (live ? "Waiting for wallet and confirmation…" : "Funding (simulated)…") : `Fund escrow${sim}`}
              </Button>
            </div>
          )}

          {invoice.onchainStatus === "Funded" && !latest && (
            <p className="text-sm text-muted-foreground">Waiting for the freelancer to submit evidence. You can still approve or dispute.</p>
          )}
          {invoice.onchainStatus === "Advanced" && (
            <Alert>
              <CheckCircle2 />
              <AlertTitle>90% advance paid from {fc.source}</AlertTitle>
              <AlertDescription>
                {fc.pull ? (
                  <>The freelancer received <Amount value={invoice.advanceAmount} />. Approving repays the vault <Amount value={proj.reserveCredit} /> (the advance plus a <Amount value={proj.fee} /> financing fee) and credits the remaining <Amount value={proj.toFreelancer} /> to the freelancer to claim.</>
                ) : (
                  <>The freelancer received <Amount value={invoice.advanceAmount} />. Approving credits that amount back to the reserve and pays them the remaining <Amount value={proj.toFreelancer} />.</>
                )}
              </AlertDescription>
            </Alert>
          )}
          {invoice.onchainStatus === "Disputed" && (
            <Alert variant="destructive">
              <AlertOctagon />
              <AlertTitle>Settlement is frozen</AlertTitle>
              <AlertDescription>
                Escrow stays locked and the invoice can&apos;t be approved. {hasAdvance ? <>The <Amount value={invoice.advanceAmount} /> advance isn&apos;t clawed back; {fc.pull ? "the vault\u2019s liquidity providers bear that loss" : "the platform bears that risk"}. </> : null}
                {live
                  ? `The platform operator now resolves it on-chain: either the freelancer is paid as normal, or the whole escrow is refunded to you${fc.pull ? " (credited for you to claim)" : ""}. Either way the advance already paid is not clawed back.`
                  : "No automatic refund or arbitration exists. Resolution is handled manually outside this demo."}
              </AlertDescription>
            </Alert>
          )}
          {invoice.onchainStatus === "Settled" && (
            <Alert>
              <CheckCircle2 />
              <AlertTitle>Settled</AlertTitle>
              <AlertDescription>
                {hasAdvance ? (
                  fc.pull ? (
                    <>Escrow repaid the vault <Amount value={invoice.reserveCredited} /> (advance plus fee) and credited <Amount value={proj.toFreelancer} /> to the freelancer to claim.</>
                  ) : (
                    <>Escrow credited <Amount value={invoice.reserveCredited} /> to the reserve and paid <Amount value={proj.toFreelancer} /> to the freelancer.</>
                  )
                ) : (
                  <>No advance was taken, so escrow {fc.pull ? "credited" : "paid"} the full <Amount value={invoice.amount} /> to the freelancer{fc.pull ? " to claim" : ""}.</>
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
              {live ? "Waiting for MetaMask and on-chain confirmation… Nothing here is final until each step shows as confirmed." : "Simulated transaction pending… This is shown as confirmed only after the simulated confirmation."}
            </p>
          )}
        </CardContent>
      </Card>

      {live && <TxProgressPanel steps={progress.steps} title="Wallet steps" />}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {latest ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="size-4" aria-hidden /> Latest submission
                </CardTitle>
                <CardDescription>
                  {submissions.length} submission{submissions.length === 1 ? "" : "s"} · evidence is stored privately{live ? "" : " (simulated path)"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {latestGithub ? (
                  <>
                    <p className="flex items-center gap-2 font-medium">
                      <GitBranch className="size-4 shrink-0" aria-hidden /> GitHub repository
                    </p>
                    <p className="break-all">
                      <a href={latestGithub.repo} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline">
                        {latestGithub.label} <ExternalLink className="size-3.5" aria-hidden />
                        <span className="sr-only">(opens GitHub in a new tab)</span>
                      </a>
                    </p>
                    <p className="text-muted-foreground">
                      Commit{" "}
                      <a href={latestGithub.commit} target="_blank" rel="noopener noreferrer" className="font-mono text-foreground underline-offset-2 hover:underline" title={latest.commitSha ?? undefined}>
                        {shortSha(latest.commitSha ?? "")}
                      </a>{" "}
                      · submitted {formatDate(latest.createdAt, true)}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">{latest.fileName}</p>
                    <p className="text-muted-foreground">
                      {formatBytes(latest.fileSize)} · submitted {formatDate(latest.createdAt, true)}
                    </p>
                  </>
                )}
                {latest.note && <p className="pt-2">“{latest.note}”</p>}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="text-sm text-muted-foreground">No evidence has been submitted yet.</CardContent>
            </Card>
          )}
          {isGithubEvaluation(latestEval) ? <GithubEvaluationPanel evaluation={latestEval} /> : <EvaluationPanel evaluation={latestEval} />}
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
            {!live && <SimulatedTag />}
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
                  {fc.pull
                    ? <>Escrow will repay the vault {formatToken(proj.reserveCredit)} (advance plus a {formatToken(proj.fee)} fee) and credit {formatToken(proj.toFreelancer)} to {invoice.freelancerName} to claim.</>
                    : <>Escrow will credit {formatToken(proj.reserveCredit)} back to the reserve and pay {formatToken(proj.toFreelancer)} to {invoice.freelancerName}.</>} This can&apos;t be undone and ends dispute options.
                </>
              ) : (
                <>
                  Escrow will pay the full {formatToken(proj.toFreelancer)} to {invoice.freelancerName}. This can&apos;t be undone and ends dispute options.
                </>
              )}{" "}
              {live ? "MetaMask will ask you to confirm one transaction." : "Simulated; no real tokens move."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approve.pending}>Cancel</AlertDialogCancel>
            <Button onClick={onApprove} disabled={approve.pending}>
              {approve.pending ? (live ? "Waiting for confirmation…" : "Confirming…") : "Approve & settle"}
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
              {live
                ? "The platform operator then resolves the dispute on-chain: the freelancer is paid, or you are refunded the whole escrow. MetaMask will ask you to confirm one transaction."
                : "There is no automatic refund or arbitration in this MVP; resolution is manual. Simulated."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dispute.pending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={onDispute} disabled={dispute.pending}>
              {dispute.pending ? (live ? "Waiting for confirmation…" : "Confirming…") : "Open dispute"}
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
