# Live data mode (Phase 6A)

**Why your tables were empty:** the app defaults to **mock mode** (`NEXT_PUBLIC_DATA_MODE` unset). Mock mode keeps everything in the browser's
`localStorage` and never calls Supabase. Rows only appear in your database in **live mode**, and only for the workflows that don't need the
blockchain (below).

## Turn it on

1. Apply migrations 1–8 to your dev project (`npx supabase db push --dry-run`, then `db push`). Add `SUPABASE_SERVICE_ROLE_KEY` to `.env.local`
   (server only). Configure Auth as described in `AUTH_RLS.md`.
2. In `.env.local` set `NEXT_PUBLIC_DATA_MODE=api`, then **restart** `npm run dev` (`NEXT_PUBLIC_*` values are fixed at start).
3. Open the app. You'll see a **Connect wallet** card; sign the free message in MetaMask. The yellow *Demo mode* banner is replaced by a blue
   *Live data* banner (with Sign out).
4. Mock mode again: remove the variable (or set `mock`) and restart. The two modes share no code path, storage or data.

There are no invoices yet because creating one needs the chain. To exercise the screens before that exists, use the **dev-only fixture**:

```
ALLOW_DEV_FIXTURES=true npm run seed:dev-fixture -- --wallet 0xYourVerifiedWallet --as freelancer
```
It inserts ONE row with `chain_id = 0`, zero contract/token addresses, no tx hash and an uncontrolled counterparty. It is **not** an on-chain invoice; the UI
tags it **Test fixture · no blockchain**, shows its status as unverified, and shows no escrow or payment figures for it. It refuses to run without
`ALLOW_DEV_FIXTURES=true` or with `NODE_ENV=production`. Sign in with that wallet first (it must be verified on an account). Then upload evidence and,
with `DUELY_EVALUATOR_MODE=demo` in `.env.local`, request an evaluation: rows appear in `submissions` and `evaluations`, and survive a refresh.

## What is live and what is not

| Screen | Live mode (`api`) | Mock mode |
|---|---|---|
| Sign-in gate (Connect wallet) | **Live**: `/api/auth/*`, server-verified wallet | not shown |
| Client dashboard `/client` | **Live reads**: invoice list from Supabase. Escrow shows **"Not connected"** (no chain) | mock |
| Freelancer dashboard `/freelancer` | **Live reads**: invoice list. Received / advances / pending show **"Not connected"** | mock |
| Invoice detail (both roles) | **Live reads**: terms, frozen criteria, submissions (no storage paths), evaluations, advance requests. Money breakdown replaced by a "not connected" notice | mock |
| Evidence upload (freelancer) | **Live write**: server-authorized private upload -> `submissions` row | mock |
| AI evaluation | **Live write** via `POST /api/evaluate`; **simulated** (and labelled so) unless a real evaluator exists; unavailable (503) if none is configured | mock |
| Request advance | Calls `POST /api/advances`; today answers **integration unavailable** (no chain/signer). A pending request would show as *pending*, never paid | mock |
| Create invoice `/client/invoices/new` | **Blocked**: notice explaining it needs the chain | mock |
| Fund / approve / dispute (client) | **Blocked**: notice replaces the buttons | mock |
| Activity | Live: states that on-chain history isn't connected; empty | mock |
| Profile | Live: verified wallet + sign out | mock |
| Platform / reserve | **Blocked** (unavailable in live mode) | mock |
| Welcome page | Live copy; no platform card | mock |

## Honesty rules enforced in live mode

- Identity is whatever the **server** says (`/api/auth/session`), never `localStorage`. The Client/Freelancer switch is a UI preference (kept in
  `sessionStorage`) and grants nothing: every request is authorized per invoice on the server.
- A database status is **not proof**. Live invoices carry `financialStatusVerified: false` until a chain adapter confirms them, and the UI says
  "Status not verified on-chain". Escrow / received / reserve figures are not shown when unverified.
- No transaction hash, on-chain invoice id or payment is ever created by the UI. Unsupported actions throw an error naming the missing blockchain integration.
- Evaluations carry their `simulated` flag to the screen; simulated results can never authorize an advance (server-enforced).

## Added API surface (needs integration-owner agreement)

- `GET /api/invoices`: the caller's own invoices (read-only list; the dashboards need it).
- `GET /api/invoices/:id` also accepts the **on-chain decimal id**, resolved only among the caller's own invoices (aligns with CLAUDE.md §8; the UUID still works).
  The UI uses on-chain ids in URLs and keeps a map to UUIDs for write endpoints.
- Responses gained `chainId`, `isTestFixture`, `createdAt` and submission `note`.

## Verify

- `npm test` (190 tests): includes the live repository running against the real handlers and schema (fetch shim): authorized reads, stranger/claimant/signed-out
  refusal, persistence across a fresh repository (= page refresh), mock/live independence, honest failures for blocked workflows.
- Manual: (1) sign in, confirm the Live banner; (2) seed the fixture; (3) upload evidence as the freelancer; (4) refresh: the submission is still there and a
  row exists in `submissions` (Table Editor); (5) sign in as a different wallet: the invoice is invisible and `/freelancer/invoices/<id>` shows not found.

## Not tested

The app in a real browser with MetaMask; any live Supabase call (Auth session creation, Storage, PostgREST queries, the fixture script's insert); visual rendering of the
new notices (type-checked and server-rendered only). The tests use the real handlers and schema but a fake object store, fake chain and a fetch shim.
