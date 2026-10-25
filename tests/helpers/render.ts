import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import * as readline from "node:readline"

/** Renders `github` (GithubEvaluationPanel) or `text` (EvaluationPanel) props to HTML in a child process. See render-child.ts. */
export function startRenderer() {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--import", "tsx", "tests/helpers/render-child.ts"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: "" },
  })
  const pending: Array<{ resolve: (s: string) => void; reject: (e: Error) => void }> = []
  let stderr = ""
  child.stderr.on("data", (d) => (stderr += String(d)))
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const waiter = pending.shift()
    if (!waiter) return
    const msg = JSON.parse(line) as { ok: boolean; markup?: string; error?: string }
    if (msg.ok) waiter.resolve(msg.markup as string)
    else waiter.reject(new Error(`render failed: ${msg.error}`))
  })
  child.on("exit", () => {
    for (const w of pending.splice(0)) w.reject(new Error(`renderer exited. ${stderr.slice(0, 500)}`))
  })
  return {
    render(kind: "github" | "text", props: unknown): Promise<string> {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject })
        child.stdin.write(JSON.stringify({ kind, props }) + "\n")
      })
    },
    close() {
      child.stdin.end()
      child.kill()
    },
  }
}
