"""Offline display patch transaction and admission prerequisite checks."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("display_patch", Path(__file__).with_name("patch-server-display-0.10.2.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DisplayPatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "server"
        self.root.mkdir()
        self.roots = {"server": self.root}
        self.backup = self.root.parent / "backup"
        (self.root / "package.json").write_text(json.dumps({"name": "@getpaseo/server", "version": "0.10.2"}))
        (self.root / "session.js").write_text("original\n")
        (self.root / "provenance.js").write_text("trusted\n")
        fixture = {"version": "0.10.2", "files": [
            {"package": "server", "path": "session.js", "originalSha256": module.digest(b"original\n"), "patchedSha256": module.digest(b"patched\n"), "replacements": [["original", "patched"]]},
            {"package": "server", "path": "display.js", "create": True, "originalSha256": module.digest(b""), "patchedSha256": module.digest(b"display\n"), "content": "display\n"},
        ]}
        dependency = {"files": [{"package": "server", "path": "provenance.js", "patchedSha256": module.digest(b"trusted\n")}]}
        for name, value in (("SPEC", fixture), ("PROVENANCE_SPEC", dependency)):
            active = patch.object(module, name, value)
            active.start()
            self.addCleanup(active.stop)

    def test_apply_check_rollback_are_idempotent_and_preserve_prerequisite(self):
        self.assertEqual(module.execute(self.roots, self.backup, check=True), 1)
        for _ in range(2): self.assertEqual(module.execute(self.roots, self.backup), 0)
        self.assertEqual(module.execute(self.roots, self.backup, check=True), 0)
        for _ in range(2): self.assertEqual(module.execute(self.roots, self.backup, rollback=True), 0)
        self.assertEqual((self.root / "session.js").read_text(), "original\n")
        self.assertFalse((self.root / "display.js").exists())
        self.assertEqual((self.root / "provenance.js").read_text(), "trusted\n")

    def test_missing_or_unknown_provenance_refuses_before_writes(self):
        (self.root / "provenance.js").write_text("untrusted")
        with self.assertRaisesRegex(ValueError, "provenance patch is required"):
            module.execute(self.roots, self.backup)
        self.assertEqual((self.root / "session.js").read_text(), "original\n")
        self.assertFalse(self.backup.exists())

    def test_unknown_module_and_version_refuse_before_writes(self):
        (self.root / "display.js").write_text("unknown")
        with self.assertRaisesRegex(ValueError, "Unknown code"):
            module.execute(self.roots, self.backup)
        self.assertEqual((self.root / "session.js").read_text(), "original\n")
        (self.root / "display.js").unlink()
        (self.root / "package.json").write_text(json.dumps({"name": "@getpaseo/server", "version": "0.10.3"}))
        with self.assertRaisesRegex(ValueError, "Expected"):
            module.execute(self.roots, self.backup)

    def test_symlink_and_bad_backup_refuse(self):
        (self.root / "display.js").symlink_to(self.root / "session.js")
        with self.assertRaisesRegex(ValueError, "Target leaves"):
            module.execute(self.roots, self.backup)
        (self.root / "display.js").unlink()
        module.execute(self.roots, self.backup)
        (self.backup / "server/session.js").write_text("corrupt")
        with self.assertRaisesRegex(ValueError, "Backup fingerprint"):
            module.execute(self.roots, self.backup, rollback=True)
        self.assertEqual((self.root / "session.js").read_text(), "patched\n")

    def test_failed_last_write_restores_all_targets(self):
        module.execute(self.roots, self.backup)
        module.execute(self.roots, self.backup, rollback=True)
        original_write = module.atomic_write
        def fail_module(path, data, mode):
            if path.name == "display.js": raise OSError("interrupted")
            return original_write(path, data, mode)
        with patch.object(module, "atomic_write", fail_module):
            with self.assertRaisesRegex(OSError, "interrupted"):
                module.execute(self.roots, self.backup)
        self.assertEqual((self.root / "session.js").read_text(), "original\n")
        self.assertFalse((self.root / "display.js").exists())

if __name__ == "__main__": unittest.main()
