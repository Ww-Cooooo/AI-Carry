import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildStartupCapsule, inspectStartupCapsule } from "./startup-capsule-contract.mjs";
import { buildVerifiedStartupProjection } from "./query-startup-capsule.mjs";
import { syncStartupCapsule } from "./sync-startup-capsule.mjs";

const assert = (condition, message) => { if (!condition) throw new Error(`Startup capsule sync test failed: ${message}`); };
const root = mkdtempSync(join(tmpdir(), "ai-carry-capsule-sync-"));
const write = (ref, source) => { const path = resolve(root, ...ref.split("/")); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source, "utf8"); };
const manifest = (mode) => `schema_version = 1\ninstance_id = "ac.sync"\nstate = "instance"\ncreated_from = "ai-carry@1.3.0"\ncreated_at = ""\n\n[direction]\ntype = "general"\nlocked = true\ndomain_id = ""\nlabel = ""\nscope_statement = ""\nout_of_scope_policy = "create-new-instance"\n\n[profile]\nstatus = "active"\nguidance_mode = "${mode}"\ndisplay_name = "测试助手"\nmission = "测试胶囊同步"\nlanguage = "zh-CN"\nuser_preferences_ref = "instance/profile/approved-profile.md"\ndomain_map_ref = "instance/maps/domain-map.toml"\nsignal_control_ref = "instance/signals/control.toml"\nsignal_map_ref = "instance/maps/signal-map.toml"\ntime_trigger_map_ref = "instance/maps/time-trigger-map.toml"\nhost_registry_ref = "instance/hosts/registry.toml"\n\n[learning]\npolicy = "risk-tiered"\nlow_risk_promotion = "explicit-confirmation-after-notice"\nmedium_high = "explicit-confirmation"\ndirect_user_instruction = "direct-authorization"\n\n[validation]\nevidence_index_ref = "instance/validations/index.toml"\n\n[versions]\nproduct = "2.0.9"\nevolution_candidate_index_schema = "1.0"\nasset_confirmation_gate_schema = "1.0"\nresult_validation_evidence_schema = "1.0"\n`;
try {
  write("core/manifest.toml", `schema_version = 1\ncore_id = "ai-carry-core"\nversion = "2.0.9"\n\n[entry]\nroot_map = "core/maps/root-map.toml"\n`);
  write("instance/manifest.toml", manifest("balanced")); write("instance/startup-capsule.toml", buildStartupCapsule(root).source);
  assert(syncStartupCapsule(root).decision === "startup-capsule-current", "unchanged capsule was not idempotent");

  const manifestBytes = readFileSync(resolve(root, "instance/manifest.toml"));
  const crlfCapsule = buildStartupCapsule(root).source.replaceAll("\n", "\r\n");
  write("instance/startup-capsule.toml", crlfCapsule);
  const repairedCrlf = buildVerifiedStartupProjection(root, { repairDerived: true });
  assert(repairedCrlf.decision === "startup-capsule-valid" && repairedCrlf.repair?.state === "repaired"
    && repairedCrlf.repair?.attempt_count === 1 && repairedCrlf.repair?.data_state.includes("用户资产")
    && !readFileSync(resolve(root, "instance/startup-capsule.toml"), "utf8").includes("\r")
    && readFileSync(resolve(root, "instance/manifest.toml")).equals(manifestBytes),
  "the startup query did not repair one CRLF-only derived capsule and report unchanged source truth");
  const stableCapsuleBytes = readFileSync(resolve(root, "instance/startup-capsule.toml"));
  const repeatedProjection = buildVerifiedStartupProjection(root, { repairDerived: true });
  assert(repeatedProjection.decision === "startup-capsule-valid" && !Object.hasOwn(repeatedProjection, "repair")
    && readFileSync(resolve(root, "instance/startup-capsule.toml")).equals(stableCapsuleBytes),
  "a second healthy startup query refreshed or re-reported the derived capsule repair");

  write("instance/manifest.toml", manifest("direct"));
  assert(inspectStartupCapsule(root).decision === "startup-repair-required" && syncStartupCapsule(root).decision === "startup-capsule-update-required", "manifest drift did not require a capsule update");
  const repairedStale = buildVerifiedStartupProjection(root, { repairDerived: true });
  assert(repairedStale.decision === "startup-capsule-valid" && repairedStale.guidance_mode === "direct"
    && repairedStale.repair?.state === "repaired", "startup did not repair and retry one stale capsule");
  assert(syncStartupCapsule(root, { write: true }).updated === false, "second capsule sync changed bytes");

  const validManifest = readFileSync(resolve(root, "instance/manifest.toml"), "utf8");
  const validCapsule = readFileSync(resolve(root, "instance/startup-capsule.toml"));
  write("instance/manifest.toml", validManifest.replaceAll("\n", "\r\n"));
  const invalidManifest = buildVerifiedStartupProjection(root, { repairDerived: true });
  assert(invalidManifest.decision === "startup-repair-required" && invalidManifest.reason === "manifest-or-core-contract-invalid"
    && invalidManifest.repairable === false && invalidManifest.ordinary_work_allowed === true
    && invalidManifest.affected_scope === "identity-dependent-persistent-actions"
    && invalidManifest.user_summary.includes("普通对话") && !Object.hasOwn(invalidManifest, "repair")
    && readFileSync(resolve(root, "instance/startup-capsule.toml")).equals(validCapsule),
  "an invalid manifest was treated as a repairable derived capsule, blocked unrelated work, or changed capsule bytes");
  write("instance/manifest.toml", validManifest);

  write("instance/startup-capsule.toml", buildStartupCapsule(root).source.replaceAll("\n", "\r\n"));
  const beforeFault = readFileSync(resolve(root, "instance/startup-capsule.toml"));
  const failedRepair = buildVerifiedStartupProjection(root, { repairDerived: true, testFaultAfterInstall: true });
  assert(failedRepair.decision === "startup-degraded" && failedRepair.reason === "capsule-auto-repair-failed"
    && failedRepair.persistence_limited === true && failedRepair.repair?.state === "fallback-active"
    && failedRepair.repair?.still_usable.includes("普通对话")
    && readFileSync(resolve(root, "instance/startup-capsule.toml")).equals(beforeFault),
  "a failed automatic capsule repair did not roll back, fall back to formal sources, and report the limited state in natural language");
  assert(buildVerifiedStartupProjection(root, { repairDerived: true }).decision === "startup-capsule-valid",
    "a clean startup retry could not recover after one rolled-back automatic repair");

  unlinkSync(resolve(root, "instance/startup-capsule.toml"));
  const repairedMissing = buildVerifiedStartupProjection(root, { repairDerived: true });
  assert(repairedMissing.decision === "startup-capsule-valid" && repairedMissing.repair?.state === "repaired"
    && existsSync(resolve(root, "instance/startup-capsule.toml")), "startup did not repair and retry a missing derived capsule");
  // No OS links are created here. Synthetic lstat metadata exercises refusal
  // of both linked ancestors before either the query or direct sync can write.
  const ordinaryLstat = fs.lstatSync;
  for (const ancestor of ["instance", "core"]) {
    for (const kind of ["symbolic-link", "reparse-point"]) {
      unlinkSync(resolve(root, "instance/startup-capsule.toml"));
      const manifestBefore = readFileSync(resolve(root, "instance/manifest.toml"));
      try {
        fs.lstatSync = (path, ...options) => {
          const info = ordinaryLstat(path, ...options);
          if (resolve(path) !== resolve(root, ancestor)) return info;
          return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
            isSymbolicLink: () => kind === "symbolic-link",
            isReparsePoint: () => kind === "reparse-point",
          });
        };
        syncBuiltinESMExports();
        const refused = buildVerifiedStartupProjection(root, { repairDerived: true });
        assert(refused.decision === "startup-repair-required" && refused.repairable === false
          && refused.ordinary_work_allowed === true && !existsSync(resolve(root, "instance/startup-capsule.toml")),
        `${ancestor} ${kind} was trusted by startup auto-repair`);
        let directRefused = false;
        try { syncStartupCapsule(root, { write: true }); } catch { directRefused = true; }
        assert(directRefused && !existsSync(resolve(root, "instance/startup-capsule.toml")),
          `${ancestor} ${kind} was followed by the direct capsule writer`);
      } finally {
        fs.lstatSync = ordinaryLstat;
        syncBuiltinESMExports();
      }
      assert(readFileSync(resolve(root, "instance/manifest.toml")).equals(manifestBefore),
        "ancestor refusal modified the instance manifest");
      assert(syncStartupCapsule(root, { write: true }).decision === "startup-capsule-updated",
        "physical-path capsule repair did not remain available after local refusal");
    }
  }
  console.log("Startup capsule sync passed one-attempt repairs, fallback, source preservation, synthetic linked-ancestor refusal, and idempotence checks (no OS link creation).");
} finally { rmSync(root, { recursive: true, force: true }); }
