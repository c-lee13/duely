#!/usr/bin/env node
// Exports the V2 ABIs (DuelyVault, InvoiceAdvanceV2) from the COMPILED artifacts, plus typed constants for
// the web app. It never edits V1 outputs and invents no ABI entries.
//
//   node contracts/script/export-abi-v2.mjs             forge build, then (re)write the V2 artifacts
//   node contracts/script/export-abi-v2.mjs --check     write nothing; exit 1 if anything is stale
//   node contracts/script/export-abi-v2.mjs --no-build  skip `forge build` (use existing contracts/out)
//
// Writes:
//   contracts/deployments/abi/DuelyVault.json            raw ABI array (any consumer)
//   contracts/deployments/abi/InvoiceAdvanceV2.json
//   lib/chain/generated/duelyVaultAbi.ts                 typed `as const` (viem), V1 convention
//   lib/chain/generated/invoiceAdvanceV2Abi.ts
//   lib/chain/generated/deploymentV2.ts                  only once contracts/deployments/xrpl-evm-testnet-v2.json exists
//   lib/chain/generated/v2.ts                            barrel for the three files above
//
// The V1 barrel (lib/chain/generated/index.ts) is deliberately NOT touched, so nothing changes for the
// existing V1 integration until Track B opts in.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as prettier from "prettier"

const args = new Set(process.argv.slice(2))
for (const a of args) {
  if (!["--check", "--no-build"].includes(a)) fail(`unknown flag ${a}`)
}
const CHECK = args.has("--check")

const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(contractsDir, "..")
const abiDir = join(contractsDir, "deployments", "abi")
// Flat in lib/chain/generated/ (not a subfolder): existing tests read every entry of that directory as a file.
const tsDir = join(repoRoot, "lib", "chain", "generated")
const manifestPath = join(contractsDir, "deployments", "xrpl-evm-testnet-v2.json")
const EXPECTED_CHAIN_ID = 1449000

// What Track B needs. Every name must exist in the compiled ABI; the export fails otherwise.
const SPEC = {
  DuelyVault: {
    functions: [
      // ERC-4626 / ERC-20 (LP side)
      "asset", "totalAssets", "totalSupply", "balanceOf", "decimals", "name", "symbol", "allowance", "approve",
      "transfer", "transferFrom", "convertToAssets", "convertToShares", "previewDeposit", "previewMint",
      "previewWithdraw", "previewRedeem", "maxDeposit", "maxMint", "maxWithdraw", "maxRedeem", "deposit", "mint",
      "withdraw", "redeem",
      // Duely accounting and limits
      "availableLiquidity", "withdrawableLiquidity", "outstandingPrincipal", "totalRealizedLosses",
      "totalFeesEarned", "utilizationBps", "maxAdvanceNow", "getAdvance", "escrow", "FEE_BPS", "MAX_ADVANCE_BPS",
      "MAX_UTILIZATION_BPS", "MAX_INVOICE_EXPOSURE_BPS",
      // pause and roles
      "paused", "advancesPaused", "advancesEnabled", "pause", "unpause", "pauseAdvances", "unpauseAdvances",
      "hasRole", "DEFAULT_ADMIN_ROLE", "OPERATOR_ROLE", "PAUSER_ROLE", "setEscrow",
      // escrow-only (documented for completeness; Track B never calls these)
      "fundAdvance", "recordRepayment", "finalizeLoss",
    ],
    events: [
      "Deposit", "Withdraw", "Transfer", "Approval", "AdvanceFunded", "AdvanceRepaid", "AdvanceLossFinalized",
      "EscrowSet", "AdvancesPaused", "AdvancesUnpaused", "Paused", "Unpaused", "RoleGranted", "RoleRevoked",
    ],
    errors: [
      "NotEscrow", "EscrowNotSet", "EscrowAlreadySet", "EscrowMismatch", "AdvancesAreDisabled", "InvalidAddress",
      "InvalidAmount", "InvalidFee", "AdvanceAlreadyExists", "AdvanceNotOpen", "AdvanceExceedsInvoiceCap",
      "ExceedsUtilizationLimit", "ExceedsInvoiceExposureLimit", "InsufficientLiquidity", "UnsupportedTokenBehavior",
      "EnforcedPause", "ExpectedPause", "ERC4626ExceededMaxDeposit", "ERC4626ExceededMaxMint",
      "ERC4626ExceededMaxWithdraw", "ERC4626ExceededMaxRedeem", "ReentrancyGuardReentrantCall",
      "AccessControlUnauthorizedAccount",
    ],
  },
  InvoiceAdvanceV2: {
    functions: [
      "createInvoice", "cancelInvoice", "fundInvoice", "approveAdvance", "approveCompletion", "raiseDispute",
      "resolveDispute", "claim", "getInvoice", "quoteAdvance", "claimable", "totalClaimable", "totalEscrow",
      "nextInvoiceId", "vault", "paymentToken", "FEE_BPS", "ADVANCE_BPS", "MIN_ADVANCE_SHARE_BPS", "hasRole", "DEFAULT_ADMIN_ROLE",
      "OPERATOR_ROLE", "EVALUATOR_ROLE",
    ],
    events: [
      "InvoiceCreated", "InvoiceFunded", "InvoiceCancelled", "AdvancePaid", "InvoiceSettled", "ProceedsCredited",
      "ProceedsClaimed", "InvoiceDisputed", "DisputeResolved", "RoleGranted", "RoleRevoked",
    ],
    errors: [
      "InvoiceNotFound", "InvalidAddress", "InvalidAmount", "InvalidHash", "InvalidInvoiceParties", "InvalidStatus",
      "NotInvoiceClient", "ZeroAdvance", "UnsupportedTokenBehavior", "VaultMismatch", "NothingToClaim",
      "ReentrancyGuardReentrantCall", "AccessControlUnauthorizedAccount",
    ],
  },
}

