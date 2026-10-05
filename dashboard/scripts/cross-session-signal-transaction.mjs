import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  opendirSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArrayTableDocument, parseMarkdownFrontmatterHead, parseSectionedToml, stableAssetId, validateInstanceManifestStructure } from "./asset-route-contract.mjs";
import { validateCandidateIndex as validateCandidateIndexClosure, validateCandidateRevisionTransition } from "./candidate-index-contract.mjs";
import { containsForbiddenLocationReference, containsForbiddenStructuredLocation } from "./safe-output-boundary.mjs";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";
import { buildSnapshotCandidate, computeSnapshotSourceDigest } from "./snapshot-source-builder.mjs";
import { withInstanceWriteLock } from "./instance-write-lock.mjs";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const SIGNAL_MAP_BUDGET_BYTES = 1536;
const CANDIDATE_INDEX_BUDGET_BYTES = 32768;
const TIME_MAP_MAX_BYTES = 32768;
const CONTROL_MAX_BYTES = 4096;
const SIGNAL_SOURCE_MAX_BYTES = 32768;
const CANDIDATE_SOURCE_MAX_BYTES = 32768;
const DASHBOARD_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
const PERSISTENT_RECORD_MAX_BYTES = 256 * 1024;
const PERSISTENT_STORE_MAX_OPERATIONS = 256;
const PERSISTENT_BUNDLE_MAX_FILES = 64;
const PERSISTENT_BUNDLE_MAX_BYTES = 40 * 1024 * 1024;
const PERSISTENT_TRANSACTION_TTL_MS = 7 * 24 * 60 * 60_000;
const PERSISTENT_LOCK_STALE_MS = 10 * 60_000;
const SNAPSHOT_PROJECTION_PREFIX = ".ai-carry-cross-session-snapshot-";
const SNAPSHOT_PROJECTION_MARKER = ".ai-carry-cross-session-owner.json";
const SNAPSHOT_PROJECTION_PARENT_ENTRY_LIMIT = 4096;
const SNAPSHOT_PROJECTION_DIRECTORY_LIMIT = 4096;
const SNAPSHOT_PROJECTION_FILE_LIMIT = 16384;

const CONTROL_REF = "instance/signals/control.toml";
const SIGNAL_MAP_REF = "instance/maps/signal-map.toml";
const TIME_MAP_REF = "instance/maps/time-trigger-map.toml";
const CANDIDATE_INDEX_REF = "instance/evolution/index.toml";
const MANIFEST_REF = "instance/manifest.toml";
const PUBLIC_SNAPSHOT_REF = "dashboard/public/snapshot.js";
const DIST_SNAPSHOT_REF = "dashboard/dist/snapshot.js";
const PERSISTENT_TRANSACTION_DIR = ".assistant-local/runtime/cross-session-signals";

const controlFields = new Set([
  "schema_version", "record_type", "instance_id", "source_revision", "projection_revision", "update_state",
  "pending_operation_id", "pending_event_id", "pending_signal_id", "pending_trigger_id", "pending_source_ref",
  "base_revision", "updated_at",
]);
const signalRootFields = new Set([
  "schema_version", "record_type", "id", "signal_type", "evaluation_family", "status", "title", "reason",
  "domain", "route_id", "revision", "created_at", "updated_at", "last_verified_at", "asset_refs",
  "candidate_source_revision", "related_signal_ids", "minimum_level", "confirmation", "provenance", "trust_state",
]);
const signalMatchFields = new Set(["asset_kind", "subject", "claim", "scope", "conditions", "aliases"]);
const signalTriggerFields = new Set(["mode", "independent_event_count", "threshold_value", "progress_summary", "next_event", "next_check_at"]);
const evidenceFields = new Set(["event_id", "event_source", "task_id", "context_id", "occurred_at", "source_kind", "source_ref", "independent", "relation", "summary"]);
const signalMapRootFields = new Set([
  "schema_version", "map_id", "instance_id", "state", "source_revision", "generated_at", "budget_bytes", "overflow",
  "active_count", "scheduled_count", "next_wakeup_at", "next_wakeup_ref",
]);
const signalProjectionFields = new Set([
  "id", "signal_type", "status", "reason", "progress", "next_event", "domain", "route_id", "source_ref",
  "source_signal_revision", "provenance", "trust_state", "minimum_level", "confirmation",
]);
const timeMapRootFields = new Set([
  "schema_version", "map_id", "instance_id", "state", "source_revision", "generated_at", "scheduled_count", "next_wakeup_at",
]);
const timeTriggerFields = new Set([
  "id", "kind", "status", "title", "next_check_at", "effective_check_at", "domain", "route_id", "source_ref",
  "source_trigger_revision", "minimum_level", "confirmation",
]);
const candidateIndexRootFields = new Set([
  "schema_version", "index_id", "instance_id", "state", "source_revision", "generated_at", "budget_bytes", "overflow",
  "candidate_count", "indexed_count", "active_count",
]);
const candidateSourceFields = new Set([
  "id", "kind", "status", "title", "summary", "triggers", "scope", "excludes", "lifecycle", "expected_next_use",
  "topic_key", "subject_key", "aliases", "conditions", "target_kind", "target_subtype", "candidate_relation",
  "observation_state", "observation_basis", "observation_event_ref", "claim_summary", "proposed_risk_tier",
  "independent_event_count", "successful_event_count", "failed_event_count", "distinct_context_count",
  "representative_event_ids", "last_evidence_at", "remind_at", "snoozed_until", "trigger_revision", "source_revision",
  "source_refs", "private_refs", "supersedes", "minimum_level", "approval_state", "activation_basis", "risk_tier",
  "approved_by_user", "updated_at", "resolution", "resolved_to",
]);
const candidateEntryProjection = Object.freeze({
  id: "id", title: "title", summary: "summary", topic_key: "topic_key", subject_key: "subject_key", triggers: "triggers",
  aliases: "aliases", scope: "scope", conditions: "conditions", excludes: "excludes", target_kind: "target_kind",
  target_subtype: "target_subtype", candidate_relation: "candidate_relation", status: "status",
  observation_state: "observation_state", observation_basis: "observation_basis", independent_event_count: "independent_event_count",
  last_evidence_at: "last_evidence_at", source_revision: "source_revision",
});
const candidateIndexRootOrder = Object.freeze([
  "schema_version", "index_id", "instance_id", "state", "source_revision", "generated_at", "budget_bytes", "overflow",
  "candidate_count", "indexed_count", "active_count",
]);
const controlRootOrder = Object.freeze([
  "schema_version", "record_type", "instance_id", "source_revision", "projection_revision", "update_state",
  "pending_operation_id", "pending_event_id", "pending_signal_id", "pending_trigger_id", "pending_source_ref",
  "base_revision", "updated_at",
]);
const candidateIndexEntryOrder = Object.freeze([
  "id", "title", "summary", "topic_key", "subject_key", "triggers", "aliases", "scope", "conditions", "excludes",
  "target_kind", "target_subtype", "candidate_relation", "status", "observation_state", "observation_basis", "risk_tier",
  "independent_event_count", "last_evidence_at", "source_ref", "source_revision",
]);
const signalMapRootOrder = Object.freeze([
  "schema_version", "map_id", "instance_id", "state", "source_revision", "generated_at", "budget_bytes", "overflow",
  "active_count", "scheduled_count", "next_wakeup_at", "next_wakeup_ref",
]);
const signalProjectionOrder = Object.freeze([
  "id", "signal_type", "status", "reason", "progress", "next_event", "domain", "route_id", "source_ref",
  "source_signal_revision", "provenance", "trust_state", "minimum_level", "confirmation",
]);
const timeMapRootOrder = Object.freeze([
  "schema_version", "map_id", "instance_id", "state", "source_revision", "generated_at", "scheduled_count", "next_wakeup_at",
]);
const timeTriggerOrder = Object.freeze([
  "id", "kind", "status", "title", "next_check_at", "effective_check_at", "domain", "route_id", "source_ref",
  "source_trigger_revision", "minimum_level", "confirmation",
]);
const candidateMutableEvidenceFields = new Set([
  "independent_event_count", "successful_event_count", "failed_event_count", "distinct_context_count",
  "representative_event_ids", "last_evidence_at", "source_revision", "updated_at",
]);
const activeCandidateRelations = new Set(["new", "refine", "condition-variant", "related"]);
const visibleSignalStates = new Set(["near-trigger", "pending-review", "conflict", "uncertain", "stale"]);
const accumulatingSignalStates = new Set(["observing", "near-trigger"]);
const allSignalStates = new Set(["observing", "near-trigger", "pending-review", "conflict", "uncertain", "stale", "resolved", "rejected", "archived"]);
const eventRelations = new Set(["supporting", "contradicting", "neutral", "superseding"]);
const eventSourceKinds = new Set([
  "current-user", "ai-carry-asset", "connected-host-observation", "host-collaborative-memory",
  "model-inference", "external-content", "unknown",
]);
// Schema 1.1 and HOST_INTEGRATION own the canonical vocabulary. These aliases
// are accepted only while reading an already-persisted signal/projection and
// are immediately normalized in memory. Receipt producers and proposed bytes
// never accept or emit them.
const legacyEventSourceAliases = new Map([
  ["connected-host-task", "connected-host-observation"],
  ["host-collaboration-memory", "host-collaborative-memory"],
]);
const legacyProvenanceAliases = new Map([
  ...legacyEventSourceAliases,
  ["host-asserted-connected-host-task", "host-asserted-connected-host-observation"],
  ["host-asserted-host-collaboration-memory", "host-asserted-host-collaborative-memory"],
]);
const independentlyCountableObservationSources = new Set(["current-user", "connected-host-observation"]);
const planPhases = Object.freeze([
  "control-pending", "candidate-source", "candidate-index", "learning-signal-source",
  "time-projection", "startup-signal-projection", "dashboard-public-snapshot",
  "dashboard-dist-snapshot", "control-clean",
]);
const planRootFields = new Set([
  "schemaVersion", "planType", "decision", "executable", "authorization", "contentIncluded", "completeness",
  "operationId", "instanceId", "transactionAt", "eventKey", "candidateId", "candidateSourceRef", "signalId",
  "signalSourceRef", "baseRevision", "nextRevision", "preimages", "steps", "finalDigests", "rollback",
  "requiredChecks", "recoveryEvidence", "failClosedAssumptions", "readSet", "truthDigests", "expiresAt", "planDigest",
]);
const planArtifactFields = new Set(["target", "digest", "byteLength"]);
const planStepFields = new Set(["ordinal", "phase", "target", "preconditionDigest", "proposedDigest", "proposedByteLength"]);
const planFinalFields = new Set(["target", "digest"]);
const planRollbackFields = new Set(["target", "restoreDigest"]);
const requiredPlanChecks = Object.freeze([
  "persist-sealed-plan-and-all-exact-bytes-before-first-product-write", "stage-all-proposed-bytes",
  "reverify-every-precondition-and-merged-truth-digest", "read-back-all-final-digests",
  "rebuild-byte-identical-dashboard-pair-from-merged-truth", "rollback-whole-write-set-on-failure",
  "second-run-event-deduplication",
]);
const hostTaskObservationFields = new Set([
  "candidateId", "signalId", "signalSourceRef", "taskBasis", "taskBasisStable", "contextBasis",
  "observationBasis", "occurredAt", "sourceKind",
]);
const eventReceiptFields = new Set([
  "basis", "message_ref", "message_digest", "confirmed_at", "relation", "summary", "challenge_nonce",
]);
const trustedHostTaskObservations = new WeakMap();
const consumedHostTaskObservations = new WeakSet();
const trustedEventChallenges = new WeakMap();
const trustedEventReceipts = new WeakMap();
const consumedEventReceipts = new WeakSet();
const consumedEventEvidenceRefs = new Map();
const trustedTransactionPayloads = new WeakMap();
const operationalDerivedStateReports = new WeakMap();

export const CROSS_SESSION_SIGNAL_FAIL_CLOSED_ASSUMPTIONS = Object.freeze([
  "A pending control record does not contain the complete write set or byte digests; recovery therefore requires the original digest-bound plan.",
  "Compressed learning evidence without a complete source-plus-event identity ledger is review-only because safe replay deduplication cannot be proved.",
  "The time projection has no schema-level byte ceiling; this validator uses a conservative 32768-byte maintenance envelope and rejects larger unsharded maps.",
  "candidate_source_revision is mandatory for learning signal cards even though the blank 1.0 signal template omits it; the 1.1 schema is treated as authoritative.",
  "Host-attested distinct-task observations and semantic context observations are counted separately: a new host task observation in an existing context may advance review priority without inventing another context.",
  "Task, context, event and evidence identities come from one same-process opaque host observation receipt; the current-user confirmation cannot supply raw IDs.",
  "A host observation without a stable reusable task basis is stored as non-independent and cannot advance the task count.",
  "Host-attested distinct-task observations are review-priority hints only; they never increase validated success or failure counters, maturity, authorization or formal promotion eligibility.",
  "The private runtime bundle is local crash-recovery material only; it is excluded from startup, public projection, migration, import/export and release selection.",
  "Expiry never authorizes deletion of a legal prefix or drifted state; only exact preimage or exact final state is safe for close or TTL cleanup.",
]);

function fail(message) { throw new Error(`Cross-session signal transaction failed: ${message}`); }
function deny(reason, details = {}) { return deepFreeze({ decision: "transaction-denied", reason, executable: false, ...details }); }
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalEventSource(value, { allowLegacy = false } = {}) {
  if (eventSourceKinds.has(value)) return value;
  return allowLegacy ? legacyEventSourceAliases.get(value) ?? null : null;
}

function canonicalProvenance(value, { allowLegacy = false } = {}) {
  if (!legacyProvenanceAliases.has(value)) return value;
  return allowLegacy ? legacyProvenanceAliases.get(value) : null;
}
function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function same(left, right) { return canonical(left) === canonical(right); }
function exactKeys(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.size && Object.keys(value).every((key) => fields.has(key));
}
function clean(value, max, allowEmpty = true) {
  return typeof value === "string" && (allowEmpty || value.length > 0) && [...value].length <= max
    && value.normalize("NFC") === value && !unsafeText.test(value);
}
function cleanList(value, maxItems, maxChars) {
  return Array.isArray(value) && value.length <= maxItems && new Set(value).size === value.length
    && value.every((item) => clean(item, maxChars, false));
}
function stableList(value, maxItems) {
  return Array.isArray(value) && value.length <= maxItems && new Set(value).size === value.length
    && value.every((item) => stableAssetId.test(item));
}
function safeInteger(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function strictZonedDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value ?? "");
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return false;
  if (match[7] !== "Z") {
    const offsetHour = Number(match[9]); const offsetMinute = Number(match[10]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}
function laterTimestamp(left, right) {
  if (!left) return right;
  const leftTime = Date.parse(left); const rightTime = Date.parse(right);
  if (rightTime > leftTime) return right;
  if (rightTime < leftTime) return left;
  return [left, right].sort()[0];
}
function decode(buffer, label) {
  try { return utf8Decoder.decode(buffer); }
  catch { fail(`${label} is not valid UTF-8`); }
}
function portableSegment(part) {
  const base = part.replace(/\..*$/u, "").toLowerCase();
  return part && part !== "." && part !== ".." && !/[. ]$/u.test(part) && !/[<>"|*]/u.test(part)
    && !["con", "prn", "aux", "nul", "clock$"].includes(base) && !/^(?:com|lpt)[1-9]$/u.test(base);
}
function normalizedRelativeRef(ref, { prefix, extension }) {
  return clean(ref, 240, false) && ref.startsWith(prefix) && ref.endsWith(extension) && !ref.includes("\\")
    && !ref.includes(":") && !ref.includes("?") && !ref.includes("#") && ref.split("/").every(portableSegment);
}
function normalizedInstanceMarkdownRef(ref) {
  return clean(ref, 240, false) && ref.startsWith("instance/") && ref.endsWith(".md") && !ref.includes("\\")
    && !ref.includes(":") && !ref.includes("?") && !ref.includes("#") && ref.split("/").every(portableSegment);
}
function validPrivateReference(ref) {
  if (!clean(ref, 240, false) || locateHighConfidenceSecretCandidates(ref).blocked) return false;
  const match = /^private:\/\/([a-z0-9][a-z0-9._:-]{0,159})\/(.+)$/u.exec(ref);
  const suffix = match ? match[2] : ref.startsWith(".assistant-private/assets/") ? ref.slice(".assistant-private/assets/".length) : "";
  return suffix.length > 0 && !suffix.includes("\\") && !suffix.includes(":") && !suffix.includes("?") && !suffix.includes("#")
    && suffix.split("/").every(portableSegment);
}
function ensureInside(repositoryReal, target) {
  const fromRoot = relative(repositoryReal, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || resolve(repositoryReal, fromRoot) !== target) fail("path escapes AI Carry");
}
function resolveCheckedPath(repositoryReal, ref, { allowMissing = false } = {}) {
  const parts = ref.split("/");
  let cursor = repositoryReal;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = resolve(cursor, parts[index]);
    ensureInside(repositoryReal, cursor);
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) fail(`${ref} crosses a symbolic link or reparse point`);
      if (index < parts.length - 1 && !info.isDirectory()) fail(`${ref} crosses a non-directory component`);
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") {
        if (index !== parts.length - 1) fail(`${ref} has a missing parent directory`);
        return cursor;
      }
      throw error;
    }
  }
  return cursor;
}
function stableRead(repositoryReal, ref, maxBytes, { allowMissing = false, onRead } = {}) {
  const target = resolveCheckedPath(repositoryReal, ref, { allowMissing });
  let descriptor;
  try { descriptor = openSync(target, "r"); }
  catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      onRead?.(ref, "absent");
      return null;
    }
    throw error;
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) fail(`${ref} exceeds its ${maxBytes}-byte envelope or is not a regular file`);
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathInfo = lstatSync(target);
    if (offset !== buffer.length || !pathInfo.isFile() || pathInfo.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail(`${ref} changed during its bounded read`);
    const snapshot = Object.freeze({ ref, buffer, text: decode(buffer, ref), byteLength: buffer.length, digest: sha256(buffer) });
    onRead?.(ref, "file");
    return snapshot;
  } finally { closeSync(descriptor); }
}
function proposedSnapshot(ref, value, maxBytes) {
  const buffer = Buffer.isBuffer(value) ? Buffer.from(value) : typeof value === "string" ? Buffer.from(value, "utf8") : null;
  if (!buffer || buffer.length > maxBytes) fail(`${ref} proposal is missing or exceeds its ${maxBytes}-byte envelope`);
  return Object.freeze({ ref, buffer, text: decode(buffer, `${ref} proposal`), byteLength: buffer.length, digest: sha256(buffer) });
}
function rootOnly(source, label) { return parseArrayTableDocument(source, "__no_array_table__", label).root; }
function canonicalTomlValue(value, label) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === "string")) return JSON.stringify(value);
  fail(`${label} contains an unsupported canonical TOML value`);
}
function serializeCanonicalRoot(values, order, label) {
  const lines = [];
  for (const field of order) {
    if (!Object.hasOwn(values, field)) continue;
    lines.push(`${field} = ${canonicalTomlValue(values[field], `${label}.${field}`)}`);
  }
  return lines.join("\n");
}
function serializeCanonicalArrayTable(root, rootOrder, table, entries, entryOrder, label) {
  const chunks = [serializeCanonicalRoot(root, rootOrder, label)];
  for (const entry of entries) chunks.push(`[[${table}]]\n${serializeCanonicalRoot(entry, entryOrder, `${label}.${table}`)}`);
  return `${chunks.join("\n\n")}\n`;
}
function manifestRoot(source) {
  const lines = [];
  for (const raw of source.replaceAll("\r\n", "\n").split("\n")) {
    if (raw.trim().startsWith("[")) break;
    lines.push(raw);
  }
  return rootOnly(lines.join("\n"), "instance manifest root");
}
function parseValue(raw, key) {
  if (/^"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"$/u.test(raw) || /^\[.*\]$/u.test(raw)) {
    try { return JSON.parse(raw); } catch { fail(`unsupported TOML value for ${key}`); }
  }
  if (raw === "true" || raw === "false") return raw === "true";
  if (/^-?(?:0|[1-9][0-9]*)$/u.test(raw)) return Number(raw);
  fail(`unsupported TOML value for ${key}`);
}
function assign(target, line, label, lineNumber) {
  const match = /^([a-z0-9_]+)\s*=\s*(.+)$/u.exec(line);
  if (!match || ["__proto__", "prototype", "constructor"].includes(match[1]) || Object.hasOwn(target, match[1])) fail(`${label} has invalid or repeated syntax at line ${lineNumber}`);
  target[match[1]] = parseValue(match[2], `${label}.${match[1]}`);
}
function parseSignalDocument(source, label = "learning signal") {
  const root = Object.create(null); const match = Object.create(null); const trigger = Object.create(null); const evidence = [];
  let target = root;
  for (const [index, raw] of source.replaceAll("\r\n", "\n").split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[match]") { target = match; continue; }
    if (line === "[trigger]") { target = trigger; continue; }
    if (line === "[[evidence]]") { target = Object.create(null); evidence.push(target); continue; }
    if (line.startsWith("[")) fail(`${label} contains an unsupported table at line ${index + 1}`);
    assign(target, line, label, index + 1);
  }
  return { root, match, trigger, evidence };
}

