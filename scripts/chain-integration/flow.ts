/**
 * The flow behind scripts/chain-integration.ts: configuration, the read-only preflight, and the
 * broadcast path. Kept separate from the CLI entry point so it can be rehearsed against a local
 * fork and unit-tested. Importing this module never sends anything; only `execute()` can.
 */
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline/promises"

import {
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  isAddress,
  keccak256,
  stringToHex,
} from "viem"

import {
  CHAIN_ID,
  ROLE_IDS,
  approveAdvance,
  approveCompletion,
  approveEscrowAllowance,
  contractAddresses,
  createChainPublicClient,
  createInvoice,
  deployment,
  depositReserve,
  formatDusd,
  fundInvoice,
  getChainEnvIssues,
  getEscrowAllowance,
  getInvoice,
  getNextInvoiceId,
  getOnchainRoleIds,
  getPaymentTokenAddress,
  getReserveSnapshot,
  getTokenBalance,
  getTokenMetadata,
  hasRole,
  invoiceAdvanceAbi,
  mockUsdcAbi,
  paymentTokenInfo,
  publicRpcUrl,
  redactUrls,
  trackTransaction,
  waitForBlock,
  xrplEvmTestnet,
  type ConfirmedTransaction,
  type ChainWalletClient,
  type HexAddress,
  type WriteContext,
} from "../../lib/chain/index"
import { type Args } from "./args"
import { accountFromKeystore, promptHidden, readPasswordFile } from "./keystore"
import {
  buildPlan,
  type Checkpoint,
  type Plan,
  type Signer,
  type Snapshot,
} from "./plan"
import {
  VerificationError,
  classifyOutcome,
  runSteps,
  type RunStep,
  type StepRecord,
} from "./run"
import { verifyAtBlock } from "./verify"

// ---- configuration (from the environment; nothing secret is stored in this file) -------------

