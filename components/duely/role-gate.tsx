"use client"

import * as React from "react"
import { ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useRepository, useSession } from "@/hooks/use-duely"
import type { DemoRole, Session } from "@/lib/frontend/domain"
import { ErrorState, PageSkeleton } from "./primitives"
import { useSwitchRole } from "./app-shell"

const LABEL: Record<DemoRole, string> = { client: "client", freelancer: "freelancer", platform: "platform" }

/**
 * Shows a page only to the matching demo role. In mock mode this is UX only;
 * real authorization will happen server-side and on-chain.
 */
export function RoleGate({ role, children }: { role: DemoRole; children: (session: Session) => React.ReactNode }) {
  const session = useSession()
  const switchRole = useSwitchRole()
  const repo = useRepository()

  if (session.error) return <ErrorState message={session.error} onRetry={session.reload} />
  if (!session.data) return <PageSkeleton />
  if (repo.live && role === "platform") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border px-6 py-14 text-center">
        <ShieldAlert className="size-7 text-muted-foreground" aria-hidden />
        <p className="font-medium">The platform view isn&apos;t available in live mode</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Reserve balances and deposits come from the contract, which isn&apos;t connected yet.
        </p>
      </div>
    )
  }
  if (session.data.role !== role) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border px-6 py-14 text-center">
        <ShieldAlert className="size-7 text-muted-foreground" aria-hidden />
        <p className="font-medium">This is the {LABEL[role]} view</p>
        <p className="max-w-md text-sm text-muted-foreground">
          You&apos;re signed in as the demo {LABEL[session.data.role]}. Switch roles to continue. In live mode, access
          will depend on your verified wallet, not this switch.
        </p>
        <Button onClick={() => switchRole(role, false)}>Switch to {LABEL[role]}</Button>
      </div>
    )
  }
  return <>{children(session.data)}</>
}
