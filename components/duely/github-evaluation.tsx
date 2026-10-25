import * as React from "react"
import { AlertOctagon, CheckCircle2, CircleDashed, ExternalLink, GitBranch, ShieldAlert, XCircle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Pill, formatDate } from "@/components/duely/primitives"
import { cn } from "@/lib/utils"
import type { CriterionAssessmentValue, CriterionResult, EvaluationRecord } from "@/lib/frontend/domain"
import {
  blockedReasonsOf,
  earnedFraction,
  formatPoints,
  scoringNotesOf,
  splitReason,
  unverifiedReferenceCount,
  verdictOf,
  whyNotPassOf,
  type Verdict,
} from "@/lib/frontend/github-evaluation"
import { githubBlobLink, githubCommitLinks, shortSha } from "@/lib/frontend/github-input"

/**
 * The detailed breakdown of a GitHub code evaluation, built only from what the backend stored and returned. Everything the
 * model or the repository wrote (explanations, file paths, quotes) is untrusted text: it is rendered as text, never as HTML,
 * and a link is produced only from values that pass strict checks and always names the exact commit.
 */

const VERDICT: Record<Verdict, { tone: "success" | "warning" | "danger"; icon: typeof CheckCircle2; label: string }> = {
  Pass: { tone: "success", icon: CheckCircle2, label: "Pass" },
  "Needs Review": { tone: "warning", icon: ShieldAlert, label: "Needs review" },
  Fail: { tone: "danger", icon: XCircle, label: "Fail" },
}

const ASSESSMENT: Record<CriterionAssessmentValue, { tone: "success" | "warning" | "danger"; icon: typeof CheckCircle2; label: string; blurb: string }> = {
  verified: { tone: "success", icon: CheckCircle2, label: "Verified", blurb: "The code clearly implements this." },
  partial: { tone: "warning", icon: CircleDashed, label: "Partial", blurb: "Only part of this is implemented, or only loosely." },
  unsupported: { tone: "danger", icon: XCircle, label: "Unsupported", blurb: "The code doesn't show this." },
}

const lines = (r: { startLine: number; endLine: number }) => (r.endLine === r.startLine ? `${r.startLine}` : `${r.startLine}–${r.endLine}`)

