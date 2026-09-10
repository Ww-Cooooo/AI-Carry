import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import { lexicalSimilarity, normalizeRetrievalRequest, projectRecallUse, rankRetrievalEntries } from "./bounded-retrieval.mjs";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";
import { containsForbiddenLocationReference, containsForbiddenStructuredLocation } from "./safe-output-boundary.mjs";
import { acceptedProfessionalExtensionRecordTypes } from "./product-identity.mjs";

export const stableAssetId = /^[a-z0-9][a-z0-9._:-]{0,159}$/;
export const stableSectionSelector = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const roots = { memory: "instance/memory/", capability: "instance/capabilities/", sop: "instance/sops/", experience: "instance/experiences/", evolution: "instance/evolution/" };
const listFields = new Set(["triggers", "aliases", "scope", "conditions", "excludes", "related_asset_ids", "body_sections"]);
const projectionFields = ["summary", "triggers", "aliases", "scope", "conditions", "excludes", "related_asset_ids", "body_sections", "topic_key", "subject_key"];
const domainRouteFields = new Set(["id", "asset_kind", "subtype", "title", "summary", "triggers", "aliases", "topic_key", "subject_key", "scope", "conditions", "excludes", "related_asset_ids", "body_sections", "target", "state", "minimum_level", "confirmation"]);
const formalStates = new Set(["active", "provisional", "review", "paused", "history", "archived"]);
const trustedEnvelopes = new WeakMap();
const trustedInstanceContexts = new WeakMap();
const trustedFormalShortlists = new WeakMap();
const trustedReadChallenges = new WeakMap();
const trustedNewFormalTargets = new WeakMap();
const consumedReadConfirmationMessages = new Map();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const manifestSections = new Set(["", "direction", "profile", "learning", "validation", "privacy", "versions"]);
const manifestFields = Object.freeze({
  "": new Set(["schema_version", "instance_id", "state", "created_from", "created_at"]),
  direction: new Set(["type", "locked", "domain_id", "label", "scope_statement", "out_of_scope_policy"]),
  profile: new Set(["status", "guidance_mode", "display_name", "mission", "language", "user_preferences_ref", "domain_map_ref", "signal_control_ref", "signal_map_ref", "time_trigger_map_ref", "host_registry_ref"]),
  learning: new Set(["policy", "low_risk_promotion", "medium_high", "direct_user_instruction"]),
  validation: new Set(["evidence_index_ref"]),
  privacy: new Set(["current_execution_model", "additional_sensitive_destination", "git_storage", "credentials", "private_asset_catalog", "private_asset_catalog_load", "complete_export_scope"]),
  versions: new Set(["product", "extension_api", "asset_schema", "dashboard_snapshot_schema", "cross_session_signal_schema", "host_integration_schema",
    "private_asset_catalog_schema", "migration_kit_schema", "extension_manifest_schema", "evolution_candidate_index_schema", "asset_confirmation_gate_schema",
    "result_validation_evidence_schema", "startup_capsule_schema"]),
});

function fail(message) { throw new Error(`Asset route contract failed: ${message}`); }
function decodeUtf8(buffer, label) {
  try { return utf8Decoder.decode(buffer); } catch { fail(`${label} is not valid UTF-8`); }
}

function portableManifestRef(value, expectedPrefix, extension) {
  if (!clean(value, 240, false) || !value.startsWith(expectedPrefix) || !value.endsWith(extension)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) || value.includes("\\") || value.includes(":") || value.includes("?") || value.includes("#")) return false;
  return value.split("/").every((part) => part && part !== "." && part !== ".." && !/[. ]$/u.test(part) && !/[<>"|*]/u.test(part));
}

function projectKnownManifestFields(values, fields) {
  const projected = Object.create(null);
  for (const field of fields) if (Object.hasOwn(values, field)) projected[field] = values[field];
  return projected;
}

export function validateInstanceManifestStructure(manifest, { allowUnknownFields = true, allowLegacyProfileReadme = false } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("instance manifest is not an object");
  if (!allowUnknownFields && Object.keys(manifest).some((section) => !manifestSections.has(section))) {
    fail("instance manifest contains an unknown section");
  }
  for (const [section, values] of Object.entries(manifest)) {
    if (!values || typeof values !== "object" || Array.isArray(values)) fail("instance manifest contains a non-object section");
    const fields = manifestFields[section];
    if (!allowUnknownFields && (!fields || Object.keys(values).some((field) => !fields.has(field)))) {
      fail("instance manifest contains an unknown field");
    }
    for (const value of Object.values(values)) {
      if (typeof value === "string" && (!clean(value, 512) || locateHighConfidenceSecretCandidates(value).blocked)) fail("instance manifest contains unsafe text");
      if (!["string", "number", "boolean"].includes(typeof value)) fail("instance manifest contains a non-scalar value");
    }
  }
  const root = projectKnownManifestFields(manifest[""] ?? {}, manifestFields[""]);
  const direction = projectKnownManifestFields(manifest.direction ?? {}, manifestFields.direction);
  const profile = projectKnownManifestFields(manifest.profile ?? {}, manifestFields.profile);
  const learning = projectKnownManifestFields(manifest.learning ?? {}, manifestFields.learning);
  const validation = projectKnownManifestFields(manifest.validation ?? {}, manifestFields.validation);
  const privacy = projectKnownManifestFields(manifest.privacy ?? {}, manifestFields.privacy);
  const versions = projectKnownManifestFields(manifest.versions ?? {}, manifestFields.versions);
  const requiredRoot = ["schema_version", "instance_id", "state", "created_from", "created_at"];
  const requiredDirection = ["type", "locked", "domain_id", "label", "scope_statement", "out_of_scope_policy"];
  const requiredProfile = ["status", "guidance_mode", "user_preferences_ref", "domain_map_ref", "signal_control_ref", "signal_map_ref", "time_trigger_map_ref", "host_registry_ref"];
  if (requiredRoot.some((field) => !Object.hasOwn(root, field)) || requiredDirection.some((field) => !Object.hasOwn(direction, field))
    || requiredProfile.some((field) => !Object.hasOwn(profile, field)) || root.schema_version !== 1 || !stableAssetId.test(root.instance_id ?? "")
    || !["template", "instance"].includes(root.state) || !clean(root.created_from, 160, false) || !zonedOrEmpty(root.created_at)
    || direction.out_of_scope_policy !== "create-new-instance" || !clean(direction.label, 80) || !clean(direction.scope_statement, 240)
    || !["not-instantiated", "active"].includes(profile.status) || !["unselected", "step-by-step", "balanced", "direct"].includes(profile.guidance_mode)
    || !clean(profile.display_name ?? "", 160) || !clean(profile.mission ?? "", 512) || !["zh-CN", "en", "en-US"].includes(profile.language ?? "zh-CN")) fail("instance manifest identity, direction, or profile is invalid");
  const refs = [
    [profile.user_preferences_ref, "instance/profile/", ".md"], [profile.domain_map_ref, "instance/maps/", ".toml"],
    [profile.signal_control_ref, "instance/signals/", ".toml"], [profile.signal_map_ref, "instance/maps/", ".toml"],
    [profile.time_trigger_map_ref, "instance/maps/", ".toml"], [profile.host_registry_ref, "instance/hosts/", ".toml"],
  ];
  if (refs.some(([value, prefix, extension]) => !portableManifestRef(value, prefix, extension))) fail("instance manifest contains an invalid reference");
  if (profile.domain_map_ref !== "instance/maps/domain-map.toml" || profile.signal_control_ref !== "instance/signals/control.toml"
    || profile.signal_map_ref !== "instance/maps/signal-map.toml" || profile.time_trigger_map_ref !== "instance/maps/time-trigger-map.toml"
    || profile.host_registry_ref !== "instance/hosts/registry.toml") fail("instance manifest control references must use the exact registered locations");
  if (root.state === "template") {
    if (root.instance_id !== "template" || direction.type !== "unselected" || direction.locked !== false || direction.domain_id !== ""
      || profile.status !== "not-instantiated" || profile.guidance_mode !== "unselected" || profile.user_preferences_ref !== "instance/profile/README.md") fail("template manifest state is inconsistent");
  } else if (direction.type === "general") {
    if (direction.locked !== true || direction.domain_id !== "" || profile.status !== "active" || profile.guidance_mode === "unselected"
      || (!allowLegacyProfileReadme && profile.user_preferences_ref === "instance/profile/README.md")) fail("general instance manifest state is inconsistent");
  } else if (direction.type === "domain") {
    if (direction.locked !== true || !stableAssetId.test(direction.domain_id ?? "") || direction.domain_id === ""
      || profile.status !== "active" || profile.guidance_mode === "unselected"
      || (!allowLegacyProfileReadme && profile.user_preferences_ref === "instance/profile/README.md")) fail("domain instance manifest state is inconsistent");
  } else fail("instance manifest direction is unsupported");
  const learningMissing = !Object.hasOwn(manifest, "learning");
  if (!learningMissing && (Object.keys(learning).length !== manifestFields.learning.size
    || !["risk-tiered", "manual-only"].includes(learning.policy)
    || learning.low_risk_promotion !== "explicit-confirmation-after-notice" || learning.medium_high !== "explicit-confirmation"
    || learning.direct_user_instruction !== "direct-authorization")) fail("instance manifest learning policy is invalid");
  const validationMissing = !Object.hasOwn(manifest, "validation") || !Object.hasOwn(validation, "evidence_index_ref");
  if (!validationMissing && (Object.keys(validation).length !== 1
    || validation.evidence_index_ref !== "instance/validations/index.toml")) fail("instance manifest validation reference is invalid");
  if (Object.hasOwn(manifest, "privacy") && (Object.keys(privacy).length !== manifestFields.privacy.size
    || privacy.current_execution_model !== "allow-task-needed-private-context" || privacy.additional_sensitive_destination !== "explicit-authorization"
    || privacy.git_storage !== "exclude-private-and-secrets" || privacy.credentials !== "host-secret-mechanism-only"
    || privacy.private_asset_catalog !== "create-on-first-relevant-use" || privacy.private_asset_catalog_load !== "on-demand-only"
    || privacy.complete_export_scope !== "registered-and-referenced")) fail("instance manifest privacy policy is invalid");
  return Object.freeze({ root, direction, profile, learningPolicy: learningMissing ? "manual-only" : learning.policy,
    validationEvidenceIndexRef: validationMissing ? "instance/validations/index.toml" : validation.evidence_index_ref,
    legacyProfileMigrationRequired: root.state === "instance" && profile.user_preferences_ref === "instance/profile/README.md",
    versions, schemaMigrationRequired: learningMissing || validationMissing || versions.result_validation_evidence_schema !== "1.0"
      || versions.evolution_candidate_index_schema !== "1.0" || versions.asset_confirmation_gate_schema !== "1.0"
      || versions.startup_capsule_schema !== "1.0" });
}

function parseValue(raw, key) {
  if (/^"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"$/.test(raw) || /^\[.*\]$/.test(raw)) {
    try { return JSON.parse(raw); } catch { fail(`unsupported TOML value for ${key}`); }
  }
  if (raw === "true" || raw === "false") return raw === "true";
  if (/^-?(?:0|[1-9][0-9]*)$/.test(raw)) return Number(raw);
  fail(`unsupported TOML value for ${key}`);
}
function assign(target, line, label, lineNumber) {
  const match = line.match(/^([a-z0-9_]+)\s*=\s*(.+)$/);
  if (!match) fail(`${label} has unsupported syntax at line ${lineNumber}`);
  if (["__proto__", "prototype", "constructor"].includes(match[1])) fail(`${label} uses a forbidden key at line ${lineNumber}`);
  if (Object.hasOwn(target, match[1])) fail(`${label} repeats ${match[1]}`);
  target[match[1]] = parseValue(match[2], `${label}.${match[1]}`);
}

export function parseRouteMap(source, label = "domain map") {
  const root = Object.create(null);
  const budget = Object.create(null);
  const routes = [];
  let target = root;
  for (const [index, rawLine] of source.replaceAll("\r\n", "\n").split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[budget]") { target = budget; continue; }
    if (line === "[[routes]]") { target = Object.create(null); routes.push(target); continue; }
    if (/^\[/.test(line)) fail(`${label} contains an unsupported table at line ${index + 1}`);
    assign(target, line, label, index + 1);
  }
  return { root, budget, routes };
}

export function parseArrayTableDocument(source, tableName, label = "TOML document") {
  const root = Object.create(null);
  const entries = [];
  let target = root;
  for (const [index, rawLine] of source.replaceAll("\r\n", "\n").split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === `[[${tableName}]]`) { target = Object.create(null); entries.push(target); continue; }
    if (/^\[/.test(line)) fail(`${label} contains an unsupported table at line ${index + 1}`);
    assign(target, line, label, index + 1);
  }
  return { root, entries };
}

export function parseMarkdownFrontmatterHead(head, label = "asset") {
  const normalized = head.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("+++\n")) fail(`${label} lacks TOML frontmatter`);
  const end = normalized.indexOf("\n+++\n", 4);
  if (end < 0) fail(`${label} frontmatter does not close within 16 KiB`);
  if (Buffer.byteLength(normalized.slice(0, end + 5), "utf8") > 16 * 1024) fail(`${label} frontmatter does not close within 16 KiB`);
  const values = Object.create(null);
  for (const [index, rawLine] of normalized.slice(4, end).split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    assign(values, line, `${label} frontmatter`, index + 2);
  }
  const bodyCharOffset = end + 5;
  return { values, bodyOffset: bodyCharOffset, bodyCharOffset, bodyByteOffset: Buffer.byteLength(normalized.slice(0, bodyCharOffset), "utf8") };
}

function digest(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function portablePathSegment(part) {
  const base = part.replace(/\..*$/u, "").toLowerCase();
  return part && part !== "." && part !== ".." && !/[. ]$/u.test(part) && !/[<>"|*]/u.test(part)
    && !["con", "prn", "aux", "nul", "clock$"].includes(base) && !/^(?:com|lpt)[1-9]$/u.test(base);
}
function portablePathKey(target) { return target.normalize("NFC").toLowerCase(); }

function resolvePhysicalRelativeFile(repository, target, label, allowedExtensions = [".md"]) {
  if (typeof target !== "string" || !allowedExtensions.some((extension) => target.endsWith(extension)) || target.normalize("NFC") !== target || target.includes("\\") || target.includes(":") || target.includes("?") || target.includes("#") || unsafeText.test(target)) fail(`${label} has unsafe syntax: ${target}`);
  const parts = target.split("/");
  if (!parts.every(portablePathSegment)) fail(`${label} contains traversal or a non-portable path segment: ${target}`);
  let cursor = repository;
  try {
    for (const part of parts) {
      cursor = resolve(cursor, part);
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) fail(`${label} crosses a link or reparse point: ${target}`);
    }
  } catch (error) {
    if (String(error?.message ?? "").startsWith("Asset route contract failed:")) throw error;
    fail(`${label} does not resolve to an existing path: ${target}`);
  }
  if (!lstatSync(cursor).isFile()) fail(`${label} is not a regular file: ${target}`);
  const rootReal = realpathSync(repository);
  const targetReal = realpathSync(cursor);
  const fromRoot = relative(rootReal, targetReal);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) fail(`${label} escapes AI Carry: ${target}`);
  return cursor;
}

function readPhysicalRelativeFile(repository, target, label, allowedExtensions, maxBytes) {
  const path = resolvePhysicalRelativeFile(repository, target, label, allowedExtensions);
  const pathRealBefore = realpathSync(path);
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) fail(`${label} exceeds its ${maxBytes}-byte envelope or is not a regular file`);
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== buffer.length || !sameIdentity(before, after)) fail(`${label} changed during its bounded read`);
    const pathInfoAfter = lstatSync(path);
    if (!pathInfoAfter.isFile() || pathInfoAfter.isSymbolicLink() || realpathSync(path) !== pathRealBefore) fail(`${label} changed path identity during its bounded read`);
    return Object.freeze({ path, buffer, text: decodeUtf8(buffer, label), fileBytes: buffer.length, sha256: digest(buffer) });
  } finally { closeSync(descriptor); }
}

