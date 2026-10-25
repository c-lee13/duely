/**
 * Row types for supabase/migrations. Hand-maintained to match the SQL; once a project is
 * linked, regenerate with `npx supabase gen types typescript --linked > lib/supabase/database.types.ts`.
 *
 * Amounts and uint256 ids are typed `string` (ERC-20 base units, never floats). The database stores
 * them as exact `numeric` integers, but PostgREST returns `numeric` as a JSON number, which is lossy
 * above 2^53. Server code MUST therefore select them as text (e.g. `select=amount::text`) or use an
 * RPC/view, and write them as decimal strings. Addresses are stored lower-case. `Json` columns hold
 * decoded receipts and ordered criterion results.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

type Address = `0x${string}`
type Bytes32 = `0x${string}`

export type OnchainStatusDb = "Created" | "Funded" | "Advanced" | "Disputed" | "Settled" | "Cancelled"
export type TxStatusDb = "pending" | "confirmed" | "failed"
export type TxActionDb =
  | "createInvoice"
  | "cancelInvoice"
  | "fundInvoice"
  | "depositReserve"
  | "withdrawReserve"
  | "approveAdvance"
  | "approveCompletion"
  | "raiseDispute"
  | "resolveDispute"
  // legacy names from the first draft; rows may still carry them (migration 9 keeps them valid)
  | "approveWork"
  | "disputeInvoice"
export type EvaluationStateDb = "running" | "completed" | "error"
export type AdvanceStatusDb = "pending" | "paid" | "failed" | "denied"

export type WalletVerificationMethodDb = "eip191" | "eip4361"

export type UserWalletRow = {
  id: string
  user_id: string
  address: Address
  /** null = unverified claim; only server code sets the verified_* columns. */
  verified_at: string | null
  verification_method: WalletVerificationMethodDb | null
  verification_nonce: string | null
  created_at: string
  updated_at: string
}

export type WalletChallengeRow = {
  nonce: string
  address: Address
  message: string
  expires_at: string
  used_at: string | null
  created_at: string
}

export type InvoiceRow = {
  id: string
  chain_id: number
  contract_address: Address
  token_address: Address
  invoice_id: string
  client_address: Address
  freelancer_address: Address
  amount: string
  criteria_hash: Bytes32
  criteria_version: number
  /** Frozen number of invoice_criteria rows; no more can ever be inserted. */
  criteria_count: number
  /** Exact canonical text that was hashed into criteria_hash (encoding owned by the integration owner). */
  criteria_canonical: string
  title: string
  description: string
  due_date: string | null
  create_tx_hash: Bytes32 | null
  registered_by: string
  /** CACHE of chain state; not authoritative. */
  onchain_status: OnchainStatusDb
  advance_amount: string
  chain_synced_at: string | null
  chain_synced_block: number | null
  created_at: string
  updated_at: string
}

export type InvoiceCriterionRow = {
  invoice_uuid: string
  position: number
  criterion_key: string
  text: string
  mandatory: boolean
  created_at: string
}

export type TransactionRow = {
  id: string
  invoice_uuid: string | null
  chain_id: number
  action: TxActionDb
  status: TxStatusDb
  from_address: Address
  amount: string | null
  tx_hash: Bytes32 | null
  block_number: number | null
  block_hash: Bytes32 | null
  block_timestamp: string | null
  log_index: number | null
  receipt: Json | null
  error: string | null
  simulated: boolean
  created_at: string
  confirmed_at: string | null
  updated_at: string
}

export type SubmissionRow = {
  id: string
  invoice_uuid: string
  freelancer_user_id: string
  freelancer_address: Address
  storage_path: string
  file_name: string
  file_size: number
  mime_type: string
  note: string
  /** true only when a trusted chain adapter confirmed funding at submission time. */
  funding_verified_onchain: boolean
  created_at: string
}

export type EvaluationRow = {
  id: string
  submission_id: string
  invoice_uuid: string
  criteria_hash: Bytes32
  criteria_version: number
  model: string
  prompt_version: string
  state: EvaluationStateDb
  score: number | null
  passed: boolean | null
  criteria_results: Json | null
  summary: string | null
  pass_rule: string
  simulated: boolean
  error_message: string | null
  created_at: string
  evaluated_at: string | null
}

export type AdvanceRequestRow = {
  id: string
  invoice_uuid: string
  requester_user_id: string
  requester_address: Address
  /** The submission this request relies on, and the evaluation OF that submission. */
  submission_id: string
  evaluation_id: string
  status: AdvanceStatusDb
  amount: string
  reason: string | null
  idempotency_key: string
  transaction_id: string | null
  created_at: string
  updated_at: string
}

type Table<Row, Required extends keyof Row> = {
  Row: Row
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>
  Update: Partial<Row>
  Relationships: []
}

export type Database = {
  public: {
    Tables: {
      user_wallets: Table<UserWalletRow, "user_id" | "address">
      wallet_challenges: Table<WalletChallengeRow, "nonce" | "address" | "message" | "expires_at">
      invoices: Table<
        InvoiceRow,
        | "chain_id" | "contract_address" | "token_address" | "invoice_id" | "client_address"
        | "freelancer_address" | "amount" | "criteria_hash" | "criteria_count" | "criteria_canonical" | "title" | "registered_by"
      >
      invoice_criteria: Table<InvoiceCriterionRow, "invoice_uuid" | "position" | "criterion_key" | "text" | "mandatory">
      transactions: Table<TransactionRow, "chain_id" | "action" | "from_address">
      submissions: Table<
        SubmissionRow,
        "invoice_uuid" | "freelancer_user_id" | "freelancer_address" | "storage_path" | "file_name" | "file_size" | "mime_type"
      >
      evaluations: Table<
        EvaluationRow,
        "submission_id" | "invoice_uuid" | "criteria_hash" | "criteria_version" | "model" | "prompt_version" | "pass_rule"
      >
      advance_requests: Table<
        AdvanceRequestRow,
        "invoice_uuid" | "requester_user_id" | "requester_address" | "submission_id" | "evaluation_id" | "amount" | "idempotency_key"
      >
    }
    Views: Record<string, never>
    Functions: {
      // Service-role-only wallet verification primitives (migration 20261024000004).
      create_wallet_challenge: {
        Args: { p_address: Address; p_nonce: string; p_message: string; p_expires_at: string }
        Returns: undefined
      }
      consume_wallet_challenge: { Args: { p_nonce: string; p_address: Address }; Returns: string | null }
      find_verified_wallet_owner: { Args: { p_address: Address }; Returns: string | null }
      // Phase 4: atomic invoice + criteria registration (migration 20261024000008).
      register_invoice: {
        Args: {
          p_chain_id: number
          p_contract: Address
          p_token: Address
          p_invoice_id: string
          p_client: Address
          p_freelancer: Address
          p_amount: string
          p_criteria_hash: Bytes32
          p_canonical: string
          p_criteria: Json
          p_title: string
          p_description: string
          p_due: string | null
          p_create_tx: Bytes32 | null
          p_user: string
          p_status: string
          p_block: number | null
        }
        Returns: { o_id: string; o_created: boolean }[]
      }
      bind_verified_wallet: {
        Args: { p_user: string; p_address: Address; p_nonce: string; p_method?: string }
        Returns: string
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
