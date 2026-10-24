"use client"

import { ArrowRight, Banknote, Briefcase, Building2, FileCheck2, Landmark, Lock, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useSession } from "@/hooks/use-duely"
import type { DemoRole } from "@/lib/frontend/domain"
import { useSwitchRole } from "@/components/duely/app-shell"

const ROLES: Array<{ role: DemoRole; title: string; icon: typeof Building2; text: string; cta: string }> = [
  {
    role: "client",
    title: "I'm a client",
    icon: Building2,
    text: "Create an invoice with acceptance criteria, lock payment in escrow, then approve or dispute the work.",
    cta: "Open client dashboard",
  },
  {
    role: "freelancer",
    title: "I'm a freelancer",
    icon: Briefcase,
    text: "Submit evidence, get an AI evaluation, and request a 90% early advance once you pass.",
    cta: "Open freelancer dashboard",
  },
  {
    role: "platform",
    title: "I'm the platform",
    icon: Landmark,
    text: "Fund the reserve that pays advances. See how much is out, and what's at risk in disputes.",
    cta: "Open reserve",
  },
]

const STEPS = [
  { icon: Lock, title: "1. Client escrows", text: "The full invoice amount is locked, with criteria fixed up front." },
  { icon: FileCheck2, title: "2. Freelancer submits", text: "Evidence is checked against those criteria by an AI evaluator." },
  { icon: Sparkles, title: "3. Freelancer asks for an advance", text: "After a pass, they explicitly request 90% from the platform reserve." },
  { icon: Banknote, title: "4. Client approves", text: "Escrow refills the reserve for the advance and pays the remainder." },
]

export default function WelcomePage() {
  const session = useSession()
  const switchRole = useSwitchRole()

  return (
    <div className="space-y-12">
      <section className="space-y-4 pt-2">
        <p className="text-sm font-medium text-primary">Escrow-backed early payment</p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Get paid for finished work before the client signs off.
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Clients lock payment up front. Freelancers prove the work against agreed criteria and can draw 90% early from
          a platform-funded reserve. The AI recommends; it never moves money.
        </p>
        <p className="max-w-2xl text-sm text-muted-foreground">
          This is a clickable demo. Wallets, transactions and AI evaluations are simulated, and DEMO tokens have no value.
        </p>
      </section>

      <section aria-labelledby="pick-role" className="space-y-4">
        <h2 id="pick-role" className="text-lg font-semibold">
          Choose a role to start the demo
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {ROLES.map(({ role, title, icon: Icon, text, cta }) => (
            <Card key={role} className={session.data?.role === role ? "ring-2 ring-primary" : undefined}>
              <CardHeader>
                <span className="mb-1 flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-5" aria-hidden />
                </span>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{text}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => switchRole(role)}>
                  {cta} <ArrowRight data-icon="inline-end" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          You can switch roles any time from the header. The switcher is a demo convenience, not real sign-in.
        </p>
      </section>

      <section aria-labelledby="how" className="space-y-4">
        <h2 id="how" className="text-lg font-semibold">
          How it works
        </h2>
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
              <Icon className="mb-2 size-5 text-primary" aria-hidden />
              <p className="font-medium">{title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground">
          If the client disputes before approval, settlement freezes. An advance already paid isn&apos;t clawed back, and
          nothing is refunded automatically.
        </p>
      </section>
    </div>
  )
}
