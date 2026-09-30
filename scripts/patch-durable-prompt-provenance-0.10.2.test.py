"""Transaction safety tests; published-package behavior is covered by process-restart regression."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "compat_patch", Path(__file__).with_name("patch-durable-prompt-provenance-0.10.2.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PatchTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.roots = {name: root / name for name in ("server", "protocol")}
        self.backup = root / "backup"
        entries = []
        for name, package in self.roots.items():
            package.mkdir()
            (package / "package.json").write_text(
                json.dumps({"name": f"@getpaseo/{name}", "version": "0.10.2"})
            )
            (package / "target.js").write_bytes(b"original\n")
            entries.append({
                "package": name, "path": "target.js",
                "originalSha256": module.digest(b"original\n"),
                "patchedSha256": module.digest(b"patched\n"),
                "replacements": [["original", "patched"]],
            })
        fixture = {"version": "0.10.2", "files": entries}
        active = patch.object(module, "SPEC", fixture)
        active.start()
        self.addCleanup(active.stop)

    def test_new_module_is_removed_by_rollback_and_unknown_content_refuses(self):
        content = "export const value = 1;\n"
        entry = {"package": "server", "path": "new.js", "create": True,
                 "originalSha256": module.digest(b""), "patchedSha256": module.digest(content.encode()), "content": content}
        module.SPEC["files"].append(entry)
        module.execute(self.roots, self.backup)
        self.assertEqual((self.roots["server"] / "new.js").read_text(), content)
        module.execute(self.roots, self.backup, rollback=True)
        self.assertFalse((self.roots["server"] / "new.js").exists())
        (self.roots["server"] / "new.js").write_text("unknown")
        with self.assertRaisesRegex(ValueError, "Unknown code"):
            module.execute(self.roots, self.backup)
        self.assertEqual((self.roots["server"] / "target.js").read_bytes(), b"original\n")

    def test_apply_check_and_rollback_are_idempotent(self):
        self.assertEqual(module.execute(self.roots, self.backup, check=True), 1)
        for _ in range(2):
            self.assertEqual(module.execute(self.roots, self.backup), 0)
        self.assertEqual(module.execute(self.roots, self.backup, check=True), 0)
        for _ in range(2):
            self.assertEqual(module.execute(self.roots, self.backup, rollback=True), 0)
        for root in self.roots.values():
            self.assertEqual((root / "target.js").read_bytes(), b"original\n")

    def test_unknown_last_file_refuses_before_any_write(self):
        (self.roots["protocol"] / "target.js").write_bytes(b"unknown\n")
        with self.assertRaisesRegex(ValueError, "Unknown code"):
            module.execute(self.roots, self.backup)
        self.assertEqual((self.roots["server"] / "target.js").read_bytes(), b"original\n")
        self.assertFalse(self.backup.exists())

    def test_unknown_version_and_corrupt_backup_refuse(self):
        module.execute(self.roots, self.backup)
        (self.backup / "protocol/target.js").write_bytes(b"bad backup")
        with self.assertRaisesRegex(ValueError, "Backup fingerprint"):
            module.execute(self.roots, self.backup, rollback=True)
        self.assertEqual((self.roots["server"] / "target.js").read_bytes(), b"patched\n")
        (self.roots["protocol"] / "package.json").write_text(
            json.dumps({"name": "@getpaseo/protocol", "version": "0.10.3"})
        )
        with self.assertRaisesRegex(ValueError, "Expected"):
            module.execute(self.roots, self.backup)

    def test_failed_second_target_restores_first_target(self):
        module.execute(self.roots, self.backup)
        module.execute(self.roots, self.backup, rollback=True)
        original_write = module.atomic_write
        calls = 0

        def fail_second(path, data, mode):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated disk write failure")
            original_write(path, data, mode)

        with patch.object(module, "atomic_write", fail_second):
            with self.assertRaisesRegex(OSError, "simulated"):
                module.execute(self.roots, self.backup)
        for root in self.roots.values():
            self.assertEqual((root / "target.js").read_bytes(), b"original\n")


if __name__ == "__main__":
    unittest.main()
