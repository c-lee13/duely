// Browser-safe entry point. Server-only helpers live in ./server (import it directly).
export * from "./config"
export * from "./amounts"
export * from "./client"
export * from "./errors"
export * from "./reads"

// Writes: an explicit list so internals shared with ./lifecycle stay private.
export {
  WRITE_REQUIREMENTS,
  approveAdvance,
  approveCompletion,
  approveEscrowAllowance,
  approveToken,
  cancelInvoice,
  createInvoice,
  depositReserve,
  fundInvoice,
  getAllowanceStatus,
  prepareDepositReserve,
  prepareFundInvoice,
  raiseDispute,
  resolveDispute,
  revokeTokenApproval,
  submissionGuard,
  withdrawReserve,
} from "./writes"
export type {
  AllowanceStatus,
  ApproveTokenInput,
  ChainWalletClient,
  ChainWriteClient,
  CreateInvoiceInput,
  DepositReserveReadiness,
  ExpectedReceipt,
  FundInvoiceReadiness,
  SignerRole,
  SubmittedTransaction,
  WriteContext,
} from "./writes"

// Transaction lifecycle: track what a write did, safely.
export {
  decodeInvoiceAdvanceEvents,
  getInvoiceIdFromReceipt,
  getTransactionStatus,
  isTerminalStatus,
  parseSubmittedTransaction,
  serializeSubmittedTransaction,
  trackTransaction,
  waitForConfirmation,
} from "./lifecycle"
export type {
  ConfirmedTransaction,
  InvoiceAdvanceEvent,
  InvoiceCreatedFilter,
  MatchedEvent,
  PendingStatus,
  ReplacedStatus,
  RevertedStatus,
  TrackOptions,
  TransactionState,
  TransactionStatus,
  UnknownStatus,
  UnverifiedStatus,
  WaitOptions,
} from "./lifecycle"
export { tokenPauseAbi } from "./token-pause"
export { EXPECTED_EVENTS } from "./expected"
export type { WriteFunctionName } from "./expected"

export {
  invoiceAdvanceAbi,
  mockUsdcAbi,
  paymentTokenAbi,
  deployments as generatedDeployments,
} from "./generated"
export * from "./deployments"

// v2 protocol: DuelyVault LP operations, pull-payment claims, quotes and event decoding.
export {
  activeProtocol,
  duelyVaultAbi,
  escrowAbi,
  invoiceAdvanceV2Abi,
  isV2,
  vaultAddress,
  vaultInfo,
} from "./protocol"
export {
  approveVaultAllowance,
  claimProceeds,
  decodeV2Events,
  depositToVault,
  getClaimable,
  getEscrowTotals,
  getLpPosition,
  getVaultAdvance,
  getVaultSnapshot,
  previewDeposit,
  quoteAdvance,
  redeemFromVault,
  withdrawFromVault,
} from "./vault"
export type {
  AdvanceQuote,
  DecodedV2Event,
  EscrowTotals,
  LpPosition,
  V2ActivityEvent,
  VaultAdvanceRecord,
  VaultSnapshot,
} from "./vault"
export { V2_ONLY_FUNCTIONS } from "./expected"
