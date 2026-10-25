import type { PGlite } from "@electric-sql/pglite"
import { createSignerFromWallet } from "@/lib/backend/advance-signer"
import { createDb } from "./db"
import { Clock, FakeObjectStore, createPgEvidenceDb } from "./evidence"
import { ctx as handlerCtx, createPgBackendDb, ScriptedEvaluator } from "./backend"
import { createChainAdapter, createChainFundingVerifier } from "@/lib/backend/chain-adapter"
import { handleAdvance, handleCreateInvoice, handleEvaluate, handleGetAdvance, handleGetInvoice, handleListInvoices, handleOperatorInvoices } from "@/lib/backend/handlers"
import type { BackendDeps } from "@/lib/backend/ports"
import { activeDeploymentScope } from "@/lib/backend/scope"
import { EvidenceUploadError } from "@/lib/evidence/upload-client"
import { EvidenceError, initUpload, registerSubmission } from "@/lib/evidence/service"
import { ApiDuelyRepository, type ApiRepositoryDeps, type WalletPort } from "@/lib/frontend/api-repository"
import { TxLog } from "@/lib/frontend/tx-log"
import { connectWallet, readWalletState, requireWallet } from "@/lib/frontend/wallet-chain"
import { ADDR, createSimulatedChain } from "./sim-contract"
import type { SimOptions } from "./sim-contract"

/**
 * One consistent world for the wallet-flow tests: a real Postgres schema (PGlite), the real backend handlers and chain
 * adapter, the real browser repository + wallet gate, all talking to ONE simulated chain. Only the network, MetaMask's UI and
 * the contract's Solidity are replaced by test doubles.
 */
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
export const U = { client: id(1), freelancer: id(2), operator: id(3), stranger: id(4) }
export const WALLET = { client: ADDR.client.toLowerCase(), freelancer: ADDR.freelancer.toLowerCase(), operator: ADDR.operator.toLowerCase(), stranger: ADDR.stranger.toLowerCase() }

export class MemoryStorage {
  data = new Map<string, string>()
  getItem(k: string) {
    return this.data.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.data.set(k, v)
  }
}

