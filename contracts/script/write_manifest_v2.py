#!/usr/bin/env python3
"""Build contracts/deployments/xrpl-evm-testnet-v2.json for the Duely V2 deployment.

Usage (from contracts/):  python3 -I script/write_manifest_v2.py [--overwrite]

Sources of truth, in order:
  1. forge broadcast records for script/DeployV2.s.sol (real receipts only; every tx must have succeeded);
  2. the live chain: every transaction receipt is re-read and must agree (block, status, address);
  3. script/verify_v2.py, which must pass in full (74-ish checks pinned to one block) before anything is written.

V1 safety: this writes ONLY xrpl-evm-testnet-v2.json. It never reads or writes the V1 manifests, refuses to
replace an existing V2 manifest without --overwrite, and refuses to write any URL that is not an explorer link
(so the RPC URL, a secret, cannot leak). Sends no transactions.
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHAIN_ID = 1449000
NETWORK = "xrpl-evm-testnet"
EXPLORER = "https://explorer.testnet.xrplevm.org"
RPC = "xrpl_evm_testnet"
OUT = ROOT / "deployments" / "xrpl-evm-testnet-v2.json"
BROADCAST = ROOT / "broadcast" / "DeployV2.s.sol" / str(CHAIN_ID)

RLUSD = "0x27b57a9D0b8d24EB97259c4E2279e45255e016f3"
EXPECTED = {
    "vault": ("DuelyVault", "0x5f8B53B32acab32F8c283CB40a4B7ac04792B6E8", "0xa29c18b9d31b42d5983de0c63fd36c1f7d46b55ff5b341112589106da7bf8c70"),
    "escrow": ("InvoiceAdvanceV2", "0x2E1598D6DBDa061EB6CafCa5D7AEe1630A04Ba96", "0xc73eb1ecf99041a38ea63a0554956fabaadcb122662d104a7c4be45791d386b5"),
}


def die(msg):
    sys.exit(f"write_manifest_v2: {msg}")


def cast(*a):
    p = subprocess.run(["cast", *a], capture_output=True, text=True, cwd=ROOT)
    if p.returncode != 0:
        die(f"cast {a[0]} failed: {(p.stderr or p.stdout).strip().splitlines()[:1]}")
    return p.stdout.strip()


def abi_sha(path):
    # same canonical form as export-abi-v2.mjs: sha256(JSON.stringify(abi))
    abi = json.loads(path.read_text())
    return hashlib.sha256(json.dumps(abi, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def env_roles():
    raw = {}
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            raw[k] = v.strip().strip('"').strip("'")
    exp = lambda v: re.sub(r"\$(\w+)", lambda m: raw.get(m.group(1), ""), v)
    return {k: exp(raw.get(k, "")) for k in ("DEPLOYER_ADDRESS", "ADMIN_ADDRESS", "OPERATOR_ADDRESS", "EVALUATOR_ADDRESS")}


def main():
    if OUT.exists() and "--overwrite" not in sys.argv:
        die(f"{OUT.name} already exists; refusing to overwrite it (pass --overwrite deliberately)")

    # --- 1. broadcast records -> the three transactions
    found = {}
    for f in sorted(BROADCAST.glob("run-[0-9]*.json")):
        run = json.loads(f.read_text())
        receipts = {r["transactionHash"].lower(): r for r in run["receipts"]}
        for tx in run["transactions"]:
            h = tx["hash"].lower()
            rc = receipts.get(h)
            if rc is None or str(rc.get("status")) not in ("0x1", "1"):
                die(f"{f.name}: transaction {h} has no successful receipt")
            kind = (
                "vault" if tx.get("contractName") == "DuelyVault"
                else "escrow" if tx.get("contractName") == "InvoiceAdvanceV2"
                else "link" if str(tx.get("function", "")).startswith("setEscrow") else None
            )
            if kind is None:
                die(f"{f.name}: unexpected transaction {tx.get('contractName') or tx.get('function')}")
            found.setdefault(kind, []).append((f.name, run, tx, rc))
    for k in ("vault", "escrow", "link"):
        if len(found.get(k, [])) != 1:
            die(f"expected exactly one {k} transaction in {BROADCAST.relative_to(ROOT)}, found {len(found.get(k, []))}")
    rec = {k: v[0] for k, v in found.items()}

    roles = env_roles()
    deployer, admin, operator, evaluator = (roles[k] for k in ("DEPLOYER_ADDRESS", "ADMIN_ADDRESS", "OPERATOR_ADDRESS", "EVALUATOR_ADDRESS"))
    if not all(re.fullmatch(r"0x[0-9a-fA-F]{40}", a) for a in (deployer, admin, operator, evaluator)):
        die("role addresses in .env are not all valid")
    pauser = operator

    txs = {}
    for k in ("vault", "escrow", "link"):
        fname, run, tx, rc = rec[k]
        h = tx["hash"]
        live = json.loads(cast("receipt", h, "--rpc-url", RPC, "--json"))  # 2. cross-check with the chain
        if live["status"] != "0x1" or int(live["blockNumber"], 16) != int(rc["blockNumber"], 16) or int(live["gasUsed"], 16) != int(rc["gasUsed"], 16):
            die(f"{k} transaction disagrees between the broadcast record and the chain")
        txs[k] = {
            "hash": h,
            "block": int(live["blockNumber"], 16),
            "gasUsed": int(live["gasUsed"], 16),
            "from": live["from"],
            "explorerUrl": f"{EXPLORER}/tx/{h}",
            "broadcastRecord": f"contracts/broadcast/DeployV2.s.sol/{CHAIN_ID}/{fname}",
            "sourceCommit": run.get("commit"),
        }
    for k in ("vault", "escrow"):
        name, addr, h = EXPECTED[k]
        _, _, tx, _ = rec[k]
        if tx["hash"].lower() != h.lower() or tx["contractAddress"].lower() != addr.lower():
            die(f"{k} in the broadcast record is not the confirmed deployment ({addr} / {h})")
    if rec["link"][2]["arguments"][0].lower() != EXPECTED["escrow"][1].lower() or rec["link"][2]["contractAddress"].lower() != EXPECTED["vault"][1].lower():
        die("the link transaction is not setEscrow(escrow) on the vault")
    if not (txs["vault"]["block"] <= txs["escrow"]["block"] <= txs["link"]["block"]):
        die("transactions are not in the expected order")
    commits = {t["sourceCommit"] for t in txs.values()}
    if len(commits) != 1:
        die(f"transactions were built from different commits: {commits}")

    # --- 3. full live verification must pass first
    p = subprocess.run([sys.executable, "-I", str(ROOT / "script" / "verify_v2.py"), "--json"], capture_output=True, text=True, cwd=ROOT)
    if p.returncode != 0:
        print(p.stdout[-1500:])
        die("live verification FAILED; not writing a manifest (nothing was changed)")
    report = json.loads([l for l in p.stdout.splitlines() if l.startswith("{")][-1])
    if report["failed"] or report["linkTransaction"]["hash"].lower() != txs["link"]["hash"].lower():
        die("verification report disagrees with the broadcast record")

    abis = {}
    for name in ("DuelyVault", "InvoiceAdvanceV2"):
        jp = ROOT / "deployments" / "abi" / f"{name}.json"
        if not jp.exists():
            die(f"missing {jp.relative_to(ROOT)}; run node contracts/script/export-abi-v2.mjs first")
        ts = {"DuelyVault": "duelyVaultAbi", "InvoiceAdvanceV2": "invoiceAdvanceV2Abi"}[name]
        abis[name] = {
            "file": f"contracts/deployments/abi/{name}.json",
            "typescript": f"lib/chain/generated/{ts}.ts",
            "sha256": abi_sha(jp),
            "entries": len(json.loads(jp.read_text())),
        }

    vault_addr, escrow_addr = EXPECTED["vault"][1], EXPECTED["escrow"][1]
    manifest = {
        "schemaVersion": 1,
        "chainId": CHAIN_ID,
        "network": NETWORK,
        "explorer": EXPLORER,
        "rpc": {
            "foundryAlias": RPC,
            "serverEnv": "XRPL_EVM_RPC_URL",
            "publicEnv": "NEXT_PUBLIC_XRPL_EVM_RPC_URL",
            "note": "No RPC URL is stored here. The server/Foundry URL is a secret; the browser uses the public RPC.",
        },
        "deployer": deployer,
        "sourceCommit": next(iter(commits)),
        "paymentToken": {"name": "RLUSD", "symbol": "RLUSD", "address": RLUSD, "decimals": 18, "external": True, "isDemoToken": False},
        "vault": {
            "address": vault_addr,
            "contract": "DuelyVault",
            "deployTxHash": txs["vault"]["hash"],
            "deployBlock": txs["vault"]["block"],
            "gasUsed": txs["vault"]["gasUsed"],
            "constructorArguments": {"asset": RLUSD, "admin": admin, "operator": operator, "pauser": pauser},
            "shareToken": {"name": "Duely Vault Share", "symbol": "dvRLUSD", "decimals": 24},
        },
        "escrow": {
            "address": escrow_addr,
            "contract": "InvoiceAdvanceV2",
            "deployTxHash": txs["escrow"]["hash"],
            "deployBlock": txs["escrow"]["block"],
            "gasUsed": txs["escrow"]["gasUsed"],
            "constructorArguments": {"paymentToken": RLUSD, "vault": vault_addr, "admin": admin, "operator": operator, "evaluator": evaluator},
        },
        "link": {
            "call": "DuelyVault.setEscrow(address)",
            "escrow": escrow_addr,
            "txHash": txs["link"]["hash"],
            "block": txs["link"]["block"],
            "gasUsed": txs["link"]["gasUsed"],
            "sentBy": txs["link"]["from"],
            "note": "One-time and irreversible; confirmed by exactly one EscrowSet event.",
        },
        "roles": {
            "admin": admin,
            "operator": operator,
            "pauser": pauser,
            "evaluator": evaluator,
            "vault": {"DEFAULT_ADMIN_ROLE": [admin], "OPERATOR_ROLE": [operator], "PAUSER_ROLE": [pauser]},
            "escrow": {"DEFAULT_ADMIN_ROLE": [admin], "OPERATOR_ROLE": [operator], "EVALUATOR_ROLE": [evaluator]},
            "note": "Testnet MVP: admin == operator == pauser == deployer (one key). The evaluator is separate. Not suitable for production (decision D5).",
        },
        "parameters": {
            "financingFeeBps": 300,
            "advanceBps": 9000,
            "maxUtilizationBps": 8000,
            "maxInvoiceExposureBps": 2500,
            "vaultDecimalsOffset": 6,
            "example": {"invoice": "1000", "advance": "900", "fee": "30", "vaultRepayment": "930", "freelancerRemainder": "70"},
        },
        "abis": abis,
        "verification": {
            "tool": "contracts/script/verify_v2.py",
            "verifiedAtBlock": report["verifiedAtBlock"],
            "checksPassed": report["checks"],
            "initialState": "totalSupply, totalAssets, outstandingPrincipal, totalEscrow, totalClaimable and all contract RLUSD balances were 0",
        },
        "transactions": [
            {"contractName": "DuelyVault", "contractAddress": vault_addr, "transactionHash": txs["vault"]["hash"], "blockNumber": txs["vault"]["block"], "gasUsed": txs["vault"]["gasUsed"], "explorerUrl": txs["vault"]["explorerUrl"]},
            {"contractName": "InvoiceAdvanceV2", "contractAddress": escrow_addr, "transactionHash": txs["escrow"]["hash"], "blockNumber": txs["escrow"]["block"], "gasUsed": txs["escrow"]["gasUsed"], "explorerUrl": txs["escrow"]["explorerUrl"]},
            {"contractName": "DuelyVault", "function": "setEscrow(address)", "contractAddress": vault_addr, "transactionHash": txs["link"]["hash"], "blockNumber": txs["link"]["block"], "gasUsed": txs["link"]["gasUsed"], "explorerUrl": txs["link"]["explorerUrl"]},
        ],
    }
    text = json.dumps(manifest, indent=2) + "\n"
    bad = [u for u in re.findall(r"https?://[^\s\"]+", text) if not (u == EXPLORER or u.startswith(EXPLORER + "/"))]
    if bad or "quiknode" in text.lower() or re.search(r"private[_ ]?key\s*[:=]", text, re.I):
        die("refusing to write: the manifest would contain a non-explorer URL or a key")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(ROOT)} (verified at block {report['verifiedAtBlock']}, {report['checks']} checks)")


if __name__ == "__main__":
    main()
