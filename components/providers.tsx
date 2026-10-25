"use client"

import * as React from "react"
import { DuelyProvider } from "@/hooks/use-duely"
import { ToastProvider } from "@/components/duely/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PrivyAppProvider } from "@/components/duely/privy-provider"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyAppProvider>
      <DuelyProvider>
        <TooltipProvider>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </DuelyProvider>
    </PrivyAppProvider>
  )
}
