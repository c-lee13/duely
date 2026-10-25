import type { Metadata } from "next"
import { VaultPreview } from "@/components/duely/vault-preview"

export const metadata: Metadata = {
  title: "Vault (V2 preview) | Duely",
  description: "Preview of the Duely V2 liquidity vault. Placeholder figures only; not connected to the blockchain.",
}

export default function VaultPage() {
  return <VaultPreview />
}
