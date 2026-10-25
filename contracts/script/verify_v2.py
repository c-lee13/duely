#!/usr/bin/env python3
"""Read-only verification of the live Duely V2 deployment (XRPL EVM testnet). Sends no transactions.

Usage (from contracts/):  python3 -I script/verify_v2.py [--json]

Every state read is pinned to ONE block so the report is internally consistent. The RPC is reached through
the Foundry alias `xrpl_evm_testnet` (XRPL_EVM_RPC_URL), so no URL or secret is read, printed or stored.
Expected role addresses come from the repo `.env` (public addresses only; private keys are never read).

Exit code 0 only if every check passes. On any failure it reports the discrepancy and stops fixing nothing.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RPC = "xrpl_evm_testnet"
CHAIN_ID = 1449000

RLUSD = "0x27b57a9D0b8d24EB97259c4E2279e45255e016f3"
VAULT = "0x5f8B53B32acab32F8c283CB40a4B7ac04792B6E8"
ESCROW = "0x2E1598D6DBDa061EB6CafCa5D7AEe1630A04Ba96"
TX = {
    "vault": "0xa29c18b9d31b42d5983de0c63fd36c1f7d46b55ff5b341112589106da7bf8c70",
    "escrow": "0xc73eb1ecf99041a38ea63a0554956fabaadcb122662d104a7c4be45791d386b5",
}
V1_ADDRESSES = {
    "0x328fc0DbF3d1F704B065192f4bFC7583bfA550E0",
    "0x1B972ec6B1B5E0b592010e7484beF0accC382792",
    "0x5ff7b6ae08c37868303e7A815308Af476421506c",
}

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  ok    " if ok else "  FAIL  ") + name + (f"  [{detail}]" if detail and not ok else ""))
    return ok


def cast(*args):
    p = subprocess.run(["cast", *args], capture_output=True, text=True, cwd=ROOT)
    if p.returncode != 0:
        msg = (p.stderr or p.stdout).strip().splitlines()
        raise RuntimeError("cast " + args[0] + " failed: " + (msg[0] if msg else "?"))
    return p.stdout.strip()


def call(addr, sig, *args, block):
    out = cast("call", addr, sig, *args, "--rpc-url", RPC, "--block", str(block))
    return out.splitlines()[0].split(" ")[0].strip('"') if "string" not in sig.split(")(")[-1] else out.strip().strip('"')


def num(addr, sig, *args, block):
    return int(call(addr, sig, *args, block=block))


def lower(a):
    return a.lower()


def load_env():
    """Public role addresses from .env (with one level of $VAR expansion). Keys/secrets are ignored."""
    raw = {}
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        raw[k] = v.strip().strip('"').strip("'")

    def expand(v):
        return re.sub(r"\$(\w+)", lambda m: raw.get(m.group(1), ""), v)

    return {k: expand(raw.get(k, "")) for k in ("DEPLOYER_ADDRESS", "ADMIN_ADDRESS", "OPERATOR_ADDRESS", "EVALUATOR_ADDRESS", "TOKEN_ADDRESS")}


def artifact(name):
    return json.loads((ROOT / "out" / f"{name}.sol" / f"{name}.json").read_text())


def masked(code_hex, refs):
    """Zero the immutable slots so deployed code can be compared with the artifact's runtime code."""
    b = bytearray(bytes.fromhex(code_hex[2:]))
    for positions in refs.values():
        for p in positions:
            b[p["start"] : p["start"] + p["length"]] = b"\x00" * p["length"]
    return bytes(b)


def role_holders(addr, from_block, to_block):
    """Final holder set per role, from RoleGranted/RoleRevoked logs (the only ways a role changes)."""
    held = {}
    for event, grant in (("RoleGranted(bytes32 indexed,address indexed,address indexed)", True), ("RoleRevoked(bytes32 indexed,address indexed,address indexed)", False)):
        logs = json.loads(cast("logs", "--rpc-url", RPC, "--address", addr, "--from-block", str(from_block), "--to-block", str(to_block), event, "--json"))
        for l in logs:
            role = l["topics"][1]
            who = "0x" + l["topics"][2][-40:]
            order = (int(l["blockNumber"], 16), int(l["logIndex"], 16))
            held.setdefault((role, who.lower()), []).append((order, grant))
    out = {}
    for (role, who), evs in held.items():
        evs.sort()
        if evs[-1][1]:
            out.setdefault(role, set()).add(who)
    return out


