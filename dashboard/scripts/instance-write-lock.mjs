import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";

const contexts = new AsyncLocalStorage();
const cleanupReports = new WeakMap();
const pendingReleases = new Map();

export function getInstanceWriteLockCleanup(result) {
  return result && (typeof result === "object" || typeof result === "function") ? cleanupReports.get(result) ?? null : null;
}
const LOCK_REF = ".assistant-local/runtime/instance-write.lock";
const MAX_RECORD_BYTES = 4096;
const decoder = new TextDecoder("utf-8", { fatal: true });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const hostBinding = digest(hostname());
const noncePattern = /^[a-f0-9]{32}$/u;

function lockError(message, code = "AI_CARRY_INSTANCE_WRITE_BUSY") {
  const error = new Error(`Instance write paused: ${message}; other reads and conversation remain available`);
  error.code = code;
  return error;
}

function inside(root, target) {
  const ref = relative(root, target);
  if (isAbsolute(ref) || ref === ".." || ref.startsWith(`..${sep}`)) {
    throw lockError("local transaction state escapes the instance", "AI_CARRY_INSTANCE_WRITE_UNSAFE");
  }
}

function runtimeDirectory(root, { create = true } = {}) {
  let cursor = root;
  for (const part of [".assistant-local", "runtime"]) {
    cursor = resolve(cursor, part);
    if (create) {
      try { mkdirSync(cursor); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const info = lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || info.isReparsePoint?.()) {
      throw lockError("local transaction parent is linked or not a directory", "AI_CARRY_INSTANCE_WRITE_UNSAFE");
    }
    inside(root, realpathSync(cursor));
  }
  return cursor;
}

function readRecord(path, root) {
  const info = lstatSync(path, { bigint: true });
  if ((!info.isFile() && !info.isDirectory()) || info.isSymbolicLink() || info.isReparsePoint?.()) {
    throw lockError("unrecognized lock evidence was preserved", "AI_CARRY_INSTANCE_WRITE_UNSAFE");
  }
  inside(root, realpathSync(path));
  const directory = info.isDirectory();
  if (directory) {
    const entries = opendirSync(path);
    try {
      const owner = entries.readSync();
      if (owner?.name !== "owner.json" || !owner.isFile() || entries.readSync() !== null) {
        throw lockError("unrecognized lock directory was preserved", "AI_CARRY_INSTANCE_WRITE_UNSAFE");
      }
    } finally { entries.closeSync(); }
  }
  // Bounded compatibility with the earlier file record: never replace an
  // active/unknown file owner; a dead owner can be retired just like a directory.
  const recordPath = directory ? resolve(path, "owner.json") : path;
  const recordInfo = lstatSync(recordPath, { bigint: true });
  if (!recordInfo.isFile() || recordInfo.isSymbolicLink() || recordInfo.isReparsePoint?.()
    || recordInfo.size > BigInt(MAX_RECORD_BYTES)) throw lockError("unrecognized owner record was preserved");
  const fd = openSync(recordPath, "r");
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_RECORD_BYTES)) throw lockError("lock evidence changed");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw lockError("lock evidence changed");
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(recordPath, { bigint: true });
    const namedContainer = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()
      || namedContainer.dev !== info.dev || namedContainer.ino !== info.ino || namedContainer.isSymbolicLink()) {
      throw lockError("lock evidence changed");
    }
    let record;
    try { record = JSON.parse(decoder.decode(bytes)); } catch { throw lockError("unrecognized lock evidence was preserved"); }
    const fields = ["schema_version", "record_type", "repository_binding", "pid", "nonce", "operation", "predecessor"];
    const knownFields = [...fields, "host_binding"];
    if (!record || typeof record !== "object" || Array.isArray(record)
      || !fields.every((key) => Object.hasOwn(record, key)) || Object.keys(record).some((key) => !knownFields.includes(key))
      || (Object.hasOwn(record, "host_binding") && !/^[a-f0-9]{64}$/u.test(record.host_binding))
      || record.schema_version !== 1 || !["instance-write-lock", "instance-write-recovery-claim"].includes(record.record_type)
      || !/^[a-f0-9]{64}$/u.test(record.repository_binding) || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || !noncePattern.test(record.nonce) || typeof record.operation !== "string" || record.operation.length > 120
      || !(record.predecessor === "" || noncePattern.test(record.predecessor))) {
      throw lockError("unrecognized lock evidence was preserved", "AI_CARRY_INSTANCE_WRITE_UNSAFE");
    }
    return { path, record, directory, dev: info.dev, ino: info.ino, digest: digest(bytes) };
  } finally { closeSync(fd); }
}

function sameRecord(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.digest === right.digest;
}

