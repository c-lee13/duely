import { z } from "zod"

/** Strict objects: unknown fields (for example a browser-supplied `score` or `passed`) are rejected, never ignored. */
const uuid = z
  .string()
  .max(40)
  .transform((s) => s.toLowerCase())
  .pipe(z.string().uuid())

const uint256 = z.string().regex(/^(0|[1-9][0-9]{0,77})$/, "Must be a decimal integer string")

const criterion = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Criterion ids use letters, digits, - and _"),
    text: z.string().min(1).max(1000),
    mandatory: z.boolean(),
  })
  .strict()

/** POST /api/invoices */
export const CreateInvoiceBody = z
  .object({
    invoiceId: uint256,
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Must be a 32-byte transaction hash"),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(4000),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    criteria: z
      .array(criterion)
      .min(1)
      .max(100)
      .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, "Criterion ids must be unique"),
  })
  .strict()

/** POST /api/evaluate: the ONLY input is the submission. Scores and pass/fail are never accepted from the browser. */
export const EvaluateBody = z.object({ submissionId: uuid }).strict()

/** POST /api/advances */
export const AdvanceBody = z.object({ invoiceId: uuid }).strict()

/** GET /api/advances/:id */
export const AdvanceRefParam = z.object({ id: uuid })

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/)

/** `:id` is the invoice's database UUID or its on-chain decimal id (resolved only among the caller's own invoices). */
export const InvoiceRefParam = z.object({ id: z.union([uuid, uint256]) })