export interface Config {
  rpcUrl: string
  usingServerRpc: boolean
  chainId: number
  addresses: Record<Signer, HexAddress> & { freelancer: HexAddress }
  keystoreDir: string
  keystoreName: Record<Signer, string>
  passwordFileEnv: Record<Signer, string>
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function envAddress(name: string): HexAddress {
  const value = env(name)
  if (!value || !isAddress(value, { strict: true })) {
    throw new Error(
      `${name} must be set to a valid (EIP-55 checksummed or lowercase) address`
    )
  }
  return value as HexAddress
}

export function loadConfig(): Config {
  const chainId = Number(env("CHAIN_ID") ?? "")
  if (chainId !== CHAIN_ID)
    throw new Error(`CHAIN_ID must be ${CHAIN_ID}, got "${env("CHAIN_ID")}"`)
  const addresses = {
    client: envAddress("CLIENT_ADDRESS"),
    evaluator: envAddress("EVALUATOR_ADDRESS"),
    operator: envAddress("OPERATOR_ADDRESS"),
    freelancer: envAddress("FREELANCER_ADDRESS"),
  }
  const distinct = new Set(Object.values(addresses).map((a) => a.toLowerCase()))
  if (distinct.size !== 4) {
    throw new Error(
      "client, evaluator, operator and freelancer addresses must all be different"
    )
  }
  const serverRpc = env("XRPL_EVM_RPC_URL")
  return {
    rpcUrl: serverRpc ?? publicRpcUrl,
    usingServerRpc: serverRpc !== undefined,
    chainId,
    addresses,
    keystoreDir:
      env("KEYSTORE_DIR") ?? join(homedir(), ".foundry", "keystores"),
    keystoreName: {
      client: env("CLIENT_ACCOUNT") ?? "duely-client",
      evaluator: env("EVALUATOR_ACCOUNT") ?? "duely-evaluator",
      operator: env("DEPLOYER_ACCOUNT") ?? "duely-deployer",
    },
    passwordFileEnv: {
      client: "CLIENT_PASSWORD_FILE",
      evaluator: "EVALUATOR_PASSWORD_FILE",
      operator: "DEPLOYER_PASSWORD_FILE",
    },
  }
}

// ---- small output helpers -----------------------------------------------------------------------

export const dusd = (v: bigint) => `${formatDusd(v)} dUSD`
/** Display only: projections can be negative when a wallet is short (formatDusd rejects that). */
const projected = (v: bigint) =>
  v < BigInt(0)
    ? `${formatUnits(v, paymentTokenInfo.decimals)} dUSD (short: not yet fundable)`
    : dusd(v)
const xrp = (wei: bigint) => `${formatEther(wei)} XRP`
export const line = (text = "") => console.log(text)

export interface Check {
  name: string
  ok: boolean
  detail: string
}

async function check(
  checks: Check[],
  name: string,
  fn: () => Promise<string>
): Promise<void> {
  try {
    checks.push({ name, ok: true, detail: await fn() })
  } catch (error) {
    checks.push({
      name,
      ok: false,
      detail: redactUrls(
        error instanceof Error ? error.message : String(error)
      ),
    })
  }
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

// ---- preflight (read-only) ----------------------------------------------------------------------

export type PublicClient = ReturnType<typeof createChainPublicClient>

export interface PreflightResult {
  checks: Check[]
  snapshot?: Snapshot
  plan?: Plan
  nextInvoiceId?: bigint
}

export async function preflight(
  cfg: Config,
  args: Args,
  client: PublicClient
): Promise<PreflightResult> {
  const checks: Check[] = []
  const opts = { client }
  const a = cfg.addresses
  const result: PreflightResult = { checks }

  await check(checks, "RPC chain ID", async () => {
    const id = await client.getChainId()
    if (id !== CHAIN_ID || id !== cfg.chainId) {
      throw new Error(`RPC reports chain ${id}, expected ${CHAIN_ID}`)
    }
    return `${id} (XRPL EVM Testnet)`
  })

  await check(checks, "Contract addresses", async () => {
    const issues = getChainEnvIssues()
    if (issues.length) throw new Error(issues.join("; "))
    const envToken = env("TOKEN_ADDRESS")
    const envContract = env("CONTRACT_ADDRESS")
    if (envToken && !same(envToken, contractAddresses.paymentToken)) {
      throw new Error("TOKEN_ADDRESS differs from the deployment manifest")
    }
    if (envContract && !same(envContract, contractAddresses.invoiceAdvance)) {
      throw new Error("CONTRACT_ADDRESS differs from the deployment manifest")
    }
    const onchainToken = await getPaymentTokenAddress(opts)
    if (!same(onchainToken, contractAddresses.paymentToken)) {
      throw new Error(
        `InvoiceAdvance.paymentToken() is ${onchainToken}, not the SDK's token`
      )
    }
    for (const [label, address] of [
      ["InvoiceAdvance", contractAddresses.invoiceAdvance],
      ["MockUSDC", contractAddresses.paymentToken],
    ] as const) {
      const code = await client.getCode({ address })
      if (!code || code === "0x")
        throw new Error(`no contract code at ${label} ${address}`)
    }
    return `InvoiceAdvance ${contractAddresses.invoiceAdvance}, token ${contractAddresses.paymentToken}`
  })

  await check(checks, "Token metadata", async () => {
    const meta = await getTokenMetadata(opts)
    if (
      meta.name !== paymentTokenInfo.name ||
      meta.symbol !== paymentTokenInfo.symbol ||
      meta.decimals !== paymentTokenInfo.decimals
    ) {
      throw new Error(
        `on-chain ${JSON.stringify(meta)} != SDK ${JSON.stringify(paymentTokenInfo)}`
      )
    }
    return `${meta.name} (${meta.symbol}), ${meta.decimals} decimals - demo token`
  })

  await check(checks, "Role IDs match the SDK", async () => {
    const onchain = await getOnchainRoleIds(opts)
    for (const role of ["admin", "operator", "evaluator"] as const) {
      if (onchain[role] !== ROLE_IDS[role])
        throw new Error(`${role} role id differs from the SDK`)
    }
    return "DEFAULT_ADMIN / OPERATOR / EVALUATOR ids identical"
  })

  await check(checks, "Role assignments", async () => {
    if (
      !same(a.operator, deployment.roles.operator) ||
      !same(a.evaluator, deployment.roles.evaluator)
    ) {
      throw new Error(
        "OPERATOR_ADDRESS / EVALUATOR_ADDRESS differ from the deployment manifest roles"
      )
    }
    const problems: string[] = []
    if (!(await hasRole("operator", a.operator, opts)))
      problems.push("operator lacks OPERATOR_ROLE")
    if (!(await hasRole("evaluator", a.evaluator, opts)))
      problems.push("evaluator lacks EVALUATOR_ROLE")
    if (await hasRole("evaluator", a.operator, opts))
      problems.push("operator also holds EVALUATOR_ROLE")
    if (await hasRole("operator", a.evaluator, opts))
      problems.push("evaluator also holds OPERATOR_ROLE")
    for (const role of ["admin", "operator", "evaluator"] as const) {
      if (await hasRole(role, a.client, opts))
        problems.push(`client unexpectedly holds the ${role} role`)
      if (await hasRole(role, a.freelancer, opts))
        problems.push(`freelancer unexpectedly holds the ${role} role`)
    }
    if (problems.length) throw new Error(problems.join("; "))
    return "operator=OPERATOR_ROLE, evaluator=EVALUATOR_ROLE, client and freelancer hold no role"
  })

  await check(
    checks,
    "Existing invoice decodes (SDK/ABI compatibility)",
    async () => {
      const invoice = await getInvoice(1, opts)
      return `invoice #1 is ${invoice.statusName}, ${dusd(invoice.amount)}, advance ${dusd(invoice.advanceAmount)}`
    }
  )

  const nextInvoiceId = await getNextInvoiceId(opts).catch(() => undefined)
  result.nextInvoiceId = nextInvoiceId

  await check(
    checks,
    "Simulate createInvoice (eth_call, nothing sent)",
    async () => {
      const probe = keccak256(stringToHex("duely-integration-preflight-probe"))
      const sim = await client.simulateContract({
        address: contractAddresses.invoiceAdvance,
        abi: invoiceAdvanceAbi,
        functionName: "createInvoice",
        args: [a.freelancer, args.amount, probe],
        account: a.client,
      })
      if (nextInvoiceId !== undefined && sim.result !== nextInvoiceId) {
        throw new Error(
          `simulated invoice id ${sim.result} != nextInvoiceId ${nextInvoiceId}`
        )
      }
      return `would create invoice #${sim.result}`
    }
  )

  await check(
    checks,
    "Simulate dUSD approve (eth_call, nothing sent)",
    async () => {
      const sim = await client.simulateContract({
        address: contractAddresses.paymentToken,
        abi: mockUsdcAbi,
        functionName: "approve",
        args: [contractAddresses.invoiceAdvance, args.amount],
        account: a.client,
      })
      if (sim.result !== true)
        throw new Error("approve simulation returned false")
      return "returns true"
    }
  )

  await check(checks, "Balances, reserve and plan", async () => {
    const [reserve, clientDusd, operatorDusd, freelancerDusd, clientAllowance] =
      await Promise.all([
        getReserveSnapshot(opts),
        getTokenBalance(a.client, opts),
        getTokenBalance(a.operator, opts),
        getTokenBalance(a.freelancer, opts),
        getEscrowAllowance(a.client, opts),
      ])
    if (!reserve.solvent)
      throw new Error(
        "InvoiceAdvance is not solvent (balance < reserve + escrow)"
      )
    const [gasClient, gasEvaluator, gasOperator, gasPrice] = await Promise.all([
      client.getBalance({ address: a.client }),
      client.getBalance({ address: a.evaluator }),
      client.getBalance({ address: a.operator }),
      client.getGasPrice(),
    ])
    const snapshot: Snapshot = {
      amount: args.amount,
      reserveBalance: reserve.reserveBalance,
      totalEscrow: reserve.totalEscrow,
      contractDusd: reserve.contractTokenBalance,
      clientDusd,
      clientAllowance,
      operatorDusd,
      freelancerDusd,
      gasBalance: {
        client: gasClient,
        evaluator: gasEvaluator,
        operator: gasOperator,
      },
      gasPrice,
    }
    result.snapshot = snapshot
    result.plan = buildPlan(snapshot)
    return [
      `reserve ${dusd(reserve.reserveBalance)}, escrow ${dusd(reserve.totalEscrow)}, solvent`,
      `client ${dusd(clientDusd)} (allowance ${dusd(clientAllowance)}), freelancer ${dusd(freelancerDusd)}, operator ${dusd(operatorDusd)}`,
      `gas: client ${xrp(gasClient)}, evaluator ${xrp(gasEvaluator)}, operator ${xrp(gasOperator)}; gas price ${gasPrice} wei`,
    ].join("\n         ")
  })

  if (result.plan) {
    const plan = result.plan
    await check(
      checks,
      "Run is feasible (funds, allowances, reserve, gas)",
      async () => {
        if (plan.blockers.length)
          throw new Error(
            plan.blockers.map((b) => `- ${b}`).join("\n         ")
          )
        return `${plan.totalTransactions} transaction(s) can be sent`
      }
    )
  }
  return result
}

export function printPreflight(
  cfg: Config,
  args: Args,
  pre: PreflightResult
): void {
  line("== Preflight (read-only: no transaction is sent) ==")
  line(
    `Network : XRPL EVM Testnet (${CHAIN_ID})   RPC: ${cfg.usingServerRpc ? "server RPC from XRPL_EVM_RPC_URL (URL hidden)" : "public RPC"}`
  )
  line(`Parties : client ${cfg.addresses.client}`)
  line(`          evaluator ${cfg.addresses.evaluator}`)
  line(`          operator ${cfg.addresses.operator}`)
  line(`          freelancer ${cfg.addresses.freelancer}`)
  line(
    `Invoice : ${args.amountDusd} dUSD (demo token), a NEW invoice; invoice #1 is not touched`
  )
  line()
  for (const c of pre.checks) {
    line(`[${c.ok ? " ok " : "FAIL"}] ${c.name}`)
    line(`       ${c.detail}`)
  }
  line()
  const plan = pre.plan
  if (!plan) return
  line("== Plan ==")
  line(
    `Advance: ${dusd(plan.advance)}  |  reserve top-up needed: ${dusd(plan.reserveShortfall)}`
  )
  line(
    `Transactions: ${plan.totalTransactions} (client ${plan.txCountBySigner.client}, evaluator ${plan.txCountBySigner.evaluator}, operator ${plan.txCountBySigner.operator})`
  )
  plan.steps.forEach((step, i) =>
    line(`  ${i + 1}. [${step.signer}] ${step.label}`)
  )
  const s = pre.snapshot!
  line("Expected net effect once settled:")
  line(
    `  client      ${dusd(s.clientDusd)} -> ${projected(plan.final.clientDusd!)}`
  )
  line(
    `  freelancer  ${dusd(s.freelancerDusd)} -> ${dusd(plan.final.freelancerDusd!)}`
  )
  line(
    `  reserve     ${dusd(s.reserveBalance)} -> ${dusd(plan.final.reserve!)}  (advance repaid from escrow)`
  )
  line(`  escrow      ${dusd(s.totalEscrow)} -> ${dusd(plan.final.escrow!)}`)
  line(`  invoice     Settled, advance ${dusd(plan.advance)}`)
  line()
}

// ---- signers --------------------------------------------------------------------------------------

export async function loadSigners(cfg: Config, needed: Signer[]) {
  const accounts = new Map<Signer, ReturnType<typeof accountFromKeystore>>()
  for (const signer of needed) {
    const fileVar = cfg.passwordFileEnv[signer]
    const file = env(fileVar)
    const name = cfg.keystoreName[signer]
    const password = file
      ? readPasswordFile(file)
      : await promptHidden(`Keystore password for ${name} (${signer}): `)
    accounts.set(
      signer,
      accountFromKeystore({
        dir: cfg.keystoreDir,
        name,
        password,
        expectedAddress: cfg.addresses[signer],
      })
    )
  }
  return accounts
}

// ---- execution --------------------------------------------------------------------------------------

export interface LiveState {
  invoiceStatus?: string
  advanceAmount?: bigint
  reserve: bigint
  escrow: bigint
  solvent: boolean
  clientDusd: bigint
  freelancerDusd: bigint
  contractDusd: bigint
  clientAllowance: bigint
  operatorAllowance: bigint
}

/**
 * Reads everything the checks compare, ALL at exactly `blockNumber`. Pinning every read (invoice,
 * reserve, escrow, balances, allowances) to one block makes the result a single coherent snapshot;
 * unpinned reads can be served by different nodes at different heights.
 */
export async function readState(
  cfg: Config,
  client: Pick<PublicClient, "readContract" | "getBlockNumber">,
  invoiceId: bigint | undefined,
  blockNumber: bigint
): Promise<LiveState> {
  const opts = { client, blockNumber }
  const [
    snap,
    clientDusd,
    freelancerDusd,
    clientAllowance,
    operatorAllowance,
    invoice,
  ] = await Promise.all([
    getReserveSnapshot(opts),
    getTokenBalance(cfg.addresses.client, opts),
    getTokenBalance(cfg.addresses.freelancer, opts),
    getEscrowAllowance(cfg.addresses.client, opts),
    getEscrowAllowance(cfg.addresses.operator, opts),
    invoiceId === undefined
      ? Promise.resolve(undefined)
      : getInvoice(invoiceId, opts),
  ])
  return {
    invoiceStatus: invoice?.statusName,
    advanceAmount: invoice?.advanceAmount,
    reserve: snap.reserveBalance,
    escrow: snap.totalEscrow,
    solvent: snap.solvent,
    clientDusd,
    freelancerDusd,
    contractDusd: snap.contractTokenBalance,
    clientAllowance,
    operatorAllowance,
  }
}

export function mismatches(expected: Checkpoint, actual: LiveState): string[] {
  const out: string[] = []
  const eq = (
    name: string,
    want: bigint | string | undefined,
    got: bigint | string | undefined
  ) => {
    if (want !== undefined && want !== got)
      out.push(`${name}: expected ${String(want)}, found ${String(got)}`)
  }
  eq("invoice status", expected.invoiceStatus, actual.invoiceStatus)
  eq("advanceAmount", expected.advanceAmount, actual.advanceAmount)
  eq("reserveBalance", expected.reserve, actual.reserve)
  eq("totalEscrow", expected.escrow, actual.escrow)
  eq("client dUSD", expected.clientDusd, actual.clientDusd)
  eq("freelancer dUSD", expected.freelancerDusd, actual.freelancerDusd)
  eq("contract dUSD", expected.contractDusd, actual.contractDusd)
  eq("client allowance", expected.clientAllowance, actual.clientAllowance)
  eq("operator allowance", expected.operatorAllowance, actual.operatorAllowance)
  if (!actual.solvent)
    out.push("contract is not solvent (balance < reserve + escrow)")
  return out
}

async function confirmBroadcast(plan: Plan, yes: boolean): Promise<void> {
  if (yes) return
  if (!process.stdin.isTTY)
    throw new Error("not a terminal: pass --yes to confirm non-interactively")
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(
      `Type BROADCAST to send ${plan.totalTransactions} transaction(s) on chain ${CHAIN_ID}: `
    )
    if (answer.trim() !== "BROADCAST")
      throw new Error("not confirmed; nothing was sent")
  } finally {
    rl.close()
  }
}

/** Seams for rehearsal and tests. The CLI never sets these. */
export interface ExecuteDeps {
  /**
   * Supplies wallet clients directly (for example impersonated accounts on a local fork) instead
   * of decrypting keystores and asking for confirmation. Everything else, including the plan,
   * the SDK calls, verification and stop-on-failure, is exactly the production path.
   */
  walletFor?: (signer: Signer) => ChainWalletClient
}

export async function execute(
  cfg: Config,
  args: Args,
  client: PublicClient,
  pre: PreflightResult,
  deps: ExecuteDeps = {}
): Promise<number> {
  const plan = pre.plan!
  const snapshot = pre.snapshot!
  const needed = (["client", "evaluator", "operator"] as const).filter(
    (s) => plan.txCountBySigner[s] > 0
  )
  let ctx: (signer: Signer) => WriteContext
  if (deps.walletFor) {
    const walletFor = deps.walletFor
    line(`Signers: injected wallets (rehearsal), ${needed.join(", ")}`)
    ctx = (signer) => ({ wallet: walletFor(signer), publicClient: client })
  } else {
    const accounts = await loadSigners(cfg, needed)
    line(
      `Signers verified: ${needed.map((s) => `${s} ${cfg.addresses[s]}`).join(", ")}`
    )
    await confirmBroadcast(plan, args.yes)
    ctx = (signer) => ({
      wallet: createWalletClient({
        account: accounts.get(signer)!,
        chain: xrplEvmTestnet,
        transport: http(cfg.rpcUrl, { retryCount: 0 }), // a state-changing request is never resent
      }),
      publicClient: client,
    })
  }

  const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`
  const metadataHash = keccak256(
    stringToHex(`duely-integration-terms:v1:${runId}`)
  )
  let invoiceId: bigint | undefined
  // Waiting for and reading at the RECEIPT block (never "latest") means a lagging or load-balanced
  // RPC, or a cached head, cannot hand us state from before the confirmed transaction.
  const verifyAt = (
    block: bigint,
    compare: (state: LiveState) => string[]
  ): Promise<LiveState> =>
    verifyAtBlock({
      block,
      waitForBlock: (b) => waitForBlock(b, { client, timeoutMs: 30_000 }),
      read: (b) => readState(cfg, client, invoiceId, b),
      compare,
      options: { attempts: 3 },
    })
  const checkpointVerify =
    (stepId: string) => async (confirmed: ConfirmedTransaction) => {
      const step = plan.steps.find((s) => s.id === stepId)!
      await verifyAt(confirmed.blockNumber, (state) =>
        mismatches(step.checkpoint, state)
      )
    }

  const runnable: RunStep[] = plan.steps.map((step) => {
    const base = { id: step.id, label: step.label, signer: step.signer }
    switch (step.id) {
      case "createInvoice":
        return {
          ...base,
          submit: () =>
            createInvoice(
              {
                freelancer: cfg.addresses.freelancer,
                amount: plan.amount,
                metadataHash,
              },
              ctx("client")
            ),
          verify: async (confirmed: ConfirmedTransaction) => {
            if (!confirmed.invoiceId)
              throw new Error("confirmation carried no invoice id")
            invoiceId = BigInt(confirmed.invoiceId)
            if (
              pre.nextInvoiceId !== undefined &&
              invoiceId !== pre.nextInvoiceId
            ) {
              line(
                `   note: invoice id ${invoiceId} differs from the preflight prediction ${pre.nextInvoiceId} (another invoice was created meanwhile); continuing with the verified id`
              )
            }
            line(`   new invoice #${invoiceId}`)
            await checkpointVerify(step.id)(confirmed)
          },
        }
      case "approveEscrow":
        return {
          ...base,
          submit: () => approveEscrowAllowance(plan.amount, ctx("client")),
          verify: checkpointVerify(step.id),
        }
      case "fundInvoice":
        return {
          ...base,
          submit: () => fundInvoice(invoiceId!, ctx("client")),
          verify: checkpointVerify(step.id),
        }
      case "operatorApprove":
        return {
          ...base,
          submit: () =>
            approveEscrowAllowance(plan.reserveShortfall, ctx("operator")),
          verify: checkpointVerify(step.id),
        }
      case "depositReserve":
        return {
          ...base,
          submit: () => depositReserve(plan.reserveShortfall, ctx("operator")),
          verify: checkpointVerify(step.id),
        }
      case "approveAdvance":
        return {
          ...base,
          submit: () =>
            approveAdvance(
              invoiceId!,
              keccak256(
                stringToHex(`duely-integration-eval:${invoiceId}:${runId}`)
              ),
              ctx("evaluator")
            ),
          verify: checkpointVerify(step.id),
        }
      case "approveCompletion":
        return {
          ...base,
          submit: () => approveCompletion(invoiceId!, ctx("client")),
          verify: checkpointVerify(step.id),
        }
    }
  })

  line()
  line(`== Executing ${runnable.length} transaction(s) (run ${runId}) ==`)
  const outcome = await runSteps(runnable, {
    track: (submitted) =>
      trackTransaction(submitted, { publicClient: client, timeoutMs: 180_000 }),
    log: line,
  })

  const records = outcome.records
  const lastBlock = records.length
    ? BigInt(records[records.length - 1].blockNumber!)
    : undefined

  // Final verification, only if every step passed its own checks: the last step's checkpoint is the
  // plan's final state, read at that transaction's receipt block.
  let after: LiveState | undefined
  let finalFailure: VerificationError | undefined
  if (!outcome.failure && lastBlock !== undefined) {
    try {
      after = await verifyAt(lastBlock, (state) =>
        mismatches(plan.final, state)
      )
    } catch (error) {
      if (!(error instanceof VerificationError)) throw error
      finalFailure = error
    }
  } else if (lastBlock !== undefined) {
    // Best effort, for the summary only.
    after = await readState(cfg, client, invoiceId, lastBlock).catch(
      () => undefined
    )
  }

  const verdict = classifyOutcome(
    finalFailure
      ? {
          records,
          failure: {
            stepId: "final",
            label: "final verification",
            state:
              finalFailure.kind === "unavailable"
                ? "verification_unavailable"
                : "verification_failed",
            message: finalFailure.message,
            transactionConfirmed: true,
          },
        }
      : outcome
  )

  const report = {
    runId,
    chainId: CHAIN_ID,
    invoiceId: invoiceId?.toString(10) ?? null,
    amount: plan.amount.toString(10),
    advance: plan.advance.toString(10),
    outcome: verdict.kind,
    passed: verdict.kind === "passed",
    transactionsConfirmed: records.length,
    verifiedAtBlock: lastBlock?.toString(10) ?? null,
    steps: records,
    failure:
      outcome.failure ??
      (finalFailure
        ? {
            state: `verification_${finalFailure.kind === "unavailable" ? "unavailable" : "failed"}`,
            message: finalFailure.message,
            transactionConfirmed: true,
          }
        : null),
    before: {
      reserve: snapshot.reserveBalance.toString(10),
      escrow: snapshot.totalEscrow.toString(10),
      client: snapshot.clientDusd.toString(10),
      freelancer: snapshot.freelancerDusd.toString(10),
    },
    after: after && {
      invoiceStatus: after.invoiceStatus,
      reserve: after.reserve.toString(10),
      escrow: after.escrow.toString(10),
      client: after.clientDusd.toString(10),
      freelancer: after.freelancerDusd.toString(10),
      solvent: after.solvent,
    },
  }
  if (args.reportPath) {
    mkdirSync(dirname(args.reportPath), { recursive: true })
    writeFileSync(args.reportPath, JSON.stringify(report, null, 2) + "\n")
  }

  line()
  if (verdict.kind === "confirmed_unverified") {
    printConfirmedUnverified({
      detail: outcome.failure ?? {
        stepId: "final",
        label: "final verification",
        state: report.failure!.state,
        message: report.failure!.message,
        transactionConfirmed: true,
      },
      records,
      lastBlock,
      invoiceId,
      invoiceStatus: after?.invoiceStatus,
      finishedAllSteps: outcome.failure === undefined,
    })
    return verdict.exitCode
  }
  if (outcome.failure) {
    const f = outcome.failure
    line(`== STOPPED at "${f.label}" (${f.state}) ==`)
    line(f.message)
    if (f.explorerUrl) line(`Explorer: ${f.explorerUrl}`)
    line(
      `Invoice: ${invoiceId ? `#${invoiceId} is currently ${after?.invoiceStatus ?? "unknown"}` : "none was created"}`
    )
    line(
      "Nothing was retried. Inspect the state above before doing anything else:"
    )
    line(
      "  - not_submitted: that step sent nothing; earlier steps' effects remain."
    )
    line(
      "  - unknown / replaced / reverted / unverified: check the explorer link first; never resubmit blindly."
    )
    line(
      "  - a Created invoice can be cancelled by the client; a Funded or Advanced one can be settled or disputed by the client."
    )
    return verdict.exitCode
  }

  line(`== Final on-chain verification (state read at block ${lastBlock}) ==`)
  line(
    `Invoice #${invoiceId} is ${after!.invoiceStatus}; advance ${dusd(plan.advance)} paid and repaid`
  )
  line(
    `client ${dusd(after!.clientDusd)}, freelancer ${dusd(after!.freelancerDusd)}, reserve ${dusd(after!.reserve)}, escrow ${dusd(after!.escrow)}, solvent`
  )
  line()
  line("Transactions:")
  for (const r of records) {
    line(
      `  ${r.functionName.padEnd(18)} [${r.signer}] block ${r.blockNumber} ${r.state}\n    ${r.hash}\n    ${r.explorerUrl}`
    )
  }
  line()
  line("INTEGRATION TEST PASSED")
  return verdict.exitCode
}