export function GithubEvaluationPanel({
  evaluation,
  mandatory,
  nextStep,
}: {
  evaluation: EvaluationRecord & { source: NonNullable<EvaluationRecord["source"]> }
  /** Per-criterion mandatory flags; defaults to the evaluation's own. */
  mandatory?: boolean[]
  /** Contextual next step shown under the breakdown (freelancer view). */
  nextStep?: React.ReactNode
}) {
  const flags = mandatory ?? evaluation.mandatory ?? []
  const verdict = verdictOf({ ...evaluation, mandatory: flags })
  const v = VERDICT[verdict]
  const blocked = blockedReasonsOf(evaluation.summary)
  const unverified = unverifiedReferenceCount(evaluation.summary)
  const notes = scoringNotesOf(evaluation.summary)
  const why = verdict === "Pass" ? [] : whyNotPassOf({ ...evaluation, mandatory: flags })
  const { repository, commitSha } = evaluation.source
  const links = githubCommitLinks(repository, commitSha)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="size-4" aria-hidden /> Code review
        </CardTitle>
        <CardDescription>
          The AI only recommends whether the code satisfies the agreed criteria. It is not the final arbiter, never signs or moves money, and the
          client still approves.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center gap-4">
          <div
            className={cn(
              "flex size-24 shrink-0 flex-col items-center justify-center rounded-full ring-4 ring-inset",
              verdict === "Pass" ? "bg-success/10 ring-success/30" : verdict === "Fail" ? "bg-destructive/10 ring-destructive/30" : "bg-warning/10 ring-warning/30"
            )}
            role="img"
            aria-label={`Score ${evaluation.score} out of 100`}
          >
            <span className="text-3xl font-semibold tabular-nums">{evaluation.score}</span>
            <span className="text-[10px] text-muted-foreground">/ 100</span>
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <Pill tone={v.tone} icon={v.icon}>
              Verdict: {v.label}
            </Pill>
            <p className="text-xs text-muted-foreground">
              Evaluated {formatDate(evaluation.evaluatedAt, true)} · {evaluation.model} · {evaluation.promptVersion}
            </p>
            <p className="break-words text-sm">
              Reviewed{" "}
              {links ? (
                <>
                  <a href={links.repo} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
                    {repository}
                    <span className="sr-only"> (opens GitHub in a new tab)</span>
                  </a>{" "}
                  at commit{" "}
                  <a
                    href={links.commit}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={commitSha}
                    className="inline-flex items-center gap-1 font-mono text-foreground underline-offset-2 hover:underline"
                  >
                    {shortSha(commitSha)} <ExternalLink className="size-3" aria-hidden />
                    <span className="sr-only"> (opens the commit on GitHub in a new tab)</span>
                  </a>
                </>
              ) : (
                <span>
                  {repository} at commit <span className="font-mono">{shortSha(commitSha)}</span>
                </span>
              )}
              . The source was read as text at this exact commit and never run.
            </p>
          </div>
        </div>

        <Progress value={evaluation.score} aria-label="Evaluation score" />

        {blocked.length > 0 && (
          <Alert variant="destructive" role="alert">
            <AlertOctagon />
            <AlertTitle>Automatic approval was blocked</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                The reviewed source may be incomplete, so this result can&apos;t pass automatically and needs a person to look at it.
              </p>
              <ul className="list-disc space-y-0.5 pl-5">
                {blocked.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {why.length > 0 && (
          <Alert>
            <ShieldAlert />
            <AlertTitle>Why this isn&apos;t a pass</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-0.5 pl-5">
                {why.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {unverified > 0 && (
          <p className="text-sm text-muted-foreground">
            Some cited source references couldn&apos;t be verified in the code and were not counted. Criteria that relied on them were downgraded, as noted below.
          </p>
        )}
        {notes && <p className="text-sm text-muted-foreground">{notes}</p>}

        <ol className="space-y-3" aria-label="Criteria breakdown">
          {evaluation.criteriaResults.map((r, i) => (
            <CriterionCard key={i} result={r} mandatory={flags[i] === true} source={evaluation.source} />
          ))}
        </ol>

        {nextStep}

        <dl className="grid gap-x-6 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
          <div>
            <dt className="inline font-medium">Pass rule: </dt>
            <dd className="inline">{evaluation.passRule}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  )
}

function CriterionCard({ result: r, mandatory, source }: { result: CriterionResult; mandatory: boolean; source: { repository: string; commitSha: string } }) {
  const a = r.assessment ? ASSESSMENT[r.assessment] : null
  const parts = splitReason(r.reason)
  const hasPoints = r.weight !== undefined && r.points !== undefined
  const evidence = r.evidence ?? []
  return (
    <li className="space-y-3 rounded-xl border p-3 text-sm sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 break-words font-medium">{r.criterion}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {a ? (
            <Pill tone={a.tone} icon={a.icon} title={a.blurb}>
              {a.label}
            </Pill>
          ) : (
            <Pill tone={r.passed ? "success" : "danger"}>{r.passed ? "Met" : "Not met"}</Pill>
          )}
          <Pill tone={mandatory ? "info" : "neutral"}>{mandatory ? "Mandatory" : "Optional"}</Pill>
        </div>
      </div>

      {hasPoints && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">
              {formatPoints(r.points!)} of {formatPoints(r.weight!)} points
            </span>{" "}
            earned · weight {formatPoints(r.weight!)}
          </p>
          <Progress value={earnedFraction(r)} aria-label={`${formatPoints(r.points!)} of ${formatPoints(r.weight!)} points earned`} />
        </div>
      )}

      <div className="space-y-1.5">
        <p className="break-words">
          <span className="font-medium">Reviewer&apos;s explanation: </span>
          {parts.explanation}
        </p>
        {parts.missing && (
          <p className="break-words text-muted-foreground">
            <span className="font-medium text-foreground">Missing: </span>
            {parts.missing}
          </p>
        )}
        {parts.uncertain && (
          <p className="break-words text-muted-foreground">
            <span className="font-medium text-foreground">Uncertain: </span>
            {parts.uncertain}
          </p>
        )}
        {parts.notes.map((n, i) => (
          <p key={i} className="text-xs text-muted-foreground">
            {n}
          </p>
        ))}
      </div>

      {evidence.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Cited code ({evidence.length})</p>
          <ul className="space-y-2">
            {evidence.map((ref, j) => {
              const href = githubBlobLink(source.repository, source.commitSha, ref.path, ref.startLine, ref.endLine)
              return (
                <li key={j} className="min-w-0 rounded-lg bg-muted/60 p-2">
                  <p className="break-all font-mono text-xs">
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                        {ref.path}:{lines(ref)}
                        <span className="sr-only"> (opens this code at the reviewed commit on GitHub in a new tab)</span>
                      </a>
                    ) : (
                      <span>
                        {ref.path}:{lines(ref)}
                      </span>
                    )}
                  </p>
                  <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 pl-2 font-mono text-xs text-muted-foreground">{ref.quote}</blockquote>
                </li>
              )
            })}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No verified code reference supports this criterion.</p>
      )}
    </li>
  )
}
