import type { Metadata } from "next"
import { VaultEntry } from "@/components/duely/vault-entry"

export const metadata: Metadata = {
  title: "Vault | Duely",
  description: "The Duely liquidity vault: supply RLUSD to fund freelancer advances. Live on the v2 deployment; a placeholder preview otherwise.",
}

export default function VaultPage() {
  return <VaultEntry />
}