function readPhysicalRelativeHead(repository, target, label, allowedExtensions, maxFileBytes, headBytes = 16 * 1024) {
  const path = resolvePhysicalRelativeFile(repository, target, label, allowedExtensions);
  const pathRealBefore = realpathSync(path);
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxFileBytes)) fail(`${label} exceeds its ${maxFileBytes}-byte envelope or is not a regular file`);
    const buffer = Buffer.alloc(Math.min(Number(before.size), headBytes));
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== buffer.length || !sameIdentity(before, after)) fail(`${label} changed during its bounded head read`);
    const pathInfoAfter = lstatSync(path);
    if (!pathInfoAfter.isFile() || pathInfoAfter.isSymbolicLink() || realpathSync(path) !== pathRealBefore) fail(`${label} changed path identity during its bounded head read`);
    const delimiters = [Buffer.from("\n+++\n", "ascii"), Buffer.from("\r\n+++\r\n", "ascii")];
    const matches = delimiters.map((delimiter) => ({ delimiter, index: buffer.indexOf(delimiter, 4) })).filter((match) => match.index >= 0).sort((left, right) => left.index - right.index);
    const match = matches[0];
    if (!match || match.index + match.delimiter.length > headBytes) fail(`${label} frontmatter does not close within 16 KiB`);
    const frontmatterBuffer = buffer.subarray(0, match.index + match.delimiter.length);
    return Object.freeze({ path, head: decodeUtf8(frontmatterBuffer, label), fileBytes: Number(before.size) });
  } finally { closeSync(descriptor); }
}

export function resolvePhysicalAssetTarget(repository, target, kind) {
  const expected = roots[kind];
  if (!expected || typeof target !== "string" || !target.startsWith(expected) || !target.endsWith(".md")) fail(`target has wrong root or extension: ${target}`);
  return resolvePhysicalRelativeFile(repository, target, "target");
}

export function prepareNewFormalTarget(repository, target, kind) {
  const expected = roots[kind];
  if (!expected || typeof target !== "string" || !target.startsWith(expected) || !target.endsWith(".md")
    || target.normalize("NFC") !== target || target.includes("\\") || target.includes(":") || target.includes("?") || target.includes("#")
    || !target.split("/").every(portablePathSegment)) fail("new formal target has unsafe syntax");
  const repositoryReal = realpathSync(repository);
  const targetPath = resolve(repositoryReal, ...target.split("/"));
  const parent = dirname(targetPath);
  const parentReal = realpathSync(parent);
  const fromRoot = relative(repositoryReal, parentReal);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) fail("new formal target parent escapes AI Carry");
  let cursor = repositoryReal;
  for (const part of target.split("/").slice(0, -1)) {
    cursor = resolve(cursor, part);
    const info = lstatSync(cursor, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) fail("new formal target parent crosses a link or reparse point");
  }
  try { lstatSync(targetPath); fail("new formal target is already occupied"); }
  catch (error) { if (String(error?.message ?? "").startsWith("Asset route contract failed:")) throw error; if (error?.code !== "ENOENT") fail("new formal target cannot be inspected"); }
  const leafKey = target.split("/").at(-1).normalize("NFC").toLowerCase();
  if (readdirSync(parent).some((name) => name.normalize("NFC").toLowerCase() === leafKey)) fail("new formal target has a case or normalization collision");
  const parentIdentity = statSync(parent, { bigint: true });
  const proof = Object.freeze({ decision: "new-formal-target-available", target, kind, executable: false });
  trustedNewFormalTargets.set(proof, Object.freeze({ repository: repositoryReal, targetPath, parentReal,
    parentDev: parentIdentity.dev, parentIno: parentIdentity.ino, leafKey }));
  return proof;
}

export function verifyNewFormalTarget(repository, proof) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return null; }
  const trust = trustedNewFormalTargets.get(proof);
  if (!trust || trust.repository !== repositoryReal) return null;
  try {
    const parentIdentity = statSync(trust.parentReal, { bigint: true });
    if (parentIdentity.dev !== trust.parentDev || parentIdentity.ino !== trust.parentIno
      || readdirSync(trust.parentReal).some((name) => name.normalize("NFC").toLowerCase() === trust.leafKey)) return null;
  } catch { return null; }
  try { lstatSync(trust.targetPath); return null; }
  catch (error) { return error?.code === "ENOENT" ? Object.freeze({ target: proof.target, kind: proof.kind, targetPreimage: "absent" }) : null; }
}

