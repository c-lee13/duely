"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  Briefcase,
  Building2,
  FileText,
  FlaskConical,
  History,
  Landmark,
  LayoutDashboard,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  UserRound,
  Wallet,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { useBalances, useRepository, useSession } from "@/hooks/use-duely"
import type { DemoRole } from "@/lib/frontend/domain"
import { tokenNotice } from "@/lib/frontend/token"
import type { DemoControls } from "@/lib/frontend/repository"
import { Amount, AddressChip } from "./primitives"
import { LiveAuthGate } from "./live-auth"
import { WalletStatusBar } from "./wallet-status"
import { useToast } from "./toast"

export const ROLE_HOME: Record<DemoRole, string> = {
  client: "/client",
  freelancer: "/freelancer",
  platform: "/platform",
}

const ROLE_META: Record<DemoRole, { label: string; icon: typeof Building2 }> = {
  client: { label: "Client", icon: Building2 },
  freelancer: { label: "Freelancer", icon: Briefcase },
  platform: { label: "Platform", icon: Landmark },
}

const NAV: Record<DemoRole, Array<{ href: string; label: string }>> = {
  client: [
    { href: "/client", label: "Invoices" },
    { href: "/client/invoices/new", label: "New invoice" },
    { href: "/activity", label: "Activity" },
    { href: "/profile", label: "Profile" },
  ],
  freelancer: [
    { href: "/freelancer", label: "My work" },
    { href: "/activity", label: "Activity" },
    { href: "/profile", label: "Profile" },
  ],
  platform: [
    { href: "/platform", label: "Reserve" },
    { href: "/activity", label: "Activity" },
    { href: "/profile", label: "Profile" },
  ],
}

function isActive(pathname: string, href: string) {
  if (href === "/client" || href === "/freelancer") {
    return pathname === href || (pathname.startsWith(`${href}/invoices/`) && !pathname.endsWith("/new"))
  }
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * Brand mark. PLACEHOLDER: public/branding/ has no logo files yet.
 * When the real Duely logo is added, replace the <span> mark below with
 * <Image src="/branding/<file>" alt="" width height /> — this is the only place it appears.
 */
export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <span className="flex size-7 items-center justify-center rounded-lg bg-navy text-sm font-bold text-mint">
        D
      </span>
      <span className="text-base font-semibold tracking-tight">Duely</span>
    </Link>
  )
}

export function useSwitchRole() {
  const repo = useRepository()
  const router = useRouter()
  return React.useCallback(
    (role: DemoRole, navigate = true) => {
      repo.demo?.switchRole(role)
      repo.live?.setViewRole(role)
      if (navigate) router.push(ROLE_HOME[role])
    },
    [repo, router]
  )
}

