#!/usr/bin/env python3
"""Build contracts/deployments/xrpl-evm-testnet-v2.json for the Duely V2 deployment.

Usage (from contracts/):  python3 -I script/write_manifest_v2.py [--overwrite] [--broadcast-dir DIR]

The deployment (addresses, transaction hashes) is DISCOVERED from the forge broadcast records for
script/DeployV2.s.sol by script/v2_deployment.py, which requires exactly one vault creation, one escrow creation
and one setEscrow link, all successful, all for chain 1449000, all consistent with each other. Nothing about a
particular deployment is hardcoded here. Then, in order:
  1. the live chain: every transaction receipt is re-read and must agree with the record (block, status, gas, address);
  2. script/verify_v2.py is run against the discovered deployment and must pass in full (every check pinned to one
     block) before anything is written; its report must name the same vault, escrow and transactions;
  3. the manifest is built from the on-chain facts, never from the records alone.
Older deployments must be archived out of the broadcast directory first (docs/V2_DEPLOY_RUNBOOK.md).

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
sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I does not add the script directory; this is our own module
import v2_deployment  # noqa: E402

CHAIN_ID = 1449000
NETWORK = "xrpl-evm-testnet"
EXPLORER = "https://explorer.testnet.xrplevm.org"
RPC = "xrpl_evm_testnet"
OUT = ROOT / "deployments" / "xrpl-evm-testnet-v2.json"
RLUSD = "0x27b57a9D0b8d24EB97259c4E2279e45255e016f3"

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

    # --- 1. broadcast records -> the one deployment they describe (strict; see v2_deployment.discover)
    argv = sys.argv
    bdir = argv[argv.index("--broadcast-dir") + 1] if "--broadcast-dir" in argv else v2_deployment.BROADCAST_DIR
    try:
        found = v2_deployment.discover(bdir, CHAIN_ID)
    except v2_deployment.DiscoveryError as e:
        die(str(e))
    rec = {
        "vault": (found["vault"]["file"], found["vault"]["txHash"]),
        "escrow": (found["escrow"]["file"], found["escrow"]["txHash"]),
        "link": (found["link"]["file"], found["link"]["txHash"]),
    }
    commits = {found["sourceCommit"]}

    roles = env_roles()
    deployer, admin, operator, evaluator = (roles[k] for k in ("DEPLOYER_ADDRESS", "ADMIN_ADDRESS", "OPERATOR_ADDRESS", "EVALUATOR_ADDRESS"))
    if not all(re.fullmatch(r"0x[0-9a-fA-F]{40}", a) for a in (deployer, admin, operator, evaluator)):
        die("role addresses in .env are not all valid")
    pauser = operator

    # --- 2. every receipt is re-read from the chain
    txs = {}
    for k in ("vault", "escrow", "link"):
        fname, h = rec[k]
        run = json.loads((Path(bdir) / fname).read_text())
        rc = next(r for r in run["receipts"] if r["transactionHash"].lower() == h.lower())
        live = json.loads(cast("receipt", h, "--rpc-url", RPC, "--json"))
        if live["status"] != "0x1" or int(live["blockNumber"], 16) != int(rc["blockNumber"], 16) or int(live["gasUsed"], 16) != int(rc["gasUsed"], 16):
            die(f"{k} transaction disagrees between the broadcast record and the chain")
        if int(cast("tx", h, "chainId", "--rpc-url", RPC), 0) != CHAIN_ID:
            die(f"{k} transaction is not for chain {CHAIN_ID}")
        txs[k] = {
            "hash": h,
            "block": int(live["blockNumber"], 16),
            "gasUsed": int(live["gasUsed"], 16),
            "from": live["from"],
            "explorerUrl": f"{EXPLORER}/tx/{h}",
            "broadcastRecord": f"contracts/broadcast/DeployV2.s.sol/{CHAIN_ID}/{fname}",
            "sourceCommit": run.get("commit"),
        }
    # On-chain facts decide the addresses: the creation receipts must have produced exactly the discovered contracts.
    # Foundry records addresses lower-cased; the manifest (and the app files generated from it) use EIP-55 checksums.
    vault_addr = cast("to-check-sum-address", found["vault"]["address"])
    escrow_addr = cast("to-check-sum-address", found["escrow"]["address"])
    for k, addr in (("vault", vault_addr), ("escrow", escrow_addr)):
        live = json.loads(cast("receipt", txs[k]["hash"], "--rpc-url", RPC, "--json"))
        if (live.get("contractAddress") or "").lower() != addr.lower():
            die(f"the {k} creation receipt on chain did not create {addr}")
    if not (txs["vault"]["block"] <= txs["escrow"]["block"] <= txs["link"]["block"]):
        die("transactions are not in the expected order")

    # --- 3. full live verification must pass first
    # Explicit mode: the verifier checks exactly the deployment discovered above, but re-derives all of it from the chain.
    p = subprocess.run(
        [sys.executable, "-I", str(ROOT / "script" / "verify_v2.py"), "--json",
         "--vault", vault_addr, "--escrow", escrow_addr, "--vault-tx", txs["vault"]["hash"], "--escrow-tx", txs["escrow"]["hash"]],
        capture_output=True, text=True, cwd=ROOT,
    )
    if p.returncode != 0:
        print(p.stdout[-1500:])
        die("live verification FAILED; not writing a manifest (nothing was changed)")
    report = json.loads([l for l in p.stdout.splitlines() if l.startswith("{")][-1])
    if (
        report["failed"]
        or (report["linkTransaction"]["hash"] or "").lower() != txs["link"]["hash"].lower()
        or report["vault"].lower() != vault_addr.lower()
        or report["escrow"].lower() != escrow_addr.lower()
        or report["deploymentBlocks"] != {"vault": txs["vault"]["block"], "escrow": txs["escrow"]["block"]}
    ):
        die("verification report disagrees with the broadcast record (the on-chain link event, addresses or blocks differ)")

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
            "financingFeeBps": 1000,
            "minAdvanceShareBps": 5000,
            "advanceBps": 9000,
            "maxUtilizationBps": 8000,
            "maxInvoiceExposureBps": 2500,
            "vaultDecimalsOffset": 6,
            "advanceRate": "client-chosen per invoice, advanceShareBps 5000..10000 of the 90% ceiling",
            "example": {
                "invoice": "1000",
                "at100pct": {"advance": "900", "fee": "100", "vaultRepayment": "1000", "freelancerRemainder": "0"},
                "at50pct": {"advance": "450", "fee": "100", "vaultRepayment": "550", "freelancerRemainder": "450"},
            },
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