function validateControl(control, expectedInstanceId) {
  if (!exactKeys(control, controlFields) || control.schema_version !== 1 || control.record_type !== "cross-session-signal-control"
    || control.instance_id !== expectedInstanceId || !safeInteger(control.source_revision) || !safeInteger(control.projection_revision)
    || !safeInteger(control.base_revision) || !["clean", "pending", "recovery-required"].includes(control.update_state)
    || !clean(control.updated_at, 64) || (control.updated_at !== "" && !strictZonedDate(control.updated_at))) fail("control record is invalid");
  for (const field of ["pending_operation_id", "pending_event_id", "pending_signal_id", "pending_trigger_id"]) {
    if (!clean(control[field], 160) || (control[field] !== "" && !stableAssetId.test(control[field]))) fail(`control ${field} is invalid`);
  }
  if (!clean(control.pending_source_ref, 240)) fail("control pending_source_ref is invalid");
  if (control.update_state === "clean") {
    if (control.source_revision !== control.projection_revision || ["pending_operation_id", "pending_event_id", "pending_signal_id", "pending_trigger_id", "pending_source_ref"].some((field) => control[field] !== "")) fail("clean control does not close its revisions and pending fields");
  } else if (control.update_state === "pending") {
    if (["pending_operation_id", "pending_event_id", "pending_signal_id", "pending_trigger_id", "pending_source_ref"].some((field) => control[field] === "")
      || control.base_revision !== control.projection_revision || control.source_revision !== control.base_revision + 1) fail("pending control lacks a single next-revision operation identity");
  }
  return control;
}

function validateSignalMap(parsed, expectedInstanceId, actualBytes, { allowLegacySourceAliases = false } = {}) {
  const signals = parsed.entries.map((raw) => {
    const provenance = canonicalProvenance(raw.provenance, { allowLegacy: allowLegacySourceAliases });
    if (provenance === null) fail("startup signal projection uses a retired provenance alias");
    return provenance === raw.provenance ? raw : { ...raw, provenance };
  });
  const map = { ...parsed.root, signals };
  if (!exactKeys(parsed.root, signalMapRootFields) || map.schema_version !== 1 || map.map_id !== "cross-session-signals"
    || map.instance_id !== expectedInstanceId || !["current", "empty", "stale", "uncertain", "overflow", "rebuild-required"].includes(map.state)
    || !safeInteger(map.source_revision) || map.budget_bytes !== SIGNAL_MAP_BUDGET_BYTES || typeof map.overflow !== "boolean"
    || actualBytes > SIGNAL_MAP_BUDGET_BYTES || !safeInteger(map.active_count) || map.active_count !== map.signals.length
    || !safeInteger(map.scheduled_count) || !clean(map.generated_at, 64) || (map.generated_at !== "" && !strictZonedDate(map.generated_at))
    || !clean(map.next_wakeup_at, 64) || (map.next_wakeup_at !== "" && !strictZonedDate(map.next_wakeup_at))
    || map.next_wakeup_ref !== TIME_MAP_REF) fail("startup signal projection is invalid or over budget");
  const ids = new Set(); const refs = new Set();
  for (const entry of map.signals) {
    if (!exactKeys(entry, signalProjectionFields) || !stableAssetId.test(entry.id ?? "") || ids.has(entry.id)
      || !clean(entry.signal_type, 80, false) || !visibleSignalStates.has(entry.status) || !clean(entry.reason, 240, false)
      || !clean(entry.progress, 120) || !clean(entry.next_event, 160) || !stableAssetId.test(entry.domain ?? "")
      || !stableAssetId.test(entry.route_id ?? "") || !normalizedRelativeRef(entry.source_ref, { prefix: "instance/signals/", extension: ".toml" })
      || entry.source_ref === CONTROL_REF || refs.has(entry.source_ref.toLowerCase()) || !safeInteger(entry.source_signal_revision, 1)
      || !clean(entry.provenance, 80, false) || !clean(entry.trust_state, 40, false) || ![1, 2, 3].includes(entry.minimum_level)
      || !clean(entry.confirmation, 80, false)) fail("startup signal projection contains an invalid entry");
    ids.add(entry.id); refs.add(entry.source_ref.toLowerCase());
  }
  if (map.state === "empty" && (map.signals.length !== 0 || map.scheduled_count !== 0)) fail("empty startup signal projection contains work");
  if ((map.overflow && (map.state !== "overflow" || map.signals.length === 0)) || (!map.overflow && map.state === "overflow")) fail("startup signal overflow state is not a bounded aggregate route");
  return map;
}

function deterministicEarliest(triggers) {
  if (triggers.length === 0) return "";
  return [...triggers].sort((left, right) => Date.parse(left.effective_check_at) - Date.parse(right.effective_check_at)
    || left.id.localeCompare(right.id, "en"))[0].effective_check_at;
}
function selectFairStartupSignal(signals, sourceRevision) {
  const priority = new Map([["conflict", 0], ["uncertain", 0], ["stale", 1], ["pending-review", 2], ["near-trigger", 3]]);
  const best = Math.min(...signals.map((entry) => priority.get(entry.status) ?? 4));
  const peers = signals.filter((entry) => (priority.get(entry.status) ?? 4) === best).sort((left, right) => left.id.localeCompare(right.id, "en"));
  return peers[sourceRevision % peers.length];
}
function validateTimeMap(parsed, expectedInstanceId, actualBytes) {
  const map = { ...parsed.root, triggers: parsed.entries };
  if (!exactKeys(parsed.root, timeMapRootFields) || map.schema_version !== 1 || map.map_id !== "time-triggers"
    || map.instance_id !== expectedInstanceId || !["current", "empty"].includes(map.state) || !safeInteger(map.source_revision)
    || actualBytes > TIME_MAP_MAX_BYTES || !safeInteger(map.scheduled_count) || map.scheduled_count !== map.triggers.length
    || !clean(map.generated_at, 64) || (map.generated_at !== "" && !strictZonedDate(map.generated_at))
    || !clean(map.next_wakeup_at, 64) || (map.next_wakeup_at !== "" && !strictZonedDate(map.next_wakeup_at))) fail("time projection metadata is invalid");
  const ids = new Set(); const refs = new Set();
  for (const entry of map.triggers) {
    if (!exactKeys(entry, timeTriggerFields) || !stableAssetId.test(entry.id ?? "") || ids.has(entry.id)
      || !clean(entry.kind, 80, false) || !["scheduled", "due"].includes(entry.status) || !clean(entry.title, 80, false)
      || !strictZonedDate(entry.next_check_at) || !strictZonedDate(entry.effective_check_at)
      || Date.parse(entry.effective_check_at) < Date.parse(entry.next_check_at) || !stableAssetId.test(entry.domain ?? "")
      || !stableAssetId.test(entry.route_id ?? "") || !normalizedInstanceMarkdownRef(entry.source_ref) || refs.has(entry.source_ref.toLowerCase())
      || !safeInteger(entry.source_trigger_revision, 1) || ![1, 2, 3].includes(entry.minimum_level)
      || !clean(entry.confirmation, 80, false)) fail("time projection contains an invalid trigger");
    ids.add(entry.id); refs.add(entry.source_ref.toLowerCase());
  }
  if (map.next_wakeup_at !== deterministicEarliest(map.triggers)) fail("time projection next_wakeup_at is not the deterministic earliest effective time");
  if (map.state === "empty" && map.triggers.length !== 0) fail("empty time projection contains triggers");
  return map;
}

function candidateEntryActive(entry) {
  return entry.status === "candidate" && entry.observation_state === "explicit"
    && ["explicit-user", "existing-approved-migration"].includes(entry.observation_basis)
    && activeCandidateRelations.has(entry.candidate_relation);
}
function validateCandidateIndex(parsed, expectedInstanceId, actualBytes) {
  const index = { ...parsed.root, candidates: parsed.entries };
  if (!exactKeys(parsed.root, candidateIndexRootFields) || index.schema_version !== 1 || index.index_id !== "evolution-candidates"
    || index.instance_id !== expectedInstanceId || !["current", "empty"].includes(index.state) || !safeInteger(index.source_revision)
    || index.budget_bytes !== CANDIDATE_INDEX_BUDGET_BYTES || index.overflow !== false || actualBytes > CANDIDATE_INDEX_BUDGET_BYTES
    || !clean(index.generated_at, 64) || (index.generated_at !== "" && !strictZonedDate(index.generated_at))
    || !safeInteger(index.candidate_count) || !safeInteger(index.indexed_count) || !safeInteger(index.active_count)
    || index.candidate_count !== index.candidates.length || index.indexed_count !== index.candidates.length
    || index.active_count !== index.candidates.filter(candidateEntryActive).length || index.candidates.length > 128
    || (index.state === "empty" && index.candidates.length !== 0)) fail("candidate index metadata is invalid");
  const ids = new Set(); const refs = new Set();
  for (const entry of index.candidates) {
    if (!validateCandidateRevisionTransition(entry, entry) || ids.has(entry.id) || refs.has(entry.source_ref.toLowerCase())) fail("candidate index contains an invalid or duplicate entry");
    ids.add(entry.id); refs.add(entry.source_ref.toLowerCase());
  }
  return index;
}

function parseCandidateSource(snapshot, label = "candidate source") {
  const normalized = snapshot.text.replaceAll("\r\n", "\n");
  const parsed = parseMarkdownFrontmatterHead(normalized, label);
  return { values: parsed.values, body: normalized.slice(parsed.bodyOffset) };
}
function validateCandidateSource(source) {
  const independent = source?.independent_event_count; const successful = source?.successful_event_count;
  const failed = source?.failed_event_count; const contexts = source?.distinct_context_count;
  if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).some((field) => !candidateSourceFields.has(field))
    || locateHighConfidenceSecretCandidates(JSON.stringify(source)).blocked || containsForbiddenStructuredLocation(source)
    || !stableAssetId.test(source.id ?? "") || source.kind !== "evolution-candidate"
    || !["candidate", "review", "archived"].includes(source.status) || !clean(source.title, 80, false) || !clean(source.summary, 240, false)
    || !clean(source.topic_key ?? "", 120) || !clean(source.subject_key ?? "", 120)
    || !cleanList(source.triggers ?? [], 8, 80) || !cleanList(source.aliases ?? [], 8, 80)
    || !cleanList(source.scope ?? [], 8, 120) || !cleanList(source.conditions ?? [], 8, 120) || !cleanList(source.excludes ?? [], 8, 120)
    || !["memory", "capability", "sop", "experience", "preference", "unknown"].includes(source.target_kind)
    || !clean(source.target_subtype ?? "", 80) || ![...activeCandidateRelations, "duplicate", "conflict", "replace", "uncertain"].includes(source.candidate_relation)
    || !["explicit", "pending", "revoked"].includes(source.observation_state)
    || !["explicit-user", "existing-approved-migration", "unknown"].includes(source.observation_basis)
    || !["low", "medium", "high"].includes(source.proposed_risk_tier) || source.risk_tier !== source.proposed_risk_tier
    || !safeInteger(independent) || !safeInteger(successful) || !safeInteger(failed) || !safeInteger(contexts)
    || successful > independent || failed > independent || successful + failed > independent || contexts > independent
    || !stableList(source.representative_event_ids ?? [], 5) || !stableList(source.source_refs ?? [], 16) || !stableList(source.supersedes ?? [], 8)
    || !Array.isArray(source.private_refs ?? []) || (source.private_refs ?? []).length > 32 || !(source.private_refs ?? []).every(validPrivateReference)
    || !safeInteger(source.trigger_revision ?? 0) || !safeInteger(source.source_revision, 1) || ![1, 2, 3].includes(source.minimum_level)
    || source.approval_state !== "pending" || source.activation_basis !== "candidate" || source.approved_by_user !== false
    || !clean(source.lifecycle ?? "", 40) || !clean(source.expected_next_use ?? "", 120)
    || !clean(source.observation_event_ref ?? "", 160) || !clean(source.claim_summary ?? "", 240)
    || !clean(source.resolution ?? "", 40) || !clean(source.resolved_to ?? "", 160)
    || !["last_evidence_at", "remind_at", "snoozed_until", "updated_at"].every((field) => (source[field] ?? "") === "" || strictZonedDate(source[field]))) fail("candidate source frontmatter is invalid");
  if ((source.observation_state === "explicit" || source.observation_state === "revoked")
    && !["explicit-user", "existing-approved-migration"].includes(source.observation_basis)) fail("candidate observation authorization is inconsistent");
  if (source.observation_state === "pending" && source.observation_basis !== "unknown") fail("pending candidate observation basis is inconsistent");
  if (source.status === "archived") {
    if (!["promoted", "merged", "superseded", "rejected"].includes(source.resolution)
      || (["promoted", "merged", "superseded"].includes(source.resolution) && !stableAssetId.test(source.resolved_to ?? ""))
      || (source.resolution === "rejected" && (source.resolved_to ?? "") !== "")) fail("archived candidate resolution is invalid");
  } else if ((source.resolution ?? "") !== "" || (source.resolved_to ?? "") !== "") fail("unresolved candidate carries terminal resolution metadata");
  return source;
}
function candidateSourceMatchesEntry(source, entry) {
  return Object.entries(candidateEntryProjection).every(([entryField, sourceField]) => same(entry[entryField], source[sourceField]))
    && entry.risk_tier === source.proposed_risk_tier;
}

function validateSignalSource(parsed, { candidateId, candidateRevision, signalId, signalRef, allowLegacySourceAliases = false }) {
  const match = parsed.match; const trigger = parsed.trigger;
  const provenance = canonicalProvenance(parsed.root.provenance, { allowLegacy: allowLegacySourceAliases });
  if (provenance === null) fail("learning signal uses a retired provenance alias in proposed bytes");
  const root = provenance === parsed.root.provenance ? parsed.root : { ...parsed.root, provenance };
  if (!exactKeys(root, signalRootFields) || !exactKeys(match, signalMatchFields) || !exactKeys(trigger, signalTriggerFields)
    || root.schema_version !== 1 || root.record_type !== "cross-session-signal" || root.id !== signalId
    || !stableAssetId.test(root.id ?? "") || !clean(root.signal_type, 80, false) || root.evaluation_family !== "count"
    || !allSignalStates.has(root.status) || !clean(root.title, 80, false) || !clean(root.reason, 240, false)
    || !stableAssetId.test(root.domain ?? "") || !stableAssetId.test(root.route_id ?? "") || !safeInteger(root.revision, 1)
    || !["created_at", "updated_at", "last_verified_at"].every((field) => root[field] === "" || strictZonedDate(root[field]))
    || !stableList(root.asset_refs, 1) || root.asset_refs.length !== 1 || root.asset_refs[0] !== candidateId
    || !safeInteger(root.candidate_source_revision, 1) || root.candidate_source_revision !== candidateRevision
    || !stableList(root.related_signal_ids, 16) || ![1, 2, 3].includes(root.minimum_level)
    || !clean(root.confirmation, 80, false) || !clean(root.provenance, 80, false) || !clean(root.trust_state, 40, false)
    || !clean(match.asset_kind, 40) || match.subject !== "" || match.claim !== "" || !same(match.scope, [])
    || !same(match.conditions, []) || !same(match.aliases, []) || !["domain-rule", "count"].includes(trigger.mode)
    || !safeInteger(trigger.independent_event_count) || !safeInteger(trigger.threshold_value)
    || !clean(trigger.progress_summary, 120) || !clean(trigger.next_event, 160)
    || !clean(trigger.next_check_at, 64) || (trigger.next_check_at !== "" && !strictZonedDate(trigger.next_check_at))
    || (trigger.mode === "count" && trigger.threshold_value < 1)) fail("learning signal source is invalid or copies candidate semantics");
  const identities = new Set(); const evidenceRefs = new Set(); const independentTasks = new Set(); const independentContexts = new Set(); const taskIds = new Set();
  const evidence = [];
  for (const rawItem of parsed.evidence) {
    const eventSource = canonicalEventSource(rawItem.event_source, { allowLegacy: allowLegacySourceAliases });
    const sourceKind = canonicalEventSource(rawItem.source_kind, { allowLegacy: allowLegacySourceAliases });
    if (eventSource === null || sourceKind === null) fail("learning signal evidence uses an unknown or retired source alias");
    const item = eventSource === rawItem.event_source && sourceKind === rawItem.source_kind
      ? rawItem : { ...rawItem, event_source: eventSource, source_kind: sourceKind };
    const identity = `${item.event_source}\u0000${item.event_id}`;
    if (!exactKeys(item, evidenceFields) || !stableAssetId.test(item.event_id ?? "") || !eventSourceKinds.has(item.event_source)
      || !stableAssetId.test(item.task_id ?? "") || !stableAssetId.test(item.context_id ?? "")
      || !strictZonedDate(item.occurred_at) || !eventSourceKinds.has(item.source_kind)
      || !clean(item.source_ref, 160) || (item.source_ref !== "" && (!stableAssetId.test(item.source_ref) || evidenceRefs.has(item.source_ref)))
      || typeof item.independent !== "boolean" || !eventRelations.has(item.relation) || item.summary !== "" || identities.has(identity)) fail("learning signal evidence is invalid or duplicated");
    identities.add(identity); if (item.source_ref !== "") evidenceRefs.add(item.source_ref);
    if (item.independent) {
      if (independentTasks.has(item.task_id)) fail("two independent learning events claim the same task identity");
      independentTasks.add(item.task_id);
      independentContexts.add(item.context_id);
    }
    taskIds.add(item.task_id);
    evidence.push(item);
  }
  if (trigger.independent_event_count !== independentTasks.size) fail("compressed learning evidence cannot prove complete event deduplication");
  return { ...parsed, root, evidence, identities, evidenceRefs, independentTasks, contexts: independentContexts, taskIds, signalRef };
}

function projectedSignalEntry(signal, signalRef) {
  return {
    id: signal.root.id, signal_type: signal.root.signal_type, status: signal.root.status, reason: signal.root.reason,
    progress: signal.trigger.progress_summary, next_event: signal.trigger.next_event, domain: signal.root.domain,
    route_id: signal.root.route_id, source_ref: signalRef, source_signal_revision: signal.root.revision,
    provenance: signal.root.provenance, trust_state: signal.root.trust_state, minimum_level: signal.root.minimum_level,
    confirmation: signal.root.confirmation,
  };
}
function verifySignalProjection(map, signal, signalRef) {
  const selected = map.signals.filter((entry) => entry.id === signal.root.id || entry.source_ref === signalRef);
  if (visibleSignalStates.has(signal.root.status)) {
    if (selected.length !== 1 || !same(selected[0], projectedSignalEntry(signal, signalRef))) fail("learning signal startup projection does not match its source revision");
  } else if (selected.length !== 0) fail("non-visible learning signal leaked into the startup projection");
}
function verifyProjectionClosure(control, signalMap, timeMap) {
  if (control.update_state !== "clean" || signalMap.source_revision !== control.projection_revision
    || timeMap.source_revision !== control.projection_revision || signalMap.scheduled_count !== timeMap.scheduled_count
    || signalMap.next_wakeup_at !== timeMap.next_wakeup_at) fail("control, signal projection, and time projection do not form one clean revision closure");
}

