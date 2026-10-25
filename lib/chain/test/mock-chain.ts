import {
  createPublicClient,
  decodeFunctionData,
  custom,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  toHex,
  type Abi,
  type EIP1193Provider,
  type Hex,
} from "viem"

import {
  createWalletClientFromProvider,
  type ChainPublicClient,
} from "../client"
import { contractAddresses, xrplEvmTestnet } from "../config"
import { invoiceAdvanceAbi, mockUsdcAbi } from "../generated"
import { tokenPauseAbi } from "../token-pause"
import { ROLE_IDS } from "../reads"
import type { ChainWalletClient, ChainWriteClient } from "../writes"

/**
 * Test-only in-memory XRPL EVM chain. A real viem public client and real viem wallet clients run
 * on top of mock transports; eth_call evaluates InvoiceAdvance's authorization and status rules
 * so simulations revert the way the deployed contract would. Every JSON-RPC request is recorded.
 */

const B = (n: number | string) => BigInt(n)
const PAUSED_SELECTOR = "0x5c975abb"
const IA = contractAddresses.invoiceAdvance.toLowerCase()
const DECODE_ABI = [
  ...invoiceAdvanceAbi,
  ...mockUsdcAbi.filter((x) => x.type === "error"),
  ...tokenPauseAbi.filter((x) => x.type === "error"),
] as Abi

export const ADDR = {
  client: "0x8d93eD20e6eD28c34aE0057f441ED97d3e63459E",
  freelancer: "0x02379033ECD642D9A9aA590ABe763D62AEa967F4",
  operator: "0x6e83F6Bb6758Ced46e60be88271D72C22B84482E",
  evaluator: "0x276acaB037BB048a682E0E7ad900F3fFDCe65ECb",
  stranger: "0x1111111111111111111111111111111111111111",
} as const

export const META = ("0x" + "11".repeat(32)) as Hex
export const EVAL = ("0x" + "22".repeat(32)) as Hex

export interface MockInvoice {
  freelancer: string
  client: string
  amount: bigint
  advanceAmount: bigint
  metadataHash: Hex
  evaluationHash: Hex
  status: number
}

export interface ChainState {
  nextInvoiceId: bigint
  invoices: Map<bigint, MockInvoice>
  reserve: bigint
  escrow: bigint
  balances: Map<string, bigint>
  allowances: Map<string, bigint>
  operators: Set<string>
  evaluators: Set<string>
}

export type SendMode = "ok" | "reject" | "fail" | "hold"

export interface MockChainOptions {
  /** chain id reported by the RPC endpoint (public client). */
  rpcChainId?: number
  /** function names whose eth_call fails with a network error containing a secret URL. */
  failCallsFor?: string[]
  /**
   * Makes the payment token pausable (RLUSD-like): `paused()` answers with this value and approvals
   * and pulls revert with EnforcedPause while true. Undefined (default) behaves like MockUSDC,
   * which has no `paused()`.
   */
  tokenPaused?: boolean
  /** With tokenPaused unset: answer `paused()` like a real node does for a token that lacks it (revert, no data). */
  tokenPauseRevertsEmpty?: boolean
}

export interface RpcRecord {
  method: string
  functionName?: string
  from?: string
}

function mk(
  status: number,
  amount = B(1000000000),
  advance = B(0)
): MockInvoice {
  return {
    freelancer: ADDR.freelancer,
    client: ADDR.client,
    amount,
    advanceAmount: advance,
    metadataHash: META,
    evaluationHash: advance > B(0) ? EVAL : (`0x${"00".repeat(32)}` as Hex),
    status,
  }
}

export function initialState(): ChainState {
  return {
    nextInvoiceId: B(6),
    invoices: new Map([
      [B(1), mk(0)], // Created
      [B(2), mk(1)], // Funded
      [B(3), mk(2, B(1000000000), B(900000000))], // Advanced
      [B(4), mk(4)], // Disputed
      [B(5), mk(3, B(1000000000), B(900000000))], // Settled
    ]),
    reserve: B(10000000000),
    escrow: B(3000000000),
    balances: new Map([
      [ADDR.client.toLowerCase(), B(5000000000)],
      [ADDR.operator.toLowerCase(), B(20000000000)],
    ]),
    allowances: new Map(),
    operators: new Set([ADDR.operator.toLowerCase()]),
    evaluators: new Set([ADDR.evaluator.toLowerCase()]),
  }
}

