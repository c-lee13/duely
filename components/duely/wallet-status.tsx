"use client"

import * as React from "react"
import { AlertTriangle, CheckCircle2, Wallet } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useRepository } from "@/hooks/use-duely"
import { explorerAddressUrl } from "@/lib/chain/config"
import { errorMessage } from "@/lib/frontend/errors"
import type { WalletState } from "@/lib/frontend/wallet-chain"

/**
 * Live mode only: which MetaMask account is active, which network it is on, and which deployment (token) the app will
 * transact with. It reads the wallet without prompting; connecting and switching network are explicit buttons. Every
 * transaction re-checks all of this itself, so this bar is information and convenience, never the safeguard.
 */
export function WalletStatusBar() {
  const repo = useRepository()
  const [state, setState] = React.useState<WalletState | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const wallet = repo.wallet

  const refresh = React.useCallback(() => {
    wallet
      ?.getState()
      .then((s) => {
        setState(s)
        setError(null)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [wallet])

  React.useEffect(() => {
    refresh()
    return wallet?.subscribe(refresh)
  }, [wallet, refresh])

  if (!wallet) return null

  async function act(fn: () => Promise<WalletState>) {
    setBusy(true)
    try {
      setState(await fn())
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
  const dep = state?.deployment
  let body: React.ReactNode
  if (!state) body = <span className="text-muted-foreground">Checking your wallet…</span>
  else if (!state.available) body = <span>No browser wallet found. Install MetaMask to send transactions.</span>
  else if (!state.account)
    body = (
      <>
        <span>MetaMask isn&apos;t connected to this site.</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act(wallet.connect)}>
          <Wallet /> Connect MetaMask
        </Button>
      </>
    )
  else if (state.chainId !== state.expectedChainId)
    body = (
      <>
        <span>
          Wrong network (chain {state.chainId ?? "?"}). Transactions need XRPL EVM Testnet ({state.expectedChainId}).
        </span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act(wallet.switchNetwork)}>
          Switch network
        </Button>
      </>
    )
  else
    body = (
      <>
        <CheckCircle2 className="size-3.5 text-success" aria-hidden />
        <a className="font-mono underline" href={explorerAddressUrl(state.account)} target="_blank" rel="noreferrer">
          {short(state.account)}
        </a>
        <span>on XRPL EVM Testnet</span>
      </>
    )

  const problem = !!state && (!state.available || !state.account || state.chainId !== state.expectedChainId)
  return (
    <div className={`border-b text-xs ${problem ? "border-warning/30 bg-warning/10" : "bg-muted/40"}`} role="status" aria-label="Wallet status">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5 sm:px-6">
        {problem && <AlertTriangle className="size-3.5 shrink-0" aria-hidden />}
        {body}
        {dep && (
          <span className="ml-auto text-muted-foreground">
            Deployment: <strong>{dep.symbol}</strong> · {dep.decimals} decimals{dep.isDemoToken ? " · demo token" : ""}
          </span>
        )}
        {error && <span className="basis-full text-destructive">{error}</span>}
      </div>
    </div>
  )
}