function derivedStateUserReport(state, repairedTargetCount = 0) {
  if (state === "repaired") return Object.freeze({
    impact: `只重建并回读了 ${repairedTargetCount} 份候选/信号派生投影。`,
    data_state: "候选正文、信号正文、正式资产和用户数据均未改动。",
    recoverability: "修复使用原文件前像；任一回读失败都会恢复整组旧状态。",
    still_usable: "原来的学习动作已继续，普通任务和其他能力不受影响。",
    next_step: "无需额外操作；继续当前任务即可。",
    user_summary: `发现候选或信号派生索引漂移，已在本机自动修复 ${repairedTargetCount} 份投影并验证通过；正文和用户数据没有改动，原任务已继续。`,
  });
  if (state === "source-truth-invalid") return Object.freeze({
    impact: "实例身份或核心清单未通过严格校验，不能把它当作普通派生漂移处理。",
    data_state: "本次没有写入、删除或猜改任何文件。",
    recoverability: "先修复正式 manifest/core 真源后，派生投影可以再按真源重建。",
    still_usable: "磁盘数据仍保留，但当前实例启动和持久变更不能宣称安全可用。",
    next_step: "让 Agent 只检查正式 manifest/core 和启动状态，不要删除资产或放宽校验。",
    user_summary: "正式实例身份或核心清单没有通过校验，本次没有改动任何数据。请先让 Agent 检查 manifest/core，再继续持久变更。",
  });
  return Object.freeze({
    impact: "新的学习候选、晋升和跨会话信号积累暂时暂停；故障没有扩散到整个助手。",
    data_state: "现有候选、信号、正式资产和用户数据保持原样，没有删除或猜测改写。",
    recoverability: "相关派生状态仍可在查明正文或未知字段冲突后定向修复。",
    still_usable: "普通对话、已有安全资产读取和其他无关任务仍可继续。",
    next_step: "让 Agent 只检查候选索引、信号地图和时间地图的闭包；不要重建或覆盖无关资产。",
    user_summary: "候选或信号派生状态无法从现有真源唯一重建，因此只暂停相关学习/信号积累；现有数据未改动，普通任务仍可继续。",
  });
}

export function bindOperationalDerivedStateReport(value, repairResult) {
  if (value && typeof value === "object" && repairResult?.userReport) {
    operationalDerivedStateReports.set(value, repairResult.userReport);
  }
  return value;
}

export function getOperationalDerivedStateReport(value) {
  return value && typeof value === "object" ? operationalDerivedStateReports.get(value) ?? null : null;
}

function existingOperationalRecoveryRoute() {
  return Object.freeze({ proceed: true, repair: Object.freeze({
    decision: "operational-derived-state-existing-recovery-route", attempted: false,
    repairedTargetCount: 0, executable: false,
  }) });
}

export function operationalDerivedStateGate(repositoryReal, operation, {
  currentCandidateId = "", currentCandidateSourceRef = "", currentSignalId = "", currentSignalSourceRef = "",
} = {}) {
  // Learning capture owns a durable source before it owns any candidate, signal,
  // reminder, or dashboard projection. Promotion already carries an explicit
  // candidate handoff and validates that source itself. Neither normal path
  // should scan and rewrite every derived record before it can continue.
  if (["learning-capture-plan", "learning-promotion"].includes(operation)) {
    try {
      const manifestRead = stableRead(repositoryReal, MANIFEST_REF, 2560);
      const manifest = validateInstanceManifestStructure(parseSectionedToml(manifestRead.text, "instance manifest"));
      if (manifest.root.state !== "instance") throw new Error("instantiated instance required");
      return Object.freeze({ proceed: true, repair: Object.freeze({
        decision: "operational-source-first-route", attempted: false,
        repairedTargetCount: 0, executable: false,
      }) });
    } catch {
      const userReport = derivedStateUserReport("source-truth-invalid");
      return Object.freeze({
        proceed: false,
        result: deepFreeze({
          decision: `${operation}-hard-stop-denied`, reason: "instance-source-truth-invalid",
          executable: false, ordinaryTasksContinue: false,
          pausedCapabilities: Object.freeze([operation]), userReport,
        }),
      });
    }
  }
  try {
    const manifestRead = stableRead(repositoryReal, MANIFEST_REF, 2560);
    const manifest = validateInstanceManifestStructure(parseSectionedToml(manifestRead.text, "instance manifest"));
    if (manifest.root.state !== "instance") throw new Error("instantiated instance required");
    let currentCandidate = null;
    if (currentCandidateSourceRef !== "") {
      try {
        const candidateRead = stableRead(repositoryReal, currentCandidateSourceRef, CANDIDATE_SOURCE_MAX_BYTES);
        const candidateParsed = parseCandidateSource(candidateRead, "current operational candidate");
        currentCandidate = validateCandidateSource(candidateParsed.values);
        if (currentCandidate.id !== currentCandidateId || !["candidate", "review"].includes(currentCandidate.status)
          || locateHighConfidenceSecretCandidates(candidateParsed.body).blocked
          || containsForbiddenLocationReference(candidateParsed.body)) return existingOperationalRecoveryRoute();
      } catch { return existingOperationalRecoveryRoute(); }
    }
    if (currentSignalSourceRef !== "") {
      try {
        if (!currentCandidate) return existingOperationalRecoveryRoute();
        validateSignalSource(parseSignalDocument(stableRead(repositoryReal, currentSignalSourceRef,
          SIGNAL_SOURCE_MAX_BYTES).text, "current operational learning signal"), {
          candidateId: currentCandidateId, candidateRevision: currentCandidate.source_revision,
          signalId: currentSignalId, signalRef: currentSignalSourceRef, allowLegacySourceAliases: true,
        });
      } catch { return existingOperationalRecoveryRoute(); }
    }
    const controlRead = stableRead(repositoryReal, CONTROL_REF, CONTROL_MAX_BYTES);
    const control = validateControl(rootOnly(controlRead.text, "signal control"), manifest.root.instance_id);
    if (control.update_state !== "clean") {
      return existingOperationalRecoveryRoute();
    }
    const signalRead = stableRead(repositoryReal, SIGNAL_MAP_REF, SIGNAL_MAP_BUDGET_BYTES);
    const signalRoot = parseArrayTableDocument(signalRead.text, "signals", "signal projection gate").root;
    if (signalRoot.overflow === true || ["overflow", "rebuild-required"].includes(signalRoot.state)) {
      return existingOperationalRecoveryRoute();
    }
    const candidateRead = stableRead(repositoryReal, CANDIDATE_INDEX_REF, CANDIDATE_INDEX_BUDGET_BYTES);
    const candidateDocument = parseArrayTableDocument(candidateRead.text, "candidates", "candidate index gate");
    const candidateRoot = candidateDocument.root;
    const legacyEmptyIndex = candidateRoot.instance_id === manifest.root.instance_id
      && candidateRoot.state === "empty" && candidateRoot.source_revision === 0 && candidateRoot.generated_at === ""
      && candidateRoot.overflow === false && candidateRoot.candidate_count === 0 && candidateRoot.indexed_count === 0
      && candidateRoot.active_count === 0 && candidateDocument.entries.length === 0;
    if (legacyEmptyIndex) {
      return Object.freeze({ proceed: true, repair: Object.freeze({
        decision: "operational-derived-state-first-write-will-initialize-empty-index", attempted: false,
        repairedTargetCount: 0, executable: false,
      }) });
    }
  } catch { /* The strict repair classifier below distinguishes core truth from derived drift. */ }
  const repair = repairOperationalDerivedStateOnce(repositoryReal);
  if (["operational-derived-state-current", "operational-derived-state-repaired"].includes(repair.decision)) {
    return Object.freeze({ proceed: true, repair });
  }
  const hardStop = repair.decision === "operational-derived-state-hard-stop";
  return Object.freeze({
    proceed: false,
    result: deepFreeze({
      decision: hardStop ? `${operation}-hard-stop-denied` : `${operation}-related-capability-paused`,
      reason: hardStop ? "instance-source-truth-invalid" : "derived-state-not-uniquely-repairable",
      executable: false,
      ordinaryTasksContinue: repair.ordinaryTasksContinue === true,
      pausedCapabilities: repair.pausedCapabilities ?? Object.freeze([]),
      userReport: repair.userReport,
    }),
  });
}

function readStrictDerivedIdentity(repositoryReal) {
  const manifestRead = stableRead(repositoryReal, MANIFEST_REF, 2560);
  const manifest = validateInstanceManifestStructure(parseSectionedToml(manifestRead.text, "instance manifest"));
  if (manifest.root.state !== "instance") fail("derived operational repair requires an instantiated manifest");
  const controlRead = stableRead(repositoryReal, CONTROL_REF, CONTROL_MAX_BYTES);
  const sourceControl = rootOnly(controlRead.text, "signal control");
  let control; let controlNeedsInitialization = false;
  try { control = validateControl(sourceControl, manifest.root.instance_id); }
  catch {
    const pristineTemplate = exactKeys(sourceControl, controlFields)
      && sourceControl.schema_version === 1 && sourceControl.record_type === "cross-session-signal-control"
      && sourceControl.instance_id === "template" && sourceControl.source_revision === 0
      && sourceControl.projection_revision === 0 && sourceControl.update_state === "clean"
      && sourceControl.base_revision === 0 && sourceControl.updated_at === ""
      && ["pending_operation_id", "pending_event_id", "pending_signal_id", "pending_trigger_id", "pending_source_ref"]
        .every((field) => sourceControl[field] === "");
    if (!pristineTemplate) throw new Error("signal control does not match this instance");
    control = validateControl({ ...sourceControl, instance_id: manifest.root.instance_id,
      updated_at: manifest.root.created_at }, manifest.root.instance_id);
    controlNeedsInitialization = true;
  }
  if (control.update_state !== "clean") fail("derived operational repair cannot rewrite a pending or recovery-required signal transaction");
  return Object.freeze({ instanceId: manifest.root.instance_id, control, controlNeedsInitialization,
    manifestRead, manifest, controlRead });
}

function candidateSourcesForRepair(repositoryReal, entries) {
  const sources = new Map(); const indexedRefs = new Set();
  for (const entry of entries) {
    if (!validateCandidateRevisionTransition(entry, entry) || indexedRefs.has(String(entry.source_ref ?? "").toLowerCase())) {
      fail("candidate entries are not valid unique projections");
    }
    const read = stableRead(repositoryReal, entry.source_ref, CANDIDATE_SOURCE_MAX_BYTES);
    const parsed = parseCandidateSource(read, entry.id); const source = validateCandidateSource(parsed.values);
    if (!["candidate", "review"].includes(source.status) || !candidateSourceMatchesEntry(source, entry)
      || locateHighConfidenceSecretCandidates(parsed.body).blocked || containsForbiddenLocationReference(parsed.body)) {
      fail("candidate entry and source cannot form one safe repair truth");
    }
    sources.set(entry.source_ref, source); indexedRefs.add(entry.source_ref.toLowerCase());
  }

  const evolutionRoot = resolveCheckedPath(repositoryReal, "instance/evolution");
  const queue = [evolutionRoot]; const unresolvedRefs = new Set(); let visited = 0; let files = 0;
  while (queue.length) {
    const directory = queue.shift();
    if (++visited > 512) fail("candidate repair source scan exceeds its directory bound");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name); const info = lstatSync(path);
      if (info.isSymbolicLink()) fail("candidate repair source scan crosses a link or reparse point");
      if (entry.isDirectory()) { if (entry.name.toLowerCase() !== "archive") queue.push(path); continue; }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || entry.name.toLowerCase() === "readme.md") continue;
      if (++files > 256) fail("candidate repair source scan exceeds its file bound");
      const ref = relative(repositoryReal, realpathSync(path)).split(sep).join("/").normalize("NFC");
      const read = stableRead(repositoryReal, ref, CANDIDATE_SOURCE_MAX_BYTES);
      const parsed = parseCandidateSource(read, ref);
      if (!["candidate", "review"].includes(parsed.values?.status)) continue;
      const source = validateCandidateSource(parsed.values);
      if (locateHighConfidenceSecretCandidates(parsed.body).blocked || containsForbiddenLocationReference(parsed.body)) {
        fail("candidate repair source scan found unsafe body content");
      }
      if (["candidate", "review"].includes(source.status)) unresolvedRefs.add(ref.toLowerCase());
    }
  }
  if (unresolvedRefs.size !== indexedRefs.size || [...unresolvedRefs].some((ref) => !indexedRefs.has(ref))) {
    fail("candidate index cannot be uniquely rebuilt from the unresolved source set");
  }
  return sources;
}

function readAndValidateDerivedClosure(repositoryReal) {
  const identity = readStrictDerivedIdentity(repositoryReal);
  const candidateRead = stableRead(repositoryReal, CANDIDATE_INDEX_REF, CANDIDATE_INDEX_BUDGET_BYTES);
  const candidateParsed = parseArrayTableDocument(candidateRead.text, "candidates", "candidate index");
  const candidateIndex = { ...candidateParsed.root, candidates: candidateParsed.entries };
  const candidateSources = candidateSourcesForRepair(repositoryReal, candidateParsed.entries);
  if (!validateCandidateIndexClosure(candidateIndex, candidateSources,
    { expectedInstanceId: identity.instanceId, actualFileBytes: candidateRead.byteLength })) fail("candidate index closure is invalid");

  const timeRead = stableRead(repositoryReal, TIME_MAP_REF, TIME_MAP_MAX_BYTES);
  const timeMap = validateTimeMap(parseArrayTableDocument(timeRead.text, "triggers", "time projection"),
    identity.instanceId, timeRead.byteLength);
  const signalRead = stableRead(repositoryReal, SIGNAL_MAP_REF, SIGNAL_MAP_BUDGET_BYTES);
  const signalMap = validateSignalMap(parseArrayTableDocument(signalRead.text, "signals", "startup signal projection"),
    identity.instanceId, signalRead.byteLength);
  verifyProjectionClosure(identity.control, signalMap, timeMap);

  const candidatesById = new Map(candidateParsed.entries.map((entry) => [entry.id, entry]));
  for (const entry of signalMap.signals) {
    const sourceRead = stableRead(repositoryReal, entry.source_ref, SIGNAL_SOURCE_MAX_BYTES);
    const parsed = parseSignalDocument(sourceRead.text, entry.id);
    const candidateId = parsed.root.asset_refs?.[0]; const candidate = candidatesById.get(candidateId);
    if (!candidate || candidate.source_revision !== parsed.root.candidate_source_revision) fail("signal projection references a missing or stale candidate");
    const source = validateSignalSource(parsed, { candidateId, candidateRevision: candidate.source_revision,
      signalId: entry.id, signalRef: entry.source_ref });
    verifySignalProjection(signalMap, source, entry.source_ref);
  }
  return Object.freeze({ identity, candidateRead, timeRead, signalRead, candidateIndex, candidateSources, timeMap, signalMap });
}

function buildDerivedRepairCandidates(repositoryReal) {
  const identity = readStrictDerivedIdentity(repositoryReal);
  const candidateRead = stableRead(repositoryReal, CANDIDATE_INDEX_REF, CANDIDATE_INDEX_BUDGET_BYTES);
  const candidateParsed = parseArrayTableDocument(candidateRead.text, "candidates", "candidate index repair source");
  const pristineCandidateIndex = exactKeys(candidateParsed.root, candidateIndexRootFields)
    && candidateParsed.root.instance_id === "template" && candidateParsed.root.state === "empty"
    && candidateParsed.root.source_revision === 0 && candidateParsed.root.generated_at === ""
    && candidateParsed.root.budget_bytes === CANDIDATE_INDEX_BUDGET_BYTES && candidateParsed.root.overflow === false
    && candidateParsed.root.candidate_count === 0 && candidateParsed.root.indexed_count === 0
    && candidateParsed.root.active_count === 0 && candidateParsed.entries.length === 0;
  if (!exactKeys(candidateParsed.root, candidateIndexRootFields) || candidateParsed.root.overflow !== false
    || !safeInteger(candidateParsed.root.source_revision)
    || (!pristineCandidateIndex && !strictZonedDate(candidateParsed.root.generated_at))) fail("candidate index has non-repairable root metadata");
  const candidateSources = candidateSourcesForRepair(repositoryReal, candidateParsed.entries);
  const candidateRoot = {
    schema_version: 1, index_id: "evolution-candidates", instance_id: identity.instanceId,
    state: candidateParsed.entries.length === 0 ? "empty" : "current",
    source_revision: candidateParsed.root.source_revision,
    generated_at: pristineCandidateIndex ? identity.manifest.root.created_at : candidateParsed.root.generated_at,
    budget_bytes: CANDIDATE_INDEX_BUDGET_BYTES, overflow: false,
    candidate_count: candidateParsed.entries.length, indexed_count: candidateParsed.entries.length,
    active_count: candidateParsed.entries.filter(candidateEntryActive).length,
  };
  const candidateProposal = proposedSnapshot(CANDIDATE_INDEX_REF,
    serializeCanonicalArrayTable(candidateRoot, candidateIndexRootOrder, "candidates", candidateParsed.entries,
      candidateIndexEntryOrder, "candidate index"), CANDIDATE_INDEX_BUDGET_BYTES);
  const proposedCandidateParsed = parseArrayTableDocument(candidateProposal.text, "candidates", "candidate index repair proposal");
  if (!validateCandidateIndexClosure({ ...proposedCandidateParsed.root, candidates: proposedCandidateParsed.entries }, candidateSources,
    { expectedInstanceId: identity.instanceId, actualFileBytes: candidateProposal.byteLength })) fail("candidate repair proposal did not close against candidate sources");

  const timeRead = stableRead(repositoryReal, TIME_MAP_REF, TIME_MAP_MAX_BYTES);
  const timeParsed = parseArrayTableDocument(timeRead.text, "triggers", "time projection repair source");
  if (!exactKeys(timeParsed.root, timeMapRootFields) || !clean(timeParsed.root.generated_at, 64)
    || (timeParsed.root.generated_at !== "" && !strictZonedDate(timeParsed.root.generated_at))) fail("time projection has non-repairable root metadata");
  const timeRoot = {
    schema_version: 1, map_id: "time-triggers", instance_id: identity.instanceId,
    state: timeParsed.entries.length === 0 ? "empty" : "current", source_revision: identity.control.projection_revision,
    generated_at: timeParsed.root.generated_at, scheduled_count: timeParsed.entries.length,
    next_wakeup_at: deterministicEarliest(timeParsed.entries),
  };
  const timeProposal = proposedSnapshot(TIME_MAP_REF,
    serializeCanonicalArrayTable(timeRoot, timeMapRootOrder, "triggers", timeParsed.entries, timeTriggerOrder, "time projection"),
    TIME_MAP_MAX_BYTES);
  const timeMap = validateTimeMap(parseArrayTableDocument(timeProposal.text, "triggers", "time projection repair proposal"),
    identity.instanceId, timeProposal.byteLength);

  const signalRead = stableRead(repositoryReal, SIGNAL_MAP_REF, SIGNAL_MAP_BUDGET_BYTES);
  const signalParsed = parseArrayTableDocument(signalRead.text, "signals", "signal projection repair source");
  if (!exactKeys(signalParsed.root, signalMapRootFields) || signalParsed.root.overflow !== false
    || !["empty", "current", "rebuild-required"].includes(signalParsed.root.state)
    || !clean(signalParsed.root.generated_at, 64)
    || (signalParsed.root.generated_at !== "" && !strictZonedDate(signalParsed.root.generated_at))) {
    fail("signal projection has non-repairable root metadata");
  }
  const signalRoot = {
    schema_version: 1, map_id: "cross-session-signals", instance_id: identity.instanceId,
    state: signalParsed.entries.length === 0 && timeMap.scheduled_count === 0 ? "empty" : "current",
    source_revision: identity.control.projection_revision, generated_at: signalParsed.root.generated_at,
    budget_bytes: SIGNAL_MAP_BUDGET_BYTES, overflow: false, active_count: signalParsed.entries.length,
    scheduled_count: timeMap.scheduled_count, next_wakeup_at: timeMap.next_wakeup_at, next_wakeup_ref: TIME_MAP_REF,
  };
  const legacySignalProposal = proposedSnapshot(SIGNAL_MAP_REF,
    serializeCanonicalArrayTable(signalRoot, signalMapRootOrder, "signals", signalParsed.entries,
      signalProjectionOrder, "signal projection"), SIGNAL_MAP_BUDGET_BYTES);
  const normalizedSignalMap = validateSignalMap(parseArrayTableDocument(legacySignalProposal.text, "signals", "signal projection repair proposal"),
    identity.instanceId, legacySignalProposal.byteLength, { allowLegacySourceAliases: true });
  const signalProposal = proposedSnapshot(SIGNAL_MAP_REF,
    serializeCanonicalArrayTable(signalRoot, signalMapRootOrder, "signals", normalizedSignalMap.signals,
      signalProjectionOrder, "signal projection"), SIGNAL_MAP_BUDGET_BYTES);
  const signalMap = validateSignalMap(parseArrayTableDocument(signalProposal.text, "signals", "canonical signal projection repair proposal"),
    identity.instanceId, signalProposal.byteLength);
  verifyProjectionClosure(identity.control, signalMap, timeMap);
  const controlProposal = identity.controlNeedsInitialization
    ? proposedSnapshot(CONTROL_REF, `${serializeCanonicalRoot(identity.control, controlRootOrder, "signal control")}\n`, CONTROL_MAX_BYTES)
    : null;
  return Object.freeze({ identity, candidates: Object.freeze([
    ...(controlProposal ? [controlProposal] : []), candidateProposal, timeProposal, signalProposal,
  ]) });
}

