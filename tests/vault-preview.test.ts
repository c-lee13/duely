import { before, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { execFileSync } from "node:child_process"

describe("Vault preview page", () => {
  let html: string
  before(() => {
    // Without the react-server condition (client components need real React hooks), as in the other UI tests.
    html = execFileSync(process.execPath, ["--import", "tsx", "tests/helpers/render-vault-child.ts"], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8" })
  })

  it("is clearly a V2 preview that is not connected to the chain", () => {
    assert.match(html, /V2 preview/)
    assert.match(html, /Not connected to the blockchain/)
    assert.match(html, /reads no contracts and sends no transactions/)
    assert.match(html, /not live data/)
    assert.equal((html.match(/<h1/g) ?? []).length, 1)
  })

  it("shows all six overview metrics with labelled placeholders and no numbers", () => {
    for (const label of ["Total Vault Assets (NAV)", "Available Liquidity", "Outstanding Principal", "Utilization", "Total Fees Earned", "Realized Losses"]) {
      assert.ok(html.includes(label), label)
      assert.ok(html.includes(`aria-label="${label}: placeholder, no data yet"`), label)
    }
    const figures = [...html.matchAll(/placeholder, no data yet"[^>]*>([^<]*)</g)].map((m) => m[1])
    assert.ok(figures.length >= 9)
    assert.ok(figures.every((f) => f === "—"), figures.join("|"))
  })

  it("has a Your position section with shares, estimated value and withdrawable amount", () => {
    assert.match(html, /Your position/)
    for (const t of ["dvRLUSD shares", "Estimated RLUSD value", "Currently withdrawable RLUSD"]) assert.ok(html.includes(t), t)
    assert.match(html, /Never more than the vault(&#x27;|')s available liquidity/)
  })

  it("has Deposit and Withdraw sections whose controls are disabled and not forms", () => {
    assert.match(html, /Deposit/)
    assert.match(html, /Withdraw/)
    assert.ok(!/<form/.test(html), "no form that could submit")
    const inputs = html.match(/<input[^>]*>/g) ?? []
    assert.equal(inputs.length, 2)
    assert.ok(inputs.every((i) => /disabled/.test(i)))
    const buttons = html.match(/<button[^>]*>/g) ?? []
    assert.ok(buttons.length >= 2 && buttons.every((b) => /disabled/.test(b) && /type="button"/.test(b)))
    assert.match(html, /sends no transaction/)
  })

  it("carries a risk disclosure: no guarantees, loss sharing, liquidity-dependent withdrawals", () => {
    assert.match(html, /Risk disclosure/)
    assert.match(html, /not guaranteed/)
    assert.match(html, /Withdrawals depend on available liquidity/)
    assert.match(html, /lose some or all/)
    assert.equal((html.match(/<li>/g) ?? []).length, 5)
  })

  it("makes no promises of yield, safety or live status", () => {
    const visible = html.replace(/<[^>]+>/g, " ")
    assert.ok(!/\b\d+(\.\d+)?\s?%\s?(APY|APR|yield|return)|guaranteed (yield|return|income)|risk[- ]free|safe(ly)? (deposit|yield)|earn up to|live (data|balance)s?\b/i.test(visible.replace(/not live data/g, "")))
  })
})

describe("Vault is independent of the client and freelancer app (source checks)", () => {
  const read = (p: string) => fs.readFileSync(p, "utf8")
  const vaultFiles = ["components/duely/vault-preview.tsx", "app/(vault)/layout.tsx", "app/(vault)/vault/page.tsx"]

  it("has its own route group and layout, outside the app shell", () => {
    for (const f of vaultFiles) assert.ok(fs.existsSync(f), f)
    assert.ok(!fs.existsSync("app/(app)/vault"), "not inside the (app) shell")
    assert.ok(!/vault/i.test(read("components/duely/app-shell.tsx")), "no vault entry in the shared navigation")
  })

  it("imports nothing from the app shell, repository, wallet, chain, API or backend", () => {
    for (const f of vaultFiles) {
      const src = read(f)
      assert.ok(!/app-shell|role-gate|live-auth|use-duely|useRepository|useSession|@\/lib\/(chain|backend|ai|supabase|frontend)|viem|wagmi|fetch\(|writeContract|process\.env/.test(src), f)
    }
  })

  it("only shared UI building blocks are imported", () => {
    const imports = [...read("components/duely/vault-preview.tsx").matchAll(/from "(@\/[^"]+)"/g)].map((m) => m[1])
    assert.ok(imports.every((i) => i.startsWith("@/components/ui/") || i === "@/components/duely/primitives"), imports.join(", "))
  })
})
