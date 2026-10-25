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
 * Shows a page only to the matching view role. This is UX only: in live mode the server and the contract authorize every
 * action (the platform view, for instance, needs the on-chain OPERATOR_ROLE and answers 403 to anyone else).
 */
export function RoleGate({ role, children }: { role: DemoRole; children: (session: Session) => React.ReactNode }) {
  const session = useSession()
  const switchRole = useSwitchRole()
  const live = useRepository().mode === "api"

  if (session.error) return <ErrorState message={session.error} onRetry={session.reload} />
  if (!session.data) return <PageSkeleton />
  if (session.data.role !== role) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border px-6 py-14 text-center">
        <ShieldAlert className="size-7 text-muted-foreground" aria-hidden />
        <p className="font-medium">This is the {LABEL[role]} view</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {live
            ? `You're viewing the ${LABEL[session.data.role]} dashboard. One wallet can use both the client and freelancer dashboards: switch to continue. The switch only changes the view. What you can open or do is decided by your verified wallet on the server and by each invoice's own client and freelancer.`
            : `You're signed in as the demo ${LABEL[session.data.role]}. Switch roles to continue.`}
        </p>
        <Button onClick={() => switchRole(role, false)}>Switch to {LABEL[role]}</Button>
      </div>
    )
  }
  return <>{children(session.data)}</>
}