export function parseSectionedToml(source, label) {
  const sections = Object.create(null); sections[""] = Object.create(null); let section = "";
  for (const [index, rawLine] of source.replaceAll("\r\n", "\n").split("\n").entries()) {
    const line = rawLine.trim(); if (!line || line.startsWith("#")) continue;
    const table = /^\[([a-z0-9_-]+)\]$/u.exec(line);
    if (table) { section = table[1]; sections[section] ??= Object.create(null); continue; }
    if (/^\[/u.test(line)) fail(`${label} has unsupported table syntax at line ${index + 1}`);
    assign(sections[section], line, label, index + 1);
  }
  return sections;
}

function resolveTaskFamilyTarget(repository, route, expected) {
  const path = resolvePhysicalRelativeFile(repository, route.target, `task-family ${route.id} target`);
  if (statSync(path).size > 32 * 1024) fail(`task-family ${route.id} target exceeds the 32 KiB entry limit`);
  if (route.target.startsWith("instance/profile/")) {
    if (typeof expected.profileEntryRef !== "string"
      || !expected.profileEntryRef.startsWith("instance/profile/")
      || route.target !== expected.profileEntryRef) fail(`task-family ${route.id} is not the profile entry registered by the trusted instance manifest`);
    return path;
  }
  const match = /^workspace\/([a-z0-9][a-z0-9.-]{2,63})\/(.+\.md)$/u.exec(route.target);
  if (!match) fail(`task-family ${route.id} target is outside an allowed profile or workspace root`);
  const extensionId = match[1];
  const manifestTarget = `workspace/${extensionId}/extension.toml`;
  let manifestRead;
  try { manifestRead = readPhysicalRelativeFile(repository, manifestTarget, `extension ${extensionId}`, [".toml"], 32 * 1024); }
  catch { fail(`task-family ${route.id} extension manifest is missing, linked, invalid, or oversized`); }
  const manifest = parseSectionedToml(manifestRead.text, `extension ${extensionId}`);
  const root = manifest[""]; const entry = manifest.entry ?? {}; const ownership = manifest.ownership ?? {};
  if (Object.keys(root).some((field) => !new Set(["schema_version", "record_type", "extension_id", "instance_id", "title", "summary", "extension_version", "status", "root", "load_policy"]).has(field))
    || Object.keys(entry).some((field) => !new Set(["route_ids", "task_family_targets"]).has(field))
    || Object.keys(ownership).some((field) => !new Set(["portable_paths", "derived_paths", "device_local_root", "private_collection_refs", "unclassified_policy"]).has(field))
    || root.schema_version !== 1 || !acceptedProfessionalExtensionRecordTypes.has(root.record_type) || root.extension_id !== extensionId
    || root.instance_id !== expected.instanceId || root.status !== "active" || root.root !== `workspace/${extensionId}` || root.load_policy !== "on-demand-only"
    || !clean(root.title, 80, false) || !clean(root.summary, 240, false) || !clean(root.extension_version, 32, false)) fail(`task-family ${route.id} extension identity or lifecycle is invalid`);
  if (!Array.isArray(entry.route_ids) || !entry.route_ids.includes(route.id) || new Set(entry.route_ids).size !== entry.route_ids.length || entry.route_ids.some((id) => !stableAssetId.test(id))) fail(`task-family ${route.id} is not registered by its extension entry`);
  if (!Array.isArray(entry.task_family_targets) || !entry.task_family_targets.includes(match[2])
    || new Set(entry.task_family_targets).size !== entry.task_family_targets.length
    || entry.task_family_targets.some((target) => typeof target !== "string" || target.length === 0 || target.length > 200 || target.normalize("NFC") !== target || target.includes("\\") || target.includes(":") || target.includes("?") || target.includes("#") || unsafeText.test(target) || !target.endsWith(".md") || !target.split("/").every((part) => part && part !== "." && part !== ".."))) fail(`task-family ${route.id} target is not explicitly registered by its extension entry`);
  if (!Array.isArray(ownership.portable_paths)) fail(`task-family ${route.id} extension has no portable ownership list`);
  if (new Set(ownership.portable_paths).size !== ownership.portable_paths.length || ownership.portable_paths.some((declared) => typeof declared !== "string" || declared.length === 0 || declared.normalize("NFC") !== declared || declared.includes("\\") || declared.includes(":") || declared.includes("?") || declared.includes("#") || unsafeText.test(declared) || !declared.split("/").every((part) => part && part !== "." && part !== ".."))) fail(`task-family ${route.id} extension has unsafe portable ownership paths`);
  const relativeTarget = match[2];
  const owned = ownership.portable_paths.some((declared) => typeof declared === "string" && declared.split("/").every((part) => part && part !== "." && part !== "..") && (relativeTarget === declared || relativeTarget.startsWith(`${declared.replace(/\/$/u, "")}/`)));
  if (!owned) fail(`task-family ${route.id} target is not owned by the registered extension`);
  return path;
}

function clean(value, max, allowEmpty = true) { return typeof value === "string" && (allowEmpty || value.length > 0) && [...value].length <= max && value.normalize("NFC") === value && !unsafeText.test(value); }
function cleanList(value, maxItems, maxChars) { return Array.isArray(value) && value.length <= maxItems && value.every((item) => clean(item, maxChars, false)); }
function subtypeCompatibility(asset) {
  if (asset.kind === "memory" && ["general", "habit"].includes(asset.subtype)) return { valid: true, subtype: asset.subtype, migrationRequired: false };
  if (asset.kind === "experience" && ["task", "host-execution"].includes(asset.subtype)) return { valid: true, subtype: asset.subtype, migrationRequired: false };
  if (["memory", "experience"].includes(asset.kind) && (asset.subtype === undefined || asset.subtype === "")
    && asset.approval_state === "explicit" && ["explicit-user", "existing-approved-migration"].includes(asset.activation_basis)) {
    return { valid: true, subtype: `legacy-unclassified-${asset.kind}`, migrationRequired: true };
  }
  if (["capability", "sop"].includes(asset.kind) && (asset.subtype === undefined || asset.subtype === "")) return { valid: true, subtype: "", migrationRequired: false };
  return { valid: false, subtype: "", migrationRequired: false };
}
function validAuthorization(asset) {
  if (!subtypeCompatibility(asset).valid) return false;
  if (!["low", "medium", "high"].includes(asset.risk_tier)) return false;
  if (asset.status === "provisional" && asset.risk_tier !== "low") return false;
  // A file cannot prove its own policy authorization. Risk-tiered learning may
  // create and accumulate an explicitly observed candidate, but becoming a
  // readable formal asset always requires a user-confirmed promotion receipt
  // (or a separately verified migration of an earlier user approval).
  return asset.approval_state === "explicit" && asset.approved_by_user === true
    && ["explicit-user", "existing-approved-migration"].includes(asset.activation_basis);
}

function validPrivateReference(ref) {
  if (!clean(ref, 240, false) || locateHighConfidenceSecretCandidates(ref).blocked) return false;
  let relativeRef;
  if (ref.startsWith("private://")) {
    const match = /^private:\/\/([a-z0-9][a-z0-9._:-]{0,159})\/(.+)$/u.exec(ref);
    if (!match) return false;
    relativeRef = match[2];
  } else if (ref.startsWith(".assistant-private/assets/")) {
    relativeRef = ref.slice(".assistant-private/assets/".length);
  } else return false;
  return relativeRef.length > 0 && relativeRef.normalize("NFC") === relativeRef && !relativeRef.includes("\\")
    && !relativeRef.includes(":") && !relativeRef.includes("?") && !relativeRef.includes("#")
    && relativeRef.split("/").every(portablePathSegment);
}

const validationRootFields = new Set(["schema_version", "index_id", "instance_id", "state", "source_revision", "generated_at", "budget_bytes", "overflow", "record_count"]);
const validationRecordFields = new Set(["id", "asset_id", "outcome", "task_event_id", "context_id", "host_experience_ref", "environment_ref", "validated_at", "result_protocol", "source_revision"]);
function loadResultValidationEvidence(repository, context) {
  const contextTrust = trustedInstanceContexts.get(context);
  if (!contextTrust || !instanceContextFresh(context)) return null;
  let read;
  try { read = readPhysicalRelativeFile(repository, context.validationEvidenceIndexRef, "result validation evidence index", [".toml"], 262144); }
  catch { return null; }
  let parsed;
  try { parsed = parseArrayTableDocument(read.text, "validations", "result validation evidence index"); }
  catch { return null; }
  const root = parsed.root; const records = parsed.entries;
  const rootValid = Object.keys(root).every((field) => validationRootFields.has(field))
    && root.schema_version === 1 && root.index_id === "result-validations" && root.instance_id === context.instanceId
    && ["empty", "current"].includes(root.state) && Number.isSafeInteger(root.source_revision) && root.source_revision >= 0
    && root.budget_bytes === 262144 && root.overflow === false && root.record_count === records.length && records.length <= 1024
    && (context.manifestState !== "template" || root.state === "empty")
    && (root.state === "empty" ? records.length === 0 && root.generated_at === ""
      : records.length > 0 && zonedOrEmpty(root.generated_at) && root.generated_at !== "");
  if (!rootValid) return null;
  const byId = new Map();
  const recordsByAssetId = new Map();
  const assetContextPairs = new Set();
  for (const record of records) {
    const pair = `${record.asset_id ?? ""}\u0000${record.task_event_id ?? ""}`;
    if (Object.keys(record).length !== validationRecordFields.size || Object.keys(record).some((field) => !validationRecordFields.has(field))
      || !stableAssetId.test(record.id ?? "") || byId.has(record.id) || assetContextPairs.has(pair) || !stableAssetId.test(record.asset_id ?? "")
      || !["success", "failure"].includes(record.outcome) || !stableAssetId.test(record.task_event_id ?? "") || !stableAssetId.test(record.context_id ?? "")
      || !clean(record.host_experience_ref ?? "", 160) || (record.host_experience_ref !== "" && !stableAssetId.test(record.host_experience_ref))
      || !clean(record.environment_ref ?? "", 160) || (record.environment_ref !== "" && !stableAssetId.test(record.environment_ref))
      || !zonedOrEmpty(record.validated_at) || record.validated_at === "" || record.result_protocol !== "result-validation-v1"
      || !Number.isSafeInteger(record.source_revision) || record.source_revision < 1
      || locateHighConfidenceSecretCandidates(JSON.stringify(record)).blocked || containsForbiddenLocationReference(JSON.stringify(record))) return null;
    const frozen = Object.freeze({ ...record });
    byId.set(record.id, frozen); assetContextPairs.add(pair);
    if (!recordsByAssetId.has(record.asset_id)) recordsByAssetId.set(record.asset_id, []);
    recordsByAssetId.get(record.asset_id).push(frozen);
  }
  return Object.freeze({ byId, recordsByAssetId: new Map([...recordsByAssetId].map(([assetId, items]) => [assetId, Object.freeze([...items])])),
    digest: read.sha256, recordCount: records.length });
}

function evidenceRegistryForAsset(repository, context, asset) {
  const maturityBearing = ["capability", "sop"].includes(asset?.kind)
    || (asset?.kind === "experience" && asset?.subtype === "host-execution");
  const needsEvidence = maturityBearing
    && ((asset?.maturity ?? "unvalidated") !== "unvalidated" || (asset?.validation_refs ?? []).length > 0
      || ["independent_task_count", "successful_use_count", "failed_use_count", "distinct_context_count", "distinct_host_count"]
        .some((field) => Number.isSafeInteger(asset?.[field]) && asset[field] > 0));
  return needsEvidence ? loadResultValidationEvidence(repository, context) : null;
}

function routeAssetProjectionMatches(route, asset, { operational = false } = {}) {
  if (!route || route.id !== asset.id || route.asset_kind !== asset.kind || route.state !== asset.status
    || (!operational && route.title !== asset.title)) return false;
  for (const field of projectionFields.filter((field) => !operational || field !== "summary")) {
    const fallback = listFields.has(field) ? [] : "";
    if (JSON.stringify(route[field] ?? fallback) !== JSON.stringify(asset[field] ?? fallback)) return false;
  }
  if (Object.hasOwn(route, "subtype") && route.subtype !== asset.subtype) return false;
  return true;
}

function formalExecutionMetadata(asset, routeIndex = new Map(), currentRouteId = asset.id, evidenceRegistry = null) {
  const maturityValues = new Set(["unvalidated", "practiced", "reliable", "portable"]);
  const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
  const stableList = (value, max) => Array.isArray(value) && value.length <= max && new Set(value).size === value.length && value.every((id) => stableAssetId.test(id));
  const privateRefs = asset.private_refs ?? [];
  if (!Array.isArray(privateRefs) || privateRefs.length > 32 || privateRefs.some((ref) => !validPrivateReference(ref))) return null;
  const hostRefs = asset.host_experience_refs ?? [];
  const validationRefs = asset.validation_refs ?? [];
  if (!stableList(hostRefs, 8) || !stableList(validationRefs, 5)) return null;
  const countFields = ["independent_task_count", "successful_use_count", "failed_use_count", "distinct_context_count", "distinct_host_count"];
  if (countFields.some((field) => Object.hasOwn(asset, field) && !nonnegative(asset[field]))) return null;
  const hostExecution = asset.kind === "experience" && asset.subtype === "host-execution";
  const maturityRequired = ["capability", "sop"].includes(asset.kind) || hostExecution;
  if (Object.hasOwn(asset, "maturity") && !maturityValues.has(asset.maturity)) return null;
  let maturity = maturityRequired ? (asset.maturity ?? "unvalidated") : "not-applicable";
  let metadataMigrationRequired = maturityRequired && !Object.hasOwn(asset, "maturity");
  const independent = asset.independent_task_count ?? 0;
  const successful = asset.successful_use_count ?? 0;
  const failed = asset.failed_use_count ?? 0;
  const distinctContexts = asset.distinct_context_count ?? 0;
  const distinctHosts = asset.distinct_host_count ?? 0;
  const validHostRefs = hostRefs.filter((id) => {
    const route = routeIndex.get(id);
    return route && route.asset_kind === "experience" && route.subtype === "host-execution" && ["active", "provisional"].includes(route.state) && id !== currentRouteId;
  });
  const referencedValidationRecords = validationRefs.map((id) => evidenceRegistry?.byId?.get(id)).filter(Boolean);
  const validationClosureComplete = referencedValidationRecords.length === validationRefs.length
    && referencedValidationRecords.every((record) => record.asset_id === currentRouteId);
  const validationRecords = evidenceRegistry?.recordsByAssetId?.get(currentRouteId) ?? [];
  const successfulEvidence = validationRecords.filter((record) => record.outcome === "success");
  const failedEvidence = validationRecords.filter((record) => record.outcome === "failure");
  const referencedSuccessfulEvidence = referencedValidationRecords.filter((record) => record.outcome === "success");
  const evidenceContexts = new Set(successfulEvidence.map((record) => record.context_id));
  const allEvidenceContexts = new Set(validationRecords.map((record) => record.context_id));
  const evidenceHostRefs = new Set(successfulEvidence.map((record) => record.host_experience_ref).filter(Boolean));
  const latestEvidenceAt = validationRecords.reduce((latest, record) => Date.parse(record.validated_at) > (latest ? Date.parse(latest) : -Infinity) ? record.validated_at : latest, "");
  if (successful !== successfulEvidence.length || failed !== failedEvidence.length || independent !== validationRecords.length
    || distinctContexts !== allEvidenceContexts.size || distinctHosts !== evidenceHostRefs.size
    || (validationRecords.length > 0 ? asset.last_validated_at !== latestEvidenceAt : (asset.last_validated_at ?? "") !== "")
    || successful > independent || failed > independent || successful + failed > independent || distinctContexts > independent || distinctHosts > independent
    || (validationRefs.length > 0 && !validationClosureComplete)
    || (maturity === "unvalidated" && successful > 0)
    || (maturity === "practiced" && (successful < 1 || independent < 1 || referencedSuccessfulEvidence.length < 1))
    || (maturity === "reliable" && (successful < 3 || independent < 3 || distinctContexts < 2 || failed > 0 || failedEvidence.length > 0
      || successfulEvidence.length < 3 || referencedSuccessfulEvidence.length < 3 || evidenceContexts.size < 2))
    || (maturity === "portable" && (successful < 3 || independent < 3 || distinctContexts < 2 || failed > 0 || validationRefs.length < 3
      || failedEvidence.length > 0 || successfulEvidence.length < 3 || referencedSuccessfulEvidence.length < 3 || evidenceContexts.size < 2
      || distinctHosts < 2 || validHostRefs.length < 2 || evidenceHostRefs.size < 2
      || [...evidenceHostRefs].some((id) => !validHostRefs.includes(id))))) return null;
  if (!maturityRequired && Object.hasOwn(asset, "maturity")) return null;
  if (hostExecution) {
    if (maturity === "portable" || !stableAssetId.test(asset.portable_core_ref ?? "")
      || !stableList(asset.host_profile_refs ?? [], 8)
      || !cleanList(asset.environment_scope ?? [], 8, 120) || !cleanList(asset.validity_signals ?? [], 8, 120)) return null;
    const portableCore = routeIndex.get(asset.portable_core_ref);
    if (!portableCore || !["capability", "sop"].includes(portableCore.asset_kind) || !["active", "provisional"].includes(portableCore.state)) return null;
  }
  return Object.freeze({
    maturity,
    maturitySource: metadataMigrationRequired ? "legacy-conservative-default" : (maturityRequired ? "asset-frontmatter" : "not-applicable"),
    metadataMigrationRequired,
    independentTaskCount: independent,
    successfulUseCount: successful,
    failedUseCount: failed,
    distinctContextCount: distinctContexts,
    distinctHostCount: distinctHosts,
    validationRefIds: Object.freeze([...validationRefs]),
    validationReferenceTrust: validationRefs.length ? "closed-result-validation-evidence-index" : "none-declared",
    hostExperienceRefIds: Object.freeze(validHostRefs),
    ignoredInvalidHostExperienceRefCount: hostRefs.length - validHostRefs.length,
    hostExperienceLoadPolicy: "match-current-host-metadata-then-load-at-most-one-separately",
    hasPrivateReferences: privateRefs.length > 0,
    privateReferenceCount: privateRefs.length,
    privateReferenceLoadPolicy: "separate-private-catalog-gate-after-task-match-never-from-this-projection",
  });
}

const proposedFormalFields = new Set([
  "id", "kind", "subtype", "status", "title", "summary", "triggers", "scope", "excludes", "lifecycle", "expected_next_use",
  "topic_key", "subject_key", "aliases", "conditions", "body_sections", "related_asset_ids", "source_refs", "private_refs", "supersedes",
  "minimum_level", "confirmation", "approval_state", "activation_basis", "risk_tier", "approved_by_user", "updated_at",
  "maturity", "independent_task_count", "successful_use_count", "failed_use_count", "distinct_host_count", "last_validated_at",
  "distinct_context_count",
  "validation_refs", "host_experience_refs", "portable_core_ref", "host_profile_refs", "environment_scope", "validity_signals",
]);

function formalSourceHasExactSafeFrontmatter(asset, { operational = false } = {}) {
  if (!(asset && typeof asset === "object" && !Array.isArray(asset)
    && Object.keys(asset).every((field) => (operational || proposedFormalFields.has(field)) && !["__proto__", "prototype", "constructor"].includes(field))
    && !locateHighConfidenceSecretCandidates(JSON.stringify(asset)).blocked
    && !containsForbiddenStructuredLocation(asset))) return false;
  const subtype = subtypeCompatibility(asset);
  const stableList = (value, max) => Array.isArray(value) && value.length <= max && new Set(value).size === value.length && value.every((id) => stableAssetId.test(id));
  const requiredCommon = ["id", "kind", "status", "title", "summary", "triggers", "scope", "excludes", "lifecycle", "expected_next_use",
    "topic_key", "subject_key", "aliases", "conditions", "source_refs", "private_refs", "supersedes", "minimum_level", "confirmation",
    "approval_state", "activation_basis", "risk_tier", "approved_by_user", "updated_at"];
  if (requiredCommon.some((field) => !(operational && field === "updated_at") && !Object.hasOwn(asset, field)) || !stableAssetId.test(asset.id ?? "")
    || !["memory", "capability", "sop", "experience"].includes(asset.kind) || !formalStates.has(asset.status) || !subtype.valid
    || !clean(asset.title, 80, false) || !clean(asset.summary, 240, false) || !cleanList(asset.triggers, 8, 80) || asset.triggers.length === 0
    || !cleanList(asset.scope, 8, 120) || !cleanList(asset.excludes, 6, 120) || !clean(asset.lifecycle, 40, false)
    || !clean(asset.expected_next_use, 120) || !clean(asset.topic_key, 120) || !clean(asset.subject_key, 120)
    || !cleanList(asset.aliases, 8, 80) || !cleanList(asset.conditions, 6, 120)
    || !stableList(asset.source_refs, 16) || !Array.isArray(asset.private_refs) || asset.private_refs.length > 32 || asset.private_refs.some((ref) => !validPrivateReference(ref))
    || !stableList(asset.supersedes, 8) || !stableList(asset.related_asset_ids ?? [], 8) || (asset.related_asset_ids ?? []).includes(asset.id)
    || !Array.isArray(asset.body_sections ?? []) || (asset.body_sections ?? []).length > 8 || new Set(asset.body_sections ?? []).size !== (asset.body_sections ?? []).length
    || (asset.body_sections ?? []).some((selector) => !stableSectionSelector.test(selector))
    || ![1, 2, 3].includes(asset.minimum_level) || !stableAssetId.test(asset.confirmation ?? "")
    || !["explicit", "policy-authorized", "pending"].includes(asset.approval_state) || !stableAssetId.test(asset.activation_basis ?? "")
    || !["low", "medium", "high"].includes(asset.risk_tier) || typeof asset.approved_by_user !== "boolean"
    || !(operational ? asset.updated_at === undefined || clean(asset.updated_at, 64) : zonedOrEmpty(asset.updated_at))) return false;
  const hostExecution = asset.kind === "experience" && asset.subtype === "host-execution";
  const maturityBearing = ["capability", "sop"].includes(asset.kind) || hostExecution;
  if (maturityBearing) {
    const required = ["maturity", "independent_task_count", "successful_use_count", "failed_use_count", "distinct_context_count", "last_validated_at", "validation_refs"];
    if (required.some((field) => !Object.hasOwn(asset, field)) || !["unvalidated", "practiced", "reliable", "portable"].includes(asset.maturity)
      || ["independent_task_count", "successful_use_count", "failed_use_count", "distinct_context_count"].some((field) => !Number.isSafeInteger(asset[field]) || asset[field] < 0)
      || !zonedOrEmpty(asset.last_validated_at) || !stableList(asset.validation_refs, 5)) return false;
    if (["capability", "sop"].includes(asset.kind)) {
      if (!Object.hasOwn(asset, "distinct_host_count") || !Number.isSafeInteger(asset.distinct_host_count) || asset.distinct_host_count < 0
        || !stableList(asset.host_experience_refs ?? [], 8)) return false;
    }
    if (hostExecution && (!stableAssetId.test(asset.portable_core_ref ?? "") || !stableList(asset.host_profile_refs ?? [], 8)
      || !cleanList(asset.environment_scope ?? [], 8, 120) || !cleanList(asset.validity_signals ?? [], 8, 120))) return false;
  } else if (["maturity", "independent_task_count", "successful_use_count", "failed_use_count", "distinct_context_count", "distinct_host_count",
    "last_validated_at", "validation_refs", "host_experience_refs", "portable_core_ref", "host_profile_refs", "environment_scope", "validity_signals"]
    .some((field) => Object.hasOwn(asset, field))) return false;
  return true;
}

function formalBodySectionsValid(asset, body) {
  const selectors = asset.body_sections ?? [];
  const markers = [...body.matchAll(/<!-- ac-section:([^>]+) -->/gu)].map((match) => match[1]);
  if (selectors.length === 0) return markers.length === 0;
  if (markers.length !== selectors.length || selectors.some((selector) => markers.filter((marker) => marker === selector).length !== 1)
    || markers.some((marker) => !selectors.includes(marker))) return false;
  return selectors.every((selector) => extractRegisteredSection(body, selectors, selector).ok);
}
function zonedOrEmpty(value) {
  return value === "" || (clean(value, 64, false) && Number.isFinite(Date.parse(value)) && /[zZ]|[+-]\d{2}:\d{2}$/u.test(value));
}

export function validateProposedFormalAsset(repository, envelope, asset, body) {
  const trust = trustedEnvelopes.get(envelope);
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return { decision: "proposal-invalid", reason: "repository-unavailable", executable: false }; }
  if (!trust || trust.repository !== repositoryReal || !envelopeFresh(trust) || !asset || typeof asset !== "object" || Array.isArray(asset)
    || Object.keys(asset).some((field) => !proposedFormalFields.has(field) || ["__proto__", "prototype", "constructor"].includes(field))) {
    return { decision: "proposal-invalid", reason: "untrusted-envelope-or-fields", executable: false };
  }
  const subtype = subtypeCompatibility(asset);
  const routeIndex = new Map(trust.maintenanceRoutes.map((entry) => [entry.id, entry]));
  const related = asset.related_asset_ids ?? []; const bodySections = asset.body_sections ?? [];
  if (!formalSourceHasExactSafeFrontmatter(asset) || !["active", "provisional"].includes(asset.status)
    || !subtype.valid || locateHighConfidenceSecretCandidates(body ?? "").blocked
    || containsForbiddenLocationReference(body ?? "")) {
    return { decision: "proposal-invalid", reason: "formal-schema-or-sensitive-projection-invalid", executable: false };
  }
  for (const id of related) {
    const route = routeIndex.get(id);
    if (!route || !["active", "provisional"].includes(route.state) || route.asset_kind === "task-family") return { decision: "proposal-invalid", reason: "related-asset-unavailable", executable: false };
  }
  if (!validAuthorization(asset)) return { decision: "proposal-invalid", reason: "authorization-matrix-invalid", executable: false };
  const evidenceRegistry = evidenceRegistryForAsset(repository, trust.expected, asset);
  const executionMetadata = formalExecutionMetadata(asset, routeIndex, asset.id, evidenceRegistry);
  if (!executionMetadata || executionMetadata.ignoredInvalidHostExperienceRefCount > 0) return { decision: "proposal-invalid", reason: "maturity-private-or-host-reference-invalid", executable: false };
  const gate = resolveConfirmationGate(trust.expected, asset.confirmation);
  if (!gate || gate.blocked || (["medium", "high"].includes(asset.risk_tier) && gate.id === "none")) return { decision: "proposal-invalid", reason: "confirmation-gate-invalid", executable: false };
  if (Buffer.byteLength(body ?? "", "utf8") === 0 || Buffer.byteLength(body, "utf8") > 112 * 1024) return { decision: "proposal-invalid", reason: "body-size-invalid", executable: false };
  if (!formalBodySectionsValid(asset, body)) return { decision: "proposal-invalid", reason: "body-section-size-or-boundary-invalid", executable: false };
  return Object.freeze({ decision: "proposal-metadata-valid", executable: false, subtype: subtype.subtype,
    executionMetadata, retainedFutureGateId: gate.id, routeIndexSize: routeIndex.size });
}

