// One offline installed-instance journey: local files survive a real product
// switch, and a missing display cache cannot veto current-session reentry.
// The prior version is synthetic; this does not claim GitHub release authority.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confirmUpgrade, prepareUpgrade, releasePathPolicyFrom, validateCurrentSessionReentry } from "./ai-carry-upgrade-cli.mjs";
import { executeFirstInstantiation } from "./first-instantiation-transaction.mjs";
import { buildStartupCapsule, inspectStartupCapsule } from "./startup-capsule-contract.mjs";
import { buildVerifiedStartupProjection } from "./query-startup-capsule.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(resolve(repository, "dashboard/package.json"), "utf8")).version;
const scene = mkdtempSync(resolve(tmpdir(), "ai-carry-upgrade-local-"));
const target = resolve(scene, "target");
const source = resolve(scene, "installed");
const read = (root, ref) => readFileSync(resolve(root, ref));
const write = (root, ref, bytes) => {
  mkdirSync(dirname(resolve(root, ref)), { recursive: true });
  writeFileSync(resolve(root, ref), bytes);
};
let passed = false;
try {
  const policy = releasePathPolicyFrom(read(repository, `core/upgrade/release-manifest-${version}.toml`).toString("utf8"));
  const matches = (ref, pattern) => pattern.endsWith("/**") ? ref.startsWith(pattern.slice(0, -2)) : ref === pattern;
  const publicPatterns = [...policy.lists.replace, "instance/**", ...policy.exactZeroByteOverrides];
  // Also runs from a source ZIP: no Git checkout or private maintainer helper.
  // Descend only into product roots and the exact empty local placeholders.
  const copyPublic = (prefix = "") => {
    for (const entry of readdirSync(resolve(repository, prefix), { withFileTypes: true })) {
      const ref = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!publicPatterns.some((pattern) => matches(ref, pattern) || pattern.startsWith(`${ref}/`))) continue;
      if (ref.split("/").some((part) => policy.forbiddenSegments.has(part))
        && ![...policy.exactZeroByteOverrides].some((path) => path === ref || path.startsWith(`${ref}/`))) continue;
      assert(!entry.isSymbolicLink(), `linked product fixture input: ${ref}`);
      if (entry.isDirectory()) copyPublic(ref);
      else {
        mkdirSync(dirname(resolve(target, ref)), { recursive: true });
        copyFileSync(resolve(repository, ref), resolve(target, ref));
      }
    }
  };
  copyPublic();
  cpSync(target, source, { recursive: true, errorOnExist: true, force: false });
  const created = executeFirstInstantiation(source, {
    schema_version: 1, guidance_mode: "balanced", display_name: "隔离兼容助手", mission: "整理测试任务，不操作真实实例。",
    direction: { type: "general", label: "通用助手", scope_statement: "隔离目录中的合成任务。" },
    first_task: { title: "整理任务", summary: "保留未完成计划。", trigger: "继续整理任务" },
  }, { testIdentity: { instanceId: "ac-upgrade-local-fixture", createdAt: "2026-09-10T08:00:00Z" } });
  assert.equal(created.updated, true);
  assert.equal(inspectStartupCapsule(source).decision, "startup-capsule-valid");
  const control = read(source, "instance/signals/control.toml");
  write(source, "instance/signals/control.toml", "broken reminder metadata\n");
  const degradedReminder = buildVerifiedStartupProjection(source);
  assert.equal(degradedReminder.decision, "startup-capsule-valid");
  assert.equal(degradedReminder.signal.affectedScope, "cross-session-reminders-only");
  assert.equal(degradedReminder.signal.ordinaryWorkAllowed, true);
  write(source, "instance/signals/control.toml", control);
  rmSync(resolve(source, "instance/startup-capsule.toml"));
  assert.equal(buildVerifiedStartupProjection(source, { repairDerived: true }).decision, "startup-capsule-valid");
  for (const ref of ["assistant.toml", "core/manifest.toml", "instance/manifest.toml"]) {
    write(source, ref, read(source, ref).toString("utf8").replaceAll(`"${version}"`, '"2.0.10"'));
  }
  write(source, "instance/startup-capsule.toml", buildStartupCapsule(source).source);
  const preserved = new Map([
    [".planning/upgrade/task_plan.md", "An unfinished user plan; do not move or delete.\n"],
    ["AGENTS.override.md", "# Local preferences\nKeep the user's files.\n"],
    ["skills-lock.json", '{"local":"keep"}\n'],
    ["dashboard/node_modules/local-tool/package.json", '{"name":"never-execute"}\n'],
    [".assistant-local/tasks/ongoing.md", "Keep this task entry.\n"],
    [".assistant-private/assets/note.txt", "Synthetic private data; not for the target.\n"],
    ["workspace/local-tool/run.mjs", "throw new Error('never execute instance tools during an upgrade');\n"],
  ]);
  for (const [ref, bytes] of preserved) write(source, ref, bytes);
  for (const ref of ["instance/profile/approved-profile.md", "instance/maps/domain-map.toml", "instance/skills/requirements.toml"])
    preserved.set(ref, read(source, ref));
  const assertPreserved = () => {
    for (const [ref, bytes] of preserved) assert(read(source, ref).equals(Buffer.from(bytes)), `changed instance-owned ${ref}`);
  };

  const prepared = prepareUpgrade(source, target, { verifyOfficial: false });
  assert.equal(prepared.decision, "ai-carry-upgrade-confirmation-required");
  assert.equal(prepared.officialEvidence, null);
  assert(!existsSync(prepared.candidate), "prepare wrote a candidate");
  for (const ref of preserved.keys()) assert(!prepared.writePaths.includes(ref), `local file in write set: ${ref}`);
  assertPreserved();
  const switched = confirmUpgrade(source, target, prepared.confirmationRef, "确认升级");
  assert.equal(switched.updated, true, JSON.stringify(switched));
  assert.equal(switched.snapshotState, "current");
  assert.equal(switched.removedFileCount, 0);
  assert.equal(inspectStartupCapsule(source).decision, "startup-capsule-valid");
  assert(read(source, "dashboard/public/snapshot.js").equals(read(source, "dashboard/dist/snapshot.js")));
  assertPreserved();

  const reenter = () => validateCurrentSessionReentry(source, prepared.confirmationRef, prepared.instanceId,
    switched.derived.sourceManifestDigest, prepared.sourceVersion);
  assert.equal(reenter().snapshotState, "current");
  const coreBytes = read(source, "instance/manifest.toml");
  const snapshotBytes = read(source, "dashboard/public/snapshot.js");
  rmSync(resolve(source, "dashboard/public/snapshot.js"));
  const pending = reenter();
  assert.equal(pending.decision, "ai-carry-upgrade-target-runtime-validated");
  assert.equal(pending.snapshotState, "pending");
  assert.equal(pending.adoptionEvidence.snapshotCurrent, false);
  assert.equal(pending.adoptionEvidence.sessionActivated, false);
  assert.equal(pending.adoptionEvidence.behaviorAccepted, false);
  assert(pending.snapshotRefreshCommand && pending.snapshotWarning);
  const repeated = prepareUpgrade(source, target, { verifyOfficial: false });
  assert.equal(repeated.decision, "ai-carry-upgrade-already-current");
  assert.equal(repeated.updated, false);
  assert.equal(repeated.snapshotState, "pending");
  assert(!existsSync(resolve(source, "dashboard/public/snapshot.js")), "read-only checks silently repaired the cache");
  assert(coreBytes.equals(read(source, "instance/manifest.toml")));
  assertPreserved();

  execFileSync(process.execPath, [resolve(source, "dashboard/scripts/sync-snapshot.mjs"), source], { windowsHide: true });
  assert.equal(reenter().snapshotState, "current");
  const afterRepair = read(source, "dashboard/public/snapshot.js");
  assert.equal(prepareUpgrade(source, target, { verifyOfficial: false }).updated, false);
  assert(afterRepair.equals(read(source, "dashboard/public/snapshot.js")));
  assertPreserved();

  // Corrupt/mismatched display data stays local too; untrusted core does not.
  write(source, "dashboard/public/snapshot.js", "broken cache\n");
  write(source, "dashboard/dist/snapshot.js", "broken cache\n");
  assert.equal(reenter().snapshotState, "pending");
  write(source, "dashboard/public/snapshot.js", snapshotBytes);
  write(source, "dashboard/dist/snapshot.js", snapshotBytes);
  write(source, "instance/manifest.toml", coreBytes.toString("utf8").replace("ac-upgrade-local-fixture", "another-instance"));
  assert.throws(reenter, /startup|instance|manifest/i, "a changed identity was accepted");
  write(source, "instance/manifest.toml", coreBytes);
  write(target, "maintainer-private/never-publish.md", "synthetic private marker");
  assert.throws(() => prepareUpgrade(source, target, { verifyOfficial: false }), /pure|private|target/i);
  assertPreserved();
  passed = true;
  console.log("upgrade-local-containment-passed: real isolated switch, local content preserved, missing/broken snapshot reported, reentry available, idempotence, identity/private target rejection; no network authority tested");
} finally {
  if (passed) rmSync(scene, { recursive: true, force: true });
  else console.error(`Upgrade containment failure evidence kept at ${scene}`);
}
