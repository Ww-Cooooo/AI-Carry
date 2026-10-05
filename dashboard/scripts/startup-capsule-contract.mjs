import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseSectionedToml, validateInstanceManifestStructure } from "./asset-route-contract.mjs";
import { PRODUCT_IDENTITY } from "./product-identity.mjs";

export const MAX_MANIFEST_BYTES = 2560;
export const MAX_CAPSULE_BYTES = 4096;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const capsuleFields = new Set([
  "schema_version", "capsule_id", "source_manifest_digest", "product_version", "instance_id", "state",
  "direction_type", "direction_locked", "domain_id", "guidance_mode", "learning_policy", "language",
  "profile_ref", "domain_map_ref", "signal_control_ref", "signal_map_ref", "root_map_ref", "migration_required",
]);

function fail(message) { throw new Error(`Startup capsule contract failed: ${message}`); }
function hash(buffer) { return `sha256:${createHash("sha256").update(buffer).digest("hex")}`; }
// Validate every existing component, not just the final file. In particular a
// missing capsule may be created only beneath a physical instance directory.
export function resolveStartupFile(repository, ref, { allowMissing = false } = {}) {
  if (typeof ref !== "string" || ref.includes("\\") || ref.includes(":") || isAbsolute(ref)
    || ref.split("/").some((part) => !part || part === "." || part === "..")) fail("startup file reference is not portable");
  const root = realpathSync(repository); const parts = ref.split("/"); let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    let info;
    try { info = lstatSync(cursor); }
    catch (error) {
      if (allowMissing && index === parts.length - 1 && error?.code === "ENOENT") return cursor;
      throw error;
    }
    if (info.isSymbolicLink() || info.isReparsePoint?.()) fail("startup file crosses a link or reparse point");
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) fail("startup file has a non-physical path component");
    const fromRoot = relative(root, realpathSync(cursor));
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) fail("startup file escapes the repository");
  }
  return cursor;
}

export function readStartupFile(repository, ref, maxBytes, { allowMissing = false } = {}) {
  const root = realpathSync(repository);
  const path = resolveStartupFile(root, ref, { allowMissing });
  let descriptor; let realBefore;
  try { realBefore = realpathSync(path); descriptor = openSync(path, "r"); }
  catch (error) { if (allowMissing && error?.code === "ENOENT") return null; throw error; }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) fail(`${ref} is not a bounded regular file`);
    const buffer = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < buffer.length) { const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset); if (count === 0) break; offset += count; }
    const after = fstatSync(descriptor, { bigint: true });
    resolveStartupFile(root, ref);
    const info = lstatSync(path, { bigint: true });
    if (offset !== buffer.length || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.dev !== info.dev || before.ino !== info.ino
      || before.size !== info.size || before.mtimeNs !== info.mtimeNs || before.ctimeNs !== info.ctimeNs
      || realpathSync(path) !== realBefore) fail(`${ref} changed during its bounded read`);
    return buffer;
  } finally { closeSync(descriptor); }
}
function q(value) { return JSON.stringify(value); }
function serialize(values) {
  const order = [...capsuleFields];
  return `${order.map((field) => `${field} = ${typeof values[field] === "string" ? q(values[field]) : values[field]}`).join("\n")}\n`;
}

