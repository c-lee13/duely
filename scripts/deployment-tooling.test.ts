import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { childEnv } from "../lib/chain/test/child-env"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const DUSD_MANIFEST = "contracts/deployments/xrpl-evm-testnet.json"

function sha256(path: string): string {
  return createHash("sha256")
    .update(readFileSync(root + path))
    .digest("hex")
}

describe("deployment tooling", () => {
  it("generated chain artifacts are up to date (dUSD + registry + ABI)", () => {
    const r = spawnSync(
      process.execPath,
      ["contracts/script/export-abi.mjs", "--check", "--no-build"],
      { cwd: root, encoding: "utf8" }
    )
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /up to date/)
  })

  it("write_manifest.py refuses to overwrite the existing dUSD manifest", () => {
    const before = sha256(DUSD_MANIFEST)
    const r = spawnSync(
      "python3",
      ["-I", "contracts/script/write_manifest.py", "1449000"],
      { cwd: root, encoding: "utf8" }
    )
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /already exists; refusing to overwrite/)
    assert.equal(sha256(DUSD_MANIFEST), before)
  })

  it("write_manifest.py rejects an unknown --token-key", () => {
    const r = spawnSync(
      "python3",
      [
        "-I",
        "contracts/script/write_manifest.py",
        "1449000",
        "--token-key",
        "usdc",
      ],
      { cwd: root, encoding: "utf8" }
    )
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /unknown --token-key/)
  })

  it("Deploy.s.sol avoids address(this): `forge script` rejects it, but `forge test` does not notice", () => {
    const src = readFileSync(
      root + "contracts/script/Deploy.s.sol",
      "utf8"
    ).replace(/\/\/.*$/gm, "")
    assert.doesNotMatch(src, /address\(this\)/)
  })

  it("the RLUSD readiness script is strictly read-only", () => {
    const src = readFileSync(root + "scripts/rlusd-readiness.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
    assert.doesNotMatch(
      src,
      /writeContract|sendTransaction|sendRawTransaction|createWalletClient|functionName:\s*"(approve|transfer|transferFrom|mint|depositReserve)"/
    )
    assert.doesNotMatch(src, /keystore|password|decrypt/i)
  })

  it("tsconfig restricts ambient types, so stray @types stubs in ancestor directories cannot break the build (TS2688)", () => {
    // tsconfig.json is JSONC (it carries comments), so strip whole-line comments before parsing.
    const jsonc = readFileSync(root + "tsconfig.json", "utf8").replace(
      /^\s*\/\/.*$/gm,
      ""
    )
    const tsconfig = JSON.parse(jsonc) as {
      compilerOptions: { types?: string[] }
    }
    assert.deepEqual(tsconfig.compilerOptions.types, ["node"])
  })

  it("package-lock.json is in sync with package.json (every direct dependency is locked at a satisfying version)", () => {
    const pkg = JSON.parse(readFileSync(root + "package.json", "utf8")) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    const lock = JSON.parse(
      readFileSync(root + "package-lock.json", "utf8")
    ) as {
      packages: Record<
        string,
        {
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
          version?: string
        }
      >
    }
    const rootEntry = lock.packages[""]
    assert.deepEqual(
      rootEntry.dependencies,
      pkg.dependencies,
      "lock root dependencies == package.json dependencies"
    )
    assert.deepEqual(
      rootEntry.devDependencies,
      pkg.devDependencies,
      "lock root devDependencies == package.json devDependencies"
    )
    for (const name of [
      ...Object.keys(pkg.dependencies),
      ...Object.keys(pkg.devDependencies),
    ]) {
      assert.ok(
        lock.packages[`node_modules/${name}`]?.version,
        `${name} has a locked version`
      )
    }
    // These two were the entries `npm ci` reported missing before the lockfile was regenerated.
    assert.ok(lock.packages["node_modules/viem"]?.version)
    assert.ok(lock.packages["node_modules/web-streams-polyfill"]?.version)
  })

  it("ESLint skips vendored/generated files but still lints project source", () => {
    const eslint = root + "node_modules/.bin/eslint"
    const run = (file: string) => {
      const r = spawnSync(eslint, ["--format", "json", file], {
        cwd: root,
        encoding: "utf8",
        env: childEnv({ PATH: process.env.PATH, HOME: process.env.HOME }),
      })
      const report = JSON.parse(r.stdout) as {
        messages: { message: string }[]
        errorCount: number
      }[]
      return {
        ignored: report[0].messages.some((m) => /ignored/i.test(m.message)),
        errors: report[0].errorCount,
      }
    }
    for (const linted of [
      "app/layout.tsx",
      "lib/backend/advances.ts",
      "lib/chain/writes.ts",
      "tests/backend-api.test.ts",
      "scripts/chain-integration/flow.ts",
    ]) {
      assert.deepEqual(
        run(linted),
        { ignored: false, errors: 0 },
        `${linted} must be linted and clean`
      )
    }
    for (const ignored of [
      "contracts/lib/openzeppelin-contracts/test/utils/structs/Heap.test.js",
      "lib/chain/generated/invoiceAdvanceAbi.ts",
    ]) {
      assert.equal(run(ignored).ignored, true, `${ignored} must be ignored`)
    }
  })
})
