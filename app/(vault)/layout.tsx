import Link from "next/link"

/**
 * Standalone layout for the Vault preview. It deliberately shares nothing with the client/freelancer app shell (no role switcher,
 * wallet sign-in gate, navigation or data provider state), so changes here cannot affect those pages and vice versa.
 */
export default function VaultLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b bg-background/90 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <span className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-navy text-sm font-bold text-mint" aria-hidden>
              D
            </span>
            <span className="text-base font-semibold tracking-tight">Duely</span>
          </span>
          <Link href="/" className="rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            Back to the app
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 md:py-8">{children}</main>
      <footer className="border-t">
        <div className="mx-auto max-w-6xl px-4 py-4 text-xs text-muted-foreground sm:px-6">Duely V2 vault · design preview · no live data</div>
      </footer>
    </div>
  )
}
