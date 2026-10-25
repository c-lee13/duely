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

/**
 * POST /api/submissions has two explicit shapes.
 *  - file (the original, `type` optional): `storagePath` is untrusted, the service re-derives and checks it. GitHub fields are refused.
 *  - github (`type: "github"`): a repository URL and a full commit SHA. Nothing else is accepted: no path, no file name.
 * Both are validated for real by the service (and, for GitHub, by lib/ai/github-submission); these schemas only bound the input.
 */
const FileSubmissionBody = z.object({
  type: z.literal("file").optional(),
  invoiceId: uuid,
  storagePath: z.string().min(1).max(200),
  fileName: z.string().min(1).max(255).optional(),
  note: z.string().max(2000).optional(),
  repositoryUrl: z.undefined().optional(),
  commitSha: z.undefined().optional(),
})

const GithubSubmissionBody = z
  .object({
    type: z.literal("github"),
    invoiceId: uuid,
    repositoryUrl: z.string().min(1).max(300),
    commitSha: z.string().min(1).max(100),
    note: z.string().max(2000).optional(),
  })
  .strict()

export const SubmissionBody = z.union([GithubSubmissionBody, FileSubmissionBody])
export type SubmissionBodyInput = z.infer<typeof SubmissionBody>

export const SubmissionIdParam = z.object({ id: uuid })
