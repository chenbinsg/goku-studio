#!/usr/bin/env python3
"""
install_skill_pack.py — One-click installer for AIOS industry skill packs.

Usage:
    python3 install_skill_pack.py japan-ir-skill-pack
    python3 install_skill_pack.py market-intelligence-skill-pack
    python3 install_skill_pack.py --list
    python3 install_skill_pack.py --all

The script calls the AIOS API to install the skill pack, so the backend
must be running.  Authenticate first with `aios-cli login`.

Environment variables:
    AIOS_BASE_URL   Backend URL (default: http://localhost:8106)
    AIOS_TOKEN      JWT token (reads from ~/.aios/config.json if not set)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────

BASE_URL = os.environ.get("AIOS_BASE_URL", "http://localhost:8106")

# All packable industry skill packs (in recommended install order)
INDUSTRY_PACKS = [
    "japan-ir-skill-pack",
    "market-intelligence-skill-pack",
]

# ── Auth helper ───────────────────────────────────────────────────────────────

def _get_token() -> str:
    token = os.environ.get("AIOS_TOKEN", "")
    if token:
        return token
    cfg_path = Path.home() / ".aios" / "config.json"
    if cfg_path.exists():
        try:
            data = json.loads(cfg_path.read_text())
            return data.get("token", "")
        except Exception:
            pass
    return ""


def _headers(token: str) -> dict:
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h

# ── API helpers ───────────────────────────────────────────────────────────────

def _request(method: str, path: str, body: dict | None = None, token: str = "") -> dict:
    url = BASE_URL.rstrip("/") + path
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=_headers(token), method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"  ✗ HTTP {e.code}: {body[:200]}", file=sys.stderr)
        return {"error": f"HTTP {e.code}"}
    except urllib.error.URLError as e:
        print(f"  ✗ Connection failed: {e.reason}", file=sys.stderr)
        print(f"    Is the backend running at {BASE_URL}?", file=sys.stderr)
        return {"error": str(e.reason)}


def list_packs(token: str) -> None:
    """List available skill packs from the marketplace."""
    result = _request("GET", "/api/v1/skills?category=finance", token=token)
    items = result.get("items", [])
    if not items:
        print("No finance skill packs found in marketplace.")
        return
    print(f"\n{'ID':<40} {'Name':<35} {'Version':<10} {'Packable'}")
    print("-" * 95)
    for s in items:
        packable = "✓" if s.get("packable") else ""
        print(f"{s['id']:<40} {s['name'][:34]:<35} {s.get('latest_version','?'):<10} {packable}")


def install_pack(skill_id: str, token: str, version: str = "") -> bool:
    """Install a single skill pack. Returns True on success."""
    print(f"\n▶ Installing: {skill_id}")

    # Load manifest for display
    manifest_path = Path(__file__).parent / skill_id / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        tools = manifest.get("tools", [])
        print(f"  Tools: {len(tools)} tools")
        print(f"  Permissions: {', '.join(manifest.get('permissions_required', []))}")
        deps = manifest.get("dependencies", [])
        if deps:
            print(f"  Dependencies: {', '.join(deps)}")

    # Call marketplace install API
    body = {"skill_id": skill_id, "version": version or ""}
    result = _request("POST", "/api/v1/skills/install", body=body, token=token)

    if "error" in result:
        print(f"  ✗ Failed: {result['error']}")
        return False

    status = result.get("status", "")
    if status == "already_installed":
        print(f"  ℹ Already installed (v{result.get('version', '?')})")
        return True
    if status == "installed":
        print(f"  ✓ Installed v{result.get('version', '?')}")
        if result.get("restart_required"):
            print("  ⚠ Restart required to activate tools")
        return True

    print(f"  ? Unexpected response: {result}")
    return False


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="AIOS Industry Skill Pack Installer",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 install_skill_pack.py --list
  python3 install_skill_pack.py japan-ir-skill-pack
  python3 install_skill_pack.py market-intelligence-skill-pack
  python3 install_skill_pack.py --all
        """.strip(),
    )
    parser.add_argument("pack_id", nargs="?", help="Skill pack ID to install")
    parser.add_argument("--list",    action="store_true", help="List available packs")
    parser.add_argument("--all",     action="store_true", help="Install all industry packs")
    parser.add_argument("--version", default="",          help="Specific version to install")
    args = parser.parse_args()

    token = _get_token()
    if not token:
        print("⚠ No auth token found. Set AIOS_TOKEN or run `aios-cli login` first.")

    if args.list:
        list_packs(token)
        return

    packs_to_install: list[str] = []
    if args.all:
        packs_to_install = list(INDUSTRY_PACKS)
    elif args.pack_id:
        packs_to_install = [args.pack_id]
    else:
        parser.print_help()
        sys.exit(0)

    print(f"\nAIOS Skill Pack Installer — {BASE_URL}")
    print("=" * 60)

    successes = 0
    for pack_id in packs_to_install:
        ok = install_pack(pack_id, token, version=args.version)
        if ok:
            successes += 1

    print("\n" + "=" * 60)
    print(f"Done: {successes}/{len(packs_to_install)} pack(s) installed successfully.")
    if successes < len(packs_to_install):
        sys.exit(1)


if __name__ == "__main__":
    main()
