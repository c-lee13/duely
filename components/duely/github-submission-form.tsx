"use client"

import * as React from "react"
import { AlertOctagon, CheckCircle2, Circle, GitBranch, Loader2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/duely/toast"
import { Pill, SimulatedTag } from "@/components/duely/primitives"
import { useAction, useRepository } from "@/hooks/use-duely"
import type { AcceptanceCriterion } from "@/lib/frontend/domain"
import { checkCommitSha, checkRepositoryUrl, githubLinks, shortSha } from "@/lib/frontend/github-input"

/** The criteria the AI will check the submission against (shared by the file and GitHub forms). */
export function CriteriaChecklist({ criteria }: { criteria: AcceptanceCriterion[] }) {
  return (
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
      <p className="text-xs text-muted-foreground">The AI only recommends whether the work satisfies these criteria. It does not decide payment.</p>
    </section>
  )
}

/**
 * Submit a public GitHub repository and an exact commit instead of a file. The server confirms both with GitHub and stores only
 * the canonical values. This form never fetches GitHub itself, never shows a payment, and a successful submission is not an advance.
 */
export function GithubSubmissionForm({ invoiceId, disabled, criteria }: { invoiceId: string; disabled: boolean; criteria: AcceptanceCriterion[] }) {
  const toast = useToast()
  const mock = useRepository().mode === "mock"
  const [url, setUrl] = React.useState("")
  const [sha, setSha] = React.useState("")
  const [note, setNote] = React.useState("")
  const [outcome, setOutcome] = React.useState<"pass" | "fail">("pass")
  const [touched, setTouched] = React.useState({ url: false, sha: false })
  const [phase, setPhase] = React.useState<"idle" | "checking" | "evaluating">("idle")
  const [done, setDone] = React.useState<{ label: string; sha: string } | null>(null)
  const urlRef = React.useRef<HTMLInputElement>(null)
  const shaRef = React.useRef<HTMLInputElement>(null)

  const urlCheck = checkRepositoryUrl(url)
  const shaCheck = checkCommitSha(sha)
  const urlError = touched.url && !urlCheck.ok ? urlCheck.message : null
  const shaError = touched.sha && !shaCheck.ok ? shaCheck.message : null

  const submit = useAction(async (repo) => {
    if (!urlCheck.ok || !shaCheck.ok) throw new Error("Check the repository URL and commit SHA.")
    setPhase("checking")
    const sub = await repo.submitGithubRepository({
      invoiceId,
      repositoryUrl: urlCheck.value,
      commitSha: shaCheck.value,
      note,
      simulatedOutcome: outcome,
    })
    // The submission is recorded at this point. An evaluation problem is visible and retryable on the evaluation panel.
    setPhase("evaluating")
    await repo.requestEvaluation(sub.submissionId).catch((e) => {
      toast({ tone: "error", title: "Evaluation didn't finish", description: e instanceof Error ? e.message : undefined })
    })
    return sub
  })

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setDone(null)
    setTouched({ url: true, sha: true })
    if (!urlCheck.ok) return urlRef.current?.focus()
    if (!shaCheck.ok) return shaRef.current?.focus()
    const r = await submit.run()
    setPhase("idle")
    if (r.ok) {
      const links = githubLinks(r.value.repositoryUrl, r.value.commitSha)
      setDone({ label: links?.label ?? "your repository", sha: r.value.commitSha ? shortSha(r.value.commitSha) : "" })
      setUrl("")
      setSha("")
      setNote("")
      setTouched({ url: false, sha: false })
      toast({
        tone: "success",
        title: mock ? "Repository submitted (simulated)" : "Repository submitted",
        description: "Recorded for review. No payment has been made.",
      })
    }
  }

  const busy = submit.pending

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label="Submit a GitHub repository">
      <Alert>
        <GitBranch />
        <AlertTitle>Public repositories only</AlertTitle>
        <AlertDescription>
          Duely checks that the repository and commit exist on GitHub and reads the source as text. Your code is never run, and the review is
          pinned to the exact commit you enter, so later pushes don&apos;t change it.
        </AlertDescription>
      </Alert>

      <div className="space-y-1.5">
        <Label htmlFor="repo-url">Repository URL</Label>
        <Input
          ref={urlRef}
          id="repo-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="https://github.com/owner/repository"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, url: true }))}
          aria-invalid={urlError ? true : undefined}
          aria-describedby={urlError ? "repo-url-err" : "repo-url-help"}
          disabled={disabled || busy}
          className="h-10"
        />
        {urlError ? (
          <p id="repo-url-err" role="alert" className="text-sm text-destructive">
            {urlError}
          </p>
        ) : (
          <p id="repo-url-help" className="text-xs text-muted-foreground">
            The repository&apos;s main page, like https://github.com/owner/repository.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="commit-sha">Commit SHA (40 characters)</Label>
        <Input
          ref={shaRef}
          id="commit-sha"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={80}
          placeholder="e.g. 9fceb02d0ae598e95dc970b74767f19372d61af8"
          value={sha}
          onChange={(e) => setSha(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, sha: true }))}
          aria-invalid={shaError ? true : undefined}
          aria-describedby={shaError ? "commit-sha-err" : "commit-sha-help"}
          disabled={disabled || busy}
          className="h-10 font-mono text-base md:text-sm"
        />
        {shaError ? (
          <p id="commit-sha-err" role="alert" className="text-sm text-destructive">
            {shaError}
          </p>
        ) : (
          <p id="commit-sha-help" className="text-xs text-muted-foreground">
            The exact commit to review. In your project run <code className="rounded bg-muted px-1">git rev-parse HEAD</code> to copy it. Short SHAs and branch names aren&apos;t accepted.
          </p>
        )}
      </div>

      <CriteriaChecklist criteria={criteria} />

      <div className="space-y-1.5">
        <Label htmlFor="github-note">Note for the reviewer (optional)</Label>
        <Textarea id="github-note" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} disabled={busy} placeholder="Point to where each criterion is met, e.g. src/auth.ts" />
      </div>

      {mock && (
        <fieldset className="space-y-2 rounded-lg border border-dashed border-warning/50 p-3">
          <legend className="flex items-center gap-1.5 px-1 text-xs font-medium">
            Demo only <SimulatedTag>Simulated evaluator</SimulatedTag>
          </legend>
          <p className="text-xs text-muted-foreground">Nothing is fetched from GitHub in the demo. Pick the result the simulated AI returns.</p>
          <div className="flex gap-4 text-sm">
            {(["pass", "fail"] as const).map((o) => (
              <label key={o} className="flex items-center gap-2">
                <input type="radio" name="github-outcome" className="accent-[var(--primary)]" checked={outcome === o} onChange={() => setOutcome(o)} />
                {o === "pass" ? "AI passes" : "AI fails"}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {submit.error && (
        <Alert variant="destructive">
          <AlertOctagon />
          <AlertTitle>Couldn&apos;t submit</AlertTitle>
          <AlertDescription>{submit.error}</AlertDescription>
        </Alert>
      )}

      {done && !busy && (
        <Alert role="status">
          <CheckCircle2 />
          <AlertTitle>{mock ? "Repository submitted (simulated)" : "Repository submitted"}</AlertTitle>
          <AlertDescription>
            {done.label}
            {done.sha ? ` at commit ${done.sha}` : ""} was recorded and is shown below as your latest submission. This is not a payment: an advance
            needs a passing evaluation and your own request.
          </AlertDescription>
        </Alert>
      )}

      <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={disabled || busy}>
        {busy ? (
          <>
            <Loader2 className="animate-spin" /> {phase === "evaluating" ? "Evaluating…" : mock ? "Submitting…" : "Checking repository…"}
          </>
        ) : disabled ? (
          "Evaluation in progress…"
        ) : (
          "Submit repository"
        )}
      </Button>
    </form>
  )
}
