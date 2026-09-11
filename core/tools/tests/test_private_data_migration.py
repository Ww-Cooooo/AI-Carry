from __future__ import annotations

import json
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "private_data_migration.py"
POLICY_REL = Path("workspace/portable-fixture/config/local-data-migration.policy.json")
CONTRACT_REL = POLICY_REL.with_name("portable-path-contract.json")
LOCAL_DATA_REL = Path(".assistant-local/portable-fixture-data")

POLICY = {
    "schemaVersion": 1,
    "policyId": "portable-fixture-local-data-migration",
    "sourceRoot": LOCAL_DATA_REL.as_posix(),
    "archiveRoot": "private-package/business-data/portable-fixture",
    "restoreRoot": LOCAL_DATA_REL.as_posix(),
    "purposePrefix": "business-data:portable-fixture",
    "portableScope": "portable-fixture-data",
    "pathContract": CONTRACT_REL.name,
    "includePatterns": ["watchlist.json", "feedback/**", "jobs/**"],
    "excludePatterns": ["**/*.log", "jobs/**/keyframes/**"],
    "allowedExtensions": [".claim", ".json", ".md", ".mp4", ".txt"],
    "categories": {"watchlist.json": "watchlist", "feedback": "feedback", "jobs": "jobs"},
    "limits": {
        "maxFiles": 100,
        "maxTotalBytes": 10485760,
        "maxSingleFileBytes": 5242880,
        "maxCompressionRatio": 1000,
    },
}

CONTRACT = {
    "schemaVersion": 1,
    "contractId": "portable-fixture-paths",
    "referencePrefix": "ac-path:",
    "scopes": {
        "portable-fixture-data": {"root": LOCAL_DATA_REL.as_posix(), "migration": "included-by-policy"},
        "instance-root": {"root": ".", "migration": "supplied-by-assistant-body"},
        "external-input": {"root": None, "migration": "resupply-required"},
    },
}


