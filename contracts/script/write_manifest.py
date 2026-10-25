#!/usr/bin/env python3
"""Build contracts/deployments/<name>.json from a forge broadcast file (real receipts only).

Usage: write_manifest.py <chainId> [--token-key KEY] [--out PATH] [--overwrite]

  (no --token-key)   the broadcast deployed MockUSDC + InvoiceAdvance (dUSD).
  --token-key rlusd  the broadcast deployed only InvoiceAdvance against the existing token listed
                     under KEY in deployments/external-tokens.json (default output
                     deployments/<network>-KEY.json).

Refuses to write unless every transaction has a successful receipt in the broadcast file, and
refuses to replace an existing manifest unless --overwrite is passed (so a later deployment can
never silently clobber the dUSD manifest).
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
token_key = args[args.index("--token-key") + 1] if "--token-key" in args else None
external = None
if token_key is not None:
    registry = json.loads((root / "deployments" / "external-tokens.json").read_text())
    external = registry.get(token_key)
    if external is None:
        sys.exit(f"unknown --token-key {token_key!r}; known: {', '.join(registry)}")
    if external["chainId"] != chain_id:
        sys.exit(f"{token_key} is registered for chain {external['chainId']}, not {chain_id}")
if out is None:
    if chain_id not in NAMES:
        sys.exit("no default manifest name for this chain; pass --out")
    suffix = f"-{token_key}" if token_key else ""
    out = root / "deployments" / f"{NAMES[chain_id]}{suffix}.json"
if out.exists() and "--overwrite" not in args:
    sys.exit(f"{out} already exists; refusing to overwrite it (pass --overwrite to replace it deliberately)")

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
needed_names = ("InvoiceAdvance",) if external else ("MockUSDC", "InvoiceAdvance")
for needed in needed_names:
    if needed not in by_name:
        hint = "" if external else " (an external-token deployment needs --token-key)"
        sys.exit(f"{needed} deployment missing from broadcast file{hint}")
if external and "MockUSDC" in by_name:
    sys.exit("this broadcast deployed MockUSDC; it is a dUSD deployment, drop --token-key")

ia = by_name["InvoiceAdvance"]
token_addr, admin, operator, evaluator = ia["constructorArguments"]
if external:
    if token_addr.lower() != external["address"].lower():
        sys.exit(f"InvoiceAdvance was deployed against {token_addr}, not the registered {token_key} token")
    payment_token = {
        "name": external["name"],
        "symbol": external["symbol"],
        "address": external["address"],
        "decimals": external["decimals"],
        "external": True,
    }
else:
    payment_token = {
        "name": "Duely Demo USD (dUSD) - DEMO TOKEN, not real USDC/RLUSD",
        "address": by_name["MockUSDC"]["contractAddress"],
        "decimals": 6,
    }
manifest = {
    "chainId": chain_id,
    "network": NAMES.get(chain_id, "local"),
    "explorer": explorer,
    "deployer": ia["from"],
    "deployedAtUnixMs": run.get("timestamp"),
    "sourceCommit": run.get("commit"),
    "paymentToken": payment_token,
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
