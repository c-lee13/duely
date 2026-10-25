"use client"

import * as React from "react"
import { PrivyProvider } from "@privy-io/react-auth"
import { PRIVY_APP_ID, isPrivyConfigured, privyXrplEvmTestnet } from "@/lib/privy/config"
import { PrivyWalletBridge } from "./privy-bridge"

/**
 * Wraps the app in a configured Privy provider when NEXT_PUBLIC_PRIVY_APP_ID is set.
 * If the env var is missing, this is a no-op so the existing MetaMask flow keeps working
 * for local-only development (e.g., unit tests, environments without a Privy app).
 */
export function PrivyAppProvider({ children }: { children: React.ReactNode }) {
  if (!isPrivyConfigured()) return <>{children}</>

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: "light",
          accentColor: "#0F172A",
          logo: undefined,
          walletChainType: "ethereum-only",
          showWalletLoginFirst: false,
        },
        loginMethods: ["email", "wallet"],
        defaultChain: privyXrplEvmTestnet,
        supportedChains: [privyXrplEvmTestnet],
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
        },
      }}
    >
      <PrivyWalletBridge>{children}</PrivyWalletBridge>
    </PrivyProvider>
  )
}