def main():
    want_json = "--json" in sys.argv
    env = load_env()
    head = int(cast("block-number", "--rpc-url", RPC))
    block = head  # every read below is pinned to this block
    print(f"Duely V2 live verification, all reads pinned to block {block}\n")

    print("network")
    check("chain id is 1449000", int(cast("chain-id", "--rpc-url", RPC)) == CHAIN_ID)
    check("V2 addresses are distinct from every V1 address", not ({VAULT, ESCROW} & V1_ADDRESSES))

    print("\nenvironment (expected roles)")
    for k, v in env.items():
        check(f".env {k} is a valid address", re.fullmatch(r"0x[0-9a-fA-F]{40}", v) is not None, v or "empty")
    deployer, admin, operator, evaluator = (env[k] for k in ("DEPLOYER_ADDRESS", "ADMIN_ADDRESS", "OPERATOR_ADDRESS", "EVALUATOR_ADDRESS"))
    pauser = operator
    check(".env TOKEN_ADDRESS is the RLUSD address", lower(env["TOKEN_ADDRESS"]) == lower(RLUSD))

    print("\ndeployment transactions")
    rcpt = {}
    for k, h in TX.items():
        r = json.loads(cast("receipt", h, "--rpc-url", RPC, "--json"))
        rcpt[k] = r
        check(f"{k} deployment tx succeeded", r["status"] == "0x1", r["status"])
        check(f"{k} deployed by DEPLOYER_ADDRESS", lower(r["from"]) == lower(deployer))
    check("vault tx created the vault address", lower(rcpt["vault"]["contractAddress"]) == lower(VAULT))
    check("escrow tx created the escrow address", lower(rcpt["escrow"]["contractAddress"]) == lower(ESCROW))
    vault_block = int(rcpt["vault"]["blockNumber"], 16)
    escrow_block = int(rcpt["escrow"]["blockNumber"], 16)

    # constructor arguments, decoded from the creation transactions' calldata
    def ctor_args(txhash, n):
        data = cast("tx", txhash, "input", "--rpc-url", RPC)
        tail = data[2:][-64 * n :]
        return ["0x" + tail[i * 64 + 24 : (i + 1) * 64] for i in range(n)]

    va = ctor_args(TX["vault"], 4)
    ea = ctor_args(TX["escrow"], 5)
    check("vault constructor args = (RLUSD, admin, operator, pauser=operator)", [lower(x) for x in va] == [lower(RLUSD), lower(admin), lower(operator), lower(pauser)], str(va))
    check("escrow constructor args = (RLUSD, vault, admin, operator, evaluator)", [lower(x) for x in ea] == [lower(RLUSD), lower(VAULT), lower(admin), lower(operator), lower(evaluator)], str(ea))

    print("\nbytecode")
    for name, addr in (("DuelyVault", VAULT), ("InvoiceAdvanceV2", ESCROW)):
        art = artifact(name)
        refs = art["deployedBytecode"].get("immutableReferences", {})
        onchain = masked(cast("code", addr, "--rpc-url", RPC, "--block", str(block)), refs)
        compiled = masked(art["deployedBytecode"]["object"], refs)
        check(f"{name} on-chain runtime code == compiled artifact (immutables masked)", onchain == compiled, f"{len(onchain)} vs {len(compiled)} bytes")

    print("\nRLUSD")
    check("RLUSD has code", len(cast("code", RLUSD, "--rpc-url", RPC, "--block", str(block))) > 2)
    check("RLUSD decimals == 18", num(RLUSD, "decimals()(uint8)", block=block) == 18)
    check("RLUSD symbol == RLUSD", call(RLUSD, "symbol()(string)", block=block) == "RLUSD")
    check("RLUSD is not paused", call(RLUSD, "paused()(bool)", block=block) == "false")

    print("\nlinking")
    check("vault.asset() == RLUSD", lower(call(VAULT, "asset()(address)", block=block)) == lower(RLUSD))
    check("escrow.vault() == DuelyVault", lower(call(ESCROW, "vault()(address)", block=block)) == lower(VAULT))
    check("escrow.paymentToken() == RLUSD", lower(call(ESCROW, "paymentToken()(address)", block=block)) == lower(RLUSD))
    check("vault.escrow() == InvoiceAdvanceV2", lower(call(VAULT, "escrow()(address)", block=block)) == lower(ESCROW))
    logs = json.loads(cast("logs", "--rpc-url", RPC, "--address", VAULT, "--from-block", str(vault_block), "--to-block", str(block), "EscrowSet(address indexed)", "--json"))
    check("exactly one EscrowSet event (the one-time link was used once)", len(logs) == 1, f"{len(logs)} events")
    link_tx = logs[0]["transactionHash"] if logs else None
    link_block = int(logs[0]["blockNumber"], 16) if logs else None
    if link_tx:
        lr = json.loads(cast("receipt", link_tx, "--rpc-url", RPC, "--json"))
        check("link transaction succeeded", lr["status"] == "0x1")
        check("link transaction sent by the vault admin", lower(lr["from"]) == lower(admin))
        check("link happened after both deployments", link_block >= escrow_block >= vault_block)
    ev_escrow = "0x" + logs[0]["topics"][1][-40:] if logs else ""
    check("EscrowSet event names the deployed escrow", lower(ev_escrow) == lower(ESCROW))

    print("\nroles (complete holder sets reconstructed from RoleGranted/RoleRevoked events)")
    vrole = {"admin": call(VAULT, "DEFAULT_ADMIN_ROLE()(bytes32)", block=block), "operator": call(VAULT, "OPERATOR_ROLE()(bytes32)", block=block), "pauser": call(VAULT, "PAUSER_ROLE()(bytes32)", block=block)}
    erole = {"admin": call(ESCROW, "DEFAULT_ADMIN_ROLE()(bytes32)", block=block), "operator": call(ESCROW, "OPERATOR_ROLE()(bytes32)", block=block), "evaluator": call(ESCROW, "EVALUATOR_ROLE()(bytes32)", block=block)}
    vh = role_holders(VAULT, vault_block, block)
    eh = role_holders(ESCROW, escrow_block, block)
    for label, roles, holders, expected in (
        ("vault", vrole, vh, {"admin": admin, "operator": operator, "pauser": pauser}),
        ("escrow", erole, eh, {"admin": admin, "operator": operator, "evaluator": evaluator}),
    ):
        addr = VAULT if label == "vault" else ESCROW
        for rname, rhash in roles.items():
            got = holders.get(rhash, set())
            check(f"{label} {rname} role held by exactly {{{expected[rname][:8]}...}}", got == {lower(expected[rname])}, str(sorted(got)))
            check(f"{label} hasRole({rname}, expected) is true on-chain", call(addr, "hasRole(bytes32,address)(bool)", rhash, expected[rname], block=block) == "true")
        known = set(roles.values())
        extra = {r for r in holders if r not in known}
        check(f"{label}: no role other than the documented ones was ever granted", not extra, str(extra))
    check("operator also holds the vault pauser role (testnet MVP design)", call(VAULT, "hasRole(bytes32,address)(bool)", vrole["pauser"], operator, block=block) == "true")
    check("evaluator holds no vault role", all(call(VAULT, "hasRole(bytes32,address)(bool)", r, evaluator, block=block) == "false" for r in vrole.values()))
    check("evaluator is distinct from admin and operator", lower(evaluator) not in (lower(admin), lower(operator)))
    if lower(admin) == lower(operator) == lower(pauser) == lower(deployer):
        print("  note  admin == operator == pauser == deployer: one key controls the vault (accepted for the testnet MVP, decision D5)")

    print("\nparameters (vault and escrow agree)")
    check("vault FEE_BPS == 300", num(VAULT, "FEE_BPS()(uint256)", block=block) == 300)
    check("escrow FEE_BPS == 300", num(ESCROW, "FEE_BPS()(uint256)", block=block) == 300)
    check("escrow ADVANCE_BPS == 9000", num(ESCROW, "ADVANCE_BPS()(uint256)", block=block) == 9000)
    check("vault MAX_ADVANCE_BPS == 9000", num(VAULT, "MAX_ADVANCE_BPS()(uint256)", block=block) == 9000)
    check("vault MAX_UTILIZATION_BPS == 8000", num(VAULT, "MAX_UTILIZATION_BPS()(uint256)", block=block) == 8000)
    check("vault MAX_INVOICE_EXPOSURE_BPS == 2500", num(VAULT, "MAX_INVOICE_EXPOSURE_BPS()(uint256)", block=block) == 2500)
    check("vault share decimals == 24", num(VAULT, "decimals()(uint8)", block=block) == 24)
    check("vault name/symbol", call(VAULT, "name()(string)", block=block) == "Duely Vault Share" and call(VAULT, "symbol()(string)", block=block) == "dvRLUSD")

    print("\nstate at initialization")
    zero = lambda label, v: check(label, v == 0, str(v))
    zero("vault totalSupply == 0", num(VAULT, "totalSupply()(uint256)", block=block))
    zero("vault totalAssets == 0", num(VAULT, "totalAssets()(uint256)", block=block))
    zero("vault availableLiquidity == 0", num(VAULT, "availableLiquidity()(uint256)", block=block))
    zero("vault outstandingPrincipal == 0", num(VAULT, "outstandingPrincipal()(uint256)", block=block))
    zero("vault totalFeesEarned == 0", num(VAULT, "totalFeesEarned()(uint256)", block=block))
    zero("vault totalRealizedLosses == 0", num(VAULT, "totalRealizedLosses()(uint256)", block=block))
    zero("vault withdrawableLiquidity == 0", num(VAULT, "withdrawableLiquidity()(uint256)", block=block))
    zero("vault utilizationBps == 0", num(VAULT, "utilizationBps()(uint256)", block=block))
    zero("vault maxAdvanceNow == 0 (no liquidity yet)", num(VAULT, "maxAdvanceNow()(uint256)", block=block))
    check("vault not paused, advances not paused, advances enabled", call(VAULT, "paused()(bool)", block=block) == "false" and call(VAULT, "advancesPaused()(bool)", block=block) == "false" and call(VAULT, "advancesEnabled()(bool)", block=block) == "true")
    zero("RLUSD balance of vault == 0", num(RLUSD, "balanceOf(address)(uint256)", VAULT, block=block))
    zero("RLUSD balance of escrow == 0", num(RLUSD, "balanceOf(address)(uint256)", ESCROW, block=block))
    zero("escrow totalEscrow == 0", num(ESCROW, "totalEscrow()(uint256)", block=block))
    zero("escrow totalClaimable == 0", num(ESCROW, "totalClaimable()(uint256)", block=block))
    check("escrow nextInvoiceId == 1 (no invoice yet)", num(ESCROW, "nextInvoiceId()(uint256)", block=block) == 1)
    zero("native balance of vault == 0", int(cast("balance", VAULT, "--rpc-url", RPC, "--block", str(block))))
    zero("native balance of escrow == 0", int(cast("balance", ESCROW, "--rpc-url", RPC, "--block", str(block))))

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed at block {block}")
    report = {
        "verifiedAtBlock": block,
        "chainId": CHAIN_ID,
        "checks": len(results),
        "failed": [r[0] for r in failed],
        "linkTransaction": {"hash": link_tx, "block": link_block},
        "deploymentBlocks": {"vault": vault_block, "escrow": escrow_block},
    }
    if want_json:
        print(json.dumps(report))
    if failed:
        print("\nDISCREPANCIES (nothing was changed or fixed):")
        for n, _, d in failed:
            print(f"  - {n} {d}")
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        print(f"verification aborted: {e}")
        sys.exit(2)
