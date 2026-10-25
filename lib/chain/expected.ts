/**
 * The on-chain evidence that proves each write operation actually ran. One table, shared by the
 * write helpers (which attach it to every SubmittedTransaction), the receipt verifier, and the
 * (de)serializer used to resume tracking after a page reload. Its event and argument names are
 * checked against the generated ABI and docs/CONTRACT_SPEC.md §6 by tests.
 */

/** The on-chain evidence for one submitted transaction (checked by the lifecycle helpers). */
export interface ExpectedReceipt {
  contract: "invoiceAdvance" | "paymentToken"
  eventName: string
  /** Decoded event args that must match (addresses compare case-insensitively). */
  args: Record<string, string | bigint | boolean>
}

export const EXPECTED_EVENTS = {
  createInvoice: {
    contract: "invoiceAdvance",
    eventName: "InvoiceCreated",
    args: ["client", "freelancer", "amount", "metadataHash"],
  },
  cancelInvoice: {
    contract: "invoiceAdvance",
    eventName: "InvoiceCancelled",
    args: ["invoiceId"],
  },
  fundInvoice: {
    contract: "invoiceAdvance",
    eventName: "InvoiceFunded",
    args: ["invoiceId", "client"],
  },
  approveCompletion: {
    contract: "invoiceAdvance",
    eventName: "InvoiceSettled",
    args: ["invoiceId"],
  },
  raiseDispute: {
    contract: "invoiceAdvance",
    eventName: "InvoiceDisputed",
    args: ["invoiceId", "client"],
  },
  resolveDispute: {
    contract: "invoiceAdvance",
    eventName: "DisputeResolved",
    args: ["invoiceId", "releasedToFreelancer"],
  },
  approveAdvance: {
    contract: "invoiceAdvance",
    eventName: "AdvancePaid",
    args: ["invoiceId", "evaluationHash"],
  },
  depositReserve: {
    contract: "invoiceAdvance",
    eventName: "ReserveDeposited",
    args: ["operator", "amount"],
  },
  withdrawReserve: {
    contract: "invoiceAdvance",
    eventName: "ReserveWithdrawn",
    args: ["operator", "amount"],
  },
  approve: {
    contract: "paymentToken",
    eventName: "Approval",
    args: ["owner", "spender", "value"],
  },
} as const satisfies Record<
  string,
  {
    contract: ExpectedReceipt["contract"]
    eventName: string
    args: readonly string[]
  }
>

export type WriteFunctionName = keyof typeof EXPECTED_EVENTS

export function isWriteFunctionName(value: string): value is WriteFunctionName {
  return Object.prototype.hasOwnProperty.call(EXPECTED_EVENTS, value)
}

/** What kind of value each expected-event argument holds (used to validate stored data). */
export const ARG_KINDS = {
  client: "address",
  freelancer: "address",
  operator: "address",
  owner: "address",
  spender: "address",
  metadataHash: "bytes32",
  evaluationHash: "bytes32",
  invoiceId: "uint",
  amount: "uint",
  value: "uint",
  releasedToFreelancer: "bool",
} as const

/** Builds the expected evidence for an operation; the argument set must match the table exactly. */
export function expectedFor(
  functionName: WriteFunctionName,
  args: ExpectedReceipt["args"]
): ExpectedReceipt {
  const spec = EXPECTED_EVENTS[functionName]
  const given = Object.keys(args).sort().join(",")
  const wanted = [...spec.args].sort().join(",")
  if (given !== wanted) {
    throw new Error(
      `expected-event arguments for ${functionName} must be [${wanted}], got [${given}]`
    )
  }
  return { contract: spec.contract, eventName: spec.eventName, args }
}
