# Deployments (Track A, milestone A5)

`xrpl-evm-testnet.json` is written **only** by `script/write_manifest.py` from a real forge broadcast
file (`broadcast/Deploy.s.sol/1449000/run-latest.json`) and only if every transaction has a
successful receipt. It does not exist until a testnet deployment has actually happened. Do not hand-edit it.

## Network (docs.xrplevm.org, confirmed against the live RPC with `eth_chainId`)

| | |
|---|---|
| Network | XRPL EVM Testnet |
| Chain ID | `1449000` (`0x161c28`) |
| RPC (public, browser) | `https://rpc.testnet.xrplevm.org` -> `NEXT_PUBLIC_XRPL_EVM_RPC_URL` |
| RPC (server + Foundry) | authenticated QuickNode URL -> `XRPL_EVM_RPC_URL` (secret; never in `NEXT_PUBLIC_*`, source, logs or manifests) |
| Explorer | `https://explorer.testnet.xrplevm.org` (Blockscout; API `https://explorer.testnet.xrplevm.org/api`) |
| Native gas token | XRP (18 decimals) |
| Faucet | `https://faucet.xrplevm.org` (docs: up to 90 XRP per request) |
| EVM version | Docs: Prague-compatible; earlier targets remain compatible. `foundry.toml` pins `cancun`, solc 0.8.28. |

Mainnet (`1440000`) is refused by `Deploy.s.sol`.

**Credential hygiene:** forge writes the full RPC URL into `contracts/cache/Deploy.s.sol/<chainId>/`
(gitignored). Never commit, share or attach that directory; `broadcast/` and the manifest do not
contain the URL, and `write_manifest.py` refuses to write a manifest containing one.

## Setup

```bash
# One env file only: the repo-root .env (gitignored). Foundry reads .env from its working
# directory and does not search parents, so link it instead of copying the secret:
ln -s ../.env contracts/.env     # contracts/.env is gitignored
# root .env needs: XRPL_EVM_RPC_URL (QuickNode), CHAIN_ID=1449000, DEPLOYER_ADDRESS, ADMIN_ADDRESS,
#       OPERATOR_ADDRESS, EVALUATOR_ADDRESS (evaluator must differ from operator and admin)
```

Prefer a Foundry keystore for the deployer (`cast wallet import duely-deployer --interactive`) and
pass `--account duely-deployer`; `--private-key` also works. The script checks the broadcasting
address equals `DEPLOYER_ADDRESS`. The deployer becomes the `MockUSDC` owner (only the owner can mint).

## Keystores and passwords

Signing uses Foundry keystores in `~/.foundry/keystores`: `duely-deployer` (deployer, admin,
operator, token owner), `duely-client`, `duely-evaluator`. No raw private keys are used or stored.

- `forge script ... --account duely-deployer` prompts for the password on the terminal (hidden,
  not stored, not in shell history). Run it in your own terminal, not through an agent.
- `smoke.sh` prompts once per keystore (hidden), keeps passwords in shell variables, and writes
  each to a `0600` file in a private `0700` temp dir only for the duration of one `cast` call
  (`cast` rejects pipes and `/dev/fd`). The file is deleted right after the call and by an exit
  trap. Passwords never appear on a command line or in output. For unattended runs, point
  `DEPLOYER_PASSWORD_FILE` / `CLIENT_PASSWORD_FILE` / `EVALUATOR_PASSWORD_FILE` at `chmod 600` files.
- Keystore addresses are verified against `DEPLOYER_ADDRESS`, `CLIENT_ADDRESS` and
  `EVALUATOR_ADDRESS`: by `smoke.sh --check` (read-only), and for deployment by `Deploy.s.sol`
  (`broadcaster == DEPLOYER_ADDRESS`).

## Deploy

```bash
cd contracts
forge fmt --check && forge build && forge test
set -a; source ../.env; set +a
# 1. read-only: keystore addresses == env, chain id, balances (no transactions)
./script/smoke.sh --check
# 2. dry run (simulation only, no transactions)
forge script script/Deploy.s.sol:Deploy --rpc-url xrpl_evm_testnet --sender $DEPLOYER_ADDRESS
# 3. broadcast (sends transactions; prompts for the duely-deployer password)
forge script script/Deploy.s.sol:Deploy --rpc-url xrpl_evm_testnet --account duely-deployer --broadcast
python3 script/write_manifest.py 1449000
```

`xrpl_evm_testnet` is the `foundry.toml` alias for `$XRPL_EVM_RPC_URL` (QuickNode), so the URL
never appears on the command line. Put `TOKEN_ADDRESS` / `CONTRACT_ADDRESS` from the manifest
into `.env`.

## Smoke test (sends transactions)

Needs at least 0.002 XRP on each of deployer, client and evaluator (the freelancer needs none).

```bash
set -a; source ../.env; set +a
./script/smoke.sh --check   # read-only
./script/smoke.sh           # full lifecycle; prompts for the three keystore passwords
```

It mints demo USD to the client and operator (deployer is the token owner), approves, creates and
funds a 1,000 dUSD invoice, deposits 1,000 reserve from the deployer keystore, approves the 900
advance with the evaluator keystore, settles from the client keystore, and checks balances,
`reserveBalance`, `totalEscrow` and invoice status against the RPC after each step. It was
rehearsed end to end (deploy + smoke, plus wrong-address and wrong-password failures) on a local
anvil chain with throwaway keystores.

## Optional: explorer verification (not yet tested)

```bash
forge verify-contract <address> src/InvoiceAdvance.sol:InvoiceAdvance --chain-id 1449000 \
  --verifier blockscout --verifier-url https://explorer.testnet.xrplevm.org/api \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address)" <token> <admin> <operator> <evaluator>)
```

The Demo USD token is a mock, labeled as such everywhere; it is not USDC or RLUSD.
