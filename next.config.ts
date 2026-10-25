import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Privy's react-auth bundle has a transitive import of @stripe/stripe-js via its fiat
  // onramp screen (@stripe/crypto). We don't expose fiat onramp — stub the import so
  // Turbopack doesn't fail to resolve a dependency we never execute.
  turbopack: {
    resolveAlias: {
      "@stripe/stripe-js": "./lib/privy/stripe-stub.ts",
    },
  },
}

export default nextConfig
