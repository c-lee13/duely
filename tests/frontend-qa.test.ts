import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { signInErrorMessage } from "@/lib/frontend/errors"
import { WalletClientError } from "@/lib/auth/wallet-client"

describe("PWA and favicon assets", () => {
  const sources = ["app/manifest.ts", "app/layout.tsx"].map((f) => fs.readFileSync(f, "utf8"))
  const refs = sources.flatMap((s) => [...s.matchAll(/\{[^{}]*?(?:src|url): "(\/icons\/[^"]+)"[^{}]*?sizes: "(\d+)x(\d+)"/g)].map((m) => ({ path: m[1], w: Number(m[2]), h: Number(m[3]) })))

  it("every icon the manifest and layout reference exists with the declared size", () => {
    assert.ok(refs.length >= 6, `found ${refs.length} icon references`)
    for (const { path, w, h } of refs) {
      const file = `public${path}`
      assert.ok(fs.existsSync(file), `${path} is referenced but missing`)
      const buf = fs.readFileSync(file)
      assert.equal(buf.subarray(1, 4).toString(), "PNG", path)
      assert.deepEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [w, h], `${path} is not ${w}x${h}`)
    }
  })

  it("the app/ directory has the favicon", () => {
    assert.ok(fs.existsSync("app/favicon.ico"))
  })
})

describe("wallet sign-in origin error", () => {
  it("explains a BAD_ORIGIN failure instead of showing only 'Cross-origin requests are not allowed'", () => {
    const e = new WalletClientError("BAD_ORIGIN", "Cross-origin requests are not allowed.")
    const m = signInErrorMessage(e, "http://10.13.20.219:3000")
    assert.match(m, /http:\/\/localhost:3000/)
    assert.match(m, /NEXT_PUBLIC_SITE_URL/)
    assert.match(m, /you are on http:\/\/10\.13\.20\.219:3000/)
  })

  it("leaves every other error message unchanged", () => {
    assert.equal(signInErrorMessage(new WalletClientError("SIGNATURE_REJECTED", "The signature request was rejected in the wallet.")), "The signature request was rejected in the wallet.")
    assert.equal(signInErrorMessage("boom"), "Something went wrong.")
  })

  it("does not touch the server-side origin check (CSRF protection)", () => {
    const http = fs.readFileSync("lib/auth/http.ts", "utf8")
    assert.match(http, /if \(!origin \|\| origin !== expectedOrigin\(request\)\)/)
  })
})