export function allowanceKey(owner: string, spender: string): string {
  return `${owner.toLowerCase()}:${spender.toLowerCase()}`
}

class Revert extends Error {
  code = 3
  data: Hex
  constructor(abi: Abi, errorName: string, args: readonly unknown[] = []) {
    super("execution reverted")
    this.data = encodeErrorResult({ abi, errorName, args } as never)
  }
}

export interface RpcTx {
  hash: string
  nonce: string
  blockHash: string | null
  blockNumber: string | null
  transactionIndex: string | null
  from: string
  to: string | null
  value: string
  gas: string
  gasPrice: string
  input: Hex
  type: string
  v: string
  r: string
  s: string
}

/** A log (address, topics, data) usable in both JSON-RPC receipts and viem-formatted receipts. */
export function eventLog(
  contract: "invoiceAdvance" | "paymentToken",
  eventName: string,
  args: Record<string, unknown>
) {
  const abi = (
    contract === "invoiceAdvance" ? invoiceAdvanceAbi : mockUsdcAbi
  ) as Abi
  const item = abi.find((x) => x.type === "event" && x.name === eventName)
  if (!item || item.type !== "event") throw new Error(`no event ${eventName}`)
  const indexed = item.inputs.filter((i) => i.indexed)
  const plain = item.inputs.filter((i) => !i.indexed)
  const topics = encodeEventTopics({
    abi,
    eventName,
    args: Object.fromEntries(
      indexed.map((i) => [i.name, args[i.name as string]])
    ),
  } as never)
  const data = encodeAbiParameters(
    plain as never,
    plain.map((i) => args[i.name as string]) as never
  )
  const address =
    contract === "invoiceAdvance"
      ? contractAddresses.invoiceAdvance
      : contractAddresses.paymentToken
  return { address, topics: topics as Hex[], data }
}