function installDerivedRepairCandidates(repositoryReal, proposal, { testFaultAfterInstall = 0 } = {}) {
  const suffix = randomBytes(8).toString("hex"); const records = [];
  for (const candidate of proposal.candidates) {
    const current = stableRead(repositoryReal, candidate.ref, artifactLimit(candidate.ref));
    if (current.digest === candidate.digest) continue;
    const stageRef = `${candidate.ref}.repair-stage-${suffix}`; const backupRef = `${candidate.ref}.repair-backup-${suffix}`;
    const stage = resolveCheckedPath(repositoryReal, stageRef, { allowMissing: true });
    const backup = resolveCheckedPath(repositoryReal, backupRef, { allowMissing: true });
    writeFileSync(stage, candidate.buffer, { flag: "wx" });
    const staged = stableRead(repositoryReal, stageRef, artifactLimit(candidate.ref));
    if (staged.digest !== candidate.digest || staged.byteLength !== candidate.byteLength) fail("derived repair stage did not round-trip");
    records.push({ candidate, current, stage, backup, target: resolveCheckedPath(repositoryReal, candidate.ref), installed: false, oldMoved: false });
  }
  if (records.length === 0) fail("derived state is invalid but has no deterministic metadata-only replacement");
  let installedCount = 0;
  try {
    for (const record of records) {
      renameSync(record.target, record.backup); record.oldMoved = true;
      renameSync(record.stage, record.target); record.installed = true; installedCount += 1;
      const readback = stableRead(repositoryReal, record.candidate.ref, artifactLimit(record.candidate.ref));
      if (readback.digest !== record.candidate.digest) fail("derived repair target failed strict readback");
      if (testFaultAfterInstall > 0 && installedCount === testFaultAfterInstall) fail("injected derived repair interruption");
    }
    readAndValidateDerivedClosure(repositoryReal);
    for (const record of records) if (existsSync(record.backup)) unlinkSync(record.backup);
    return records.length;
  } catch (error) {
    for (const record of [...records].reverse()) {
      if (existsSync(record.stage)) unlinkSync(record.stage);
      if (record.installed && existsSync(record.target)) unlinkSync(record.target);
      if (record.oldMoved && existsSync(record.backup)) renameSync(record.backup, record.target);
    }
    for (const record of records) {
      const restored = stableRead(repositoryReal, record.candidate.ref, artifactLimit(record.candidate.ref));
      if (restored.digest !== record.current.digest) fail("derived repair rollback could not restore an exact preimage");
    }
    throw error;
  }
}

function repairOperationalDerivedStateOnceLocked(repository, { testFaultAfterInstall = 0 } = {}) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); readStrictDerivedIdentity(repositoryReal); }
  catch {
    return deepFreeze({ decision: "operational-derived-state-hard-stop", attempted: false, repairedTargetCount: 0,
      executable: false, userReport: derivedStateUserReport("source-truth-invalid") });
  }
  try {
    readAndValidateDerivedClosure(repositoryReal);
    return deepFreeze({ decision: "operational-derived-state-current", attempted: false, repairedTargetCount: 0, executable: false });
  } catch { /* One evidence-based repair attempt follows. */ }
  try {
    const proposal = buildDerivedRepairCandidates(repositoryReal);
    const repairedTargetCount = installDerivedRepairCandidates(repositoryReal, proposal, { testFaultAfterInstall });
    return deepFreeze({ decision: "operational-derived-state-repaired", attempted: true, attemptCount: 1,
      repairedTargetCount, executable: false, userReport: derivedStateUserReport("repaired", repairedTargetCount) });
  } catch {
    return deepFreeze({ decision: "operational-derived-state-related-capability-paused", attempted: true, attemptCount: 1,
      repairedTargetCount: 0, executable: false, ordinaryTasksContinue: true,
      pausedCapabilities: Object.freeze(["learning-capture", "learning-promotion", "cross-session-signals"]),
      userReport: derivedStateUserReport("paused") });
  }
}
function normalizeEvent(event) {
  if (!exactKeys(event, evidenceFields) || !stableAssetId.test(event.event_id ?? "") || !eventSourceKinds.has(event.event_source)
    || !stableAssetId.test(event.task_id ?? "") || !stableAssetId.test(event.context_id ?? "")
    || !strictZonedDate(event.occurred_at) || !eventSourceKinds.has(event.source_kind)
    || !clean(event.source_ref, 160) || (event.source_ref !== "" && !stableAssetId.test(event.source_ref))
    || typeof event.independent !== "boolean" || !eventRelations.has(event.relation) || event.summary !== "") fail("event envelope is invalid");
  return event;
}

function expectedCandidateEvidenceTransition(current, event, transactionAt, distinctContextCount, { transitionMode = "append", replacedEventId = "" } = {}) {
  const independentDelta = transitionMode === "append" && event.independent ? 1 : 0;
  const representatives = [...(current.representative_event_ids ?? [])];
  if (transitionMode === "replace" && replacedEventId !== "") {
    const replacementIndex = representatives.indexOf(replacedEventId);
    if (replacementIndex >= 0) representatives[replacementIndex] = event.event_id;
  } else if (!representatives.includes(event.event_id) && representatives.length < 5) representatives.push(event.event_id);
  const uniqueRepresentatives = [...new Set(representatives)];
  return {
    independent_event_count: current.independent_event_count + independentDelta,
    successful_event_count: current.successful_event_count,
    failed_event_count: current.failed_event_count,
    distinct_context_count: distinctContextCount,
    representative_event_ids: uniqueRepresentatives,
    last_evidence_at: laterTimestamp(current.last_evidence_at ?? "", event.occurred_at),
    source_revision: current.source_revision + 1,
    updated_at: transactionAt,
  };
}
function verifyCandidateTransition(currentParsed, proposedParsed, currentEntry, proposedEntry, event, transactionAt, distinctContextCount, transition = {}) {
  const current = currentParsed.values; const proposed = proposedParsed.values;
  if (currentParsed.body !== proposedParsed.body) fail("an evidence-count transaction changed the candidate body");
  const keys = new Set([...Object.keys(current), ...Object.keys(proposed)]);
  if ([...keys].some((key) => !candidateMutableEvidenceFields.has(key) && !same(current[key], proposed[key]))) fail("candidate transaction changed non-evidence metadata");
  const expected = expectedCandidateEvidenceTransition(current, event, transactionAt, distinctContextCount, transition);
  if (Object.entries(expected).some(([key, value]) => !same(proposed[key], value))) fail("candidate evidence counters, representative IDs, time, or source revision are not deterministic");
  if (!validateCandidateRevisionTransition(currentEntry, proposedEntry) || proposedEntry.source_revision !== proposed.source_revision
    || !candidateSourceMatchesEntry(proposed, proposedEntry)) fail("candidate index entry does not exactly project the next candidate source revision");
}
function verifyIndexTransition(current, proposed, candidateId, transactionAt) {
  if (proposed.source_revision !== current.source_revision + 1 || proposed.generated_at !== transactionAt
    || proposed.candidates.length !== current.candidates.length || proposed.candidates.map((entry) => entry.id).join("\u0000") !== current.candidates.map((entry) => entry.id).join("\u0000")) fail("candidate index root revision or stable entry order did not advance exactly once");
  for (let index = 0; index < current.candidates.length; index += 1) {
    if (current.candidates[index].id !== candidateId && !same(current.candidates[index], proposed.candidates[index])) fail("candidate transaction changed an unrelated index entry");
  }
}
function verifySignalTransition(current, proposed, event, candidateCurrent, candidateProposed, transactionAt, { transitionMode = "append", replaceIndex = -1 } = {}) {
  if (!accumulatingSignalStates.has(current.root.status)) fail("learning signal is no longer in an accumulating state");
  if (proposed.root.revision !== current.root.revision + 1 || proposed.root.updated_at !== transactionAt
    || proposed.root.candidate_source_revision !== candidateProposed.source_revision) fail("learning signal did not bind the next candidate source revision");
  const stableRoot = new Set(["revision", "updated_at", "candidate_source_revision", "status"]);
  if (Object.keys(current.root).some((key) => !stableRoot.has(key) && !same(current.root[key], proposed.root[key]))) fail("learning signal changed unrelated root metadata");
  const supportingCount = proposed.evidence.filter((item) => item.independent && item.relation === "supporting").length;
  const expectedStatus = proposed.evidence.some((item) => ["contradicting", "superseding"].includes(item.relation)) ? "conflict"
    : supportingCount >= proposed.trigger.threshold_value ? "pending-review" : "observing";
  const expectedNextEvent = expectedStatus === "pending-review" ? "请用户复核是否采用、限定试用或继续观察"
    : expectedStatus === "conflict" ? "读取候选与冲突证据，交由用户判断" : "等待下一次宿主可区分的任务观察";
  if (proposed.root.status !== expectedStatus || proposed.trigger.progress_summary !== `${proposed.independentTasks.size} 个宿主区分出的任务观察`
    || proposed.trigger.next_event !== expectedNextEvent) fail("learning signal status or user-facing progress is not the deterministic result of current evidence");
  if (!same(current.match, proposed.match) || current.trigger.mode !== proposed.trigger.mode
    || current.trigger.threshold_value !== proposed.trigger.threshold_value || current.trigger.next_check_at !== proposed.trigger.next_check_at) fail("learning signal changed matching or domain-owned threshold semantics");
  if (transitionMode === "append") {
    if (proposed.evidence.length !== current.evidence.length + 1
      || current.evidence.some((item, index) => !same(item, proposed.evidence[index])) || !same(proposed.evidence.at(-1), event)) fail("learning signal did not append exactly one normalized event");
  } else if (transitionMode === "replace") {
    if (!Number.isSafeInteger(replaceIndex) || replaceIndex < 0 || replaceIndex >= current.evidence.length
      || proposed.evidence.length !== current.evidence.length
      || current.evidence.some((item, index) => index !== replaceIndex && !same(item, proposed.evidence[index]))
      || !same(proposed.evidence[replaceIndex], event)) fail("learning signal did not replace exactly one bounded task observation");
  } else fail("learning signal transition mode is invalid");
  const expectedCount = current.trigger.independent_event_count + (transitionMode === "append" && event.independent ? 1 : 0);
  if (proposed.trigger.independent_event_count !== expectedCount || proposed.trigger.independent_event_count !== proposed.independentTasks.size
    || candidateProposed.independent_event_count !== proposed.independentTasks.size || candidateProposed.distinct_context_count !== proposed.contexts.size
    || candidateCurrent.independent_event_count !== current.independentTasks.size || candidateCurrent.distinct_context_count !== current.contexts.size)
    fail("candidate and learning signal task/context evidence counts diverge");
}
function verifyTimeTransition(current, proposed, nextGlobalRevision, transactionAt) {
  if (!same(current.triggers, proposed.triggers) || proposed.source_revision !== nextGlobalRevision || proposed.generated_at !== transactionAt
    || proposed.state !== current.state || proposed.scheduled_count !== current.scheduled_count || proposed.next_wakeup_at !== current.next_wakeup_at) fail("evidence accumulation changed schedule semantics or failed to refresh the time projection revision");
}
function expectedSignalEntries(currentMap, proposedSignal, signalRef) {
  const replacement = visibleSignalStates.has(proposedSignal.root.status) ? projectedSignalEntry(proposedSignal, signalRef) : null;
  const result = [];
  let replaced = false;
  for (const entry of currentMap.signals) {
    if (entry.id === proposedSignal.root.id || entry.source_ref === signalRef) {
      if (replacement && !replaced) result.push(replacement);
      replaced = true;
    } else result.push(entry);
  }
  if (replacement && !replaced) result.push(replacement);
  return result;
}
function verifySignalMapTransition(current, proposed, proposedSignal, signalRef, nextGlobalRevision, transactionAt, timeMap) {
  const expectedEntries = expectedSignalEntries(current, proposedSignal, signalRef);
  if (!same(proposed.signals, expectedEntries) || proposed.source_revision !== nextGlobalRevision || proposed.generated_at !== transactionAt
    || proposed.scheduled_count !== timeMap.scheduled_count || proposed.next_wakeup_at !== timeMap.next_wakeup_at
    || proposed.state !== (proposed.signals.length === 0 && proposed.scheduled_count === 0 ? "empty" : "current")
    || proposed.active_count !== proposed.signals.length || proposed.overflow !== false) fail("startup signal projection is not the exact bounded projection of the proposed sources");
}

function validateControlPair(current, pending, cleanControl, { operationId, event, signalId, candidateSourceRef, transactionAt }) {
  const next = current.source_revision + 1;
  if (pending.instance_id !== current.instance_id || pending.source_revision !== next || pending.projection_revision !== current.projection_revision
    || pending.update_state !== "pending" || pending.pending_operation_id !== operationId || pending.pending_event_id !== event.event_id
    || pending.pending_signal_id !== signalId || pending.pending_trigger_id !== signalId || pending.pending_source_ref !== candidateSourceRef
    || pending.base_revision !== current.source_revision || pending.updated_at !== transactionAt) fail("pending control proposal is not the exact next-revision transaction header");
  if (cleanControl.instance_id !== current.instance_id || cleanControl.source_revision !== next || cleanControl.projection_revision !== next
    || cleanControl.update_state !== "clean" || ["pending_operation_id", "pending_event_id", "pending_signal_id", "pending_trigger_id", "pending_source_ref"].some((field) => cleanControl[field] !== "")
    || cleanControl.base_revision !== next || cleanControl.updated_at !== transactionAt) fail("clean control proposal does not close the exact transaction revision");
  return next;
}

function artifactLimit(ref) {
  if (ref === CONTROL_REF) return CONTROL_MAX_BYTES;
  if (ref === SIGNAL_MAP_REF) return SIGNAL_MAP_BUDGET_BYTES;
  if (ref === TIME_MAP_REF) return TIME_MAP_MAX_BYTES;
  if (ref === CANDIDATE_INDEX_REF) return CANDIDATE_INDEX_BUDGET_BYTES;
  if (ref === PUBLIC_SNAPSHOT_REF || ref === DIST_SNAPSHOT_REF) return DASHBOARD_SNAPSHOT_MAX_BYTES;
  if (normalizedRelativeRef(ref, { prefix: "instance/evolution/", extension: ".md" })) return CANDIDATE_SOURCE_MAX_BYTES;
  if (normalizedRelativeRef(ref, { prefix: "instance/signals/", extension: ".toml" }) && ref !== CONTROL_REF) return SIGNAL_SOURCE_MAX_BYTES;
  fail(`transaction plan contains an unsupported target: ${ref}`);
}
function makeArtifact(ref, snapshot) { return { target: ref, digest: snapshot?.digest ?? "absent", byteLength: snapshot?.byteLength ?? 0 }; }
function makeStep(ordinal, phase, target, from, to) {
  return { ordinal, phase, target, preconditionDigest: from.digest, proposedDigest: to.digest, proposedByteLength: to.byteLength };
}
function sealPlan(core) { return deepFreeze({ ...core, planDigest: sha256(Buffer.from(canonical(core), "utf8")) }); }
function withoutPlanDigest(plan) { const { planDigest, ...core } = plan; return core; }

function validateSealedPlan(plan) {
  if (!exactKeys(plan, planRootFields) || !digestPattern.test(plan.planDigest ?? "")
    || sha256(Buffer.from(canonical(withoutPlanDigest(plan)), "utf8")) !== plan.planDigest || plan.schemaVersion !== 1
    || plan.planType !== "cross-session-signal-transaction" || plan.decision !== "transaction-preview"
    || plan.executable !== false || plan.authorization !== "same-process-host-and-current-user-observation-receipt"
    || !stableAssetId.test(plan.operationId ?? "") || !stableAssetId.test(plan.instanceId ?? "")
    || !stableAssetId.test(plan.candidateId ?? "") || !stableAssetId.test(plan.signalId ?? "") || !clean(plan.eventKey, 321, false)
    || !normalizedRelativeRef(plan.candidateSourceRef, { prefix: "instance/evolution/", extension: ".md" })
    || !normalizedRelativeRef(plan.signalSourceRef, { prefix: "instance/signals/", extension: ".toml" }) || plan.signalSourceRef === CONTROL_REF
    || !safeInteger(plan.baseRevision) || plan.nextRevision !== plan.baseRevision + 1 || !strictZonedDate(plan.transactionAt)
    || !strictZonedDate(plan.expiresAt) || Date.parse(plan.expiresAt) !== Date.parse(plan.transactionAt) + PERSISTENT_TRANSACTION_TTL_MS
    || !Array.isArray(plan.preimages) || !Array.isArray(plan.steps) || !Array.isArray(plan.finalDigests) || !Array.isArray(plan.rollback)
    || !Array.isArray(plan.truthDigests) || plan.truthDigests.length !== plan.steps.length + 1
    || plan.truthDigests.some((digest) => !digestPattern.test(digest))
    || !same(plan.requiredChecks, requiredPlanChecks)
    || plan.recoveryEvidence !== "private-atomic-bundle-with-sealed-plan-exact-preimages-and-exact-step-bytes"
    || !same(plan.failClosedAssumptions, CROSS_SESSION_SIGNAL_FAIL_CLOSED_ASSUMPTIONS)
    || plan.steps.length !== planPhases.length || plan.steps.some((step, index) => step.ordinal !== index + 1 || step.phase !== planPhases[index]
      || !exactKeys(step, planStepFields)
      || !digestPattern.test(step.preconditionDigest) && step.preconditionDigest !== "absent" || !digestPattern.test(step.proposedDigest)
      || !safeInteger(step.proposedByteLength) || step.proposedByteLength > artifactLimit(step.target))) return false;
  const preimages = new Map();
  for (const item of plan.preimages) {
    if (!exactKeys(item, planArtifactFields) || preimages.has(item.target) || (!digestPattern.test(item.digest) && item.digest !== "absent") || !safeInteger(item.byteLength)
      || item.byteLength > artifactLimit(item.target)) return false;
    preimages.set(item.target, item.digest);
  }
  const expectedTargets = [CONTROL_REF, plan.candidateSourceRef, CANDIDATE_INDEX_REF, plan.signalSourceRef, TIME_MAP_REF,
    SIGNAL_MAP_REF, PUBLIC_SNAPSHOT_REF, DIST_SNAPSHOT_REF];
  if (!same([...preimages.keys()], expectedTargets)
    || !same(plan.readSet, [MANIFEST_REF, CONTROL_REF, SIGNAL_MAP_REF, TIME_MAP_REF, CANDIDATE_INDEX_REF,
      plan.candidateSourceRef, plan.signalSourceRef, PUBLIC_SNAPSHOT_REF, DIST_SNAPSHOT_REF])) return false;
  const state = new Map(preimages);
  for (const step of plan.steps) {
    if (!state.has(step.target) || state.get(step.target) !== step.preconditionDigest) return false;
    state.set(step.target, step.proposedDigest);
  }
  if (plan.steps[0].target !== CONTROL_REF || plan.steps.at(-1).target !== CONTROL_REF
    || plan.steps[1].target !== plan.candidateSourceRef || plan.steps[2].target !== CANDIDATE_INDEX_REF
    || plan.steps[3].target !== plan.signalSourceRef || plan.steps[4].target !== TIME_MAP_REF || plan.steps[5].target !== SIGNAL_MAP_REF
    || plan.steps[6].target !== PUBLIC_SNAPSHOT_REF || plan.steps[7].target !== DIST_SNAPSHOT_REF) return false;
  if (plan.finalDigests.some((item) => !exactKeys(item, planFinalFields) || !digestPattern.test(item.digest ?? ""))
    || plan.rollback.some((item) => !exactKeys(item, planRollbackFields) || (!digestPattern.test(item.restoreDigest ?? "") && item.restoreDigest !== "absent"))) return false;
  const final = new Map(plan.finalDigests.map((item) => [item.target, item.digest]));
  if (final.size !== state.size || [...state].some(([target, digest]) => final.get(target) !== digest)
    || final.get(PUBLIC_SNAPSHOT_REF) !== final.get(DIST_SNAPSHOT_REF)) return false;
  const expectedRollback = [...preimages.keys()].reverse().map((target) => ({ target, restoreDigest: preimages.get(target) }));
  if (!same(plan.rollback, expectedRollback) || plan.contentIncluded !== false
    || plan.completeness !== "digest-bound-plan-with-private-exact-byte-executor") return false;
  return true;
}