// Maintenance-only semantic collision check. It compares the trusted proposal
// metadata against every registered formal route, including review, paused,
// history and archived states. It never opens unrelated bodies or returns paths.
export function findPotentialFormalDuplicates(repository, envelope, proposals, { limit = 3 } = {}) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return Object.freeze({ decision: "duplicate-check-denied", matches: Object.freeze([]), executable: false }); }
  const trust = trustedEnvelopes.get(envelope);
  if (!trust || trust.repository !== repositoryReal || !envelopeFresh(trust) || !Array.isArray(proposals)
    || proposals.length < 1 || proposals.length > 2 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
    return Object.freeze({ decision: "duplicate-check-denied", matches: Object.freeze([]), executable: false });
  }
  const normalized = [];
  for (const item of proposals) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || !stableAssetId.test(item.id ?? "") || !["memory", "capability", "sop", "experience"].includes(item.kind)
      || !clean(item.title, 80, false) || !clean(item.summary, 240, false)
      || !clean(item.topicKey ?? "", 120) || !clean(item.subjectKey ?? "", 120)
      || !cleanList(item.triggers ?? [], 8, 80) || !cleanList(item.aliases ?? [], 8, 80)
      || !cleanList(item.scope ?? [], 8, 120) || !cleanList(item.conditions ?? [], 6, 120)) {
      return Object.freeze({ decision: "duplicate-check-denied", matches: Object.freeze([]), executable: false });
    }
    normalized.push(item);
  }
  const matches = [];
  for (const route of trust.maintenanceRoutes) {
    if (route.asset_kind === "task-family" || normalized.some((item) => item.id === route.id)) continue;
    const evidence = [];
    for (const item of normalized) {
      const sameTopicSubject = Boolean(item.topicKey && item.subjectKey
        && route.topic_key === item.topicKey && route.subject_key === item.subjectKey);
      const titleScore = lexicalSimilarity(item.title, route.title);
      const summaryScore = lexicalSimilarity(item.summary, route.summary);
      const triggerScore = Math.max(0, ...(item.triggers ?? []).flatMap((left) => [...(route.triggers ?? []), ...(route.aliases ?? [])].map((right) => lexicalSimilarity(left, right))),
        ...(item.aliases ?? []).flatMap((left) => [...(route.triggers ?? []), ...(route.aliases ?? [])].map((right) => lexicalSimilarity(left, right))));
      const scopeScore = Math.max(0, ...(item.scope ?? []).flatMap((left) => [...(route.scope ?? []), ...(route.conditions ?? [])].map((right) => lexicalSimilarity(left, right))),
        ...(item.conditions ?? []).flatMap((left) => [...(route.scope ?? []), ...(route.conditions ?? [])].map((right) => lexicalSimilarity(left, right))));
      const sameKind = item.kind === route.asset_kind;
      if (sameTopicSubject || titleScore >= 0.82 || summaryScore >= 0.82 || triggerScore >= 0.9 || (sameKind && triggerScore >= 0.82 && scopeScore >= 0.45)) {
        evidence.push(Object.freeze({ proposalId: item.id, sameTopicSubject, sameKind, titleScore, summaryScore, triggerScore, scopeScore }));
      }
    }
    if (evidence.length) matches.push(Object.freeze({ id: route.id, kind: route.asset_kind, state: route.state, evidence: Object.freeze(evidence) }));
    if (matches.length >= limit) break;
  }
  return Object.freeze({ decision: "duplicate-check-complete", matches: Object.freeze(matches), executable: false });
}

function verifyFormalSourceClosure(repository, validatedRoutes, trustedContext) {
  const rootsByKind = Object.entries(roots).filter(([kind]) => kind !== "evolution");
  const routeByTarget = new Map([...validatedRoutes.values()]
    .filter((route) => route.asset_kind !== "task-family")
    .map((route) => [portablePathKey(route.target), route]));
  const seen = new Set();
  const assetsById = new Map();
  const evidenceRegistry = loadResultValidationEvidence(repository, trustedContext);
  if (!evidenceRegistry) fail("result validation evidence index is unavailable or invalid");
  let declaredValidationReferenceCount = 0;
  let visited = 0;
  for (const [kind, relativeRoot] of rootsByKind) {
    const rootPath = resolve(realpathSync(repository), relativeRoot);
    const rootInfo = lstatSync(rootPath);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail(`formal ${kind} root is not a physical directory`);
    const queue = [rootPath];
    while (queue.length) {
      const directory = queue.shift();
      if (++visited > 4096) fail("formal source closure exceeds the bounded maintenance scan");
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name); const info = lstatSync(path);
        if (info.isSymbolicLink()) fail("formal source closure crosses a link or reparse point");
        if (entry.isDirectory()) { queue.push(path); continue; }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || entry.name.toLowerCase() === "readme.md") continue;
        const target = relative(realpathSync(repository), realpathSync(path)).split(sep).join("/").normalize("NFC");
        const read = readPhysicalRelativeFile(repository, target, `formal source ${kind}`, [".md"], 128 * 1024);
        const parsed = parseMarkdownFrontmatterHead(read.text);
        const asset = parsed.values;
        const body = read.text.replaceAll("\r\n", "\n").slice(parsed.bodyOffset);
        if (!formalSourceHasExactSafeFrontmatter(asset)
          || locateHighConfidenceSecretCandidates(body).blocked
          || containsForbiddenLocationReference(body)) fail("formal source contains unknown, secret-bearing, or non-portable content");
        if (asset.kind !== kind || !formalStates.has(asset.status) || !stableAssetId.test(asset.id ?? "")) fail("formal source closure contains an invalid asset identity or state");
        const route = routeByTarget.get(portablePathKey(target));
        if (!routeAssetProjectionMatches(route, asset)) fail("formal source is missing an exact domain-map projection");
        if (![1, 2, 3].includes(route.minimum_level) || ![1, 2, 3].includes(asset.minimum_level) || route.minimum_level < asset.minimum_level) fail("formal source has an invalid model-level projection");
        if (["active", "provisional"].includes(asset.status) && !validAuthorization(asset)) fail("formal source has an invalid activation combination");
        const executionMetadata = formalExecutionMetadata(asset, validatedRoutes, route.id, evidenceRegistry);
        if (!executionMetadata || executionMetadata.ignoredInvalidHostExperienceRefCount > 0) fail("formal source has invalid maturity, host-experience, or private-reference metadata");
        const execution = executionBoundary(route, asset, trustedContext);
        if (!execution.valid) fail("formal source has an invalid confirmation-gate projection");
        declaredValidationReferenceCount += executionMetadata.validationRefIds.length;
        assetsById.set(asset.id, asset);
        seen.add(portablePathKey(target));
      }
    }
  }
  if (seen.size !== routeByTarget.size || [...routeByTarget.keys()].some((target) => !seen.has(target))) fail("domain map contains a formal route without exactly one physical source");
  for (const asset of assetsById.values()) {
    for (const hostId of asset.host_experience_refs ?? []) {
      const host = assetsById.get(hostId);
      if (!host || host.kind !== "experience" || host.subtype !== "host-execution" || host.portable_core_ref !== asset.id) fail("formal source closure found a broken host-experience reverse reference");
    }
  }
  return Object.freeze({ declaredValidationReferenceCount });
}

function loadTrustedInstanceContext(repository) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { fail("AI Carry root does not exist"); }
  const coreManifestRead = readPhysicalRelativeFile(repositoryReal, "core/manifest.toml", "core manifest", [".toml"], 32 * 1024);
  const coreManifest = parseSectionedToml(coreManifestRead.text, "core manifest");
  const coreRoot = coreManifest[""] ?? {};
  const coreEntry = coreManifest.entry ?? {};
  const coreContracts = coreManifest.contracts ?? {};
  if (!["1.2", "1.3"].includes(coreRoot.asset_schema)
    || coreRoot.evolution_candidate_index_schema !== "1.0"
    || coreRoot.asset_confirmation_gate_schema !== "1.0"
    || coreRoot.result_validation_evidence_schema !== "1.0") fail("core manifest declares an unsupported asset, candidate-index, confirmation-gate, or validation-evidence schema");
  if (coreContracts.asset_confirmation_gate_registry !== "core/maps/asset-confirmation-gates.toml"
    || coreContracts.asset_confirmation_gate_schema !== "core/schemas/asset-confirmation-gates.schema.md"
    || coreContracts.result_validation_evidence_schema !== "core/schemas/result-validation-evidence-index.schema.md"
    || coreEntry.result_validation_evidence_index !== "instance/validations/index.toml") fail("core manifest does not register the confirmation-gate and result-validation evidence contracts");

  const manifestRead = readPhysicalRelativeFile(repositoryReal, "instance/manifest.toml", "instance manifest", [".toml"], 2560);
  const manifest = parseSectionedToml(manifestRead.text, "instance manifest");
  const validatedManifest = validateInstanceManifestStructure(manifest);
  const { root, direction, profile, versions } = validatedManifest;
  if (Object.hasOwn(versions, "asset_schema") && !["1.2", "1.3"].includes(versions.asset_schema)) fail("instance manifest declares an unsupported asset schema");
  if (Object.hasOwn(versions, "evolution_candidate_index_schema") && versions.evolution_candidate_index_schema !== "1.0") fail("instance manifest declares an unsupported candidate-index schema");
  if (Object.hasOwn(versions, "asset_confirmation_gate_schema") && versions.asset_confirmation_gate_schema !== "1.0") fail("instance manifest declares an unsupported confirmation-gate schema");
  resolvePhysicalRelativeFile(repositoryReal, profile.user_preferences_ref, "instance profile reference");
  resolvePhysicalRelativeFile(repositoryReal, profile.domain_map_ref, "instance domain-map reference", [".toml"]);

  let expectedDirection;
  let allowedStatuses;
  if (root.state === "template") {
    if (root.instance_id !== "template" || direction.type !== "unselected" || direction.locked !== false) fail("template manifest direction is inconsistent");
    expectedDirection = "unselected";
    allowedStatuses = ["empty-until-instantiation"];
  } else if (direction.type === "general") {
    if (direction.locked !== true || direction.domain_id !== "") fail("general instance direction is inconsistent");
    expectedDirection = "general";
    allowedStatuses = ["active"];
  } else if (direction.type === "domain") {
    if (direction.locked !== true || !stableAssetId.test(direction.domain_id ?? "") || direction.domain_id === "") fail("domain instance direction is inconsistent");
    expectedDirection = direction.domain_id;
    allowedStatuses = ["active"];
  } else {
    fail("instance manifest has an unsupported direction state");
  }

  const registryRef = coreContracts.asset_confirmation_gate_registry;
  const registryRead = readPhysicalRelativeFile(repositoryReal, registryRef, "asset confirmation gate registry", [".toml"], 16 * 1024);
  const registry = parseArrayTableDocument(registryRead.text, "gates", "asset confirmation gate registry");
  if (Object.keys(registry.root).some((field) => !["schema_version", "registry_id"].includes(field))
    || registry.root.schema_version !== 1 || registry.root.registry_id !== "asset-confirmation-gates"
    || registry.entries.length === 0 || registry.entries.length > 32) fail("asset confirmation gate registry root is invalid");
  const gateIds = [];
  const gateRecords = [];
  const confirmationResolution = new Map();
  for (const gate of registry.entries) {
    if (Object.keys(gate).some((field) => !["id", "phase", "summary", "legacy_aliases"].includes(field)) || !stableAssetId.test(gate.id ?? "") || !["none", "before-read", "before-action", "both"].includes(gate.phase)
      || (gate.id === "none" && gate.phase !== "none") || (gate.id !== "none" && gate.phase === "none") || !clean(gate.summary, 240, false)
      || !cleanList(gate.legacy_aliases ?? [], 8, 80) || (gate.legacy_aliases ?? []).some((alias) => !stableAssetId.test(alias))) fail("asset confirmation gate entry is invalid");
    gateIds.push(gate.id);
    gateRecords.push(Object.freeze({ id: gate.id, phase: gate.phase, summary: gate.summary }));
    if (confirmationResolution.has(gate.id)) fail("asset confirmation gate IDs or aliases are duplicated");
    confirmationResolution.set(gate.id, Object.freeze({ id: gate.id, migrationRequired: false, source: "registered" }));
    for (const alias of gate.legacy_aliases ?? []) {
      if (confirmationResolution.has(alias)) fail("asset confirmation gate IDs or aliases are duplicated");
      confirmationResolution.set(alias, Object.freeze({ id: gate.id, migrationRequired: true, source: "legacy-alias" }));
    }
  }
  if (new Set(gateIds).size !== gateIds.length || !gateIds.includes("none") || !gateIds.includes("risk-dependent-before-action")) fail("asset confirmation gate registry is incomplete or duplicated");

  const context = Object.freeze({
    repository: repositoryReal,
    mapId: "instance-domain",
    instanceId: root.instance_id,
    direction: expectedDirection,
    allowedStatuses: Object.freeze(allowedStatuses),
    allowedConfirmationGates: Object.freeze(gateIds),
    confirmationGates: Object.freeze(gateRecords),
    profileEntryRef: profile.user_preferences_ref,
    domainMapRef: profile.domain_map_ref,
    validationEvidenceIndexRef: validatedManifest.validationEvidenceIndexRef,
    manifestState: root.state,
    learningPolicy: root.state === "template" ? "unselected" : validatedManifest.learningPolicy,
    schemaMigrationRequired: validatedManifest.schemaMigrationRequired,
  });
  trustedInstanceContexts.set(context, Object.freeze({
    repository: repositoryReal,
    manifestDigest: manifestRead.sha256,
    coreManifestDigest: coreManifestRead.sha256,
    registryDigest: registryRead.sha256,
    registryRef,
    confirmationResolution,
  }));
  return context;
}

