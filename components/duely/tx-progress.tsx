"use client"

import * as React from "react"
import { CheckCircle2, CircleDashed, Loader2, XCircle, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { TxProgress } from "@/lib/frontend/tx-runner"
import { tryExplorerTxUrl } from "@/lib/chain/config"

/**
 * Live view of the wallet steps of one action, in the order they happen. A step is only "confirmed" when the transaction
 * runner verified a receipt with the expected event; `pending` and `unknown` are shown as exactly that (never as done).
 */
export function useTxProgress() {
  const [steps, setSteps] = React.useState<TxProgress[]>([])
  const onProgress = React.useCallback((p: TxProgress) => {
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.id === p.id)
      if (i === -1) return [...prev, p]
      const next = [...prev]
      next[i] = { ...next[i], ...p }
      return next
    })
  }, [])
  const reset = React.useCallback(() => setSteps([]), [])
  return { steps, onProgress, reset }
}

const META: Record<TxProgress["status"], { icon: typeof CheckCircle2; text: string; className: string }> = {
  awaiting_wallet: { icon: Loader2, text: "Confirm in your wallet…", className: "text-muted-foreground animate-spin-slow" },
  pending: { icon: Loader2, text: "Submitted, waiting for confirmation…", className: "text-warning-foreground" },
  confirmed: { icon: CheckCircle2, text: "Confirmed on-chain", className: "text-success" },
  failed: { icon: XCircle, text: "Failed", className: "text-destructive" },
  unknown: { icon: AlertTriangle, text: "Not confirmed yet. Don't send it again.", className: "text-warning-foreground" },
}

export function TxProgressPanel({ steps, title = "Transaction progress" }: { steps: TxProgress[]; title?: string }) {
  if (steps.length === 0) return null
  return (
    <Card aria-live="polite">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Each step is final only once it shows &ldquo;Confirmed on-chain&rdquo;.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {steps.map((s) => {
            const m = META[s.status] ?? { icon: CircleDashed, text: s.status, className: "" }
            const Icon = m.icon
            const link = s.txHash ? tryExplorerTxUrl(s.txHash) : null
            return (
              <li key={s.id} className="flex gap-3 text-sm" data-status={s.status}>
                <Icon className={`mt-0.5 size-4 shrink-0 ${m.className}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.label}</p>
                  <p className="text-muted-foreground">{s.error && (s.status === "failed" || s.status === "unknown") ? s.error : m.text}</p>
                  {link && (
                    <a className="text-xs text-primary underline" href={link} target="_blank" rel="noreferrer">
                      View on the explorer
                    </a>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}