export function RoleSwitcher({ current, roles }: { current: DemoRole; roles?: DemoRole[] }) {
  const switchRole = useSwitchRole()
  return (
    <div role="radiogroup" aria-label={roles ? "View" : "Demo role"} className="inline-flex rounded-lg bg-muted p-0.5">
      {(roles ?? (Object.keys(ROLE_META) as DemoRole[])).map((role) => {
        const { label, icon: Icon } = ROLE_META[role]
        const active = role === current
        return (
          <button
            key={role}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => switchRole(role)}
            className={cn(
              "inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors md:h-7 md:min-w-0 md:px-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="size-4 md:size-3.5" aria-hidden />
            <span className="sr-only sm:not-sr-only">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

function WalletChip() {
  const repo = useRepository()
  const session = useSession()
  const live = repo.mode === "api"
  const balances = useBalances(session.data && !live ? `${session.data.role}` : undefined)
  if (!session.data) return live ? null : <Skeleton className="h-8 w-40" />
  return (
    <div className="hidden items-center gap-2 rounded-lg border bg-card px-2.5 py-1 text-xs md:flex">
      <Wallet className="size-3.5 text-muted-foreground" aria-hidden />
      <div className="flex flex-col leading-tight">
        <span className="flex items-center gap-1">
          {!live && <span className="font-medium">{session.data.displayName}</span>}
          <AddressChip address={session.data.wallet} />
        </span>
        <span className="text-muted-foreground">
          {live ? (
            "verified wallet"
          ) : (
            <>
              {balances.data ? <Amount value={balances.data.walletBalance} className="font-normal" /> : "…"} · simulated wallet
            </>
          )}
        </span>
      </div>
    </div>
  )
}

export function DemoControlsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const repo = useRepository()
  if (!repo.demo) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DemoControlsBody demo={repo.demo} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function DemoControlsBody({ demo, onClose }: { demo: DemoControls; onClose: () => void }) {
  const toast = useToast()
  const router = useRouter()
  // Mounted only while the dialog is open, so this reads fresh settings each time.
  const [failNext, setFailNext] = React.useState(() => demo.getSettings().failNextTransaction)

  return (
    <>
      <DialogHeader>
        <DialogTitle>Demo controls</DialogTitle>
        <DialogDescription>
          Everything here is simulated in your browser. No wallet, blockchain, database or AI service is used, and DEMO
          tokens have no value.
        </DialogDescription>
      </DialogHeader>

      <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[var(--primary)]"
          checked={failNext}
          onChange={(e) => {
            setFailNext(e.target.checked)
            demo.setFailNextTransaction(e.target.checked)
          }}
        />
        <span className="text-sm">
          <span className="font-medium">Fail the next simulated transaction</span>
          <span className="block text-muted-foreground">
            Use this to show what happens when a transaction reverts: it shows as failed and no balances change.
          </span>
        </span>
      </label>

      <div className="rounded-lg border p-3 text-sm">
        <p className="font-medium">Reset demo data</p>
        <p className="text-muted-foreground">
          Restores the original invoices, balances and reserve. Clears anything you created.
        </p>
        <Button
          variant="destructive"
          className="mt-3"
          onClick={() => {
            demo.reset()
            onClose()
            toast({ tone: "success", title: "Demo reset", description: "All mock data was restored to its starting state." })
            router.push("/")
          }}
        >
          <RotateCcw /> Reset demo
        </Button>
      </div>

      <DialogFooter showCloseButton />
    </>
  )
}

function DemoBanner({ onOpenControls }: { onOpenControls: () => void }) {
  const repo = useRepository()
  if (repo.mode === "api") return <LiveBanner />
  if (repo.mode !== "mock") return null
  return (
    <div className="border-b border-warning/30 bg-warning/10 text-warning-foreground">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-1.5 text-xs sm:px-6">
        <FlaskConical className="size-3.5 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          <span className="font-semibold">Demo mode.</span>{" "}
          <span className="hidden sm:inline">
            All wallets, transactions and AI evaluations are simulated in your browser. DEMO tokens are not real money
            and nothing touches a blockchain.
          </span>
          <span className="sm:hidden">Simulated data · DEMO tokens have no value.</span>
        </p>
        <button
          type="button"
          onClick={onOpenControls}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1.5 font-medium sm:py-0.5 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Settings2 className="size-3.5" aria-hidden /> Demo controls
        </button>
      </div>
    </div>
  )
}

function LiveBanner() {
  const repo = useRepository()
  const [busy, setBusy] = React.useState(false)
  return (
    <div className="border-b border-primary/20 bg-primary/5 text-foreground">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-1.5 text-xs sm:px-6">
        <ShieldCheck className="size-3.5 shrink-0 text-primary" aria-hidden />
        <p className="min-w-0 flex-1">
          <span className="font-semibold">Live.</span>{" "}
          <span className="hidden sm:inline">
            Invoices, evidence and evaluations are stored in Supabase; escrow, payments and balances are read from the blockchain.
            A payment counts only once its transaction is confirmed on-chain.
          </span>
          <span className="sm:hidden">Supabase + on-chain · paid only when confirmed.</span>
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await repo.live?.signOut()
            } finally {
              setBusy(false)
            }
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1.5 font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:py-0.5"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

/** Mobile tab bar. Dashboard/Invoices map onto the existing role home and its invoice list. */
function bottomTabs(role: DemoRole) {
  const home = ROLE_HOME[role]
  return [
    { key: "dashboard", href: home, label: "Dashboard", icon: LayoutDashboard },
    { key: "invoices", href: `${home}#invoices`, label: "Invoices", icon: FileText },
    { key: "activity", href: "/activity", label: "Activity", icon: History },
    { key: "profile", href: "/profile", label: "Profile", icon: UserRound },
  ] as const
}

function activeTab(pathname: string, role: DemoRole, hash: string): string | null {
  const home = ROLE_HOME[role]
  if (pathname === home) return hash === "#invoices" ? "invoices" : "dashboard"
  if (pathname.startsWith(`${home}/invoices`)) return "invoices"
  if (pathname.startsWith("/activity")) return "activity"
  if (pathname.startsWith("/profile")) return "profile"
  return null
}

function BottomNav({ role, pathname }: { role: DemoRole; pathname: string }) {
  // Next's hash navigation uses pushState (no hashchange event), so remember the tapped hash with its path;
  // it stops applying as soon as the route changes.
  const [tapped, setTapped] = React.useState({ path: "", hash: "" })
  const setHash = (href: string) => {
    const [path, hash = ""] = href.split("#")
    setTapped({ path, hash: hash ? `#${hash}` : "" })
  }
  const current = activeTab(pathname, role, tapped.path === pathname ? tapped.hash : "")
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] shadow-[0_-4px_16px_-8px_rgb(6_21_47/0.12)] backdrop-blur supports-backdrop-filter:bg-card/85 md:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-4">
        {bottomTabs(role).map(({ key, href, label, icon: Icon }) => {
          const active = current === key
          return (
            <li key={key}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                onClick={() => setHash(href)}
                className={cn(
                  "relative flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
                  active ? "text-primary" : "text-muted-foreground active:text-foreground"
                )}
              >
                {active && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-primary" aria-hidden />}
                <Icon className={cn("size-6", active && "stroke-[2.25]")} aria-hidden />
                {label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const session = useSession()
  const [controlsOpen, setControlsOpen] = React.useState(false)
  const role = session.data?.role
  const repo = useRepository()

  return (
    // Bottom padding reserves room for the fixed tab bar (mobile) so content and the footer are never covered.
    <div className="flex min-h-svh flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
      <DemoBanner onOpenControls={() => setControlsOpen(true)} />
      {repo.mode === "api" && <WalletStatusBar />}
      <header className="sticky top-0 z-40 border-b bg-background/90 pt-[env(safe-area-inset-top)] backdrop-blur supports-backdrop-filter:bg-background/75">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Logo />
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {role
              ? NAV[role].map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive(pathname, item.href) ? "page" : undefined}
                    className={cn(
                      "rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      "aria-[current=page]:bg-accent aria-[current=page]:text-primary"
                    )}
                  >
                    {item.label}
                  </Link>
                ))
              : null}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {role === "client" && (
              <Link
                href="/client/invoices/new"
                aria-label="New invoice"
                className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:hidden"
              >
                <Plus className="size-5" aria-hidden />
              </Link>
            )}
            <WalletChip />
            {role && repo.demo ? (
              <RoleSwitcher current={role} />
            ) : role && repo.live ? (
              <RoleSwitcher current={role} roles={["client", "freelancer", "platform"]} />
            ) : repo.mode === "api" ? null : (
              <Skeleton className="h-9 w-28 md:h-8" />
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 md:py-8">
        {repo.mode === "api" ? <LiveAuthGate>{children}</LiveAuthGate> : children}
      </main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:px-6">
          <span>Duely · XRPL EVM hackathon MVP · escrow-backed early payment</span>
          <span>{tokenNotice()}</span>
        </div>
      </footer>
      {role && <BottomNav role={role} pathname={pathname} />}
      <DemoControlsDialog open={controlsOpen} onOpenChange={setControlsOpen} />
    </div>
  )
}
