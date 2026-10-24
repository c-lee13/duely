"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowDown, ArrowLeft, ArrowUp, Check, Lock, Plus, Trash2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RoleGate } from "@/components/duely/role-gate"
import { useToast } from "@/components/duely/toast"
import { AddressChip, Amount, ButtonLink, PageHeader, Pill, SimulatedTag } from "@/components/duely/primitives"
import { useAction } from "@/hooks/use-duely"
import { ACTORS, nameForWallet } from "@/lib/mocks/actors"
import type { Address } from "@/lib/frontend/domain"
import { advanceFor, DEMO_TOKEN, parseTokenInput } from "@/lib/frontend/token"

interface CriterionDraft {
  key: number
  text: string
  mandatory: boolean
}

type Errors = Partial<Record<"title" | "freelancer" | "amount" | "description" | "criteria", string>>

function NewInvoice({ clientWallet }: { clientWallet: Address }) {
  const router = useRouter()
  const toast = useToast()
  const keyRef = React.useRef(3)
  const [step, setStep] = React.useState<"edit" | "review">("edit")
  const [title, setTitle] = React.useState("")
  const [freelancer, setFreelancer] = React.useState<string>(ACTORS.freelancer.wallet)
  const [amountText, setAmountText] = React.useState("1000")
  const [description, setDescription] = React.useState("")
  const [dueDate, setDueDate] = React.useState("")
  const [criteria, setCriteria] = React.useState<CriterionDraft[]>([
    { key: 1, text: "", mandatory: true },
    { key: 2, text: "", mandatory: true },
  ])
  const [errors, setErrors] = React.useState<Errors>({})

  const create = useAction(async (repo, ...[input]: [Parameters<typeof repo.createInvoice>[0]]) => {
    const invoice = await repo.createInvoice(input)
    await repo.fundInvoice(invoice.invoiceId).catch((e) => {
      // Created but not funded: let the user retry funding from the detail page.
      toast({ tone: "warning", title: "Invoice created, funding not completed", description: e instanceof Error ? e.message : undefined })
    })
    return invoice
  })

  const amount = parseTokenInput(amountText)

  function validate(): boolean {
    const e: Errors = {}
    if (!title.trim()) e.title = "Give the invoice a short title."
    if (!/^0x[0-9a-fA-F]{40}$/.test(freelancer.trim())) e.freelancer = "Enter a valid 0x wallet address (42 characters)."
    else if (freelancer.trim().toLowerCase() === clientWallet.toLowerCase()) e.freelancer = "The freelancer wallet must differ from yours."
    if (!amount || BigInt(amount) <= BigInt(0)) e.amount = "Enter an amount greater than zero, such as 1000 or 250.5."
    if (!description.trim()) e.description = "Describe the work so both sides agree on scope."
    const filled = criteria.filter((c) => c.text.trim())
    if (filled.length === 0) e.criteria = "Add at least one acceptance criterion."
    else if (!filled.some((c) => c.mandatory)) e.criteria = "Mark at least one criterion as mandatory."
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function move(i: number, d: -1 | 1) {
    setCriteria((cs) => {
      const j = i + d
      if (j < 0 || j >= cs.length) return cs
      const next = [...cs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  async function submit() {
    if (!amount) return
    const res = await create.run({
      title,
      freelancer: freelancer.trim() as Address,
      amount,
      description,
      dueDate: dueDate || undefined,
      criteria: criteria.filter((c) => c.text.trim()).map((c) => ({ text: c.text, mandatory: c.mandatory })),
    })
    if (res.ok) {
      toast({ tone: "success", title: "Invoice created and escrow funded (simulated)", description: "No real tokens moved." })
      router.push(`/client/invoices/${res.value.invoiceId}`)
    }
  }

  const filledCriteria = criteria.filter((c) => c.text.trim())

  if (step === "review" && amount) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <PageHeader eyebrow="Step 2 of 2" title="Review and fund" description="Check everything. Criteria can't be changed after this." />
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Freelancer</dt>
                <dd className="mt-0.5 min-w-0">
                  <AddressChip address={freelancer} label={nameForWallet(freelancer)} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Escrow amount</dt>
                <dd className="mt-0.5 text-lg">
                  <Amount value={amount} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Possible 90% advance</dt>
                <dd className="mt-0.5">
                  <Amount value={advanceFor(amount)} /> <span className="text-muted-foreground">from the reserve, if requested</span>
                </dd>
              </div>
              {dueDate && (
                <div>
                  <dt className="text-muted-foreground">Due</dt>
                  <dd className="mt-0.5">{dueDate}</dd>
                </div>
              )}
            </dl>
            <div>
              <p className="mb-2 flex items-center gap-1.5 font-medium">
                <Lock className="size-4" aria-hidden /> Acceptance criteria (locked once created)
              </p>
              <ol className="space-y-2">
                {filledCriteria.map((c, i) => (
                  <li key={c.key} className="flex gap-3 rounded-lg border p-3">
                    <span className="text-muted-foreground">{i + 1}.</span>
                    <span className="flex-1">{c.text}</span>
                    <Pill tone={c.mandatory ? "info" : "neutral"}>{c.mandatory ? "Mandatory" : "Optional"}</Pill>
                  </li>
                ))}
              </ol>
            </div>
            <Alert>
              <Lock />
              <AlertTitle className="flex items-center gap-2">
                Simulated transactions <SimulatedTag />
              </AlertTitle>
              <AlertDescription>
                Confirming runs two simulated steps: create the invoice, then lock <Amount value={amount} /> in escrow. No
                wallet is used and no real funds move. DEMO tokens aren&apos;t RLUSD or real dollars.
              </AlertDescription>
            </Alert>
            {create.error && (
              <Alert variant="destructive" role="alert">
                <AlertTitle>Couldn&apos;t complete the transaction</AlertTitle>
                <AlertDescription>{create.error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button variant="outline" onClick={() => setStep("edit")} disabled={create.pending}>
            <ArrowLeft /> Edit
          </Button>
          <Button size="lg" onClick={submit} disabled={create.pending}>
            {create.pending ? "Confirming simulated transactions…" : (
              <>
                <Check /> Create invoice &amp; fund escrow
              </>
            )}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader eyebrow="Step 1 of 2" title="New invoice" description="Define the work and exactly how it will be judged." />
      <form
        noValidate
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (validate()) setStep("review")
        }}
      >
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Title" error={errors.title} htmlFor="title">
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Investor pitch deck" aria-invalid={!!errors.title} aria-describedby={errors.title ? "title-err" : undefined} />
            </Field>
            <Field label="Freelancer wallet" error={errors.freelancer} htmlFor="freelancer" hint="Demo wallet prefilled. Anyone using another address won't see this invoice.">
              <Input id="freelancer" value={freelancer} onChange={(e) => setFreelancer(e.target.value)} className="font-mono text-base sm:text-xs" aria-invalid={!!errors.freelancer} aria-describedby={errors.freelancer ? "freelancer-err" : undefined} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={`Amount (${DEMO_TOKEN.symbol} demo tokens)`} error={errors.amount} htmlFor="amount">
                <Input id="amount" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-invalid={!!errors.amount} aria-describedby={errors.amount ? "amount-err" : undefined} />
              </Field>
              <Field label="Due date (optional)" htmlFor="due">
                <Input id="due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>
            </div>
            {amount && BigInt(amount) > BigInt(0) && (
              <p className="text-sm text-muted-foreground">
                If the freelancer requests an advance, <Amount value={advanceFor(amount)} /> (90%, rounded down) is paid from the platform reserve.
              </p>
            )}
            <Field label="Description" error={errors.description} htmlFor="description">
              <Textarea id="description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What will be delivered?" aria-invalid={!!errors.description} aria-describedby={errors.description ? "description-err" : undefined} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Acceptance criteria</CardTitle>
            <CardDescription>
              The AI judges submissions only against these, in order. They&apos;re locked when you create the invoice; a change means a new invoice.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {criteria.map((c, i) => (
              <div key={c.key} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{i + 1}</span>
                  <Input
                    aria-label={`Criterion ${i + 1}`}
                    value={c.text}
                    placeholder="A checkable requirement"
                    onChange={(e) => setCriteria((cs) => cs.map((x) => (x.key === c.key ? { ...x, text: e.target.value } : x)))}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 pl-8">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={c.mandatory}
                      onChange={(e) => setCriteria((cs) => cs.map((x) => (x.key === c.key ? { ...x, mandatory: e.target.checked } : x)))}
                    />
                    Mandatory (must pass for an advance)
                  </label>
                  <div className="flex gap-1">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move criterion ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move criterion ${i + 1} down`} disabled={i === criteria.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove criterion ${i + 1}`} disabled={criteria.length === 1} onClick={() => setCriteria((cs) => cs.filter((x) => x.key !== c.key))}>
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {errors.criteria && (
              <p id="criteria-err" role="alert" className="text-sm text-destructive">
                {errors.criteria}
              </p>
            )}
            <Button type="button" variant="outline" onClick={() => setCriteria((cs) => [...cs, { key: keyRef.current++, text: "", mandatory: false }])}>
              <Plus /> Add criterion
            </Button>
          </CardContent>
        </Card>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <ButtonLink href="/client" variant="outline">
            Cancel
          </ButtonLink>
          <Button type="submit" size="lg">
            Review details
          </Button>
        </div>
      </form>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  error?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p id={`${htmlFor}-err`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

export default function NewInvoicePage() {
  return <RoleGate role="client">{(session) => <NewInvoice clientWallet={session.wallet} />}</RoleGate>
}