function mirrorPhysicalTree(source, target, budget) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) fail("dashboard truth projection source contains a link or reparse point");
  if (info.isDirectory()) {
    if (++budget.directories > 8192) fail("dashboard truth projection directory budget exceeded");
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      mirrorPhysicalTree(resolve(source, entry.name), resolve(target, entry.name), budget);
    }
    return;
  }
  if (!info.isFile() || ++budget.files > 16384) fail("dashboard truth projection file budget exceeded");
  mkdirSync(dirname(target), { recursive: true });
  linkSync(source, target);
}

function replaceProjectionFile(root, ref, bytes) {
  const target = resolve(root, ...ref.split("/"));
  ensureInside(root, target);
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) fail(`dashboard truth projection target is unsafe: ${ref}`);
    unlinkSync(target);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: "wx" });
}

function snapshotProjectionBinding(repositoryReal) {
  return sha256(Buffer.from(repositoryReal.normalize("NFC"), "utf8"));
}

function snapshotProjectionPrefix(repositoryReal) {
  return `${SNAPSHOT_PROJECTION_PREFIX}${createHash("sha256").update(repositoryReal.normalize("NFC")).digest("hex").slice(0, 16)}-`;
}

function inspectOwnedSnapshotProjectionRoot(projectionRoot, expectedParent, repositoryReal) {
  const parentReal = realpathSync(expectedParent); const parent = dirname(projectionRoot);
  const name = projectionRoot.slice(parent.length + 1); const prefix = snapshotProjectionPrefix(repositoryReal);
  if (parent !== expectedParent || parentReal !== realpathSync(parent) || !name.startsWith(prefix)
    || name.length <= prefix.length || name.length > prefix.length + 32) return null;
  const info = lstatSync(projectionRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || dirname(realpathSync(projectionRoot)) !== parentReal) return null;
  const markerTarget = resolve(projectionRoot, SNAPSHOT_PROJECTION_MARKER);
  const markerInfo = lstatSync(markerTarget);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 2048) return null;
  const marker = JSON.parse(decode(stableReadAbsolute(markerTarget, 2048, "snapshot projection owner"), "snapshot projection owner"));
  const fields = new Set(["schema_version", "record_type", "repository_binding", "directory_name", "pid", "created_at"]);
  if (!exactKeys(marker, fields) || marker.schema_version !== 1 || marker.record_type !== "cross-session-snapshot-projection"
    || marker.repository_binding !== snapshotProjectionBinding(repositoryReal) || marker.directory_name !== name
    || !safeInteger(marker.pid, 1) || !strictZonedDate(marker.created_at) || Date.parse(marker.created_at) > Date.now() + 60_000) return null;
  return marker;
}

function removePhysicalSnapshotProjectionTree(projectionRoot) {
  const rootReal = realpathSync(projectionRoot); const queue = [projectionRoot]; const directories = []; const files = [];
  while (queue.length > 0) {
    const directory = queue.shift(); const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory
      || (directory !== projectionRoot && !relative(rootReal, directory).split(sep).every((part) => part && part !== ".."))) {
      fail("snapshot projection cleanup encountered an unsafe directory");
    }
    directories.push(directory);
    if (directories.length > SNAPSHOT_PROJECTION_DIRECTORY_LIMIT) fail("snapshot projection cleanup directory budget exceeded");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name); const childInfo = lstatSync(child);
      if (childInfo.isSymbolicLink()) fail("snapshot projection cleanup refused a link or reparse point");
      if (childInfo.isDirectory()) queue.push(child);
      else if (childInfo.isFile()) {
        files.push(child);
        if (files.length > SNAPSHOT_PROJECTION_FILE_LIMIT) fail("snapshot projection cleanup file budget exceeded");
      } else fail("snapshot projection cleanup encountered an unsupported object");
    }
  }
  for (const file of files) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) fail("snapshot projection cleanup file changed identity");
    unlinkSync(file);
  }
  for (const directory of directories.sort((left, right) => right.length - left.length)) rmdirSync(directory);
}

function cleanupStaleSnapshotProjectionRoots(repositoryReal) {
  const expectedParent = dirname(repositoryReal); const prefix = snapshotProjectionPrefix(repositoryReal);
  const entries = []; const directory = opendirSync(expectedParent); let removed = 0; let candidates = 0;
  try {
    for (let scanned = 0; scanned < SNAPSHOT_PROJECTION_PARENT_ENTRY_LIMIT; scanned += 1) {
      const entry = directory.readSync(); if (!entry) break; entries.push(entry);
    }
  } finally { directory.closeSync(); }
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    if (++candidates > 32) break;
    const projectionRoot = resolve(expectedParent, entry.name); let marker;
    try { marker = inspectOwnedSnapshotProjectionRoot(projectionRoot, expectedParent, repositoryReal); }
    catch { marker = null; }
    if (!marker || processAlive(marker.pid)) continue;
    try { removePhysicalSnapshotProjectionTree(projectionRoot); removed += 1; }
    catch { /* Preserve unsafe or concurrently changed roots without following them. */ }
  }
  return Object.freeze({ inspectedCandidateCount: candidates, removedProjectionCount: removed });
}

function removeProjectionRoot(projectionRoot, expectedParent, repositoryReal) {
  if (!projectionRoot) return;
  const parent = dirname(projectionRoot); const name = projectionRoot.slice(parent.length + 1);
  if (parent !== expectedParent || !name.startsWith(snapshotProjectionPrefix(repositoryReal))) {
    fail("refused to remove an unexpected dashboard truth projection root");
  }
  const info = lstatSync(projectionRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || dirname(realpathSync(projectionRoot)) !== realpathSync(expectedParent)) {
    fail("refused to remove a linked dashboard truth projection root");
  }
  removePhysicalSnapshotProjectionTree(projectionRoot);
}

function buildMergedDashboardArtifacts(repositoryReal, {
  pendingControlRead, candidateRead, proposedIndexRead, proposedSignalRead, proposedTimeRead,
  proposedSignalMapRead, cleanControlRead, publicSnapshotRead, distSnapshotRead, transactionAt,
}) {
  let projectionRoot;
  const projectionParent = dirname(repositoryReal);
  const requiredSourceRefs = [CONTROL_REF, candidateRead.ref, CANDIDATE_INDEX_REF, proposedSignalRead.ref, TIME_MAP_REF, SIGNAL_MAP_REF];
  const operationalDigestOptions = { mode: "operational", requiredSourceRefs };
  try {
    cleanupStaleSnapshotProjectionRoots(repositoryReal);
    const baseTruth = computeSnapshotSourceDigest(repositoryReal, operationalDigestOptions);
    projectionRoot = mkdtempSync(join(projectionParent, snapshotProjectionPrefix(repositoryReal)));
    const marker = { schema_version: 1, record_type: "cross-session-snapshot-projection",
      repository_binding: snapshotProjectionBinding(repositoryReal), directory_name: projectionRoot.slice(projectionParent.length + 1),
      pid: process.pid, created_at: new Date().toISOString() };
    writeDurableExclusive(resolve(projectionRoot, SNAPSHOT_PROJECTION_MARKER), Buffer.from(`${JSON.stringify(marker)}\n`, "utf8"));
    const budget = { directories: 0, files: 0 };
    for (const ref of ["assistant.toml", "AGENTS.md", "BOOTSTRAP.md", "core", "instance"]) {
      mirrorPhysicalTree(resolve(repositoryReal, ...ref.split("/")), resolve(projectionRoot, ...ref.split("/")), budget);
    }
    for (const ref of [PUBLIC_SNAPSHOT_REF, DIST_SNAPSHOT_REF]) {
      mirrorPhysicalTree(resolve(repositoryReal, ...ref.split("/")), resolve(projectionRoot, ...ref.split("/")), budget);
    }
    const projectionBase = computeSnapshotSourceDigest(projectionRoot, operationalDigestOptions);
    if (projectionBase.digest !== baseTruth.digest || projectionBase.fileCount !== baseTruth.fileCount
      || projectionBase.totalBytes !== baseTruth.totalBytes) fail("isolated dashboard truth projection did not preserve the frozen source tree");

    const truthDigests = [baseTruth.digest];
    const sourceSteps = [
      [CONTROL_REF, pendingControlRead.buffer],
      [candidateRead.ref, candidateRead.buffer],
      [CANDIDATE_INDEX_REF, proposedIndexRead.buffer],
      [proposedSignalRead.ref, proposedSignalRead.buffer],
      [TIME_MAP_REF, proposedTimeRead.buffer],
      [SIGNAL_MAP_REF, proposedSignalMapRead.buffer],
    ];
    for (const [ref, bytes] of sourceSteps) {
      replaceProjectionFile(projectionRoot, ref, bytes);
      truthDigests.push(computeSnapshotSourceDigest(projectionRoot, operationalDigestOptions).digest);
    }
    replaceProjectionFile(projectionRoot, CONTROL_REF, cleanControlRead.buffer);
    const finalTruth = computeSnapshotSourceDigest(projectionRoot, operationalDigestOptions).digest;
    const snapshot = buildSnapshotCandidate(projectionRoot, {
      existingSource: publicSnapshotRead.text,
      now: new Date(transactionAt),
      mode: "operational",
      requiredSourceRefs,
    });
    if (typeof snapshot.source !== "string" || snapshot.sourceDigest !== finalTruth
      || Buffer.byteLength(snapshot.source, "utf8") > DASHBOARD_SNAPSHOT_MAX_BYTES) {
      fail("merged truth did not rebuild one bounded dashboard snapshot candidate");
    }
    const snapshotRead = proposedSnapshot(PUBLIC_SNAPSHOT_REF, snapshot.source, DASHBOARD_SNAPSHOT_MAX_BYTES);
    return Object.freeze({
      publicSnapshotRead, distSnapshotRead, snapshotRead,
      truthDigests: Object.freeze([...truthDigests, truthDigests.at(-1), truthDigests.at(-1), finalTruth]),
    });
  } finally {
    removeProjectionRoot(projectionRoot, projectionParent, repositoryReal);
  }
}

function purgeConsumedEventEvidenceRefs(now) {
  for (const [key, expiresAt] of consumedEventEvidenceRefs) if (expiresAt < now) consumedEventEvidenceRefs.delete(key);
}

function lowSensitiveHostBasis(value) {
  return clean(value, 320, false) && !containsForbiddenLocationReference(value)
    && !locateHighConfidenceSecretCandidates(value).blocked;
}

function derivedObservationId(prefix, instanceId, candidateId, signalId, basis) {
  const digest = createHash("sha256").update(`${instanceId}\u0000${candidateId}\u0000${signalId}\u0000${prefix}\u0000${basis}`).digest("hex");
  return `${prefix}.${digest.slice(0, 32)}`;
}

// This is a host-adapter boundary, not a model tool. It immediately replaces
// host-visible task/message keys with instance-scoped opaque IDs and retains
// the raw bases only for this synchronous call. A copied return object has no
// authority because subsequent boundaries require WeakMap identity.
export function createHostTaskObservationReceipt(repository, request = {}) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); }
  catch { return deepFreeze({ decision: "host-task-observation-denied", reason: "repository-unavailable", executable: false }); }
  const now = Date.now(); const occurredAtMs = Date.parse(request?.occurredAt ?? "");
  if (!exactKeys(request, hostTaskObservationFields)
    || !stableAssetId.test(request.candidateId ?? "") || !stableAssetId.test(request.signalId ?? "")
    || !normalizedRelativeRef(request.signalSourceRef, { prefix: "instance/signals/", extension: ".toml" }) || request.signalSourceRef === CONTROL_REF
    || typeof request.taskBasisStable !== "boolean" || !clean(request.taskBasis, 320)
    || (request.taskBasisStable ? !lowSensitiveHostBasis(request.taskBasis) : request.taskBasis !== "")
    || !clean(request.contextBasis, 320) || (request.contextBasis !== "" && !lowSensitiveHostBasis(request.contextBasis))
    || !lowSensitiveHostBasis(request.observationBasis) || !eventSourceKinds.has(request.sourceKind)
    || !strictZonedDate(request.occurredAt) || occurredAtMs > now || occurredAtMs < now - 24 * 60 * 60_000) {
    return deepFreeze({ decision: "host-task-observation-denied", reason: "request-invalid-or-unbounded", executable: false });
  }
  let manifest;
  try { manifest = manifestRoot(stableRead(repositoryReal, MANIFEST_REF, 2560).text); }
  catch { return deepFreeze({ decision: "host-task-observation-denied", reason: "instance-identity-unavailable", executable: false }); }
  if (!stableAssetId.test(manifest.instance_id ?? "") || manifest.state !== "instance") {
    return deepFreeze({ decision: "host-task-observation-denied", reason: "instantiated-instance-required", executable: false });
  }
  const taskId = request.taskBasisStable
    ? derivedObservationId("task.observation", manifest.instance_id, request.candidateId, request.signalId, request.taskBasis)
    : derivedObservationId("task.unverified", manifest.instance_id, request.candidateId, request.signalId, request.observationBasis);
  const contextId = request.contextBasis !== ""
    ? derivedObservationId("context.observation", manifest.instance_id, request.candidateId, request.signalId, request.contextBasis)
    : derivedObservationId("context.unknown", manifest.instance_id, request.candidateId, request.signalId, "unknown-context");
  const eventId = derivedObservationId("event.observation", manifest.instance_id, request.candidateId, request.signalId,
    `${request.observationBasis}\u0000${request.occurredAt}`);
  const sourceRef = derivedObservationId("observation", manifest.instance_id, request.candidateId, request.signalId, request.observationBasis);
  const independent = request.taskBasisStable && independentlyCountableObservationSources.has(request.sourceKind);
  const expiresAtMs = now + 10 * 60_000;
  const receipt = deepFreeze({
    decision: "host-task-observation-attested", executable: false, instanceId: manifest.instance_id,
    candidateId: request.candidateId, signalId: request.signalId, signalSourceRef: request.signalSourceRef,
    taskId, contextId, eventId, occurredAt: request.occurredAt, eventSource: request.sourceKind,
    sourceKind: request.sourceKind, sourceRef, independent,
    taskIdentityTrust: independent ? "host-attested-stable-task-basis-not-result-validation" : "host-task-basis-unavailable-or-source-not-countable",
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  trustedHostTaskObservations.set(receipt, Object.freeze({ repository: repositoryReal, instanceId: manifest.instance_id,
    candidateId: request.candidateId, signalId: request.signalId, signalSourceRef: request.signalSourceRef,
    taskId, contextId, eventId, occurredAt: request.occurredAt, eventSource: request.sourceKind,
    sourceKind: request.sourceKind, sourceRef, independent, expiresAt: expiresAtMs }));
  return receipt;
}

// The challenge consumes the opaque host observation and binds it to one
// current-user message. It never accepts raw task/context/event/source IDs.
export function createCrossSessionSignalEventChallenge(repository, {
  hostTaskObservationReceipt, purpose = "accumulate-host-attested-cross-session-learning-observation",
} = {}) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); }
  catch { return deepFreeze({ decision: "signal-event-challenge-denied", reason: "repository-unavailable", executable: false }); }
  const observation = trustedHostTaskObservations.get(hostTaskObservationReceipt);
  if (!observation || observation.repository !== repositoryReal || consumedHostTaskObservations.has(hostTaskObservationReceipt)
    || observation.expiresAt < Date.now() || purpose !== "accumulate-host-attested-cross-session-learning-observation") {
    return deepFreeze({ decision: "signal-event-challenge-denied", reason: "trusted-host-task-observation-required", executable: false });
  }
  consumedHostTaskObservations.add(hostTaskObservationReceipt);
  const issuedAtMs = Date.now();
  const challengeNonce = randomBytes(16).toString("hex");
  const challenge = deepFreeze({
    decision: "signal-event-receipt-required", candidateId: observation.candidateId, signalId: observation.signalId,
    signalSourceRef: observation.signalSourceRef, independent: observation.independent,
    taskIdentityTrust: observation.independent ? "host-attested-distinct-task-observation-not-validated" : "non-independent-observation",
    purpose,
    challengeNonce, issuedAt: new Date(issuedAtMs).toISOString(), expiresAt: new Date(issuedAtMs + 10 * 60_000).toISOString(), executable: false,
  });
  trustedEventChallenges.set(challenge, Object.freeze({
    ...observation, purpose, challengeNonce, issuedAtMs, expiresAt: Math.min(observation.expiresAt, issuedAtMs + 10 * 60_000),
  }));
  return challenge;
}

export function confirmCrossSessionSignalEvent(challenge, receipt) {
  const trust = trustedEventChallenges.get(challenge);
  const now = Date.now();
  purgeConsumedEventEvidenceRefs(now);
  const confirmedAt = Date.parse(receipt?.confirmed_at ?? "");
  const basisValid = receipt?.basis === "host-current-user-message";
  const evidenceKey = trust && stableAssetId.test(receipt?.message_ref ?? "")
    ? `${trust.repository}\u0000${receipt.basis}\u0000${receipt.message_ref}` : "";
  const valid = trust && exactKeys(receipt, eventReceiptFields) && basisValid
    && receipt.challenge_nonce === trust.challengeNonce && stableAssetId.test(receipt.message_ref ?? "")
    && digestPattern.test(receipt.message_digest ?? "")
    && eventRelations.has(receipt.relation) && receipt.summary === ""
    && strictZonedDate(receipt.confirmed_at) && confirmedAt >= trust.issuedAtMs
    && Date.parse(trust.occurredAt) <= confirmedAt && confirmedAt <= now
    && confirmedAt <= trust.expiresAt && now <= trust.expiresAt
    && evidenceKey !== "" && !consumedEventEvidenceRefs.has(evidenceKey);
  if (!valid) return deepFreeze({ decision: "signal-event-receipt-denied", executable: false });
  trustedEventChallenges.delete(challenge);
  consumedEventEvidenceRefs.set(evidenceKey, trust.expiresAt);
  const transactionAt = new Date(now).toISOString();
  const operationId = `operation.signal.${createHash("sha256").update(`${trust.challengeNonce}\u0000${trust.eventSource}\u0000${trust.eventId}`).digest("hex").slice(0, 24)}`;
  const eventReceipt = deepFreeze({
    decision: "trusted-signal-event", candidateId: trust.candidateId, signalId: trust.signalId, signalSourceRef: trust.signalSourceRef,
    contextId: trust.contextId, eventId: trust.eventId, eventSource: trust.eventSource, taskId: trust.taskId,
    occurredAt: trust.occurredAt, sourceKind: trust.sourceKind, sourceRef: trust.sourceRef, evidenceRef: trust.sourceRef,
    independent: trust.independent,
    relation: receipt.relation,
    operationId, transactionAt, confirmationTrust: "same-process-host-attested-current-user-observation-not-result-validation",
    executable: false,
  });
  trustedEventReceipts.set(eventReceipt, Object.freeze({
    ...trust, evidenceRef: trust.sourceRef,
    relation: receipt.relation,
    operationId, transactionAt,
  }));
  return eventReceipt;
}

