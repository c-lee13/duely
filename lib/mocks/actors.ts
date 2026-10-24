import type { Address, DemoRole } from "@/lib/frontend/domain"

/** Clearly fictional demo identities. These wallets do not exist on any chain. */
function demoAddress(prefix: string, n: number): Address {
  return `0x${prefix}${n.toString(16).padStart(40 - prefix.length, "0")}` as Address
}

export const ACTORS = {
  client: {
    wallet: demoAddress("c11e", 1),
    name: "Northwind Studio",
  },
  freelancer: {
    wallet: demoAddress("f3ee", 1),
    name: "Ada Rivera",
  },
  otherFreelancer: {
    wallet: demoAddress("f3ee", 2),
    name: "Bo Lindqvist",
  },
  platform: {
    wallet: demoAddress("9a7f", 1),
    name: "Duely Platform",
  },
} as const

export const ROLE_ACTOR: Record<DemoRole, { wallet: Address; name: string }> = {
  client: ACTORS.client,
  freelancer: ACTORS.freelancer,
  platform: ACTORS.platform,
}

export function nameForWallet(wallet: string): string {
  const match = Object.values(ACTORS).find(
    (a) => a.wallet.toLowerCase() === wallet.toLowerCase()
  )
  return match?.name ?? "Unregistered wallet"
}
