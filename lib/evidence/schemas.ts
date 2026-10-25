import { z } from "zod"

const uuid = z
  .string()
  .max(40)
  .transform((s) => s.toLowerCase())
  .pipe(z.string().uuid())

/** POST /api/evidence/upload-url */
export const UploadUrlBody = z.object({
  invoiceId: uuid,
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive(),
  mimeType: z.string().min(1).max(100),
})

/** POST /api/submissions. `storagePath` is untrusted: the service re-derives and checks it. */
export const SubmissionBody = z.object({
  invoiceId: uuid,
  storagePath: z.string().min(1).max(200),
  fileName: z.string().min(1).max(255).optional(),
  note: z.string().max(2000).optional(),
})

export const SubmissionIdParam = z.object({ id: uuid })