export function readTrustedInstanceIdentity(repository, context) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return null; }
  const trust = trustedInstanceContexts.get(context);
  if (!trust || trust.repository !== repositoryReal || context.repository !== repositoryReal || !instanceContextFresh(context)) return null;
  return Object.freeze({
    repository: repositoryReal,
    instanceId: context.instanceId,
    manifestState: context.manifestState,
  });
}

function instanceContextFresh(context) {
  const trust = trustedInstanceContexts.get(context);
  if (!trust) return false;
  try {
    const manifest = readPhysicalRelativeFile(trust.repository, "instance/manifest.toml", "instance manifest freshness check", [".toml"], 2560);
    const coreManifest = readPhysicalRelativeFile(trust.repository, "core/manifest.toml", "core manifest freshness check", [".toml"], 32 * 1024);
    const registry = readPhysicalRelativeFile(trust.repository, trust.registryRef, "confirmation registry freshness check", [".toml"], 16 * 1024);
    return manifest.sha256 === trust.manifestDigest && coreManifest.sha256 === trust.coreManifestDigest && registry.sha256 === trust.registryDigest;
  } catch { return false; }
}

export function extractRegisteredSection(body, selectors, requestedSelector) {
  if (typeof body !== "string" || !stableSectionSelector.test(requestedSelector ?? "")) return { ok: false, reason: "selector-invalid" };
  if (!Array.isArray(selectors) || selectors.length === 0 || selectors.length > 8 || new Set(selectors).size !== selectors.length || !selectors.every((selector) => stableSectionSelector.test(selector) && clean(selector, 80))) return { ok: false, reason: "registry-invalid" };
  if (!selectors.includes(requestedSelector)) return { ok: false, reason: "selector-unregistered" };
  const markers = [...body.matchAll(/<!-- ac-section:([^>]+) -->/gu)].map((match) => ({ selector: match[1], index: match.index, end: match.index + match[0].length }));
  if (markers.some((marker) => !stableSectionSelector.test(marker.selector) || !selectors.includes(marker.selector))) return { ok: false, reason: "unknown-marker" };
  if (selectors.some((selector) => markers.filter((marker) => marker.selector === selector).length !== 1)) return { ok: false, reason: "marker-count" };
  const marker = markers.find((entry) => entry.selector === requestedSelector);
  const next = markers.find((entry) => entry.index > marker.index);
  const selected = body.slice(marker.end, next?.index ?? body.length);
  const bytes = Buffer.byteLength(selected, "utf8");
  return bytes <= 32 * 1024 ? { ok: true, bytes, selected } : { ok: false, reason: "section-oversize", bytes };
}

function resolveConfirmationGate(context, raw) {
  const trust = trustedInstanceContexts.get(context);
  if (!trust || !stableAssetId.test(raw ?? "")) return null;
  const registered = trust.confirmationResolution.get(raw);
  if (registered) return registered;
  // Unknown never means "none" and must not be weakened to a generic gate. Keep
  // the map readable so other routes survive, but block this route until Level 3
  // migrates it to a registered meaning.
  return Object.freeze({ id: "risk-dependent-before-action", migrationRequired: true, source: "legacy-unknown", blocked: true });
}

function validateDomainMapEnvelope(source, parsed, expected, label = "domain map", {
  explicitRequestedId = undefined, mapDigest = undefined, mode = "strict",
} = {}) {
  const bytes = Buffer.byteLength(source, "utf8");
  const { root, budget, routes } = parsed;
  const operational = mode === "operational";
  if (!operational && mode !== "strict") fail(`${label} has an invalid read mode`);
  const expectedTrust = trustedInstanceContexts.get(expected);
  if (!expectedTrust) fail(`${label} lacks a context minted from the installed instance manifest`);
  if (explicitRequestedId !== undefined && !stableAssetId.test(explicitRequestedId)) fail(`${label} has an invalid explicit route request`);
  if (root.schema_version !== 1
    || !stableAssetId.test(root.map_id ?? "")
    || !stableAssetId.test(root.instance_id ?? "")
    || !clean(root.direction, 120, false)
    || !clean(root.status, 80, false)
    || root.map_id !== expected.mapId
    || root.instance_id !== expected.instanceId
    || root.direction !== expected.direction
    || !expected.repository
    || !Array.isArray(expected.allowedStatuses)
    || !expected.allowedStatuses.includes(root.status)) fail(`${label} identity or lifecycle state does not match the trusted instance envelope`);
  if (!Array.isArray(expected.allowedConfirmationGates)) fail(`${label} lacks a model-external confirmation-gate registry`);
  const allowedConfirmationGates = new Set(expected.allowedConfirmationGates);
  if (!allowedConfirmationGates.has("none") || allowedConfirmationGates.size !== expected.allowedConfirmationGates.length || [...allowedConfirmationGates].some((gate) => !stableAssetId.test(gate))) fail(`${label} has an invalid trusted confirmation-gate registry`);
  if (budget.soft_max_bytes !== 32768 || budget.hard_max_bytes !== 49152 || budget.soft_max_routes !== 96 || budget.hard_max_routes !== 128 || budget.max_route_bytes !== 2048 || budget.candidate_limit !== 3) fail(`${label} budget contract drift`);
  if (!['ok', 'rebuild-required'].includes(budget.overflow_state) || bytes > budget.hard_max_bytes || routes.length > budget.hard_max_routes) fail(`${label} exceeds its hard envelope`);
  const routeIds = new Set();
  const validatedRoutes = new Map();
  const formalTargets = new Set();
  const safeRoutes = [];
  const reviewRoutes = [];
  const routeConfirmationMigrations = new Map();
  const blockedRouteIds = new Set();
  const isolatedRouteIds = new Set();
  for (const route of routes) {
    try {
    if (Buffer.byteLength(JSON.stringify(route), "utf8") > budget.max_route_bytes) fail(`${label} contains an oversized route`);
    if (locateHighConfidenceSecretCandidates(JSON.stringify(route)).blocked) fail(`${label} route contains a secret candidate`);
    if (!stableAssetId.test(route.id ?? "") || routeIds.has(route.id)) fail(`${label} contains an invalid or duplicate route ID`);
    if (!operational && Object.keys(route).some((field) => !domainRouteFields.has(field))) fail(`${label} route ${route.id} contains an unknown field`);
    if (!clean(route.title, 80, false) || !clean(route.summary, 240, false)
      || !cleanList(route.triggers, 8, 80) || route.triggers.length === 0
      || !cleanList(route.aliases ?? [], 8, 80) || !clean(route.topic_key ?? "", 120)
      || !clean(route.subject_key ?? "", 120) || !cleanList(route.scope ?? [], 8, 120)
      || !cleanList(route.conditions ?? [], 6, 120) || !cleanList(route.excludes ?? [], 6, 120)
      || !cleanList(route.related_asset_ids ?? [], 8, 160) || !cleanList(route.body_sections ?? [], 8, 80)) fail(`${label} route ${route.id} contains unsafe retrieval metadata`);
    if (new Set(route.related_asset_ids ?? []).size !== (route.related_asset_ids ?? []).length
      || (route.related_asset_ids ?? []).some((id) => !stableAssetId.test(id) || id === route.id)) fail(`${label} route ${route.id} has invalid related IDs`);
    if (new Set(route.body_sections ?? []).size !== (route.body_sections ?? []).length
      || (route.body_sections ?? []).some((selector) => !stableSectionSelector.test(selector))) fail(`${label} route ${route.id} has invalid body-section selectors`);
    const confirmation = resolveConfirmationGate(expected, route.confirmation);
    if (![1, 2, 3].includes(route.minimum_level) || !confirmation || !allowedConfirmationGates.has(confirmation.id)) fail(`${label} route ${route.id} has an invalid model or confirmation gate`);
    if (!["memory", "capability", "sop", "experience", "task-family"].includes(route.asset_kind)) fail(`${label} route ${route.id} has an unknown asset kind`);
    if (Object.hasOwn(route, "subtype")) {
      const subtypeValid = (route.asset_kind === "memory" && ["general", "habit"].includes(route.subtype))
        || (route.asset_kind === "experience" && ["task", "host-execution"].includes(route.subtype));
      if (!subtypeValid) fail(`${label} route ${route.id} has an invalid subtype projection`);
    }
    if (route.asset_kind === "task-family") {
      if (route.state !== "on-demand" || !clean(route.target, 240, false) || !route.target.endsWith(".md")
        || !(route.target.startsWith("instance/profile/") || /^workspace\/[a-z0-9][a-z0-9.-]{2,63}\/.+\.md$/u.test(route.target))) fail(`${label} task-family ${route.id} has an invalid state or target`);
      resolveTaskFamilyTarget(expected.repository, route, expected);
    } else {
      if (!formalStates.has(route.state)) fail(`${label} route ${route.id} has an invalid formal state`);
      resolvePhysicalAssetTarget(expected.repository, route.target, route.asset_kind);
    }
    routeIds.add(route.id);
    validatedRoutes.set(route.id, route);
    if (["memory", "capability", "sop", "experience"].includes(route.asset_kind)) {
      const targetKey = portablePathKey(route.target);
      if (typeof route.target !== "string" || formalTargets.has(targetKey)) fail(`${label} contains a duplicate or cross-platform-colliding formal asset target`);
      formalTargets.add(targetKey);
    }
    const safeRoute = Object.freeze(Object.fromEntries([...domainRouteFields]
      .filter((field) => Object.hasOwn(route, field))
      .map((field) => [field, field === "confirmation" ? confirmation.id : (Array.isArray(route[field]) ? Object.freeze([...route[field]]) : route[field])])));
    routeConfirmationMigrations.set(route.id, confirmation.migrationRequired);
    if (confirmation.blocked) blockedRouteIds.add(route.id);
    if (!confirmation.blocked && (route.asset_kind === "task-family" || ["active", "provisional"].includes(route.state))) safeRoutes.push(safeRoute);
    else reviewRoutes.push(safeRoute);
    } catch (error) {
      if (!operational) throw error;
      if (stableAssetId.test(route?.id ?? "")) isolatedRouteIds.add(route.id);
    }
  }
  let relatedChanged = true;
  while (relatedChanged) {
    relatedChanged = false;
    for (const route of validatedRoutes.values()) {
      if (isolatedRouteIds.has(route.id)) continue;
      for (const relatedId of route.related_asset_ids ?? []) {
        const related = validatedRoutes.get(relatedId);
        if (!related || isolatedRouteIds.has(relatedId) || related.asset_kind === "task-family"
          || !["active", "provisional"].includes(related.state)) {
          if (!operational) fail(`${label} route ${route.id} has an unavailable related asset ${relatedId}`);
          isolatedRouteIds.add(route.id); relatedChanged = true; break;
        }
      }
    }
  }
  const visiting = []; const visited = new Set();
  const visitRelated = (id) => {
    if (isolatedRouteIds.has(id) || visited.has(id)) return;
    const cycleStart = visiting.indexOf(id);
    if (cycleStart >= 0) {
      if (!operational) fail(`${label} contains a related-asset cycle at ${id}`);
      for (const cycleId of visiting.slice(cycleStart)) isolatedRouteIds.add(cycleId);
      return;
    }
    visiting.push(id);
    for (const relatedId of validatedRoutes.get(id)?.related_asset_ids ?? []) visitRelated(relatedId);
    visiting.pop(); visited.add(id);
  };
  for (const id of validatedRoutes.keys()) visitRelated(id);
  if (operational && isolatedRouteIds.size) {
    relatedChanged = true;
    while (relatedChanged) {
      relatedChanged = false;
      for (const route of validatedRoutes.values()) {
        if (!isolatedRouteIds.has(route.id) && (route.related_asset_ids ?? []).some((id) => isolatedRouteIds.has(id))) {
          isolatedRouteIds.add(route.id); relatedChanged = true;
        }
      }
    }
  }
  const softExceeded = bytes > budget.soft_max_bytes || routes.length > budget.soft_max_routes;
  const explicitRoute = explicitRequestedId
    ? [...safeRoutes, ...reviewRoutes].find((route) => route.id === explicitRequestedId && !isolatedRouteIds.has(route.id)) ?? null
    : null;
  const usableSafeRoutes = safeRoutes.filter((route) => !isolatedRouteIds.has(route.id));
  const usableReviewRoutes = reviewRoutes.filter((route) => !isolatedRouteIds.has(route.id));
  const envelope = Object.freeze({
    bytes,
    routeCount: routes.length,
    isolatedRouteCount: isolatedRouteIds.size,
    softExceeded,
    ordinaryMatchingAllowed: budget.overflow_state === "ok",
    blockReason: budget.overflow_state === "ok" ? "" : "rebuild-required",
    routes: budget.overflow_state === "ok" ? Object.freeze(usableSafeRoutes) : Object.freeze([]),
    reviewRoutes: Object.freeze(explicitRoute && usableReviewRoutes.includes(explicitRoute)
      && !["active", "provisional", "on-demand"].includes(explicitRoute.state) ? [explicitRoute] : []),
    explicitRoute,
  });
  trustedEnvelopes.set(envelope, Object.freeze({
    repository: realpathSync(expected.repository),
    expected,
    context: expected,
    manifestDigest: expectedTrust.manifestDigest,
    coreManifestDigest: expectedTrust.coreManifestDigest,
    registryDigest: expectedTrust.registryDigest,
    mapDigest,
    routeConfirmationMigrations,
    blockedRouteIds,
    maintenanceRoutes: Object.freeze([...validatedRoutes.values()].filter((route) => !isolatedRouteIds.has(route.id))
      .map((route) => Object.freeze({ ...route }))),
  }));
  return envelope;
}

export function loadTrustedDomainEnvelope(repository, { explicitRequestedId = undefined } = {}) {
  const context = loadTrustedInstanceContext(repository);
  const mapRead = readPhysicalRelativeFile(context.repository, context.domainMapRef, "instance domain map", [".toml"], 49152);
  const parsed = parseRouteMap(mapRead.text, "instance domain map");
  const envelope = validateDomainMapEnvelope(mapRead.text, parsed, context, "instance domain map", { explicitRequestedId, mapDigest: mapRead.sha256 });
  return Object.freeze({ context, envelope });
}