export function inspectCrossSessionSignalStartup(repository, { now = new Date().toISOString(), onRead } = {}) {
  const readSet = [];
  const observe = (ref, kind) => { readSet.push(ref); onRead?.(ref, kind); };
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); }
  catch { return deepFreeze({ decision: "startup-recovery-required", reason: "repository-unavailable", executable: false, readSet }); }
  try {
    if (!strictZonedDate(now)) fail("startup now must include a valid timezone offset");
    const manifest = manifestRoot(stableRead(repositoryReal, MANIFEST_REF, 2560, { onRead: observe }).text);
    if (!stableAssetId.test(manifest.instance_id ?? "")) fail("instance manifest identity is invalid");
    const control = validateControl(rootOnly(stableRead(repositoryReal, CONTROL_REF, CONTROL_MAX_BYTES, { onRead: observe }).text, "signal control"), manifest.instance_id);
    const signalRead = stableRead(repositoryReal, SIGNAL_MAP_REF, SIGNAL_MAP_BUDGET_BYTES, { onRead: observe });
    const signalMap = validateSignalMap(parseArrayTableDocument(signalRead.text, "signals", "startup signal projection"),
      manifest.instance_id, signalRead.byteLength, { allowLegacySourceAliases: true });
    if (control.update_state !== "clean") return deepFreeze({ decision: "startup-targeted-recovery", reason: control.update_state,
      operationId: control.pending_operation_id, sourceRevision: control.source_revision, projectionRevision: control.projection_revision,
      executable: false, readSet, bodyReads: 0 });
    if (signalMap.source_revision !== control.projection_revision) return deepFreeze({ decision: "startup-targeted-recovery", reason: "projection-revision-mismatch", executable: false, readSet, bodyReads: 0 });
    if (signalMap.next_wakeup_at !== "" && Date.parse(now) >= Date.parse(signalMap.next_wakeup_at)) {
      const deferred = signalMap.signals.length > 0 ? selectFairStartupSignal(signalMap.signals, control.source_revision) : null;
      return deepFreeze({ decision: "startup-time-index-due", nextWakeupAt: signalMap.next_wakeup_at,
        nextWakeupRef: signalMap.next_wakeup_ref, deferredSignalId: deferred?.id ?? "",
        selectionPolicy: deferred ? "due-time-first-with-one-bounded-deferred-signal" : "due-time-first",
        executable: false, readSet, bodyReads: 0 });
    }
    if (signalMap.signals.length > 0) {
      const selected = selectFairStartupSignal(signalMap.signals, control.source_revision);
      return deepFreeze({ decision: "startup-signal-route-ready", signalId: selected.id, routeId: selected.route_id,
        selectionPolicy: "severity-first-revision-rotated-equal-priority", overflow: signalMap.overflow,
        executable: false, readSet, bodyReads: 0 });
    }
    return deepFreeze({ decision: "startup-ordinary-route", nextWakeupAt: signalMap.next_wakeup_at, scheduledCount: signalMap.scheduled_count,
      executable: false, readSet, bodyReads: 0 });
  } catch (error) {
    return deepFreeze({ decision: "startup-recovery-required", reason: error.message, executable: false, readSet, bodyReads: 0 });
  }
}

function buildCrossSessionSignalTransactionPlanLocked(repository, request = {}) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); }
  catch { return deny("repository-unavailable"); }
  if (Object.hasOwn(request, "event") || Object.hasOwn(request, "operationId") || Object.hasOwn(request, "transactionAt")) return deny("raw-event-or-caller-time-not-accepted");
  const { eventReceipt, candidateId, candidateSourceRef, signalId, signalSourceRef, proposed = {} } = request;
  const receiptTrust = trustedEventReceipts.get(eventReceipt);
  if (!receiptTrust || receiptTrust.repository !== repositoryReal || receiptTrust.candidateId !== candidateId
    || receiptTrust.signalId !== signalId || receiptTrust.signalSourceRef !== signalSourceRef || receiptTrust.expiresAt < Date.now()) return deny("trusted-current-event-receipt-required");
  const { operationId, transactionAt } = receiptTrust;
  if (!stableAssetId.test(operationId ?? "") || !stableAssetId.test(candidateId ?? "") || !stableAssetId.test(signalId ?? "")
    || !normalizedRelativeRef(candidateSourceRef, { prefix: "instance/evolution/", extension: ".md" })
    || !normalizedRelativeRef(signalSourceRef, { prefix: "instance/signals/", extension: ".toml" }) || signalSourceRef === CONTROL_REF
    || !strictZonedDate(transactionAt)) return deny("request-envelope-invalid");
  const operationalGate = operationalDerivedStateGate(repositoryReal, "cross-session-signal", {
    currentCandidateId: candidateId, currentCandidateSourceRef: candidateSourceRef,
    currentSignalId: signalId, currentSignalSourceRef: signalSourceRef,
  });
  if (!operationalGate.proceed) return operationalGate.result;
  try {
    const manifestRead = stableRead(repositoryReal, MANIFEST_REF, 2560);
    const manifest = manifestRoot(manifestRead.text);
    if (!stableAssetId.test(manifest.instance_id ?? "") || manifest.state !== "instance") return deny("instantiated-instance-required");
    const controlRead = stableRead(repositoryReal, CONTROL_REF, CONTROL_MAX_BYTES);
    const control = validateControl(rootOnly(controlRead.text, "signal control"), manifest.instance_id);
    const signalMapRead = stableRead(repositoryReal, SIGNAL_MAP_REF, SIGNAL_MAP_BUDGET_BYTES);
    const currentSignalMap = validateSignalMap(parseArrayTableDocument(signalMapRead.text, "signals", "startup signal projection"),
      manifest.instance_id, signalMapRead.byteLength, { allowLegacySourceAliases: true });
    if (control.update_state !== "clean") return deepFreeze({ decision: "transaction-recovery-required", reason: "unfinished-control-operation",
      operationId: control.pending_operation_id, executable: false, requiredEvidence: "original-digest-bound-plan", readSet: [MANIFEST_REF, CONTROL_REF, SIGNAL_MAP_REF] });
    if (currentSignalMap.overflow || !["current", "empty"].includes(currentSignalMap.state)) return deepFreeze({
      decision: "transaction-recovery-required", reason: "startup-projection-rebuild-required-before-accumulation",
      executable: false, readSet: [MANIFEST_REF, CONTROL_REF, SIGNAL_MAP_REF],
    });
    const timeMapRead = stableRead(repositoryReal, TIME_MAP_REF, TIME_MAP_MAX_BYTES);
    const currentTimeMap = validateTimeMap(parseArrayTableDocument(timeMapRead.text, "triggers", "time projection"), manifest.instance_id, timeMapRead.byteLength);
    verifyProjectionClosure(control, currentSignalMap, currentTimeMap);

    const indexRead = stableRead(repositoryReal, CANDIDATE_INDEX_REF, CANDIDATE_INDEX_BUDGET_BYTES);
    const currentIndex = validateCandidateIndex(parseArrayTableDocument(indexRead.text, "candidates", "candidate index"), manifest.instance_id, indexRead.byteLength);
    const sourceRead = stableRead(repositoryReal, candidateSourceRef, CANDIDATE_SOURCE_MAX_BYTES, { allowMissing: true });
    const currentEntry = currentIndex.candidates.find((entry) => entry.id === candidateId);
    if (!sourceRead) return deny("candidate-deleted-no-further-accumulation");
    const currentCandidateParsed = parseCandidateSource(sourceRead, "current candidate source");
    const currentCandidate = validateCandidateSource(currentCandidateParsed.values);
    if (currentCandidate.id !== candidateId) return deny("candidate-id-drift");
    if (currentCandidate.status === "archived") return deny("candidate-promoted-or-archived-no-further-accumulation");
    if (currentCandidate.observation_state === "revoked") return deny("candidate-observation-revoked-no-further-accumulation");
    if (!currentEntry) return deny("candidate-not-indexed-no-further-accumulation");
    if (currentEntry.source_ref !== candidateSourceRef || !candidateSourceMatchesEntry(currentCandidate, currentEntry)) return deny("candidate-source-index-drift");
    if (currentCandidate.status !== "candidate" || currentCandidate.observation_state !== "explicit"
      || !["explicit-user", "existing-approved-migration"].includes(currentCandidate.observation_basis)
      || !activeCandidateRelations.has(currentCandidate.candidate_relation)) return deny("candidate-not-active-for-accumulation");

    const signalRead = stableRead(repositoryReal, signalSourceRef, SIGNAL_SOURCE_MAX_BYTES, { allowMissing: true });
    if (!signalRead) return deny("learning-signal-missing-fail-closed");
    const currentSignal = validateSignalSource(parseSignalDocument(signalRead.text, "current learning signal"), {
      candidateId, candidateRevision: currentCandidate.source_revision, signalId, signalRef: signalSourceRef,
      allowLegacySourceAliases: true,
    });
    verifySignalProjection(currentSignalMap, currentSignal, signalSourceRef);
    if (currentSignal.trigger.independent_event_count !== currentCandidate.independent_event_count
      || currentCandidate.distinct_context_count !== currentSignal.contexts.size) return deny("candidate-signal-count-or-context-drift");
    const sameTaskEvidence = currentSignal.evidence.filter((item) => item.task_id === receiptTrust.taskId);
    if (sameTaskEvidence.length > 1) return deny("duplicate-task-evidence-requires-targeted-compaction");
    const independent = receiptTrust.independent === true && sameTaskEvidence.length === 0;
    let event = normalizeEvent({
      event_id: receiptTrust.eventId, event_source: receiptTrust.eventSource, task_id: receiptTrust.taskId,
      context_id: receiptTrust.contextId, occurred_at: receiptTrust.occurredAt, source_kind: receiptTrust.sourceKind,
      source_ref: receiptTrust.sourceRef, independent, relation: receiptTrust.relation, summary: "",
    });
    let transitionMode = "append"; let replaceIndex = -1; let replacedEvent = null;
    if (sameTaskEvidence.length === 1) {
      replacedEvent = sameTaskEvidence[0];
      replaceIndex = currentSignal.evidence.findIndex((item) => item.task_id === receiptTrust.taskId);
      if (replacedEvent.relation === event.relation && replacedEvent.source_kind === event.source_kind
        && replacedEvent.event_source === event.event_source) {
        consumedEventReceipts.add(eventReceipt);
        const sameIdentity = replacedEvent.event_id === event.event_id && replacedEvent.event_source === event.event_source;
        return deepFreeze({ decision: "transaction-noop", reason: sameIdentity ? "event-already-applied" : "same-task-observation-already-represented",
          eventKey: `${event.event_source}:${event.event_id}`, sourceRevision: control.source_revision, executable: false,
          readSet: [MANIFEST_REF, CONTROL_REF, SIGNAL_MAP_REF, TIME_MAP_REF, CANDIDATE_INDEX_REF, candidateSourceRef, signalSourceRef] });
      }
      transitionMode = "replace";
      event = normalizeEvent({ ...event, context_id: replacedEvent.context_id, independent: replacedEvent.independent });
    }
    const eventKey = `${event.event_source}:${event.event_id}`;
    if (transitionMode === "append" && currentSignal.identities.has(`${event.event_source}\u0000${event.event_id}`)) return deepFreeze({ decision: "transaction-noop",
      reason: "event-already-applied", eventKey, sourceRevision: control.source_revision, executable: false,
      readSet: [MANIFEST_REF, CONTROL_REF, SIGNAL_MAP_REF, TIME_MAP_REF, CANDIDATE_INDEX_REF, candidateSourceRef, signalSourceRef] });
    if (currentSignal.evidenceRefs.has(receiptTrust.evidenceRef)
      && !(transitionMode === "replace" && replacedEvent?.source_ref === receiptTrust.evidenceRef)) return deny("evidence-receipt-reference-already-applied");
    if (consumedEventReceipts.has(eventReceipt)) return deny("event-receipt-already-bound-to-a-plan");
    if ((currentCandidate.representative_event_ids ?? []).includes(event.event_id)
      && !(transitionMode === "replace" && replacedEvent?.event_id === event.event_id)) return deny("event-id-ambiguous-outside-complete-signal-ledger");

    const pendingRead = proposedSnapshot(CONTROL_REF, proposed.pendingControl, CONTROL_MAX_BYTES);
    const candidateRead = proposedSnapshot(candidateSourceRef, proposed.candidateSource, CANDIDATE_SOURCE_MAX_BYTES);
    const proposedIndexRead = proposedSnapshot(CANDIDATE_INDEX_REF, proposed.candidateIndex, CANDIDATE_INDEX_BUDGET_BYTES);
    const proposedSignalRead = proposedSnapshot(signalSourceRef, proposed.signalSource, SIGNAL_SOURCE_MAX_BYTES);
    const proposedTimeRead = proposedSnapshot(TIME_MAP_REF, proposed.timeProjection, TIME_MAP_MAX_BYTES);
    const proposedSignalMapRead = proposedSnapshot(SIGNAL_MAP_REF, proposed.signalProjection, SIGNAL_MAP_BUDGET_BYTES);
    const cleanRead = proposedSnapshot(CONTROL_REF, proposed.cleanControl, CONTROL_MAX_BYTES);

    const pending = validateControl(rootOnly(pendingRead.text, "pending signal control"), manifest.instance_id);
    const cleanControl = validateControl(rootOnly(cleanRead.text, "clean signal control"), manifest.instance_id);
    const nextGlobalRevision = validateControlPair(control, pending, cleanControl, { operationId, event, signalId, candidateSourceRef, transactionAt });
    const proposedCandidateParsed = parseCandidateSource(candidateRead, "proposed candidate source");
    const proposedCandidate = validateCandidateSource(proposedCandidateParsed.values);
    const proposedIndex = validateCandidateIndex(parseArrayTableDocument(proposedIndexRead.text, "candidates", "proposed candidate index"), manifest.instance_id, proposedIndexRead.byteLength);
    const proposedEntry = proposedIndex.candidates.find((entry) => entry.id === candidateId);
    if (!proposedEntry || proposedEntry.source_ref !== candidateSourceRef || proposedCandidate.id !== candidateId
      || !candidateSourceMatchesEntry(proposedCandidate, proposedEntry)) fail("proposed candidate source and index entry do not close");
    verifyIndexTransition(currentIndex, proposedIndex, candidateId, transactionAt);
    const proposedDistinctContextCount = currentSignal.contexts.size + (transitionMode === "append" && independent && !currentSignal.contexts.has(receiptTrust.contextId) ? 1 : 0);
    verifyCandidateTransition(currentCandidateParsed, proposedCandidateParsed, currentEntry, proposedEntry, event, transactionAt, proposedDistinctContextCount,
      { transitionMode, replacedEventId: replacedEvent?.event_id ?? "" });

    const proposedSignal = validateSignalSource(parseSignalDocument(proposedSignalRead.text, "proposed learning signal"), {
      candidateId, candidateRevision: proposedCandidate.source_revision, signalId, signalRef: signalSourceRef,
    });
    verifySignalTransition(currentSignal, proposedSignal, event, currentCandidate, proposedCandidate, transactionAt, { transitionMode, replaceIndex });
    const proposedTimeMap = validateTimeMap(parseArrayTableDocument(proposedTimeRead.text, "triggers", "proposed time projection"), manifest.instance_id, proposedTimeRead.byteLength);
    verifyTimeTransition(currentTimeMap, proposedTimeMap, nextGlobalRevision, transactionAt);
    const proposedSignalMap = validateSignalMap(parseArrayTableDocument(proposedSignalMapRead.text, "signals", "proposed startup signal projection"), manifest.instance_id, proposedSignalMapRead.byteLength);
    verifySignalMapTransition(currentSignalMap, proposedSignalMap, proposedSignal, signalSourceRef, nextGlobalRevision, transactionAt, proposedTimeMap);
    verifyProjectionClosure(cleanControl, proposedSignalMap, proposedTimeMap);

    const publicSnapshotRead = stableRead(repositoryReal, PUBLIC_SNAPSHOT_REF, DASHBOARD_SNAPSHOT_MAX_BYTES);
    const distSnapshotRead = stableRead(repositoryReal, DIST_SNAPSHOT_REF, DASHBOARD_SNAPSHOT_MAX_BYTES);
    const dashboard = buildMergedDashboardArtifacts(repositoryReal, {
      pendingControlRead: pendingRead, candidateRead, proposedIndexRead, proposedSignalRead,
      proposedTimeRead, proposedSignalMapRead, cleanControlRead: cleanRead,
      publicSnapshotRead, distSnapshotRead, transactionAt,
    });
    if (dashboard.truthDigests.length !== planPhases.length + 1) fail("merged truth checkpoint count is invalid");
    const proposedPublicSnapshotRead = proposedSnapshot(PUBLIC_SNAPSHOT_REF, dashboard.snapshotRead.buffer, DASHBOARD_SNAPSHOT_MAX_BYTES);
    const proposedDistSnapshotRead = proposedSnapshot(DIST_SNAPSHOT_REF, dashboard.snapshotRead.buffer, DASHBOARD_SNAPSHOT_MAX_BYTES);

    const preimages = [
      makeArtifact(CONTROL_REF, controlRead), makeArtifact(candidateSourceRef, sourceRead), makeArtifact(CANDIDATE_INDEX_REF, indexRead),
      makeArtifact(signalSourceRef, signalRead), makeArtifact(TIME_MAP_REF, timeMapRead), makeArtifact(SIGNAL_MAP_REF, signalMapRead),
      makeArtifact(PUBLIC_SNAPSHOT_REF, publicSnapshotRead), makeArtifact(DIST_SNAPSHOT_REF, distSnapshotRead),
    ];
    const steps = [
      makeStep(1, planPhases[0], CONTROL_REF, controlRead, pendingRead),
      makeStep(2, planPhases[1], candidateSourceRef, sourceRead, candidateRead),
      makeStep(3, planPhases[2], CANDIDATE_INDEX_REF, indexRead, proposedIndexRead),
      makeStep(4, planPhases[3], signalSourceRef, signalRead, proposedSignalRead),
      makeStep(5, planPhases[4], TIME_MAP_REF, timeMapRead, proposedTimeRead),
      makeStep(6, planPhases[5], SIGNAL_MAP_REF, signalMapRead, proposedSignalMapRead),
      makeStep(7, planPhases[6], PUBLIC_SNAPSHOT_REF, publicSnapshotRead, proposedPublicSnapshotRead),
      makeStep(8, planPhases[7], DIST_SNAPSHOT_REF, distSnapshotRead, proposedDistSnapshotRead),
      makeStep(9, planPhases[8], CONTROL_REF, pendingRead, cleanRead),
    ];
    const finalByTarget = new Map(preimages.map((item) => [item.target, item.digest]));
    for (const step of steps) finalByTarget.set(step.target, step.proposedDigest);
    const core = {
      schemaVersion: 1, planType: "cross-session-signal-transaction", decision: "transaction-preview", executable: false,
      authorization: "same-process-host-and-current-user-observation-receipt", contentIncluded: false,
      completeness: "digest-bound-plan-with-private-exact-byte-executor",
      operationId, instanceId: manifest.instance_id, transactionAt, eventKey, candidateId, candidateSourceRef, signalId, signalSourceRef,
      baseRevision: control.source_revision, nextRevision: nextGlobalRevision,
      preimages, steps, finalDigests: [...finalByTarget].map(([target, digest]) => ({ target, digest })),
      rollback: [...preimages].reverse().map((item) => ({ target: item.target, restoreDigest: item.digest })),
      requiredChecks: requiredPlanChecks,
      recoveryEvidence: "private-atomic-bundle-with-sealed-plan-exact-preimages-and-exact-step-bytes",
      failClosedAssumptions: CROSS_SESSION_SIGNAL_FAIL_CLOSED_ASSUMPTIONS,
      readSet: [MANIFEST_REF, CONTROL_REF, SIGNAL_MAP_REF, TIME_MAP_REF, CANDIDATE_INDEX_REF, candidateSourceRef,
        signalSourceRef, PUBLIC_SNAPSHOT_REF, DIST_SNAPSHOT_REF],
      truthDigests: dashboard.truthDigests,
      expiresAt: new Date(Date.parse(transactionAt) + PERSISTENT_TRANSACTION_TTL_MS).toISOString(),
    };
    const plan = sealPlan(core);
    trustedTransactionPayloads.set(plan, Object.freeze({
      repositoryReal, expiresAtMs: Date.parse(plan.expiresAt),
      preimages: new Map([
        [CONTROL_REF, Buffer.from(controlRead.buffer)], [candidateSourceRef, Buffer.from(sourceRead.buffer)],
        [CANDIDATE_INDEX_REF, Buffer.from(indexRead.buffer)], [signalSourceRef, Buffer.from(signalRead.buffer)],
        [TIME_MAP_REF, Buffer.from(timeMapRead.buffer)], [SIGNAL_MAP_REF, Buffer.from(signalMapRead.buffer)],
        [PUBLIC_SNAPSHOT_REF, Buffer.from(publicSnapshotRead.buffer)], [DIST_SNAPSHOT_REF, Buffer.from(distSnapshotRead.buffer)],
      ]),
      steps: new Map([
        [1, Buffer.from(pendingRead.buffer)], [2, Buffer.from(candidateRead.buffer)], [3, Buffer.from(proposedIndexRead.buffer)],
        [4, Buffer.from(proposedSignalRead.buffer)], [5, Buffer.from(proposedTimeRead.buffer)],
        [6, Buffer.from(proposedSignalMapRead.buffer)], [7, Buffer.from(proposedPublicSnapshotRead.buffer)],
        [8, Buffer.from(proposedDistSnapshotRead.buffer)], [9, Buffer.from(cleanRead.buffer)],
      ]),
    }));
    consumedEventReceipts.add(eventReceipt);
    return bindOperationalDerivedStateReport(plan, operationalGate.repair);
  } catch (error) {
    return deny("proposal-or-source-closure-invalid", { detail: error.message });
  }
}

