# Duely V2: XRPL EVM testnet deployment runbook (manual, three steps)

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
given, FEE 300 bps, advance cap 90%, utilization cap 80%, exposure cap 25%, not paused. Escrow checks: same
token, points at `VAULT_ADDRESS`, FEE 300 / ADVANCE 9000, admin/operator/evaluator roles exact, vault and escrow
compatible. Step 3 additionally requires the vault to be unlinked and signed by the vault admin.

## Environment (existing `.env`; no new wallets)

`CHAIN_ID` `DEPLOYER_ADDRESS` `ADMIN_ADDRESS` `OPERATOR_ADDRESS` `EVALUATOR_ADDRESS` `TOKEN_ADDRESS` and the
RPC via `XRPL_EVM_RPC_URL` (used through the `xrpl_evm_testnet` alias). Signing: `DEPLOYER_PRIVATE_KEY` if set,
otherwise `--account duely-deployer` (it is empty in the current `.env`, so the keystore is used).
`VAULT_ADDRESS` and `ESCROW_ADDRESS` are now stored in `.env` (the deployed values), so the steps no longer need them
inline; with them set, steps 2 and 3 refuse because the vault is already linked. `ADMIN_ADDRESS` is a literal address in
`.env` (it used to be a duplicate `$OPERATOR_ADDRESS` reference). Run `forge` from `contracts/`: that is where `foundry.toml`
(the `xrpl_evm_testnet` RPC alias) and the `.env` symlink are found.

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
