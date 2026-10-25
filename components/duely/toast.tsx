"use client"

import * as React from "react"
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

type ToastTone = "success" | "error" | "info" | "warning"
interface ToastItem {
  id: number
  tone: ToastTone
  title: string
  description?: string
}

const ToastContext = React.createContext<(t: Omit<ToastItem, "id">) => void>(() => {})

export function useToast() {
  return React.useContext(ToastContext)
}

const ICONS = { success: CheckCircle2, error: XCircle, info: Info, warning: TriangleAlert }
const TONES: Record<ToastTone, string> = {
  success: "text-success",
  error: "text-destructive",
  info: "text-info",
  warning: "text-warning-foreground",
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([])
  const idRef = React.useRef(0)

  const dismiss = React.useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), [])
  const push = React.useCallback(
    (t: Omit<ToastItem, "id">) => {
      const id = ++idRef.current
      setItems((xs) => [...xs.slice(-3), { ...t, id }])
      setTimeout(() => dismiss(id), t.tone === "error" ? 8000 : 5000)
    },
    [dismiss]
  )

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] md:bottom-4 flex flex-col items-end gap-2 sm:left-auto sm:w-96"
      >
        {items.map((t) => {
          const Icon = ICONS[t.tone]
          return (
            <div
              key={t.id}
              className="pointer-events-auto flex w-full items-start gap-3 rounded-xl border bg-popover p-3 text-sm text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2"
            >
              <Icon className={cn("mt-0.5 size-4 shrink-0", TONES[t.tone])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t.title}</p>
                {t.description && <p className="mt-0.5 text-muted-foreground">{t.description}</p>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="rounded-md p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label="Dismiss notification"
              >
                <X className="size-4" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