const persistentRecordFields = new Set([
  "schemaVersion", "recordType", "operationId", "instanceId", "repositoryBinding", "createdAt", "expiresAt",
  "planDigest", "plan", "preimages", "steps",
]);
const persistentPayloadFields = new Set(["target", "file", "digest", "byteLength"]);
const persistentStepPayloadFields = new Set(["ordinal", "target", "file", "digest", "byteLength"]);

function repositoryBinding(repositoryReal) {
  const normalized = repositoryReal.normalize("NFC");
  return sha256(Buffer.from(process.platform === "win32" ? normalized.toLowerCase() : normalized, "utf8"));
}

function persistentRoot(repositoryReal, { create = true } = {}) {
  let cursor = repositoryReal;
  for (const part of PERSISTENT_TRANSACTION_DIR.split("/")) {
    cursor = resolve(cursor, part); ensureInside(repositoryReal, cursor);
    if (!existsSync(cursor)) {
      if (!create) return null;
      mkdirSync(cursor);
    }
    const info = lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("persistent transaction store crosses a link or non-directory");
  }
  return cursor;
}

function operationDirectory(repositoryReal, operationId, { allowMissing = false, createStore = true } = {}) {
  if (!stableAssetId.test(operationId ?? "")) fail("persistent transaction operation ID is invalid");
  const root = persistentRoot(repositoryReal, { create: createStore });
  if (!root) return null;
  const target = resolve(root, operationId); ensureInside(root, target);
  if (!existsSync(target)) {
    if (allowMissing) return target;
    fail("persistent transaction bundle is missing");
  }
  const info = lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("persistent transaction bundle is not one physical directory");
  return target;
}

function boundedPersistentEntries(root) {
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.length > PERSISTENT_STORE_MAX_OPERATIONS * 4) fail("persistent transaction store entry budget exceeded");
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail("persistent transaction store contains a link or reparse point");
    const operationDirectoryEntry = entry.isDirectory() && stableAssetId.test(entry.name);
    const atomicStageDirectory = entry.isDirectory() && /^\.stage-operation\.signal\.[a-f0-9]{24}-[a-f0-9]{12}$/u.test(entry.name);
    const operationLock = entry.isFile() && /^operation\.signal\.[a-f0-9]{24}\.lock$/u.test(entry.name);
    if (!operationDirectoryEntry && !atomicStageDirectory && !operationLock) fail("persistent transaction store contains an unrecognized entry");
  }
  return entries;
}

function stableReadAbsolute(target, maxBytes, label) {
  const pathInfo = lstatSync(target);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size > maxBytes) fail(`${label} exceeds its bound or is not a physical file`);
  const descriptor = openSync(target, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const buffer = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(target);
    if (offset !== buffer.length || !afterPath.isFile() || afterPath.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail(`${label} changed during bounded read`);
    return buffer;
  } finally { closeSync(descriptor); }
}

function writeDurableExclusive(target, bytes) {
  const descriptor = openSync(target, "wx", 0o600);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function syncDirectoryBestEffort(directory) {
  let descriptor;
  try { descriptor = openSync(directory, "r"); fsyncSync(descriptor); }
  catch (error) {
    if (!["EINVAL", "EPERM", "EISDIR", "ENOTSUP"].includes(error?.code)) throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function removeKnownBundleDirectory(root, target) {
  const parent = dirname(target); const name = target.slice(parent.length + 1);
  if (parent !== root || (!stableAssetId.test(name) && !/^\.stage-operation\.signal\.[a-f0-9]{24}-[a-f0-9]{12}$/u.test(name))) {
    fail("refused to remove an unexpected persistent transaction directory");
  }
  const info = lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("persistent transaction removal target is unsafe");
  const entries = readdirSync(target, { withFileTypes: true });
  if (entries.length > PERSISTENT_BUNDLE_MAX_FILES) fail("persistent transaction removal budget exceeded");
  for (const entry of entries) {
    const child = resolve(target, entry.name); const childInfo = lstatSync(child);
    if (!entry.isFile() || !childInfo.isFile() || childInfo.isSymbolicLink()) fail("persistent transaction bundle contains an unexpected nested object");
  }
  for (const entry of entries) unlinkSync(resolve(target, entry.name));
  rmdirSync(target);
}

function payloadFile(prefix, ordinal) {
  return `${prefix}-${String(ordinal).padStart(2, "0")}.bin`;
}

function validatePayloadFileName(value, prefix) {
  return typeof value === "string" && new RegExp(`^${prefix}-[0-9]{2}\\.bin$`, "u").test(value);
}

function readPersistentBundle(repositoryReal, operationId) {
  const directory = operationDirectory(repositoryReal, operationId, { createStore: false });
  const recordBytes = stableReadAbsolute(resolve(directory, "record.json"), PERSISTENT_RECORD_MAX_BYTES, "persistent transaction record");
  let record;
  try { record = JSON.parse(decode(recordBytes, "persistent transaction record")); }
  catch { fail("persistent transaction record is not valid JSON"); }
  if (!exactKeys(record, persistentRecordFields) || record.schemaVersion !== 1
    || record.recordType !== "cross-session-signal-runtime-transaction" || record.operationId !== operationId
    || record.instanceId !== record.plan?.instanceId || record.repositoryBinding !== repositoryBinding(repositoryReal)
    || record.createdAt !== record.plan?.transactionAt || record.expiresAt !== record.plan?.expiresAt
    || record.planDigest !== record.plan?.planDigest || !validateSealedPlan(record.plan)
    || !Array.isArray(record.preimages) || record.preimages.length !== record.plan.preimages.length
    || !Array.isArray(record.steps) || record.steps.length !== record.plan.steps.length) fail("persistent transaction record does not close against its sealed plan");
  const expectedNames = new Set(["record.json"]); const preimageBytes = new Map(); const stepBytes = new Map();
  let totalBytes = recordBytes.length;
  for (const [index, descriptor] of record.preimages.entries()) {
    const planned = record.plan.preimages[index];
    if (!exactKeys(descriptor, persistentPayloadFields) || descriptor.target !== planned.target
      || descriptor.digest !== planned.digest || descriptor.byteLength !== planned.byteLength
      || !validatePayloadFileName(descriptor.file, "preimage") || expectedNames.has(descriptor.file)) fail("persistent preimage descriptor is invalid");
    expectedNames.add(descriptor.file);
    const bytes = stableReadAbsolute(resolve(directory, descriptor.file), artifactLimit(descriptor.target), "persistent exact preimage");
    totalBytes += bytes.length;
    if (bytes.length !== descriptor.byteLength || sha256(bytes) !== descriptor.digest) fail("persistent exact preimage bytes drifted");
    preimageBytes.set(descriptor.target, bytes);
  }
  for (const [index, descriptor] of record.steps.entries()) {
    const planned = record.plan.steps[index];
    if (!exactKeys(descriptor, persistentStepPayloadFields) || descriptor.ordinal !== planned.ordinal
      || descriptor.target !== planned.target || descriptor.digest !== planned.proposedDigest
      || descriptor.byteLength !== planned.proposedByteLength || !validatePayloadFileName(descriptor.file, "step")
      || expectedNames.has(descriptor.file)) fail("persistent proposed-byte descriptor is invalid");
    expectedNames.add(descriptor.file);
    const bytes = stableReadAbsolute(resolve(directory, descriptor.file), artifactLimit(descriptor.target), "persistent exact proposed bytes");
    totalBytes += bytes.length;
    if (bytes.length !== descriptor.byteLength || sha256(bytes) !== descriptor.digest) fail("persistent exact proposed bytes drifted");
    stepBytes.set(descriptor.ordinal, bytes);
  }
  if (totalBytes > PERSISTENT_BUNDLE_MAX_BYTES) fail("persistent transaction bundle byte budget exceeded");
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length !== expectedNames.size || entries.length > PERSISTENT_BUNDLE_MAX_FILES
    || entries.some((entry) => !entry.isFile() || !expectedNames.has(entry.name))) fail("persistent transaction bundle contains unbound files");
  return { repositoryReal, directory, record, plan: record.plan, preimageBytes, stepBytes };
}

function persistTransactionBundle(repositoryReal, plan, payload) {
  if (!validateSealedPlan(plan) || payload?.repositoryReal !== repositoryReal || payload.expiresAtMs !== Date.parse(plan.expiresAt)) {
    fail("same-process trusted transaction payload is required");
  }
  const root = persistentRoot(repositoryReal); const target = operationDirectory(repositoryReal, plan.operationId, { allowMissing: true });
  if (existsSync(target)) {
    const existing = readPersistentBundle(repositoryReal, plan.operationId);
    if (existing.plan.planDigest !== plan.planDigest) fail("operation ID is already bound to a different persistent transaction");
    return existing;
  }
  const operationCount = boundedPersistentEntries(root)
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".stage-")).length;
  if (operationCount >= PERSISTENT_STORE_MAX_OPERATIONS) fail("persistent transaction store operation budget exceeded");
  const stage = resolve(root, `.stage-${plan.operationId}-${randomBytes(6).toString("hex")}`); ensureInside(root, stage);
  mkdirSync(stage, { mode: 0o700 });
  try {
    const preimages = []; const steps = [];
    for (const [index, item] of plan.preimages.entries()) {
      const bytes = payload.preimages.get(item.target); const file = payloadFile("preimage", index + 1);
      if (!Buffer.isBuffer(bytes) || bytes.length !== item.byteLength || sha256(bytes) !== item.digest) fail("trusted preimage payload does not match the sealed plan");
      writeDurableExclusive(resolve(stage, file), bytes);
      preimages.push({ target: item.target, file, digest: item.digest, byteLength: item.byteLength });
    }
    for (const step of plan.steps) {
      const bytes = payload.steps.get(step.ordinal); const file = payloadFile("step", step.ordinal);
      if (!Buffer.isBuffer(bytes) || bytes.length !== step.proposedByteLength || sha256(bytes) !== step.proposedDigest) fail("trusted proposed payload does not match the sealed plan");
      writeDurableExclusive(resolve(stage, file), bytes);
      steps.push({ ordinal: step.ordinal, target: step.target, file, digest: step.proposedDigest, byteLength: step.proposedByteLength });
    }
    const record = {
      schemaVersion: 1, recordType: "cross-session-signal-runtime-transaction", operationId: plan.operationId,
      instanceId: plan.instanceId, repositoryBinding: repositoryBinding(repositoryReal), createdAt: plan.transactionAt,
      expiresAt: plan.expiresAt, planDigest: plan.planDigest, plan, preimages, steps,
    };
    const recordBytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (recordBytes.length > PERSISTENT_RECORD_MAX_BYTES) fail("persistent transaction record exceeds its byte budget");
    writeDurableExclusive(resolve(stage, "record.json"), recordBytes);
    syncDirectoryBestEffort(stage); renameSync(stage, target); syncDirectoryBestEffort(root);
    return readPersistentBundle(repositoryReal, plan.operationId);
  } catch (error) {
    if (existsSync(stage)) removeKnownBundleDirectory(root, stage);
    throw error;
  }
}

function checkpointStates(plan) {
  const checkpoints = [new Map(plan.preimages.map((item) => [item.target, item.digest]))];
  for (const step of plan.steps) {
    const next = new Map(checkpoints.at(-1)); next.set(step.target, step.proposedDigest); checkpoints.push(next);
  }
  return checkpoints;
}

function swapPaths(repositoryReal, plan, step) {
  const target = resolveCheckedPath(repositoryReal, step.target, { allowMissing: true });
  const token = `${plan.planDigest.slice("sha256:".length, "sha256:".length + 16)}-${String(step.ordinal).padStart(2, "0")}`;
  return { target, stage: `${target}.cross-session-${token}.stage`, backup: `${target}.cross-session-${token}.backup` };
}

function absoluteDigest(target, maxBytes) {
  if (!existsSync(target)) return "absent";
  return sha256(stableReadAbsolute(target, maxBytes, "transaction swap artifact"));
}

function inspectAtomicSwap(repositoryReal, plan, observed) {
  const candidates = [];
  // Rollback swaps reverse a bound forward step, but their ordinal counts only
  // the targets restored by that rollback attempt (90..97). Enumerate that
  // bounded range for each target so interrupted old and new bundles recover
  // without inventing a write or changing the sealed plan format.
  const rollbackSteps = plan.rollback.flatMap((item) => {
    const forward = plan.steps.find((step) => step.target === item.target);
    const preimage = plan.preimages.find((entry) => entry.target === item.target);
    return plan.rollback.map((_, index) => ({
      ordinal: 90 + index, target: item.target, preconditionDigest: forward.proposedDigest,
      proposedDigest: item.restoreDigest, proposedByteLength: preimage.byteLength,
    }));
  });
  for (const step of [...plan.steps, ...rollbackSteps]) {
    const paths = swapPaths(repositoryReal, plan, step);
    const hasStage = existsSync(paths.stage); const hasBackup = existsSync(paths.backup);
    if (hasStage || hasBackup) candidates.push({ step, paths, hasStage, hasBackup });
  }
  if (candidates.length === 0) return { observed, repair: null };
  if (candidates.length !== 1) return { observed, repair: null, invalid: true };
  const item = candidates[0]; const limit = artifactLimit(item.step.target);
  const stageDigest = item.hasStage ? absoluteDigest(item.paths.stage, limit) : "absent";
  const backupDigest = item.hasBackup ? absoluteDigest(item.paths.backup, limit) : "absent";
  const targetDigest = observed.get(item.step.target);
  const virtual = new Map(observed); let repair = null;
  if (!item.hasBackup && stageDigest === item.step.proposedDigest && targetDigest === item.step.preconditionDigest) {
    repair = { kind: "delete-stage", ...item.paths, step: item.step }; virtual.set(item.step.target, item.step.preconditionDigest);
  } else if (backupDigest === item.step.preconditionDigest && targetDigest === "absent"
    && ["absent", item.step.proposedDigest].includes(stageDigest)) {
    repair = { kind: "restore-backup", ...item.paths, step: item.step }; virtual.set(item.step.target, item.step.preconditionDigest);
  } else if (backupDigest === item.step.preconditionDigest && targetDigest === item.step.proposedDigest
    && stageDigest === "absent") {
    repair = { kind: "delete-backup", ...item.paths, step: item.step }; virtual.set(item.step.target, item.step.proposedDigest);
  } else return { observed, repair: null, invalid: true };
  return { observed: virtual, repair };
}

function classifyPlanState(repositoryReal, plan) {
  if (!validateSealedPlan(plan)) return { state: "drift", checkpoint: -1, reason: "invalid-sealed-plan", repair: null };
  try {
    const manifest = manifestRoot(stableRead(repositoryReal, MANIFEST_REF, 2560).text);
    if (manifest.instance_id !== plan.instanceId) return { state: "drift", checkpoint: -1, reason: "instance-identity-drift", repair: null };
    const observed = new Map();
    for (const preimage of plan.preimages) {
      const snapshot = stableRead(repositoryReal, preimage.target, artifactLimit(preimage.target), { allowMissing: true });
      observed.set(preimage.target, snapshot?.digest ?? "absent");
    }
    const swap = inspectAtomicSwap(repositoryReal, plan, observed);
    if (swap.invalid) return { state: "drift", checkpoint: -1, reason: "unrecognized-atomic-swap-state", repair: null };
    const checkpoints = checkpointStates(plan);
    const matches = (expected) => expected.size === swap.observed.size
      && [...expected].every(([target, digest]) => swap.observed.get(target) === digest);
    const checkpoint = checkpoints.findIndex(matches);
    if (checkpoint < 0) return { state: "drift", checkpoint: -1, reason: "non-prefix-or-external-target-drift", repair: null };
    // Known swap carriers are temporary source-tree entries. Their byte-bound
    // repair comes first; resume/rollback immediately reclassify the clean tree
    // and verify its merged-truth digest before any further transaction write.
    if (!swap.repair) {
      const truth = computeSnapshotSourceDigest(repositoryReal, { mode: "operational",
        requiredSourceRefs: plan.steps.map((step) => step.target) }).digest;
      if (truth !== plan.truthDigests[checkpoint]) return { state: "drift", checkpoint, reason: "merged-truth-source-drift", repair: swap.repair };
    }
    if (swap.repair) return { state: "prefix", checkpoint, reason: "atomic-swap-repair-required", repair: swap.repair };
    return { state: checkpoint === 0 ? "preimage" : checkpoint === plan.steps.length ? "final" : "prefix",
      checkpoint, reason: "", repair: null };
  } catch (error) {
    return { state: "drift", checkpoint: -1, reason: error.message, repair: null };
  }
}

