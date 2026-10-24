"use client"

import { History } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { TransactionList } from "@/components/duely/invoice-parts"
import { EmptyState, ErrorState, PageHeader } from "@/components/duely/primitives"
import { useSession, useTransactions } from "@/hooks/use-duely"

export default function ActivityPage() {
  const session = useSession()
  const txs = useTransactions(session.data?.role)

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Activity" title="Transaction history" description="Every simulated payment-related action visible to your role." />
      <Alert>
        <History />
        <AlertTitle>Simulated transactions</AlertTitle>
        <AlertDescription>
          These entries come from the in-browser demo ledger, so none has a blockchain hash or explorer link. Pending
          becomes confirmed only after the simulated confirmation; failed means nothing moved.
        </AlertDescription>
      </Alert>
      {txs.error ? (
        <ErrorState message={txs.error} onRetry={txs.reload} />
      ) : !txs.data ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : txs.data.length === 0 ? (
        <EmptyState icon={History} title="No transactions yet" description="Actions like funding escrow or paying an advance appear here." />
      ) : (
        <TransactionList transactions={txs.data} showInvoice />
      )}
    </div>
  )
}
