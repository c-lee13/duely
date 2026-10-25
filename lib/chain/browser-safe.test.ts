import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"

/**
 * Runs in its own process (node --test isolates files), so the secret below is in the
 * environment BEFORE any SDK module is imported.
 */
const SECRET_URL = "https://quiknode-secret.example/v2/TOP-SECRET-CREDENTIAL"
process.env.XRPL_EVM_RPC_URL = SECRET_URL
const SECRET = "TOP-SECRET-CREDENTIAL"

const here = new URL("./", import.meta.url)
const sources = readdirSync(here)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => [f, readFileSync(new URL(f, here), "utf8")] as const)

describe("browser-safe modules cannot expose server credentials", () => {
  it("only server.ts reads the authenticated RPC variable, and only server.ts imports server-only", () => {
    for (const [file, source] of sources) {
      const stripped = source.replace(/NEXT_PUBLIC_XRPL_EVM_RPC_URL/g, "")
      if (file === "server.ts") {
        assert.match(source, /^import "server-only"/m)
        assert.match(stripped, /process\.env\.XRPL_EVM_RPC_URL/)
      } else {
        assert.doesNotMatch(stripped, /process\.env\.XRPL_EVM_RPC_URL/, file)
        assert.doesNotMatch(source, /server-only/, file)
      }
    }
  })

  it("no browser-safe source or generated file holds keys, mnemonics or provider URLs", () => {
    const generated = readdirSync(new URL("./generated/", here)).map(
      (f) =>
        [
          `generated/${f}`,
          readFileSync(new URL(`./generated/${f}`, here), "utf8"),
        ] as const
    )
    for (const [file, source] of [...sources, ...generated]) {
      if (file === "server.ts") continue
      assert.doesNotMatch(source, /quiknode|alchemy|infura|ankr\.com/i, file)
      assert.doesNotMatch(source, /private[_ ]?key|mnemonic|seed phrase/i, file)
      const urls = source.match(/https?:\/\/[^\s"'`)]+/g) ?? []
      for (const url of urls) {
        assert.match(
          url,
          /^https:\/\/(rpc|explorer)\.testnet\.xrplevm\.org|^https:\/\/viem\.sh|^https?:\/\/localhost/,
          `${file}: ${url}`
        )
      }
    }
  })

  it("the browser-safe barrel does not re-export the server module", () => {
    const index = sources.find(([f]) => f === "index.ts")![1]
    assert.doesNotMatch(index, /["']\.\/server["']/)
  })

  it("with the secret in the environment, nothing exported by the barrel contains it", async () => {
    const sdk = await import("./index")
    const serialize = (value: unknown) =>
      JSON.stringify(value, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
      )
    for (const [name, value] of Object.entries(sdk)) {
      if (typeof value === "function") continue
      assert.ok(
        !serialize(value)?.includes(SECRET),
        `export ${name} leaks the secret`
      )
    }
    assert.equal(sdk.publicRpcUrl, "https://rpc.testnet.xrplevm.org")
    assert.ok(!serialize(sdk.xrplEvmTestnet).includes(SECRET))
    const publicClient = sdk.getPublicClient()
    assert.ok(
      !serialize(publicClient.transport as { url?: string }).includes(SECRET)
    )
    assert.equal(
      (publicClient.transport as { url?: string }).url,
      "https://rpc.testnet.xrplevm.org"
    )
  })

  it("a ChainWriteError built from a failure never contains the secret URL", async () => {
    const { ChainWriteError, ChainReadError, redactUrls } =
      await import("./errors")
    const text = redactUrls(
      `fetch failed ${SECRET_URL}?key=1 and wss://x.example/${SECRET}`
    )
    assert.ok(!text.includes(SECRET))
    assert.ok(
      new ChainWriteError("RPC_ERROR", text).message.indexOf(SECRET) === -1
    )
    assert.ok(
      new ChainReadError("RPC_ERROR", text).message.indexOf(SECRET) === -1
    )
  })
})
