import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArrayTableDocument, parseMarkdownFrontmatterHead, parseSectionedToml, projectFormalAssetsForSnapshot, projectFormalAssetsForOperationalSnapshot, loadTrustedDomainEnvelope, stableAssetId, validateInstanceManifestStructure } from "./asset-route-contract.mjs";
import { projectCandidatesForSnapshot, projectCandidatesForOperationalSnapshot } from "./candidate-index-contract.mjs";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";
import { containsForbiddenLocationReference, containsForbiddenStructuredLocation } from "./safe-output-boundary.mjs";
import { parseCurrentSnapshotEnvelope, serializeSnapshotEnvelope } from "./snapshot-envelope.mjs";
import { validateSnapshotSemantics } from "./snapshot-semantics.mjs";
import { inspectStartupCapsule } from "./startup-capsule-contract.mjs";
import { measureModelVisibleStartupContext } from "./query-startup-capsule.mjs";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const structuredPrivateRefSource = /^instance\/(?:memory|capabilities|sops|experiences|evolution|todo|deferred)\/.+\.md$/u;
const structuredComponentManifestSource = /^instance\/components\/[a-z0-9][a-z0-9._-]{0,159}\/component\.toml$/u;
const supportFields = {
  todo: new Set(["id", "kind", "status", "visible", "title", "summary", "triggers", "scope", "excludes", "source_refs", "private_refs", "minimum_level", "approved_by_user", "updated_at"]),
  governance: new Set(["id", "kind", "status", "title", "summary", "triggers", "frequency_days", "background", "minimum_level", "approved_by_user", "schedule_state", "schedule_anchor_at", "last_completed_at", "next_due_at", "snoozed_until", "trigger_revision"]),
  "deferred-work": new Set(["id", "kind", "status", "title", "summary", "required_level", "deferral_reason", "recovery_route", "source_refs", "private_refs", "created_at", "remind_at", "snoozed_until", "trigger_revision", "approved_by_user"]),
};
const snapshotModes = new Set(["strict", "operational"]);
const isolatableSourceAreas = Object.freeze([
  ["instance/memory/", "memory"],
  ["instance/capabilities/", "capabilities"],
  ["instance/sops/", "sops"],
  ["instance/experiences/", "experiences"],
  ["instance/todo/", "todo"],
  ["instance/governance/", "governance"],
  ["instance/deferred/", "deferred"],
  ["instance/skills/", "skills"],
  ["instance/components/", "components"],
  ["instance/signals/", "signals"],
  ["instance/evolution/", "evolution"],
  ["instance/startup-capsule.toml", "startup"],
]);
const signalProjectionRefs = new Set([
  "instance/maps/signal-map.toml",
  "instance/maps/time-trigger-map.toml",
]);