export function buildStartupCapsule(repository) {
  const root = realpathSync(repository);
  const manifestBuffer = readStartupFile(root, "instance/manifest.toml", MAX_MANIFEST_BYTES);
  let manifestSource;
  try { manifestSource = utf8.decode(manifestBuffer); } catch { fail("instance manifest is not UTF-8"); }
  if (manifestSource.startsWith("\uFEFF") || manifestSource.includes("\r")) fail("instance manifest must be UTF-8 without BOM and use LF line endings");
  const manifest = parseSectionedToml(manifestSource, "instance manifest");
  const validated = validateInstanceManifestStructure(manifest);
  const coreBuffer = readStartupFile(root, "core/manifest.toml", 32 * 1024);
  let coreSource;
  try { coreSource = utf8.decode(coreBuffer); } catch { fail("core manifest is not UTF-8"); }
  const core = parseSectionedToml(coreSource, "core manifest");
  const coreRoot = core[""] ?? {}; const entry = core.entry ?? {};
  if (coreRoot.core_id !== PRODUCT_IDENTITY.coreId
    || typeof coreRoot.version !== "string" || coreRoot.version.length === 0
    || entry.root_map !== "core/maps/root-map.toml") fail("core startup identity is invalid");
  if (validated.versions.product !== coreRoot.version) fail("instance and core product versions disagree");
  const values = Object.freeze({
    schema_version: 1,
    capsule_id: PRODUCT_IDENTITY.startupCapsuleId,
    source_manifest_digest: hash(manifestBuffer),
    product_version: coreRoot.version,
    instance_id: validated.root.instance_id,
    state: validated.root.state,
    direction_type: validated.direction.type,
    direction_locked: validated.direction.locked,
    domain_id: validated.direction.domain_id,
    guidance_mode: validated.profile.guidance_mode,
    learning_policy: validated.root.state === "template" ? "unselected" : validated.learningPolicy,
    language: validated.profile.language ?? "zh-CN",
    profile_ref: validated.profile.user_preferences_ref,
    domain_map_ref: validated.profile.domain_map_ref,
    signal_control_ref: validated.profile.signal_control_ref,
    signal_map_ref: validated.profile.signal_map_ref,
    root_map_ref: entry.root_map,
    migration_required: validated.schemaMigrationRequired,
  });
  const source = serialize(values);
  if (Buffer.byteLength(source, "utf8") > MAX_CAPSULE_BYTES) fail("generated capsule exceeds its hard budget");
  return Object.freeze({ values, source, sourceManifestDigest: values.source_manifest_digest });
}

export function inspectStartupCapsule(repository) {
  let expected;
  try {
    expected = buildStartupCapsule(repository);
  } catch {
    return Object.freeze({ decision: "startup-repair-required", reason: "manifest-or-core-contract-invalid",
      repairable: false, executable: false });
  }
  try {
    const root = realpathSync(repository);
    const target = resolveStartupFile(root, "instance/startup-capsule.toml", { allowMissing: true });
    let info;
    try { info = lstatSync(target); }
    catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ decision: "startup-repair-required", reason: "capsule-missing",
        repairable: true, executable: false });
      return Object.freeze({ decision: "startup-repair-required", reason: "capsule-path-unavailable",
        repairable: false, executable: false });
    }
    if (!info.isFile() || info.isSymbolicLink()) return Object.freeze({ decision: "startup-repair-required",
      reason: "capsule-path-unsafe", repairable: false, executable: false });
    const actualBuffer = readStartupFile(root, "instance/startup-capsule.toml", MAX_CAPSULE_BYTES);
    let actualSource;
    try { actualSource = utf8.decode(actualBuffer); } catch { return Object.freeze({ decision: "startup-repair-required", reason: "capsule-not-utf8", repairable: true, executable: false }); }
    if (actualSource.startsWith("\uFEFF") || actualSource.includes("\r")) {
      return Object.freeze({ decision: "startup-repair-required", reason: "capsule-stale-or-invalid", repairable: true, executable: false });
    }
    const parsed = parseSectionedToml(actualSource, "startup capsule");
    const values = parsed[""] ?? {};
    if (Object.keys(parsed).some((section) => section !== "") || Object.keys(values).length !== capsuleFields.size
      || Object.keys(values).some((field) => !capsuleFields.has(field)) || actualSource !== expected.source) {
      return Object.freeze({ decision: "startup-repair-required", reason: "capsule-stale-or-invalid", repairable: true, executable: false });
    }
    return Object.freeze({ decision: "startup-capsule-valid", executable: false, ...expected.values });
  } catch {
    return Object.freeze({ decision: "startup-repair-required", reason: "capsule-read-unstable-or-unbounded",
      repairable: false, executable: false });
  }
}
