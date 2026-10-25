import { activeDeployment } from "@/lib/chain/config"
import type { Address, Bytes32, UiTxAction } from "./domain"

/**
 * This browser's record of the wallet transactions it submitted: label, hash, status. It exists so the UI can show a
 * transaction as PENDING straight after the wallet returns a hash, survive a page reload, and resume tracking.
 *
 * It is a convenience cache, never evidence: a row says `confirmed` only because the chain SDK verified a receipt and
 * the expected event (the runner writes the status), and every row is scoped to the active deployment, so a dUSD
 * transaction can never show up under RLUSD. Losing it loses history, not money.
 */
export type TxLogStatus = "awaiting_wallet" | "pending" | "confirmed" | "failed" | "unknown"

export interface TxLogEntry {
  /** Transaction hash, once the wallet returned one. */
  hash: Bytes32
  label: string
  action: UiTxAction
  invoiceId?: string
  from: Address
  createdAt: number
  status: TxLogStatus
  blockNumber?: string
  error?: string
  explorerUrl?: string
  /** `serializeSubmittedTransaction` output, so tracking can resume after a reload. */
  serialized: string
  /** Anything needed to finish a multi-step flow after a reload (for example the invoice registration payload). */
  meta?: Record<string, unknown>
}

type StorageLike = Pick<Storage, "getItem" | "setItem">
const MAX_ENTRIES = 200

export class TxLog {
  constructor(
    private readonly storage: StorageLike | null,
    private readonly deploymentKey: () => string = () => activeDeployment().key
  ) {}

  private key() {
    return `duely.txlog.v1:${this.deploymentKey()}`
  }

  private read(): TxLogEntry[] {
    try {
      const raw = this.storage?.getItem(this.key())
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? (parsed as TxLogEntry[]).filter((e) => e && typeof e.hash === "string" && typeof e.from === "string") : []
    } catch {
      return []
    }
  }

  private write(entries: TxLogEntry[]) {
    try {
      this.storage?.setItem(this.key(), JSON.stringify(entries.slice(0, MAX_ENTRIES)))
    } catch {
      /* storage full or blocked: history is a convenience */
    }
  }

  /** Newest first. With `account`, only that wallet's transactions. */
  list(account?: string): TxLogEntry[] {
    const all = this.read().sort((a, b) => b.createdAt - a.createdAt)
    return account ? all.filter((e) => e.from.toLowerCase() === account.toLowerCase()) : all
  }

  find(hash: string): TxLogEntry | undefined {
    return this.read().find((e) => e.hash.toLowerCase() === hash.toLowerCase())
  }

  add(entry: TxLogEntry): void {
    this.write([entry, ...this.read().filter((e) => e.hash.toLowerCase() !== entry.hash.toLowerCase())])
  }

  update(hash: string, patch: Partial<Pick<TxLogEntry, "status" | "blockNumber" | "error" | "meta" | "invoiceId">>): void {
    this.write(this.read().map((e) => (e.hash.toLowerCase() === hash.toLowerCase() ? { ...e, ...patch } : e)))
  }
}

export function browserTxLog(): TxLog {
  try {
    return new TxLog(typeof localStorage === "undefined" ? null : localStorage)
  } catch {
    return new TxLog(null)
  }
}
