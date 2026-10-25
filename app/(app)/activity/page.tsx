"use client"

import { History } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { TransactionList } from "@/components/duely/invoice-parts"
import { EmptyState, ErrorState, PageHeader } from "@/components/duely/primitives"
import { useRepository, useSession, useTransactions } from "@/hooks/use-duely"

export default function ActivityPage() {
  const session = useSession()
  const txs = useTransactions(session.data?.role)
  const live = useRepository().mode === "api"

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Activity" title="Transaction history" description={live ? "On-chain payment activity visible to your wallet." : "Every simulated payment-related action visible to your role."} />
      <Alert>
        <History />
        <AlertTitle>{live ? "Not connected to the blockchain" : "Simulated transactions"}</AlertTitle>
        <AlertDescription>
          {live
            ? "Transaction history is read from the chain, which isn't connected yet, so nothing is listed. An empty list does not mean nothing happened on-chain."
            : "These entries come from the in-browser demo ledger, so none has a blockchain hash or explorer link. Pending becomes confirmed only after the simulated confirmation; failed means nothing moved."}
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
        <EmptyState icon={History} title={live ? "No transaction data available" : "No transactions yet"} description={live ? "Confirmed on-chain transactions will appear here once the blockchain integration is connected." : "Actions like funding escrow or paying an advance appear here."} />
      ) : (
        <TransactionList transactions={txs.data} showInvoice />
      )}
    </div>
  )
}
