"use client"

import * as React from "react"
import Link from "next/link"
import type { VariantProps } from "class-variance-authority"
import {
  AlertOctagon,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  Copy,
  FileCheck2,
  FileClock,
  FileX2,
  FlaskConical,
  Inbox,
  Lock,
  RefreshCw,
  Rocket,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { OnchainInvoiceStatus, SubmissionStatus, TokenAmount, TxStatus } from "@/lib/frontend/domain"
import { formatToken, tokenDisplay } from "@/lib/frontend/token"
import { shortHash } from "@/lib/frontend/criteria-digest"

// ---- Links styled as buttons ------------------------------------------------

export function ButtonLink({
  href,
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<typeof Link> & VariantProps<typeof buttonVariants>) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant, size }), className)} {...props}>
      {children}
    </Link>
  )
}

// ---- Tone pill used by every status indicator -----------------------------------

type Tone = "neutral" | "info" | "advance" | "success" | "warning" | "danger"

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground ring-border",
  info: "bg-info/10 text-info-foreground ring-info/25",
  advance: "bg-advance/10 text-advance-foreground ring-advance/25",
  success: "bg-success/10 text-success-foreground ring-success/25",
  warning: "bg-warning/15 text-warning-foreground ring-warning/30",
  danger: "bg-destructive/10 text-destructive ring-destructive/25",
}

export function Pill({
  tone,
  icon: Icon,
  children,
  className,
  title,
}: {
  tone: Tone
  icon?: LucideIcon
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        TONE_CLASSES[tone],
        className
      )}
    >
      {Icon && <Icon className="size-3.5" aria-hidden />}
      {children}
    </span>
  )
}

const ONCHAIN: Record<OnchainInvoiceStatus, { tone: Tone; icon: LucideIcon; label: string; hint: string }> = {
  Created: { tone: "neutral", icon: CircleDashed, label: "Awaiting funding", hint: "Invoice created; escrow not funded yet" },
  Funded: { tone: "info", icon: Lock, label: "Funded in escrow", hint: "Full amount locked in escrow" },
  Advanced: { tone: "advance", icon: Rocket, label: "90% advanced", hint: "Reserve advanced 90%; awaiting client approval" },
  Disputed: { tone: "danger", icon: AlertOctagon, label: "Disputed · frozen", hint: "Settlement frozen pending manual resolution" },
  Settled: { tone: "success", icon: CheckCircle2, label: "Settled", hint: "Client approved; escrow paid out" },
  Cancelled: { tone: "neutral", icon: CircleDashed, label: "Cancelled", hint: "Cancelled by the client before funding" },
}

export function OnchainStatusBadge({ status, className }: { status: OnchainInvoiceStatus; className?: string }) {
  const s = ONCHAIN[status]
  return (
    <Pill tone={s.tone} icon={s.icon} className={className} title={`Simulated on-chain status: ${s.hint}`}>
      {s.label}
    </Pill>
  )
}

export function SubmissionStatusBadge({
  status,
  passed,
}: {
  status: SubmissionStatus
  passed?: boolean
}) {
  if (status === "NotSubmitted") return <Pill tone="neutral" icon={FileClock}>No evidence yet</Pill>
  if (status === "Submitted") return <Pill tone="warning" icon={Clock}>Awaiting evaluation</Pill>
  if (passed === undefined) return <Pill tone="info" icon={FileCheck2}>Evaluated</Pill>
  return passed ? (
    <Pill tone="success" icon={FileCheck2}>AI pass</Pill>
  ) : (
    <Pill tone="danger" icon={FileX2}>AI didn&apos;t pass</Pill>
  )
}

export function TxStatusBadge({ status }: { status: TxStatus }) {
  if (status === "pending")
    return (
      <Pill tone="warning" icon={RefreshCw} className="[&>svg]:animate-spin">
        Pending
      </Pill>
    )
  if (status === "failed") return <Pill tone="danger" icon={XCircle}>Failed</Pill>
  return <Pill tone="success" icon={CheckCircle2}>Confirmed</Pill>
}

export function SimulatedTag({ children = "Simulated", className }: { children?: React.ReactNode; className?: string }) {
  return (
    <Pill tone="warning" icon={FlaskConical} className={className}>
      {children}
    </Pill>
  )
}

// ---- Money and identity ------------------------------------------------------

export function Amount({
  value,
  className,
  maxFraction,
  hideSymbol,
}: {
  value: TokenAmount
  className?: string
  maxFraction?: number
  hideSymbol?: boolean
}) {
  return (
    <span className={cn("font-medium tabular-nums", className)} title={`${value} base units`}>
      {formatToken(value, { maxFraction, symbol: false })}
      {!hideSymbol && <span className="ml-1 text-[0.8em] font-normal text-muted-foreground">{tokenDisplay().symbol}</span>}
    </span>
  )
}

export function AddressChip({ address, label, className }: { address: string; label?: string; className?: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {label && <span className="truncate">{label}</span>}
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(address).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            },
            () => {}
          )
        }}
        className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-label={`Copy address ${address}`}
        title={address}
      >
        {shortHash(address, 4)}
        <Copy className="size-3" aria-hidden />
        <span className="sr-only" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </button>
    </span>
  )
}

// ---- Layout + states -------------------------------------------------------------

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        {eyebrow && <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center">
      <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorState({
  title = "Couldn't load this",
  message,
  onRetry,
  action,
}: {
  title?: string
  message: string
  onRetry?: () => void
  action?: React.ReactNode
}) {
  return (
    <div role="alert" className="flex flex-col items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center">
      <Ban className="size-6 text-destructive" aria-hidden />
      <p className="font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <div className="mt-2 flex gap-2">
        {onRetry && (
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw /> Try again
          </Button>
        )}
        {action}
      </div>
    </div>
  )
}

export function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  )
}

export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "neutral",
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon: LucideIcon
  tone?: Tone
}) {
  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        <span className={cn("flex size-8 items-center justify-center rounded-lg ring-1 ring-inset", TONE_CLASSES[tone])}>
          <Icon className="size-4" aria-hidden />
        </span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function formatDate(iso: string, withTime = false) {
  const d = new Date(iso)
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  })
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