function loadOperationalDomainEnvelope(repository) {
  const context = loadTrustedInstanceContext(repository);
  const mapRead = readPhysicalRelativeFile(context.repository, context.domainMapRef, "instance domain map", [".toml"], 49152);
  const parsed = parseRouteMap(mapRead.text, "instance domain map");
  const envelope = validateDomainMapEnvelope(mapRead.text, parsed, context, "instance domain map", {
    mapDigest: mapRead.sha256, mode: "operational",
  });
  return Object.freeze({ context, envelope });
}

// Opaque maintenance fingerprint for same-process transaction guards. It binds
// the complete map (including review/history routes), installed identity,
// manifest, core schema and confirmation registry without exposing any paths or
// raw digests to model-visible projections.
export function trustedMaintenanceStateDigest(repository, envelope) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return null; }
  const trust = trustedEnvelopes.get(envelope);
  if (!trust || trust.repository !== repositoryReal || !envelopeFresh(trust)) return null;
  return digest(Buffer.from(JSON.stringify({
    instanceId: trust.context.instanceId,
    manifestState: trust.context.manifestState,
    direction: trust.context.direction,
    learningPolicy: trust.context.learningPolicy,
    manifestDigest: trust.manifestDigest,
    coreManifestDigest: trust.coreManifestDigest,
    registryDigest: trust.registryDigest,
    mapDigest: trust.mapDigest,
    confirmationGates: trust.context.confirmationGates,
    maintenanceRoutes: trust.maintenanceRoutes,
  }), "utf8"));
}

// Maintenance/transaction boundary only. Ordinary task routing must never call
// this full projection audit; it is intentionally separate from the bounded
// map + selected-frontmatter read path.
export function auditFormalSourceClosure(repository) {
  const { envelope } = loadTrustedDomainEnvelope(repository);
  const trust = trustedEnvelopes.get(envelope);
  if (!trust) fail("formal source closure audit lacks a trusted maintenance envelope");
  const routes = new Map(trust.maintenanceRoutes.map((route) => [route.id, route]));
  const closure = verifyFormalSourceClosure(repository, routes, trust.expected);
  return Object.freeze({
    decision: closure.declaredValidationReferenceCount > 0 ? "formal-projection-closure-complete-reference-evidence-needs-result-validation-audit" : "formal-source-closure-complete",
    routeCount: routes.size, declaredValidationReferenceCount: closure.declaredValidationReferenceCount,
    executable: false,
  });
}

// Explicit snapshot-maintenance projection. It runs the full source closure
// first, then emits only low-sensitivity metadata; ordinary startup and task
// routing never call this function.
function projectFormalSnapshotRoute(repository, route, routeIndex, evidenceRegistry, { operational = false } = {}) {
  const read = readFormalAsset(repository, route, 128 * 1024, { operational });
  const asset = read.asset;
  if (!routeAssetProjectionMatches(route, asset, { operational })) fail(`snapshot route/source drift at ${route.id}`);
  if (["active", "provisional"].includes(asset.status) && !validAuthorization(asset)) fail(`snapshot source authorization is invalid at ${route.id}`);
  const execution = formalExecutionMetadata(asset, routeIndex, route.id, evidenceRegistry);
  if (!execution || execution.ignoredInvalidHostExperienceRefCount > 0) fail(`snapshot maturity or reference metadata is invalid at ${route.id}`);
    const approvalState = ["explicit", "policy-authorized", "pending"].includes(asset.approval_state) ? asset.approval_state : "pending";
    const activationBasis = clean(asset.activation_basis ?? "", 64, false) ? asset.activation_basis : "candidate";
    const riskTier = ["low", "medium", "high"].includes(asset.risk_tier) ? asset.risk_tier : "high";
    const item = {
      id: asset.id,
      title: asset.title,
      summary: asset.summary,
      status: asset.status,
      approval_state: approvalState,
      activation_basis: activationBasis,
      risk_tier: riskTier,
      approved_by_user: asset.approved_by_user === true,
      triggers: [...(asset.triggers ?? [])],
    };
    if (["memory", "experience"].includes(asset.kind)) item.subtype = subtypeCompatibility(asset).subtype;
    if (asset.kind === "memory") {
      const scope = asset.scope ?? []; const excludes = asset.excludes ?? [];
      item.scope_summary = scope.length || excludes.length
        ? `${scope.length ? `适用于：${scope.join("；")}` : ""}${scope.length && excludes.length ? "。" : ""}${excludes.length ? `不用于：${excludes.join("；")}` : ""}`
        : "现有记录尚未说明适用范围";
      item.source_summary = approvalState === "explicit" && item.approved_by_user
        ? "来自用户明确确认的长期积累" : "现有记录仍需核对来源与授权";
    }
    if (["capability", "sop"].includes(asset.kind) || (asset.kind === "experience" && item.subtype === "host-execution")) {
      item.maturity = execution.maturity;
      item.reliability = execution.maturity;
      item.evidence_summary = `独立任务 ${execution.independentTaskCount}；成功 ${execution.successfulUseCount}；失败 ${execution.failedUseCount}；宿主 ${execution.distinctHostCount}`;
    }
  return Object.freeze({ route, asset, targetKey: { memory: "memory", sop: "sops", capability: "capabilities", experience: "experiences" }[asset.kind],
    item: Object.freeze(item) });
}

function freezeFormalProjection(result) {
  return Object.freeze(Object.fromEntries(Object.entries(result).map(([key, value]) => [key,
    Object.freeze(value.sort((left, right) => left.id.localeCompare(right.id, "en")))])));
}

function formalSnapshotArea(kind) {
  return { memory: "memory", sop: "sops", capability: "capabilities", experience: "experiences" }[kind] ?? "formal-assets";
}

export function projectFormalAssetsForSnapshot(repository) {
  auditFormalSourceClosure(repository);
  const { envelope } = loadTrustedDomainEnvelope(repository);
  const trust = trustedEnvelopes.get(envelope);
  if (!trust || !envelopeFresh(trust)) fail("snapshot formal projection lacks a fresh trusted maintenance envelope");
  const evidenceRegistry = loadResultValidationEvidence(repository, trust.expected);
  if (!evidenceRegistry) fail("snapshot result-validation evidence index is unavailable or invalid");
  const result = { memory: [], sops: [], capabilities: [], experiences: [] };
  const routeIndex = new Map(trust.maintenanceRoutes.map((entry) => [entry.id, entry]));
  for (const route of [...trust.maintenanceRoutes].filter((entry) => entry.asset_kind !== "task-family")) {
    const projected = projectFormalSnapshotRoute(repository, route, routeIndex, evidenceRegistry);
    result[projected.targetKey].push(projected.item);
  }
  return freezeFormalProjection(result);
}

export function projectFormalAssetsForOperationalSnapshot(repository, {
  requiredSourceRefs = new Set(), onIssue = undefined,
} = {}) {
  if (!(requiredSourceRefs instanceof Set) || typeof onIssue !== "function") fail("operational formal projection requires bounded isolation controls");
  const { envelope } = loadTrustedDomainEnvelope(repository);
  const trust = trustedEnvelopes.get(envelope);
  if (!trust || !envelopeFresh(trust)) fail("operational formal projection lacks a fresh trusted maintenance envelope");
  let evidenceRegistry = loadResultValidationEvidence(repository, trust.expected);
  if (!evidenceRegistry) {
    const evidenceRef = trust.expected.validationEvidenceIndexRef;
    if (requiredSourceRefs.has(evidenceRef)) fail("required result-validation evidence index is unavailable or invalid");
    onIssue({ area: "validations", sourceRef: evidenceRef, code: "validation-index-uninitialized-or-invalid" });
    evidenceRegistry = Object.freeze({ byId: new Map(), recordsByAssetId: new Map(), recordCount: 0 });
  }
  const routes = [...trust.maintenanceRoutes].filter((entry) => entry.asset_kind !== "task-family");
  const routeIndex = new Map(trust.maintenanceRoutes.map((entry) => [entry.id, entry]));
  const projectedById = new Map(); const invalidIds = new Set();
  for (const route of routes) {
    try { projectedById.set(route.id, projectFormalSnapshotRoute(repository, route, routeIndex, evidenceRegistry,
      { operational: !requiredSourceRefs.has(route.target) })); }
    catch (error) {
      if (requiredSourceRefs.has(route.target)) throw error;
      invalidIds.add(route.id); onIssue({ area: formalSnapshotArea(route.asset_kind), sourceRef: route.target, code: "formal-source-invalid" });
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, projected] of projectedById) {
      const dependencies = [...(projected.asset.related_asset_ids ?? []), ...(projected.asset.host_experience_refs ?? [])];
      if (!dependencies.some((dependency) => invalidIds.has(dependency))) continue;
      if (requiredSourceRefs.has(projected.route.target)) fail(`required formal source ${id} depends on an isolated source`);
      projectedById.delete(id); invalidIds.add(id); changed = true;
      onIssue({ area: formalSnapshotArea(projected.route.asset_kind), sourceRef: projected.route.target, code: "formal-dependency-isolated" });
    }
  }
  const registeredTargets = new Set(routes.map((route) => portablePathKey(route.target)));
  const repositoryReal = realpathSync(repository); let visited = 0;
  for (const [kind, relativeRoot] of Object.entries(roots).filter(([assetKind]) => assetKind !== "evolution")) {
    const queue = [resolve(repositoryReal, relativeRoot)];
    while (queue.length) {
      const directory = queue.shift();
      if (++visited > 4096) fail("operational formal source scan exceeds its directory bound");
      const directoryInfo = lstatSync(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) fail(`operational formal ${kind} root is unsafe`);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name); const info = lstatSync(path);
        if (info.isSymbolicLink()) fail("operational formal source scan crosses a link or reparse point");
        if (entry.isDirectory()) { queue.push(path); continue; }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || entry.name.toLowerCase() === "readme.md") continue;
        const sourceRef = relative(repositoryReal, realpathSync(path)).split(sep).join("/").normalize("NFC");
        if (registeredTargets.has(portablePathKey(sourceRef))) continue;
        if (requiredSourceRefs.has(sourceRef)) fail(`required formal source ${sourceRef} is not registered`);
        onIssue({ area: formalSnapshotArea(kind), sourceRef, code: "formal-source-unregistered" });
      }
    }
  }
  const result = { memory: [], sops: [], capabilities: [], experiences: [] };
  for (const projected of projectedById.values()) result[projected.targetKey].push(projected.item);
  return freezeFormalProjection(result);
}

function envelopeFresh(trust) {
  try {
    const contextTrust = trustedInstanceContexts.get(trust.context);
    if (!contextTrust || !instanceContextFresh(trust.context)) return false;
    const map = readPhysicalRelativeFile(trust.repository, trust.context.domainMapRef, "domain map freshness check", [".toml"], 49152);
    return map.sha256 === trust.mapDigest;
  } catch { return false; }
}

function confirmationTargetFingerprint(repository, routeId) {
  try {
    const loaded = loadTrustedDomainEnvelope(repository, { explicitRequestedId: routeId });
    const route = [...loaded.envelope.routes, ...(loaded.envelope.reviewRoutes ?? []), ...(loaded.envelope.explicitRoute ? [loaded.envelope.explicitRoute] : [])]
      .find((entry) => entry.id === routeId);
    if (!route) return null;
    const read = readPhysicalRelativeFile(repository, route.target, `confirmation target ${routeId}`, [".md"], route.asset_kind === "task-family" ? 32 * 1024 : 128 * 1024);
    return digest(Buffer.from(JSON.stringify({ instanceId: loaded.context.instanceId, route, sourceDigest: read.sha256 }), "utf8"));
  } catch { return null; }
}

function consumeCurrentMessageOnce(registry, repository, messageRef, expiresAt) {
  const now = Date.now();
  for (const [key, expiry] of registry) if (expiry < now) registry.delete(key);
  const key = `${realpathSync(repository)}:${messageRef}`;
  if (registry.has(key)) return false;
  registry.set(key, expiresAt);
  return true;
}

function trustedRoute(repository, envelope, routeId, allowedStates) {
  const trust = trustedEnvelopes.get(envelope);
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return null; }
  if (!trust || repositoryReal !== trust.repository || !stableAssetId.test(routeId ?? "") || trust.blockedRouteIds.has(routeId) || !envelopeFresh(trust)) return null;
  const route = [...envelope.routes, ...(envelope.reviewRoutes ?? []), ...(envelope.explicitRoute ? [envelope.explicitRoute] : [])]
    .find((entry) => entry.id === routeId && allowedStates.includes(entry.state));
  return route ? { route, trust } : null;
}

function readFormalAsset(repository, route, maxBytes = 128 * 1024, { operational = false } = {}) {
  resolvePhysicalAssetTarget(repository, route.target, route.asset_kind);
  const read = readPhysicalRelativeFile(repository, route.target, `asset ${route.id}`, [".md"], maxBytes);
  const parsed = parseMarkdownFrontmatterHead(read.text, route.id);
  const body = read.text.replaceAll("\r\n", "\n").slice(parsed.bodyOffset);
  if (!formalSourceHasExactSafeFrontmatter(parsed.values, { operational })
    || locateHighConfidenceSecretCandidates(body).blocked
    || containsForbiddenLocationReference(body) || !formalBodySectionsValid(parsed.values, body)) fail(`asset ${route.id} contains unknown, secret-bearing, non-portable, or section-drifted content`);
  return Object.freeze({ ...read, asset: parsed.values, body });
}

function executionBoundary(route, asset, trustedContext) {
  const declared = Object.hasOwn(asset, "confirmation") ? asset.confirmation : undefined;
  const declaredResolution = declared === undefined ? null : resolveConfirmationGate(trustedContext, declared);
  if (declared !== undefined && !declaredResolution) return { valid: false, reason: "asset-confirmation-gate-invalid" };
  if (declaredResolution?.blocked) return { valid: false, reason: "asset-confirmation-gate-needs-migration" };
  if (declaredResolution && route.confirmation !== declaredResolution.id) return { valid: false, reason: "confirmation-gate-drift" };
  if (declaredResolution && ["medium", "high"].includes(asset.risk_tier) && declaredResolution.id === "none") return { valid: false, reason: "risk-requires-confirmation-gate" };
  const requiredIds = [];
  if (["medium", "high"].includes(asset.risk_tier)) requiredIds.push("risk-dependent-before-action");
  const specificGate = declaredResolution?.id ?? route.confirmation;
  if (specificGate !== "none") requiredIds.push(specificGate);
  const uniqueIds = [...new Set(requiredIds)];
  const registry = new Map((trustedContext.confirmationGates ?? []).map((gate) => [gate.id, gate]));
  if (uniqueIds.some((id) => !registry.has(id))) return { valid: false, reason: "confirmation-gate-registry-drift" };
  const resolved = uniqueIds.map((id) => registry.get(id));
  const readGates = resolved.filter((gate) => ["before-read", "both"].includes(gate.phase));
  const actionGates = resolved.filter((gate) => ["before-action", "both"].includes(gate.phase));
  return Object.freeze({
    valid: true,
    executable: false,
    eligibility: "content-read-does-not-authorize-actions",
    readConfirmationGates: Object.freeze(readGates),
    actionConfirmationGates: Object.freeze(actionGates),
    requiredConfirmationGates: Object.freeze(resolved),
    requiresReadConfirmation: readGates.length > 0,
    requiresUserConfirmation: actionGates.length > 0,
    confirmationSource: declared === undefined ? "legacy-safe-default" : (declaredResolution.migrationRequired ? declaredResolution.source : "asset-and-route"),
    confirmationMigrationRequired: declared === undefined || declaredResolution?.migrationRequired === true,
  });
}