function fail(message) { throw new Error(`Snapshot source builder failed: ${message}`); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function clean(value, max, allowEmpty = false) {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0) && [...value].length <= max
    && value.normalize("NFC") === value && !unsafeText.test(value);
}
function compareOrdinal(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function decode(buffer, label) { try { return utf8Decoder.decode(buffer); } catch { fail(`${label} is not UTF-8`); } }

function normalizeRequiredSourceRefs(refs) {
  if (!Array.isArray(refs) || refs.length > 64) fail("required source refs are not a bounded array");
  const normalized = new Set();
  for (const ref of refs) {
    if (!clean(ref, 240) || ref.includes("\\") || ref.includes(":") || ref.startsWith("/") || ref.split("/").some((part) => !part || part === "." || part === "..")) {
      fail("required source ref is not a portable repository-relative path");
    }
    normalized.add(ref.normalize("NFC"));
  }
  return normalized;
}

function isolatableArea(ref) {
  if (signalProjectionRefs.has(ref)) return "signals";
  if (ref.startsWith("instance/maps/")) return null;
  return isolatableSourceAreas.find(([prefix]) => ref.startsWith(prefix))?.[1] ?? null;
}

function recordOperationalIssue(issues, { area, code, sourceRef }) {
  const key = `${area}\u0000${sourceRef}`;
  if (issues.some((item) => item.key === key)) return;
  issues.push(Object.freeze({ key, area, code, sourceRef }));
}

function isolateOrFail(mode, requiredSourceRefs, issues, ref, code, message) {
  const area = isolatableArea(ref);
  if (mode !== "operational" || !area || requiredSourceRefs.has(ref)) fail(message);
  recordOperationalIssue(issues, { area, code, sourceRef: ref });
}

function portablePrivatePathSegment(part) {
  const base = part.replace(/\..*$/u, "").toLowerCase();
  return part && part !== "." && part !== ".." && part.normalize("NFC") === part && !unsafeText.test(part)
    && !/[. ]$/u.test(part) && !/[<>"|*]/u.test(part)
    && !["con", "prn", "aux", "nul", "clock$"].includes(base) && !/^(?:com|lpt)[1-9]$/u.test(base);
}

function validStructuredPrivateReference(ref) {
  if (!clean(ref, 240)) return false;
  let relativeRef;
  if (ref.startsWith("private://")) {
    const match = /^private:\/\/([a-z0-9][a-z0-9._:-]{0,159})\/(.+)$/u.exec(ref);
    if (!match) return false;
    relativeRef = match[2];
  } else if (ref.startsWith(".assistant-private/assets/")) {
    relativeRef = ref.slice(".assistant-private/assets/".length);
  } else return false;
  return relativeRef.length > 0 && !relativeRef.includes("\\") && !relativeRef.includes(":")
    && !relativeRef.includes("?") && !relativeRef.includes("#") && relativeRef.split("/").every(portablePrivatePathSegment);
}

function containsForbiddenSnapshotSourceLocation(ref, text) {
  const normalized = text.replaceAll("\r\n", "\n");
  if (structuredPrivateRefSource.test(ref)) {
    let parsed;
    try { parsed = parseMarkdownFrontmatterHead(normalized, ref); } catch { return true; }
    const privateRefs = parsed.values.private_refs ?? [];
    if (!Array.isArray(privateRefs) || privateRefs.length > 32 || privateRefs.some((item) => !validStructuredPrivateReference(item))) return true;
    return containsForbiddenStructuredLocation(parsed.values)
      || containsForbiddenLocationReference(normalized.slice(parsed.bodyOffset));
  }
  if (structuredComponentManifestSource.test(ref)) {
    let parsed;
    try { parsed = parseSectionedToml(normalized, ref); } catch { return true; }
    const privateRefs = parsed.ownership?.private_collection_refs ?? [];
    if (!Array.isArray(privateRefs) || privateRefs.length > 32 || privateRefs.some((item) => !validStructuredPrivateReference(item))) return true;
    const structured = { ...parsed, ownership: { ...(parsed.ownership ?? {}) } };
    delete structured.ownership.private_collection_refs;
    return containsForbiddenStructuredLocation(structured);
  }
  return containsForbiddenLocationReference(text);
}

function stableRead(path, maxBytes, label) {
  const realBefore = realpathSync(path);
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) fail(`${label} is not a regular file or exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < buffer.length) { const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset); if (count === 0) break; offset += count; }
    const after = fstatSync(descriptor, { bigint: true });
    const pathInfo = lstatSync(path);
    if (offset !== buffer.length || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || !pathInfo.isFile() || pathInfo.isSymbolicLink()
      || realpathSync(path) !== realBefore) fail(`${label} changed during its bounded read`);
    return buffer;
  } finally { closeSync(descriptor); }
}

function enumerateInstanceSources(repository) {
  const root = realpathSync(repository);
  const files = [{ ref: "assistant.toml", path: resolve(root, "assistant.toml") }];
  const instanceRoot = resolve(root, "instance");
  if (!lstatSync(instanceRoot).isDirectory() || lstatSync(instanceRoot).isSymbolicLink()) fail("instance root is not a physical directory");
  const queue = [instanceRoot]; let visited = 0;
  while (queue.length) {
    const directory = queue.shift();
    if (++visited > 4096) fail("instance directory count exceeds the maintenance bound");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name); const info = lstatSync(path);
      if (info.isSymbolicLink()) fail("instance source tree contains a link or reparse point");
      if (entry.isDirectory()) { queue.push(path); continue; }
      if (!entry.isFile() || basename(path) === "README.md") continue;
      const ref = relative(root, realpathSync(path)).split(sep).join("/").normalize("NFC");
      if (!ref.startsWith("instance/") || ref.includes("\\") || ref.includes(":")) fail("instance source escaped the repository or is not portable");
      files.push({ ref, path });
      if (files.length > 8192) fail("instance source file count exceeds 8192");
    }
  }
  return files.sort((left, right) => compareOrdinal(left.ref, right.ref));
}

function isOpaqueSkillPayload(ref) {
  return ref.startsWith("instance/skills/exports/") || ref.startsWith("instance/skills/shares/");
}

function computeSnapshotSourceDigestWithMode(repository, { mode = "strict", requiredSourceRefs = new Set(), issues = [] } = {}) {
  if (!snapshotModes.has(mode)) fail("snapshot mode is invalid");
  const files = enumerateInstanceSources(repository); const lines = []; let totalBytes = 0;
  for (const file of files) {
    const bytes = stableRead(file.path, 128 * 1024 * 1024, `source ${file.ref}`);
    totalBytes += bytes.length;
    if (totalBytes > 512 * 1024 * 1024) fail("instance source bytes exceed the 512 MiB snapshot-maintenance bound");
    lines.push(`${file.ref}\t${hash(bytes)}\n`);
    // Editable Skill payloads and their delivery carriers may legitimately
    // contain images or archives. They affect the byte digest, while their
    // content is inspected only through the bounded Skill-package route and is
    // never projected into the dashboard. A binary carrier must not stop the
    // whole snapshot or unrelated assistant capabilities.
    if (isOpaqueSkillPayload(file.ref)) continue;
    let text;
    try { text = utf8Decoder.decode(bytes); }
    catch {
      isolateOrFail(mode, requiredSourceRefs, issues, file.ref, "source-not-utf8", `source ${file.ref} is not UTF-8`);
      continue;
    }
    if (locateHighConfidenceSecretCandidates(text).blocked || containsForbiddenSnapshotSourceLocation(file.ref, text)) {
      isolateOrFail(mode, requiredSourceRefs, issues, file.ref, "source-unsafe-or-nonportable",
        `source ${file.ref} contains a secret candidate or non-portable absolute location`);
    }
  }
  return Object.freeze({ digest: `sha256:${hash(Buffer.from(lines.join(""), "utf8"))}`, fileCount: files.length, totalBytes });
}

export function computeSnapshotSourceDigest(repository, { mode = "strict", requiredSourceRefs = [] } = {}) {
  if (!snapshotModes.has(mode)) fail("snapshot mode is invalid");
  const issues = [];
  const result = computeSnapshotSourceDigestWithMode(repository, {
    mode,
    requiredSourceRefs: normalizeRequiredSourceRefs(requiredSourceRefs),
    issues,
  });
  return Object.freeze({ ...result, diagnostics: publicDiagnostics(issues), mode });
}

function readStructured(repository, ref, maxBytes = 128 * 1024) {
  const root = realpathSync(repository); const path = resolve(root, ...ref.split("/"));
  const fromRoot = relative(root, realpathSync(path));
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) fail(`${ref} escapes the repository`);
  let cursor = root;
  for (const part of ref.split("/")) { cursor = resolve(cursor, part); const info = lstatSync(cursor); if (info.isSymbolicLink()) fail(`${ref} crosses a link`); }
  return decode(stableRead(path, maxBytes, ref), ref).replaceAll("\r\n", "\n");
}

function projectSupportDirectory(repository, directory, expectedKind, { mode = "strict", requiredSourceRefs = new Set(), issues = [] } = {}) {
  const root = resolve(realpathSync(repository), "instance", directory);
  const results = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "README.md" || !entry.name.endsWith(".md")) continue;
    const ref = `instance/${directory}/${entry.name}`;
    const source = readStructured(repository, ref);
    try {
      const parsed = parseMarkdownFrontmatterHead(source, `${directory}/${entry.name}`);
      const asset = parsed.values; const body = source.slice(parsed.bodyOffset);
      const allowed = supportFields[expectedKind];
      if (!allowed || Object.keys(asset).some((field) => !allowed.has(field)) || asset.kind !== expectedKind
        || !stableAssetId.test(asset.id ?? "") || !clean(asset.title, 160) || !clean(asset.summary, 1000)
        || locateHighConfidenceSecretCandidates(JSON.stringify(asset)).blocked || containsForbiddenStructuredLocation(asset)
        || locateHighConfidenceSecretCandidates(body).blocked || containsForbiddenLocationReference(body)) fail(`support asset ${asset.id ?? entry.name} is unsafe or invalid`);
      if (expectedKind === "todo") {
        if (asset.visible === false) continue;
        results.push({ id: asset.id, title: asset.title, summary: asset.summary, status: asset.status, visible: asset.visible !== false });
      } else if (expectedKind === "deferred-work") {
        if (![1, 2, 3].includes(asset.required_level)) fail(`deferred asset ${asset.id} has an invalid required level`);
        results.push({ summary: asset.summary, level: asset.required_level, remind: asset.remind_at ?? "", status: asset.status });
      } else {
        if (asset.approved_by_user !== true || (asset.schedule_state ?? "uninitialized") === "uninitialized") continue;
        if (!Number.isSafeInteger(asset.frequency_days) || asset.frequency_days < 1 || asset.frequency_days > 3650) fail(`governance asset ${asset.id} has an invalid frequency`);
        const steps = [...body.matchAll(/^\s*\d+\.\s+(.+)$/gmu)].map((match) => match[1].trim()).slice(0, 20);
        if (steps.length === 0) fail(`governance asset ${asset.id} has no bounded numbered steps`);
        results.push({ id: asset.id, title: asset.title, summary: asset.summary, frequency: `每 ${asset.frequency_days} 天`, status: asset.schedule_state ?? asset.status,
          purpose: asset.summary, steps, last_completed_at: asset.last_completed_at ?? "", next_due_at: asset.next_due_at ?? "", schedule_state: asset.schedule_state ?? "uninitialized" });
      }
    } catch (error) {
      isolateOrFail(mode, requiredSourceRefs, issues, ref, "support-item-invalid", error.message);
    }
  }
  return results.sort((left, right) => compareOrdinal(left.id ?? left.summary, right.id ?? right.summary));
}

function titleFromSkillId(id) {
  return id.split(/[.:_-]+/u).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ") || "未命名 Skill";
}

const skillDeliveryDigest = /^sha256:[0-9a-f]{64}$/u;
const skillDeliveryMethods = new Set(["zip", "folder", "link", "local-only"]);
const skillDeliveryStates = new Set(["unselected", "local-only", "artifact-ready", "target-needed", "link-ready"]);
const skillDeliveryFields = ["delivery_method", "delivery_state", "delivery_ref", "delivery_source_digest", "delivery_digest", "delivery_generated_at", "delivery_link"];

function validZonedDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && /[zZ]|[+-]\d{2}:\d{2}$/u.test(value);
}

function resolvePhysicalRef(repository, ref) {
  if (!clean(ref, 480) || ref.startsWith("/") || ref.includes("\\") || ref.includes(":")
    || ref.split("/").some((part) => !portablePrivatePathSegment(part))) throw new Error("delivery reference is not portable");
  let cursor = realpathSync(repository);
  for (const part of ref.split("/")) {
    cursor = resolve(cursor, part);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error("delivery reference crosses a link");
  }
  return cursor;
}

function skillDirectoryDigest(repository, ref) {
  const root = resolvePhysicalRef(repository, ref);
  if (!lstatSync(root).isDirectory()) throw new Error("Skill delivery directory is not physical");
  const files = [];
  let totalBytes = 0;
  const walk = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length > 128) throw new Error("Skill delivery directory exceeds its entry bound");
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const itemRef = relative(root, path).split(sep).join("/");
      if (!clean(itemRef, 480) || itemRef.split("/").some((part) => !portablePrivatePathSegment(part))) throw new Error("Skill delivery contains a non-portable path");
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("Skill delivery contains a link");
      if (info.isDirectory()) { walk(path); continue; }
      if (!info.isFile() || info.size > 512 * 1024) throw new Error("Skill delivery contains an unsupported file");
      totalBytes += info.size;
      if (totalBytes > 2 * 1024 * 1024) throw new Error("Skill delivery exceeds its byte bound");
      const bytes = stableRead(path, 512 * 1024, itemRef);
      files.push({ ref: itemRef, digest: hash(bytes) });
      if (files.length > 128) throw new Error("Skill delivery exceeds its file bound");
    }
  };
  walk(root);
  files.sort((left, right) => compareOrdinal(left.ref, right.ref));
  return `sha256:${hash(Buffer.from(files.map((file) => `${file.digest}  ${file.ref}\n`).join(""), "utf8"))}`;
}

function safeDeliveryLink(value) {
  if (!clean(value, 2048)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
}

function projectSkillDelivery(repository, item) {
  const hasDelivery = skillDeliveryFields.some((field) => Object.hasOwn(item, field));
  if (!hasDelivery) return { delivery_method: "", delivery_state: "unselected" };
  const method = item.delivery_method ?? "";
  const state = item.delivery_state ?? "";
  const prefix = `instance/skills/shares/${item.id}/`;
  if ((!method && state !== "unselected") || !skillDeliveryStates.has(state) || (method && !skillDeliveryMethods.has(method))) {
    return { delivery_method: "", delivery_state: "review" };
  }
  if (state === "unselected") {
    return method || skillDeliveryFields.slice(2).some((field) => Object.hasOwn(item, field))
      ? { delivery_method: method, delivery_state: "review" }
      : { delivery_method: "", delivery_state: "unselected" };
  }
  if (state === "local-only") {
    return method === "local-only" && !skillDeliveryFields.slice(2).some((field) => Object.hasOwn(item, field))
      ? { delivery_method: method, delivery_state: state }
      : { delivery_method: method, delivery_state: "review" };
  }
  const combinationValid = (state === "artifact-ready" && ["zip", "folder"].includes(method))
    || (["target-needed", "link-ready"].includes(state) && method === "link");
  if (!combinationValid || !clean(item.delivery_ref, 480) || !item.delivery_ref.startsWith(prefix)
    || !skillDeliveryDigest.test(item.delivery_source_digest ?? "") || !skillDeliveryDigest.test(item.delivery_digest ?? "")
    || !validZonedDate(item.delivery_generated_at)
    || (state === "link-ready" ? !safeDeliveryLink(item.delivery_link) : Object.hasOwn(item, "delivery_link"))) {
    return { delivery_method: method, delivery_state: "review" };
  }
  try {
    const currentSourceDigest = skillDirectoryDigest(repository, `instance/skills/exports/${item.id}`);
    if (currentSourceDigest !== item.delivery_source_digest) return { delivery_method: method, delivery_state: "stale" };
    const artifactPath = resolvePhysicalRef(repository, item.delivery_ref);
    let artifactDigest;
    if (method === "folder") {
      if (!lstatSync(artifactPath).isDirectory()) return { delivery_method: method, delivery_state: "stale" };
      artifactDigest = skillDirectoryDigest(repository, item.delivery_ref);
    } else {
      const info = lstatSync(artifactPath);
      if (!info.isFile() || info.size > 4 * 1024 * 1024) return { delivery_method: method, delivery_state: "stale" };
      artifactDigest = `sha256:${hash(stableRead(artifactPath, 4 * 1024 * 1024, item.delivery_ref))}`;
    }
    return { delivery_method: method, delivery_state: artifactDigest === item.delivery_digest ? state : "stale" };
  } catch {
    return { delivery_method: method, delivery_state: "stale" };
  }
}

function projectSkillExports(repository, instanceId, { mode = "strict", requiredSourceRefs = new Set(), issues = [] } = {}) {
  const ref = "instance/skills/exports/index.toml";
  if (!existsSync(resolve(repository, ...ref.split("/")))) return [];
  try {
    const source = readStructured(repository, ref, 128 * 1024);
    if (locateHighConfidenceSecretCandidates(source).blocked || containsForbiddenLocationReference(source)) fail("skill export index contains unsafe content");
    const parsed = parseArrayTableDocument(source, "exports", "skill export index");
    if (parsed.root.schema_version !== 1 || parsed.root.index_id !== "skill-exports" || parsed.root.instance_id !== instanceId
      || parsed.entries.length > 128) fail("skill export index identity or size is invalid");
    // Counts are derived below. Informational dates are not projected, so an
    // absent date does not hide an otherwise usable export or invent a date.
    const counts = new Map();
    for (const item of parsed.entries) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    const items = [];
    for (const item of parsed.entries) {
      if (!stableAssetId.test(item.id ?? "") || counts.get(item.id) !== 1 || !clean(item.title, 160) || !clean(item.summary, 500)
        || !stableAssetId.test(item.source_asset_id ?? "") || !["sop", "capability"].includes(item.source_kind)
        || !["draft", "ready", "review"].includes(item.state)
        || item.entry !== `instance/skills/exports/${item.id}/SKILL.md`) {
        isolateOrFail(mode, requiredSourceRefs, issues, ref, "skill-export-entry-invalid", "skill export entry is invalid");
        continue;
      }
      items.push({ id: item.id, title: item.title, summary: item.summary, state: item.state, ...projectSkillDelivery(repository, item) });
    }
    return items.sort((left, right) => compareOrdinal(left.id, right.id));
  } catch (error) {
    isolateOrFail(mode, requiredSourceRefs, issues, ref, "skill-export-index-invalid", error.message);
    return [];
  }
}

function projectSkills(repository, instanceId, { mode = "strict", requiredSourceRefs = new Set(), issues = [] } = {}) {
  const ref = "instance/skills/requirements.toml";
  let items = [];
  let status = "尚未登记 Skill";
  try {
    const source = readStructured(repository, ref, 32 * 1024);
    if (locateHighConfidenceSecretCandidates(source).blocked || containsForbiddenLocationReference(source)) fail("skill requirements contain unsafe content");
    const parsed = parseArrayTableDocument(source, "skills", "skill requirements");
    if (parsed.root.schema_version !== 1 || parsed.root.instance_id !== instanceId || parsed.entries.length > 256) fail("skill requirements identity or count is invalid");
    const counts = new Map();
    for (const item of parsed.entries) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    for (const item of parsed.entries) {
      if (!stableAssetId.test(item.id ?? "") || counts.get(item.id) !== 1 || !clean(item.summary, 240) || !["available", "review", "unavailable"].includes(item.state)
        || (Object.hasOwn(item, "title") && !clean(item.title, 160))
        || (Object.hasOwn(item, "platform") && !clean(item.platform, 80, true))
        || (Object.hasOwn(item, "triggers") && (!Array.isArray(item.triggers) || item.triggers.length > 8 || item.triggers.some((trigger) => !clean(trigger, 80))))) {
        isolateOrFail(mode, requiredSourceRefs, issues, ref, "skill-entry-invalid", "skill requirement entry is invalid");
        continue;
      }
      items.push({ id: item.id, title: item.title ?? titleFromSkillId(item.id), summary: item.summary,
        triggers: Array.isArray(item.triggers) ? item.triggers : [], platform: item.platform ?? "", state: item.state });
    }
    items.sort((left, right) => compareOrdinal(left.id, right.id));
    status = items.length < parsed.entries.length ? "部分 Skill 登记暂时隔离，其他条目仍可使用"
      : parsed.root.status ?? (items.length ? "已登记，按任务需要加载" : "尚未登记 Skill");
  } catch (error) {
    isolateOrFail(mode, requiredSourceRefs, issues, ref, "skill-index-invalid", error.message);
    status = "部分 Skill 登记暂时隔离，其他功能仍可使用";
  }
  const exports = projectSkillExports(repository, instanceId, { mode, requiredSourceRefs, issues });
  return { count: items.length, status, path: "", items, exports };
}

function withoutGeneratedAt(snapshot) {
  const clone = JSON.parse(JSON.stringify(snapshot));
  if (clone?.meta) clone.meta.generated_at = "";
  return clone;
}

function buildProjectionHealth(issues) {
  const affectedAreas = [...new Set(issues.map((item) => item.area))].sort(compareOrdinal).slice(0, 12);
  const count = issues.length;
  return Object.freeze({
    state: "degraded",
    isolated_item_count: count,
    affected_areas: Object.freeze(affectedAreas),
    source_data_preserved: true,
    summary: `有 ${count} 项内容暂未进入看板，源文件仍原样保留，其他有效内容可以继续使用。`,
    next_step: "让 Agent 只检查受影响类别并给出修复建议；修复前不需要停止其他无关工作。",
  });
}

function publicDiagnostics(issues) {
  // 限制诊断明细的输出，不限制可以隔离的坏项数；health 保留完整数量和类别。
  return Object.freeze(issues.slice(0, 64).map(({ area, code }) => Object.freeze({ area, code })));
}

export function buildSnapshotCandidate(repository, {
  existingSource = undefined,
  now = new Date(),
  mode = "strict",
  requiredSourceRefs = [],
} = {}) {
  if (!snapshotModes.has(mode)) fail("snapshot mode is invalid");
  const requiredSourceRefSet = normalizeRequiredSourceRefs(requiredSourceRefs);
  const issues = [];
  const root = realpathSync(repository);
  if (inspectStartupCapsule(root).decision !== "startup-capsule-valid") {
    if (mode !== "operational" || requiredSourceRefSet.has("instance/startup-capsule.toml")) fail("startup capsule is stale or invalid");
    recordOperationalIssue(issues, { area: "startup", code: "startup-capsule-stale", sourceRef: "instance/startup-capsule.toml" });
  }
  const assistant = parseSectionedToml(readStructured(root, "assistant.toml", 64 * 1024), "assistant manifest");
  const manifest = parseSectionedToml(readStructured(root, "instance/manifest.toml", 2560), "instance manifest");
  const validatedManifest = validateInstanceManifestStructure(manifest);
  const identity = validatedManifest.root; const direction = validatedManifest.direction; const profile = validatedManifest.profile; const versions = validatedManifest.versions;
  const productVersion = versions.product ?? assistant[""]?.product_version;
  if (!clean(productVersion, 64)) fail("product version is missing");
  if (identity.state === "template") {
    const startupBudget = assistant.bootstrap?.maximum_characters;
    if (!Number.isSafeInteger(startupBudget) || startupBudget < 1) fail("assistant startup budget is invalid");
    const template = {
      meta: { schema_version: "1.1", generated_at: "", product_version: productVersion, state: "template",
        freshness_seconds: 86400, source_digest: "template-empty", identity_ref: "template" },
      overview: { product: "AI Carry", state: "template", domain: "uninstantiated",
        startup_chars: measureModelVisibleStartupContext(root).totalCharacters, startup_budget: startupBudget },
      profile: { display_name: "AI Carry", mission: "把你的记忆、能力与工作方式沉淀为可迁移的个人助手。",
        domain_id: "uninstantiated", guidance_mode: "unselected", learning_policy: "unselected", language: "zh-CN" },
      assets: { memory: 0, sops: 0, capabilities: 0, experiences: 0, evolution: 0, todo: 0, governance: 0, skills: 0 },
      memories: [], sops: [], capabilities: [], experiences: [], evolution: [], governance: [], todo: [], deferred: [],
      skills: { count: 0, status: "等待实例化后按需扫描", path: "" }, changes: [],
      advanced: { file_count: 0, entry_files: ["AGENTS.md", "BOOTSTRAP.md", "assistant.toml", "core/maps/root-map.toml"] },
    };
    validateSnapshotSemantics(template, "generated formal template snapshot");
    const source = serializeSnapshotEnvelope(template);
    const current = typeof existingSource === "string" ? existingSource : readStructured(root, "dashboard/public/snapshot.js", 8 * 1024 * 1024);
    return Object.freeze({ updated: current !== source, snapshot: template, source, sourceDigest: "template-empty", identityRef: "template",
      diagnostics: Object.freeze([]), mode });
  }
  if (!["general", "domain"].includes(direction.type) || direction.locked !== true
    || !["step-by-step", "balanced", "direct"].includes(profile.guidance_mode)
    || !["risk-tiered", "manual-only"].includes(validatedManifest.learningPolicy)
    || !clean(profile.display_name, 160) || !clean(profile.mission, 512) || !clean(profile.language ?? "zh-CN", 80)) fail("instance profile lacks explicit low-sensitivity dashboard fields");
  const generatedAt = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : "";
  if (!generatedAt) fail("snapshot generation time is invalid");
  const sources = computeSnapshotSourceDigestWithMode(root, { mode, requiredSourceRefs: requiredSourceRefSet, issues });
  const { context } = loadTrustedDomainEnvelope(root);
  const onProjectionIssue = ({ area, sourceRef, code }) => recordOperationalIssue(issues, { area, sourceRef, code });
  const formal = mode === "operational"
    ? projectFormalAssetsForOperationalSnapshot(root, { requiredSourceRefs: requiredSourceRefSet, onIssue: onProjectionIssue })
    : projectFormalAssetsForSnapshot(root);
  const evolution = mode === "operational"
    ? projectCandidatesForOperationalSnapshot(root, { instanceContext: context, requiredSourceRefs: requiredSourceRefSet, onIssue: onProjectionIssue })
    : projectCandidatesForSnapshot(root, { instanceContext: context });
  const projectionOptions = { mode, requiredSourceRefs: requiredSourceRefSet, issues };
  const todo = projectSupportDirectory(root, "todo", "todo", projectionOptions);
  const governance = projectSupportDirectory(root, "governance", "governance", projectionOptions);
  const deferred = projectSupportDirectory(root, "deferred", "deferred-work", projectionOptions);
  const skills = projectSkills(root, identity.instance_id, projectionOptions);
  const startupBudget = assistant.bootstrap?.maximum_characters;
  if (!Number.isSafeInteger(startupBudget) || startupBudget < 1) fail("assistant startup budget is invalid");
  const snapshot = {
    meta: { schema_version: "1.1", generated_at: generatedAt, product_version: productVersion, state: "instance", freshness_seconds: 86400,
      source_digest: sources.digest, identity_ref: `ac-${hash(Buffer.from(identity.instance_id, "utf8")).slice(0, 12)}` },
    overview: { product: "AI Carry", state: "instance", domain: direction.type === "general" ? "general" : direction.domain_id,
      startup_chars: measureModelVisibleStartupContext(root).totalCharacters, startup_budget: startupBudget },
    profile: { display_name: profile.display_name, mission: profile.mission, domain_id: direction.type === "general" ? "general" : direction.domain_id,
      guidance_mode: profile.guidance_mode, learning_policy: validatedManifest.learningPolicy, language: profile.language ?? "zh-CN" },
    ...(issues.length > 0 ? { health: buildProjectionHealth(issues) } : {}),
    assets: { memory: formal.memory.length, sops: formal.sops.length, capabilities: formal.capabilities.length, experiences: formal.experiences.length,
      evolution: evolution.length, todo: todo.length, governance: governance.length, skills: skills.count },
    memories: formal.memory, sops: formal.sops, capabilities: formal.capabilities, experiences: formal.experiences,
    evolution, governance, todo, deferred, skills, changes: [], advanced: { file_count: sources.fileCount, entry_files: ["AGENTS.md", "BOOTSTRAP.md", "assistant.toml", "core/maps/root-map.toml"] },
  };
  validateSnapshotSemantics(snapshot, "generated instance snapshot");
  const source = serializeSnapshotEnvelope(snapshot);
  if (locateHighConfidenceSecretCandidates(source).blocked || containsForbiddenLocationReference(source)) fail("generated snapshot contains unsafe projected content");
  if (typeof existingSource === "string") {
    try {
      const existing = parseCurrentSnapshotEnvelope(existingSource, "existing current instance snapshot");
      validateSnapshotSemantics(existing, "existing instance snapshot");
      if (existing.meta?.source_digest === snapshot.meta.source_digest
        && JSON.stringify(withoutGeneratedAt(existing)) === JSON.stringify(withoutGeneratedAt(snapshot))) {
        return Object.freeze({ updated: false, snapshot: existing, source: existingSource, sourceDigest: sources.digest, identityRef: snapshot.meta.identity_ref,
          diagnostics: publicDiagnostics(issues), mode });
      }
    } catch { /* Invalid old snapshots never suppress a valid rebuild candidate. */ }
  }
  return Object.freeze({ updated: true, snapshot, source, sourceDigest: sources.digest, identityRef: snapshot.meta.identity_ref,
    diagnostics: publicDiagnostics(issues), mode });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const existingPath = resolve(root, "dashboard", "public", "snapshot.js");
  const existingSource = readStructured(root, relative(root, existingPath).split(sep).join("/"), 8 * 1024 * 1024);
  const candidate = buildSnapshotCandidate(root, { existingSource });
  console.log(JSON.stringify({ updated: candidate.updated, source_digest: candidate.sourceDigest, identity_ref: candidate.identityRef }));
}
