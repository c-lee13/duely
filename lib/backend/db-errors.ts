import { DuplicateAdvanceError, DuplicateEvaluationError } from "./ports"

/** Shared by the Supabase adapter and the tests so both translate database rejections identically. */
const isUnique = (code: string | undefined, message: string) => code === "23505" || /duplicate key value|already exists/i.test(message)

export function mapEvaluationInsertError(code: string | undefined, message: string): Error | null {
  return isUnique(code, message) ? new DuplicateEvaluationError(message) : null
}

export function mapAdvanceInsertError(code: string | undefined, message: string): Error | null {
  return isUnique(code, message) ? new DuplicateAdvanceError(message) : null
}