function makeReadConfirmationChallenge(repository, metadata, resume) {
  const issuedAtMs = Date.now();
  const challengeNonce = randomBytes(18).toString("hex");
  const targetFingerprint = confirmationTargetFingerprint(repository, metadata.id);
  if (!targetFingerprint) return Object.freeze({ decision: "deny-confirmation-target-drift", executable: false });
  const challengeDigest = digest(Buffer.from(JSON.stringify({ id: metadata.id, gateIds: metadata.readConfirmationGates.map((gate) => gate.id), targetFingerprint, challengeNonce }), "utf8"));
  const challenge = Object.freeze({
    decision: "read-confirmation-required", executable: false,
    contentRole: metadata.contentRole, authorizedActions: Object.freeze([]),
    id: metadata.id, title: metadata.title,
    readConfirmationGates: metadata.readConfirmationGates,
    actionConfirmationGates: metadata.actionConfirmationGates,
    challengeNonce, challengeDigest, issuedAt: new Date(issuedAtMs).toISOString(), expiresAt: new Date(issuedAtMs + 10 * 60_000).toISOString(),
    confirmationReceiptContract: "same-process-host-current-user-message-v2",
  });
  trustedReadChallenges.set(challenge, Object.freeze({ repository: realpathSync(repository), routeId: metadata.id,
    gateIds: metadata.readConfirmationGates.map((gate) => gate.id), targetFingerprint, challengeNonce, challengeDigest, issuedAtMs, resume }));
  return challenge;
}

export function resumeProtectedAssetRead(repository, challenge, receipt) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return { decision: "deny-untrusted-read-confirmation", executable: false }; }
  const trust = trustedReadChallenges.get(challenge);
  const keys = receipt && typeof receipt === "object" && !Array.isArray(receipt) && Object.getPrototypeOf(receipt) === Object.prototype ? Object.keys(receipt) : [];
  const exactKeys = keys.length === 7 && ["basis", "message_ref", "confirmed_at", "confirmed_asset_id", "confirmed_gate_ids", "challenge_nonce", "challenge_digest"].every((key) => keys.includes(key));
  const confirmedAt = Date.parse(receipt?.confirmed_at ?? "");
  const now = Date.now();
  const gateIds = Array.isArray(receipt?.confirmed_gate_ids) ? receipt.confirmed_gate_ids : [];
  const valid = trust && trust.repository === repositoryReal && exactKeys
    && receipt.basis === "host-current-user-message" && stableAssetId.test(receipt.message_ref ?? "")
    && receipt.confirmed_asset_id === trust.routeId && receipt.challenge_nonce === trust.challengeNonce && receipt.challenge_digest === trust.challengeDigest
    && Number.isFinite(confirmedAt) && /[zZ]|[+-]\d{2}:\d{2}$/u.test(receipt.confirmed_at)
    && confirmedAt <= now + 60_000 && confirmedAt >= trust.issuedAtMs && confirmedAt <= trust.issuedAtMs + 10 * 60_000
    && gateIds.length === trust.gateIds.length && new Set(gateIds).size === gateIds.length
    && trust.gateIds.every((id) => gateIds.includes(id))
    && confirmationTargetFingerprint(repository, trust.routeId) === trust.targetFingerprint;
  if (!valid || !consumeCurrentMessageOnce(consumedReadConfirmationMessages, repository, receipt?.message_ref ?? "", trust.issuedAtMs + 10 * 60_000)) return { decision: "deny-untrusted-read-confirmation", executable: false };
  trustedReadChallenges.delete(challenge);
  const result = trust.resume();
  return Object.freeze({ ...result, readConfirmationTrust: "host-asserted-current-user-message-not-cryptographically-verifiable" });
}

export function inspectAssetMetadata(repository, envelope, routeId) {
  const selection = trustedRoute(repository, envelope, routeId, ["active", "provisional"]);
  if (!selection || selection.route.asset_kind === "task-family") return { decision: "deny-untrusted-envelope", executable: false };
  const { route, trust } = selection;
  let path;
  try { path = resolvePhysicalAssetTarget(repository, route.target, route.asset_kind); }
  catch { return { decision: "deny-path", executable: false };
  }
  const fileBytes = statSync(path).size;
  if (fileBytes > 128 * 1024) return { decision: "deny-body-size", executable: false, fileBytes };
  let headRead;
  try { headRead = readPhysicalRelativeHead(repository, route.target, `asset ${route.id}`, [".md"], 128 * 1024); }
  catch { return { decision: "deny-frontmatter", executable: false, fileBytes };
  }
  let asset;
  try { asset = parseMarkdownFrontmatterHead(headRead.head, route.id).values; }
  catch { return { decision: "deny-frontmatter", executable: false, fileBytes }; }
  if (!formalSourceHasExactSafeFrontmatter(asset, { operational: true })) return { decision: "deny-frontmatter-contract", executable: false, fileBytes };
  if (route.id !== asset.id || route.asset_kind !== asset.kind) return { decision: "deny-identity", executable: false, fileBytes };
  // Titles and summaries describe an asset; they do not grant scope or actions.
  // Keep source text authoritative without rewriting the stored map on read.
  for (const field of projectionFields.filter((field) => field !== "summary")) {
    const fallback = listFields.has(field) ? [] : "";
    if (JSON.stringify(route[field] ?? fallback) !== JSON.stringify(asset[field] ?? fallback)) return { decision: "deny-retrieval-drift", executable: false, fileBytes, field };
  }
  if (Object.hasOwn(route, "subtype") && route.subtype !== asset.subtype) return { decision: "deny-retrieval-drift", executable: false, fileBytes, field: "subtype" };
  if (route.state !== asset.status || !["active", "provisional"].includes(asset.status) || !validAuthorization(asset)) return { decision: "frontmatter-review-only", executable: false, fileBytes };
  const routeIndex = new Map(trust.maintenanceRoutes.map((entry) => [entry.id, entry]));
  const evidenceRegistry = evidenceRegistryForAsset(repository, trust.expected, asset);
  const executionMetadata = formalExecutionMetadata(asset, routeIndex, route.id, evidenceRegistry);
  if (!executionMetadata || executionMetadata.ignoredInvalidHostExperienceRefCount > 0) return { decision: "deny-execution-metadata", executable: false, fileBytes };
  if (![1, 2, 3].includes(route.minimum_level) || ![1, 2, 3].includes(asset.minimum_level) || route.minimum_level < asset.minimum_level) return { decision: "deny-model-level", executable: false, fileBytes };
  const execution = executionBoundary(route, asset, trust.expected);
  if (!execution.valid) return { decision: "deny-confirmation-gate", executable: false, fileBytes, reason: execution.reason };
  if (!envelopeFresh(trust)) return { decision: "deny-stale-envelope", executable: false, fileBytes };
  const subtype = subtypeCompatibility(asset);
  const confirmedHabit = asset.kind === "memory" && asset.subtype === "habit"
    && asset.risk_tier === "low" && !execution.requiresReadConfirmation;
  return Object.freeze({
    decision: "metadata-verified",
    executable: false,
    id: route.id,
    kind: route.asset_kind,
    subtype: subtype.subtype,
    title: asset.title,
    summary: asset.summary,
    topicKey: route.topic_key ?? "",
    subjectKey: route.subject_key ?? "",
    triggers: Object.freeze([...(route.triggers ?? [])]),
    aliases: Object.freeze([...(route.aliases ?? [])]),
    scope: Object.freeze([...(route.scope ?? [])]),
    conditions: Object.freeze([...(route.conditions ?? [])]),
    excludes: Object.freeze([...(route.excludes ?? [])]),
    state: route.state,
    requiredLevel: Math.max(route.minimum_level, asset.minimum_level),
    selectionMode: confirmedHabit
      ? (route.state === "active" ? "automatic-confirmed-habit-if-scope-clear" : "automatic-confirmed-habit-within-confirmed-scope")
      : "confirm-fuzzy-before-body",
    metadataMigrationRequired: Object.keys(asset).some((field) => !proposedFormalFields.has(field)) || !zonedOrEmpty(asset.updated_at)
      || route.title !== asset.title || route.summary !== asset.summary
      || subtype.migrationRequired || !Object.hasOwn(route, "subtype") && ["memory", "experience"].includes(asset.kind)
      || trust.routeConfirmationMigrations.get(route.id) === true || execution.confirmationMigrationRequired || executionMetadata.metadataMigrationRequired,
    relatedAssetIds: Object.freeze([...(route.related_asset_ids ?? [])]),
    relatedLoadPolicy: "separate-validated-read-only-no-recursion",
    executionMetadata,
    ...execution,
  });
}

export function queryFormalAssetShortlist(repository, { queryText = "", intentHints = [], workSignals = [] } = {}) {
  const request = normalizeRetrievalRequest(queryText, intentHints, workSignals);
  if (!request.ok) return Object.freeze({ decision: "query-rejected", reason: request.reason, candidates: Object.freeze([]), disposition: "ask-user-to-rephrase" });
  let envelope;
  try { ({ envelope } = loadOperationalDomainEnvelope(repository)); }
  catch { return Object.freeze({ decision: "route-map-unavailable", candidates: Object.freeze([]), disposition: "maintenance-required" }); }
  if (!envelope.ordinaryMatchingAllowed) return Object.freeze({ decision: "route-map-rebuild-required", candidates: Object.freeze([]), disposition: "maintenance-required" });
  const ranked = rankRetrievalEntries(envelope.routes, request, {
    limit: Math.max(1, Math.min(envelope.routes.length, 128)),
    lifecyclePriority: (entry) => entry.asset_kind === "task-family" ? 10 : entry.state === "active" ? 30 : 20,
  });
  const candidates = [];
  let rejectedMetadataCount = 0;
  for (const { entry, evidence } of ranked) {
    if (candidates.length >= 3) break;
    if (entry.asset_kind === "task-family") {
      candidates.push(Object.freeze({
        id: entry.id, kind: "task-family", subtype: "", title: entry.title, summary: entry.summary,
        state: entry.state, requiredLevel: entry.minimum_level, recommendedLevel: entry.minimum_level,
        selectionMode: "load-after-unique-match-or-explicit-choice", executable: false,
        retrievalEvidence: Object.freeze({ directUserMatch: evidence.directUserMatch, workSignalMatch: evidence.workSignalMatch,
          hintOnlyMatch: evidence.hintOnlyMatch, automaticEvidenceSource: evidence.automaticEvidenceSource }),
      }));
      continue;
    }
    const metadata = inspectAssetMetadata(repository, envelope, entry.id);
    if (metadata.decision === "metadata-verified") {
      const selectionMode = metadata.selectionMode.startsWith("automatic-confirmed-habit")
        ? evidence.reuseStopOrCorrectionRequested || evidence.workContextExcluded
          ? "do-not-apply-in-current-context"
          : evidence.automaticScopeEvidence ? metadata.selectionMode
            : evidence.directUserMatch || evidence.workSignalMatch ? "assess-confirmed-habit-scope" : "confirm-fuzzy-before-body"
        : metadata.selectionMode;
      candidates.push(Object.freeze({ ...metadata, selectionMode, retrievalEvidence: Object.freeze({
        triggerMatchStrong: evidence.triggerScore >= 0.72,
        workTriggerMatchStrong: evidence.workTriggerScore >= 0.72,
        scopeOrObjectMatch: evidence.scopeScore >= 0.45,
        workScopeOrObjectMatch: evidence.workScopeScore >= 0.45,
        automaticScopeEvidence: evidence.automaticScopeEvidence,
        automaticEvidenceSource: evidence.automaticEvidenceSource,
        automaticBlockedReason: evidence.automaticBlockedReason,
        directUserMatch: evidence.directUserMatch,
        workSignalMatch: evidence.workSignalMatch,
        hintOnlyMatch: evidence.hintOnlyMatch,
      }) }));
    } else rejectedMetadataCount += 1;
  }
  const frozen = Object.freeze(candidates.slice(0, 3));
  const disposition = frozen.length === 0 ? "no-trusted-match"
    : frozen.length > 1 ? "offer-small-choice" : "load-unique-match";
  const result = Object.freeze({ decision: frozen.length ? "shortlist-ready" : "no-match", candidates: frozen, disposition,
    rejectedMetadataCount, isolatedRouteCount: envelope.isolatedRouteCount ?? 0,
    integrityState: rejectedMetadataCount === 0 && (envelope.isolatedRouteCount ?? 0) === 0 ? "verified" : "degraded-valid-matches-only",
    intentHintCount: request.hints.length, workSignalCount: request.workSignals.length });
  trustedFormalShortlists.set(result, Object.freeze({ repository: realpathSync(repository), envelope, allowedIds: new Set(frozen.map((entry) => entry.id)) }));
  return result;
}

export function inspectShortlistedFormalAsset(repository, shortlist, routeId) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return { decision: "deny-untrusted-shortlist", executable: false }; }
  const trust = trustedFormalShortlists.get(shortlist);
  const selected = shortlist?.candidates?.find((entry) => entry.id === routeId);
  if (!trust || trust.repository !== repositoryReal || !trust.allowedIds.has(routeId) || !selected || !envelopeFresh(trustedEnvelopes.get(trust.envelope))) {
    return { decision: "deny-untrusted-shortlist", executable: false };
  }
  // The shortlist is bounded to three items. A unique match or the caller's
  // explicit selected ID is enough to re-run the bounded query and load it;
  // ordinary recall does not mint expiring, same-process confirmation tickets.
  const inspected = selected.kind === "task-family"
    ? inspectTaskFamilyRoute(repository, trust.envelope, routeId, { selectionConfirmed: true })
    : inspectAssetRoute(repository, trust.envelope, routeId, { selectionConfirmed: true });
  return Object.freeze({ ...inspected,
    selectedBy: shortlist.candidates.length === 1 ? "unique-match" : "explicit-choice",
    recallUse: projectRecallUse(selected, ["load-bounded-body", "bounded-section-only", "load-bounded-task-family"].includes(inspected.decision)
      ? "asset-body-loaded" : "candidate-found-not-used") });
}

