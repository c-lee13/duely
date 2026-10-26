# Duely V2: XRPL EVM testnet deployment runbook (manual, three steps)

> **Build described here: client-chosen advance rate + fixed 10% fee.** `createInvoice` takes `advanceShareBps` (5000..10000 of the
> 90% ceiling); the financing fee is 1000 bps (10%) of the invoice whatever the rate. This is an ABI-breaking redeploy of both
> contracts (see `docs/VAULT_IMPLEMENTATION_SPEC.md`, amendment). The first deployment (fixed 90% advance, 300 bps fee) is archived,
> not reused. Note the command blocks below are from that first deployment; step 0 and the post-deploy section are new.

Script: `contracts/script/DeployV2.s.sol` (`DeployVaultV2`, `DeployEscrowV2`, `LinkEscrowV2`). Test:
`contracts/test/DeployV2Script.t.sol`. Nothing here has been broadcast. V1 (`Deploy.s.sol`, manifests,
V1 addresses) is never touched: V2 writes no manifest, refuses V1 addresses as inputs, and forge's records
go to `contracts/broadcast/DeployV2.s.sol/` (separate from V1's `broadcast/Deploy.s.sol/`).

## Rules the script enforces (every step, before sending anything, and again after)

Chain id must be 1449000 (mainnet 1440000 and every other id refused; `CHAIN_ID` must match the RPC).
`TOKEN_ADDRESS` must be the registered testnet RLUSD `0x27b57a9D0b8d24EB97259c4E2279e45255e016f3`, with code,
18 decimals, symbol `RLUSD`, non-zero supply, answering `balanceOf`, and not paused. Evaluator distinct from
operator and admin. Signer must be `DEPLOYER_ADDRESS` (steps 1-2) or `ADMIN_ADDRESS` (step 3) and hold
>= 0.05 native XRP (`MIN_GAS_WEI` overrides). Vault checks: asset RLUSD, 24-decimal `dvRLUSD`, roles as
configured (operator also holds PAUSER), evaluator holds no vault role, deployer keeps no role it was not
given, FEE 1000 bps, advance cap 90%, utilization cap 80%, exposure cap 25%, not paused. Escrow checks: same
token, points at `VAULT_ADDRESS`, FEE 1000 / ADVANCE 9000 (the 90% ceiling), admin/operator/evaluator roles exact, vault and escrow
compatible. Step 3 additionally requires the vault to be unlinked and signed by the vault admin.

## Environment (existing `.env`; no new wallets)

`CHAIN_ID` `DEPLOYER_ADDRESS` `ADMIN_ADDRESS` `OPERATOR_ADDRESS` `EVALUATOR_ADDRESS` `TOKEN_ADDRESS` and the
RPC via `XRPL_EVM_RPC_URL` (used through the `xrpl_evm_testnet` alias). Signing: `DEPLOYER_PRIVATE_KEY` if set,
otherwise `--account duely-deployer` (it is empty in the current `.env`, so the keystore is used).
`VAULT_ADDRESS` and `ESCROW_ADDRESS` are now stored in `.env` (the deployed values), so the steps no longer need them
inline; with them set, steps 2 and 3 refuse because the vault is already linked. `ADMIN_ADDRESS` is a literal address in
`.env` (it used to be a duplicate `$OPERATOR_ADDRESS` reference). Run `forge` from `contracts/`: that is where `foundry.toml`
(the `xrpl_evm_testnet` RPC alias) and the `.env` symlink are found.

## Step 0: archive the previous deployment's records (once, before step 1)

The manifest and verification tools discover the deployment from `broadcast/DeployV2.s.sol/1449000/` and require **exactly one**
vault creation, one escrow creation and one `setEscrow` link there. The old deployment's records must therefore not be in that
directory. Archive them (a move; nothing is deleted, and they stay auditable):

```bash
export PATH=$PATH:~/.foundry/bin
python3 -I script/archive_v2_broadcast.py fixed90-fee3     # -> broadcast/archive/DeployV2-fixed90-fee3-<UTC time>/
```

Then clear `VAULT_ADDRESS` / `ESCROW_ADDRESS` in `.env` (or set them to the new values after each step); with the old linked values
set, steps 2 and 3 refuse. Do not deposit anything into the new vault until the manifest is written (below): verification checks
the freshly-deployed zero state.

## Commands (run from `contracts/`)

```bash
# ---- Step 1: vault. Simulation first (sends nothing), then broadcast (prompts for the keystore password)
forge script script/DeployV2.s.sol:DeployVaultV2 --rpc-url xrpl_evm_testnet --sender 0x6e83F6Bb6758Ced46e60be88271D72C22B84482E
forge script script/DeployV2.s.sol:DeployVaultV2 --rpc-url xrpl_evm_testnet --account duely-deployer --broadcast
#   copy the "DuelyVault 0x..." address from the output, then verify it on-chain:
cast call <VAULT> "asset()(address)" --rpc-url xrpl_evm_testnet      # RLUSD
cast call <VAULT> "escrow()(address)" --rpc-url xrpl_evm_testnet     # 0x000...0 (not linked yet)

# ---- Step 2: escrow
VAULT_ADDRESS=<VAULT> forge script script/DeployV2.s.sol:DeployEscrowV2 --rpc-url xrpl_evm_testnet --sender 0x6e83F6Bb6758Ced46e60be88271D72C22B84482E
VAULT_ADDRESS=<VAULT> forge script script/DeployV2.s.sol:DeployEscrowV2 --rpc-url xrpl_evm_testnet --account duely-deployer --broadcast
cast call <ESCROW> "vault()(address)" --rpc-url xrpl_evm_testnet    # == <VAULT>

# ---- Step 3: the one-time, irreversible link (signed by the vault admin; here admin == deployer)
VAULT_ADDRESS=<VAULT> ESCROW_ADDRESS=<ESCROW> forge script script/DeployV2.s.sol:LinkEscrowV2 --rpc-url xrpl_evm_testnet --sender 0x6e83F6Bb6758Ced46e60be88271D72C22B84482E
VAULT_ADDRESS=<VAULT> ESCROW_ADDRESS=<ESCROW> forge script script/DeployV2.s.sol:LinkEscrowV2 --rpc-url xrpl_evm_testnet --account duely-deployer --broadcast
cast call <VAULT> "escrow()(address)" --rpc-url xrpl_evm_testnet    # == <ESCROW>
```

**Before step 1, run the offline checks** (no network, no transactions): `python3 -I script/test_v2_deployment.py` and
`forge build && forge test`. Always run each script without `--broadcast` first and read it.

Each `run-latest.json` under `broadcast/DeployV2.s.sol/1449000/` is overwritten by the next step (timestamped
copies stay); record the addresses from the console output.

## Gas and funding (measured)

Local execution traces: `DuelyVault` deploy about 3.7-4.1M gas, `InvoiceAdvanceV2` deploy about 2.7-3.0M, `setEscrow`
about 55k; roughly 7M in total. Live simulation of step 1: 5.3M gas estimated with forge's safety margin,
0.006 XRP at the current max fee 1.142 gwei, so the whole deployment is about 0.01 XRP. The deployer held
78.8 XRP when checked.

## Not covered by this preflight

Steps 2 and 3 cannot be simulated against the live chain until the vault (and escrow) exist; they are covered by
the local test with an RLUSD stand-in at the real address. That the `duely-deployer` keystore derives
`DEPLOYER_ADDRESS` is only checked at signing time (it needs the password). The live RLUSD is an upgradeable
issuer-controlled proxy; only its current behavior is checked.

## After step 3: verify, write the manifest, regenerate the app files (no transactions)

Run from `contracts/` with `~/.foundry/bin` on `PATH`. None of this sends a transaction.

```bash
# 1. Independent on-chain verification of the deployment found in the broadcast records. Every receipt, contract address,
#    chain id, constructor argument, bytecode (== compiled artifact), link event, role holder, token setting and the
#    fee / advance-rate schedule is re-read from the chain at one pinned block. Exit code 0 only if all checks pass.
python3 -I script/verify_v2.py
#    (explicit alternative, no records needed: --vault A --escrow B --vault-tx H --escrow-tx H)

# 2. Build contracts/deployments/xrpl-evm-testnet-v2.json. It discovers the deployment from the records, re-reads each receipt,
#    runs the verifier above against exactly that deployment and refuses to write unless it passes in full and names the same
#    vault, escrow, blocks and link. --overwrite is required because the first deployment's manifest exists.
python3 -I script/write_manifest_v2.py --overwrite

# 3. Regenerate the typed ABIs and deployment constants (its manifest ABI-hash guard now passes).
cd .. && node contracts/script/export-abi-v2.mjs
```

What the tools refuse, by design (all covered by `script/test_v2_deployment.py`): more than one vault or escrow creation in the
directory (an old deployment left behind), a missing or failed receipt, a record for another chain (mainnet 1440000 included), an
escrow built for a different vault, a link that is not `setEscrow(<this escrow>)` on `<this vault>`, creation order other than
vault, escrow, link, and records from different source commits. The verifier fails a deployment whose bytecode is not the current
build (it fails the first deployment, which is the intended proof that a stale deployment cannot pass), whose fee is not 1000 bps,
or whose `quoteAdvance` / `createInvoice` do not implement the 50..100% advance rate.

Then update `.env` and `.env.example` (`VAULT_ADDRESS`, `ESCROW_ADDRESS`, `NEXT_PUBLIC_V2_VAULT_ADDRESS`,
`NEXT_PUBLIC_V2_ESCROW_ADDRESS`), the escrow address asserted in `lib/chain/vault.test.ts`, apply the Supabase migration
`supabase/migrations/20261026000010_advance_share_bps.sql`, and only then deposit liquidity into the new vault.
