import assert from "node:assert/strict"
import fs from "node:fs"
import { describe, it } from "node:test"
import { ChainWriteError, type ChainWriteErrorCode } from "@/lib/chain"
import { toTransactionRecord } from "@/lib/frontend/api-repository"
import { DomainError, type DomainErrorCode } from "@/lib/frontend/errors"
import type { TxLogEntry } from "@/lib/frontend/tx-log"
import { toDomainError } from "@/lib/frontend/tx-runner"

const read = (p: string) => fs.readFileSync(p, "utf8")

describe("every SDK write error maps to a specific UI error (exhaustive at compile time)", () => {
  // `Record<ChainWriteErrorCode, ...>` fails to compile when the SDK adds a code that is not mapped here.
  const expected: Record<ChainWriteErrorCode, DomainErrorCode> = {
    INVALID_INPUT: "INVALID_INPUT",
    WRONG_CHAIN: "WRONG_NETWORK",
    NO_ACCOUNT: "WALLET_NOT_CONNECTED",
    UNAUTHORIZED_SIGNER: "FORBIDDEN",
    INVOICE_NOT_FOUND: "NOT_FOUND",
    INSUFFICIENT_ALLOWANCE: "INSUFFICIENT_BALANCE",
    INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
    TOKEN_PAUSED: "TOKEN_PAUSED",
    DEPLOYMENT_MISMATCH: "INTEGRATION_UNAVAILABLE",
    SIMULATION_REVERTED: "TX_FAILED",
    USER_REJECTED: "USER_REJECTED",
    DUPLICATE_SUBMISSION: "DUPLICATE_REQUEST",
    RPC_ERROR: "INTEGRATION_UNAVAILABLE",
    SEND_FAILED: "TX_UNCONFIRMED",
    TX_REVERTED: "TX_FAILED",
    TX_REPLACED: "TX_FAILED",
    RECEIPT_MISMATCH: "TX_FAILED",
    WAIT_TIMEOUT: "TX_UNCONFIRMED",
  }

  it("maps each code, keeps the SDK's message, and never turns an unknown outcome into a plain failure", () => {
    for (const [code, ui] of Object.entries(expected) as [ChainWriteErrorCode, DomainErrorCode][]) {
      const e = toDomainError(new ChainWriteError(code, `message for ${code}`))
      assert.equal(e.code, ui, code)
      assert.equal(e.message, `message for ${code}`)
    }
    // "May have been broadcast" and "not confirmed in time" are the two outcomes that must never read as a failed attempt.
    assert.equal(expected.SEND_FAILED, "TX_UNCONFIRMED")
    assert.equal(expected.WAIT_TIMEOUT, "TX_UNCONFIRMED")
  })

  it("passes DomainErrors through unchanged and wraps anything else as TX_FAILED", () => {
    const d = new DomainError("WRONG_NETWORK", "x")
    assert.equal(toDomainError(d), d)
    assert.equal(toDomainError(new Error("boom")).code, "TX_FAILED")
    assert.equal(toDomainError("odd").code, "TX_FAILED")
  })
})

describe("a transaction is shown confirmed only when a verified receipt was recorded", () => {
  const entry = (status: TxLogEntry["status"]): TxLogEntry => ({
    hash: ("0x" + "ab".repeat(32)) as `0x${string}`,
    label: "Fund escrow",
    action: "fundInvoice",
    invoiceId: "1",
    from: ("0x" + "a".repeat(40)) as `0x${string}`,
    createdAt: 1_700_000_000_000,
    status,
    error: status === "failed" || status === "unknown" ? "why" : undefined,
    serialized: "{}",
  })

  it("awaiting_wallet, pending and unknown are all PENDING; only confirmed is confirmed; failed is failed", () => {
    assert.deepEqual(
      (["awaiting_wallet", "pending", "unknown", "confirmed", "failed"] as const).map((s) => toTransactionRecord(entry(s)).status),
      ["pending", "pending", "pending", "confirmed", "failed"]
    )
  })

  it("never marks a live transaction simulated, always carries its real hash, and keeps the warning on unknown ones", () => {
    const unknown = toTransactionRecord(entry("unknown"))
    assert.equal(unknown.simulated, false)
    assert.equal(unknown.txHash, entry("unknown").hash)
    assert.equal(unknown.error, "why")
    assert.equal(unknown.settledAt, undefined)
    assert.ok(toTransactionRecord(entry("confirmed")).settledAt)
  })
})

