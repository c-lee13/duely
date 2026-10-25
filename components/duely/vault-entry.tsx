"use client"

import { VaultLive } from "@/components/duely/vault-live"
import { VaultPreview } from "@/components/duely/vault-preview"
import { useRepository } from "@/hooks/use-duely"

/** The live vault when the repository offers vault controls (live mode on the v2 deployment); otherwise the static preview. */
export function VaultEntry() {
  const repo = useRepository()
  return repo.vault ? <VaultLive /> : <VaultPreview />
}
