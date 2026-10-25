import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
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
})