function inspectAssetRouteInternal(repository, envelope, routeId, { requestedSelector = undefined } = {}, readConfirmationSatisfied = false) {
  const selection = trustedRoute(repository, envelope, routeId, ["active", "provisional"]);
  if (!selection) return { decision: "deny-untrusted-envelope", executable: false };
  const { route, trust } = selection;
  if (!clean(route.title, 80, false) || !clean(route.summary, 240, false) || !cleanList(route.triggers, 8, 80) || route.triggers.length === 0
    || !cleanList(route.aliases ?? [], 8, 80) || !clean(route.topic_key ?? "", 120) || !clean(route.subject_key ?? "", 120)
    || !cleanList(route.scope ?? [], 8, 120) || !cleanList(route.conditions ?? [], 6, 120) || !cleanList(route.excludes ?? [], 6, 120)
    || !cleanList(route.related_asset_ids ?? [], 8, 160) || !cleanList(route.body_sections ?? [], 8, 80)
    || !stableAssetId.test(route.confirmation ?? "")) fail(`route ${route.id ?? "<unknown>"} has unsafe retrieval metadata`);
  if (!stableAssetId.test(route.id ?? "") || ![1, 2, 3].includes(route.minimum_level) || Buffer.byteLength(JSON.stringify(route), "utf8") > 2048) fail(`route ${route.id ?? "<unknown>"} has invalid identity, level, or size`);
  if (new Set(route.related_asset_ids ?? []).size !== (route.related_asset_ids ?? []).length || (route.related_asset_ids ?? []).some((id) => !stableAssetId.test(id) || id === route.id)) fail(`route ${route.id} has invalid related IDs`);

  const metadataPreflight = inspectAssetMetadata(repository, envelope, routeId);
  if (metadataPreflight.decision !== "metadata-verified") return metadataPreflight;
  if (metadataPreflight.requiresReadConfirmation && !readConfirmationSatisfied) return makeReadConfirmationChallenge(repository, {
    contentRole: "protected-context-metadata-only", id: metadataPreflight.id, title: metadataPreflight.title,
    readConfirmationGates: metadataPreflight.readConfirmationGates, actionConfirmationGates: metadataPreflight.actionConfirmationGates,
  }, () => inspectAssetRouteInternal(repository, envelope, routeId, { requestedSelector }, true));

  const path = resolvePhysicalAssetTarget(repository, route.target, route.asset_kind);
  const fileBytes = statSync(path).size;
  if (fileBytes > 128 * 1024) return { decision: "deny-body-size", executable: false, fileBytes };
  let read;
  try { read = readFormalAsset(repository, route, 128 * 1024, { operational: true }); } catch { return { decision: "deny-read-race-or-frontmatter", executable: false, fileBytes }; }
  const asset = read.asset;
  if (route.id !== asset.id || route.asset_kind !== asset.kind) return { decision: "deny-identity", executable: false, fileBytes };
  for (const field of projectionFields.filter((field) => field !== "summary")) {
    const fallback = listFields.has(field) ? [] : "";
    if (JSON.stringify(route[field] ?? fallback) !== JSON.stringify(asset[field] ?? fallback)) return { decision: "deny-retrieval-drift", executable: false, fileBytes, field };
  }
  if (Object.hasOwn(route, "subtype") && route.subtype !== asset.subtype) return { decision: "deny-retrieval-drift", executable: false, fileBytes, field: "subtype" };
  if (route.state !== asset.status || !["active", "provisional"].includes(asset.status) || !validAuthorization(asset)) return { decision: "frontmatter-review-only", executable: false, fileBytes };
  const routeIndex = new Map(trust.maintenanceRoutes.map((entry) => [entry.id, entry]));
  const evidenceRegistry = evidenceRegistryForAsset(repository, trust.expected, asset);
  const executionMetadata = formalExecutionMetadata(asset, routeIndex, route.id, evidenceRegistry);
  if (!executionMetadata || executionMetadata.ignoredInvalidHostExperienceRefCount > 0) return { decision: "deny-execution-metadata", executable: false, fileBytes };
  if (![1, 2, 3].includes(asset.minimum_level) || route.minimum_level < asset.minimum_level) return { decision: "deny-model-level-metadata", executable: false, fileBytes };
  const execution = executionBoundary(route, asset, trust.expected);
  if (!execution.valid) return { decision: "deny-confirmation-gate", executable: false, fileBytes, reason: execution.reason };
  const subtype = subtypeCompatibility(asset);
  if (!envelopeFresh(trust)) return { decision: "deny-stale-envelope", executable: false, fileBytes };
  const body = read.body;
  const metadataMigrationRequired = metadataPreflight.metadataMigrationRequired || subtype.migrationRequired
    || trust.routeConfirmationMigrations.get(route.id) === true || execution.confirmationMigrationRequired || executionMetadata.metadataMigrationRequired;
  const relatedAssetIds = Object.freeze([...(route.related_asset_ids ?? [])]);
  if (fileBytes <= 32 * 1024) {
    const secrets = locateHighConfidenceSecretCandidates(body);
    if (secrets.blocked) return { decision: "deny-secret-candidate", executable: false, fileBytes, secretFindingCount: secrets.count, secretFindingCategories: Object.freeze([...new Set(secrets.findings.map((finding) => finding.category))]) };
    return { decision: "load-bounded-body", executable: false, contentRole: "formal-asset-reference-only", authorizedActions: Object.freeze([]), fileBytes, body, subtype: subtype.subtype, metadataMigrationRequired, relatedAssetIds, relatedLoadPolicy: "separate-validated-read-only-no-recursion", executionMetadata, ...execution };
  }
  const sections = route.body_sections ?? [];
  if (sections.length === 0 || JSON.stringify(sections) !== JSON.stringify(asset.body_sections ?? [])) return { decision: "split-required", executable: false, fileBytes };
  const selected = extractRegisteredSection(body, sections, requestedSelector);
  if (!selected.ok) return { decision: "split-required", executable: false, fileBytes, reason: selected.reason };
  const sectionSecrets = locateHighConfidenceSecretCandidates(selected.selected);
  return sectionSecrets.blocked
    ? { decision: "deny-secret-candidate", executable: false, fileBytes, secretFindingCount: sectionSecrets.count, secretFindingCategories: Object.freeze([...new Set(sectionSecrets.findings.map((finding) => finding.category))]) }
    : { decision: "bounded-section-only", executable: false, contentRole: "formal-asset-reference-only", authorizedActions: Object.freeze([]), fileBytes, body: selected.selected, sectionBytes: selected.bytes, subtype: subtype.subtype, metadataMigrationRequired, relatedAssetIds, relatedLoadPolicy: "separate-validated-read-only-no-recursion", executionMetadata, ...execution };
}

export function inspectAssetRoute(repository, envelope, routeId, options = {}) {
  return inspectAssetRouteInternal(repository, envelope, routeId, options, options.selectionConfirmed === true);
}

function inspectAssetForReviewInternal(repository, envelope, routeId, { explicitRequestedId, requestedSelector = undefined } = {}, readConfirmationSatisfied = false) {
  if (explicitRequestedId !== routeId || !stableAssetId.test(explicitRequestedId ?? "")) return { decision: "deny-explicit-review-id", executable: false };
  const selection = trustedRoute(repository, envelope, routeId, ["review", "paused", "history", "archived"]);
  if (!selection) return { decision: "deny-untrusted-envelope", executable: false };
  const { route, trust } = selection;
  if (!clean(route.title, 80, false) || !clean(route.summary, 240, false) || !cleanList(route.triggers, 8, 80) || route.triggers.length === 0
    || !cleanList(route.aliases ?? [], 8, 80) || !clean(route.topic_key ?? "", 120) || !clean(route.subject_key ?? "", 120)
    || !cleanList(route.scope ?? [], 8, 120) || !cleanList(route.conditions ?? [], 6, 120) || !cleanList(route.excludes ?? [], 6, 120)
    || !cleanList(route.related_asset_ids ?? [], 8, 160) || !cleanList(route.body_sections ?? [], 8, 80)
    || !stableAssetId.test(route.confirmation ?? "") || Buffer.byteLength(JSON.stringify(route), "utf8") > 2048) return { decision: "deny-route", executable: false };
  if (!["review", "paused", "history", "archived"].includes(route.state)) return { decision: "deny-not-review-state", executable: false };
  let path;
  try { path = resolvePhysicalAssetTarget(repository, route.target, route.asset_kind); }
  catch { return { decision: "deny-path", executable: false }; }
  const fileBytes = statSync(path).size;
  if (fileBytes > 128 * 1024) return { decision: "deny-body-size", executable: false, fileBytes };
  let reviewHead;
  try { reviewHead = parseMarkdownFrontmatterHead(readPhysicalRelativeHead(repository, route.target, `review asset ${route.id}`, [".md"], 128 * 1024).head, route.id).values; }
  catch { return { decision: "deny-frontmatter", executable: false, fileBytes }; }
  if (!formalSourceHasExactSafeFrontmatter(reviewHead)) return { decision: "deny-frontmatter-contract", executable: false, fileBytes };
  if (route.id !== reviewHead.id || route.asset_kind !== reviewHead.kind || route.title !== reviewHead.title || route.state !== reviewHead.status) return { decision: "deny-identity", executable: false, fileBytes };
  for (const field of projectionFields) {
    const fallback = listFields.has(field) ? [] : "";
    if (JSON.stringify(route[field] ?? fallback) !== JSON.stringify(reviewHead[field] ?? fallback)) return { decision: "deny-retrieval-drift", executable: false, fileBytes, field };
  }
  const reviewExecution = executionBoundary(route, reviewHead, trust.expected);
  if (!reviewExecution.valid) return { decision: "deny-confirmation-gate", executable: false, fileBytes, reason: reviewExecution.reason };
  if (reviewExecution.requiresReadConfirmation && !readConfirmationSatisfied) return makeReadConfirmationChallenge(repository, {
    contentRole: "protected-review-metadata-only", id: route.id, title: route.title,
    readConfirmationGates: reviewExecution.readConfirmationGates, actionConfirmationGates: reviewExecution.actionConfirmationGates,
  }, () => inspectAssetForReviewInternal(repository, envelope, routeId, { explicitRequestedId, requestedSelector }, true));
  let read;
  try { read = readFormalAsset(repository, route); }
  catch { return { decision: "deny-frontmatter", executable: false, fileBytes }; }
  const asset = read.asset;
  if (route.id !== asset.id || route.asset_kind !== asset.kind || route.title !== asset.title || route.state !== asset.status) return { decision: "deny-identity", executable: false, fileBytes };
  for (const field of projectionFields) {
    const fallback = listFields.has(field) ? [] : "";
    if (JSON.stringify(route[field] ?? fallback) !== JSON.stringify(asset[field] ?? fallback)) return { decision: "deny-retrieval-drift", executable: false, fileBytes, field };
  }
  if (Object.hasOwn(route, "subtype") && route.subtype !== asset.subtype) return { decision: "deny-retrieval-drift", executable: false, fileBytes, field: "subtype" };
  if (![1, 2, 3].includes(route.minimum_level) || ![1, 2, 3].includes(asset.minimum_level)
    || route.minimum_level < asset.minimum_level) return { decision: "deny-model-level-metadata", executable: false, fileBytes };
  const recommendedLevel = Math.max(route.minimum_level, asset.minimum_level);
  if (!envelopeFresh(trust)) return { decision: "deny-stale-envelope", executable: false, fileBytes };
  const routeIndex = new Map(trust.maintenanceRoutes.map((entry) => [entry.id, entry]));
  const evidenceRegistry = evidenceRegistryForAsset(repository, trust.expected, asset);
  const executionMetadata = formalExecutionMetadata(asset, routeIndex, route.id, evidenceRegistry);
  if (!executionMetadata || executionMetadata.ignoredInvalidHostExperienceRefCount > 0) return { decision: "deny-execution-metadata", executable: false, fileBytes };
  const body = read.body;
  if (fileBytes <= 32 * 1024) {
    const secrets = locateHighConfidenceSecretCandidates(body);
    return secrets.blocked
      ? { decision: "deny-secret-candidate", executable: false, fileBytes, secretFindingCount: secrets.count, secretFindingCategories: Object.freeze([...new Set(secrets.findings.map((finding) => finding.category))]) }
      : { decision: "review-evidence-only", executable: false, contentRole: "formal-review-evidence-only", authorizedActions: Object.freeze([]), fileBytes, body, recommendedLevel, executionMetadata, ...reviewExecution };
  }
  const sections = route.body_sections ?? [];
  if (sections.length === 0 || JSON.stringify(sections) !== JSON.stringify(asset.body_sections ?? [])) return { decision: "split-required", executable: false, fileBytes };
  const selected = extractRegisteredSection(body, sections, requestedSelector);
  if (!selected.ok) return { decision: "split-required", executable: false, fileBytes, reason: selected.reason };
  const reviewSecrets = locateHighConfidenceSecretCandidates(selected.selected);
  return reviewSecrets.blocked
    ? { decision: "deny-secret-candidate", executable: false, fileBytes, secretFindingCount: reviewSecrets.count, secretFindingCategories: Object.freeze([...new Set(reviewSecrets.findings.map((finding) => finding.category))]) }
    : { decision: "review-evidence-only", executable: false, contentRole: "formal-review-evidence-only", authorizedActions: Object.freeze([]), fileBytes, body: selected.selected, sectionBytes: selected.bytes, recommendedLevel, executionMetadata, ...reviewExecution };
}

export function inspectAssetForReview(repository, envelope, routeId, options = {}) {
  return inspectAssetForReviewInternal(repository, envelope, routeId, options, false);
}

function inspectTaskFamilyRouteInternal(repository, envelope, routeId, options = {}, readConfirmationSatisfied = false) {
  const selection = trustedRoute(repository, envelope, routeId, ["on-demand"]);
  if (!selection || selection.route.asset_kind !== "task-family") return { decision: "deny-untrusted-envelope", executable: false };
  const { route, trust } = selection;
  if (![1, 2, 3].includes(route.minimum_level)) return { decision: "deny-model-level-metadata", executable: false };
  const gate = route.confirmation === "none" ? [] : (trust.expected.confirmationGates ?? []).filter((entry) => entry.id === route.confirmation);
  const readGates = gate.filter((entry) => ["before-read", "both"].includes(entry.phase));
  const actionGates = gate.filter((entry) => ["before-action", "both"].includes(entry.phase));
  if (readGates.length && !readConfirmationSatisfied) return makeReadConfirmationChallenge(repository, {
    contentRole: "protected-navigation-metadata-only", id: route.id, title: route.title,
    readConfirmationGates: Object.freeze(readGates), actionConfirmationGates: Object.freeze(actionGates),
  }, () => inspectTaskFamilyRouteInternal(repository, envelope, routeId, options, true));
  resolveTaskFamilyTarget(repository, route, trust.expected);
  let read;
  try { read = readPhysicalRelativeFile(repository, route.target, `task-family ${route.id}`, [".md"], 32 * 1024); }
  catch { return { decision: "deny-read-race", executable: false }; }
  if (!envelopeFresh(trust)) return { decision: "deny-stale-envelope", executable: false };
  const taskSecrets = locateHighConfidenceSecretCandidates(read.text);
  if (taskSecrets.blocked) return { decision: "deny-secret-candidate", executable: false, fileBytes: read.fileBytes, secretFindingCount: taskSecrets.count, secretFindingCategories: Object.freeze([...new Set(taskSecrets.findings.map((finding) => finding.category))]) };
  return {
    decision: "load-bounded-task-family",
    executable: false,
    contentRole: "task-family-navigation-context-only",
    authorizedActions: Object.freeze([]),
    eligibility: "content-read-does-not-authorize-actions",
    requiredConfirmationGates: Object.freeze(gate),
    readConfirmationGates: Object.freeze(readGates),
    actionConfirmationGates: Object.freeze(actionGates),
    requiresReadConfirmation: false,
    requiresUserConfirmation: actionGates.length > 0,
    fileBytes: read.fileBytes,
    body: read.text,
  };
}

export function inspectTaskFamilyRoute(repository, envelope, routeId, options = {}) {
  return inspectTaskFamilyRouteInternal(repository, envelope, routeId, options, options.selectionConfirmed === true);
}