function removeOwned(evidence, root) {
  let current;
  try { current = readRecord(evidence.path, root); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!sameRecord(evidence, current)) throw lockError("replacement lock evidence was preserved", "AI_CARRY_INSTANCE_WRITE_UNSAFE");
  const retired = `${evidence.path}.retired-${evidence.record.nonce}`;
  try { lstatSync(retired); throw lockError("existing retired lock evidence was preserved"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Retire the complete record atomically. Death during cleanup can leave only
  // an unrelated retired name, never an empty/ownerless primary lock.
  renameSync(evidence.path, retired);
  if (evidence.directory) { unlinkSync(resolve(retired, "owner.json")); rmdirSync(retired); }
  else unlinkSync(retired);
}

function processIsDead(record) {
  if (record.host_binding !== hostBinding) return false;
  try { process.kill(record.pid, 0); return false; }
  catch (error) {
    // EPERM and unknown platforms/errors cannot establish that the owner died.
    return error.code === "ESRCH";
  }
}

function publishRecord(path, root, operation, predecessor = "") {
  const record = {
    schema_version: 1, record_type: predecessor ? "instance-write-recovery-claim" : "instance-write-lock",
    repository_binding: digest(root), host_binding: hostBinding, pid: process.pid, nonce: randomBytes(16).toString("hex"), operation, predecessor,
  };
  const candidate = `${path}.publish-${process.pid}-${record.nonce}`;
  const ownerPath = resolve(candidate, "owner.json");
  let published = false;
  mkdirSync(candidate, { mode: 0o700 });
  try {
    // A nonempty directory is an atomic, non-replacing publication on both
    // POSIX and Windows. Unlike hardlinks this works on portable FAT/exFAT
    // volumes. Death before rename leaves no ownerless fixed lock name.
    writeFileSync(ownerPath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    const fd = openSync(ownerPath, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    try {
      try { lstatSync(path); const occupied = new Error("lock name is occupied"); occupied.code = "EEXIST"; throw occupied; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      renameSync(candidate, path);
    }
    catch (error) {
      if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR", "EPERM", "EACCES"].includes(error.code)) {
        try { lstatSync(path); error.code = "EEXIST"; } catch { /* Preserve the filesystem error. */ }
      }
      throw error;
    }
    published = true;
    return readRecord(path, root);
  } finally {
    if (!published) {
      try { unlinkSync(ownerPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      try { rmdirSync(candidate); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

function recoverDeadOwner(root, path, owner, operation) {
  // This is local coordination evidence, not user authorization. A moved or
  // copied root may retain another repository_binding: a provably dead owner
  // is still reclaimable; an active/unknown owner is never guessed away.
  // A hostname hash is only a known-foreign-host rejection signal, not proof
  // of machine uniqueness. This lock does not implement distributed locking.
  if (owner.record.host_binding !== hostBinding) {
    throw lockError("the preserved lock may belong to another computer or an unknown host; verify the original holder and remove only proven obsolete local runtime evidence before retrying this write");
  }
  if (owner.record.record_type !== "instance-write-lock" || owner.record.predecessor !== ""
    || !processIsDead(owner.record)) throw lockError("another writer is active or its liveness is unknown; finish the owning process, then retry only this write");
  const claims = [];
  let predecessor = owner.record.nonce;
  try {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const claimPath = `${path}.recover-${predecessor}`;
      let claim;
      try { claim = publishRecord(claimPath, root, operation, predecessor); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        claim = readRecord(claimPath, root);
        if (claim.record.record_type !== "instance-write-recovery-claim" || claim.record.predecessor !== predecessor) {
          throw lockError("unrecognized recovery evidence was preserved");
        }
        if (claim.record.host_binding !== hostBinding) throw lockError("recovery evidence may belong to another computer or an unknown host; preserve it for targeted ownership review");
        if (!processIsDead(claim.record)) throw lockError("another writer is recovering an interrupted transaction");
        claims.push(claim);
        predecessor = claim.record.nonce;
        continue;
      }
      claims.push(claim);
      // An immutable claim chain elects exactly one live reaper for this lock
      // generation. Losers cannot unlink it, and a dead reaper can itself be
      // replaced through the next exclusively-created claim, without ABA.
      const current = readRecord(path, root);
      if (!sameRecord(owner, current)) return;
      runtimeDirectory(root, { create: false });
      removeOwned(owner, root);
      return;
    }
    throw lockError("recovery claim budget exceeded; recovery evidence was preserved");
  } finally {
    // Delete a generation's claims only after its primary lock is gone/changed.
    // Otherwise an older reaper could be elected a second time. In particular,
    // an active competing claimant must never be removed by a losing contender.
    let retired = false;
    try { retired = !sameRecord(owner, readRecord(path, root)); }
    catch (error) { retired = error.code === "ENOENT"; }
    if (retired) for (const claim of [...claims].reverse()) {
      try { removeOwned(claim, root); } catch { /* Preserve ambiguous residue. */ }
    }
  }
}

function acquire(root, operation) {
  runtimeDirectory(root);
  const path = resolve(root, LOCK_REF);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    try { return publishRecord(path, root, operation); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = readRecord(path, root); } catch (readError) {
        if (readError.code === "ENOENT") continue;
        throw readError;
      }
      try { recoverDeadOwner(root, path, owner, operation); }
      catch (recoveryError) { if (recoveryError.code !== "ENOENT") throw recoveryError; }
    }
  }
  throw lockError("writer contention exceeded the local retry budget");
}

function release(root, evidence) {
  runtimeDirectory(root, { create: false });
  removeOwned(evidence, root);
  // rmdir itself checks emptiness; never recursively remove another operation.
  for (const ref of [".assistant-local/runtime", ".assistant-local"]) {
    try { rmdirSync(resolve(root, ref)); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) break; }
  }
}

function retryOwnRelease(root) {
  const evidence = pendingReleases.get(root);
  if (!evidence) return;
  let current;
  try { current = readRecord(evidence.path, root); }
  catch (error) { if (error.code === "ENOENT") { pendingReleases.delete(root); return; } throw error; }
  if (!sameRecord(evidence, current)) { pendingReleases.delete(root); return; }
  try { release(root, evidence); pendingReleases.delete(root); }
  catch { throw lockError("the previous completed write's lock cleanup is still pending; correct its local filesystem access and retry only this write"); }
}

/**
 * Serialize controlled writes on the SAME MACHINE only, not a distributed
 * lock for shared volumes or different computers with identical hostnames.
 * A foreign/unknown hostname binding is never reaped using a local PID probe.
 * Synchronous callbacks stay synchronous; Promise callbacks retain the lock
 * until settled. Only the same async call chain may reenter, not unrelated
 * work in the same process. Subprocess writes must run after leaving the
 * callback (they are new owners). A failed release preserves the business
 * result; the same live process can retry its exact retained lease next time.
 */
export function withInstanceWriteLock(repositoryRoot, operation, callback) {
  const root = realpathSync(resolve(repositoryRoot));
  if (typeof callback !== "function" || typeof operation !== "string" || !operation
    || operation.length > 120 || /[\u0000-\u001f\u007f]/u.test(operation)) throw new TypeError("Invalid instance write lock request");
  const parent = contexts.getStore();
  const inherited = parent?.get(root);
  if (inherited?.active) {
    runtimeDirectory(root, { create: false });
    if (!sameRecord(inherited.evidence, readRecord(inherited.evidence.path, root))) {
      throw lockError("the enclosing writer no longer owns its lock", "AI_CARRY_INSTANCE_WRITE_UNSAFE");
    }
    return callback();
  }
  retryOwnRelease(root);
  const evidence = acquire(root, operation);
  const lease = { evidence, active: true };
  const context = new Map(parent ?? []); context.set(root, lease);
  const finish = () => {
    lease.active = false;
    try { release(root, evidence); pendingReleases.delete(root); return null; }
    catch {
      pendingReleases.set(root, evidence);
      // Coordination cleanup cannot retroactively turn a committed business
      // result into failure. Preserve the evidence, expose a bounded local
      // receipt, and never remove a replacement owner's lock.
      const pending = Object.freeze({ state: "pending", operation,
        reason: "instance-write-lock-cleanup-pending", ordinaryTasksContinue: true,
        nextStep: "The committed result is retained. Correct local filesystem access and retry this write; this process will retry its exact pending lease cleanup. A different process must wait for the owner to exit; a replaced or foreign lock needs targeted ownership review." });
      process.emitWarning("Instance write completed, but its local lock cleanup is pending; preserve the committed result, correct local filesystem access and retry only this write.",
        { code: "AI_CARRY_INSTANCE_WRITE_CLEANUP_PENDING" });
      return pending;
    }
  };
  const completed = (value) => {
    const pending = finish();
    if (pending && value && (typeof value === "object" || typeof value === "function")) cleanupReports.set(value, pending);
    // Plans/receipts are often WeakMap capabilities; cloning would revoke an
    // otherwise valid result. Report separately without changing its identity.
    return value;
  };
  const failed = (error) => { finish(); throw error; };
  let result;
  try { result = contexts.run(context, callback); }
  catch (error) { return failed(error); }
  let thenable;
  try { thenable = result && typeof result.then === "function"; }
  catch (error) { return failed(error); }
  if (thenable) return Promise.resolve(result).then(completed, failed);
  return completed(result);
}
