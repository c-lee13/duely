import type { Address } from "@/lib/frontend/domain"
import { UUID_RE } from "@/lib/evidence/policy"
import { ApiError } from "./api-error"
import { invoiceInScope, type DeploymentScope } from "@/lib/shared/deployment-scope"
import type { BackendDb, InvoiceData } from "./ports"

export function requireUser(userId: string | null | undefined): string {
  if (!userId) throw new ApiError("UNAUTHENTICATED", "Sign in to continue.")
  return userId
}

/** Wallet addresses VERIFIED for this user. Unverified claims never count. */
export async function requireVerifiedWallets(db: BackendDb, userId: string): Promise<Address[]> {
  const addresses = await db.verifiedAddresses(userId)
  if (addresses.length === 0) throw new ApiError("NO_VERIFIED_WALLET", "Verify your wallet before continuing.")
  return addresses
}

export interface InvoiceAccess {
  invoice: InvoiceData
  wallets: Address[]
  isClient: boolean
  isFreelancer: boolean
}

/**
 * Loads an invoice for a caller who must be one of its parties (by VERIFIED wallet). Unrelated callers get NOT_FOUND,
 * identical to a nonexistent invoice, so existence is never revealed.
 */
export async function loadInvoiceAsParty(db: BackendDb, userId: string, invoiceId: string, scope: DeploymentScope): Promise<InvoiceAccess> {
  const wallets = await requireVerifiedWallets(db, userId)
  if (!UUID_RE.test(invoiceId)) throw new ApiError("NOT_FOUND", "Invoice not found.")
  const invoice = await db.getInvoice(invoiceId)
  if (!invoice) throw new ApiError("NOT_FOUND", "Invoice not found.")
  const isClient = wallets.includes(invoice.client_address)
  const isFreelancer = wallets.includes(invoice.freelancer_address)
  if (!isClient && !isFreelancer) throw new ApiError("NOT_FOUND", "Invoice not found.")
  // Only after the party check, so another deployment's invoice is never confirmed to a stranger. A party is told why.
  if (!invoiceInScope(invoice, scope)) {
    throw new ApiError(
      "WRONG_DEPLOYMENT",
      `This invoice belongs to a different deployment than the one this server runs (${scope.key.toUpperCase()}). Its amounts are not shown or acted on here.`
    )
  }
  return { invoice, wallets, isClient, isFreelancer }
}

export function requireFreelancer(access: InvoiceAccess, action: string) {
  if (!access.isFreelancer) throw new ApiError("FORBIDDEN", `Only the freelancer assigned to this invoice can ${action}.`)
}
