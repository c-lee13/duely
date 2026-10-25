import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Dev server only (ignored by `next build`/`next start`): the app also works when opened by this machine's network address or
  // 127.0.0.1, not just localhost. Without this, Next refuses to serve its scripts to those addresses and pages stay on their
  // loading skeleton. Add your own address here if it changes.
  allowedDevOrigins: ["127.0.0.1", "10.13.*.*", "192.168.*.*"],
}

export default nextConfig