export async function createWorld(simOptions: SimOptions & { tokenPaused?: boolean } = {}) {
  const scope = activeDeploymentScope()
  const db: PGlite = await createDb()
  for (const [k, uid] of Object.entries(U)) await db.query("insert into auth.users (id, email) values ($1,$2)", [uid, `${k}@t.invalid`])
  for (const [k, uid] of Object.entries(U)) {
    await db.query("insert into user_wallets (user_id, address, verified_at, verification_method) values ($1,$2,now(),'eip191')", [uid, WALLET[k as keyof typeof WALLET]])
  }
  const { chain, sim } = createSimulatedChain({
    ...simOptions,
    balances: { [WALLET.client]: BigInt(60_000_000), [WALLET.operator]: BigInt(20_000_000), [WALLET.freelancer]: BigInt(0) },
  })
  const store = new FakeObjectStore(new Clock())
  const evaluator = new ScriptedEvaluator()
  const adapter = createChainAdapter({ scope, client: chain.publicClient as never })
  const deps: BackendDeps = {
    scope,
    db: createPgBackendDb(db),
    objects: store,
    chain: adapter,
    signer: createSignerFromWallet({ wallet: chain.walletFor(ADDR.evaluator), address: ADDR.evaluator as `0x${string}`, publicClient: chain.publicClient, scope }),
    evaluator,
    confirmWaitMs: 2000,
  }

  /** Which MetaMask account is selected and on which network. Tests change this to simulate the user switching. */
  const wallet = { account: ADDR.client as string, chainId: 1449000 }
  const provider = () => chain.providerFor(wallet.account, { chainId: wallet.chainId })
  const walletPort: WalletPort = {
    require: (o) => requireWallet({ ...o, provider: provider(), publicClient: chain.publicClient }),
    state: () => readWalletState(provider()),
    connect: () => connectWallet(provider()),
    switchNetwork: async () => {
      wallet.chainId = 1449000
      return readWalletState(provider())
    },
    watch: () => () => undefined,
  }

  /** The browser's fetch, routed to the real handlers for the signed-in user. */
  const shim = (getUser: () => string | null, hooks: { failRegistration?: () => boolean } = {}): typeof fetch => async (input, init) => {
    const url = new URL(String(input), "http://localhost:3000")
    const method = (init?.method ?? "GET").toUpperCase()
    const headers = new Headers(init?.headers as HeadersInit)
    if (method !== "GET") headers.set("origin", "http://localhost:3000")
    const req = new Request(url, { method, headers, body: (init?.body as string | undefined) ?? undefined })
    const user = getUser()
    const c = handlerCtx(user, deps)
    if (url.pathname === "/api/auth/session") {
      const wallets = user ? await deps.db.verifiedAddresses(user) : []
      return Response.json({ authenticated: !!user, userId: user, wallets })
    }
    if (url.pathname === "/api/invoices" && method === "GET") return handleListInvoices(req, c)
    if (url.pathname === "/api/invoices" && method === "POST") {
      if (hooks.failRegistration?.()) return Response.json({ error: { code: "INTEGRATION_UNAVAILABLE", message: "The server is restarting." } }, { status: 503 })
      return handleCreateInvoice(req, c)
    }
    const inv = url.pathname.match(/^\/api\/invoices\/([^/]+)$/)
    if (inv) return handleGetInvoice(req, c, { id: decodeURIComponent(inv[1]) })
    const adv = url.pathname.match(/^\/api\/advances\/([^/]+)$/)
    if (adv) return handleGetAdvance(req, c, { id: adv[1] })
    if (url.pathname === "/api/advances") return handleAdvance(req, c)
    if (url.pathname === "/api/evaluate") return handleEvaluate(req, c)
    if (url.pathname === "/api/operator/invoices") return handleOperatorInvoices(req, c)
    return Response.json({ error: { code: "NOT_FOUND", message: "no route" } }, { status: 404 })
  }

  /** Evidence upload through the REAL evidence service with the REAL chain-backed funding check (no Storage network hop). */
  const uploader = (getUser: () => string | null): NonNullable<ApiRepositoryDeps["uploadEvidence"]> =>
    (async ({ invoiceId, file, note }: { invoiceId: string; file: File; note?: string }) => {
      const evDeps = { scope, db: createPgEvidenceDb(db), objects: store, chain: createChainFundingVerifier(adapter), requireChainVerification: true }
      try {
        const grant = await initUpload(evDeps, { userId: getUser(), invoiceId, fileName: file.name, fileSize: file.size, mimeType: file.type })
        store.upload(grant.uploadToken, new Uint8Array(await file.arrayBuffer()), file.type)
        const { submission, duplicate } = await registerSubmission(evDeps, { userId: getUser(), invoiceId, storagePath: grant.path, fileName: file.name, note })
        return { submissionId: submission.id, invoiceId: submission.invoice_uuid, fileName: submission.file_name, fileSize: submission.file_size, mimeType: submission.mime_type, createdAt: submission.created_at, fundingVerifiedOnchain: submission.funding_verified_onchain, duplicate, storagePath: grant.path }
      } catch (e) {
        if (e instanceof EvidenceError) throw new EvidenceUploadError(e.code, e.message)
        throw e
      }
    }) as never

  const storage = new MemoryStorage()
  const repoFor = (user: string | null, extra: Partial<ApiRepositoryDeps> & { failRegistration?: () => boolean } = {}) =>
    new ApiDuelyRepository({
      fetch: shim(() => user, { failRegistration: extra.failRegistration }),
      uploadEvidence: uploader(() => user),
      storage: null,
      signIn: async () => undefined,
      signOut: async () => undefined,
      wallet: walletPort,
      txLog: new TxLog(storage),
      readClient: chain.publicClient,
      sleep: async () => undefined,
      txTimeoutMs: 400,
      ...extra,
    })

  return { scope, db, chain, sim, store, evaluator, deps, wallet, repoFor, storage, close: () => db.close() }
}

export type World = Awaited<ReturnType<typeof createWorld>>

export const CRITERIA = [
  { text: "Logo delivered in SVG and PNG", mandatory: true },
  { text: "Source files included", mandatory: false },
]
/** 1 dUSD in base units (the default deployment has 6 decimals). */
export const ONE = BigInt(1_000_000)
export const input = (amount = ONE, over: Record<string, unknown> = {}) => ({
  title: "Brand identity",
  freelancer: ADDR.freelancer as `0x${string}`,
  amount: amount.toString(),
  description: "Logo and brand guidelines",
  criteria: CRITERIA,
  ...over,
})
