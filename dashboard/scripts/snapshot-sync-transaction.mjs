import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { getInstanceWriteLockCleanup, withInstanceWriteLock } from "./instance-write-lock.mjs";

const sameBytes = (left, right) => left !== null && right !== null && Buffer.compare(left, right) === 0;

async function readRegularFile(path, label, allowMissing = false) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file and must not be a symbolic link: ${path}`);
    return await readFile(path);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeOwnFile(path) {
  try { await unlink(path); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function isWithin(root, target) {
  const ref = relative(root, target);
  return ref !== "" && !isAbsolute(ref) && ref !== ".." && !ref.startsWith(`..${sep}`);
}

function snapshotRepository(targets, repository) {
  if (repository !== undefined) {
    const root = resolve(repository);
    if (!targets.every((target) => isWithin(root, target))) throw new Error("Snapshot targets must belong to the locked instance.");
    return root;
  }
  let common = dirname(targets[0]);
  while (!targets.every((target) => isWithin(common, target))) {
    const parent = dirname(common);
    if (parent === common) throw new Error("Snapshot targets do not share one instance root.");
    common = parent;
  }
  // The existing CLI supplies the formal dashboard/public + dashboard/dist
  // pair. Lock its instance, not a separate dashboard-only mutex.
  const formalPair = new Set(targets.map((target) => relative(common, target).split(sep).join("/")));
  return basename(common) === "dashboard" && formalPair.has("public/snapshot.js") && formalPair.has("dist/snapshot.js")
    ? dirname(common) : common;
}

export async function synchronizeSnapshotPair(options) {
  if (!Array.isArray(options?.targets) || options.targets.length !== 2 || options.targets.some((target) => typeof target !== "string")) {
    throw new Error("Snapshot transaction requires two distinct targets.");
  }
  const targets = options.targets.map((target) => resolve(target));
  if (new Set(targets).size !== 2) throw new Error("Snapshot transaction requires two distinct targets.");
  const root = snapshotRepository(targets, options.repository);
  await mkdir(root, { recursive: true });
  const result = await withInstanceWriteLock(root, "snapshot-sync", () => synchronizeLockedSnapshotPair({ ...options, targets }));
  const cleanup = getInstanceWriteLockCleanup(result);
  return cleanup ? { ...result, instanceWriteLockCleanup: cleanup } : result;
}

async function synchronizeLockedSnapshotPair({ sourceBytes, targets, validateBytes, operationId = randomUUID(), hooks = {} }) {
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length === 0) throw new Error("Snapshot transaction requires nonempty source bytes.");
  if (!Array.isArray(targets) || targets.length !== 2 || new Set(targets).size !== 2) throw new Error("Snapshot transaction requires two distinct targets.");
  if (typeof validateBytes !== "function") throw new Error("Snapshot transaction requires a non-executing byte validator.");
  validateBytes(sourceBytes, "snapshot source");

  const previous = new Map();
  for (const target of targets) {
    await mkdir(dirname(target), { recursive: true });
    previous.set(target, await readRegularFile(target, "Snapshot target", true));
  }
  if (targets.every((target) => sameBytes(previous.get(target), sourceBytes))) return { updated: false, targets, cleanup_warnings: [] };

  const records = targets.map((target, index) => ({
    target,
    stage: `${target}.ai-carry-stage-${operationId}-${index}`,
    backup: `${target}.ai-carry-backup-${operationId}-${index}`,
    hadOriginal: previous.get(target) !== null,
    originalMoved: false,
    staged: false,
    installed: false,
  }));

  try {
    for (const [index, record] of records.entries()) {
      await writeFile(record.stage, sourceBytes, { flag: "wx" });
      record.staged = true;
      const stagedBytes = await readRegularFile(record.stage, "Staged snapshot");
      if (!sameBytes(stagedBytes, sourceBytes)) throw new Error(`Staged snapshot differs from source: ${record.stage}`);
      validateBytes(stagedBytes, `staged snapshot ${record.stage}`);
      await hooks.afterStage?.({ index, record });
    }

    for (const [index, record] of records.entries()) {
      const current = await readRegularFile(record.target, "Snapshot target before commit", true);
      const expected = previous.get(record.target);
      if ((current === null) !== (expected === null) || (expected !== null && !sameBytes(current, expected))) {
        throw new Error(`Snapshot target changed before commit: ${record.target}`);
      }
      if (record.hadOriginal) {
        await rename(record.target, record.backup);
        record.originalMoved = true;
      }
      await rename(record.stage, record.target);
      record.installed = true;
      await hooks.afterInstall?.({ index, record });
    }

    const installedBytes = [];
    for (const record of records) {
      const bytes = await readRegularFile(record.target, "Installed snapshot");
      validateBytes(bytes, `installed snapshot ${record.target}`);
      if (!sameBytes(bytes, sourceBytes)) throw new Error(`Installed snapshot differs from source: ${record.target}`);
      installedBytes.push(bytes);
    }
    if (!sameBytes(installedBytes[0], installedBytes[1])) throw new Error("The public and dist snapshots are not byte-identical after installation.");

    // The pair is committed after both readbacks. Cleanup failures are warnings;
    // they must not roll back a valid pair after any backup has been destroyed.
    const cleanupWarnings = [];
    for (const [index, record] of records.entries()) {
      try {
        await hooks.beforeBackupCleanup?.({ index, record });
        await removeOwnFile(record.backup);
      } catch (error) {
        cleanupWarnings.push(`${record.backup}: ${error.message}`);
      }
    }
    return { updated: true, targets, cleanup_warnings: cleanupWarnings };
  } catch (error) {
    const rollbackErrors = [];
    for (const record of [...records].reverse()) {
      try {
        if (record.installed) {
          const live = await readRegularFile(record.target, "Snapshot target before rollback", true);
          if (!sameBytes(live, sourceBytes)) throw new Error("live target changed; preserved it and the transaction backup");
          await removeOwnFile(record.target);
        }
        if (record.originalMoved) {
          if (await readRegularFile(record.target, "Snapshot rollback destination", true) !== null) throw new Error("rollback destination is occupied; preserved its contents");
          const backup = await readRegularFile(record.backup, "Snapshot rollback backup");
          if (!sameBytes(backup, previous.get(record.target))) throw new Error("rollback backup changed; preserved recovery evidence");
          await rename(record.backup, record.target);
        }
        if (record.staged) await removeOwnFile(record.stage);
      } catch (rollbackError) {
        rollbackErrors.push(`${record.target}: ${rollbackError.message}`);
      }
    }
    for (const record of records) {
      try {
        const restored = await readRegularFile(record.target, "Restored snapshot target", true);
        const expected = previous.get(record.target);
        if ((expected === null) !== (restored === null) || (expected !== null && !sameBytes(expected, restored))) rollbackErrors.push(`${record.target}: restored bytes do not match the frozen pre-action state`);
      } catch (rollbackError) {
        rollbackErrors.push(`${record.target}: ${rollbackError.message}`);
      }
    }
    const rollbackMessage = rollbackErrors.length > 0
      ? ` Rollback verification also failed: ${rollbackErrors.join("; ")}`
      : " Both live targets were restored to their exact pre-action state.";
    throw new Error(`Snapshot synchronization failed: ${error.message}.${rollbackMessage}`, { cause: error });
  }
}
