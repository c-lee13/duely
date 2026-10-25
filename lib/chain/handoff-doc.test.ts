import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const doc = readFileSync(
  new URL("../../docs/CHAIN_SDK_HANDOFF.md", import.meta.url),
  "utf8"
)

function section(from: string, to: string): string {
  const a = doc.indexOf(from)
  const b = doc.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `${from} .. ${to}`)
  return doc.slice(a, b)
}

describe("docs/CHAIN_SDK_HANDOFF.md matches the code", () => {
  it("every identifier in the exports table is really exported (and nothing private is advertised)", async () => {
    const sdk = (await import("./index")) as Record<string, unknown>
    const server = await import("node:fs").then(() =>
      readFileSync(new URL("./server.ts", import.meta.url), "utf8")
    )
    const table = section("## What is exported", "## Environment variables")
    const names = new Set<string>()
    for (const [, token] of table.matchAll(
      /`([A-Za-z_][A-Za-z0-9_]*)(?:\([^`]*\))?`/g
    ))
      names.add(token)
    // Not SDK identifiers: words used in prose inside backticks.
    for (const prose of ["null", "as", "const"]) names.delete(prose)
    assert.ok(names.size > 50, `parsed only ${names.size} names`)
    const missing = [...names].filter((n) => !(n in sdk))
    assert.deepEqual(missing, [])
    for (const privateName of [
      "releaseByHash",
      "mapWriteError",
      "expectedFor",
    ]) {
      assert.ok(!names.has(privateName))
    }
    assert.match(server, /export function getServerPublicClient/)
    assert.match(server, /export function createServerWalletClient/)
  })

  it("the authorization table agrees with WRITE_REQUIREMENTS", async () => {
    const { WRITE_REQUIREMENTS } = await import("./index")
    const table = section("## Who may call what", "## Backend operations")
    const expectations: Record<string, string> = {
      createInvoice: "client",
      cancelInvoice: "client",
      fundInvoice: "client",
      approveCompletion: "client",
      raiseDispute: "client",
      approveAdvance: "evaluator",
      depositReserve: "operator",
      withdrawReserve: "operator",
      resolveDispute: "operator",
    }
    for (const [fn, role] of Object.entries(expectations)) {
      assert.equal(
        WRITE_REQUIREMENTS[fn as keyof typeof WRITE_REQUIREMENTS],
        role,
        fn
      )
      const row = table.split("\n").find((l) => l.includes(`\`${fn}\``))
      assert.ok(row, `doc has no row for ${fn}`)
      assert.match(row!, new RegExp(role, "i"), `${fn} should mention ${role}`)
    }
  })

  it("every env var named in the environment table appears in .env.example (or is documented as server-defined)", () => {
    const table = section(
      "## Environment variables",
      "The live integration script"
    )
    const example = readFileSync(
      new URL("../../.env.example", import.meta.url),
      "utf8"
    )
    for (const [, name] of table.matchAll(
      /`((?:NEXT_PUBLIC_)?[A-Z][A-Z0-9_]{4,})`/g
    )) {
      assert.ok(
        example.includes(`${name}=`),
        `${name} is documented but missing from .env.example`
      )
    }
  })

  it("the example code names functions that exist", async () => {
    const sdk = (await import("./index")) as Record<string, unknown>
    const code = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)]
      .map((m) => m[1])
      .join("\n")
    const imported = new Set<string>()
    for (const [, list] of code.matchAll(
      /import \{([^}]*)\} from "@\/lib\/chain"/g
    )) {
      for (const n of list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean))
        imported.add(n)
    }
    assert.ok(imported.size >= 18, `only ${imported.size} imports found`)
    assert.deepEqual(
      [...imported].filter((n) => !(n in sdk)),
      []
    )
  })
})