function applyAtomicSwapRepair(repair) {
  if (!repair) return;
  if (repair.kind === "delete-stage") unlinkSync(repair.stage);
  else if (repair.kind === "restore-backup") {
    if (existsSync(repair.stage)) unlinkSync(repair.stage);
    if (existsSync(repair.target)) fail("atomic swap repair target unexpectedly exists");
    renameSync(repair.backup, repair.target);
  } else if (repair.kind === "delete-backup") unlinkSync(repair.backup);
  else fail("unknown atomic swap repair");
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function acquireOperationLock(repositoryReal, operationId) {
  const root = persistentRoot(repositoryReal); const target = resolve(root, `${operationId}.lock`); ensureInside(root, target);
  const token = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeDurableExclusive(target, Buffer.from(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token })}\n`, "utf8"));
      return { target, token };
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      let stale = false;
      try {
        const value = JSON.parse(decode(stableReadAbsolute(target, 2048, "persistent transaction lock"), "persistent transaction lock"));
        stale = !processAlive(value.pid) && Date.now() - Date.parse(value.createdAt) > 0;
      } catch { stale = statSync(target).mtimeMs < Date.now() - PERSISTENT_LOCK_STALE_MS; }
      if (!stale) fail("persistent transaction is busy");
      unlinkSync(target);
    }
  }
  fail("persistent transaction lock could not be acquired");
}

function releaseOperationLock(lock) {
  if (!lock || !existsSync(lock.target)) return;
  try {
    const value = JSON.parse(decode(stableReadAbsolute(lock.target, 2048, "persistent transaction lock"), "persistent transaction lock"));
    if (value.token === lock.token) unlinkSync(lock.target);
  } catch { /* A changed lock is preserved for bounded recovery. */ }
}

function physicalPlanTarget(repositoryReal, ref) {
  if (typeof ref !== "string" || ref.includes("\\") || ref.includes(":") || isAbsolute(ref)
    || ref.split("/").some((part) => part === "" || part === "." || part === "..")) fail("transaction target is not portable");
  const parts = ref.split("/"); let cursor = repositoryReal;
  for (const part of parts.slice(0, -1)) {
    cursor = resolve(cursor, part); ensureInside(repositoryReal, cursor);
    if (!existsSync(cursor)) mkdirSync(cursor);
    const info = lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("transaction target parent is unsafe");
  }
  const target = resolve(repositoryReal, ...parts); ensureInside(repositoryReal, target);
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) fail("transaction target is not a physical file");
  }
  return target;
}

function atomicPlanStep(repositoryReal, plan, step, content) {
  const target = physicalPlanTarget(repositoryReal, step.target); const paths = swapPaths(repositoryReal, plan, step);
  if (existsSync(paths.stage) || existsSync(paths.backup)) fail(`unreconciled atomic swap exists at step ${step.ordinal}`);
  const current = stableRead(repositoryReal, step.target, artifactLimit(step.target), { allowMissing: true });
  if ((current?.digest ?? "absent") !== step.preconditionDigest) fail(`transaction precondition drifted at step ${step.ordinal}`);
  if (!Buffer.isBuffer(content) || content.length !== step.proposedByteLength || sha256(content) !== step.proposedDigest) {
    fail(`persistent proposed bytes are invalid at step ${step.ordinal}`);
  }
  writeDurableExclusive(paths.stage, content);
  try {
    if (existsSync(target)) renameSync(target, paths.backup);
    renameSync(paths.stage, target);
    const installed = stableRead(repositoryReal, step.target, artifactLimit(step.target));
    if (installed.digest !== step.proposedDigest) fail(`transaction readback failed at step ${step.ordinal}`);
    if (existsSync(paths.backup)) unlinkSync(paths.backup);
  } catch (error) {
    if (existsSync(paths.stage)) unlinkSync(paths.stage);
    if (existsSync(paths.backup)) {
      if (existsSync(target)) unlinkSync(target);
      renameSync(paths.backup, target);
    }
    throw error;
  }
}

function inspectSummary(loaded, state) {
  return deepFreeze({ decision: "persistent-cross-session-signal-transaction-inspected", executable: false,
    operationId: loaded.plan.operationId, planDigest: loaded.plan.planDigest, state: state.state,
    checkpoint: Math.max(0, state.checkpoint), stepCount: loaded.plan.steps.length,
    expired: Date.now() > Date.parse(loaded.plan.expiresAt), reason: state.reason,
    atomicRepairRequired: Boolean(state.repair), recoveryEvidencePreserved: true });
}

export function inspectPersistentCrossSessionSignalTransaction(repository, { operationId = "" } = {}) {
  try {
    const repositoryReal = realpathSync(repository);
    if (operationId) {
      const loaded = readPersistentBundle(repositoryReal, operationId);
      return inspectSummary(loaded, classifyPlanState(repositoryReal, loaded.plan));
    }
    const root = persistentRoot(repositoryReal, { create: false });
    if (!root) return deepFreeze({ decision: "persistent-cross-session-signal-transactions-inspected", executable: false,
      operationCount: 0, transactions: [] });
    const operationIds = boundedPersistentEntries(root)
      .filter((entry) => entry.isDirectory() && stableAssetId.test(entry.name)).map((entry) => entry.name).sort();
    if (operationIds.length > PERSISTENT_STORE_MAX_OPERATIONS) fail("persistent transaction inspection budget exceeded");
    const transactions = operationIds.map((id) => {
      try {
        const loaded = readPersistentBundle(repositoryReal, id); const state = classifyPlanState(repositoryReal, loaded.plan);
        return { operationId: id, state: state.state, checkpoint: Math.max(0, state.checkpoint), expired: Date.now() > Date.parse(loaded.plan.expiresAt) };
      } catch { return { operationId: id, state: "drift", checkpoint: 0, expired: false }; }
    });
    return deepFreeze({ decision: "persistent-cross-session-signal-transactions-inspected", executable: false,
      operationCount: transactions.length, transactions });
  } catch (error) {
    return deepFreeze({ decision: "persistent-cross-session-signal-inspect-denied", reason: error.message, executable: false });
  }
}

function verifyFinalDashboard(repositoryReal, plan) {
  const publicRead = stableRead(repositoryReal, PUBLIC_SNAPSHOT_REF, DASHBOARD_SNAPSHOT_MAX_BYTES);
  const distRead = stableRead(repositoryReal, DIST_SNAPSHOT_REF, DASHBOARD_SNAPSHOT_MAX_BYTES);
  if (publicRead.digest !== distRead.digest || publicRead.digest !== new Map(plan.finalDigests.map((item) => [item.target, item.digest])).get(PUBLIC_SNAPSHOT_REF)) {
    fail("dashboard snapshot pair is not byte-identical at the sealed final digest");
  }
  const rebuilt = buildSnapshotCandidate(repositoryReal, { existingSource: publicRead.text, now: new Date(plan.transactionAt),
    mode: "operational", requiredSourceRefs: plan.steps.map((step) => step.target) });
  if (rebuilt.updated || rebuilt.source !== publicRead.text || rebuilt.sourceDigest !== plan.truthDigests.at(-1)) {
    fail("dashboard snapshot pair is not the exact merged-truth rebuild");
  }
}

function resumePersistentCrossSessionSignalTransactionLocked(repository, { operationId } = {}, { hooks = {} } = {}) {
  let lock; let loaded;
  try {
    const repositoryReal = realpathSync(repository); lock = acquireOperationLock(repositoryReal, operationId);
    loaded = readPersistentBundle(repositoryReal, operationId);
    let state = classifyPlanState(repositoryReal, loaded.plan);
    if (state.repair) { applyAtomicSwapRepair(state.repair); state = classifyPlanState(repositoryReal, loaded.plan); }
    if (state.state === "drift") return deepFreeze({ decision: "persistent-cross-session-signal-resume-recovery-required",
      executable: false, operationId, reason: state.reason, recoveryEvidencePreserved: true });
    if (state.state === "final") {
      verifyFinalDashboard(repositoryReal, loaded.plan);
      return deepFreeze({ decision: "persistent-cross-session-signal-resume-complete", executable: false,
        operationId, planDigest: loaded.plan.planDigest, idempotent: true, checkpoint: loaded.plan.steps.length, writeCount: 0,
        recoveryEvidencePreserved: true });
    }
    if (state.state === "preimage" && Date.now() > Date.parse(loaded.plan.expiresAt)) {
      return deepFreeze({ decision: "persistent-cross-session-signal-resume-expired-unstarted", executable: false,
        operationId, checkpoint: 0, recoveryEvidencePreserved: true });
    }
    let writeCount = 0;
    for (const step of loaded.plan.steps.slice(state.checkpoint)) {
      const digestOptions = { mode: "operational", requiredSourceRefs: loaded.plan.steps.map((item) => item.target) };
      const beforeTruth = computeSnapshotSourceDigest(repositoryReal, digestOptions).digest;
      if (beforeTruth !== loaded.plan.truthDigests[step.ordinal - 1]) fail(`merged truth drifted before step ${step.ordinal}`);
      atomicPlanStep(repositoryReal, loaded.plan, step, loaded.stepBytes.get(step.ordinal)); writeCount += 1;
      const afterTruth = computeSnapshotSourceDigest(repositoryReal, digestOptions).digest;
      if (afterTruth !== loaded.plan.truthDigests[step.ordinal]) fail(`merged truth drifted after step ${step.ordinal}`);
      awaitMaybe(hooks.afterStep, { ordinal: step.ordinal, phase: step.phase, checkpoint: step.ordinal });
    }
    state = classifyPlanState(repositoryReal, loaded.plan);
    if (state.state !== "final") fail("transaction did not reach its exact final state");
    verifyFinalDashboard(repositoryReal, loaded.plan);
    return deepFreeze({ decision: "persistent-cross-session-signal-resume-complete", executable: false,
      operationId, planDigest: loaded.plan.planDigest, idempotent: false, checkpoint: loaded.plan.steps.length,
      writeCount, recoveryEvidencePreserved: true });
  } catch (error) {
    let state;
    try { if (loaded) state = classifyPlanState(loaded.repositoryReal, loaded.plan); } catch { /* preserve bundle */ }
    return deepFreeze({ decision: ["prefix", "final"].includes(state?.state) ? "persistent-cross-session-signal-resume-interrupted"
      : "persistent-cross-session-signal-resume-denied", reason: error.message, executable: false,
    operationId: operationId ?? "", checkpoint: Math.max(0, state?.checkpoint ?? 0), recoveryEvidencePreserved: Boolean(loaded) });
  } finally { releaseOperationLock(lock); }
}

function awaitMaybe(callback, value) {
  if (!callback) return;
  const result = callback(value);
  if (result && typeof result.then === "function") fail("cross-session transaction hooks must be synchronous");
}

function executeCrossSessionSignalTransactionLocked(repository, plan, { hooks = {} } = {}) {
  try {
    const repositoryReal = realpathSync(repository); const payload = trustedTransactionPayloads.get(plan);
    if (!payload || payload.repositoryReal !== repositoryReal || !validateSealedPlan(plan)) fail("same-process trusted sealed plan is required");
    persistTransactionBundle(repositoryReal, plan, payload);
    return resumePersistentCrossSessionSignalTransaction(repositoryReal, { operationId: plan.operationId }, { hooks });
  } catch (error) {
    return deepFreeze({ decision: "cross-session-signal-execution-denied", reason: error.message,
      executable: false, operationId: plan?.operationId ?? "", recoveryEvidencePreserved: false });
  }
}

function rollbackPersistentCrossSessionSignalTransactionLocked(repository, { operationId } = {}) {
  let lock; let loaded;
  try {
    const repositoryReal = realpathSync(repository); lock = acquireOperationLock(repositoryReal, operationId);
    loaded = readPersistentBundle(repositoryReal, operationId);
    let state = classifyPlanState(repositoryReal, loaded.plan);
    if (state.repair) { applyAtomicSwapRepair(state.repair); state = classifyPlanState(repositoryReal, loaded.plan); }
    if (state.state === "drift") return deepFreeze({ decision: "persistent-cross-session-signal-rollback-recovery-required",
      executable: false, operationId, reason: state.reason, recoveryEvidencePreserved: true });
    if (state.state === "final") return deepFreeze({ decision: "persistent-cross-session-signal-rollback-already-committed",
      executable: false, operationId, idempotent: true, recoveryEvidencePreserved: true });
    if (state.state === "preimage") return deepFreeze({ decision: "persistent-cross-session-signal-rollback-complete",
      executable: false, operationId, idempotent: true, restoredTargetCount: 0, recoveryEvidencePreserved: true });
    let restoredTargetCount = 0;
    const current = new Map();
    for (const preimage of loaded.plan.preimages) {
      current.set(preimage.target, stableRead(repositoryReal, preimage.target, artifactLimit(preimage.target), { allowMissing: true })?.digest ?? "absent");
    }
    for (const item of loaded.plan.rollback) {
      if (current.get(item.target) === item.restoreDigest) continue;
      const bytes = loaded.preimageBytes.get(item.target);
      const synthetic = { ordinal: 90 + restoredTargetCount, target: item.target, preconditionDigest: current.get(item.target),
        proposedDigest: item.restoreDigest, proposedByteLength: bytes.length };
      atomicPlanStep(repositoryReal, loaded.plan, synthetic, bytes); current.set(item.target, item.restoreDigest); restoredTargetCount += 1;
    }
    const restored = classifyPlanState(repositoryReal, loaded.plan);
    if (restored.state !== "preimage") fail("rollback did not restore every exact preimage and merged truth digest");
    return deepFreeze({ decision: "persistent-cross-session-signal-rollback-complete", executable: false,
      operationId, idempotent: false, restoredTargetCount, recoveryEvidencePreserved: true });
  } catch (error) {
    return deepFreeze({ decision: "persistent-cross-session-signal-rollback-denied", reason: error.message,
      executable: false, operationId: operationId ?? "", recoveryEvidencePreserved: Boolean(loaded) });
  } finally { releaseOperationLock(lock); }
}

function closePersistentCrossSessionSignalTransactionLocked(repository, { operationId } = {}) {
  let lock;
  try {
    const repositoryReal = realpathSync(repository); lock = acquireOperationLock(repositoryReal, operationId);
    const loaded = readPersistentBundle(repositoryReal, operationId); const state = classifyPlanState(repositoryReal, loaded.plan);
    if (state.state === "prefix") return deepFreeze({ decision: "persistent-cross-session-signal-close-rollback-required",
      executable: false, operationId, checkpoint: state.checkpoint, recoveryEvidencePreserved: true });
    if (state.state === "drift") return deepFreeze({ decision: "persistent-cross-session-signal-close-recovery-required",
      executable: false, operationId, reason: state.reason, recoveryEvidencePreserved: true });
    const root = persistentRoot(repositoryReal); removeKnownBundleDirectory(root, loaded.directory);
    return deepFreeze({ decision: "persistent-cross-session-signal-closed", executable: false,
      operationId, priorState: state.state, operationalBundleRemoved: true });
  } catch (error) {
    return deepFreeze({ decision: "persistent-cross-session-signal-close-denied", reason: error.message,
      executable: false, operationId: operationId ?? "" });
  } finally { releaseOperationLock(lock); }
}

function cleanupExpiredPersistentCrossSessionSignalTransactionsLocked(repository, { now = new Date() } = {}) {
  try {
    const repositoryReal = realpathSync(repository); const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(nowMs)) fail("persistent cleanup time is invalid");
    cleanupStaleSnapshotProjectionRoots(repositoryReal);
    const root = persistentRoot(repositoryReal, { create: false });
    if (!root) return deepFreeze({ decision: "persistent-cross-session-signal-cleanup-complete", executable: false,
      inspectedCount: 0, removedCount: 0, orphanStageRemovedCount: 0, rollbackRequiredCount: 0, recoveryRequiredCount: 0 });
    const storeEntries = boundedPersistentEntries(root);
    const ids = storeEntries.filter((entry) => entry.isDirectory() && stableAssetId.test(entry.name))
      .map((entry) => entry.name).sort();
    if (ids.length > PERSISTENT_STORE_MAX_OPERATIONS) fail("persistent cleanup operation budget exceeded");
    let removedCount = 0; let orphanStageRemovedCount = 0; let rollbackRequiredCount = 0; let recoveryRequiredCount = 0;
    for (const entry of storeEntries.filter((item) => item.isDirectory() && item.name.startsWith(".stage-"))) {
      const stage = resolve(root, entry.name);
      if (statSync(stage).mtimeMs + PERSISTENT_TRANSACTION_TTL_MS > nowMs) continue;
      try { removeKnownBundleDirectory(root, stage); orphanStageRemovedCount += 1; }
      catch { recoveryRequiredCount += 1; }
    }
    for (const operationId of ids) {
      let lock;
      try {
        const loaded = readPersistentBundle(repositoryReal, operationId);
        if (Date.parse(loaded.plan.expiresAt) > nowMs) continue;
        lock = acquireOperationLock(repositoryReal, operationId);
        const state = classifyPlanState(repositoryReal, loaded.plan);
        if (["preimage", "final"].includes(state.state)) {
          removeKnownBundleDirectory(root, loaded.directory); removedCount += 1;
        } else if (state.state === "prefix") rollbackRequiredCount += 1;
        else recoveryRequiredCount += 1;
      } catch { recoveryRequiredCount += 1; }
      finally { releaseOperationLock(lock); }
    }
    const decision = recoveryRequiredCount > 0 ? "persistent-cross-session-signal-cleanup-recovery-required"
      : rollbackRequiredCount > 0 ? "persistent-cross-session-signal-cleanup-rollback-required"
        : "persistent-cross-session-signal-cleanup-complete";
    return deepFreeze({ decision, executable: false, inspectedCount: ids.length, removedCount, orphanStageRemovedCount,
      rollbackRequiredCount, recoveryRequiredCount });
  } catch (error) {
    return deepFreeze({ decision: "persistent-cross-session-signal-cleanup-denied", reason: error.message, executable: false });
  }
}

// Operation IDs identify recovery bundles, not the shared control/index write
// set. Hold the instance lock across fresh reads, repairs, writes, and cleanup;
// nested execute -> resume and plan -> repair calls reuse the same lease.
function withSignalWriteLock(repository, operation, failure, callback) {
  try { return withInstanceWriteLock(repository, `cross-session-signal-${operation}`, callback); }
  catch (error) {
    return deepFreeze({ ...failure, executable: false,
      reason: error?.code === "AI_CARRY_INSTANCE_WRITE_BUSY" ? "instance-write-busy" : "instance-write-unavailable",
      detail: String(error?.message ?? error), ordinaryTasksContinue: true, affectedScope: "cross-session-signals-only" });
  }
}

export function repairOperationalDerivedStateOnce(repository, options = {}) {
  return withSignalWriteLock(repository, "derived-repair", {
    decision: "operational-derived-state-related-capability-paused", attempted: false, repairedTargetCount: 0,
    pausedCapabilities: ["cross-session-signals"], userReport: derivedStateUserReport("paused"),
  }, () => repairOperationalDerivedStateOnceLocked(repository, options));
}

export function buildCrossSessionSignalTransactionPlan(repository, request = {}) {
  return withSignalWriteLock(repository, "plan", { decision: "transaction-denied" },
    () => buildCrossSessionSignalTransactionPlanLocked(repository, request));
}

export function executeCrossSessionSignalTransaction(repository, plan, options = {}) {
  return withSignalWriteLock(repository, "execute", {
    decision: "cross-session-signal-execution-denied", operationId: plan?.operationId ?? "",
  }, () => executeCrossSessionSignalTransactionLocked(repository, plan, options));
}

export function resumePersistentCrossSessionSignalTransaction(repository, request = {}, options = {}) {
  return withSignalWriteLock(repository, "resume", {
    decision: "persistent-cross-session-signal-resume-denied", operationId: request.operationId ?? "",
  }, () => resumePersistentCrossSessionSignalTransactionLocked(repository, request, options));
}

export function rollbackPersistentCrossSessionSignalTransaction(repository, request = {}) {
  return withSignalWriteLock(repository, "rollback", {
    decision: "persistent-cross-session-signal-rollback-denied", operationId: request.operationId ?? "",
  }, () => rollbackPersistentCrossSessionSignalTransactionLocked(repository, request));
}

export function closePersistentCrossSessionSignalTransaction(repository, request = {}) {
  return withSignalWriteLock(repository, "close", {
    decision: "persistent-cross-session-signal-close-denied", operationId: request.operationId ?? "",
  }, () => closePersistentCrossSessionSignalTransactionLocked(repository, request));
}

export function cleanupExpiredPersistentCrossSessionSignalTransactions(repository, options = {}) {
  return withSignalWriteLock(repository, "cleanup", { decision: "persistent-cross-session-signal-cleanup-denied" },
    () => cleanupExpiredPersistentCrossSessionSignalTransactionsLocked(repository, options));
}

export function inspectCrossSessionSignalRecovery(repository, plan, { strategy = "resume" } = {}) {
  if (!validateSealedPlan(plan) || !["resume", "rollback"].includes(strategy)) {
    return deepFreeze({ decision: "recovery-required", reason: "untrusted-or-invalid-plan", executable: false });
  }
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); }
  catch { return deepFreeze({ decision: "recovery-required", reason: "repository-unavailable", executable: false, planDigest: plan.planDigest }); }
  const state = classifyPlanState(repositoryReal, plan);
  if (state.state === "final") return deepFreeze({ decision: "transaction-complete", reason: "all-final-digests-match",
    idempotent: true, executable: false, planDigest: plan.planDigest });
  if (state.state === "preimage") return deepFreeze({ decision: "transaction-not-started", reason: "all-preimage-digests-match",
    retrySafe: true, executable: false, planDigest: plan.planDigest, nextSteps: plan.steps });
  if (state.state === "drift") return deepFreeze({ decision: "recovery-required", reason: state.reason,
    preserveEvidence: true, executable: false, planDigest: plan.planDigest });
  if (strategy === "resume") return deepFreeze({ decision: "transaction-resume-required", checkpoint: state.checkpoint,
    nextSteps: plan.steps.slice(state.checkpoint), executable: false, planDigest: plan.planDigest });
  const checkpoints = checkpointStates(plan); const observed = checkpoints[state.checkpoint];
  const rollbackSteps = plan.rollback.filter((item) => observed.get(item.target) !== item.restoreDigest);
  return deepFreeze({ decision: "transaction-rollback-required", reason: "explicit-failure-rollback", checkpoint: state.checkpoint,
    rollbackSteps, verifyAllPreimagesAfterRollback: true, executable: false, planDigest: plan.planDigest });
}

export function validateCrossSessionSignalTransactionPlan(plan) {
  return validateSealedPlan(plan);
}
