import { ApiError } from "./api-error"
import { requireUser, requireVerifiedWallets } from "./access"
import { callChain, toRecordView, type InvoiceRecordView } from "./invoices"
import type { BackendDeps } from "./ports"

/** How many registered invoices the operator view looks at (each is verified against the chain). */
export const OPERATOR_VIEW_LIMIT = 50

export interface OperatorInvoicesView {
  /** The verified wallet of the caller that holds OPERATOR_ROLE on-chain. */
  operator: string
  /** Only invoices whose status was READ FROM THE CHAIN as Advanced or Disputed (the ones the operator can be exposed to). */
  invoices: InvoiceRecordView[]
}

/**
 * The operator's overview of the active deployment: advances outstanding and disputes awaiting resolution. Authorization is the
 * ON-CHAIN role (`hasRole(OPERATOR_ROLE)` for one of the caller's verified wallets), not anything stored in our database, and the
 * operator is generally NOT a party to the invoices, so this is the only way they can see them. Statuses are never cached values:
 * an invoice whose chain read fails is left out rather than shown with a guessed status.
 */
export async function listOperatorInvoices(deps: BackendDeps, input: { userId: string | null }): Promise<OperatorInvoicesView> {
  const userId = requireUser(input.userId)
  const wallets = await requireVerifiedWallets(deps.db, userId)
  if (!deps.chain.available) {
    throw new ApiError("INTEGRATION_UNAVAILABLE", "Blockchain integration isn't available, so operator rights can't be verified.")
  }
  let operator: string | null = null
  for (const w of wallets) {
    if (await callChain(() => deps.chain.hasRole("operator", w))) {
      operator = w
      break
    }
  }
  if (!operator) throw new ApiError("FORBIDDEN", "Only a wallet holding OPERATOR_ROLE on this deployment can open the operator view.")

  const rows = (await deps.db.listInvoicesInScope(deps.scope, OPERATOR_VIEW_LIMIT)).filter((i) => i.chain_id !== 0)
  const views = await Promise.all(
    rows.map(async (invoice) => {
      const state = await deps.chain
        .getInvoiceState({ chainId: invoice.chain_id, contractAddress: invoice.contract_address, invoiceId: BigInt(invoice.invoice_id) })
        .catch(() => null)
      return state && (state.onchainStatus === "Advanced" || state.onchainStatus === "Disputed") ? toRecordView(invoice, "NotSubmitted", state) : null
    })
  )
  return { operator, invoices: views.filter((v): v is InvoiceRecordView => v !== null) }
}
