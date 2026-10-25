/**
 * Child process for tests: renders UI components to static HTML. It runs WITHOUT the `react-server` export condition (the test
 * runner needs that condition so `server-only` imports work, but under it React has no hooks, which client components need).
 * Protocol: one JSON request per line on stdin -> one JSON response per line on stdout.
 */
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as readline from "node:readline"
import { GithubEvaluationPanel } from "@/components/duely/github-evaluation"
import { EvaluationPanel } from "@/components/duely/invoice-parts"

const KINDS = { github: GithubEvaluationPanel, text: EvaluationPanel } as const

const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  try {
    const { kind, props } = JSON.parse(line) as { kind: keyof typeof KINDS; props: Record<string, unknown> }
    const markup = renderToStaticMarkup(React.createElement(KINDS[kind] as React.ComponentType<Record<string, unknown>>, props))
    process.stdout.write(JSON.stringify({ ok: true, markup }) + "\n")
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + "\n")
  }
})