function fail(msg) {
  console.error(`export-abi-v2: ${msg}`)
  process.exit(1)
}

function run(cmd, cmdArgs, opts = {}) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8", ...opts }).trim()
  } catch (e) {
    fail(`\`${cmd} ${cmdArgs[0] ?? ""}\` failed: ${String(e.stderr || e.message).split("\n")[0]}`)
  }
}

function loadArtifact(name) {
  const p = join(contractsDir, "out", `${name}.sol`, `${name}.json`)
  if (!existsSync(p)) fail(`missing artifact ${relative(repoRoot, p)}; run \`forge build\``)
  return JSON.parse(readFileSync(p, "utf8"))
}

function assertSpec(name, abi) {
  for (const [kind, type] of [["functions", "function"], ["events", "event"], ["errors", "error"]]) {
    const have = new Set(abi.filter((x) => x.type === type).map((x) => x.name))
    const missing = SPEC[name][kind].filter((n) => !have.has(n))
    if (missing.length) fail(`${name} ABI is missing required ${kind}: ${missing.join(", ")}`)
  }
}

async function format(source) {
  return prettier.format(source, {
    parser: "typescript", semi: false, singleQuote: false, tabWidth: 2, trailingComma: "es5", printWidth: 80, endOfLine: "lf",
  })
}

const sha = (abi) => createHash("sha256").update(JSON.stringify(abi)).digest("hex")
const HEADER = (what, from) =>
  `// AUTO-GENERATED by contracts/script/export-abi-v2.mjs - DO NOT EDIT.\n// ${what}\n// Source: ${from}\n` +
  `// Regenerate: node contracts/script/export-abi-v2.mjs\n\n`

if (!args.has("--no-build")) run("forge", ["build"], { cwd: contractsDir })

const artifacts = { DuelyVault: loadArtifact("DuelyVault"), InvoiceAdvanceV2: loadArtifact("InvoiceAdvanceV2") }
for (const [name, a] of Object.entries(artifacts)) assertSpec(name, a.abi)

const outputs = new Map() // path -> content
const consts = { DuelyVault: "duelyVaultAbi", InvoiceAdvanceV2: "invoiceAdvanceV2Abi" }
for (const [name, a] of Object.entries(artifacts)) {
  outputs.set(join(abiDir, `${name}.json`), JSON.stringify(a.abi, null, 2) + "\n")
  outputs.set(
    join(tsDir, `${consts[name]}.ts`),
    await format(
      HEADER(`ABI of ${name} (sha256 ${sha(a.abi)}).`, `contracts/out/${name}.sol/${name}.json`) +
        `export const ${consts[name]} = ${JSON.stringify(a.abi, null, 2)} as const\n`
    )
  )
}

let barrel =
  `export { duelyVaultAbi } from "./duelyVaultAbi"\nexport { invoiceAdvanceV2Abi } from "./invoiceAdvanceV2Abi"\n`

if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (m.chainId !== EXPECTED_CHAIN_ID) fail(`manifest chainId ${m.chainId} != ${EXPECTED_CHAIN_ID}`)
  for (const [name, a] of Object.entries(artifacts)) {
    if (m.abis?.[name]?.sha256 !== sha(a.abi)) fail(`manifest ABI hash for ${name} does not match the compiled ABI`)
  }
  const deployment = {
    chainId: m.chainId,
    network: m.network,
    explorer: m.explorer,
    sourceCommit: m.sourceCommit,
    contracts: {
      paymentToken: m.paymentToken,
      duelyVault: m.vault,
      invoiceAdvanceV2: m.escrow,
    },
    link: m.link,
    roles: m.roles,
    parameters: m.parameters,
  }
  outputs.set(
    join(tsDir, "deploymentV2.ts"),
    await format(
      HEADER("Deployed V2 addresses for XRPL EVM Testnet, taken from the deployment manifest.", "contracts/deployments/xrpl-evm-testnet-v2.json") +
        `export const deploymentV2 = ${JSON.stringify(deployment, null, 2)} as const\n`
    )
  )
  barrel += `export { deploymentV2 } from "./deploymentV2"\n`
}
outputs.set(join(tsDir, "v2.ts"), await format(HEADER("Barrel for the V2 chain artifacts (import from \"@/lib/chain/generated/v2\").", "contracts/script/export-abi-v2.mjs") + barrel))

let stale = 0
for (const [path, content] of outputs) {
  const rel = relative(repoRoot, path)
  const current = existsSync(path) ? readFileSync(path, "utf8") : null
  if (CHECK) {
    if (current !== content) {
      console.error(`stale or missing: ${rel}`)
      stale++
    }
  } else {
    mkdirSync(dirname(path), { recursive: true })
    if (current !== content) writeFileSync(path, content)
    console.log(`${current === content ? "unchanged" : "wrote    "} ${rel}`)
  }
}
if (CHECK) {
  if (stale) fail(`${stale} generated file(s) are stale; run \`node contracts/script/export-abi-v2.mjs\``)
  console.log(`export-abi-v2: ${outputs.size} generated files are up to date`)
}
for (const [name, a] of Object.entries(artifacts)) {
  console.log(`ABI ${name}: ${a.abi.length} entries, sha256 ${sha(a.abi)}`)
}
