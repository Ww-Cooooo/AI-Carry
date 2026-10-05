import { existsSync, renameSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStartupCapsule, inspectStartupCapsule, MAX_CAPSULE_BYTES, readStartupFile, resolveStartupFile } from "./startup-capsule-contract.mjs";

export function syncStartupCapsule(repository, { write = false, testFaultAfterInstall = false } = {}) {
  const root = realpathSync(repository); const capsuleRef = "instance/startup-capsule.toml";
  const checked = (ref) => resolveStartupFile(root, ref, { allowMissing: true });
  const target = checked(capsuleRef);
  const expected = buildStartupCapsule(root);
  const current = readStartupFile(root, capsuleRef, MAX_CAPSULE_BYTES, { allowMissing: true })?.toString("utf8") ?? "";
  if (current === expected.source && inspectStartupCapsule(root).decision === "startup-capsule-valid") {
    return Object.freeze({ decision: "startup-capsule-current", updated: false, sourceManifestDigest: expected.sourceManifestDigest, executable: false });
  }
  if (!write) return Object.freeze({ decision: "startup-capsule-update-required", updated: false, sourceManifestDigest: expected.sourceManifestDigest, executable: false });
  const suffix = randomBytes(8).toString("hex");
  const stageRef = `${capsuleRef}.stage-${suffix}`; const backupRef = `${capsuleRef}.backup-${suffix}`;
  const stage = checked(stageRef); const backup = checked(backupRef);
  let oldMoved = false;
  let newInstalled = false;
  try {
    writeFileSync(checked(stageRef), expected.source, { encoding: "utf8", flag: "wx" });
    if (readStartupFile(root, stageRef, MAX_CAPSULE_BYTES).toString("utf8") !== expected.source) throw new Error("staged capsule did not round-trip");
    if (existsSync(checked(capsuleRef))) { renameSync(target, checked(backupRef)); oldMoved = true; }
    renameSync(checked(stageRef), checked(capsuleRef)); newInstalled = true;
    if (testFaultAfterInstall) throw new Error("injected post-install readback failure");
    if (inspectStartupCapsule(root).decision !== "startup-capsule-valid") throw new Error("installed capsule failed readback");
    if (oldMoved && existsSync(checked(backupRef))) unlinkSync(backup);
    return Object.freeze({ decision: "startup-capsule-updated", updated: true, sourceManifestDigest: expected.sourceManifestDigest, executable: false });
  } catch (error) {
    // If an ancestor changed to a link, do not let cleanup follow it either.
    checked(stageRef); checked(capsuleRef); checked(backupRef);
    if (existsSync(stage)) unlinkSync(stage);
    if (newInstalled && existsSync(target)) unlinkSync(target);
    if (oldMoved) {
      if (existsSync(backup)) renameSync(backup, target);
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const root = resolve(process.argv[2] ?? defaultRoot);
  const write = process.argv.includes("--write") && process.argv.includes("--acknowledge-manifest-change");
  process.stdout.write(`${JSON.stringify(syncStartupCapsule(root, { write }))}\n`);
}
