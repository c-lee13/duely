/**
 * Deployment isolation. dUSD (6 decimals) and RLUSD (18 decimals) are different contracts with different tokens, and
 * on-chain invoice ids repeat between them. Every invoice row belongs to exactly one (chain, InvoiceAdvance, token)
 * triple, and a server process only ever serves the ACTIVE deployment's invoices: rows of another deployment are
 * never listed, resolved by on-chain id, or acted on, so their amounts can never be read with the wrong decimals.
 *
 * `chain_id = 0` rows are dev test fixtures (no contract, flagged in the UI); they belong to no deployment and stay visible.
 */

export interface DeploymentScope {
  chainId: number
  /** Lower-case InvoiceAdvance address. */
  contractAddress: string
  /** Lower-case payment token address. */
  tokenAddress: string
  /** For messages and tests only. */
  key: string
  symbol: string
  decimals: number
}

export interface ScopedInvoiceRow {
  chain_id: number
  contract_address: string
  /** Absent on rows loaded for evidence handling; the contract address already pins the token. */
  token_address?: string
}

export function invoiceInScope(row: ScopedInvoiceRow, scope: DeploymentScope): boolean {
  if (row.chain_id === 0) return true // dev test fixture
  return (
    row.chain_id === scope.chainId &&
    row.contract_address.toLowerCase() === scope.contractAddress.toLowerCase() &&
    (row.token_address === undefined || row.token_address.toLowerCase() === scope.tokenAddress.toLowerCase())
  )
}
