import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

const scriptPath = fileURLToPath(
  new URL("./chain-integration.ts", import.meta.url)
)
const registerPath = fileURLToPath(
  new URL("../lib/chain/test/register.mjs", import.meta.url)
)
const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const cli = readFileSync(scriptPath, "utf8")
const flow = readFileSync(
  fileURLToPath(new URL("./chain-integration/flow.ts", import.meta.url)),
  "utf8"
)
/** Both files together: the CLI entry point and the flow it drives. */
const source = `${flow}\n${cli}`

/** Runs the real CLI in a subprocess with a deliberately minimal environment. */
function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ["--import", registerPath, scriptPath, ...args],
    {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...env,
      },
      encoding: "utf8",
      timeout: 60_000,
    }
  )
}

describe("the CLI: safe by default (static guarantees)", () => {
  it("builds wallet clients only inside execute(), which main() reaches only past the preflight return", () => {
    assert.equal(source.match(/createWalletClient\(/g)?.length, 1)
    const execute = flow.slice(flow.indexOf("export async function execute("))
    assert.ok(execute.includes("createWalletClient("))
    // ...and only on the keystore path: the injected-wallet seam is not reachable from the CLI.
    assert.doesNotMatch(cli, /walletFor/)
    const main = cli.slice(cli.indexOf("async function main()"))
    const preflightBranch = main.indexOf('if (args.mode === "preflight")')
    const executeCall = main.indexOf("return execute(")
    assert.ok(preflightBranch > 0 && executeCall > preflightBranch)
    // every path out of the preflight branch returns before execute() is reachable
    const branch = main.slice(preflightBranch, executeCall)
    assert.match(branch, /return 0/)
    assert.match(branch, /return 1/)
  })

  it("decrypts keystores only for --check-signers or --execute", () => {
    // flow: the definition and the single call inside execute(); cli: the guarded --check-signers use
    assert.equal([...flow.matchAll(/loadSigners\(/g)].length, 2)
    assert.equal([...cli.matchAll(/loadSigners\(/g)].length, 1)
    const main = cli.slice(cli.indexOf("async function main()"))
    const preflightBranch = main.indexOf('if (args.mode === "preflight")')
    const call = main.indexOf("loadSigners(")
    assert.ok(call > preflightBranch)
    assert.match(main.slice(preflightBranch, call), /args\.checkSigners/)
  })

  it("has no embedded secrets, key material, URLs or hard-coded addresses", () => {
    assert.doesNotMatch(source, /0x[0-9a-fA-F]{64}/, "64-hex literal")
    assert.doesNotMatch(source, /0x[0-9a-fA-F]{40}/, "address literal")
    assert.doesNotMatch(source, /https?:\/\//, "URL literal")
    assert.doesNotMatch(source, /PRIVATE_KEY|mnemonic|seed phrase/i)
    assert.doesNotMatch(source, /quiknode/i)
  })

  it("never prints the RPC URL: it is only handed to the clients", () => {
    const lines = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /rpcUrl/i.test(l))
    const allowed = [
      /^rpcUrl: string$/,
      /^rpcUrl: serverRpc \?\? publicRpcUrl,$/,
      /^publicRpcUrl,$/,
      /^const client = createChainPublicClient\(cfg\.rpcUrl\)$/,
      /^transport: http\(cfg\.rpcUrl, \{ retryCount: 0 \}\),/,
    ]
    assert.ok(lines.length >= 4)
    for (const l of lines) {
      assert.ok(
        allowed.some((re) => re.test(l)),
        `unexpected use of the RPC URL: ${l}`
      )
    }
    assert.doesNotMatch(
      source,
      /(console\.log|line|console\.error)\([^)]*rpcUrl/i
    )
  })

  it("has no path that mints or transfers tokens (only a printed hint for the human owner)", () => {
    // The one allowed mention: the instruction shown to the token owner when the client is short.
    const withoutHint = source
      .split("\n")
      .filter(
        (l) => !(l.includes("cast send") && l.includes("mint(address,uint256)"))
      )
      .join("\n")
    assert.doesNotMatch(withoutHint, /\bmint\w*\s*\(/)
    assert.doesNotMatch(
      withoutHint,
      /functionName:\s*"(mint|transfer|transferFrom)"/
    )
    assert.doesNotMatch(withoutHint, /import[^;]*\b(mint|transfer)\w*[^;]*from/)
    assert.match(source, /this script will not do it for you/)
  })

  it("sends state-changing requests with retries disabled", () => {
    assert.match(source, /http\(cfg\.rpcUrl, \{ retryCount: 0 \}\)/)
  })

  it("uses only the SDK's public write and lifecycle APIs, not raw contract writes", () => {
    assert.doesNotMatch(
      source,
      /\.writeContract\(|\.sendTransaction\(|\.sendRawTransaction\(/
    )
    for (const api of [
      "createInvoice",
      "approveEscrowAllowance",
      "fundInvoice",
      "approveAdvance",
      "approveCompletion",
      "trackTransaction",
    ]) {
      assert.match(source, new RegExp(`\\b${api}\\b`), api)
    }
  })
})

describe("the CLI: behaviour in a subprocess", () => {
  it("--help prints usage and exits 0 without needing any environment", () => {
    const r = run(["--help"])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /read-only preflight/)
    assert.match(r.stdout, /--execute/)
  })

  it("rejects unknown flags and --yes without --execute with a clear error", () => {
    const unknown = run(["--bogus"])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /unknown argument: --bogus/)
    const yes = run(["--yes"])
    assert.equal(yes.status, 1)
    assert.match(yes.stderr, /--yes only makes sense/)
  })

  it("without configuration it fails before any network call, in both modes", () => {
    for (const mode of [[], ["--execute"], ["--execute", "--yes"]]) {
      const r = run(mode)
      assert.equal(r.status, 1, mode.join(" "))
      assert.match(r.stderr, /CHAIN_ID must be 1449000/)
      assert.doesNotMatch(r.stdout, /Preflight|Executing|BROADCAST/)
    }
  })

  it("rejects a wrong chain id or a repeated address before touching the network", () => {
    const env = {
      CHAIN_ID: "1449000",
      CLIENT_ADDRESS: "0x8d93eD20e6eD28c34aE0057f441ED97d3e63459E",
      EVALUATOR_ADDRESS: "0x276acaB037BB048a682E0E7ad900F3fFDCe65ECb",
      OPERATOR_ADDRESS: "0x6e83F6Bb6758Ced46e60be88271D72C22B84482E",
      FREELANCER_ADDRESS: "0x8d93eD20e6eD28c34aE0057f441ED97d3e63459E",
    }
    const dup = run([], env)
    assert.equal(dup.status, 1)
    assert.match(dup.stderr, /must all be different/)
    const wrongChain = run([], { ...env, CHAIN_ID: "1440000" })
    assert.equal(wrongChain.status, 1)
    assert.match(wrongChain.stderr, /CHAIN_ID must be 1449000/)
    const badChecksum = run([], {
      ...env,
      FREELANCER_ADDRESS: "0x02379033ecD642D9A9aA590ABe763D62AEa967F4",
    })
    assert.equal(badChecksum.status, 1)
    assert.match(
      badChecksum.stderr,
      /FREELANCER_ADDRESS must be set to a valid/
    )
  })
})

describe("the fork rehearsal tool cannot touch the live chain", () => {
  const rehearseSource = readFileSync(
    fileURLToPath(new URL("./rehearse-fork.ts", import.meta.url)),
    "utf8"
  )

  it("talks only to the local fork and refuses unless the node is Anvil", () => {
    const urls = [...rehearseSource.matchAll(/https?:\/\/[^\s"'`)]+/g)].map(
      (m) => m[0]
    )
    for (const url of urls) {
      // The header comment documents forking from the public RPC; code uses only the local URL.
      assert.match(
        url,
        /^http:\/\/127\.0\.0\.1:8560$|^https:\/\/rpc\.testnet\.xrplevm\.org$/,
        url
      )
    }
    assert.match(rehearseSource, /const LOCAL = "http:\/\/127\.0\.0\.1:8560"/)
    assert.match(rehearseSource, /process\.env\.XRPL_EVM_RPC_URL = LOCAL/)
    assert.match(rehearseSource, /anvil_nodeInfo/)
    assert.match(rehearseSource, /Refusing to continue/)
    // the guard runs before any transaction-sending setup
    assert.ok(
      rehearseSource.indexOf("anvil_nodeInfo") <
        rehearseSource.indexOf("writeContract")
    )
    assert.doesNotMatch(rehearseSource, /PRIVATE_KEY|keystore|decrypt/i)
  })

  it("rejects an unknown scenario before any network call", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        registerPath,
        fileURLToPath(new URL("./rehearse-fork.ts", import.meta.url)),
        "--scenario",
        "nope",
      ],
      {
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        encoding: "utf8",
        timeout: 60_000,
      }
    )
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--scenario must be normal, topup or bad-evaluator/)
  })

  it("the real CLI never imports the rehearsal tool or its fork-only setup", () => {
    assert.doesNotMatch(source, /rehearse-fork/)
    assert.doesNotMatch(source, /anvil/i)
    // the injection seam exists only on execute(); the CLI entry point never supplies it
    assert.doesNotMatch(cli, /walletFor|ExecuteDeps/)
  })
})