class PrivateDataMigrationTests(unittest.TestCase):
    def test_completed_import_cleanup_failure_does_not_block_use_or_retry(self) -> None:
        spec = importlib.util.spec_from_file_location("migration_cleanup_fixture", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        base = Path(tempfile.mkdtemp(prefix="ai-carry-import-cleanup-"))
        passed = False
        try:
            source, target, output = base / "source", base / "target", base / "output"
            self.make_instance(source)
            self.make_instance(target)
            restored = target / ".assistant-private/assets/private.profile.example.md"
            restored.unlink()
            exported = module.export_package(source, output, POLICY_REL)
            package = Path(exported["package_path"])
            before = (source / ".assistant-private/assets/private.profile.example.md").read_bytes()

            def interrupted_cleanup(path):
                # Simulate a partial recursive cleanup, not just a failure
                # before deletion: its journal is already gone.
                (Path(path) / "transaction.json").unlink(missing_ok=True)
                raise PermissionError("synthetic cleanup failure")

            with mock.patch.object(module.shutil, "rmtree", side_effect=interrupted_cleanup):
                result = module.import_package(package, target, policy_path=POLICY_REL)
                self.assertEqual(result["status"], "validated")
                self.assertEqual(result["transaction_artifacts_remaining"], 1)
                self.assertTrue(result["cleanup_warnings"])
                self.assertEqual(restored.read_bytes(), before)
                again = module.import_package(package, target, policy_path=POLICY_REL)
                self.assertEqual(again["written"], 0)
                self.assertEqual(again["transaction_artifacts_remaining"], 1)
                self.assertEqual(restored.read_bytes(), before)
            final = module.import_package(package, target, policy_path=POLICY_REL)
            self.assertEqual(final["written"], 0)
            self.assertEqual(final["transaction_artifacts_remaining"], 0)
            self.assertEqual(restored.read_bytes(), before)
            passed = True
        finally:
            if passed:
                shutil.rmtree(base)
            else:
                print(f"Import cleanup failure evidence kept at {base}", file=sys.stderr)

    def make_instance(self, root: Path) -> None:
        (root / "instance" / "profile").mkdir(parents=True)
        (root / ".assistant-private" / "assets").mkdir(parents=True)
        (root / LOCAL_DATA_REL / "feedback").mkdir(parents=True)
        policy_target = root / POLICY_REL
        policy_target.parent.mkdir(parents=True)
        policy_target.write_text(json.dumps(POLICY, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (root / CONTRACT_REL).write_text(json.dumps(CONTRACT, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (root / "assistant.toml").write_text('product_version = "1.1.0"\nasset_schema = "1.2"\n', encoding="utf-8")
        (root / "instance" / "manifest.toml").write_text(
            'instance_id = "ac.test.instance"\n[versions]\nasset_schema = "1.2"\n', encoding="utf-8"
        )
        (root / "instance" / "profile" / "README.md").write_text(
            "stable reference: private.profile.example\n", encoding="utf-8"
        )
        (root / ".assistant-private" / "assets" / "private.profile.example.md").write_text(
            "local private preference\n", encoding="utf-8"
        )
        (root / LOCAL_DATA_REL / "watchlist.json").write_text(
            '{"items": []}\n', encoding="utf-8"
        )
        (root / LOCAL_DATA_REL / "feedback" / "index.json").write_text(
            '{"processed": 1, "localArtifact": "ac-path:portable-fixture-data/feedback/index.json", "rebuildableFrame": "ac-path:portable-fixture-data/jobs/real-1/keyframes/frame-01.jpg", "externalInput": "ac-path:external-input/user-supplied-video.mp4"}\n',
            encoding="utf-8",
        )
        log = root / LOCAL_DATA_REL / "jobs" / "real-1" / "download.log"
        log.parent.mkdir(parents=True)
        log.write_text("rebuildable log\n", encoding="utf-8")
        (log.parent / ".run-local.claim").write_text(
            '{"schemaVersion": 1, "claimedAt": "2026-08-19T00:00:00Z", "pid": 1234}\n',
            encoding="utf-8",
        )

    def run_tool(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

    def test_export_verify_preview_and_import_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "source"
            target = base / "target"
            output = base / "output"
            self.make_instance(source)
            self.make_instance(target)
            for path in [
                target / ".assistant-private" / "assets" / "private.profile.example.md",
                target / LOCAL_DATA_REL / "watchlist.json",
                target / LOCAL_DATA_REL / "feedback" / "index.json",
                target / LOCAL_DATA_REL / "jobs" / "real-1" / ".run-local.claim",
            ]:
                path.unlink()

            exported = self.run_tool("export", "--root", str(source), "--output-dir", str(output), "--policy", POLICY_REL.as_posix())
            self.assertEqual(exported.returncode, 0, exported.stdout + exported.stderr)
            export_result = json.loads(exported.stdout)
            package = Path(export_result["package_path"])
            self.assertTrue(package.is_file())
            self.assertEqual(export_result["entry_count"], 4)
            self.assertEqual(export_result["entry_counts"]["private_asset"], 1)
            self.assertEqual(export_result["entry_counts"]["local_business_data"], 3)

            verified = self.run_tool("verify", "--package", str(package), "--root", str(source), "--policy", POLICY_REL.as_posix())
            self.assertEqual(verified.returncode, 0, verified.stdout + verified.stderr)
            self.assertEqual(json.loads(verified.stdout)["secret_scan"]["finding_count"], 0)
            self.assertEqual(json.loads(verified.stdout)["portable_paths"]["status"], "passed")
            self.assertEqual(json.loads(verified.stdout)["portable_paths"]["reconstructable_missing"], 1)
            self.assertEqual(json.loads(verified.stdout)["portable_paths"]["external_input_resupply"], 1)

            expected_watchlist = (source / LOCAL_DATA_REL / "watchlist.json").read_bytes()
            expected_claim = (source / LOCAL_DATA_REL / "jobs" / "real-1" / ".run-local.claim").read_bytes()
            shutil.rmtree(source)

            preview = self.run_tool("preview-import", "--package", str(package), "--target-root", str(target), "--policy", POLICY_REL.as_posix())
            self.assertEqual(preview.returncode, 0, preview.stdout + preview.stderr)
            self.assertEqual(json.loads(preview.stdout)["counts"], {"conflict": 0, "new": 4, "same": 0})
            self.assertEqual(json.loads(preview.stdout)["verification"]["portable_paths"]["reconstructable_missing"], 1)

            restored = self.run_tool("import", "--package", str(package), "--target-root", str(target), "--policy", POLICY_REL.as_posix())
            self.assertEqual(restored.returncode, 0, restored.stdout + restored.stderr)
            self.assertEqual(json.loads(restored.stdout)["post_import_mismatches"], 0)
            self.assertEqual(
                (target / LOCAL_DATA_REL / "watchlist.json").read_bytes(),
                expected_watchlist,
            )
            self.assertEqual(
                (target / LOCAL_DATA_REL / "jobs" / "real-1" / ".run-local.claim").read_bytes(),
                expected_claim,
            )
            restored_index = json.loads(
                (target / LOCAL_DATA_REL / "feedback" / "index.json").read_text(encoding="utf-8")
            )
            prefix = "ac-path:portable-fixture-data/"
            self.assertTrue(restored_index["localArtifact"].startswith(prefix))
            restored_target = target / LOCAL_DATA_REL / restored_index["localArtifact"][len(prefix):]
            self.assertTrue(restored_target.is_file())

            repeated = self.run_tool("import", "--package", str(package), "--target-root", str(target), "--policy", POLICY_REL.as_posix())
            self.assertEqual(repeated.returncode, 0, repeated.stdout + repeated.stderr)
            repeated_result = json.loads(repeated.stdout)
            self.assertEqual(repeated_result["written"], 0)
            self.assertEqual(repeated_result["same_skipped"], 4)

    def test_secret_scan_never_echoes_value(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "source"
            output = base / "output"
            self.make_instance(source)
            synthetic = "sk-" + ("A" * 32)
            target = source / LOCAL_DATA_REL / "feedback" / "index.json"
            target.write_text(json.dumps({"api_key": synthetic}), encoding="utf-8")
            result = self.run_tool("export", "--root", str(source), "--output-dir", str(output), "--policy", POLICY_REL.as_posix())
            self.assertEqual(result.returncode, 2)
            self.assertNotIn(synthetic, result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["error"], "secret-scan-blocked")
            self.assertGreater(payload["details"]["finding_count"], 0)

    def test_unsafe_archive_path_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            package = Path(temp) / "unsafe.zip"
            manifest = {
                "schema_version": 2,
                "package_type": "ai-carry-private-migration",
                "package_id": "pvt-test",
                "source_instance_id": "ac.test.instance",
                "credentials_included": False,
                "entries": [],
            }
            with zipfile.ZipFile(package, "w") as archive:
                archive.writestr("private-package/manifest.json", json.dumps(manifest))
                archive.writestr("../escape.txt", "blocked")
            result = self.run_tool("verify", "--package", str(package))
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)["error"], "unsafe-relative-path")

    def test_cross_platform_case_collision_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            package = Path(temp) / "collision.zip"
            manifest = {
                "schema_version": 2,
                "package_type": "ai-carry-private-migration",
                "package_id": "pvt-test",
                "source_instance_id": "ac.test.instance",
                "credentials_included": False,
                "entries": [],
            }
            with zipfile.ZipFile(package, "w") as archive:
                archive.writestr("private-package/manifest.json", json.dumps(manifest))
                archive.writestr("private-package/assets/Example.txt", "one")
                archive.writestr("private-package/assets/example.txt", "two")
            result = self.run_tool("verify", "--package", str(package))
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)["error"], "portable-path-collision")

    def test_legacy_agent_carry_package_identity_remains_readable(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            package = Path(temp) / "legacy-agent-carry-private.zip"
            manifest = {
                "schema_version": 1,
                "package_type": "agent-carry-private-migration",
                "package_id": "pvt-legacy-agent-carry",
                "source_instance_id": "ac.legacy.instance",
                "credentials_included": False,
                "entries": [],
            }
            with zipfile.ZipFile(package, "w") as archive:
                archive.writestr("private-package/manifest.json", json.dumps(manifest))
            result = self.run_tool("verify", "--package", str(package))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["status"], "validated")
            self.assertEqual(payload["entry_count"], 0)

    def test_absolute_json_path_blocks_export_without_echoing_value(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "source"
            output = base / "output"
            self.make_instance(source)
            synthetic_path = r"C:\private-location\do-not-echo\artifact.json"
            target = source / LOCAL_DATA_REL / "feedback" / "index.json"
            target.write_text(json.dumps({"artifact": synthetic_path}), encoding="utf-8")
            result = self.run_tool("export", "--root", str(source), "--output-dir", str(output), "--policy", POLICY_REL.as_posix())
            self.assertEqual(result.returncode, 2)
            self.assertNotIn(synthetic_path, result.stdout)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["error"], "nonportable-json-blocked")
            self.assertEqual(payload["details"]["finding_count"], 1)

    def test_corrupt_json_is_preserved_and_blocks_export(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "source"
            output = base / "output"
            self.make_instance(source)
            target = source / LOCAL_DATA_REL / "feedback" / "index.json"
            original = b'{"unfinished": '
            target.write_bytes(original)
            result = self.run_tool("export", "--root", str(source), "--output-dir", str(output), "--policy", POLICY_REL.as_posix())
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)["error"], "invalid-json")
            self.assertEqual(target.read_bytes(), original)
            self.assertFalse(output.exists() and any(output.iterdir()))

    def test_unknown_logical_scope_fails_closed_and_removes_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "source"
            output = base / "output"
            self.make_instance(source)
            target = source / LOCAL_DATA_REL / "feedback" / "index.json"
            target.write_text('{"artifact":"ac-path:unknown-scope/file.json"}\n', encoding="utf-8")
            result = self.run_tool("export", "--root", str(source), "--output-dir", str(output), "--policy", POLICY_REL.as_posix())
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)["error"], "portable-reference-target-missing")
            self.assertEqual(list(output.iterdir()), [])

    def test_interrupted_multi_file_import_rolls_back_then_retries_cleanly(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "source"
            target = base / "different-absolute-target"
            output = base / "output"
            self.make_instance(source)
            self.make_instance(target)
            removable = [
                target / ".assistant-private" / "assets" / "private.profile.example.md",
                target / LOCAL_DATA_REL / "watchlist.json",
                target / LOCAL_DATA_REL / "feedback" / "index.json",
                target / LOCAL_DATA_REL / "jobs" / "real-1" / ".run-local.claim",
            ]
            for path in removable:
                path.unlink()
            exported = self.run_tool("export", "--root", str(source), "--output-dir", str(output), "--policy", POLICY_REL.as_posix())
            self.assertEqual(exported.returncode, 0, exported.stdout + exported.stderr)
            package = Path(json.loads(exported.stdout)["package_path"])

            environment = os.environ.copy()
            environment["AI_CARRY_TEST_IMPORT_FAIL_AFTER"] = "2"
            interrupted = subprocess.run(
                [sys.executable, str(SCRIPT), "import", "--package", str(package), "--target-root", str(target), "--policy", POLICY_REL.as_posix()],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                env=environment,
            )
            self.assertEqual(interrupted.returncode, 2)
            self.assertEqual(json.loads(interrupted.stdout)["error"], "import-transaction-rolled-back")
            self.assertTrue(all(not path.exists() for path in removable))
            transaction_root = target / ".assistant-local" / "migration-transactions"
            self.assertEqual(list(transaction_root.iterdir()), [])

            restored = self.run_tool("import", "--package", str(package), "--target-root", str(target), "--policy", POLICY_REL.as_posix())
            self.assertEqual(restored.returncode, 0, restored.stdout + restored.stderr)
            result = json.loads(restored.stdout)
            self.assertEqual(result["post_import_mismatches"], 0)
            self.assertEqual(result["transaction_artifacts_remaining"], 0)


if __name__ == "__main__":
    unittest.main()