export function createMockChain(options: MockChainOptions = {}) {
  const state = initialState()
  const rpc: RpcRecord[] = []
  const walletRequests: { method: string; params?: unknown }[] = []
  const sent: { from: string; to: string; data: Hex }[] = []
  let hashCounter = 0
  const sentByHash = new Map<string, { from: string; to: string; data: Hex }>()
  const receipts = new Map<string, unknown>() // lowercase tx hash -> JSON-RPC receipt
  const rpcTxs = new Map<string, RpcTx>() // lowercase tx hash -> JSON-RPC transaction
  const blocks = new Map<number, RpcTx[]>() // block number -> transactions
  let hold: Promise<void> = Promise.resolve()
  let release: () => void = () => {}

  const send = {
    mode: "ok" as SendMode,
    attempts: 0,
    holdNext() {
      hold = new Promise<void>((resolve) => {
        release = resolve
      })
      send.mode = "hold"
    },
    release() {
      send.mode = "ok"
      release()
    },
  }

  // ---- public RPC (eth_call evaluates the contract) ----
  const publicTransport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_chainId") {
          rpc.push({ method })
          return toHex(options.rpcChainId ?? xrplEvmTestnet.id)
        }
        if (method === "eth_blockNumber") {
          rpc.push({ method })
          return toHex(500)
        }
        if (method === "eth_getTransactionReceipt") {
          rpc.push({ method })
          return (
            receipts.get(String((params as string[])[0]).toLowerCase()) ?? null
          )
        }
        if (method === "eth_getTransactionByHash") {
          rpc.push({ method })
          return (
            rpcTxs.get(String((params as string[])[0]).toLowerCase()) ?? null
          )
        }
        if (method === "eth_getBlockByNumber") {
          rpc.push({ method })
          const number = Number((params as string[])[0])
          return {
            number: toHex(number),
            hash: "0x" + "ab".repeat(32),
            parentHash: "0x" + "cd".repeat(32),
            timestamp: toHex(1700000000),
            transactions: blocks.get(number) ?? [],
          }
        }
        if (method !== "eth_call")
          throw new Error(`unexpected public method ${method}`)

        const [{ from, to, data }] = params as [
          { from?: string; to: string; data: Hex },
        ]
        const isIa = to.toLowerCase() === IA
        if (!isIa && data.toLowerCase().startsWith(PAUSED_SELECTOR)) {
          rpc.push({ method, functionName: "paused", from })
          if (options.tokenPaused === undefined) {
            if (options.tokenPauseRevertsEmpty) {
              throw Object.assign(new Error("execution reverted"), {
                code: 3,
                data: "0x",
              })
            }
            return "0x"
          }
          return encodeFunctionResult({
            abi: tokenPauseAbi,
            functionName: "paused",
            result: options.tokenPaused,
          })
        }
        const abi = isIa ? (DECODE_ABI as Abi) : (mockUsdcAbi as Abi)
        const { functionName, args = [] } = decodeFunctionData({
          abi,
          data,
        }) as {
          functionName: string
          args?: readonly unknown[]
        }
        rpc.push({ method, functionName, from })
        if (options.failCallsFor?.includes(functionName)) {
          throw new Error(
            "fetch failed https://secret-node.example/v2/TOP-SECRET-KEY"
          )
        }
        const encode = (result?: unknown) =>
          encodeFunctionResult({
            abi: abi as Abi,
            functionName: functionName as never,
            result: result as never,
          })
        return isIa
          ? callInvoiceAdvance(
              functionName,
              args,
              (from ?? "").toLowerCase(),
              encode
            )
          : callToken(functionName, args, encode)
      },
    },
    { retryCount: 0 }
  )
  const publicClient = createPublicClient({
    chain: xrplEvmTestnet,
    transport: publicTransport,
    pollingInterval: 5,
  })

  function invoiceOrRevert(id: bigint): MockInvoice {
    const inv = state.invoices.get(id)
    if (!inv)
      throw new Revert(invoiceAdvanceAbi as Abi, "InvoiceNotFound", [id])
    return inv
  }
  function asClient(id: bigint, from: string): MockInvoice {
    const inv = invoiceOrRevert(id)
    if (inv.client.toLowerCase() !== from) {
      throw new Revert(invoiceAdvanceAbi as Abi, "NotInvoiceClient", [id])
    }
    return inv
  }
  function status(id: bigint, inv: MockInvoice, allowed: number[]) {
    if (!allowed.includes(inv.status)) {
      throw new Revert(invoiceAdvanceAbi as Abi, "InvalidStatus", [
        id,
        inv.status,
      ])
    }
  }
  function role(set: Set<string>, roleId: Hex, from: string) {
    if (!set.has(from)) {
      throw new Revert(
        invoiceAdvanceAbi as Abi,
        "AccessControlUnauthorizedAccount",
        [from, roleId]
      )
    }
  }
  function pull(from: string, amount: bigint) {
    if (options.tokenPaused) {
      throw new Revert(tokenPauseAbi as unknown as Abi, "EnforcedPause")
    }
    const allowance = state.allowances.get(allowanceKey(from, IA)) ?? B(0)
    if (allowance < amount) {
      throw new Revert(mockUsdcAbi as Abi, "ERC20InsufficientAllowance", [
        IA,
        allowance,
        amount,
      ])
    }
    const balance = state.balances.get(from) ?? B(0)
    if (balance < amount) {
      throw new Revert(mockUsdcAbi as Abi, "ERC20InsufficientBalance", [
        from,
        balance,
        amount,
      ])
    }
  }

  function callInvoiceAdvance(
    fn: string,
    args: readonly unknown[],
    from: string,
    encode: (r?: unknown) => Hex
  ): Hex {
    const id = args[0] as bigint
    switch (fn) {
      case "createInvoice":
        return encode(state.nextInvoiceId)
      case "cancelInvoice": {
        const inv = asClient(id, from)
        status(id, inv, [0])
        return encode()
      }
      case "fundInvoice": {
        const inv = asClient(id, from)
        status(id, inv, [0])
        pull(from, inv.amount)
        return encode()
      }
      case "depositReserve": {
        role(state.operators, ROLE_IDS.operator, from)
        if ((args[0] as bigint) === B(0))
          throw new Revert(invoiceAdvanceAbi as Abi, "InvalidAmount")
        pull(from, args[0] as bigint)
        return encode()
      }
      case "withdrawReserve": {
        role(state.operators, ROLE_IDS.operator, from)
        const amount = args[0] as bigint
        if (amount > state.reserve) {
          throw new Revert(invoiceAdvanceAbi as Abi, "InsufficientReserve", [
            amount,
            state.reserve,
          ])
        }
        return encode()
      }
      case "approveAdvance": {
        role(state.evaluators, ROLE_IDS.evaluator, from)
        const inv = invoiceOrRevert(id)
        status(id, inv, [1])
        const advance = (inv.amount * B(9000)) / B(10000)
        if (advance > state.reserve) {
          throw new Revert(invoiceAdvanceAbi as Abi, "InsufficientReserve", [
            advance,
            state.reserve,
          ])
        }
        return encode()
      }
      case "approveCompletion": {
        const inv = asClient(id, from)
        status(id, inv, [1, 2])
        return encode()
      }
      case "raiseDispute": {
        const inv = asClient(id, from)
        status(id, inv, [1, 2])
        return encode()
      }
      case "resolveDispute": {
        role(state.operators, ROLE_IDS.operator, from)
        const inv = invoiceOrRevert(id)
        status(id, inv, [4])
        return encode()
      }
      case "getInvoice":
        return encode(invoiceOrRevert(id))
      case "nextInvoiceId":
        return encode(state.nextInvoiceId)
      case "reserveBalance":
      case "availableReserve":
        return encode(state.reserve)
      case "totalEscrow":
        return encode(state.escrow)
      case "hasRole": {
        const [roleId, account] = args as [Hex, string]
        const set =
          roleId === ROLE_IDS.operator
            ? state.operators
            : roleId === ROLE_IDS.evaluator
              ? state.evaluators
              : new Set<string>()
        return encode(set.has(account.toLowerCase()))
      }
      default:
        throw new Error(`mock: unhandled InvoiceAdvance.${fn}`)
    }
  }

  function callToken(
    fn: string,
    args: readonly unknown[],
    encode: (r?: unknown) => Hex
  ): Hex {
    switch (fn) {
      case "approve":
        if (options.tokenPaused) {
          throw new Revert(tokenPauseAbi as unknown as Abi, "EnforcedPause")
        }
        return encode(true)
      case "balanceOf":
        return encode(
          state.balances.get((args[0] as string).toLowerCase()) ?? B(0)
        )
      case "allowance":
        return encode(
          state.allowances.get(
            allowanceKey(args[0] as string, args[1] as string)
          ) ?? B(0)
        )
      default:
        throw new Error(`mock: unhandled token.${fn}`)
    }
  }

  // ---- wallets (eth_sendTransaction is recorded, never applied) ----
  function walletFor(
    address: string,
    opts: { chainId?: number } = {}
  ): ChainWalletClient & { sentFrom: () => number } {
    const provider = {
      async request({ method, params }: { method: string; params?: unknown }) {
        walletRequests.push({ method, params })
        if (method === "eth_chainId")
          return toHex(opts.chainId ?? xrplEvmTestnet.id)
        if (method === "eth_accounts") return [address]
        if (method === "eth_sendTransaction") {
          const [tx] = params as [{ from: string; to: string; data: Hex }]
          send.attempts += 1
          if (send.mode === "reject") {
            throw Object.assign(new Error("User rejected the request."), {
              code: 4001,
            })
          }
          if (send.mode === "fail") {
            throw Object.assign(
              new Error(
                "internal error fetch failed https://wallet-node.example/KEY"
              ),
              { code: -32603 }
            )
          }
          if (send.mode === "hold") await hold
          sent.push({ from: tx.from, to: tx.to, data: tx.data })
          hashCounter += 1
          const sentHash = "0x" + hashCounter.toString(16).padStart(64, "0")
          sentByHash.set(sentHash, { from: tx.from, to: tx.to, data: tx.data })
          return sentHash as Hex
        }
        throw new Error(`mock wallet: unexpected method ${method}`)
      },
    }
    const client = createWalletClientFromProvider(
      provider as unknown as EIP1193Provider,
      address as `0x${string}`
    )
    return Object.assign(client, {
      sentFrom: () =>
        sent.filter((t) => t.from.toLowerCase() === address.toLowerCase())
          .length,
    })
  }

  function rpcTxFor(
    hash: string,
    tx: { from: string; to: string | null; data: Hex; value?: bigint },
    nonce: number,
    gasPrice = 1000000000
  ): RpcTx {
    return {
      hash,
      nonce: toHex(nonce),
      blockHash: null,
      blockNumber: null,
      transactionIndex: null,
      from: tx.from,
      to: tx.to,
      value: toHex(tx.value ?? B(0)),
      gas: toHex(200000),
      gasPrice: toHex(gasPrice),
      input: tx.data,
      type: "0x0",
      v: "0x1b",
      r: "0x" + "11".repeat(32),
      s: "0x" + "22".repeat(32),
    }
  }

  function receiptJson(
    hash: string,
    from: string,
    to: string | null,
    status: "success" | "reverted",
    logs: { address: string; topics: Hex[]; data: Hex }[]
  ) {
    return {
      blockHash: "0x" + "ab".repeat(32),
      blockNumber: toHex(501),
      contractAddress: null,
      cumulativeGasUsed: toHex(21000),
      effectiveGasPrice: toHex(1000000000),
      from,
      gasUsed: toHex(21000),
      logs: logs.map((l, i) => ({
        ...l,
        blockHash: "0x" + "ab".repeat(32),
        blockNumber: toHex(501),
        logIndex: toHex(i),
        transactionHash: hash,
        transactionIndex: toHex(0),
        removed: false,
      })),
      logsBloom: "0x" + "00".repeat(256),
      status: status === "success" ? "0x1" : "0x0",
      to,
      transactionHash: hash,
      transactionIndex: toHex(0),
      type: "0x0",
    }
  }

  return {
    state,
    rpc,
    sentByHash,
    rpcTxs,
    blocks,
    rpcTxFor,
    receiptJson,
    /** Marks a transaction sent through a mock wallet as mined (default: success, no logs). */
    mine(
      hash: string,
      status: "success" | "reverted" = "success",
      logs: { address: string; topics: Hex[]; data: Hex }[] = []
    ) {
      const tx = sentByHash.get(hash)
      if (!tx) throw new Error(`mock: unknown tx ${hash}`)
      receipts.set(
        hash.toLowerCase(),
        receiptJson(hash, tx.from, tx.to, status, logs)
      )
    },
    /** Makes a sent transaction visible to the RPC as pending (known, not yet mined). */
    registerPending(hash: string, nonce = 7) {
      const tx = sentByHash.get(hash)
      if (!tx) throw new Error(`mock: unknown tx ${hash}`)
      rpcTxs.set(hash.toLowerCase(), rpcTxFor(hash, tx, nonce))
      return tx
    },
    /** Mines `replacement` at the same nonce in block 500 with a successful receipt. */
    placeReplacement(
      hash: string,
      replacement: { from: string; to: string; data: Hex },
      logs: { address: string; topics: Hex[]; data: Hex }[],
      options: { nonce?: number; gasPrice?: number } = {}
    ) {
      const tx = rpcTxFor(
        hash,
        replacement,
        options.nonce ?? 7,
        options.gasPrice
      )
      blocks.set(500, [
        {
          ...tx,
          blockHash: "0x" + "ab".repeat(32),
          blockNumber: "0x1f4",
          transactionIndex: "0x0",
        },
      ])
      receipts.set(
        hash.toLowerCase(),
        receiptJson(hash, replacement.from, replacement.to, "success", logs)
      )
    },
    /** Registers a raw JSON-RPC receipt (e.g. for a replacement transaction). */
    setReceipt(hash: string, json: unknown) {
      receipts.set(hash.toLowerCase(), json)
    },
    walletRequests,
    sent,
    send,
    publicClient: publicClient as unknown as ChainWriteClient &
      ChainPublicClient,
    walletFor,
    /** eth_call count for a given function (simulations and reads). */
    callsOf: (fn: string) => rpc.filter((r) => r.functionName === fn).length,
  }
}
