"use client"

import * as React from "react"
import { createRepository } from "@/lib/frontend/create-repository"
import type { DuelyRepository } from "@/lib/frontend/repository"
import type { DemoRole, InvoiceId } from "@/lib/frontend/domain"
import { errorMessage } from "@/lib/frontend/errors"

const RepositoryContext = React.createContext<DuelyRepository | null>(null)
const VersionContext = React.createContext(0)

export function DuelyProvider({ children }: { children: React.ReactNode }) {
  const [repo] = React.useState(createRepository)
  const [version, setVersion] = React.useState(0)

  React.useEffect(() => repo.subscribe(() => setVersion((v) => v + 1)), [repo])

  return (
    <RepositoryContext.Provider value={repo}>
      <VersionContext.Provider value={version}>{children}</VersionContext.Provider>
    </RepositoryContext.Provider>
  )
}

export function useRepository(): DuelyRepository {
  const repo = React.useContext(RepositoryContext)
  if (!repo) throw new Error("useRepository must be used inside <DuelyProvider>")
  return repo
}

export interface QueryState<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  reload: () => void
}

/**
 * Runs `fetcher` on mount, when `key` changes, and whenever the repository
 * reports a change. Keeps showing the previous data while refreshing.
 */
export function useRepoQuery<T>(key: string | null, fetcher: (repo: DuelyRepository) => Promise<T>): QueryState<T> {
  const repo = useRepository()
  const version = React.useContext(VersionContext)
  const [state, setState] = React.useState<{ key: string | null; data?: T; error: string | null }>({
    key: null,
    error: null,
  })
  const [nonce, setNonce] = React.useState(0)
  const fetcherRef = React.useRef(fetcher)
  React.useEffect(() => {
    fetcherRef.current = fetcher
  })

  React.useEffect(() => {
    if (key === null) return
    let cancelled = false
    fetcherRef
      .current(repo)
      .then((data) => {
        if (!cancelled) setState({ key, data, error: null })
      })
      .catch((e) => {
        if (!cancelled) setState({ key, data: undefined, error: errorMessage(e) })
      })
    return () => {
      cancelled = true
    }
  }, [repo, key, version, nonce])

  const sameKey = state.key === key
  return {
    data: sameKey ? state.data : undefined,
    error: sameKey ? state.error : null,
    loading: key !== null && (!sameKey || (state.data === undefined && state.error === null)),
    reload: React.useCallback(() => setNonce((n) => n + 1), []),
  }
}

export function useSession() {
  return useRepoQuery("session", (r) => r.getSession())
}

export function useInvoices(role: DemoRole | undefined, wallet: string | undefined) {
  return useRepoQuery(role && wallet ? `invoices:${role}:${wallet}` : null, (r) =>
    r.listInvoices(role as DemoRole, wallet as string)
  )
}

export function useInvoiceBundle(invoiceId: InvoiceId, sessionKey: string | undefined) {
  // Re-fetch when the demo role changes so authorization is re-checked.
  return useRepoQuery(sessionKey ? `invoice:${invoiceId}:${sessionKey}` : null, (r) => r.getInvoice(invoiceId))
}

export function useBalances(sessionKey: string | undefined) {
  return useRepoQuery(sessionKey ? `balances:${sessionKey}` : null, (r) => r.getBalances())
}

export function useTransactions(sessionKey: string | undefined) {
  return useRepoQuery(sessionKey ? `txs:${sessionKey}` : null, (r) => r.listTransactions())
}

/**
 * Calls `fn` every `ms` while `active` is true (for example while an advance is pending, until the server's reconciliation
 * reports a final state). Stops the moment `active` turns false or the component unmounts.
 */
export function usePollWhile(active: boolean, fn: () => void, ms = 4000) {
  const ref = React.useRef(fn)
  React.useEffect(() => {
    ref.current = fn
  })
  React.useEffect(() => {
    if (!active) return
    const t = setInterval(() => ref.current(), ms)
    return () => clearInterval(t)
  }, [active, ms])
}

/** Wraps a mutation with pending/error state. */
export function useAction<A extends unknown[], R>(fn: (repo: DuelyRepository, ...args: A) => Promise<R>) {
  const repo = useRepository()
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const fnRef = React.useRef(fn)
  React.useEffect(() => {
    fnRef.current = fn
  })

  const run = React.useCallback(
    async (...args: A): Promise<{ ok: true; value: R } | { ok: false; error: string }> => {
      setPending(true)
      setError(null)
      try {
        const value = await fnRef.current(repo, ...args)
        return { ok: true, value }
      } catch (e) {
        const message = errorMessage(e)
        setError(message)
        return { ok: false, error: message }
      } finally {
        setPending(false)
      }
    },
    [repo]
  )

  return { run, pending, error, clearError: () => setError(null) }
}
