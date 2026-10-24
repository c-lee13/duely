import { MockDuelyRepository } from "@/lib/mocks/mock-repository"
import { ApiDuelyRepository } from "./api-repository"
import { DATA_MODE } from "./data-mode"
import type { DuelyRepository } from "./repository"

export function createRepository(): DuelyRepository {
  return DATA_MODE === "api" ? new ApiDuelyRepository() : new MockDuelyRepository()
}
