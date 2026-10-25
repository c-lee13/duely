/**
 * The single place NEXT_PUBLIC_DATA_MODE is read.
 * Defaults to "mock" for the local demo. This flag only chooses a data adapter;
 * it never grants or bypasses backend authorization.
 */
export type DataMode = "mock" | "api"

export const DATA_MODE: DataMode =
  process.env.NEXT_PUBLIC_DATA_MODE === "api" ? "api" : "mock"
