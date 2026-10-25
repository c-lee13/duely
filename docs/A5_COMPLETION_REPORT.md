# A5 Completion Report — XRPL EVM Testnet Deployment & Smoke Test

**Status: complete.** MockUSDC and InvoiceAdvance are deployed on XRPL EVM Testnet and one full invoice lifecycle (create → fund → reserve → 90% advance → settle) ran and was independently re-verified from chain data.
All tokens are **Duely Demo USD (dUSD)**, a mock 6-decimal token. It is not USDC, not RLUSD, and has no value.

## Network and contracts

| | |
|---|---|
| Network | XRPL EVM Testnet, chain ID `1449000` |
| Explorer | https://explorer.testnet.xrplevm.org |
| Source commit at deploy | `9f3e548` |
| Manifest | `contracts/deployments/xrpl-evm-testnet.json` (generated from broadcast receipts) |

| Contract | Address | Deploy tx (block 9225054) |
|---|---|---|
| MockUSDC (`dUSD`, 6 dp) | [`0x5ff7b6ae08c37868303e7A815308Af476421506c`](https://explorer.testnet.xrplevm.org/address/0x5ff7b6ae08c37868303e7A815308Af476421506c) | [`0xe7fb8e6a…8d69b`](https://explorer.testnet.xrplevm.org/tx/0xe7fb8e6ae581d60862bfdc49def910efd0228ebab652387ab4fda3301de8d69b) |
| InvoiceAdvance | [`0x328fc0DbF3d1F704B065192f4bFC7583bfA550E0`](https://explorer.testnet.xrplevm.org/address/0x328fc0DbF3d1F704B065192f4bFC7583bfA550E0) | [`0x4fbfc89e…b49c5`](https://explorer.testnet.xrplevm.org/tx/0x4fbfc89eb7671437643998796a7421a1f3aa80f5d408d605cf67f37cf28b49c5) |

| Role | Address |
|---|---|
| Deployer / `DEFAULT_ADMIN_ROLE` / `OPERATOR_ROLE` / MockUSDC owner | `0x6e83F6Bb6758Ced46e60be88271D72C22B84482E` |
| `EVALUATOR_ROLE` | `0x276acaB037BB048a682E0E7ad900F3fFDCe65ECb` |
| Client (smoke test) | `0x8d93eD20e6eD28c34aE0057f441ED97d3e63459E` |
| Freelancer (smoke test) | `0x02379033ECD642D9A9aA590ABe763D62AEa967F4` |

Roles verified on-chain: admin, operator and evaluator hold exactly their roles; the evaluator holds neither admin nor operator, the operator does not hold evaluator, and the client holds no role.

## Smoke test (invoice #1, 1,000 dUSD)

All transactions succeeded (receipt status `true`) and were re-read from the chain. Each is a link on the explorer under `/tx/<hash>`.

| Step | Tx hash | Block | Verified events |
|---|---|---|---|
| 1a Mint 1,000 dUSD to client | `0x46068577a6f4f1311cc78004a2ea062f6438955699b7f67201edc0d154497542` | 9225134 | `Transfer` 0x0 → client 1,000 |
| 1b Mint 10,000 dUSD to operator | `0x9ea2c65c790922d41c82c997a942d07c03400e6f7d5bb88f7b8f7e81ca24dfc7` | 9225135 | `Transfer` 0x0 → operator 10,000 |
| 2 Client approves 1,000 | `0xe24099c50793ce328e1fc3b75d2d91b67f85002ba647c73369f5ff8973a73102` | 9225136 | `Approval` client → InvoiceAdvance 1,000 |
| 3 `createInvoice` | `0xfb9090fba894f12e69b060badd699a10d4ca74d9d589b871dc796d8c5924c63e` | 9225139 | `InvoiceCreated` id 1, amount 1,000 |
| 4 `fundInvoice` | `0x6afebf871528a59ee31b0b6189b9d04e7fb959a1b1c37052683933b266a646c7` | 9225140 | `Transfer` client → contract 1,000; `InvoiceFunded` |
| 5a Operator approves 10,000 | `0xd72152282ff0e66de3fc66daf06e8796c99ab2eeac60c29ace0918a36d447007` | 9225144 | `Approval` operator → InvoiceAdvance 10,000 |
| 5b `depositReserve` 10,000 | `0x2ae0e1d11deee57061ac46d7564ed5a7bca6a998075f2f29a8efc186791c552e` | 9225145 | `Transfer` operator → contract 10,000; `ReserveDeposited` |
| 6 `approveAdvance` (evaluator) | `0x11e4577418b6f06632d62a57cfe01d01a8a44b6bdd2896dc57aa05506593a81b` | 9225148 | `Transfer` contract → freelancer 900; `AdvancePaid` 900 |
| 7 `approveCompletion` (client) | `0x1a7d2b65c70a6c9e17a3f36f9be24b74552eddb41414806e724a9c49f82e33fc` | 9225149 | `Transfer` contract → freelancer **100**; `InvoiceSettled` reserveRepaid 900, freelancerPaid 100 |

That is **9** transactions (deployer nonce +4, client +4, evaluator +1 since deployment), not 10 as in the terminal summary.
Settlement emits a transfer of only the 100 remainder: the 900 reimbursement is an internal reclassification from escrow to reserve with no token movement, as designed.

## State and accounting

Invoice #1, read at block 9225232: status `Settled` (3), amount 1,000, `advanceAmount` 900 (exactly `floor(1000 × 9000 / 10000)`), `evaluationHash` = `keccak256("duely-smoke-eval-1")`.

| Stage | Reserve | Escrow | Freelancer holds |
|---|---:|---:|---:|
| After reserve deposit + funding | 10,000 | 1,000 | 0 |
| After advance | 9,100 | 1,000 | 900 |
| After settlement (final, on-chain) | **10,000** | **0** | **1,000** |

Final on-chain balances (dUSD): contract 10,000; freelancer 1,000; client 0; operator 0; evaluator 0; total supply 11,000 (= 10,000 + 1,000). Client and operator allowances to the contract are 0. `nextInvoiceId` is 2.
Solvency: contract balance 10,000 = `reserveBalance` 10,000 + `totalEscrow` 0.
No discrepancy between the terminal output and the on-chain state beyond the transaction count above.

## Security and permission assumptions
- The evaluator key is a trusted off-chain signer: the contract cannot verify AI quality or the freelancer's request. Track B must check both before `approveAdvance`.
- The deployer holds admin, operator and token-owner powers (one demo wallet); the admin can re-grant roles and the operator chooses dispute outcomes. This is a documented MVP trust assumption, not decentralised arbitration.
- Dispute refund after an advance leaves the advance as an operator loss (tested in Foundry; not exercised on testnet).
- Signing uses Foundry keystores. No private keys, keystore passwords or the authenticated QuickNode URL are in tracked files or the manifest. Forge's `contracts/cache/Deploy.s.sol/` embeds the RPC URL; it is gitignored, so do not share it.
- Demo token only; no real funds; mainnet is refused by the deploy script.

## What A5 tested versus what remains
- **Tested on testnet:** deployment, role assignment, and the happy path with an advance (create, fund, reserve, advance, settle) with reserve reimbursement.
- **Tested only in Foundry (70 tests, incl. fuzz, invariants, reentrancy, fee-on-transfer):** no-advance settlement, disputes (release and refund), insufficient reserve, duplicate calls, unauthorised callers.
- **A6 (not started):** export compiled ABI/addresses to `lib/chain/generated/` and typed viem wrappers. Compiled artifacts are at `contracts/out/InvoiceAdvance.sol/InvoiceAdvance.json`, `contracts/out/MockUSDC.sol/MockUSDC.json`, `contracts/out/IInvoiceAdvance.sol/IInvoiceAdvance.json`.
- **A7 (not started):** server-only evaluator adapter and Track B integration.
- **Not done:** explorer source verification of the contracts; a dispute run on testnet.

## Reproducing
```bash
git submodule update --init contracts/lib/openzeppelin-contracts   # forge-std is vendored
cd contracts && forge build && forge test
# testnet scripts: see contracts/deployments/README.md (needs your own keystores and QuickNode URL)
```
