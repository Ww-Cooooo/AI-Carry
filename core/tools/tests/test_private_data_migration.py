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
    def load_tool(self):
        spec = importlib.util.spec_from_file_location("migration_regression_fixture", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module

    def interrupt_import(self, package: Path, target: Path, package_id: str, phase: str) -> None:
        # Terminate a real importer, bypassing Python exception cleanup. All
        # inputs are synthetic and the child releases its OS lock on exit.
        code = '''
import importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("migration_crash_fixture", sys.argv[1])
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
phase = sys.argv[5]
write = m.atomic_write_bytes
copy = m.copy_file_atomic
def interrupted_write(target, data):
    if target.name == "transaction.json" and phase == "before-journal":
        os._exit(23)
    write(target, data)
    if target.name == "transaction.json" and phase == "after-journal":
        os._exit(23)
def interrupted_copy(source, target, **kwargs):
    copy(source, target, **kwargs)
    if source.suffix == ".next" and phase == "after-first-write":
        os._exit(23)
m.atomic_write_bytes = interrupted_write
m.copy_file_atomic = interrupted_copy
m.import_package(Path(sys.argv[2]), Path(sys.argv[3]), policy_path=Path(sys.argv[6]),
                 overwrite_conflicts=True, confirmed_package_id=sys.argv[4])
sys.exit(99)
'''
        result = subprocess.run(
            [sys.executable, "-B", "-c", code, str(SCRIPT), str(package), str(target), package_id, phase, POLICY_REL.as_posix()],
            capture_output=True, text=True, encoding="utf-8", timeout=30,
        )
        self.assertEqual(result.returncode, 23, result.stdout + result.stderr)

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
            # 在运行时构造合成赋值，避免源码中的变量名被误当作凭据值。
            target.write_text(json.dumps(dict([("api_key", synthetic)])), encoding="utf-8")
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

    def test_json_credentials_and_escaped_values_block_export_and_verification(self) -> None:
        module = self.load_tool()
        synthetic = "SyntheticOnly0123456789ABCDE"
        cases = [json.dumps({"nested": [{field: synthetic}]}).encode() for field in
                 ("password", "client_secret", "api_key", "access_token", "aws_secret_access_key")]
        escaped = "".join(f"\\u{ord(char):04x}" for char in synthetic)
        cases.append(('{"pass\\u0077ord":"' + escaped + '"}').encode())
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, output = base / "source", base / "output"
            self.make_instance(source)
            for index, data in enumerate(cases):
                with self.subTest(case=index):
                    (source / LOCAL_DATA_REL / "feedback/index.json").write_bytes(data)
                    exported = self.run_tool("export", "--root", str(source), "--output-dir", str(output), "--policy", POLICY_REL.as_posix())
                    self.assertEqual(exported.returncode, 2, exported.stderr)
                    self.assertEqual(json.loads(exported.stdout)["error"], "secret-scan-blocked")
                    self.assertNotIn(synthetic, exported.stdout + exported.stderr)
                    self.assertEqual(list(output.iterdir()), [])
                    package = base / "synthetic-secret.zip"
                    archive_ref = "private-package/assets/private.example.json"
                    manifest = {
                        "schema_version": 3, "package_type": "ai-carry-private-migration",
                        "package_id": "pvt-synthetic-secret", "source_instance_id": "ac.test.instance",
                        "credentials_included": False,
                        "entries": [{"entry_kind": "private-asset", "relative_path": "private.example.json",
                                     "restore_path": ".assistant-private/assets/private.example.json", "archive_path": archive_ref,
                                     "asset_ref": "private.example", "size": len(data), "sha256": module.sha256_bytes(data),
                                     "conflict_policy": "preview-before-overwrite"}],
                    }
                    with zipfile.ZipFile(package, "w") as archive:
                        archive.writestr(module.MANIFEST_PATH, json.dumps(manifest))
                        archive.writestr(archive_ref, data)
                    verified = self.run_tool("verify", "--package", str(package))
                    self.assertEqual(verified.returncode, 2, verified.stderr)
                    self.assertEqual(json.loads(verified.stdout)["error"], "secret-scan-blocked")
                    self.assertNotIn(synthetic, verified.stdout + verified.stderr)

    def test_import_rejects_target_drift_since_internal_preview(self) -> None:
        module = self.load_tool()
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "source"
            self.make_instance(source)
            exported = module.export_package(source, base / "output", POLICY_REL)
            package = Path(exported["package_path"])
            for initial in ("missing", "same", "conflict"):
                with self.subTest(initial=initial):
                    target = base / initial
                    self.make_instance(target)
                    destination = target / ".assistant-private/assets/private.profile.example.md"
                    if initial == "missing":
                        destination.unlink()
                    elif initial == "conflict":
                        destination.write_bytes(b"confirmed old preference\n")
                    changed = b"new user work after internal preview\n"
                    real_preview = module.preview_import
                    def changed_after_preview(*args, **kwargs):
                        result = real_preview(*args, **kwargs)
                        destination.write_bytes(changed)
                        return result
                    with mock.patch.object(module, "preview_import", side_effect=changed_after_preview):
                        with self.assertRaises(module.MigrationError) as caught:
                            module.import_package(package, target, policy_path=POLICY_REL,
                                                  overwrite_conflicts=initial == "conflict", confirmed_package_id=exported["package_id"])
                    self.assertEqual(caught.exception.code, "import-concurrent-target-change")
                    self.assertEqual(destination.read_bytes(), changed)
                    self.assertFalse((target / ".assistant-local/migration-transactions").exists())

    def test_import_rechecks_destination_after_staging_before_replace(self) -> None:
        module = self.load_tool()
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "source"
            self.make_instance(source)
            exported = module.export_package(source, base / "output", POLICY_REL)
            for initial in ("missing", "existing"):
                with self.subTest(initial=initial):
                    target = base / initial
                    self.make_instance(target)
                    destination = target / ".assistant-private/assets/private.profile.example.md"
                    if initial == "missing":
                        destination.unlink()
                    else:
                        destination.write_bytes(b"confirmed old preference\n")
                    changed = b"new user work immediately before replacement\n"
                    real_copy = module.copy_file_atomic
                    def changed_before_replace(source_file, target_file, **kwargs):
                        if source_file.suffix == ".next":
                            guard = kwargs["before_replace"]
                            def changed_guard():
                                destination.write_bytes(changed)
                                guard()
                            kwargs["before_replace"] = changed_guard
                        return real_copy(source_file, target_file, **kwargs)
                    with mock.patch.object(module, "copy_file_atomic", side_effect=changed_before_replace):
                        with self.assertRaises(module.MigrationError) as caught:
                            module.import_package(Path(exported["package_path"]), target, policy_path=POLICY_REL,
                                                  overwrite_conflicts=initial == "existing", confirmed_package_id=exported["package_id"])
                    self.assertEqual(caught.exception.code, "import-concurrent-target-change")
                    self.assertEqual(destination.read_bytes(), changed)
                    self.assertEqual(len(list((target / ".assistant-local/migration-transactions").glob("import-*/transaction.json"))), 1)

    def test_preparation_process_death_is_retryable_without_target_writes(self) -> None:
        module = self.load_tool()
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "source"
            self.make_instance(source)
            exported = module.export_package(source, base / "output", POLICY_REL)
            for phase in ("before-journal", "after-journal"):
                with self.subTest(phase=phase):
                    target = base / phase
                    self.make_instance(target)
                    destination = target / ".assistant-private/assets/private.profile.example.md"
                    destination.unlink()
                    package = Path(exported["package_path"])
                    self.interrupt_import(package, target, exported["package_id"], phase)
                    transactions = target / ".assistant-local/migration-transactions"
                    self.assertTrue(all(path.name.startswith("preparing-import-") for path in transactions.iterdir()))
                    self.assertFalse(destination.exists())
                    result = module.import_package(package, target, policy_path=POLICY_REL)
                    self.assertEqual(result["status"], "validated")
                    self.assertEqual(destination.read_bytes(), (source / ".assistant-private/assets/private.profile.example.md").read_bytes())
                    self.assertEqual(list(transactions.iterdir()), [])

    def test_recovery_preserves_user_edit_after_real_process_interruption(self) -> None:
        module = self.load_tool()
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, target = base / "source", base / "target"
            self.make_instance(source)
            self.make_instance(target)
            first = target / ".assistant-private/assets/private.profile.example.md"
            later = target / LOCAL_DATA_REL / "watchlist.json"
            first.write_bytes(b"old preference\n")
            later.write_bytes(b'{"old":true}\n')
            exported = module.export_package(source, base / "output", POLICY_REL)
            package = Path(exported["package_path"])
            self.interrupt_import(package, target, exported["package_id"], "after-first-write")
            installed_first = first.read_bytes()
            changed = b'{"new_user_work":true}\n'
            later.write_bytes(changed)
            transaction = next((target / ".assistant-local/migration-transactions").glob("import-*"))
            journal = (transaction / "transaction.json").read_bytes()
            with self.assertRaises(module.MigrationError) as caught:
                module.import_package(package, target, policy_path=POLICY_REL)
            self.assertEqual(caught.exception.code, "import-concurrent-target-change")
            self.assertEqual(later.read_bytes(), changed)
            self.assertEqual(first.read_bytes(), installed_first, "recovery changed an earlier target before detecting later drift")
            self.assertEqual((transaction / "transaction.json").read_bytes(), journal)

    def test_conflicting_import_can_retry_after_verified_rollback(self) -> None:
        module = self.load_tool()
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, target = base / "source", base / "target"
            self.make_instance(source)
            self.make_instance(target)
            destinations = [target / ".assistant-private/assets/private.profile.example.md", target / LOCAL_DATA_REL / "watchlist.json"]
            before = [b"old preference\n", b'{"old":true}\n']
            for path, content in zip(destinations, before):
                path.write_bytes(content)
            exported = module.export_package(source, base / "output", POLICY_REL)
            args = (Path(exported["package_path"]), target)
            kwargs = {"policy_path": POLICY_REL, "overwrite_conflicts": True, "confirmed_package_id": exported["package_id"]}
            with mock.patch.dict(os.environ, {"AI_CARRY_TEST_IMPORT_FAIL_AFTER": "1"}):
                with self.assertRaises(module.MigrationError) as caught:
                    module.import_package(*args, **kwargs)
            self.assertEqual(caught.exception.code, "import-transaction-rolled-back")
            self.assertEqual([path.read_bytes() for path in destinations], before)
            backups = target / ".assistant-local/migration-backups"
            original = next(backups.glob("*.zip"))
            original_bytes = original.read_bytes()
            result = module.import_package(*args, **kwargs)
            self.assertEqual(result["status"], "validated")
            self.assertNotEqual(Path(result["backup_path"]), original)
            self.assertEqual(original.read_bytes(), original_bytes)
            self.assertEqual(len(list(backups.glob("*.zip"))), 2)
            self.assertEqual(module.import_package(*args, **kwargs)["written"], 0)

    def test_another_importer_cannot_recover_live_preparation(self) -> None:
        module = self.load_tool()
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, target = base / "source", base / "target"
            self.make_instance(source)
            self.make_instance(target)
            exported = module.export_package(source, base / "output", POLICY_REL)
            preparing = target / ".assistant-local/migration-transactions" / ("preparing-import-" + "a" * 32)
            preparing.mkdir(parents=True)
            marker = preparing / "live-stage"
            marker.write_bytes(b"staging is still in progress")
            with module.import_instance_lock(target):
                result = self.run_tool("import", "--package", exported["package_path"], "--target-root", str(target), "--policy", POLICY_REL.as_posix())
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(json.loads(result.stdout)["error"], "import-busy")
                self.assertTrue(marker.exists())
            result = module.import_package(Path(exported["package_path"]), target, policy_path=POLICY_REL)
            self.assertEqual(result["status"], "validated")
            self.assertFalse(preparing.exists())


if __name__ == "__main__":
    unittest.main()
