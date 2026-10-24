#!/usr/bin/env python3
"""Build contracts/deployments/<name>.json from a forge broadcast file (real receipts only).

Usage: write_manifest.py <chainId> [--out PATH]
Refuses to write unless every transaction has a successful receipt in the broadcast file.
"""
import json
import re
import sys
from pathlib import Path

EXPLORERS = {1449000: "https://explorer.testnet.xrplevm.org"}
NAMES = {1449000: "xrpl-evm-testnet"}

root = Path(__file__).resolve().parent.parent
args = sys.argv[1:]
if not args:
    sys.exit(__doc__)
chain_id = int(args[0])
out = None
if "--out" in args:
    out = Path(args[args.index("--out") + 1])
if out is None:
    if chain_id not in NAMES:
        sys.exit("no default manifest name for this chain; pass --out")
    out = root / "deployments" / f"{NAMES[chain_id]}.json"

src = root / "broadcast" / "Deploy.s.sol" / str(chain_id) / "run-latest.json"
run = json.loads(src.read_text())
receipts = {r["transactionHash"].lower(): r for r in run["receipts"]}
explorer = EXPLORERS.get(chain_id)

txs = []
for tx in run["transactions"]:
    h = tx["hash"].lower()
    r = receipts.get(h)
    if r is None or str(r.get("status")) not in ("0x1", "1"):
        sys.exit(f"transaction {h} has no successful receipt; not writing manifest")
    txs.append(
        {
            "contractName": tx["contractName"],
            "contractAddress": tx["contractAddress"],
            "transactionHash": tx["hash"],
            "blockNumber": int(r["blockNumber"], 16),
            "gasUsed": int(r["gasUsed"], 16),
            "constructorArguments": tx.get("arguments"),
            "from": tx["transaction"]["from"],
        }
    )

by_name = {t["contractName"]: t for t in txs}
for needed in ("MockUSDC", "InvoiceAdvance"):
    if needed not in by_name:
        sys.exit(f"{needed} deployment missing from broadcast file")

ia = by_name["InvoiceAdvance"]
token_addr, admin, operator, evaluator = ia["constructorArguments"]
manifest = {
    "chainId": chain_id,
    "network": NAMES.get(chain_id, "local"),
    "explorer": explorer,
    "deployer": by_name["MockUSDC"]["from"],
    "deployedAtUnixMs": run.get("timestamp"),
    "sourceCommit": run.get("commit"),
    "paymentToken": {
        "name": "Duely Demo USD (dUSD) - DEMO TOKEN, not real USDC/RLUSD",
        "address": by_name["MockUSDC"]["contractAddress"],
        "decimals": 6,
    },
    "invoiceAdvance": {"address": ia["contractAddress"], "paymentToken": token_addr},
    "roles": {"admin": admin, "operator": operator, "evaluator": evaluator},
    "transactions": [
        {
            **t,
            "explorerUrl": f"{explorer}/tx/{t['transactionHash']}" if explorer else None,
        }
        for t in txs
    ],
}
text = json.dumps(manifest, indent=2) + "\n"
# Only explorer links may appear as URLs; an RPC URL (e.g. QuickNode) must never be written.
allowed = explorer or ""
bad = [u for u in re.findall(r"https?://[^\s\"]+", text) if not (allowed and (u == allowed or u.startswith(allowed + "/")))]
if bad or "quiknode" in text.lower():
    sys.exit("refusing to write manifest: contains a URL that is not an explorer link")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(text)
print(f"wrote {out}")
