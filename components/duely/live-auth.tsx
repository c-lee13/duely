"use client"

import * as React from "react"
import { useRepoQuery } from "@/hooks/use-duely"
import { ErrorState, PageSkeleton } from "./primitives"
import { LoginChoice } from "./login-choice"

/**
 * Live (API) mode only: nothing is shown until the SERVER confirms a signed-in user with a
 * verified wallet. The answer comes from /api/auth/session, never from browser storage.
 * Mock mode never renders this.
 */
export function LiveAuthGate({ children }: { children: React.ReactNode }) {
  const auth = useRepoQuery("live-auth", (r) =>
    r.live ? r.live.getAuth() : Promise.resolve({ authenticated: true, wallets: [] })
  )

  if (auth.error) return <ErrorState message={auth.error} onRetry={auth.reload} />
  if (!auth.data) return <PageSkeleton />
  if (auth.data.authenticated && auth.data.wallets.length > 0) return <>{children}</>

  return <LoginChoice needsWalletOnly={auth.data.authenticated} />
}
