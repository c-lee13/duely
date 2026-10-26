#!/usr/bin/env python3
"""Move the existing V2 broadcast records out of the way before a NEW deployment (never deletes anything).

Usage (from contracts/):  python3 -I script/archive_v2_broadcast.py <label>      e.g. <label> = fixed90-fee3

broadcast/DeployV2.s.sol/  ->  broadcast/archive/DeployV2-<label>-<UTC timestamp>/
After this, forge writes the next deployment into a fresh broadcast/DeployV2.s.sol/, so verify_v2.py and
write_manifest_v2.py (which require exactly one deployment in that directory) see only the new one. The archived
records keep the old deployment auditable. Sends no transactions and touches no other directory.
"""
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "broadcast" / "DeployV2.s.sol"


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", sys.argv[1]):
        sys.exit("usage: archive_v2_broadcast.py <label>   (letters, digits, . _ - only)")
    if not SRC.is_dir():
        sys.exit(f"nothing to archive: {SRC.relative_to(ROOT)} does not exist")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = ROOT / "broadcast" / "archive" / f"DeployV2-{sys.argv[1]}-{stamp}"
    if dest.exists():
        sys.exit(f"{dest.relative_to(ROOT)} already exists; refusing to overwrite")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(SRC), str(dest))
    print(f"archived {SRC.relative_to(ROOT)} -> {dest.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
