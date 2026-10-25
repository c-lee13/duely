/**
 * No-op stub for @stripe/stripe-js. Privy's @stripe/crypto transitive dependency references
 * it for its fiat onramp screen, which Duely does not expose. Aliasing the import to this
 * module keeps the bundle resolvable without pulling in Stripe.
 */
export function loadStripe(): Promise<null> {
  return Promise.resolve(null)
}

const stripeStub = { loadStripe }
export default stripeStub
