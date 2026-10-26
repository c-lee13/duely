#!/usr/bin/env python3
"""Offline tests for script/v2_deployment.py (no network, no chain, no transactions).

Run from contracts/:  python3 -I script/test_v2_deployment.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import v2_deployment as d  # noqa: E402

CHAIN = 1449000
VAULT, ESCROW = "0x" + "aa" * 20, "0x" + "bb" * 20
TOKEN, ADMIN, OPERATOR, EVALUATOR = "0x" + "11" * 20, "0x" + "22" * 20, "0x" + "22" * 20, "0x" + "33" * 20


def h(n):
    return "0x" + f"{n:064x}"


def run(txs, receipts, chain=CHAIN, commit="abc1234"):
    return {"transactions": txs, "receipts": receipts, "chain": chain, "commit": commit, "timestamp": 1}


def vault_tx(n=1, addr=VAULT, chain=CHAIN):
    return {"hash": h(n), "transactionType": "CREATE", "contractName": "DuelyVault", "contractAddress": addr, "arguments": [TOKEN, ADMIN, OPERATOR, OPERATOR], "transaction": {"chainId": hex(chain)}}


def escrow_tx(n=2, addr=ESCROW, vault=VAULT, chain=CHAIN):
    return {"hash": h(n), "transactionType": "CREATE", "contractName": "InvoiceAdvanceV2", "contractAddress": addr, "arguments": [TOKEN, vault, ADMIN, OPERATOR, EVALUATOR], "transaction": {"chainId": hex(chain)}}


def link_tx(n=3, vault=VAULT, escrow=ESCROW, chain=CHAIN):
    return {"hash": h(n), "transactionType": "CALL", "function": "setEscrow(address)", "contractAddress": vault, "arguments": [escrow], "transaction": {"chainId": hex(chain), "to": vault}}


def rcpt(tx, block, status="0x1", created=None):
    return {"transactionHash": tx["hash"], "status": status, "blockNumber": hex(block), "gasUsed": "0x1", "contractAddress": created}


class Dir:
    """A throwaway broadcast directory; also writes run-latest.json (a copy) and a dry-run folder, like forge."""

    def __init__(self):
        self.t = tempfile.TemporaryDirectory()
        self.p = Path(self.t.name)

    def write(self, name, r):
        (self.p / name).write_text(json.dumps(r))

    def full(self, ts=100, commit="abc1234"):
        v, e, l = vault_tx(), escrow_tx(), link_tx()
        self.write(f"run-{ts}.json", run([v], [rcpt(v, 10, created=VAULT)], commit=commit))
        self.write(f"run-{ts + 1}.json", run([e], [rcpt(e, 11, created=ESCROW)], commit=commit))
        self.write(f"run-{ts + 2}.json", run([l], [rcpt(l, 12)], commit=commit))
        self.write("run-latest.json", run([l], [rcpt(l, 12)], commit=commit))
        (self.p / "dry-run").mkdir(exist_ok=True)
        (self.p / "dry-run" / "run-9.json").write_text("not even json")


class Discover(unittest.TestCase):
    def setUp(self):
        self.d = Dir()
        self.addCleanup(self.d.t.cleanup)

    def fail(self, pattern):
        with self.assertRaisesRegex(d.DiscoveryError, pattern):
            d.discover(self.d.p, CHAIN)

    def test_discovers_the_one_deployment_ignoring_latest_copy_and_dry_runs(self):
        self.d.full()
        out = d.discover(self.d.p, CHAIN)
        self.assertEqual((out["vault"]["address"], out["escrow"]["address"]), (VAULT, ESCROW))
        self.assertEqual((out["vault"]["txHash"], out["escrow"]["txHash"], out["link"]["txHash"]), (h(1), h(2), h(3)))
        self.assertEqual(out["sourceCommit"], "abc1234")

    def test_empty_or_missing_directory(self):
        self.fail("no run-")
        with self.assertRaisesRegex(d.DiscoveryError, "no run-"):
            d.discover(self.d.p / "nope", CHAIN)

    def test_old_deployment_left_in_the_directory_is_refused_not_guessed(self):
        self.d.full()
        old_v = vault_tx(11, addr="0x" + "cc" * 20)
        self.d.write("run-50.json", run([old_v], [rcpt(old_v, 5, created="0x" + "cc" * 20)]))
        self.fail("exactly one DuelyVault creation.*found 2.*Archive")

    def test_missing_link(self):
        self.d.full()
        (self.d.p / "run-102.json").unlink()
        self.fail("exactly one setEscrow link.*found 0")

    def test_failed_receipt(self):
        self.d.full()
        e = escrow_tx()
        self.d.write("run-101.json", run([e], [rcpt(e, 11, status="0x0", created=ESCROW)]))
        self.fail("no successful receipt")

    def test_missing_receipt(self):
        self.d.full()
        e = escrow_tx()
        self.d.write("run-101.json", run([e], []))
        self.fail("no successful receipt")

    def test_wrong_chain_in_the_run(self):
        self.d.full()
        v = vault_tx()
        self.d.write("run-100.json", run([v], [rcpt(v, 10, created=VAULT)], chain=1440000))
        self.fail("chain 1440000")

    def test_wrong_chain_in_a_transaction(self):
        self.d.full()
        v = vault_tx(chain=1440000)
        self.d.write("run-100.json", run([v], [rcpt(v, 10, created=VAULT)]))
        self.fail("not for chain")

    def test_escrow_built_for_another_vault(self):
        self.d.full()
        e = escrow_tx(vault="0x" + "dd" * 20)
        self.d.write("run-101.json", run([e], [rcpt(e, 11, created=ESCROW)]))
        self.fail("not constructed with the discovered vault")

    def test_link_to_another_escrow(self):
        self.d.full()
        l = link_tx(escrow="0x" + "ee" * 20)
        self.d.write("run-102.json", run([l], [rcpt(l, 12)]))
        self.fail("link is not setEscrow")

    def test_link_on_another_vault(self):
        self.d.full()
        l = link_tx(vault="0x" + "ee" * 20)
        self.d.write("run-102.json", run([l], [rcpt(l, 12)]))
        self.fail("link is not setEscrow")

    def test_record_address_must_match_the_receipt(self):
        self.d.full()
        v = vault_tx()
        self.d.write("run-100.json", run([v], [rcpt(v, 10, created="0x" + "99" * 20)]))
        self.fail("differs from its receipt")

    def test_order(self):
        self.d.full()
        v = vault_tx()
        self.d.write("run-100.json", run([v], [rcpt(v, 20, created=VAULT)]))
        self.fail("order")

    def test_mixed_commits(self):
        self.d.full()
        e = escrow_tx()
        self.d.write("run-101.json", run([e], [rcpt(e, 11, created=ESCROW)], commit="other"))
        self.fail("different")

    def test_unexpected_transaction(self):
        self.d.full()
        x = {"hash": h(9), "transactionType": "CALL", "function": "transfer(address,uint256)", "contractAddress": VAULT, "arguments": [], "transaction": {"chainId": hex(CHAIN)}}
        self.d.write("run-103.json", run([x], [rcpt(x, 13)]))
        self.fail("unexpected transaction")

    def test_all_three_in_one_run_file_is_fine(self):
        v, e, l = vault_tx(), escrow_tx(), link_tx()
        self.d.write("run-5.json", run([v, e, l], [rcpt(v, 10, created=VAULT), rcpt(e, 11, created=ESCROW), rcpt(l, 12)]))
        self.assertEqual(d.discover(self.d.p, CHAIN)["vault"]["address"], VAULT)


if __name__ == "__main__":
    unittest.main(verbosity=2)
