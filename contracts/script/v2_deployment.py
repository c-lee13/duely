"""Shared, read-only helpers for the Duely V2 deployment tools (verify_v2.py, write_manifest_v2.py).

Discovers the deployment from Foundry's broadcast records instead of hardcoded constants, and validates the
records structurally. This is only a SOURCE OF CLAIMS: addresses and hashes found here are never trusted by the
tools that use them. verify_v2.py re-reads every receipt, address, role and parameter from the chain.

Strictness (all enforced in `discover`, each failure raises DiscoveryError with the reason):
  - only timestamped `run-<digits>.json` records are read (`run-latest.json` is a copy; `dry-run/` is a simulation);
  - every record is for chain 1449000 and every transaction carries chain id 1449000;
  - every transaction has a successful receipt;
  - exactly one DuelyVault creation, exactly one InvoiceAdvanceV2 creation, exactly one setEscrow(address) call;
  - the contract addresses in the records equal the receipts' contract addresses;
  - the escrow was constructed with THIS vault; the link is setEscrow(THIS escrow) on THIS vault;
  - creation order is vault, escrow, link; all records come from one source commit.
Older deployments must be archived out of the broadcast directory first (see docs/V2_DEPLOY_RUNBOOK.md); a
directory that still holds two vault deployments is refused, never guessed at.
"""
import json
import re
from pathlib import Path

CHAIN_ID = 1449000
ROOT = Path(__file__).resolve().parent.parent
BROADCAST_DIR = ROOT / "broadcast" / "DeployV2.s.sol" / str(CHAIN_ID)
RUN_FILE = re.compile(r"^run-\d+\.json$")
ADDR = re.compile(r"^0x[0-9a-fA-F]{40}$")
HASH = re.compile(r"^0x[0-9a-fA-F]{64}$")


class DiscoveryError(Exception):
    pass


def _lower(a):
    return a.lower()


def _chain_id(value):
    if isinstance(value, int):
        return value
    return int(value, 16) if str(value).startswith("0x") else int(value)


def discover(broadcast_dir=BROADCAST_DIR, chain_id=CHAIN_ID):
    """Return the one deployment described by the records in `broadcast_dir`, or raise DiscoveryError."""
    broadcast_dir = Path(broadcast_dir)
    files = sorted(p for p in broadcast_dir.glob("run-*.json") if RUN_FILE.match(p.name)) if broadcast_dir.is_dir() else []
    if not files:
        raise DiscoveryError(f"no run-<timestamp>.json broadcast records in {broadcast_dir}")

    found = {"vault": [], "escrow": [], "link": []}
    for f in files:
        run = json.loads(f.read_text())
        if _chain_id(run.get("chain", -1)) != chain_id:
            raise DiscoveryError(f"{f.name}: records chain {run.get('chain')}, expected {chain_id} (XRPL EVM testnet)")
        receipts = {r["transactionHash"].lower(): r for r in run.get("receipts", [])}
        for tx in run.get("transactions", []):
            h = tx.get("hash", "")
            if not HASH.match(h):
                raise DiscoveryError(f"{f.name}: transaction without a valid hash")
            rc = receipts.get(h.lower())
            if rc is None or str(rc.get("status")) not in ("0x1", "1"):
                raise DiscoveryError(f"{f.name}: transaction {h} has no successful receipt")
            inner_chain = tx.get("transaction", {}).get("chainId")
            if inner_chain is None or _chain_id(inner_chain) != chain_id:
                raise DiscoveryError(f"{f.name}: transaction {h} is not for chain {chain_id}")
            if tx.get("transactionType") == "CREATE" and tx.get("contractName") == "DuelyVault":
                kind = "vault"
            elif tx.get("transactionType") == "CREATE" and tx.get("contractName") == "InvoiceAdvanceV2":
                kind = "escrow"
            elif tx.get("transactionType") == "CALL" and str(tx.get("function", "")).startswith("setEscrow("):
                kind = "link"
            else:
                raise DiscoveryError(f"{f.name}: unexpected transaction {tx.get('contractName') or tx.get('function')} ({h})")
            found[kind].append({"file": f.name, "run": run, "tx": tx, "receipt": rc})

    for kind, label in (("vault", "DuelyVault creation"), ("escrow", "InvoiceAdvanceV2 creation"), ("link", "setEscrow link")):
        n = len(found[kind])
        if n != 1:
            names = ", ".join(sorted({r["file"] for r in found[kind]})) or "none"
            hint = (
                " Archive older deployments first (move broadcast/DeployV2.s.sol aside) so only the new one remains."
                if n > 1
                else ""
            )
            raise DiscoveryError(f"expected exactly one {label} in {broadcast_dir}, found {n} ({names}).{hint}")

    v, e, l = found["vault"][0], found["escrow"][0], found["link"][0]
    vault_addr, escrow_addr = v["tx"].get("contractAddress", ""), e["tx"].get("contractAddress", "")
    if not (ADDR.match(vault_addr) and ADDR.match(escrow_addr)):
        raise DiscoveryError("a creation record has no contract address")
    if _lower(v["receipt"].get("contractAddress") or "") != _lower(vault_addr):
        raise DiscoveryError("the vault record's address differs from its receipt's contract address")
    if _lower(e["receipt"].get("contractAddress") or "") != _lower(escrow_addr):
        raise DiscoveryError("the escrow record's address differs from its receipt's contract address")
    # InvoiceAdvanceV2(paymentToken, vault, admin, operator, evaluator): argument 1 is the vault it was built for.
    e_args = e["tx"].get("arguments") or []
    if len(e_args) != 5 or _lower(e_args[1]) != _lower(vault_addr):
        raise DiscoveryError("the escrow was not constructed with the discovered vault")
    l_args = l["tx"].get("arguments") or []
    if _lower(l["tx"].get("contractAddress", "")) != _lower(vault_addr) or len(l_args) != 1 or _lower(l_args[0]) != _lower(escrow_addr):
        raise DiscoveryError("the link is not setEscrow(<discovered escrow>) on the discovered vault")

    blocks = [int(x["receipt"]["blockNumber"], 16) for x in (v, e, l)]
    if not (blocks[0] <= blocks[1] <= blocks[2]):
        raise DiscoveryError("transactions are not in the order vault, escrow, link")
    commits = {x["run"].get("commit") for x in (v, e, l)}
    if len(commits) != 1 or None in commits:
        raise DiscoveryError(f"transactions were built from different (or unknown) commits: {sorted(map(str, commits))}")

    return {
        "vault": {"address": vault_addr, "txHash": v["tx"]["hash"], "file": v["file"], "constructorArguments": v["tx"].get("arguments")},
        "escrow": {"address": escrow_addr, "txHash": e["tx"]["hash"], "file": e["file"], "constructorArguments": e_args},
        "link": {"txHash": l["tx"]["hash"], "file": l["file"]},
        "sourceCommit": next(iter(commits)),
    }
