import { MockDuelyRepository } from "@/lib/mocks/mock-repository"
import { ApiDuelyRepository } from "./api-repository"
import { DATA_MODE } from "./data-mode"
import { hybridWalletPort, signInHybrid, signOutHybrid } from "@/lib/privy/wallet-port"
import type { DuelyRepository } from "./repository"

export function createRepository(): DuelyRepository {
  if (DATA_MODE !== "api") return new MockDuelyRepository()
  return new ApiDuelyRepository({
    wallet: hybridWalletPort,
    signIn: signInHybrid,
    signOut: signOutHybrid,
  })
}