/**
 * The wording for "the transaction is final, but the follow-up state check could not be completed
 * or disagreed". Deliberately never says the transaction failed: the receipt-verified event proves
 * it ran, and the state check is a separate, retryable read.
 */
function printConfirmedUnverified(args: {
  detail: {
    label: string
    state: string
    message: string
    hash?: string
    explorerUrl?: string
  }
  records: StepRecord[]
  lastBlock: bigint | undefined
  invoiceId: bigint | undefined
  invoiceStatus: string | undefined
  finishedAllSteps: boolean
}): void {
  const unavailable = args.detail.state === "verification_unavailable"
  line(
    args.finishedAllSteps
      ? "== ALL TRANSACTIONS CONFIRMED - BUT THE FINAL STATE CHECK DID NOT PASS =="
      : `== STOPPED AFTER A CONFIRMED TRANSACTION ("${args.detail.label}") - THE STATE CHECK DID NOT PASS ==`
  )
  line(
    "This is NOT a failed or reverted transaction. Every transaction below is confirmed on-chain, with its expected event verified from the receipt."
  )
  line(
    unavailable
      ? "The follow-up read of the contract state could not be completed (RPC unavailable or behind); the state is simply not yet checked."
      : "The follow-up read of the contract state, taken at the receipt block, disagreed with the plan; investigate before relying on the result."
  )
  line(args.detail.message)
  for (const r of args.records) {
    line(
      `  confirmed: ${r.functionName.padEnd(18)} [${r.signer}] block ${r.blockNumber}  ${r.hash}`
    )
    if (r.evidence) {
      line(
        `             receipt evidence: ${r.evidence.eventName} ${Object.entries(
          r.evidence.args
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`
      )
    }
  }
  if (args.detail.explorerUrl) line(`Explorer: ${args.detail.explorerUrl}`)
  line(
    `Invoice: ${args.invoiceId ? `#${args.invoiceId} status ${args.invoiceStatus ?? "not read"}${args.lastBlock !== undefined ? ` (at block ${args.lastBlock})` : ""}` : "none was created"}`
  )
  line(
    "Nothing was retried. Next: re-run the read-only check, which reads fresh state:"
  )
  line("  npm run chain:integration")
  line(
    args.finishedAllSteps
      ? "Exit code 3 = transactions confirmed, state check inconclusive."
      : "The remaining steps were not run. Exit code 3 = last transaction confirmed, state check inconclusive."
  )
}
