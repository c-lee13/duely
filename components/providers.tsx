"use client"

import * as React from "react"
import { DuelyProvider } from "@/hooks/use-duely"
import { ToastProvider } from "@/components/duely/toast"
import { TooltipProvider } from "@/components/ui/tooltip"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <DuelyProvider>
      <TooltipProvider>
        <ToastProvider>{children}</ToastProvider>
      </TooltipProvider>
    </DuelyProvider>
  )
}
