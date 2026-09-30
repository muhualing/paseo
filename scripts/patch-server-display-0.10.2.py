#!/usr/bin/env python3
"""Apply server timeline display projection to verified 0.10.2 packages.

Run against an offline installation. This does not restart a service or update web assets.
Every target must match its published or patched SHA256 before any write occurs.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile


SPEC = json.loads(Path(__file__).with_name("server-display-0.10.2.json").read_text())
PROVENANCE_SPEC = json.loads(Path(__file__).with_name("durable-prompt-provenance-0.10.2.json").read_text())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(path, data, mode):
    fd, temporary = tempfile.mkstemp(prefix=".prompt-display-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def plan(roots):
    # Admission provenance is a security prerequisite, not a best-effort shim.
    for entry in PROVENANCE_SPEC["files"]:
        path = roots[entry["package"]] / entry["path"]
        if path.is_symlink() or not path.is_file() or digest(path.read_bytes()) != entry["patchedSha256"]:
            raise ValueError("Verified submitted prompt provenance patch is required")
    for name, root in roots.items():
        package = json.loads((root / "package.json").read_text())
        if package.get("name") != f"@getpaseo/{name}" or package.get("version") != SPEC["version"]:
            raise ValueError(f"Expected @getpaseo/{name} {SPEC['version']}")
    result = []
    for entry in SPEC["files"]:
        root = roots[entry["package"]]
        path = root / entry["path"]
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError("Target leaves the verified package root")
        current = path.read_bytes() if path.exists() else b""
        if not path.exists() and not entry.get("create"):
            raise ValueError("Missing published target")
        current_hash = digest(current)
        if entry.get("create") and path.exists() and current_hash != entry["patchedSha256"]:
            raise ValueError("Unknown code fingerprint for the added module")
        if current_hash not in (entry["originalSha256"], entry["patchedSha256"]):
            raise ValueError(f"Unknown code fingerprint: {entry['package']}/{entry['path']}")
        if entry.get("create"):
            original = ""
            updated = entry["content"]
        else:
            original = current.decode()
            if current_hash == entry["patchedSha256"]:
                for before, after in reversed(entry["replacements"]):
                    if original.count(after) != 1:
                        raise ValueError("Ambiguous reverse patch")
                    original = original.replace(after, before)
            updated = original
            for before, after in entry["replacements"]:
                if updated.count(before) != 1:
                    raise ValueError("Ambiguous patch location")
                updated = updated.replace(before, after)
        if digest(original.encode()) != entry["originalSha256"] or digest(updated.encode()) != entry["patchedSha256"]:
            raise ValueError("Patch manifest integrity mismatch")
        result.append((entry, path, current, original.encode(), updated.encode(), path.stat().st_mode & 0o777 if path.exists() else 0o644))
    return result


def execute(roots, backup, *, check=False, rollback=False):
    changes = plan(roots)
    if check:
        return 0 if all(current == updated for _, _, current, _, updated, _ in changes) else 1
    if any(backup.is_relative_to(root) for root in roots.values()):
        raise ValueError("Backup directory must be outside the package roots")
    identity = {name: str(root) for name, root in roots.items()}
    manifest = backup / "manifest.json"
    if manifest.is_symlink():
        raise ValueError("Backup manifest must not be a symlink")
    if rollback:
        if not manifest.exists() or json.loads(manifest.read_text()) != identity:
            raise ValueError("Backup does not belong to these package roots")
    else:
        if backup.exists() and any(backup.iterdir()) and not manifest.exists():
            raise ValueError("Backup directory is not empty")
        if manifest.exists() and json.loads(manifest.read_text()) != identity:
            raise ValueError("Backup belongs to different package roots")
        backup.mkdir(parents=True, exist_ok=True)
    # Validate every backup before creating or replacing any target.
    for entry, _, _, original, _, mode in changes:
        saved = backup / entry["package"] / entry["path"]
        if not saved.resolve().is_relative_to(backup):
            raise ValueError("Backup leaves its root")
        if saved.exists():
            if saved.is_symlink() or saved.read_bytes() != original:
                raise ValueError("Backup fingerprint mismatch")
        elif rollback:
            raise ValueError("Incomplete rollback backup")
    if not rollback:
        for entry, _, _, original, _, mode in changes:
            saved = backup / entry["package"] / entry["path"]
            if not saved.exists():
                saved.parent.mkdir(parents=True, exist_ok=True)
                atomic_write(saved, original, mode)
        if not manifest.exists():
            atomic_write(manifest, (json.dumps(identity, indent=2) + "\n").encode(), 0o600)
    written = []
    try:
        for _, path, current, original, updated, mode in changes:
            target = original if rollback else updated
            # Reject a concurrent edit between preflight and replacement.
            if (path.read_bytes() if path.exists() else b"") != current:
                raise ValueError("Target changed during patch transaction")
            if target != current:
                if target:
                    atomic_write(path, target, mode)
                else:
                    path.unlink(missing_ok=True)
                written.append((path, current, mode))
    except Exception:
        for path, current, mode in reversed(written):
            if current:
                atomic_write(path, current, mode)
            else:
                path.unlink(missing_ok=True)
        raise
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-root", type=Path, required=True)
    parser.add_argument("--backup-dir", type=Path, required=True)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true")
    action.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    roots = {"server": args.server_root.resolve()}
    try:
        result = execute(roots, args.backup_dir.resolve(), check=args.check, rollback=args.rollback)
    except (ValueError, OSError, KeyError) as error:
        print(f"Refused: {error}")
        return 2
    print("Verified" if args.check else "Rolled back" if args.rollback else "Applied (or already present)")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