describe("live-mode wiring (source-level guarantees)", () => {
  it("the live repository never imports mock data and never falls back to it", () => {
    const src = read("lib/frontend/api-repository.ts")
    assert.doesNotMatch(src, /@\/lib\/mocks|MockDuelyRepository|fixtures/)
    assert.doesNotMatch(src, /NOT_IMPLEMENTED/, "every wallet workflow is implemented; none is stubbed")
  })

  it("only the chain SDK sends transactions: no raw writeContract/sendTransaction in the frontend", () => {
    for (const f of ["lib/frontend/api-repository.ts", "lib/frontend/tx-runner.ts", "lib/frontend/wallet-chain.ts", "lib/frontend/tx-log.ts"]) {
      assert.doesNotMatch(read(f), /\.writeContract\(|\.sendTransaction\(|\.sendRawTransaction\(|eth_sendTransaction/, f)
    }
  })

  it("no signing key or server secret is referenced anywhere the browser can reach", () => {
    const roots = ["app", "components", "hooks", "lib/frontend", "lib/auth/wallet-client.ts"]
    const bad: string[] = []
    const walk = (p: string) => {
      const st = fs.statSync(p)
      if (st.isDirectory()) {
        for (const e of fs.readdirSync(p)) walk(`${p}/${e}`)
      } else if (/\.(ts|tsx)$/.test(p) && /EVALUATOR_PRIVATE_KEY|OPERATOR_PRIVATE_KEY|CLIENT_PRIVATE_KEY|SUPABASE_SERVICE_ROLE|privateKeyToAccount|advance-signer/.test(read(p))) {
        bad.push(p)
      }
    }
    roots.forEach(walk)
    assert.deepEqual(bad, [])
  })

  it("the wallet is only prompted by an explicit click: the status bar reads state without prompting", () => {
    const src = read("components/duely/wallet-status.tsx")
    // connect / switchNetwork appear only inside click handlers
    assert.match(src, /onClick=\{\(\) => act\(wallet\.connect\)\}/)
    assert.match(src, /onClick=\{\(\) => act\(wallet\.switchNetwork\)\}/)
    assert.doesNotMatch(src.replace(/onClick=\{\(\) => act\(wallet\.(connect|switchNetwork)\)\}/g, ""), /wallet\.(connect|switchNetwork)\(/)
  })

  it("the old 'blockchain not connected' blockers are gone from the live pages", () => {
    const pages = ["app/(app)/client/invoices/new/page.tsx", "app/(app)/client/invoices/[id]/page.tsx", "app/(app)/platform/page.tsx", "components/duely/role-gate.tsx"]
    for (const f of pages) assert.doesNotMatch(read(f), /LiveCreateUnavailable|isn&apos;t available in live mode|aren&apos;t connected yet/, f)
  })

  it("success toasts in live mode never say 'simulated', and live pages show wallet progress", () => {
    for (const f of ["app/(app)/client/invoices/[id]/page.tsx", "app/(app)/client/invoices/new/page.tsx", "app/(app)/platform/page.tsx"]) {
      assert.match(read(f), /TxProgressPanel/, f)
    }
    assert.match(read("app/(app)/client/invoices/[id]/page.tsx"), /const sim = live \? "" : " \(simulated\)"/)
  })

  it("the dispute copy matches the contract in live mode: operator resolves, refund or release, advance never clawed back", () => {
    const client = read("app/(app)/client/invoices/[id]/page.tsx")
    assert.match(client, /operator now resolves it on-chain/)
    assert.match(client, /advance already paid is not clawed back/)
    const platform = read("app/(app)/platform/page.tsx")
    assert.match(platform, /NOT clawed back/)
    assert.match(platform, /whole .* escrow back/)
  })

  it("the activity list links real transaction hashes to the explorer and labels a pending one as not final", () => {
    const src = read("components/duely/invoice-parts.tsx")
    assert.match(src, /tryExplorerTxUrl\(t\.txHash\)/)
    assert.match(src, /Sent, not final yet/)
  })
})
