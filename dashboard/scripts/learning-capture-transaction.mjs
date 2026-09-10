import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  parseArrayTableDocument,
  parseMarkdownFrontmatterHead,
  parseSectionedToml,
  findPotentialFormalDuplicates,
  loadTrustedDomainEnvelope,
  prepareNewFormalTarget,
  stableAssetId,
  trustedMaintenanceStateDigest,
  validateInstanceManifestStructure,
  validateProposedFormalAsset,
  verifyNewFormalTarget,
} from "./asset-route-contract.mjs";
import { buildSnapshotCandidate, computeSnapshotSourceDigest } from "./snapshot-source-builder.mjs";
import { normalizeRetrievalRequest, rankRetrievalEntries } from "./bounded-retrieval.mjs";
import { containsForbiddenLocationReference } from "./safe-output-boundary.mjs";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";
import {
  bindOperationalDerivedStateReport,
  getOperationalDerivedStateReport,
  operationalDerivedStateGate,
} from "./cross-session-signal-transaction.mjs";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const choices = new Set(["keep", "observe", "remind", "discard"]);
const transactionChoices = new Set([...choices, "cancel-reminder"]);
const formalKinds = new Set(["memory", "capability", "sop", "experience"]);
const candidateKinds = new Set([...formalKinds, "preference"]);
const candidateRelations = new Set(["new", "refine", "condition-variant", "related"]);
const riskTiers = new Set(["low", "medium", "high"]);

const MANIFEST_REF = "instance/manifest.toml";
const CONTROL_REF = "instance/signals/control.toml";
const SIGNAL_MAP_REF = "instance/maps/signal-map.toml";
const TIME_MAP_REF = "instance/maps/time-trigger-map.toml";
const CANDIDATE_INDEX_REF = "instance/evolution/index.toml";
const DOMAIN_MAP_REF = "instance/maps/domain-map.toml";
const PUBLIC_SNAPSHOT_REF = "dashboard/public/snapshot.js";
const DIST_SNAPSHOT_REF = "dashboard/dist/snapshot.js";
const PERSISTENT_CAPTURE_DIR = ".assistant-local/runtime/learning-capture";
const PROJECTION_MARKER = ".ai-carry-projection-owner.json";
const PROJECTION_TTL_MS = 30 * 60_000;
const projectionPrefixes = Object.freeze({
  "direct-keep": ".ai-carry-direct-keep-projection-",
  "candidate-snapshot": ".ai-carry-learning-capture-snapshot-",
});
const projectionMarkerFields = new Set([
  "schema_version", "record_type", "repository_binding", "projection_kind", "created_at", "nonce", "state",
]);
const persistentRecordFields = new Set([
  "schema_version", "record_type", "challenge_id", "instance_id", "repository_binding",
  "proposal_digest", "formal_preview_digest", "observation_digest", "state_digest", "challenge_nonce", "issued_at", "expires_at",
  "direct_keep_mode", "status", "message_ref", "message_digest", "choice", "remind_at", "plan_digest", "plan_ref",
]);

const limits = Object.freeze({
  manifest: 16 * 1024,
  control: 4 * 1024,
  candidateIndex: 32 * 1024,
  candidateSource: 32 * 1024,
  signalSource: 32 * 1024,
  signalMap: 1536,
  timeMap: 32 * 1024,
  formalPreview: 128 * 1024,
  reviewPayload: 256 * 1024,
  domainMap: 49_152,
  snapshot: 8 * 1024 * 1024,
});

const proposalFields = new Set([
  "title", "summary", "triggers", "aliases", "scope", "conditions", "excludes",
  "topic_key", "subject_key", "target_kind", "target_subtype",
  "claim_summary", "proposed_risk_tier", "minimum_level", "formal_preview",
]);
const receiptFields = new Set([
  "basis", "message_ref", "message_digest", "user_message_at", "confirmed_at", "choice",
  "remind_at", "instance_id", "proposal_digest", "challenge_nonce",
]);
const receiptRequiredFields = new Set([
  "basis", "message_ref", "message_digest", "choice", "instance_id", "proposal_digest", "challenge_nonce",
]);
const controlFields = new Set([
  "schema_version", "record_type", "instance_id", "source_revision", "projection_revision",
  "update_state", "pending_operation_id", "pending_event_id", "pending_signal_id",
  "pending_trigger_id", "pending_source_ref", "base_revision", "updated_at",
]);
const candidateIndexRootFields = new Set([
  "schema_version", "index_id", "instance_id", "state", "source_revision", "generated_at",
  "budget_bytes", "overflow", "candidate_count", "indexed_count", "active_count",
]);
const candidateEntryFields = new Set([
  "id", "title", "summary", "topic_key", "subject_key", "triggers", "aliases", "scope",
  "conditions", "excludes", "target_kind", "target_subtype", "candidate_relation", "status",
  "observation_state", "observation_basis", "risk_tier", "independent_event_count",
  "last_evidence_at", "source_ref", "source_revision",
]);
const signalMapRootFields = new Set([
  "schema_version", "map_id", "instance_id", "state", "source_revision", "generated_at",
  "budget_bytes", "overflow", "active_count", "scheduled_count", "next_wakeup_at",
  "next_wakeup_ref",
]);
const signalProjectionFields = new Set([
  "id", "signal_type", "status", "reason", "progress", "next_event", "domain", "route_id",
  "source_ref", "source_signal_revision", "provenance", "trust_state", "minimum_level", "confirmation",
]);
const timeMapRootFields = new Set([
  "schema_version", "map_id", "instance_id", "state", "source_revision", "generated_at",
  "scheduled_count", "next_wakeup_at",
]);
const timeTriggerFields = new Set([
  "id", "kind", "status", "title", "next_check_at", "effective_check_at", "domain",
  "route_id", "source_ref", "source_trigger_revision", "minimum_level", "confirmation",
]);
const candidateSourceFields = new Set([
  "id", "kind", "status", "title", "summary", "triggers", "scope", "excludes", "lifecycle", "expected_next_use",
  "topic_key", "subject_key", "aliases", "conditions", "target_kind", "target_subtype", "candidate_relation",
  "observation_state", "observation_basis", "observation_event_ref", "claim_summary", "proposed_risk_tier",
  "independent_event_count", "successful_event_count", "failed_event_count", "distinct_context_count",
  "representative_event_ids", "last_evidence_at", "remind_at", "snoozed_until", "trigger_revision", "source_revision",
  "source_refs", "private_refs", "supersedes", "minimum_level", "approval_state", "activation_basis", "risk_tier",
  "approved_by_user", "updated_at",
]);
const signalRootFields = new Set([
  "schema_version", "record_type", "id", "signal_type", "evaluation_family", "status", "title", "reason",
  "domain", "route_id", "revision", "created_at", "updated_at", "last_verified_at", "asset_refs",
  "candidate_source_revision", "related_signal_ids", "minimum_level", "confirmation", "provenance", "trust_state",
]);
const signalMatchFields = new Set(["asset_kind", "subject", "claim", "scope", "conditions", "aliases"]);
const signalTriggerFields = new Set(["mode", "independent_event_count", "threshold_value", "progress_summary", "next_event", "next_check_at"]);
const signalEvidenceFields = new Set(["event_id", "event_source", "task_id", "context_id", "occurred_at", "source_kind", "source_ref", "independent", "relation", "summary"]);
const cancellationReceiptFields = new Set([
  "basis", "message_ref", "message_digest", "user_message_at", "confirmed_at", "candidate_id", "instance_id", "challenge_nonce",
]);
const cancellationReceiptRequiredFields = new Set([
  "basis", "message_ref", "message_digest", "candidate_id", "instance_id", "challenge_nonce",
]);
const observationAssertionFields = new Set([
  "basis", "source_kind", "task_ref_digest", "context_ref_digest", "occurred_at", "result_state",
]);
// HOST_INTEGRATION owns these provenance names. Prompt-only callers and old
// aliases must be downgraded before they reach this producer; newly persisted
// learning evidence is always written with one canonical source kind.
const observationSourceKinds = new Set([
  "connected-host-observation", "host-collaborative-memory", "model-inference", "external-content", "unknown",
]);
const observationResultStates = new Set(["closed-result-checked", "closed-unverified"]);
const trustedChallenges = new WeakMap();
const trustedSelections = new WeakMap();
const trustedPlans = new WeakMap();
const consumedSelections = new WeakSet();
const consumedMessageRefs = new Map();
const trustedCancellationChallenges = new WeakMap();
const trustedCancellations = new WeakMap();
const consumedCancellations = new WeakSet();
const trustedObservationReceipts = new WeakMap();
const consumedObservationReceipts = new WeakSet();
const trustedReminderShortlists = new WeakMap();
const consumedReminderShortlists = new WeakSet();

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function clean(value, max, allowEmpty = true) {
  return typeof value === "string" && (allowEmpty || value.length > 0) && [...value].length <= max
    && value.normalize("NFC") === value && !unsafeText.test(value);
}

function cleanList(value, maxItems, maxChars) {
  return Array.isArray(value) && value.length <= maxItems && new Set(value).size === value.length
    && value.every((item) => clean(item, maxChars, false));
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

function exactKeys(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.size
    && Object.keys(value).every((key) => fields.has(key));
}

function compatibleReceipt(value, requiredFields, knownFields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && [...requiredFields].every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => knownFields.has(key));
}

function strictDate(value) {
  return clean(value, 64, false) && /[zZ]|[+-]\d{2}:\d{2}$/u.test(value) && Number.isFinite(Date.parse(value));
}

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function sha256(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function portableRef(ref, { prefix, extension }) {
  return clean(ref, 240, false) && ref.startsWith(prefix) && ref.endsWith(extension)
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(ref) && !ref.includes("\\") && !ref.includes(":")
    && !ref.includes("?") && !ref.includes("#")
    && ref.split("/").every((part) => part && part !== "." && part !== ".." && !/[. ]$/u.test(part));
}

function decode(buffer, label) {
  try { return utf8Decoder.decode(buffer); }
  catch { throw new Error(`${label} is not valid UTF-8`); }
}

function ensureInside(repositoryReal, absolute) {
  const rel = relative(repositoryReal, absolute);
  if (rel === "") return;
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("target escaped the AI Carry repository");
  if (resolve(repositoryReal, rel) !== resolve(absolute)) throw new Error("target containment cannot be proved");
}

function verifyExistingParents(repositoryReal, ref) {
  let cursor = repositoryReal;
  for (const segment of ref.split("/").slice(0, -1)) {
    cursor = resolve(cursor, segment);
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) throw new Error(`${ref} uses a linked parent`);
      if (!info.isDirectory()) throw new Error(`${ref} parent is not a directory`);
      ensureInside(repositoryReal, realpathSync(cursor));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

function stableRead(repositoryReal, ref, maxBytes, { allowMissing = false } = {}) {
  const extension = ref.slice(ref.lastIndexOf("."));
  const permitted = portableRef(ref, { prefix: "instance/", extension })
    || [PUBLIC_SNAPSHOT_REF, DIST_SNAPSHOT_REF, "assistant.toml", "core/manifest.toml",
      "core/maps/asset-confirmation-gates.toml"].includes(ref);
  if (!permitted) throw new Error(`${ref} is not portable`);
  const target = resolve(repositoryReal, ...ref.split("/"));
  ensureInside(repositoryReal, target);
  verifyExistingParents(repositoryReal, ref);
  let linkInfo;
  try { linkInfo = lstatSync(target, { bigint: true }); }
  catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink() || linkInfo.isReparsePoint?.()) throw new Error(`${ref} is not a regular unlinked file`);
  ensureInside(repositoryReal, realpathSync(target));
  if (linkInfo.size > BigInt(maxBytes)) throw new Error(`${ref} exceeds its byte envelope`);
  const descriptor = openSync(target, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error(`${ref} is not a bounded regular file`);
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new Error(`${ref} ended during read`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`${ref} changed during read`);
    return Object.freeze({ ref, buffer, text: decode(buffer, ref), byteLength: buffer.length, digest: sha256(buffer) });
  } finally { closeSync(descriptor); }
}

function rootOnly(source, label) {
  return parseArrayTableDocument(source, "__no_array_table__", label).root;
}

function validateControl(control, instanceId) {
  if (!exactKeys(control, controlFields) || control.schema_version !== 1
    || control.record_type !== "cross-session-signal-control" || control.instance_id !== instanceId
    || !safeInteger(control.source_revision) || !safeInteger(control.projection_revision)
    || !safeInteger(control.base_revision) || control.update_state !== "clean"
    || control.source_revision !== control.projection_revision
    || !clean(control.updated_at, 64) || (control.updated_at !== "" && !strictDate(control.updated_at))
    || ["pending_operation_id", "pending_event_id", "pending_signal_id", "pending_trigger_id", "pending_source_ref"]
      .some((field) => control[field] !== "")) throw new Error("signal control is not a clean exact record");
  return control;
}

function validCandidateEntry(entry) {
  return exactKeys(entry, candidateEntryFields) && stableAssetId.test(entry.id ?? "")
    && clean(entry.title, 80, false) && clean(entry.summary, 240, false)
    && clean(entry.topic_key, 80) && clean(entry.subject_key, 80)
    && cleanList(entry.triggers, 8, 80) && cleanList(entry.aliases, 8, 80)
    && cleanList(entry.scope, 8, 120) && cleanList(entry.conditions, 8, 120) && cleanList(entry.excludes, 8, 120)
    && candidateKinds.has(entry.target_kind) && clean(entry.target_subtype, 80)
    && candidateRelations.has(entry.candidate_relation) && ["candidate", "review"].includes(entry.status)
    && entry.observation_state === "explicit" && entry.observation_basis === "explicit-user"
    && riskTiers.has(entry.risk_tier) && safeInteger(entry.independent_event_count, 1)
    && strictDate(entry.last_evidence_at) && portableRef(entry.source_ref, { prefix: "instance/evolution/", extension: ".md" })
    && safeInteger(entry.source_revision, 1);
}

function parseCandidateIndex(read, instanceId) {
  const parsed = parseArrayTableDocument(read.text, "candidates", "evolution candidate index");
  const root = parsed.root; const entries = parsed.entries;
  const ids = new Set(); const refs = new Set();
  if (!exactKeys(root, candidateIndexRootFields) || root.schema_version !== 1 || root.index_id !== "evolution-candidates"
    || root.instance_id !== instanceId || !["empty", "current"].includes(root.state)
    || !safeInteger(root.source_revision) || !clean(root.generated_at, 64)
    || (root.generated_at !== "" && !strictDate(root.generated_at)) || root.budget_bytes !== limits.candidateIndex
    || root.overflow !== false || !safeInteger(root.candidate_count) || !safeInteger(root.indexed_count)
    || !safeInteger(root.active_count) || root.candidate_count !== entries.length || root.indexed_count !== entries.length
    || root.active_count !== entries.filter((entry) => entry.status === "candidate").length
    || (root.state === "empty" && entries.length !== 0) || read.byteLength > limits.candidateIndex) {
    throw new Error("candidate index is not a complete current projection");
  }
  for (const entry of entries) {
    if (!validCandidateEntry(entry) || ids.has(entry.id) || refs.has(entry.source_ref.toLowerCase())) throw new Error("candidate index contains an invalid or duplicate entry");
    ids.add(entry.id); refs.add(entry.source_ref.toLowerCase());
  }
  return { root, entries };
}

function validSignalProjection(entry) {
  return exactKeys(entry, signalProjectionFields) && stableAssetId.test(entry.id ?? "")
    && clean(entry.signal_type, 80, false) && ["near-trigger", "pending-review", "conflict", "uncertain", "stale"].includes(entry.status)
    && clean(entry.reason, 240, false) && clean(entry.progress, 160, false) && clean(entry.next_event, 200, false)
    && clean(entry.domain, 80, false) && stableAssetId.test(entry.route_id ?? "")
    && portableRef(entry.source_ref, { prefix: "instance/signals/", extension: ".toml" }) && entry.source_ref !== CONTROL_REF
    && safeInteger(entry.source_signal_revision, 1) && clean(entry.provenance, 80, false)
    && clean(entry.trust_state, 80, false) && [1, 2, 3].includes(entry.minimum_level)
    && clean(entry.confirmation, 80, false);
}

function parseSignalMap(read, instanceId, revision) {
  const parsed = parseArrayTableDocument(read.text, "signals", "startup signal projection");
  const root = parsed.root; const entries = parsed.entries;
  if (!exactKeys(root, signalMapRootFields) || root.schema_version !== 1 || root.map_id !== "cross-session-signals"
    || root.instance_id !== instanceId || !["empty", "current"].includes(root.state)
    || root.source_revision !== revision || !clean(root.generated_at, 64)
    || (root.generated_at !== "" && !strictDate(root.generated_at)) || root.budget_bytes !== limits.signalMap
    || root.overflow !== false || root.active_count !== entries.length || !safeInteger(root.scheduled_count)
    || !clean(root.next_wakeup_at, 64) || (root.next_wakeup_at !== "" && !strictDate(root.next_wakeup_at))
    || root.next_wakeup_ref !== TIME_MAP_REF || (root.state === "empty" && (entries.length !== 0 || root.scheduled_count !== 0))
    || entries.some((entry) => !validSignalProjection(entry)) || new Set(entries.map((entry) => entry.id)).size !== entries.length
    || read.byteLength > limits.signalMap) throw new Error("startup signal projection is not current and bounded");
  return { root, entries };
}

function validTimeTrigger(entry) {
  return exactKeys(entry, timeTriggerFields) && stableAssetId.test(entry.id ?? "")
    && clean(entry.kind, 80, false) && ["scheduled", "due"].includes(entry.status) && clean(entry.title, 80, false)
    && strictDate(entry.next_check_at) && strictDate(entry.effective_check_at)
    && Date.parse(entry.effective_check_at) >= Date.parse(entry.next_check_at)
    && clean(entry.domain, 80, false) && stableAssetId.test(entry.route_id ?? "")
    && portableRef(entry.source_ref, { prefix: "instance/", extension: entry.source_ref?.endsWith(".md") ? ".md" : ".toml" })
    && safeInteger(entry.source_trigger_revision, 1) && [1, 2, 3].includes(entry.minimum_level)
    && clean(entry.confirmation, 80, false);
}

function deterministicEarliest(entries) {
  if (entries.length === 0) return "";
  return [...entries].sort((left, right) => Date.parse(left.effective_check_at) - Date.parse(right.effective_check_at)
    || left.id.localeCompare(right.id, "en"))[0].effective_check_at;
}

function parseTimeMap(read, instanceId, revision) {
  const parsed = parseArrayTableDocument(read.text, "triggers", "time trigger projection");
  const root = parsed.root; const entries = parsed.entries;
  const expectedNext = deterministicEarliest(entries);
  if (!exactKeys(root, timeMapRootFields) || root.schema_version !== 1 || root.map_id !== "time-triggers"
    || root.instance_id !== instanceId || !["empty", "current"].includes(root.state)
    || root.source_revision !== revision || !clean(root.generated_at, 64)
    || (root.generated_at !== "" && !strictDate(root.generated_at)) || root.scheduled_count !== entries.length
    || root.next_wakeup_at !== expectedNext || (root.state === "empty" && entries.length !== 0)
    || entries.some((entry) => !validTimeTrigger(entry)) || new Set(entries.map((entry) => entry.id)).size !== entries.length
    || read.byteLength > limits.timeMap) throw new Error("time trigger projection is not current and bounded");
  return { root, entries };
}

function pristineDerivedFoldersAreEmpty(repositoryReal) {
  const allowed = new Map([
    [resolve(repositoryReal, "instance/evolution"), new Set(["index.toml", "README.md"])],
    [resolve(repositoryReal, "instance/signals"), new Set(["control.toml", "README.md"])],
  ]);
  for (const [directory, names] of allowed) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const info = lstatSync(resolve(directory, entry.name));
      if (!entry.isFile() || info.isSymbolicLink() || !names.has(entry.name)) return false;
    }
  }
  return true;
}

function controlForLearningWrite(read, instanceId, initializedAt, allowPristineTemplate) {
  const source = rootOnly(read.text, "signal control");
  try { return validateControl(source, instanceId); }
  catch (error) {
    const pristine = allowPristineTemplate && exactKeys(source, controlFields)
      && source.schema_version === 1 && source.record_type === "cross-session-signal-control"
      && source.instance_id === "template" && source.source_revision === 0 && source.projection_revision === 0
      && source.update_state === "clean" && source.base_revision === 0 && source.updated_at === ""
      && ["pending_operation_id", "pending_event_id", "pending_signal_id", "pending_trigger_id", "pending_source_ref"]
        .every((field) => source[field] === "");
    if (!pristine) throw error;
    return validateControl({ ...source, instance_id: instanceId, updated_at: initializedAt }, instanceId);
  }
}

function candidateIndexForLearningWrite(read, instanceId, allowPristineTemplate) {
  try { return parseCandidateIndex(read, instanceId); }
  catch (error) {
    const parsed = parseArrayTableDocument(read.text, "candidates", "evolution candidate index");
    const root = parsed.root;
    const pristine = allowPristineTemplate && exactKeys(root, candidateIndexRootFields)
      && root.schema_version === 1 && root.index_id === "evolution-candidates" && root.instance_id === "template"
      && root.state === "empty" && root.source_revision === 0 && root.generated_at === ""
      && root.budget_bytes === limits.candidateIndex && root.overflow === false
      && root.candidate_count === 0 && root.indexed_count === 0 && root.active_count === 0
      && parsed.entries.length === 0 && read.byteLength <= limits.candidateIndex;
    if (!pristine) throw error;
    return { root: { ...root, instance_id: instanceId }, entries: [] };
  }
}

function signalMapForLearningWrite(read, instanceId, revision, allowPristineTemplate) {
  try { return parseSignalMap(read, instanceId, revision); }
  catch (error) {
    const parsed = parseArrayTableDocument(read.text, "signals", "startup signal projection");
    const root = parsed.root;
    const pristine = allowPristineTemplate && exactKeys(root, signalMapRootFields)
      && root.schema_version === 1 && root.map_id === "cross-session-signals" && root.instance_id === "template"
      && root.state === "empty" && root.source_revision === 0 && root.generated_at === ""
      && root.budget_bytes === limits.signalMap && root.overflow === false && root.active_count === 0
      && root.scheduled_count === 0 && root.next_wakeup_at === "" && root.next_wakeup_ref === TIME_MAP_REF
      && parsed.entries.length === 0 && read.byteLength <= limits.signalMap;
    if (!pristine || revision !== 0) throw error;
    return { root: { ...root, instance_id: instanceId }, entries: [] };
  }
}

function timeMapForLearningWrite(read, instanceId, revision, allowPristineTemplate) {
  try { return parseTimeMap(read, instanceId, revision); }
  catch (error) {
    const parsed = parseArrayTableDocument(read.text, "triggers", "time trigger projection");
    const root = parsed.root;
    const pristine = allowPristineTemplate && exactKeys(root, timeMapRootFields)
      && root.schema_version === 1 && root.map_id === "time-triggers" && root.instance_id === "template"
      && root.state === "empty" && root.source_revision === 0 && root.generated_at === ""
      && root.scheduled_count === 0 && root.next_wakeup_at === "" && parsed.entries.length === 0
      && read.byteLength <= limits.timeMap;
    if (!pristine || revision !== 0) throw error;
    return { root: { ...root, instance_id: instanceId }, entries: [] };
  }
}

function parseSignalSource(source, label = "learning signal") {
  const root = Object.create(null); const match = Object.create(null); const trigger = Object.create(null); const evidence = [];
  let target = root;
  for (const [index, raw] of source.replaceAll("\r\n", "\n").split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[match]") { target = match; continue; }
    if (line === "[trigger]") { target = trigger; continue; }
    if (line === "[[evidence]]") { target = Object.create(null); evidence.push(target); continue; }
    if (line.startsWith("[")) throw new Error(`${label} contains an unsupported table at line ${index + 1}`);
    const parsed = parseArrayTableDocument(`${line}\n`, "__no_array_table__", label).root;
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || Object.hasOwn(target, keys[0])) throw new Error(`${label} repeats a field at line ${index + 1}`);
    target[keys[0]] = parsed[keys[0]];
  }
  return { root, match, trigger, evidence };
}

function validateGeneratedCandidateSource(source, entry) {
  return exactKeys(source, candidateSourceFields) && source.id === entry.id && source.kind === "evolution-candidate"
    && source.status === "candidate" && source.title === entry.title && source.summary === entry.summary
    && JSON.stringify(source.triggers) === JSON.stringify(entry.triggers) && JSON.stringify(source.aliases) === JSON.stringify(entry.aliases)
    && JSON.stringify(source.scope) === JSON.stringify(entry.scope) && JSON.stringify(source.conditions) === JSON.stringify(entry.conditions)
    && JSON.stringify(source.excludes) === JSON.stringify(entry.excludes) && source.topic_key === entry.topic_key
    && source.subject_key === entry.subject_key && source.target_kind === entry.target_kind
    && source.target_subtype === entry.target_subtype && source.candidate_relation === entry.candidate_relation
    && source.observation_state === "explicit" && source.observation_basis === "explicit-user"
    && source.proposed_risk_tier === entry.risk_tier && source.risk_tier === entry.risk_tier
    && source.independent_event_count === entry.independent_event_count && source.distinct_context_count === source.independent_event_count
    && source.last_evidence_at === entry.last_evidence_at && source.source_revision === entry.source_revision
    && safeInteger(source.successful_event_count) && safeInteger(source.failed_event_count)
    && cleanList(source.representative_event_ids, 5, 160) && strictDate(source.last_evidence_at)
    && strictDate(source.remind_at) && clean(source.snoozed_until, 64)
    && (source.snoozed_until === "" || strictDate(source.snoozed_until)) && safeInteger(source.trigger_revision, 1)
    && source.approval_state === "pending" && source.activation_basis === "candidate" && source.approved_by_user === false
    && [1, 2, 3].includes(source.minimum_level) && strictDate(source.updated_at);
}

function validateGeneratedSignalSource(signal, { signalId, signalSourceRef, candidate, reminderAt }) {
  if (!exactKeys(signal.root, signalRootFields) || !exactKeys(signal.match, signalMatchFields)
    || !exactKeys(signal.trigger, signalTriggerFields) || signal.root.schema_version !== 1
    || signal.root.record_type !== "cross-session-signal" || signal.root.id !== signalId
    || signal.root.evaluation_family !== "count" || signal.root.status !== "observing"
    || signal.root.revision < 1 || signal.root.asset_refs.length !== 1 || signal.root.asset_refs[0] !== candidate.id
    || signal.root.candidate_source_revision !== candidate.source_revision || signal.root.trust_state !== "candidate"
    || !signal.root.provenance.startsWith("host-asserted-") || signal.trigger.mode !== "count"
    || signal.trigger.independent_event_count !== candidate.independent_event_count
    || signal.trigger.next_check_at !== reminderAt || signal.match.subject !== "" || signal.match.claim !== ""
    || signal.match.scope.length !== 0 || signal.match.conditions.length !== 0 || signal.match.aliases.length !== 0
    || signal.evidence.length < 1 || signal.evidence.some((item) => !exactKeys(item, signalEvidenceFields)
      || !stableAssetId.test(item.event_id ?? "") || !stableAssetId.test(item.task_id ?? "")
      || !stableAssetId.test(item.context_id ?? "") || !strictDate(item.occurred_at)
      || item.summary !== "" || item.independent !== true)) return false;
  return portableRef(signalSourceRef, { prefix: "instance/signals/", extension: ".toml" });
}

function normalizedTerms(values) {
  return new Set(values.map((value) => value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\s]+/gu, "")).filter(Boolean));
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function semanticDuplicate(entry, proposal) {
  const sameTopicSubject = proposal.topic_key !== "" && proposal.subject_key !== ""
    && entry.topic_key === proposal.topic_key && entry.subject_key === proposal.subject_key;
  const triggerOverlap = intersects(normalizedTerms([...entry.triggers, ...entry.aliases]), normalizedTerms([...proposal.triggers, ...proposal.aliases]));
  const scopeOverlap = intersects(normalizedTerms([...entry.scope, ...entry.conditions]), normalizedTerms([...proposal.scope, ...proposal.conditions]));
  return sameTopicSubject || (triggerOverlap && (scopeOverlap || (proposal.subject_key !== "" && entry.subject_key === proposal.subject_key)));
}

function formalTargetFor(asset, formalDigest) {
  const folder = { memory: "memory", capability: "capabilities", sop: "sops", experience: "experiences" }[asset.kind];
  return `instance/${folder}/${asset.kind}.${formalDigest.slice("sha256:".length, "sha256:".length + 24)}.md`;
}

function validateProposal(proposal) {
  if (!exactObject(proposal, proposalFields) || !clean(proposal.title, 80, false) || !clean(proposal.summary, 240, false)
    || !cleanList(proposal.triggers, 8, 80) || !cleanList(proposal.aliases, 8, 80)
    || !cleanList(proposal.scope, 8, 120) || !cleanList(proposal.conditions, 8, 120) || !cleanList(proposal.excludes, 8, 120)
    || !clean(proposal.topic_key, 80) || !clean(proposal.subject_key, 80) || !candidateKinds.has(proposal.target_kind)
    || !clean(proposal.target_subtype, 80)
    || !clean(proposal.claim_summary, 240, false) || !riskTiers.has(proposal.proposed_risk_tier)
    || ![1, 2, 3].includes(proposal.minimum_level) || typeof proposal.formal_preview !== "string"
    || Buffer.byteLength(proposal.formal_preview, "utf8") === 0
    || Buffer.byteLength(proposal.formal_preview, "utf8") > limits.formalPreview) throw new Error("learning proposal is invalid or unbounded");
  const semanticText = [proposal.title, proposal.summary, proposal.claim_summary, ...proposal.triggers, ...proposal.aliases,
    ...proposal.scope, ...proposal.conditions, ...proposal.excludes].join("\n");
  if (locateHighConfidenceSecretCandidates(semanticText).blocked || containsForbiddenLocationReference(semanticText)
    || locateHighConfidenceSecretCandidates(proposal.formal_preview).blocked || containsForbiddenLocationReference(proposal.formal_preview)) {
    throw new Error("learning proposal contains a secret or device-specific location");
  }
  const parsed = parseMarkdownFrontmatterHead(proposal.formal_preview, "bound formal preview");
  const formal = parsed.values;
  if (!stableAssetId.test(formal.id ?? "") || !formalKinds.has(formal.kind)
    || (proposal.target_kind === "preference" ? formal.kind !== "memory" : formal.kind !== proposal.target_kind)) {
    throw new Error("formal preview does not match the Agent-selected destination");
  }
  const exactProjection = [
    [formal.title, proposal.title], [formal.summary, proposal.summary],
    [formal.topic_key ?? "", proposal.topic_key], [formal.subject_key ?? "", proposal.subject_key],
    [formal.risk_tier, proposal.proposed_risk_tier], [formal.minimum_level, proposal.minimum_level],
  ].every(([left, right]) => left === right)
    && JSON.stringify(formal.triggers ?? []) === JSON.stringify(proposal.triggers)
    && JSON.stringify(formal.aliases ?? []) === JSON.stringify(proposal.aliases)
    && JSON.stringify(formal.scope ?? []) === JSON.stringify(proposal.scope)
    && JSON.stringify(formal.conditions ?? []) === JSON.stringify(proposal.conditions)
    && JSON.stringify(formal.excludes ?? []) === JSON.stringify(proposal.excludes);
  if (!exactProjection) throw new Error("formal preview is not an exact projection of the user-facing learning proposal");
  const normalized = Object.freeze({ ...proposal, candidate_relation: "new", formal_preview: proposal.formal_preview.replaceAll("\r\n", "\n") });
  const semantic = {
    topic_key: normalized.topic_key, subject_key: normalized.subject_key, target_kind: normalized.target_kind,
    target_subtype: normalized.target_subtype, candidate_relation: normalized.candidate_relation,
    claim_summary: normalized.claim_summary, triggers: [...normalized.triggers].sort(), aliases: [...normalized.aliases].sort(),
    scope: [...normalized.scope].sort(), conditions: [...normalized.conditions].sort(), excludes: [...normalized.excludes].sort(),
  };
  const semanticDigest = sha256(canonical(semantic));
  const proposalDigest = sha256(canonical({ ...normalized, formal_preview: sha256(normalized.formal_preview) }));
  const formalDigest = sha256(normalized.formal_preview);
  return Object.freeze({ proposal: normalized, formal: Object.freeze({ id: formal.id, kind: formal.kind, subtype: formal.subtype ?? "" }), semanticDigest, proposalDigest, formalDigest });
}

function formalDuplicateProbe(repository, envelope, checked) {
  const proposalId = `proposal.learning.${checked.semanticDigest.slice("sha256:".length, "sha256:".length + 24)}`;
  return findPotentialFormalDuplicates(repository, envelope, [{
    id: proposalId, kind: checked.formal.kind, title: checked.proposal.title, summary: checked.proposal.summary,
    topicKey: checked.proposal.topic_key, subjectKey: checked.proposal.subject_key,
    triggers: checked.proposal.triggers, aliases: checked.proposal.aliases,
    scope: checked.proposal.scope, conditions: checked.proposal.conditions,
  }], { limit: 3 });
}

function registeredFormalId(envelope, formalId) {
  return envelope?.explicitRoute?.id === formalId
    || envelope?.routes?.some((route) => route.id === formalId) === true
    || envelope?.reviewRoutes?.some((route) => route.id === formalId) === true;
}

function formalRouteProjection(asset, formalTarget) {
  const route = {
    id: asset.id, asset_kind: asset.kind, ...(asset.subtype ? { subtype: asset.subtype } : {}),
    title: asset.title, summary: asset.summary, triggers: asset.triggers, aliases: asset.aliases ?? [],
    topic_key: asset.topic_key ?? "", subject_key: asset.subject_key ?? "", scope: asset.scope ?? [],
    conditions: asset.conditions ?? [], excludes: asset.excludes ?? [], related_asset_ids: asset.related_asset_ids ?? [],
    body_sections: asset.body_sections ?? [], target: formalTarget, state: asset.status,
    minimum_level: asset.minimum_level, confirmation: asset.confirmation,
  };
  const source = `\n[[routes]]\n${Object.entries(route).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n`;
  return Object.freeze({ route: Object.freeze(route), source, byteLength: Buffer.byteLength(source, "utf8"), digest: sha256(source) });
}

function auditDirectFormalIdCandidateHistory(repositoryReal, formalId) {
  const root = resolve(repositoryReal, "instance/evolution");
  const queue = [root]; let directories = 0; let files = 0;
  while (queue.length) {
    const directory = queue.shift();
    if (++directories > 1024) throw new Error("candidate history exceeds the bounded identity scan");
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("candidate history crosses a link or reparse point");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name); const child = lstatSync(absolute);
      if (child.isSymbolicLink()) throw new Error("candidate history crosses a link or reparse point");
      if (entry.isDirectory()) { queue.push(absolute); continue; }
      if (!entry.isFile() || entry.name.toLowerCase() === "readme.md" || !entry.name.toLowerCase().endsWith(".md")) continue;
      if (++files > 4096) throw new Error("candidate history exceeds the bounded file scan");
      const read = stableRead(repositoryReal, relative(repositoryReal, absolute).split(sep).join("/"), limits.candidateSource);
      const source = parseMarkdownFrontmatterHead(read.text, "candidate history identity").values;
      if (source.kind !== "evolution-candidate" || !stableAssetId.test(source.id ?? "")) {
        throw new Error("candidate history contains an invalid identity source");
      }
      if (source.id === formalId) throw new Error("formal ID collides with candidate history");
    }
  }
}

function mirrorPhysicalTree(source, target, budget) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) throw new Error("snapshot projection source contains a link or reparse point");
  if (info.isDirectory()) {
    if (++budget.directories > 8192) throw new Error("snapshot projection directory budget exceeded");
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      mirrorPhysicalTree(resolve(source, entry.name), resolve(target, entry.name), budget);
    }
    return;
  }
  if (!info.isFile() || ++budget.files > 16384) throw new Error("snapshot projection file budget exceeded");
  mkdirSync(dirname(target), { recursive: true });
  linkSync(source, target);
}

function readBoundedPhysicalJson(target, maxBytes, label) {
  const info = lstatSync(target, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.isReparsePoint?.() || info.size > BigInt(maxBytes)) {
    throw new Error(`${label} is not one bounded physical file`);
  }
  const descriptor = openSync(target, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true }); const buffer = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new Error(`${label} ended during read`); offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`${label} changed during read`);
    return JSON.parse(decode(buffer, label));
  } finally { closeSync(descriptor); }
}

function validateOwnedProjectionTree(root) {
  const queue = [root]; let directories = 0; let files = 0;
  while (queue.length > 0) {
    const directory = queue.shift(); const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.isReparsePoint?.()) {
      throw new Error("projection cleanup encountered a linked or non-physical directory");
    }
    if (++directories > 8192) throw new Error("projection cleanup directory budget exceeded");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name); const child = lstatSync(absolute);
      if (child.isSymbolicLink() || child.isReparsePoint?.()) {
        throw new Error("projection cleanup refuses to cross or remove a link/reparse point");
      }
      if (child.isDirectory()) queue.push(absolute);
      else if (!child.isFile() || ++files > 16384) throw new Error("projection cleanup file budget exceeded");
    }
  }
  return Object.freeze({ directories, files });
}

function readOwnedProjectionMarker(repositoryReal, projectionRoot, expectedKind = "") {
  const marker = readBoundedPhysicalJson(resolve(projectionRoot, PROJECTION_MARKER), 4096, "projection owner marker");
  if (!exactObject(marker, projectionMarkerFields) || marker.schema_version !== 1
    || marker.record_type !== "ai-carry-learning-projection-owner" || marker.state !== "projection-only"
    || marker.repository_binding !== sha256(repositoryReal.normalize("NFC"))
    || !Object.hasOwn(projectionPrefixes, marker.projection_kind)
    || (expectedKind !== "" && marker.projection_kind !== expectedKind)
    || !strictDate(marker.created_at) || !/^[a-f0-9]{24}$/u.test(marker.nonce)) {
    throw new Error("projection owner marker does not prove this repository and producer");
  }
  const expectedPrefix = projectionPrefixes[marker.projection_kind];
  if (!projectionRoot.split(sep).at(-1).startsWith(expectedPrefix)) {
    throw new Error("projection directory prefix does not match its owner marker");
  }
  return marker;
}

function createOwnedProjectionRoot(repositoryReal, kind) {
  const prefix = projectionPrefixes[kind];
  if (!prefix) throw new Error("projection kind is invalid");
  const projectionRoot = mkdtempSync(join(dirname(repositoryReal), prefix));
  const marker = {
    schema_version: 1, record_type: "ai-carry-learning-projection-owner",
    repository_binding: sha256(repositoryReal.normalize("NFC")), projection_kind: kind,
    created_at: new Date().toISOString(), nonce: randomBytes(12).toString("hex"), state: "projection-only",
  };
  writeFileSync(resolve(projectionRoot, PROJECTION_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return projectionRoot;
}

function removeOwnedProjectionRoot(repositoryReal, projectionRoot, expectedKind) {
  const parentReal = realpathSync(dirname(repositoryReal)); const candidateReal = realpathSync(projectionRoot);
  ensureInside(parentReal, candidateReal);
  if (dirname(candidateReal) !== parentReal || candidateReal === repositoryReal) {
    throw new Error("projection cleanup target is not one repository sibling");
  }
  readOwnedProjectionMarker(repositoryReal, candidateReal, expectedKind);
  validateOwnedProjectionTree(candidateReal);
  rmSync(candidateReal, { recursive: true, force: false });
}

export function cleanupStaleLearningCaptureProjections(repository, { now = new Date() } = {}) {
  try {
    const repositoryReal = realpathSync(repository); const parentReal = realpathSync(dirname(repositoryReal));
    const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(nowMs)) throw new Error("projection cleanup time is invalid");
    let inspected = 0; let removed = 0; const preserved = [];
    for (const entry of readdirSync(parentReal, { withFileTypes: true })) {
      if (!Object.values(projectionPrefixes).some((prefix) => entry.name.startsWith(prefix))) continue;
      if (++inspected > 256) throw new Error("projection cleanup sibling budget exceeded");
      const target = resolve(parentReal, entry.name);
      try {
        const info = lstatSync(target);
        if (!entry.isDirectory() || !info.isDirectory() || info.isSymbolicLink() || info.isReparsePoint?.()) {
          throw new Error("candidate is not one physical sibling directory");
        }
        const targetReal = realpathSync(target); ensureInside(parentReal, targetReal);
        if (dirname(targetReal) !== parentReal || targetReal === repositoryReal) throw new Error("candidate is not one direct sibling");
        const marker = readOwnedProjectionMarker(repositoryReal, targetReal);
        const createdAt = Date.parse(marker.created_at);
        if (createdAt > nowMs + 60_000) throw new Error("owner marker is future-dated");
        if (nowMs - createdAt < PROJECTION_TTL_MS) { preserved.push(Object.freeze({ name: entry.name, reason: "active-ttl" })); continue; }
        validateOwnedProjectionTree(targetReal);
        rmSync(targetReal, { recursive: true, force: false }); removed += 1;
      } catch (error) {
        preserved.push(Object.freeze({ name: entry.name, reason: error.message }));
      }
    }
    return deepFreeze({ decision: "learning-capture-projection-cleanup-complete", executable: false,
      inspectedCount: inspected, removedCount: removed, preservedCount: preserved.length,
      preserved: Object.freeze(preserved.slice(0, 32)) });
  } catch (error) {
    return deepFreeze({ decision: "learning-capture-projection-cleanup-denied", reason: error.message, executable: false });
  }
}

function replaceProjectionFile(root, ref, content) {
  const target = resolve(root, ...ref.split("/"));
  if (existsSync(target)) unlinkSync(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function buildDirectKeepProjection(repositoryReal, checked, envelope, context) {
  const normalizedPreview = checked.proposal.formal_preview;
  const parsed = parseMarkdownFrontmatterHead(normalizedPreview, "direct keep formal preview");
  const asset = parsed.values; const body = normalizedPreview.slice(parsed.bodyOffset);
  const requiredLevel = Math.max(asset.minimum_level,
    asset.risk_tier === "high" ? 3 : asset.risk_tier === "medium" ? 2 : 1);
  if (![1, 2, 3].includes(requiredLevel)) throw new Error("formal preview has invalid model guidance metadata");
  if (!context.allowedConfirmationGates.includes(asset.confirmation)
    || asset.approval_state !== "explicit" || asset.activation_basis !== "explicit-user" || asset.approved_by_user !== true
    || !["active", "provisional"].includes(asset.status)
    || (asset.status === "provisional" && asset.risk_tier !== "low")
    || (["medium", "high"].includes(asset.risk_tier) && asset.confirmation === "none")) {
    throw new Error("formal preview authorization, status, risk, or future action gate requires targeted review");
  }
  if ((asset.related_asset_ids ?? []).length > 0 || (asset.supersedes ?? []).length > 0) {
    throw new Error("formal preview changes existing asset relationships and requires targeted review");
  }
  const maturityBearing = ["capability", "sop"].includes(asset.kind)
    || (asset.kind === "experience" && asset.subtype === "host-execution");
  if (maturityBearing && (asset.maturity !== "unvalidated" || asset.independent_task_count !== 0
    || asset.successful_use_count !== 0 || asset.failed_use_count !== 0 || asset.distinct_context_count !== 0
    || asset.distinct_host_count !== 0 || (asset.validation_refs ?? []).length !== 0)) {
    throw new Error("new formal content preclaims maturity and requires targeted review");
  }
  const schema = validateProposedFormalAsset(repositoryReal, envelope, asset, body);
  if (schema.decision !== "proposal-metadata-valid") throw new Error(schema.reason ?? "formal preview schema requires targeted review");
  auditDirectFormalIdCandidateHistory(repositoryReal, asset.id);
  const formalTarget = formalTargetFor(asset, checked.formalDigest);
  const targetProof = prepareNewFormalTarget(repositoryReal, formalTarget, asset.kind);
  if (!verifyNewFormalTarget(repositoryReal, targetProof)) throw new Error("formal target is no longer available");
  const route = formalRouteProjection(asset, formalTarget);
  if (Buffer.byteLength(JSON.stringify(route.route), "utf8") > 2048 || envelope.routeCount + 1 > 128) {
    throw new Error("domain map hard budget would be exceeded; keep this new content for targeted review, existing assets remain available");
  }
  const domainMapRead = stableRead(repositoryReal, context.domainMapRef, limits.domainMap);
  const domainMapText = `${domainMapRead.text.replace(/\s*$/u, "")}${route.source}`;
  if (Buffer.byteLength(domainMapText, "utf8") > limits.domainMap) throw new Error("domain map hard budget would be exceeded");
  const capacityNotice = envelope.routeCount + 1 >= 96 || Buffer.byteLength(domainMapText, "utf8") >= 32768
    ? "检索目录已达到建议整理的容量，但未超过安全上限；本次仍可保存并召回，后续可按需整理，不必暂停当前工作。" : "";
  return Object.freeze({ eligible: true, requiredLevel, asset: Object.freeze({ ...asset }), normalizedPreview,
    formalTarget, targetProof, route, domainMapRef: context.domainMapRef, domainMapRead, domainMapText,
    writeSetPreview: Object.freeze([formalTarget, context.domainMapRef]),
    retainedFutureActionGate: asset.confirmation, initialMaturity: maturityBearing ? "unvalidated" : "not-applicable", capacityNotice });
}

function purgeMessageRefs(now) {
  for (const [key, expiresAt] of consumedMessageRefs) if (expiresAt < now) consumedMessageRefs.delete(key);
}

function runtimeObservationIds(instanceId, semanticDigest, nonce, observedAt) {
  const semanticHex = semanticDigest.slice("sha256:".length);
  const eventHex = createHash("sha256").update(`${instanceId}\u0000${semanticHex}\u0000${nonce}\u0000${observedAt}\u0000host-natural-stop-observation`).digest("hex");
  return Object.freeze({
    candidateId: `evolution.learning.${semanticHex.slice(0, 24)}`,
    candidateSourceRef: `instance/evolution/evolution.learning.${semanticHex.slice(0, 24)}.md`,
    signalId: `signal.learning.${semanticHex.slice(0, 24)}`,
    signalSourceRef: `instance/signals/count/signal.learning.${semanticHex.slice(0, 24)}.toml`,
    reviewPayloadId: `review-payload.learning.${semanticHex.slice(0, 24)}`,
    reviewPayloadRef: `instance/evolution/review-payloads/review-payload.learning.${semanticHex.slice(0, 24)}.json`,
    eventId: `event.learning.${eventHex.slice(0, 24)}`,
    taskId: `task.learning.${eventHex.slice(24, 48)}`,
    contextId: `context.learning.${eventHex.slice(40, 64)}`,
    observationRef: `observation.learning.${eventHex.slice(8, 32)}`,
    observedAt,
  });
}

function runtimeOperationId(instanceId, nonce, messageRef, messageDigest) {
  const hex = createHash("sha256").update(`${instanceId}\u0000${nonce}\u0000${messageRef}\u0000${messageDigest}\u0000capture-choice`).digest("hex");
  return `operation.learning.${hex.slice(0, 24)}`;
}

export function createLearningCaptureObservationReceipt(repository, assertion) {
  try {
    const repositoryReal = realpathSync(repository); const now = Date.now();
    const manifestRead = stableRead(repositoryReal, MANIFEST_REF, limits.manifest);
    const manifest = validateInstanceManifestStructure(parseSectionedToml(manifestRead.text, "instance manifest"));
    if (manifest.root.state !== "instance" || !exactObject(assertion, observationAssertionFields)
      || assertion.basis !== "same-process-host-task-observation"
      || !observationSourceKinds.has(assertion.source_kind) || !observationResultStates.has(assertion.result_state)
      || !digestPattern.test(assertion.task_ref_digest ?? "") || !digestPattern.test(assertion.context_ref_digest ?? "")
      || !strictDate(assertion.occurred_at)) {
      throw new Error("host observation assertion is invalid");
    }
    const nonce = randomBytes(18).toString("hex");
    const digest = sha256(canonical(assertion));
    const hex = createHash("sha256").update(`${manifest.root.instance_id}\u0000${digest}\u0000${nonce}`).digest("hex");
    const receipt = deepFreeze({ decision: "learning-capture-host-observation-bound", executable: false,
      instanceId: manifest.root.instance_id, sourceKind: assertion.source_kind, resultState: assertion.result_state,
      occurredAt: assertion.occurred_at, observationDigest: digest,
      trust: "same-process-host-asserted-not-independently-verified" });
    trustedObservationReceipts.set(receipt, Object.freeze({ repositoryReal, instanceId: manifest.root.instance_id,
      manifestDigest: manifestRead.digest, sourceKind: assertion.source_kind, resultState: assertion.result_state,
      occurredAt: assertion.occurred_at, expiresAtMs: now + 10 * 60_000,
      eventId: `event.learning.${hex.slice(0, 24)}`, taskId: `task.learning.${hex.slice(24, 48)}`,
      contextId: `context.learning.${hex.slice(40, 64)}`, observationRef: `observation.learning.${hex.slice(8, 32)}` }));
    return receipt;
  } catch (error) {
    return deepFreeze({ decision: "learning-capture-host-observation-denied", reason: error.message, executable: false });
  }
}

export function createLearningCaptureChoiceChallenge(repository, proposal, { levelEvidence = undefined,
  observationReceipt = undefined, allowPromptOnlyLowRiskKeep = false } = {}) {
  try {
    const repositoryReal = realpathSync(repository);
    const manifestRead = stableRead(repositoryReal, MANIFEST_REF, limits.manifest);
    const manifest = validateInstanceManifestStructure(parseSectionedToml(manifestRead.text, "instance manifest"));
    if (manifest.root.state !== "instance") throw new Error("an instantiated AI Carry is required");
    const checked = validateProposal(proposal);
    const observationTrust = trustedObservationReceipts.get(observationReceipt);
    if (!observationTrust || consumedObservationReceipts.has(observationReceipt)
      || observationTrust.repositoryReal !== repositoryReal || observationTrust.instanceId !== manifest.root.instance_id
      || observationTrust.manifestDigest !== manifestRead.digest || Date.now() > observationTrust.expiresAtMs) {
      throw new Error("a same-process host observation receipt is required before offering durable learning choices");
    }
    consumedObservationReceipts.add(observationReceipt);
    const { context, envelope } = loadTrustedDomainEnvelope(repositoryReal, { explicitRequestedId: checked.formal.id });
    if (context.instanceId !== manifest.root.instance_id || context.manifestState !== "instance") throw new Error("trusted formal routing context does not match the instance");
    if (registeredFormalId(envelope, checked.formal.id)) throw new Error("the proposed formal asset ID is already registered and cannot create a new candidate");
    const formalStateDigest = trustedMaintenanceStateDigest(repositoryReal, envelope);
    const duplicateProbe = formalDuplicateProbe(repositoryReal, envelope, checked);
    if (!formalStateDigest || duplicateProbe.decision !== "duplicate-check-complete") throw new Error("formal duplicate check is unavailable");
    if (duplicateProbe.matches.length > 0) throw new Error("a semantically similar formal asset already exists and must be routed instead of creating a candidate");
    const issuedAtMs = Date.now(); const nonce = randomBytes(18).toString("hex");
    let directKeep;
    try {
      const verifiedHostResult = observationTrust.sourceKind === "connected-host-observation"
        && observationTrust.resultState === "closed-result-checked";
      const exactPreviewOnly = allowPromptOnlyLowRiskKeep === true
        && observationTrust.sourceKind === "unknown" && observationTrust.resultState === "closed-unverified"
        && checked.proposal.proposed_risk_tier === "low" && checked.proposal.minimum_level === 1;
      if (!verifiedHostResult && !exactPreviewOnly) {
        throw new Error("non-host, inferred, external, unknown, or unclosed observations require a targeted review before direct formal saving");
      }
      directKeep = buildDirectKeepProjection(repositoryReal, checked, envelope, context);
    } catch (error) {
      directKeep = Object.freeze({ eligible: false, reason: error.message });
    }
    const keepConsequence = directKeep.eligible
      ? `你确认后会把这份精确内容直接保存为正式资产并接入召回；看板随后单独刷新，只保存，不执行任何未来动作。${directKeep.capacityNotice}`
      : `当前不能安全直写（${directKeep.reason}）。选择后只会生成定向复核请求，不会假装已经保存。`;
    const challenge = deepFreeze({
      decision: "learning-capture-current-user-choice-required", executable: false,
      instanceId: manifest.root.instance_id, proposalDigest: checked.proposalDigest,
      choices: ["keep", "observe", "remind", "discard"], challengeNonce: nonce,
      issuedAt: new Date(issuedAtMs).toISOString(), expiresAt: "",
      preview: Object.freeze({
        discovery: checked.proposal.title,
        futureUse: checked.proposal.summary,
        scope: Object.freeze([...checked.proposal.scope]),
        limits: Object.freeze([...checked.proposal.excludes]),
        question: "这项做法以后可能还会有用。你希望怎么处理？请先核对下面的精确内容。即使你刚才说过“记住”，当前通用宿主也必须真实展示这次选择并等待你的回复；事务回执只绑定预览与选择，不能证明是谁发言。",
        options: Object.freeze([
          Object.freeze({ id: "keep", label: directKeep.eligible ? "留下" : "复核后留下", consequence: keepConsequence }),
          Object.freeze({ id: "observe", label: "先观察", consequence: "只建立可撤销候选，等新的真实任务再次验证。" }),
          Object.freeze({ id: "remind", label: "以后提醒", consequence: "建立可撤销候选，并在你指定的时间提醒复核。" }),
          Object.freeze({ id: "discard", label: "不保存", consequence: "本次发现不会写入任何持久文件。" }),
        ]),
        exactFormalPreview: checked.proposal.formal_preview,
        exactFormalPreviewDigest: checked.formalDigest,
        futureUse: Object.freeze({ triggers: [...checked.proposal.triggers], scope: [...checked.proposal.scope],
          conditions: [...checked.proposal.conditions], excludes: [...checked.proposal.excludes] }),
        saveBoundary: "本次只保存内容，不执行内容描述的任何未来动作；未来动作仍遵守正式资产内的确认门。",
        retainedFutureActionGate: directKeep.eligible ? directKeep.retainedFutureActionGate : "定向复核后确定",
        initialMaturity: directKeep.eligible ? directKeep.initialMaturity : "尚未采用",
        correctionAndDisable: "以后可直接用普通语言指出哪里不对、要求修改或停用；正式资产不会因为本次保存而预领真实使用成功。",
        directWriteSet: directKeep.eligible ? Object.freeze([...directKeep.writeSetPreview]) : Object.freeze([]),
        rollbackBoundary: directKeep.eligible
          ? "正式内容和直接召回路线会一起保存并回读；其中一项没有成功就只恢复这次保存，其他学习和普通任务不受影响。"
          : "选择前没有语义写入；确认这个选项后只建立不可执行的候选与定向复核交接，不改变正式资产。",
      }),
      userMeaning: Object.freeze({
        keep: directKeep.eligible ? "按上面的精确内容直接正式保存；只保存，不执行" : "当前只请求定向复核，不会假装已保存",
        observe: "只建立可撤销观察候选，后续真实任务再验证",
        remind: "建立观察候选并在指定时间提醒；随时可取消",
        discard: "本次发现不写入任何持久文件",
      }),
      confirmationTrust: "same-process-host-asserted-current-user-message-not-independent-validation",
    });
    const runtimeIds = runtimeObservationIds(manifest.root.instance_id, checked.semanticDigest, nonce, observationTrust.occurredAt);
    const observation = Object.freeze({ ...runtimeIds, eventId: observationTrust.eventId,
      taskId: observationTrust.taskId, contextId: observationTrust.contextId,
      observationRef: observationTrust.observationRef, observedAt: observationTrust.occurredAt,
      sourceKind: observationTrust.sourceKind, resultState: observationTrust.resultState });
    trustedChallenges.set(challenge, Object.freeze({ repositoryReal, manifestDigest: manifestRead.digest, formalStateDigest,
      instanceId: manifest.root.instance_id, checked, observation, directKeep,
      allowedChoices: choices, issuedAtMs, nonce }));
    return challenge;
  } catch (error) {
    return deepFreeze({ decision: "learning-capture-challenge-denied", reason: error.message, executable: false });
  }
}

export function confirmLearningCaptureChoice(challenge, receipt) {
  const trust = trustedChallenges.get(challenge); const now = Date.now(); purgeMessageRefs(now);
  const messageKey = trust ? `${trust.repositoryReal}\u0000${trust.instanceId}\u0000${receipt?.message_ref ?? ""}` : "";
  const remindAt = Date.parse(receipt?.remind_at ?? "");
  const valid = trust && compatibleReceipt(receipt, receiptRequiredFields, receiptFields) && receipt.basis === "host-current-user-message"
    && stableAssetId.test(receipt.message_ref ?? "") && digestPattern.test(receipt.message_digest ?? "")
    && trust.allowedChoices.has(receipt.choice) && receipt.instance_id === trust.instanceId
    && receipt.proposal_digest === trust.checked.proposalDigest && receipt.challenge_nonce === trust.nonce
    && !consumedMessageRefs.has(messageKey)
    && (receipt.choice === "remind"
      ? strictDate(receipt.remind_at) && remindAt > now && remindAt <= now + 10 * 365 * 24 * 60 * 60_000
      : receipt.remind_at === undefined || receipt.remind_at === "");
  if (!valid) return deepFreeze({ decision: "learning-capture-choice-denied", reason: "receipt-invalid-replayed-or-cross-bound", executable: false });
  const internalAt = new Date(now).toISOString();
  const normalizedReceipt = Object.freeze({ ...receipt,
    user_message_at: strictDate(receipt.user_message_at) ? receipt.user_message_at : internalAt,
    confirmed_at: internalAt, remind_at: receipt.choice === "remind" ? receipt.remind_at : "" });
  trustedChallenges.delete(challenge); consumedMessageRefs.set(messageKey, Number.POSITIVE_INFINITY);
  const ids = Object.freeze({ ...trust.observation,
    operationId: runtimeOperationId(trust.instanceId, trust.nonce, receipt.message_ref, receipt.message_digest) });
  const transactionAt = new Date(now).toISOString();
  const selection = deepFreeze({
    decision: receipt.choice === "discard" ? "learning-capture-discard-confirmed" : "learning-capture-choice-confirmed",
    executable: false, choice: receipt.choice, instanceId: trust.instanceId, proposalDigest: trust.checked.proposalDigest,
    candidateId: receipt.choice === "discard" ? "" : ids.candidateId,
    transactionAt, sourceTrust: "host-asserted-current-user-message-not-independently-verified",
    durableEffect: receipt.choice === "discard" ? "zero-persistent-writes" : "host-transaction-plan-required",
    cancellationGuidance: receipt.choice === "remind" ? "随时告诉当前 Agent：取消这条学习提醒，并说出它的大概内容即可；不需要 ID 或路径。" : "",
  });
  trustedSelections.set(selection, Object.freeze({ ...trust, receipt: normalizedReceipt, ids, transactionAt }));
  const earlierReport = getOperationalDerivedStateReport(challenge);
  return bindOperationalDerivedStateReport(selection, earlierReport ? { userReport: earlierReport } : null);
}

export function closeLearningCaptureWithoutResponse(challenge) {
  const trust = trustedChallenges.get(challenge);
  if (!trust) return deepFreeze({ decision: "learning-capture-no-response-denied", executable: false });
  trustedChallenges.delete(challenge);
  return deepFreeze({ decision: "learning-capture-closed-without-response", executable: false,
    durableEffect: "zero-persistent-writes", writeSet: Object.freeze([]), reminderCreated: false, candidateCreated: false });
}

function persistentRoot(repositoryReal) {
  let cursor = repositoryReal;
  for (const part of PERSISTENT_CAPTURE_DIR.split("/")) {
    cursor = resolve(cursor, part); mkdirSync(cursor, { recursive: true });
    const info = lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("persistent challenge store crosses a link or reparse point");
    ensureInside(repositoryReal, realpathSync(cursor));
  }
  return cursor;
}

function persistentRecordPath(repositoryReal, challengeId) {
  if (!stableAssetId.test(challengeId ?? "")) throw new Error("persistent challenge ID is invalid");
  return resolve(persistentRoot(repositoryReal), `${challengeId}.json`);
}

function persistentPlanPath(repositoryReal, challengeId) {
  return resolve(persistentRoot(repositoryReal), `${challengeId}.plan.json`);
}

function removeEmptyPersistentDirectories(repositoryReal) {
  for (const ref of [PERSISTENT_CAPTURE_DIR, ".assistant-local/runtime", ".assistant-local"]) {
    const target = resolve(repositoryReal, ...ref.split("/"));
    if (existsSync(target) && lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink()
      && readdirSync(target).length === 0) rmdirSync(target);
  }
}

function recoverAtomicFile(target) {
  const stage = `${target}.stage`; const backup = `${target}.backup`;
  if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
  if (existsSync(stage)) unlinkSync(stage);
  if (existsSync(target) && existsSync(backup)) unlinkSync(backup);
}

function atomicJson(target, value, { replace = false } = {}) {
  recoverAtomicFile(target);
  const source = `${JSON.stringify(value, null, 2)}\n`; const stage = `${target}.stage`; const backup = `${target}.backup`;
  writeFileSync(stage, source, { encoding: "utf8", flag: "wx" });
  try {
    if (replace && existsSync(target)) renameSync(target, backup);
    renameSync(stage, target);
    if (existsSync(backup)) unlinkSync(backup);
  } catch (error) {
    if (existsSync(stage)) unlinkSync(stage);
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
}

function readPersistentJson(target, maxBytes, label) {
  recoverAtomicFile(target);
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error(`${label} is not a bounded physical file`);
  const descriptor = openSync(target, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true }); const buffer = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < buffer.length) { const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset); if (count === 0) break; offset += count; }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== buffer.length || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`${label} changed during read`);
    return JSON.parse(decode(buffer, label));
  } finally { closeSync(descriptor); }
}

function currentPersistentStateDigest(repositoryReal) {
  const refs = ["assistant.toml", "core/manifest.toml", "core/maps/asset-confirmation-gates.toml",
    MANIFEST_REF, DOMAIN_MAP_REF];
  return sha256(canonical(refs.map((ref) => [ref, stableRead(repositoryReal, ref, 64 * 1024).digest])));
}

function validPersistentRecord(record, repositoryReal) {
  return exactKeys(record, persistentRecordFields) && record.schema_version === 1
    && record.record_type === "learning-capture-operational-challenge" && stableAssetId.test(record.challenge_id ?? "")
    && stableAssetId.test(record.instance_id ?? "") && digestPattern.test(record.repository_binding ?? "")
    && record.repository_binding === sha256(repositoryReal.normalize("NFC"))
    && digestPattern.test(record.proposal_digest ?? "") && digestPattern.test(record.formal_preview_digest ?? "")
    && digestPattern.test(record.observation_digest ?? "")
    && digestPattern.test(record.state_digest ?? "") && clean(record.challenge_nonce, 80, false)
    && strictDate(record.issued_at) && (record.expires_at === "" || strictDate(record.expires_at))
    && ["direct", "review", "level3"].includes(record.direct_keep_mode)
    && ["prepared", "planned", "completed"].includes(record.status) && clean(record.message_ref, 160)
    && (record.message_digest === "" || digestPattern.test(record.message_digest))
    && (record.choice === "" || choices.has(record.choice)) && clean(record.remind_at, 64)
    && (record.remind_at === "" || strictDate(record.remind_at))
    && (record.status === "prepared"
      ? record.message_ref === "" && record.message_digest === "" && record.choice === "" && record.remind_at === ""
        && record.plan_digest === "" && record.plan_ref === ""
      : record.message_ref !== "" && digestPattern.test(record.message_digest) && choices.has(record.choice)
        && (record.choice === "remind" ? strictDate(record.remind_at) : record.remind_at === "")
        && digestPattern.test(record.plan_digest)
        && (record.status === "planned" ? record.plan_ref !== "" : record.plan_ref === ""))
    && (record.plan_digest === "" || digestPattern.test(record.plan_digest)) && clean(record.plan_ref, 240);
}

function normalizedReviewMode(value) {
  return value === "level3" ? "review" : value;
}

function readBoundPersistentPlan(repositoryReal, record) {
  const expectedPlanRef = `${PERSISTENT_CAPTURE_DIR}/${record.challenge_id}.plan.json`;
  if (!validPersistentRecord(record, repositoryReal) || record.status !== "planned" || record.plan_ref !== expectedPlanRef) {
    throw new Error("persistent challenge is not one valid planned transaction");
  }
  const plan = readPersistentJson(persistentPlanPath(repositoryReal, record.challenge_id), 64 * 1024 * 1024,
    "persistent transaction plan");
  if (!validateLearningCaptureTransactionPlan(plan) || plan.planDigest !== record.plan_digest
    || plan.choice !== record.choice || plan.instanceId !== record.instance_id
    || plan.proposalDigest !== record.proposal_digest || plan.confirmationMessageRef !== record.message_ref
    || plan.confirmationMessageDigest !== record.message_digest) {
    throw new Error("persistent transaction plan does not close against its operational challenge record");
  }
  return plan;
}

export function cleanupExpiredPersistentLearningCaptureChallenges(repository, _options = {}) {
  try {
    const repositoryReal = realpathSync(repository); const root = persistentRoot(repositoryReal);
    let removed = 0; let inspected = 0;
    const rollbackRequired = []; const recoveryRequired = []; const isolatedRecords = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (++inspected > 2048) throw new Error("persistent challenge cleanup budget exceeded");
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".plan.json")) continue;
      const target = resolve(root, entry.name);
      try {
        const record = readPersistentJson(target, 32 * 1024, "persistent challenge record");
        if (!validPersistentRecord(record, repositoryReal)) {
          isolatedRecords.push(Object.freeze({ record: entry.name, reason: "record shape or repository binding is invalid" }));
          continue;
        }
        const plan = persistentPlanPath(repositoryReal, record.challenge_id);
        if (record.status === "prepared") continue;
        if (record.status === "planned") {
          const boundPlan = readBoundPersistentPlan(repositoryReal, record);
          const state = inspectStructurallyTrustedPlanState(repositoryReal, boundPlan);
          if (state.decision === "learning-capture-rollback-required") {
            rollbackRequired.push(Object.freeze({ challengeId: record.challenge_id, checkpoint: state.checkpoint,
              planRef: record.plan_ref })); continue;
          }
          if (state.decision === "learning-capture-recovery-required") {
            recoveryRequired.push(Object.freeze({ challengeId: record.challenge_id, reason: state.reason,
              planRef: record.plan_ref })); continue;
          }
          if (!["learning-capture-ready-for-host-execution", "learning-capture-already-committed"].includes(state.decision)) {
            recoveryRequired.push(Object.freeze({ challengeId: record.challenge_id,
              reason: `unexpected persistent plan state: ${state.decision}`, planRef: record.plan_ref })); continue;
          }
          continue;
        }
        if (existsSync(plan)) unlinkSync(plan); unlinkSync(target); removed += 1;
      } catch (error) {
        isolatedRecords.push(Object.freeze({ record: entry.name, reason: String(error?.message ?? error) }));
      }
    }
    removeEmptyPersistentDirectories(repositoryReal);
    const decision = recoveryRequired.length > 0 ? "persistent-learning-capture-cleanup-recovery-required"
      : rollbackRequired.length > 0 ? "persistent-learning-capture-cleanup-rollback-required"
        : "persistent-learning-capture-cleanup-complete";
    return deepFreeze({ decision, executable: false, removedOperationalRecordCount: removed,
      preservedRollbackCount: rollbackRequired.length, preservedRecoveryCount: recoveryRequired.length,
      isolatedRecordCount: isolatedRecords.length, isolatedRecords: Object.freeze(isolatedRecords.slice(0, 32)),
      rollbackRequired: Object.freeze(rollbackRequired), recoveryRequired: Object.freeze(recoveryRequired), semanticAssetWriteCount: 0 });
  } catch (error) {
    return deepFreeze({ decision: "persistent-learning-capture-cleanup-denied", reason: error.message, executable: false });
  }
}

export function preparePersistentLearningCaptureChallenge(repository, proposal, observationAssertion, {
  levelEvidence = undefined, allowPromptOnlyLowRiskKeep = false,
} = {}) {
  try {
    const repositoryReal = realpathSync(repository);
    const cleanup = cleanupExpiredPersistentLearningCaptureChallenges(repositoryReal);
    if (cleanup.decision === "persistent-learning-capture-cleanup-denied") throw new Error(cleanup.reason ?? "persistent challenge cleanup unavailable");
    const observationReceipt = createLearningCaptureObservationReceipt(repositoryReal, observationAssertion);
    if (observationReceipt.decision !== "learning-capture-host-observation-bound") throw new Error(observationReceipt.reason ?? "host observation unavailable");
    const embedded = createLearningCaptureChoiceChallenge(repositoryReal, proposal, {
      levelEvidence, observationReceipt, allowPromptOnlyLowRiskKeep,
    });
    if (embedded.decision !== "learning-capture-current-user-choice-required") {
      if (embedded.userReport) return embedded;
      throw new Error(embedded.reason ?? "learning choice unavailable");
    }
    const challengeId = `capture.${randomBytes(16).toString("hex")}`; const challengeNonce = randomBytes(18).toString("hex");
    const record = {
      schema_version: 1, record_type: "learning-capture-operational-challenge", challenge_id: challengeId,
      instance_id: embedded.instanceId, repository_binding: sha256(repositoryReal.normalize("NFC")),
      proposal_digest: embedded.proposalDigest, formal_preview_digest: embedded.preview.exactFormalPreviewDigest,
      observation_digest: observationReceipt.observationDigest,
      state_digest: currentPersistentStateDigest(repositoryReal), challenge_nonce: challengeNonce,
      issued_at: embedded.issuedAt, expires_at: "",
      direct_keep_mode: embedded.preview.directWriteSet.length > 0 ? "direct" : "review",
      status: "prepared", message_ref: "", message_digest: "", choice: "", remind_at: "", plan_digest: "", plan_ref: "",
    };
    atomicJson(persistentRecordPath(repositoryReal, challengeId), record);
    const derivedUserReport = getOperationalDerivedStateReport(embedded);
    const hasOlderDiagnostics = cleanup.isolatedRecordCount > 0 || cleanup.preservedRollbackCount > 0
      || cleanup.preservedRecoveryCount > 0;
    const olderUserReport = hasOlderDiagnostics ? Object.freeze({
      impact: "发现旧的学习操作记录需要复核，但问题已限制在那些旧记录内；这一次新的学习仍可继续。",
      data_state: "旧记录和恢复现场保持原样，没有被自动删除、覆盖或冒充成功。",
      recoverability: "以后可以只检查报告中的旧记录，并分别继续、回退或保留。",
      still_usable: "当前学习选择、普通对话、已有记忆和其他能力仍可正常使用。",
      next_step: "先完成眼前这次学习；方便时再让 Agent 只查看旧学习记录，不需要重建整个实例。",
      user_summary: "旧学习记录存在局部问题，但已原样隔离；当前学习和其他能力继续可用，稍后只需定向处理旧记录。",
    }) : undefined;
    const userReport = derivedUserReport && olderUserReport ? Object.freeze({
      ...derivedUserReport,
      impact: `${derivedUserReport.impact}此外，旧学习操作记录的局部问题也已隔离，本次学习仍可继续。`,
      data_state: `${derivedUserReport.data_state}旧记录和恢复现场保持原样。`,
      next_step: `${derivedUserReport.next_step}方便时再单独查看旧学习记录。`,
      user_summary: `${derivedUserReport.user_summary}旧学习记录也已原样隔离，可稍后单独处理。`,
    }) : derivedUserReport ?? olderUserReport;
    return deepFreeze({ decision: "persistent-learning-capture-choice-required", executable: false,
      persistentChallengeId: challengeId, instanceId: embedded.instanceId, proposalDigest: embedded.proposalDigest,
      challengeNonce, issuedAt: embedded.issuedAt, expiresAt: "",
      choices: embedded.choices, preview: embedded.preview, userMeaning: embedded.userMeaning,
      operationalRecordContainsSemanticBody: false, ...(userReport ? { userReport } : {}) });
  } catch (error) {
    return deepFreeze({ decision: "persistent-learning-capture-prepare-denied", reason: error.message, executable: false });
  }
}

export function confirmPersistentLearningCaptureChallenge(repository, { challengeId, proposal, observationAssertion, receipt,
  levelEvidence = undefined, allowPromptOnlyLowRiskKeep = false } = {}) {
  try {
    const repositoryReal = realpathSync(repository); const target = persistentRecordPath(repositoryReal, challengeId);
    const record = readPersistentJson(target, 32 * 1024, "persistent challenge record");
    if (!validPersistentRecord(record, repositoryReal) || record.challenge_id !== challengeId) throw new Error("persistent challenge record is invalid");
    const now = Date.now();
    if (!compatibleReceipt(receipt, receiptRequiredFields, receiptFields) || receipt.basis !== "host-current-user-message"
      || receipt.instance_id !== record.instance_id || receipt.proposal_digest !== record.proposal_digest
      || receipt.challenge_nonce !== record.challenge_nonce || !choices.has(receipt.choice)
      || !stableAssetId.test(receipt.message_ref ?? "") || !digestPattern.test(receipt.message_digest ?? "")
      || (receipt.choice === "remind"
        ? !strictDate(receipt.remind_at) || Date.parse(receipt.remind_at) <= now
        : receipt.remind_at !== undefined && receipt.remind_at !== "")) {
      throw new Error("persistent current-user choice receipt is invalid, replayed, or cross-bound");
    }
    const internalAt = new Date(now).toISOString();
    const boundReceipt = Object.freeze({ ...receipt,
      user_message_at: strictDate(receipt.user_message_at) ? receipt.user_message_at : internalAt,
      confirmed_at: internalAt, remind_at: receipt.choice === "remind" ? receipt.remind_at : "" });
    const planTarget = persistentPlanPath(repositoryReal, challengeId);
    if (record.status === "completed") {
      if (record.message_ref !== boundReceipt.message_ref || record.message_digest !== boundReceipt.message_digest
        || record.choice !== boundReceipt.choice || record.remind_at !== boundReceipt.remind_at) {
        throw new Error("persistent challenge was completed by a different message");
      }
      return deepFreeze({ decision: "persistent-learning-capture-already-committed", executable: false,
        persistentChallengeId: challengeId, planDigest: record.plan_digest, idempotent: true });
    }
    if (record.status === "planned") {
      if (record.message_ref !== boundReceipt.message_ref || record.message_digest !== boundReceipt.message_digest
        || record.choice !== boundReceipt.choice || record.remind_at !== boundReceipt.remind_at || !existsSync(planTarget)) {
        throw new Error("persistent challenge was already consumed by a different message");
      }
      const existing = readPersistentJson(planTarget, 64 * 1024 * 1024, "persistent transaction plan");
      if (!validateLearningCaptureTransactionPlan(existing) || existing.planDigest !== record.plan_digest) throw new Error("stored transaction plan is invalid");
      trustedPlans.set(existing, Object.freeze({ repositoryReal, noWrite: existing.writeSet.length === 0 }));
      return deepFreeze({ decision: "persistent-learning-capture-plan-ready", executable: false,
        persistentChallengeId: challengeId, planRef: record.plan_ref, plan: existing, idempotent: true });
    }
    if (currentPersistentStateDigest(repositoryReal) !== record.state_digest) throw new Error("repository state changed after the user reviewed the persistent challenge");
    const observationReceipt = createLearningCaptureObservationReceipt(repositoryReal, observationAssertion);
    if (observationReceipt.decision !== "learning-capture-host-observation-bound"
      || observationReceipt.observationDigest !== record.observation_digest) {
      throw new Error("recomputed host observation differs from the observation reviewed before the choice");
    }
    const embedded = createLearningCaptureChoiceChallenge(repositoryReal, proposal, {
      levelEvidence, observationReceipt, allowPromptOnlyLowRiskKeep,
    });
    if (embedded.decision !== "learning-capture-current-user-choice-required"
      || embedded.instanceId !== record.instance_id || embedded.proposalDigest !== record.proposal_digest
      || embedded.preview.exactFormalPreviewDigest !== record.formal_preview_digest
      || (embedded.preview.directWriteSet.length > 0 ? "direct" : "review") !== normalizedReviewMode(record.direct_keep_mode)) {
      throw new Error("recomputed proposal, formal preview, gates, or direct-write eligibility differs from the reviewed challenge");
    }
    const reboundAt = new Date().toISOString();
    const selection = confirmLearningCaptureChoice(embedded, {
      ...boundReceipt, user_message_at: reboundAt, confirmed_at: reboundAt,
      proposal_digest: embedded.proposalDigest, challenge_nonce: embedded.challengeNonce,
    });
    if (!["learning-capture-choice-confirmed", "learning-capture-discard-confirmed"].includes(selection.decision)) {
      throw new Error("persistent user choice could not be rebound to the recomputed same-process transaction");
    }
    const plan = buildLearningCaptureTransactionPlan(repositoryReal, selection);
    if (!validateLearningCaptureTransactionPlan(plan)) throw new Error(plan.reason ?? "recomputed transaction plan is invalid");
    if (boundReceipt.choice === "discard") {
      unlinkSync(target);
      removeEmptyPersistentDirectories(repositoryReal);
      return deepFreeze({ decision: "persistent-learning-capture-discard-closed", executable: false,
        durableEffect: "zero-semantic-writes", plan, operationalRecordRemoved: true });
    }
    atomicJson(planTarget, plan);
    const planRef = `${PERSISTENT_CAPTURE_DIR}/${challengeId}.plan.json`;
    atomicJson(target, { ...record, status: "planned", message_ref: boundReceipt.message_ref,
      message_digest: boundReceipt.message_digest, choice: boundReceipt.choice, remind_at: boundReceipt.remind_at,
      plan_digest: plan.planDigest, plan_ref: planRef }, { replace: true });
    return deepFreeze({ decision: "persistent-learning-capture-plan-ready", executable: false,
      persistentChallengeId: challengeId, planRef, plan, idempotent: false });
  } catch (error) {
    return deepFreeze({ decision: "persistent-learning-capture-confirm-denied", reason: error.message, executable: false });
  }
}

export function closePersistentLearningCaptureChallenge(repository, { challengeId, challengeNonce } = {}) {
  try {
    const repositoryReal = realpathSync(repository); const target = persistentRecordPath(repositoryReal, challengeId);
    const record = readPersistentJson(target, 32 * 1024, "persistent challenge record");
    if (!validPersistentRecord(record, repositoryReal) || record.challenge_nonce !== challengeNonce) throw new Error("persistent challenge close request is invalid");
    const plan = persistentPlanPath(repositoryReal, challengeId);
    let transactionState = "prepared-with-no-plan";
    if (record.status === "planned") {
      const boundPlan = readBoundPersistentPlan(repositoryReal, record);
      const state = inspectStructurallyTrustedPlanState(repositoryReal, boundPlan);
      transactionState = state.decision;
      if (state.decision === "learning-capture-rollback-required") {
        return deepFreeze({ decision: "persistent-learning-capture-close-rollback-required", executable: false,
          persistentChallengeId: challengeId, checkpoint: state.checkpoint, planRef: record.plan_ref,
          operationalRecordPreserved: true });
      }
      if (state.decision === "learning-capture-recovery-required") {
        return deepFreeze({ decision: "persistent-learning-capture-close-recovery-required", executable: false,
          persistentChallengeId: challengeId, reason: state.reason, planRef: record.plan_ref,
          operationalRecordPreserved: true });
      }
      if (!["learning-capture-ready-for-host-execution", "learning-capture-already-committed"].includes(state.decision)) {
        throw new Error(`persistent planned transaction is not safely closable: ${state.decision}`);
      }
    }
    if (existsSync(plan)) unlinkSync(plan);
    unlinkSync(target);
    removeEmptyPersistentDirectories(repositoryReal);
    return deepFreeze({ decision: "persistent-learning-capture-closed", executable: false,
      durableEffect: "zero-semantic-writes", transactionState, operationalRecordRemoved: true });
  } catch (error) {
    return deepFreeze({ decision: "persistent-learning-capture-close-denied", reason: error.message, executable: false });
  }
}

export function loadPersistentLearningCapturePlan(repository, { challengeId, challengeNonce } = {}) {
  try {
    const repositoryReal = realpathSync(repository); const target = persistentRecordPath(repositoryReal, challengeId);
    const record = readPersistentJson(target, 32 * 1024, "persistent challenge record");
    const expectedPlanRef = `${PERSISTENT_CAPTURE_DIR}/${challengeId}.plan.json`;
    if (!validPersistentRecord(record, repositoryReal) || record.status !== "planned"
      || record.challenge_nonce !== challengeNonce || record.plan_ref !== expectedPlanRef) {
      throw new Error("persistent plan load request is invalid or the challenge is not planned");
    }
    const plan = readBoundPersistentPlan(repositoryReal, record);
    const state = inspectStructurallyTrustedPlanState(repositoryReal, plan);
    trustedPlans.set(plan, Object.freeze({ repositoryReal, noWrite: plan.writeSet.length === 0 }));
    return deepFreeze({ decision: "persistent-learning-capture-plan-loaded", executable: false,
      persistentChallengeId: challengeId, planRef: expectedPlanRef, transactionState: state.decision, plan });
  } catch (error) {
    return deepFreeze({ decision: "persistent-learning-capture-plan-load-denied", reason: error.message, executable: false });
  }
}

function reminderStateDigest(state) {
  return sha256(canonical({
    manifest: state.manifestRead.digest, control: state.controlRead.digest, index: state.indexRead.digest,
    candidate: state.candidateRead.digest, signal: state.signalRead.digest,
    signalMap: state.signalMapRead.digest, timeMap: state.timeMapRead.digest,
  }));
}

function loadReminderState(repositoryReal, candidateId) {
  const manifestRead = stableRead(repositoryReal, MANIFEST_REF, limits.manifest);
  const manifest = validateInstanceManifestStructure(parseSectionedToml(manifestRead.text, "instance manifest"));
  if (manifest.root.state !== "instance") throw new Error("an instantiated AI Carry is required");
  const controlRead = stableRead(repositoryReal, CONTROL_REF, limits.control);
  const control = validateControl(rootOnly(controlRead.text, "signal control"), manifest.root.instance_id);
  const indexRead = stableRead(repositoryReal, CANDIDATE_INDEX_REF, limits.candidateIndex);
  const index = parseCandidateIndex(indexRead, manifest.root.instance_id);
  const entry = index.entries.find((item) => item.id === candidateId);
  if (!entry) throw new Error("the requested reminder candidate is not in the bounded active index");
  const candidateRead = stableRead(repositoryReal, entry.source_ref, limits.candidateSource);
  const candidateParsed = parseMarkdownFrontmatterHead(candidateRead.text, "reminder candidate");
  if (!validateGeneratedCandidateSource(candidateParsed.values, entry)) throw new Error("reminder candidate source and index do not close exactly");
  const timeMapRead = stableRead(repositoryReal, TIME_MAP_REF, limits.timeMap);
  const timeMap = parseTimeMap(timeMapRead, manifest.root.instance_id, control.projection_revision);
  const triggers = timeMap.entries.filter((item) => item.source_ref === entry.source_ref);
  if (triggers.length !== 1 || triggers[0].next_check_at !== candidateParsed.values.remind_at
    || triggers[0].source_trigger_revision !== candidateParsed.values.trigger_revision) throw new Error("candidate has no single exact reminder projection");
  const trigger = triggers[0];
  const signalSourceRef = `instance/signals/count/${trigger.id}.toml`;
  if (!portableRef(signalSourceRef, { prefix: "instance/signals/", extension: ".toml" })) throw new Error("reminder signal path is not portable");
  const signalRead = stableRead(repositoryReal, signalSourceRef, limits.signalSource);
  const signal = parseSignalSource(signalRead.text, "reminder learning signal");
  if (!validateGeneratedSignalSource(signal, { signalId: trigger.id, signalSourceRef,
    candidate: candidateParsed.values, reminderAt: candidateParsed.values.remind_at })) throw new Error("reminder learning signal is invalid or drifted");
  const signalMapRead = stableRead(repositoryReal, SIGNAL_MAP_REF, limits.signalMap);
  const signalMap = parseSignalMap(signalMapRead, manifest.root.instance_id, control.projection_revision);
  if (signalMap.root.scheduled_count !== timeMap.entries.length || signalMap.root.next_wakeup_at !== timeMap.root.next_wakeup_at
    || signalMap.entries.some((item) => item.id === trigger.id || item.source_ref === signalSourceRef)) {
    throw new Error("reminder projections are not one clean observing-state revision");
  }
  const state = { repositoryReal, instanceId: manifest.root.instance_id, manifestRead, controlRead, control,
    indexRead, index, entry, candidateRead, candidateParsed, timeMapRead, timeMap, trigger,
    signalRead, signal, signalSourceRef, signalMapRead, signalMap };
  return Object.freeze({ ...state, stateDigest: reminderStateDigest(state) });
}

export function shortlistLearningReminderCancellations(repository, { query } = {}) {
  try {
    const repositoryReal = realpathSync(repository);
    if (!clean(query, 240, false) || locateHighConfidenceSecretCandidates(query).blocked
      || containsForbiddenLocationReference(query)) throw new Error("a short non-sensitive natural-language reminder description is required");
    const manifestRead = stableRead(repositoryReal, MANIFEST_REF, limits.manifest);
    const manifest = validateInstanceManifestStructure(parseSectionedToml(manifestRead.text, "instance manifest"));
    if (manifest.root.state !== "instance") throw new Error("an instantiated AI Carry is required");
    const controlRead = stableRead(repositoryReal, CONTROL_REF, limits.control);
    const control = validateControl(rootOnly(controlRead.text, "signal control"), manifest.root.instance_id);
    const indexRead = stableRead(repositoryReal, CANDIDATE_INDEX_REF, limits.candidateIndex);
    const index = parseCandidateIndex(indexRead, manifest.root.instance_id);
    const timeMapRead = stableRead(repositoryReal, TIME_MAP_REF, limits.timeMap);
    const timeMap = parseTimeMap(timeMapRead, manifest.root.instance_id, control.projection_revision);
    const scheduledRefs = new Map(timeMap.entries.map((item) => [item.source_ref, item]));
    const scheduledEntries = index.entries.filter((entry) => scheduledRefs.has(entry.source_ref));
    const recencyIntent = /(?:刚才|刚刚|最近|上一条|上一个).{0,8}(?:提醒|那条|那个)|(?:提醒|那条|那个).{0,8}(?:刚才|刚刚|最近|上一条|上一个)/u.test(query);
    const ranked = recencyIntent
      ? scheduledEntries.sort((left, right) => Date.parse(right.last_evidence_at) - Date.parse(left.last_evidence_at)
        || left.id.localeCompare(right.id, "en")).slice(0, 3)
        .map((entry) => ({ entry, trigger: scheduledRefs.get(entry.source_ref), score: 1 }))
      : rankRetrievalEntries(scheduledEntries, normalizeRetrievalRequest(query), { limit: 3 })
        .map((result) => ({ entry: result.entry, trigger: scheduledRefs.get(result.entry.source_ref), score: result.score }));
    if (ranked.length === 0) throw new Error("no active learning reminder is available in the bounded reminder index");
    const shortlist = deepFreeze({ decision: "learning-reminder-cancellation-shortlist-ready", executable: false,
      query, maximumItems: 3, needsSelection: ranked.length > 1,
      guidance: ranked.length > 1 ? "我找到了几条可能的提醒，请按标题或序号确认要取消哪一条。" : "我找到了一条可能的提醒，请确认是否取消。",
      items: ranked.map((item, index) => Object.freeze({ position: index + 1, title: item.entry.title,
        summary: item.entry.summary, scheduledFor: item.trigger.next_check_at })) });
    trustedReminderShortlists.set(shortlist, Object.freeze({ repositoryReal, instanceId: manifest.root.instance_id,
      stateDigest: sha256(canonical({ manifest: manifestRead.digest, control: controlRead.digest,
        index: indexRead.digest, timeMap: timeMapRead.digest })), candidateIds: ranked.map((item) => item.entry.id) }));
    return shortlist;
  } catch (error) {
    return deepFreeze({ decision: "learning-reminder-cancellation-shortlist-denied", reason: error.message, executable: false });
  }
}

export function createLearningReminderCancellationChallenge(repository, { candidateId, shortlist, selection } = {}) {
  try {
    const repositoryReal = realpathSync(repository);
    if (shortlist !== undefined) {
      const shortlistTrust = trustedReminderShortlists.get(shortlist);
      const selected = shortlistTrust?.candidateIds.length === 1 && selection === undefined ? 1 : selection;
      if (!shortlistTrust || consumedReminderShortlists.has(shortlist) || shortlistTrust.repositoryReal !== repositoryReal
        || !Number.isSafeInteger(selected)
        || selected < 1 || selected > shortlistTrust.candidateIds.length) throw new Error("a current same-process reminder shortlist selection is required");
      consumedReminderShortlists.add(shortlist); candidateId = shortlistTrust.candidateIds[selected - 1];
    }
    if (!stableAssetId.test(candidateId ?? "")) throw new Error("a stable routed candidate is required");
    const state = loadReminderState(repositoryReal, candidateId);
    const issuedAtMs = Date.now(); const nonce = randomBytes(18).toString("hex");
    const challenge = deepFreeze({
      decision: "learning-reminder-cancellation-current-user-confirmation-required", executable: false,
      instanceId: state.instanceId, candidateId, candidateSourceRevision: state.candidateParsed.values.source_revision,
      reminderAt: state.candidateParsed.values.remind_at, challengeNonce: nonce,
      issuedAt: new Date(issuedAtMs).toISOString(), expiresAt: "",
      preview: Object.freeze({ title: state.entry.title, scheduledFor: state.candidateParsed.values.remind_at,
        question: "确认取消这条学习提醒吗？取消后保留观察候选，但不再按这个时间提醒。",
        confirmLabel: "确认取消提醒", keepLabel: "保留提醒" }),
      confirmationTrust: "same-process-host-asserted-current-user-message-not-independent-validation",
    });
    trustedCancellationChallenges.set(challenge, Object.freeze({ repositoryReal, stateDigest: state.stateDigest,
      instanceId: state.instanceId, candidateId, candidateSourceRef: state.entry.source_ref,
      signalId: state.trigger.id, signalSourceRef: state.signalSourceRef,
      issuedAtMs, nonce }));
    return challenge;
  } catch (error) {
    return deepFreeze({ decision: "learning-reminder-cancellation-challenge-denied", reason: error.message, executable: false });
  }
}

export function confirmLearningReminderCancellation(challenge, receipt) {
  const trust = trustedCancellationChallenges.get(challenge); const now = Date.now(); purgeMessageRefs(now);
  const key = trust ? `${trust.repositoryReal}\u0000${trust.instanceId}\u0000${receipt?.message_ref ?? ""}` : "";
  const valid = trust && compatibleReceipt(receipt, cancellationReceiptRequiredFields, cancellationReceiptFields)
    && receipt.basis === "host-current-user-message"
    && stableAssetId.test(receipt.message_ref ?? "") && digestPattern.test(receipt.message_digest ?? "")
    && receipt.candidate_id === trust.candidateId && receipt.instance_id === trust.instanceId
    && receipt.challenge_nonce === trust.nonce && !consumedMessageRefs.has(key);
  if (!valid) return deepFreeze({ decision: "learning-reminder-cancellation-denied", reason: "receipt-invalid-replayed-or-cross-bound", executable: false });
  let current;
  try { current = loadReminderState(trust.repositoryReal, trust.candidateId); }
  catch { return deepFreeze({ decision: "learning-reminder-cancellation-denied", reason: "reminder-state-unavailable", executable: false }); }
  if (current.stateDigest !== trust.stateDigest) return deepFreeze({ decision: "learning-reminder-cancellation-denied", reason: "reminder-state-drifted", executable: false });
  const internalAt = new Date(now).toISOString();
  const boundReceipt = Object.freeze({ ...receipt,
    user_message_at: strictDate(receipt.user_message_at) ? receipt.user_message_at : internalAt,
    confirmed_at: internalAt });
  trustedCancellationChallenges.delete(challenge); consumedMessageRefs.set(key, Number.POSITIVE_INFINITY);
  const transactionAt = new Date(now).toISOString();
  const operationHex = createHash("sha256").update(`${trust.instanceId}\u0000${trust.nonce}\u0000${receipt.message_ref}\u0000${receipt.message_digest}\u0000cancel-reminder`).digest("hex");
  const confirmation = deepFreeze({ decision: "learning-reminder-cancellation-confirmed", executable: false,
    instanceId: trust.instanceId, candidateId: trust.candidateId, signalId: trust.signalId,
    transactionAt, durableEffect: "host-transaction-plan-required",
    sourceTrust: "host-asserted-current-user-message-not-independently-verified" });
  trustedCancellations.set(confirmation, Object.freeze({ ...trust, receipt: boundReceipt, transactionAt,
    operationId: `operation.cancel-reminder.${operationHex.slice(0, 24)}`, eventId: `event.cancel-reminder.${operationHex.slice(24, 48)}`,
    taskId: `task.cancel-reminder.${operationHex.slice(8, 32)}`, contextId: `context.cancel-reminder.${operationHex.slice(32, 56)}` }));
  return confirmation;
}

function tomlValue(value) {
  if (typeof value === "string" || Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "boolean" || Number.isSafeInteger(value)) return String(value);
  throw new Error("unsupported canonical TOML value");
}

function serializeRoot(root, order) {
  return order.map((key) => `${key} = ${tomlValue(root[key])}`).join("\n");
}

function serializeArrayTable(root, rootOrder, table, entries, entryOrder) {
  const chunks = [serializeRoot(root, rootOrder)];
  for (const entry of entries) chunks.push(`[[${table}]]\n${serializeRoot(entry, entryOrder)}`);
  return `${chunks.join("\n\n")}\n`;
}

function serializeCandidateSource(candidate, body) {
  const order = [
    "id", "kind", "status", "title", "summary", "triggers", "scope", "excludes", "lifecycle",
    "expected_next_use", "topic_key", "subject_key", "aliases", "conditions", "target_kind", "target_subtype",
    "candidate_relation", "observation_state", "observation_basis", "observation_event_ref", "claim_summary",
    "proposed_risk_tier", "independent_event_count", "successful_event_count", "failed_event_count",
    "distinct_context_count", "representative_event_ids", "last_evidence_at", "remind_at", "snoozed_until",
    "trigger_revision", "source_revision", "source_refs", "private_refs", "supersedes", "minimum_level",
    "approval_state", "activation_basis", "risk_tier", "approved_by_user", "updated_at",
  ];
  return `+++\n${serializeRoot(candidate, order)}\n+++\n${body.trim()}\n`;
}

function serializeSignalSource(signal, match, trigger, evidence) {
  const rootOrder = ["schema_version", "record_type", "id", "signal_type", "evaluation_family", "status", "title", "reason",
    "domain", "route_id", "revision", "created_at", "updated_at", "last_verified_at", "asset_refs", "candidate_source_revision",
    "related_signal_ids", "minimum_level", "confirmation", "provenance", "trust_state"];
  const matchOrder = ["asset_kind", "subject", "claim", "scope", "conditions", "aliases"];
  const triggerOrder = ["mode", "independent_event_count", "threshold_value", "progress_summary", "next_event", "next_check_at"];
  const evidenceOrder = ["event_id", "event_source", "task_id", "context_id", "occurred_at", "source_kind", "source_ref", "independent", "relation", "summary"];
  const chunks = [serializeRoot(signal, rootOrder), `[match]\n${serializeRoot(match, matchOrder)}`, `[trigger]\n${serializeRoot(trigger, triggerOrder)}`];
  for (const item of evidence) chunks.push(`[[evidence]]\n${serializeRoot(item, evidenceOrder)}`);
  return `${chunks.join("\n\n")}\n`;
}

function artifact(ref, content, maxBytes) {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length > maxBytes) throw new Error(`${ref} proposal exceeds its byte budget`);
  return Object.freeze({ target: ref, digest: sha256(buffer), byteLength: buffer.length,
    encoding: "base64", contentBase64: buffer.toString("base64") });
}

function preimage(read, target) {
  return Object.freeze({ target, digest: read?.digest ?? "absent", byteLength: read?.byteLength ?? 0,
    encoding: read ? "base64" : "absent", contentBase64: read ? read.buffer.toString("base64") : "" });
}

function candidateBody(proposal, { choice, sourceKind, resultState }) {
  const intended = choice === "keep"
    ? "用户已经对展示过的正式内容与范围选择“留下”。当前建立不可执行的定向复核交接，只复核架构与风险；内容没有实质变化时不重复询问，内容、范围、排除项或未来动作门变化时才展示差异并重新确认。精确绑定由同目录的结构化复核载荷负责，不把内部摘要写进用户说明。"
    : choice === "remind"
      ? "用户选择以后提醒；当前建立可撤销观察候选与时间提醒，尚未成为正式资产。"
      : "用户选择先观察；当前只建立可撤销观察候选，尚未成为正式资产。";
  return `# 核心主张与未来价值\n\n${proposal.claim_summary}\n\n# 来源、独立证据与限制\n\n${intended}\n主张来源类别为 ${sourceKind}，任务结果状态为 ${resultState}；保存授权来自随后单独的用户选择，两者没有混成同一条证据。该来源仍只是宿主断言，不是独立验证事实；首次只记录 1 个任务事件和 1 个情境，成功次数仍为 0。外部内容、其他 Agent 内容或未知来源不会因本记录被洗白成当前宿主事实。未保存对话正文、秘密或设备绝对路径。\n\n# 同类匹配与关系判断\n\n主题：${proposal.topic_key || "未命名主题"}；对象：${proposal.subject_key || "未命名对象"}。创建前比较了候选极小索引和可信正式资产地图；若存在同 ID 或高置信同类内容，只暂停这一项并请用户复核。\n\n# 风险与建议动作\n\n建议风险为 ${proposal.proposed_risk_tier}。候选目标由 AI Carry 内部归类为 ${proposal.target_kind}，用户不需要理解或选择内部资产类型。\n\n# 给用户的简短说明\n\n${proposal.summary}\n选择“不保存”或没有回答时不会生成本文件；选择提醒后可直接用日常语言说“取消刚才那条学习提醒”。`;
}

function buildState(repositoryReal, trust) {
  const { checked, ids, receipt, transactionAt } = trust;
  const manifestRead = stableRead(repositoryReal, MANIFEST_REF, limits.manifest);
  const manifest = validateInstanceManifestStructure(parseSectionedToml(manifestRead.text, "instance manifest"));
  if (manifest.root.state !== "instance" || manifest.root.instance_id !== trust.instanceId || manifestRead.digest !== trust.manifestDigest) {
    throw new Error("instance identity changed after the user choice");
  }
  const currentFormal = loadTrustedDomainEnvelope(repositoryReal, { explicitRequestedId: checked.formal.id });
  const currentFormalDigest = trustedMaintenanceStateDigest(repositoryReal, currentFormal.envelope);
  const currentFormalDuplicates = formalDuplicateProbe(repositoryReal, currentFormal.envelope, checked);
  if (currentFormal.context.instanceId !== trust.instanceId || currentFormalDigest !== trust.formalStateDigest
    || registeredFormalId(currentFormal.envelope, checked.formal.id)
    || currentFormalDuplicates.decision !== "duplicate-check-complete" || currentFormalDuplicates.matches.length > 0) {
    throw new Error("formal routes changed or now contain a semantic duplicate");
  }
  let controlRead = null; let control = null;
  let indexRead = null; let index = null;
  let signalMapRead = null; let signalMap = null;
  let timeMapRead = null; let timeMap = null;
  let signalRead = null;
  const projectionIssues = [];
  try {
    const allowPristineTemplate = pristineDerivedFoldersAreEmpty(repositoryReal);
    controlRead = stableRead(repositoryReal, CONTROL_REF, limits.control);
    control = controlForLearningWrite(controlRead, trust.instanceId, transactionAt, allowPristineTemplate);
    indexRead = stableRead(repositoryReal, CANDIDATE_INDEX_REF, limits.candidateIndex);
    index = candidateIndexForLearningWrite(indexRead, trust.instanceId, allowPristineTemplate);
    signalMapRead = stableRead(repositoryReal, SIGNAL_MAP_REF, limits.signalMap);
    signalMap = signalMapForLearningWrite(signalMapRead, trust.instanceId, control.projection_revision, allowPristineTemplate);
    timeMapRead = stableRead(repositoryReal, TIME_MAP_REF, limits.timeMap);
    timeMap = timeMapForLearningWrite(timeMapRead, trust.instanceId, control.projection_revision, allowPristineTemplate);
    if (signalMap.root.scheduled_count !== timeMap.entries.length
      || signalMap.root.next_wakeup_at !== timeMap.root.next_wakeup_at) {
      throw new Error("time and startup projections are not one clean revision");
    }
  } catch {
    projectionIssues.push("learning-derived-state-refresh-pending");
  }
  if (projectionIssues.length === 0) {
    if (index.entries.some((entry) => entry.id === ids.candidateId
      || entry.source_ref.toLowerCase() === ids.candidateSourceRef.toLowerCase())) {
      throw new Error("runtime-derived candidate already exists");
    }
    if (index.entries.some((entry) => semanticDuplicate(entry, checked.proposal))) {
      throw new Error("a semantically similar candidate already exists and must be routed instead of duplicated");
    }
    try {
      signalRead = stableRead(repositoryReal, ids.signalSourceRef, limits.signalSource, { allowMissing: true });
      if (signalRead || signalMap.entries.some((entry) => entry.id === ids.signalId
        || entry.source_ref.toLowerCase() === ids.signalSourceRef.toLowerCase())
        || timeMap.entries.some((entry) => entry.id === ids.signalId)) {
        projectionIssues.push("learning-derived-state-refresh-pending");
      }
    } catch {
      projectionIssues.push("learning-derived-state-refresh-pending");
    }
  }
  const candidateRead = stableRead(repositoryReal, ids.candidateSourceRef, limits.candidateSource, { allowMissing: true });
  const reviewPayloadRead = receipt.choice === "keep"
    ? stableRead(repositoryReal, ids.reviewPayloadRef, limits.reviewPayload, { allowMissing: true }) : null;
  if (candidateRead || reviewPayloadRead) throw new Error("candidate or review payload path is already occupied");

  // When direct formal closure is unavailable, "keep" becomes a durable,
  // non-executable targeted-review handoff. It preserves the exact authorization
  // without treating the host observation as independent result validation.
  const status = "candidate";
  const candidate = {
    id: ids.candidateId, kind: "evolution-candidate", status,
    title: checked.proposal.title, summary: checked.proposal.summary, triggers: checked.proposal.triggers,
    scope: checked.proposal.scope, excludes: checked.proposal.excludes, lifecycle: "review", expected_next_use: "",
    topic_key: checked.proposal.topic_key, subject_key: checked.proposal.subject_key, aliases: checked.proposal.aliases,
    conditions: checked.proposal.conditions, target_kind: checked.proposal.target_kind, target_subtype: checked.proposal.target_subtype,
    candidate_relation: checked.proposal.candidate_relation, observation_state: "explicit", observation_basis: "explicit-user",
    observation_event_ref: ids.eventId, claim_summary: checked.proposal.claim_summary,
    proposed_risk_tier: checked.proposal.proposed_risk_tier, independent_event_count: 1, successful_event_count: 0,
    failed_event_count: 0, distinct_context_count: 1, representative_event_ids: [ids.eventId],
    last_evidence_at: ids.observedAt, remind_at: receipt.choice === "remind" ? receipt.remind_at : "",
    snoozed_until: "", trigger_revision: receipt.choice === "remind" ? 1 : 0, source_revision: 1,
    source_refs: receipt.choice === "keep" ? [ids.reviewPayloadId] : [], private_refs: [], supersedes: [], minimum_level: checked.proposal.minimum_level,
    approval_state: "pending", activation_basis: "candidate", risk_tier: checked.proposal.proposed_risk_tier,
    approved_by_user: false, updated_at: transactionAt,
  };
  const reviewPayload = receipt.choice === "keep" ? Object.freeze({
    schema_version: 1, record_type: "awaiting-learning-review", id: ids.reviewPayloadId,
    state: "awaiting-review", candidate_id: ids.candidateId,
    formal_id: checked.formal.id, formal_kind: checked.formal.kind,
    formal_preview_digest: checked.formalDigest, formal_preview_encoding: "base64",
    formal_preview_base64: Buffer.from(checked.proposal.formal_preview, "utf8").toString("base64"),
    authorization: Object.freeze({ basis: "current-user-exact-preview-keep", message_ref: receipt.message_ref,
      message_digest: receipt.message_digest, message_at: receipt.user_message_at,
      content_scope: "exact-formal-preview-and-user-visible-scope", exact_content_authorized: true,
      future_actions_authorized: false }),
    review: Object.freeze({ reason: trust.directKeep.reason, recommended_level: 3,
      exact_preview_may_reuse_authorization: true, material_change_requires_new_confirmation: true,
      result_validation_claimed: false, executable: false }),
  }) : null;
  const reviewPayloadArtifact = reviewPayload
    ? artifact(ids.reviewPayloadRef, `${JSON.stringify(reviewPayload, null, 2)}\n`, limits.reviewPayload) : null;
  const candidateText = serializeCandidateSource(candidate, candidateBody(checked.proposal, {
    choice: receipt.choice, sourceKind: ids.sourceKind, resultState: ids.resultState,
  }));
  const candidateArtifact = artifact(ids.candidateSourceRef, candidateText, limits.candidateSource);
  if (projectionIssues.includes("learning-derived-state-refresh-pending")) {
    return {
      manifestRead, controlRead, indexRead, signalMapRead, timeMapRead, candidateRead, signalRead, reviewPayloadRead,
      publicSnapshotRead: null, distSnapshotRead: null, candidateArtifact,
      indexArtifact: null, signalArtifact: null, timeArtifact: null, signalMapArtifact: null,
      cleanControlArtifact: null, publicSnapshotArtifact: null, distSnapshotArtifact: null,
      reviewPayloadArtifact, projectionIssues,
    };
  }
  const candidateEntry = {
    id: candidate.id, title: candidate.title, summary: candidate.summary, topic_key: candidate.topic_key,
    subject_key: candidate.subject_key, triggers: candidate.triggers, aliases: candidate.aliases, scope: candidate.scope,
    conditions: candidate.conditions, excludes: candidate.excludes, target_kind: candidate.target_kind,
    target_subtype: candidate.target_subtype, candidate_relation: candidate.candidate_relation, status: candidate.status,
    observation_state: candidate.observation_state, observation_basis: candidate.observation_basis,
    risk_tier: candidate.risk_tier, independent_event_count: 1, last_evidence_at: candidate.last_evidence_at,
    source_ref: ids.candidateSourceRef, source_revision: 1,
  };
  const indexEntries = [...index.entries, candidateEntry].sort((left, right) => left.id.localeCompare(right.id, "en"));
  const indexRoot = { ...index.root, state: "current", source_revision: index.root.source_revision + 1,
    generated_at: transactionAt, candidate_count: indexEntries.length, indexed_count: indexEntries.length,
    active_count: indexEntries.filter((entry) => entry.status === "candidate").length };
  const indexText = serializeArrayTable(indexRoot,
    ["schema_version", "index_id", "instance_id", "state", "source_revision", "generated_at", "budget_bytes", "overflow", "candidate_count", "indexed_count", "active_count"],
    "candidates", indexEntries,
    ["id", "title", "summary", "topic_key", "subject_key", "triggers", "aliases", "scope", "conditions", "excludes", "target_kind", "target_subtype", "candidate_relation", "status", "observation_state", "observation_basis", "risk_tier", "independent_event_count", "last_evidence_at", "source_ref", "source_revision"]);
  const indexArtifact = artifact(CANDIDATE_INDEX_REF, indexText, limits.candidateIndex);
  if (Buffer.byteLength(serializeArrayTable({}, [], "candidates", [candidateEntry], [...candidateEntry ? Object.keys(candidateEntry) : []]), "utf8") > 2048) {
    throw new Error("candidate index entry exceeds its per-entry budget");
  }

  const signalStatus = receipt.choice === "keep" ? "pending-review" : "observing";
  const signal = { schema_version: 1, record_type: "cross-session-signal", id: ids.signalId,
    signal_type: "learning-candidate-review", evaluation_family: "count", status: signalStatus,
    title: "已获准保留一项可能可复用的做法", reason: receipt.choice === "keep" ? "用户已确认精确内容，等待定向复核架构与风险" : "用户选择先观察，等待后续真实任务验证",
    domain: "evolution-model", route_id: "evolution-review", revision: 1, created_at: transactionAt,
    updated_at: transactionAt, last_verified_at: "", asset_refs: [ids.candidateId], candidate_source_revision: 1,
    related_signal_ids: [], minimum_level: checked.proposal.minimum_level, confirmation: "risk-dependent",
    provenance: `host-asserted-${ids.sourceKind}`, trust_state: "candidate" };
  const signalMatch = { asset_kind: checked.proposal.target_kind, subject: "", claim: "", scope: [], conditions: [], aliases: [] };
  // The signal remains a count-family learning signal. The separate time map
  // owns reminder scheduling, matching the existing signal runtime contract.
  const signalTrigger = { mode: "count", independent_event_count: 1,
    threshold_value: receipt.choice === "keep" ? 1 : 3, progress_summary: "已记录 1 个不同任务情境",
    next_event: receipt.choice === "keep" ? "定向复核架构与风险；精确内容未变时沿用已有授权" : "在新的真实任务中再次验证",
    next_check_at: receipt.choice === "remind" ? receipt.remind_at : "" };
  const evidence = [{ event_id: ids.eventId, event_source: ids.sourceKind, task_id: ids.taskId,
    context_id: ids.contextId, occurred_at: ids.observedAt, source_kind: ids.sourceKind,
    source_ref: ids.observationRef, independent: true, relation: "supporting", summary: "" }];
  const signalArtifact = artifact(ids.signalSourceRef, serializeSignalSource(signal, signalMatch, signalTrigger, evidence), limits.signalSource);

  const timeEntries = [...timeMap.entries];
  if (receipt.choice === "remind") timeEntries.push({ id: ids.signalId, kind: "evolution-candidate", status: "scheduled",
    title: "复核一项已获准保留的学习候选", next_check_at: receipt.remind_at, effective_check_at: receipt.remind_at,
    domain: "evolution-model", route_id: "evolution-review", source_ref: ids.candidateSourceRef,
    source_trigger_revision: 1, minimum_level: checked.proposal.minimum_level, confirmation: "risk-dependent" });
  timeEntries.sort((left, right) => left.id.localeCompare(right.id, "en"));
  const nextWakeup = deterministicEarliest(timeEntries);
  const nextRevision = control.source_revision + 1;
  const timeRoot = { ...timeMap.root, state: timeEntries.length === 0 ? "empty" : "current", source_revision: nextRevision,
    generated_at: transactionAt, scheduled_count: timeEntries.length, next_wakeup_at: nextWakeup };
  const timeArtifact = artifact(TIME_MAP_REF, serializeArrayTable(timeRoot,
    ["schema_version", "map_id", "instance_id", "state", "source_revision", "generated_at", "scheduled_count", "next_wakeup_at"],
    "triggers", timeEntries,
    ["id", "kind", "status", "title", "next_check_at", "effective_check_at", "domain", "route_id", "source_ref", "source_trigger_revision", "minimum_level", "confirmation"]), limits.timeMap);

  const signalEntries = [...signalMap.entries];
  if (signalStatus === "pending-review") signalEntries.push({ id: signal.id, signal_type: signal.signal_type, status: signal.status,
    reason: signal.reason, progress: signalTrigger.progress_summary, next_event: signalTrigger.next_event,
    domain: signal.domain, route_id: signal.route_id, source_ref: ids.signalSourceRef, source_signal_revision: 1,
    provenance: signal.provenance, trust_state: signal.trust_state, minimum_level: signal.minimum_level, confirmation: signal.confirmation });
  signalEntries.sort((left, right) => left.id.localeCompare(right.id, "en"));
  const signalRoot = { ...signalMap.root, state: signalEntries.length === 0 && timeEntries.length === 0 ? "empty" : "current",
    source_revision: nextRevision, generated_at: transactionAt, active_count: signalEntries.length,
    scheduled_count: timeEntries.length, next_wakeup_at: nextWakeup };
  const signalMapArtifact = artifact(SIGNAL_MAP_REF, serializeArrayTable(signalRoot,
    ["schema_version", "map_id", "instance_id", "state", "source_revision", "generated_at", "budget_bytes", "overflow", "active_count", "scheduled_count", "next_wakeup_at", "next_wakeup_ref"],
    "signals", signalEntries,
    ["id", "signal_type", "status", "reason", "progress", "next_event", "domain", "route_id", "source_ref", "source_signal_revision", "provenance", "trust_state", "minimum_level", "confirmation"]), limits.signalMap);

  const cleanControl = { ...control, source_revision: nextRevision, projection_revision: nextRevision, update_state: "clean",
    pending_operation_id: "", pending_event_id: "", pending_signal_id: "", pending_trigger_id: "", pending_source_ref: "",
    base_revision: nextRevision, updated_at: transactionAt };
  const controlOrder = ["schema_version", "record_type", "instance_id", "source_revision", "projection_revision", "update_state",
    "pending_operation_id", "pending_event_id", "pending_signal_id", "pending_trigger_id", "pending_source_ref", "base_revision", "updated_at"];
  const cleanControlArtifact = artifact(CONTROL_REF, `${serializeRoot(cleanControl, controlOrder)}\n`, limits.control);
  let publicSnapshotRead = null;
  let distSnapshotRead = null;
  let publicSnapshotArtifact = null;
  let distSnapshotArtifact = null;
  let projectionRoot;
  try {
    publicSnapshotRead = stableRead(repositoryReal, PUBLIC_SNAPSHOT_REF, limits.snapshot);
    distSnapshotRead = stableRead(repositoryReal, DIST_SNAPSHOT_REF, limits.snapshot);
    if (publicSnapshotRead.digest !== distSnapshotRead.digest) throw new Error("dashboard snapshot pair is already drifted");
    cleanupStaleLearningCaptureProjections(repositoryReal);
    projectionRoot = createOwnedProjectionRoot(repositoryReal, "candidate-snapshot");
    const budget = { directories: 0, files: 0 };
    for (const ref of ["assistant.toml", "AGENTS.md", "BOOTSTRAP.md", "core", "instance"])
      mirrorPhysicalTree(resolve(repositoryReal, ...ref.split("/")), resolve(projectionRoot, ...ref.split("/")), budget);
    mirrorPhysicalTree(resolve(repositoryReal, ...PUBLIC_SNAPSHOT_REF.split("/")), resolve(projectionRoot, ...PUBLIC_SNAPSHOT_REF.split("/")), budget);
    mirrorPhysicalTree(resolve(repositoryReal, ...DIST_SNAPSHOT_REF.split("/")), resolve(projectionRoot, ...DIST_SNAPSHOT_REF.split("/")), budget);
    for (const item of [cleanControlArtifact, candidateArtifact, indexArtifact, signalArtifact, timeArtifact, signalMapArtifact,
      ...(reviewPayloadArtifact ? [reviewPayloadArtifact] : [])]) {
      replaceProjectionFile(projectionRoot, item.target, Buffer.from(item.contentBase64, "base64").toString("utf8"));
    }
    const currentTargets = [cleanControlArtifact, candidateArtifact, indexArtifact, signalArtifact, timeArtifact, signalMapArtifact,
      ...(reviewPayloadArtifact ? [reviewPayloadArtifact] : [])].map((item) => item.target);
    const snapshot = buildSnapshotCandidate(projectionRoot, { existingSource: publicSnapshotRead.text, now: new Date(transactionAt),
      mode: "operational", requiredSourceRefs: currentTargets });
    if (!snapshot.updated || typeof snapshot.source !== "string" || Buffer.byteLength(snapshot.source, "utf8") > limits.snapshot) {
      throw new Error("candidate transaction did not produce one bounded changed dashboard snapshot");
    }
    publicSnapshotArtifact = artifact(PUBLIC_SNAPSHOT_REF, snapshot.source, limits.snapshot);
    distSnapshotArtifact = artifact(DIST_SNAPSHOT_REF, snapshot.source, limits.snapshot);
  } catch {
    projectionIssues.push("dashboard-snapshot-refresh-pending");
  } finally {
    if (projectionRoot && existsSync(projectionRoot)) {
      try { removeOwnedProjectionRoot(repositoryReal, projectionRoot, "candidate-snapshot"); }
      catch { projectionIssues.push("dashboard-projection-cleanup-pending"); }
    }
  }
  return { manifestRead, controlRead, indexRead, signalMapRead, timeMapRead, candidateRead, signalRead, reviewPayloadRead,
    publicSnapshotRead, distSnapshotRead, candidateArtifact, indexArtifact, signalArtifact, timeArtifact, signalMapArtifact,
    cleanControlArtifact, publicSnapshotArtifact, distSnapshotArtifact, reviewPayloadArtifact, projectionIssues };
}

function sealPlan(core) {
  return deepFreeze({ ...core, planDigest: sha256(canonical(core)) });
}

function buildNoWritePlan(trust) {
  const core = {
    schemaVersion: 1, planType: "learning-capture-transaction", decision: "learning-capture-no-write-closed",
    choice: trust.receipt.choice, executable: false,
    authorization: "current-user-discard-choice", completeness: "zero-persistent-writes",
    contentIncluded: false, instanceId: trust.instanceId,
    proposalDigest: trust.checked.proposalDigest, transactionAt: trust.transactionAt,
    confirmationMessageRef: trust.receipt.message_ref, confirmationMessageDigest: trust.receipt.message_digest,
    confirmationAt: trust.receipt.confirmed_at,
    sourceTrust: "host-asserted-current-user-message-not-independently-verified",
    preimages: [], steps: [], finalDigests: [], rollback: [], writeSet: [], readSet: [MANIFEST_REF],
    hostExecutionRequired: false, formalPromotionRequest: null,
    userGuidance: "本次发现没有保存，也没有创建候选或提醒。",
    requiredChecks: [],
  };
  return sealPlan(core);
}

function buildDirectKeepPlan(repositoryReal, trust) {
  const direct = trust.directKeep;
  const manifestRead = stableRead(repositoryReal, MANIFEST_REF, limits.manifest);
  const current = loadTrustedDomainEnvelope(repositoryReal, { explicitRequestedId: trust.checked.formal.id });
  const currentFormalDigest = trustedMaintenanceStateDigest(repositoryReal, current.envelope);
  const currentDuplicates = formalDuplicateProbe(repositoryReal, current.envelope, trust.checked);
  if (manifestRead.digest !== trust.manifestDigest || current.context.instanceId !== trust.instanceId
    || currentFormalDigest !== trust.formalStateDigest || registeredFormalId(current.envelope, trust.checked.formal.id)
    || currentDuplicates.decision !== "duplicate-check-complete" || currentDuplicates.matches.length > 0
    || !verifyNewFormalTarget(repositoryReal, direct.targetProof)) {
    throw new Error("direct keep inputs changed after the user reviewed the exact preview");
  }
  const domainMapRead = stableRead(repositoryReal, direct.domainMapRef, limits.domainMap);
  const formalRead = stableRead(repositoryReal, direct.formalTarget, limits.formalPreview, { allowMissing: true });
  if (formalRead || domainMapRead.digest !== direct.domainMapRead.digest) {
    throw new Error("direct keep write-set preimages changed after review");
  }
  const formalArtifact = artifact(direct.formalTarget, direct.normalizedPreview, limits.formalPreview);
  const domainArtifact = artifact(direct.domainMapRef, direct.domainMapText, limits.domainMap);
  const preimages = [preimage(formalRead, direct.formalTarget), preimage(domainMapRead, direct.domainMapRef)];
  const phaseArtifacts = [["formal-asset", formalArtifact], ["instance-domain-map", domainArtifact]];
  const currentDigest = new Map(preimages.map((item) => [item.target, item.digest]));
  const steps = phaseArtifacts.map(([phase, item], index) => {
    const step = Object.freeze({ ordinal: index + 1, phase, target: item.target,
      preconditionDigest: currentDigest.get(item.target), proposedDigest: item.digest,
      proposedByteLength: item.byteLength, encoding: item.encoding, contentBase64: item.contentBase64 });
    currentDigest.set(item.target, item.digest); return step;
  });
  const writeSet = [formalArtifact, domainArtifact]
    .sort((left, right) => left.target.localeCompare(right.target, "en"));
  const finalDigests = writeSet.map((item) => ({ target: item.target, digest: item.digest }));
  const rollback = [...preimages].reverse().map((item) => ({ target: item.target, restoreDigest: item.digest,
    encoding: item.encoding, contentBase64: item.contentBase64 }));
  return sealPlan({
    schemaVersion: 1, planType: "learning-capture-transaction", decision: "learning-capture-direct-formal-host-transaction-preview",
    choice: "keep", executable: false, authorization: "current-user-exact-formal-preview-receipt",
    completeness: "exact-bytes-bound-host-executed-plan-not-a-filesystem-executor", contentIncluded: true,
    instanceId: trust.instanceId, proposalDigest: trust.checked.proposalDigest, semanticDigest: trust.checked.semanticDigest,
    operationId: trust.ids.operationId, formalId: direct.asset.id, formalKind: direct.asset.kind,
    formalTarget: direct.formalTarget, formalPreviewDigest: trust.checked.formalDigest,
    retainedFutureActionGate: direct.retainedFutureActionGate, initialMaturity: direct.initialMaturity,
    transactionAt: trust.transactionAt, confirmationMessageRef: trust.receipt.message_ref,
    confirmationMessageDigest: trust.receipt.message_digest, confirmationAt: trust.receipt.confirmed_at,
    sourceTrust: "host-asserted-current-user-message-not-independently-verified",
    observationReceipt: Object.freeze({ basis: "same-process-host-natural-stop-observation",
      sourceTrust: "host-asserted-not-independently-verified", observedAt: trust.ids.observedAt,
      observationRef: trust.ids.observationRef, eventId: trust.ids.eventId, taskId: trust.ids.taskId, contextId: trust.ids.contextId,
      sourceKind: trust.ids.sourceKind, resultState: trust.ids.resultState }),
    initialEvidence: Object.freeze({ hostObservationCount: 1, formalSuccessfulUseCount: 0,
      formalMaturityPreclaimed: false, independentValidationClaimed: false }),
    preimages, steps, finalDigests, rollback, writeSet,
    readSet: [MANIFEST_REF, direct.domainMapRef, direct.formalTarget],
    hostExecutionRequired: true, formalPromotionRequest: null,
    userGuidance: `这份精确内容已准备按一次确认正式保存。核心事务只写正式资产和直接召回路由，不执行任何未来动作；看板在保存后单独刷新。${direct.capacityNotice}`,
    requiredChecks: ["stage-all-exact-proposed-bytes", "reverify-all-preimage-digests", "commit-in-step-order",
      "read-back-all-final-digests", "rollback-core-write-set-on-any-failure", "verify-ordinary-language-recall-after-commit"],
  });
}

export function buildLearningCaptureTransactionPlan(repository, selection) {
  const trust = trustedSelections.get(selection);
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return deepFreeze({ decision: "learning-capture-plan-denied", reason: "repository-unavailable", executable: false }); }
  if (!trust || trust.repositoryReal !== repositoryReal || consumedSelections.has(selection)) {
    return deepFreeze({ decision: "learning-capture-plan-denied", reason: "trusted-current-choice-required", executable: false });
  }
  if (trust.receipt.choice === "discard") {
    consumedSelections.add(selection);
    const plan = buildNoWritePlan(trust); trustedPlans.set(plan, Object.freeze({ repositoryReal, noWrite: true }));
    return plan;
  }
  if (trust.receipt.choice === "keep") {
    if (trust.directKeep.eligible) try {
      consumedSelections.add(selection);
      const plan = buildDirectKeepPlan(repositoryReal, trust);
      trustedPlans.set(plan, Object.freeze({ repositoryReal, noWrite: false }));
      return plan;
    } catch (error) {
      return deepFreeze({ decision: "learning-capture-plan-denied", reason: error.message, executable: false });
    }
  }
  const operationalGate = operationalDerivedStateGate(repositoryReal, "learning-capture-plan");
  if (!operationalGate.proceed) return operationalGate.result;
  consumedSelections.add(selection);
  const earlierReport = getOperationalDerivedStateReport(selection);
  const reportSource = operationalGate.repair.userReport ? operationalGate.repair
    : earlierReport ? { userReport: earlierReport } : null;
  try {
    const state = buildState(repositoryReal, trust);
    const coreArtifacts = [
      ["candidate-source", state.candidateArtifact, state.candidateRead],
      ...(state.reviewPayloadArtifact ? [["review-payload", state.reviewPayloadArtifact, state.reviewPayloadRead]] : []),
    ];
    const preimages = coreArtifacts.map(([, item, read]) => preimage(read, item.target));
    const currentDigest = new Map(preimages.map((item) => [item.target, item.digest]));
    const steps = coreArtifacts.map(([phase, item], index) => {
      const step = Object.freeze({ ordinal: index + 1, phase, target: item.target,
        preconditionDigest: currentDigest.get(item.target), proposedDigest: item.digest,
        proposedByteLength: item.byteLength, encoding: item.encoding, contentBase64: item.contentBase64 });
      currentDigest.set(item.target, item.digest); return step;
    });
    const writeSet = coreArtifacts.map(([, item]) => item)
      .sort((left, right) => left.target.localeCompare(right.target, "en"));
    const finalDigests = writeSet.map((item) => ({ target: item.target, digest: item.digest }));
    const rollback = [...preimages].reverse().map((item) => ({ target: item.target, restoreDigest: item.digest,
      encoding: item.encoding, contentBase64: item.contentBase64 }));
    const projectionArtifacts = [
      ...(state.indexArtifact ? [
        ["candidate-index", state.indexArtifact, state.indexRead],
        ["learning-signal-source", state.signalArtifact, state.signalRead],
        ["time-projection", state.timeArtifact, state.timeMapRead],
        ["startup-signal-projection", state.signalMapArtifact, state.signalMapRead],
        ["control-clean", state.cleanControlArtifact, state.controlRead],
      ] : []),
      ...(state.publicSnapshotArtifact && state.distSnapshotArtifact
        ? [["dashboard-public-snapshot", state.publicSnapshotArtifact, state.publicSnapshotRead],
          ["dashboard-dist-snapshot", state.distSnapshotArtifact, state.distSnapshotRead]] : []),
    ];
    const projections = projectionArtifacts.map(([phase, item, read], index) => Object.freeze({
      ordinal: index + 1, phase, target: item.target, preconditionDigest: preimage(read, item.target).digest,
      proposedDigest: item.digest, proposedByteLength: item.byteLength,
      encoding: item.encoding, contentBase64: item.contentBase64,
    }));
    const formalTarget = formalTargetFor(trust.checked.formal, trust.checked.formalDigest);
    const formalPromotionRequest = trust.receipt.choice === "keep" ? Object.freeze({
      decision: "awaiting-review-with-existing-content-authorization", executable: false,
      candidateId: trust.ids.candidateId, candidateSourceRevision: 1,
      reviewPayloadId: trust.ids.reviewPayloadId, reviewPayloadRef: trust.ids.reviewPayloadRef,
      reviewPayloadDigest: state.reviewPayloadArtifact.digest,
      formalId: trust.checked.formal.id, formalKind: trust.checked.formal.kind, formalSubtype: trust.checked.formal.subtype,
      formalTarget, formalPreviewDigest: trust.checked.formalDigest,
      requiredNextBoundary: "targeted review checks architecture and risk; unchanged exact preview reuses the existing keep authorization",
      existingKeepAuthorizationReusableIfExactDigestUnchanged: true,
      materialChangeRequiresNewConfirmation: true, silentFormalWriteForbidden: true,
      candidateStagingRequired: false, userMustChooseInternalAssetKind: false,
    }) : null;
    const guidance = trust.receipt.choice === "keep"
      ? "你选择留下的精确内容已保存为不可执行的定向复核交接。只检查架构和风险；内容与范围没变时不会重复问你，只有发生实质变化才会展示差异并重新确认。"
      : trust.receipt.choice === "remind"
        ? `我会在 ${trust.receipt.remind_at} 提醒你复核这项做法。随时告诉 Agent“取消刚才那条学习提醒”并描述大概内容即可，不需要记住 ID 或路径。`
        : "我会先观察这项做法，只在后续新的真实任务里再次出现时再累计证据；它现在不会被当成正式规则自动使用。随时可以用日常语言让我停止观察。";
    const core = {
      schemaVersion: 1, planType: "learning-capture-transaction", decision: "learning-capture-host-transaction-preview",
      choice: trust.receipt.choice, executable: false, authorization: "same-process-current-user-choice-receipt",
      completeness: "exact-bytes-bound-host-executed-plan-not-a-filesystem-executor", contentIncluded: true,
      instanceId: trust.instanceId, proposalDigest: trust.checked.proposalDigest, semanticDigest: trust.checked.semanticDigest,
      operationId: trust.ids.operationId, candidateId: trust.ids.candidateId, candidateSourceRef: trust.ids.candidateSourceRef,
      signalId: trust.ids.signalId, signalSourceRef: trust.ids.signalSourceRef, eventId: trust.ids.eventId,
      taskId: trust.ids.taskId, contextId: trust.ids.contextId, transactionAt: trust.transactionAt,
      confirmationMessageRef: trust.receipt.message_ref, confirmationMessageDigest: trust.receipt.message_digest,
      confirmationAt: trust.receipt.confirmed_at,
      sourceTrust: "host-asserted-current-user-message-not-independently-verified",
      observationReceipt: Object.freeze({ basis: "same-process-host-natural-stop-observation",
        sourceTrust: "host-asserted-not-independently-verified", observedAt: trust.ids.observedAt,
        observationRef: trust.ids.observationRef, eventId: trust.ids.eventId, taskId: trust.ids.taskId, contextId: trust.ids.contextId,
        sourceKind: trust.ids.sourceKind, resultState: trust.ids.resultState }),
      initialEvidence: Object.freeze({ independentEventCount: 1, distinctContextCount: 1, successfulEventCount: 0,
        contextId: trust.ids.contextId, independentValidationClaimed: false }),
      preimages, steps, finalDigests, rollback, writeSet, projections,
      projectionIssues: Object.freeze([...state.projectionIssues]),
      readSet: [MANIFEST_REF, trust.ids.candidateSourceRef,
        ...(state.reviewPayloadArtifact ? [trust.ids.reviewPayloadRef] : []),
        ...(state.indexArtifact ? [CONTROL_REF, CANDIDATE_INDEX_REF, SIGNAL_MAP_REF, TIME_MAP_REF,
          trust.ids.signalSourceRef] : []),
        ...(state.publicSnapshotArtifact ? [PUBLIC_SNAPSHOT_REF, DIST_SNAPSHOT_REF] : [])],
      hostExecutionRequired: true, formalPromotionRequest, userGuidance: guidance,
      requiredChecks: ["commit-and-read-back-candidate-source", "rollback-only-core-source-on-core-failure",
        "refresh-derived-projections-best-effort", "report-projection-failure-without-rolling-back-source"],
    };
    const plan = sealPlan(core);
    trustedPlans.set(plan, Object.freeze({ repositoryReal, noWrite: false }));
    return bindOperationalDerivedStateReport(plan, reportSource);
  } catch (error) {
    return deepFreeze({ decision: "learning-capture-plan-denied", reason: error.message, executable: false });
  }
}

export function buildLearningReminderCancellationPlan(repository, confirmation) {
  const trust = trustedCancellations.get(confirmation);
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch {
    return deepFreeze({ decision: "learning-reminder-cancellation-plan-denied", reason: "repository-unavailable", executable: false });
  }
  if (!trust || trust.repositoryReal !== repositoryReal || consumedCancellations.has(confirmation)) {
    return deepFreeze({ decision: "learning-reminder-cancellation-plan-denied", reason: "trusted-current-cancellation-required", executable: false });
  }
  consumedCancellations.add(confirmation);
  try {
    const state = loadReminderState(repositoryReal, trust.candidateId);
    if (state.stateDigest !== trust.stateDigest || state.entry.source_ref !== trust.candidateSourceRef
      || state.trigger.id !== trust.signalId || state.signalSourceRef !== trust.signalSourceRef) {
      throw new Error("the bound reminder state changed before cancellation planning");
    }

    const nextRevision = state.control.source_revision + 1;
    const candidate = {
      ...state.candidateParsed.values,
      remind_at: "",
      snoozed_until: "",
      trigger_revision: state.candidateParsed.values.trigger_revision + 1,
      source_revision: state.candidateParsed.values.source_revision + 1,
      updated_at: trust.transactionAt,
    };
    const candidateBodyText = state.candidateRead.text.slice(state.candidateParsed.bodyCharOffset);
    const candidateArtifact = artifact(trust.candidateSourceRef,
      serializeCandidateSource(candidate, candidateBodyText), limits.candidateSource);

    const indexEntries = state.index.entries.map((item) => item.id === trust.candidateId
      ? { ...item, source_revision: candidate.source_revision }
      : item);
    const indexRoot = { ...state.index.root, state: "current",
      source_revision: state.index.root.source_revision + 1, generated_at: trust.transactionAt };
    const indexArtifact = artifact(CANDIDATE_INDEX_REF, serializeArrayTable(indexRoot,
      ["schema_version", "index_id", "instance_id", "state", "source_revision", "generated_at", "budget_bytes", "overflow", "candidate_count", "indexed_count", "active_count"],
      "candidates", indexEntries,
      ["id", "title", "summary", "topic_key", "subject_key", "triggers", "aliases", "scope", "conditions", "excludes", "target_kind", "target_subtype", "candidate_relation", "status", "observation_state", "observation_basis", "risk_tier", "independent_event_count", "last_evidence_at", "source_ref", "source_revision"]), limits.candidateIndex);

    const signalRoot = { ...state.signal.root, revision: state.signal.root.revision + 1,
      updated_at: trust.transactionAt, candidate_source_revision: candidate.source_revision };
    const signalTrigger = { ...state.signal.trigger, next_check_at: "" };
    const signalArtifact = artifact(trust.signalSourceRef,
      serializeSignalSource(signalRoot, state.signal.match, signalTrigger, state.signal.evidence), limits.signalSource);

    const timeEntries = state.timeMap.entries.filter((item) => item.id !== trust.signalId);
    if (timeEntries.length !== state.timeMap.entries.length - 1) throw new Error("the bound reminder projection was not removed exactly once");
    const nextWakeup = deterministicEarliest(timeEntries);
    const timeRoot = { ...state.timeMap.root, state: timeEntries.length === 0 ? "empty" : "current",
      source_revision: nextRevision, generated_at: trust.transactionAt,
      scheduled_count: timeEntries.length, next_wakeup_at: nextWakeup };
    const timeArtifact = artifact(TIME_MAP_REF, serializeArrayTable(timeRoot,
      ["schema_version", "map_id", "instance_id", "state", "source_revision", "generated_at", "scheduled_count", "next_wakeup_at"],
      "triggers", timeEntries,
      ["id", "kind", "status", "title", "next_check_at", "effective_check_at", "domain", "route_id", "source_ref", "source_trigger_revision", "minimum_level", "confirmation"]), limits.timeMap);

    const signalEntries = [...state.signalMap.entries];
    const signalMapRoot = { ...state.signalMap.root,
      state: signalEntries.length === 0 && timeEntries.length === 0 ? "empty" : "current",
      source_revision: nextRevision, generated_at: trust.transactionAt,
      active_count: signalEntries.length, scheduled_count: timeEntries.length, next_wakeup_at: nextWakeup };
    const signalMapArtifact = artifact(SIGNAL_MAP_REF, serializeArrayTable(signalMapRoot,
      ["schema_version", "map_id", "instance_id", "state", "source_revision", "generated_at", "budget_bytes", "overflow", "active_count", "scheduled_count", "next_wakeup_at", "next_wakeup_ref"],
      "signals", signalEntries,
      ["id", "signal_type", "status", "reason", "progress", "next_event", "domain", "route_id", "source_ref", "source_signal_revision", "provenance", "trust_state", "minimum_level", "confirmation"]), limits.signalMap);

    const cleanControl = { ...state.control, source_revision: nextRevision, projection_revision: nextRevision, update_state: "clean",
      pending_operation_id: "", pending_event_id: "", pending_signal_id: "", pending_trigger_id: "", pending_source_ref: "",
      base_revision: nextRevision, updated_at: trust.transactionAt };
    const controlOrder = ["schema_version", "record_type", "instance_id", "source_revision", "projection_revision", "update_state",
      "pending_operation_id", "pending_event_id", "pending_signal_id", "pending_trigger_id", "pending_source_ref", "base_revision", "updated_at"];
    const cleanControlArtifact = artifact(CONTROL_REF, `${serializeRoot(cleanControl, controlOrder)}\n`, limits.control);

    const preimages = [preimage(state.candidateRead, trust.candidateSourceRef)];
    const phaseArtifacts = [["candidate-source", candidateArtifact]];
    const currentDigest = new Map(preimages.map((item) => [item.target, item.digest]));
    const steps = phaseArtifacts.map(([phase, item], index) => {
      const step = Object.freeze({ ordinal: index + 1, phase, target: item.target,
        preconditionDigest: currentDigest.get(item.target), proposedDigest: item.digest,
        proposedByteLength: item.byteLength, encoding: item.encoding, contentBase64: item.contentBase64 });
      currentDigest.set(item.target, item.digest); return step;
    });
    const writeSet = [candidateArtifact];
    const finalDigests = writeSet.map((item) => ({ target: item.target, digest: item.digest }));
    const rollback = [...preimages].reverse().map((item) => ({ target: item.target, restoreDigest: item.digest,
      encoding: item.encoding, contentBase64: item.contentBase64 }));
    const projectionArtifacts = [
      ["candidate-index", indexArtifact, state.indexRead],
      ["learning-signal-source", signalArtifact, state.signalRead],
      ["time-projection", timeArtifact, state.timeMapRead],
      ["startup-signal-projection", signalMapArtifact, state.signalMapRead],
      ["control-clean", cleanControlArtifact, state.controlRead],
    ];
    const projections = projectionArtifacts.map(([phase, item, read], index) => Object.freeze({
      ordinal: index + 1, phase, target: item.target, preconditionDigest: preimage(read, item.target).digest,
      proposedDigest: item.digest, proposedByteLength: item.byteLength,
      encoding: item.encoding, contentBase64: item.contentBase64,
    }));
    const core = {
      schemaVersion: 1, planType: "learning-capture-transaction", decision: "learning-reminder-cancellation-host-transaction-preview",
      choice: "cancel-reminder", executable: false, authorization: "same-process-current-user-cancellation-receipt",
      completeness: "exact-bytes-bound-host-executed-plan-not-a-filesystem-executor", contentIncluded: true,
      instanceId: trust.instanceId, proposalDigest: trust.stateDigest, semanticDigest: trust.stateDigest,
      operationId: trust.operationId, candidateId: trust.candidateId, candidateSourceRef: trust.candidateSourceRef,
      signalId: trust.signalId, signalSourceRef: trust.signalSourceRef, eventId: trust.eventId,
      taskId: trust.taskId, contextId: trust.contextId, transactionAt: trust.transactionAt,
      confirmationMessageRef: trust.receipt.message_ref, confirmationMessageDigest: trust.receipt.message_digest,
      confirmationAt: trust.receipt.confirmed_at,
      sourceTrust: "host-asserted-current-user-message-not-independently-verified",
      observationReceipt: null, initialEvidence: null,
      cancellationTarget: Object.freeze({ candidateId: trust.candidateId, signalId: trust.signalId,
        previousReminderAt: state.candidateParsed.values.remind_at,
        candidateRemainsObserved: true, reminderProjectionRemoved: true }),
      preimages, steps, finalDigests, rollback, writeSet, projections, projectionIssues: Object.freeze([]),
      readSet: [MANIFEST_REF, CONTROL_REF, CANDIDATE_INDEX_REF, SIGNAL_MAP_REF, TIME_MAP_REF,
        trust.candidateSourceRef, trust.signalSourceRef],
      hostExecutionRequired: true, formalPromotionRequest: null,
      userGuidance: "这条定时提醒已准备取消；观察候选会保留，后续仍可在相关真实任务中继续积累，但不会再按原时间提醒。",
      requiredChecks: ["commit-and-read-back-candidate-source", "rollback-only-core-source-on-core-failure",
        "refresh-reminder-projections-best-effort", "report-projection-failure-without-restoring-reminder"],
    };
    const plan = sealPlan(core);
    trustedPlans.set(plan, Object.freeze({ repositoryReal, noWrite: false }));
    return plan;
  } catch (error) {
    return deepFreeze({ decision: "learning-reminder-cancellation-plan-denied", reason: error.message, executable: false });
  }
}

function exactBytePlanShape(plan, expectedPhases, expectedTargetCount) {
  if (!Array.isArray(plan.preimages) || plan.preimages.length !== expectedTargetCount
    || !Array.isArray(plan.steps) || plan.steps.length !== expectedPhases.length
    || !Array.isArray(plan.finalDigests) || plan.finalDigests.length !== expectedTargetCount
    || !Array.isArray(plan.rollback) || plan.rollback.length !== expectedTargetCount
    || !Array.isArray(plan.writeSet) || plan.writeSet.length !== expectedTargetCount) return false;
  const preimageTargets = new Set(); const preimageMap = new Map();
  for (const item of plan.preimages) {
    if (!clean(item.target, 240, false) || preimageTargets.has(item.target) || !(digestPattern.test(item.digest) || item.digest === "absent")
      || !safeInteger(item.byteLength) || !["base64", "absent"].includes(item.encoding)
      || typeof item.contentBase64 !== "string") return false;
    if (item.encoding === "absent" && (item.digest !== "absent" || item.byteLength !== 0 || item.contentBase64 !== "")) return false;
    if (item.encoding === "base64") {
      const bytes = Buffer.from(item.contentBase64, "base64");
      if (bytes.length !== item.byteLength || sha256(bytes) !== item.digest) return false;
    }
    preimageTargets.add(item.target); preimageMap.set(item.target, item);
  }
  const state = new Map(plan.preimages.map((item) => [item.target, item.digest]));
  for (const [index, step] of plan.steps.entries()) {
    if (step.ordinal !== index + 1 || step.phase !== expectedPhases[index] || state.get(step.target) !== step.preconditionDigest
      || !digestPattern.test(step.proposedDigest ?? "") || step.encoding !== "base64"
      || typeof step.contentBase64 !== "string") return false;
    const buffer = Buffer.from(step.contentBase64, "base64");
    if (buffer.length !== step.proposedByteLength || sha256(buffer) !== step.proposedDigest) return false;
    state.set(step.target, step.proposedDigest);
  }
  const finals = new Map(plan.finalDigests.map((item) => [item.target, item.digest]));
  if (finals.size !== state.size || [...state].some(([target, digest]) => finals.get(target) !== digest)) return false;
  const writes = new Map(plan.writeSet.map((item) => [item.target, item]));
  if (writes.size !== finals.size) return false;
  for (const [target, digest] of finals) {
    const item = writes.get(target); if (!item || item.digest !== digest || item.encoding !== "base64") return false;
    const buffer = Buffer.from(item.contentBase64, "base64");
    if (buffer.length !== item.byteLength || sha256(buffer) !== digest) return false;
  }
  const rollback = new Map(plan.rollback.map((item) => [item.target, item]));
  if (rollback.size !== preimageMap.size) return false;
  for (const [target, source] of preimageMap) {
    const item = rollback.get(target);
    if (!item || item.restoreDigest !== source.digest || item.encoding !== source.encoding
      || item.contentBase64 !== source.contentBase64) return false;
  }
  return true;
}

function projectionPlanShape(plan, expectedPhases) {
  if (!Array.isArray(plan.projections) || plan.projections.length !== expectedPhases.length
    || !Array.isArray(plan.projectionIssues) || plan.projectionIssues.some((item) => typeof item !== "string")) return false;
  const targets = new Set();
  for (const [index, item] of plan.projections.entries()) {
    if (item.ordinal !== index + 1 || item.phase !== expectedPhases[index]
      || !clean(item.target, 240, false) || targets.has(item.target)
      || !(digestPattern.test(item.preconditionDigest ?? "") || item.preconditionDigest === "absent")
      || !digestPattern.test(item.proposedDigest ?? "") || item.encoding !== "base64"
      || typeof item.contentBase64 !== "string") return false;
    const buffer = Buffer.from(item.contentBase64, "base64");
    if (buffer.length !== item.proposedByteLength || sha256(buffer) !== item.proposedDigest) return false;
    targets.add(item.target);
  }
  return true;
}

function structuralPlanValid(plan) {
  if (!plan || typeof plan !== "object" || plan.schemaVersion !== 1 || plan.planType !== "learning-capture-transaction"
    || plan.executable !== false || !digestPattern.test(plan.planDigest ?? "")) return false;
  const { planDigest, ...core } = plan;
  if (sha256(canonical(core)) !== planDigest || !transactionChoices.has(plan.choice) || !strictDate(plan.transactionAt)
    || (Object.hasOwn(plan, "expiresAt") && plan.expiresAt !== "" && !strictDate(plan.expiresAt))
    || !digestPattern.test(plan.proposalDigest ?? "")
    || !stableAssetId.test(plan.confirmationMessageRef ?? "") || !digestPattern.test(plan.confirmationMessageDigest ?? "")
    || !strictDate(plan.confirmationAt)) return false;
  if (plan.choice === "discard") return plan.decision === "learning-capture-no-write-closed"
    && plan.completeness === "zero-persistent-writes" && plan.contentIncluded === false
    && [plan.preimages, plan.steps, plan.finalDigests, plan.rollback, plan.writeSet]
      .every((items) => Array.isArray(items) && items.length === 0)
    && plan.formalPromotionRequest === null;
  if (["learning-capture-review-required", "learning-capture-level3-review-required"].includes(plan.decision)) return plan.choice === "keep"
    && ["zero-persistent-writes-targeted-review", "zero-persistent-writes-targeted-level3-review"].includes(plan.completeness)
    && [plan.preimages, plan.steps, plan.finalDigests, plan.rollback, plan.writeSet]
      .every((items) => Array.isArray(items) && items.length === 0)
    && plan.hostExecutionRequired === false && plan.formalPromotionRequest?.candidateCreated === false
    && plan.formalPromotionRequest?.formalCreated === false
    && digestPattern.test(plan.formalPromotionRequest?.formalPreviewDigest ?? "")
    && /review|复核/iu.test(plan.formalPromotionRequest?.requiredNextBoundary ?? "");
  if (plan.decision === "learning-capture-direct-formal-host-transaction-preview") {
    const expectedPrefix = { memory: "instance/memory/", capability: "instance/capabilities/",
      sop: "instance/sops/", experience: "instance/experiences/" }[plan.formalKind];
    return plan.choice === "keep" && plan.completeness === "exact-bytes-bound-host-executed-plan-not-a-filesystem-executor"
      && plan.hostExecutionRequired === true && plan.formalPromotionRequest === null
      && stableAssetId.test(plan.operationId ?? "") && stableAssetId.test(plan.formalId ?? "")
      && typeof expectedPrefix === "string" && portableRef(plan.formalTarget, { prefix: expectedPrefix, extension: ".md" })
      && digestPattern.test(plan.formalPreviewDigest ?? "") && clean(plan.retainedFutureActionGate, 80, false)
      && ["unvalidated", "not-applicable"].includes(plan.initialMaturity)
      && plan.initialEvidence?.hostObservationCount === 1 && plan.initialEvidence?.formalSuccessfulUseCount === 0
      && plan.initialEvidence?.formalMaturityPreclaimed === false && plan.initialEvidence?.independentValidationClaimed === false
      && plan.observationReceipt?.basis === "same-process-host-natural-stop-observation"
      && ((plan.observationReceipt?.sourceKind === "connected-host-observation"
        && plan.observationReceipt?.resultState === "closed-result-checked")
        || (plan.observationReceipt?.sourceKind === "unknown"
          && plan.observationReceipt?.resultState === "closed-unverified"))
      && exactBytePlanShape(plan, ["formal-asset", "instance-domain-map"], 2);
  }
  if (!["learning-capture-host-transaction-preview", "learning-reminder-cancellation-host-transaction-preview"].includes(plan.decision)
    || plan.executable !== false
    || plan.completeness !== "exact-bytes-bound-host-executed-plan-not-a-filesystem-executor"
    || plan.contentIncluded !== true || plan.hostExecutionRequired !== true
    || !stableAssetId.test(plan.operationId ?? "") || !stableAssetId.test(plan.candidateId ?? "")
    || !portableRef(plan.candidateSourceRef, { prefix: "instance/evolution/", extension: ".md" })
    || !stableAssetId.test(plan.signalId ?? "") || !portableRef(plan.signalSourceRef, { prefix: "instance/signals/", extension: ".toml" })
    ) return false;
  if (plan.choice === "cancel-reminder") return exactBytePlanShape(plan, ["candidate-source"], 1)
    && projectionPlanShape(plan,
      ["candidate-index", "learning-signal-source", "time-projection", "startup-signal-projection", "control-clean"])
    && plan.projectionIssues.length === 0
    && plan.decision === "learning-reminder-cancellation-host-transaction-preview"
    && plan.initialEvidence === null && plan.observationReceipt === null && plan.formalPromotionRequest === null
    && plan.cancellationTarget?.candidateId === plan.candidateId
    && plan.cancellationTarget?.signalId === plan.signalId
    && strictDate(plan.cancellationTarget?.previousReminderAt ?? "")
    && plan.cancellationTarget?.candidateRemainsObserved === true
    && plan.cancellationTarget?.reminderProjectionRemoved === true;
  const corePhases = plan.choice === "keep" ? ["candidate-source", "review-payload"] : ["candidate-source"];
  if (!exactBytePlanShape(plan, corePhases, corePhases.length)) return false;
  const baseProjectionPhases = ["candidate-index", "learning-signal-source", "time-projection", "startup-signal-projection", "control-clean"];
  const fullProjectionPhases = [...baseProjectionPhases, "dashboard-public-snapshot", "dashboard-dist-snapshot"];
  const projectionIssueSet = new Set(plan.projectionIssues);
  if (projectionIssueSet.size !== plan.projectionIssues.length
    || [...projectionIssueSet].some((item) => !["learning-derived-state-refresh-pending",
      "dashboard-snapshot-refresh-pending", "dashboard-projection-cleanup-pending"].includes(item))) return false;
  const derivedStatePending = projectionIssueSet.has("learning-derived-state-refresh-pending");
  const snapshotPending = projectionIssueSet.has("dashboard-snapshot-refresh-pending");
  const projectionShapeValid = derivedStatePending
    ? projectionIssueSet.size === 1 && projectionPlanShape(plan, [])
    : projectionPlanShape(plan, snapshotPending ? baseProjectionPhases : fullProjectionPhases);
  if (!projectionShapeValid) return false;
  return plan.initialEvidence?.independentEventCount === 1 && plan.initialEvidence?.distinctContextCount === 1
    && plan.initialEvidence?.successfulEventCount === 0 && plan.initialEvidence?.independentValidationClaimed === false
    && plan.observationReceipt?.basis === "same-process-host-natural-stop-observation"
    && plan.observationReceipt?.sourceTrust === "host-asserted-not-independently-verified"
    && strictDate(plan.observationReceipt?.observedAt ?? "")
    && plan.observationReceipt?.eventId === plan.eventId && plan.observationReceipt?.taskId === plan.taskId
    && plan.observationReceipt?.contextId === plan.contextId
    && (plan.choice !== "keep" || (plan.formalPromotionRequest?.silentFormalWriteForbidden === true
      && plan.formalPromotionRequest?.candidateStagingRequired === false
      && plan.formalPromotionRequest?.existingKeepAuthorizationReusableIfExactDigestUnchanged === true
      && plan.formalPromotionRequest?.materialChangeRequiresNewConfirmation === true
      && digestPattern.test(plan.formalPromotionRequest?.formalPreviewDigest ?? "")
      && digestPattern.test(plan.formalPromotionRequest?.reviewPayloadDigest ?? "")
      && portableRef(plan.formalPromotionRequest?.reviewPayloadRef ?? "", { prefix: "instance/evolution/review-payloads/", extension: ".json" })
      && plan.formalPromotionRequest?.candidateId === plan.candidateId));
}

export function validateLearningCaptureTransactionPlan(plan) {
  return structuralPlanValid(plan);
}

export function validateLearningReminderCancellationPlan(plan) {
  return plan?.choice === "cancel-reminder" && structuralPlanValid(plan);
}

function digestAt(repositoryReal, preimage) {
  const limit = preimage.target === CONTROL_REF ? limits.control
    : preimage.target === CANDIDATE_INDEX_REF ? limits.candidateIndex
      : preimage.target === SIGNAL_MAP_REF ? limits.signalMap
        : preimage.target === TIME_MAP_REF ? limits.timeMap
          : preimage.target === DOMAIN_MAP_REF ? limits.domainMap
            : [PUBLIC_SNAPSHOT_REF, DIST_SNAPSHOT_REF].includes(preimage.target) ? limits.snapshot
              : preimage.target.startsWith("instance/evolution/review-payloads/") ? limits.reviewPayload
                : preimage.target.startsWith("instance/evolution/") ? limits.candidateSource
                : preimage.target.startsWith("instance/signals/") ? limits.signalSource : limits.formalPreview;
  return stableRead(repositoryReal, preimage.target, limit, { allowMissing: true })?.digest ?? "absent";
}

export function inspectLearningCaptureTransactionState(repository, plan) {
  const trust = trustedPlans.get(plan);
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return deepFreeze({ decision: "learning-capture-recovery-required", reason: "repository-unavailable", executable: false }); }
  if (!trust || trust.repositoryReal !== repositoryReal || !structuralPlanValid(plan)) {
    return deepFreeze({ decision: "learning-capture-recovery-required", reason: "untrusted-or-invalid-plan", executable: false });
  }
  return inspectStructurallyTrustedPlanState(repositoryReal, plan, trust.noWrite);
}

function inspectStructurallyTrustedPlanState(repositoryReal, plan, noWrite = plan.writeSet.length === 0) {
  if (!structuralPlanValid(plan)) return deepFreeze({ decision: "learning-capture-recovery-required",
    reason: "invalid-plan-structure", executable: false });
  if (noWrite) return deepFreeze({ decision: plan.decision, executable: false,
    durableEffect: "zero-persistent-writes", formalPromotionRequest: plan.formalPromotionRequest });
  try { recoverOwnedPlanAtomicArtifacts(repositoryReal, plan); }
  catch (error) {
    return deepFreeze({ decision: "learning-capture-recovery-required",
      reason: `owned-atomic-artifact-cannot-be-proved: ${error.message}`, executable: false });
  }
  const actual = new Map(plan.preimages.map((item) => [item.target, digestAt(repositoryReal, item)]));
  const preimageState = new Map(plan.preimages.map((item) => [item.target, item.digest]));
  const finalState = new Map(plan.finalDigests.map((item) => [item.target, item.digest]));
  const sameState = (expected) => expected.size === actual.size && [...expected].every(([target, digest]) => actual.get(target) === digest);
  if (sameState(finalState)) return deepFreeze({ decision: "learning-capture-already-committed", executable: false, idempotent: true, writeCount: 0 });
  if (sameState(preimageState)) return deepFreeze({ decision: "learning-capture-ready-for-host-execution", executable: false,
    requiredBoundary: "host-stages-validates-commits-readbacks-or-rolls-back" });
  const simulated = new Map(preimageState);
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index]; simulated.set(step.target, step.proposedDigest);
    if (index < plan.steps.length - 1 && sameState(simulated)) return deepFreeze({
      decision: "learning-capture-rollback-required", executable: false, checkpoint: index + 1,
      rollback: plan.rollback, verifyAfterRollback: plan.preimages.map(({ target, digest }) => ({ target, digest })),
    });
  }
  return deepFreeze({ decision: "learning-capture-recovery-required", reason: "non-prefix-or-external-drift", executable: false,
    expectedPreimages: plan.preimages.map(({ target, digest }) => ({ target, digest })),
    expectedFinals: plan.finalDigests });
}

export function inspectLearningReminderCancellationState(repository, plan) {
  return inspectLearningCaptureTransactionState(repository, plan);
}

function loadPersistentAction(repository, challengeId, challengeNonce) {
  const repositoryReal = realpathSync(repository); const recordTarget = persistentRecordPath(repositoryReal, challengeId);
  const record = readPersistentJson(recordTarget, 32 * 1024, "persistent challenge record");
  if (!validPersistentRecord(record, repositoryReal) || record.challenge_nonce !== challengeNonce) {
    throw new Error("persistent transaction action is not bound to the current challenge");
  }
  if (record.status === "completed") return { repositoryReal, recordTarget, record, plan: null,
    state: deepFreeze({ decision: "learning-capture-already-committed", executable: false, idempotent: true }) };
  if (record.status !== "planned") throw new Error("persistent transaction has not reached an authorized plan");
  const plan = readBoundPersistentPlan(repositoryReal, record);
  const state = inspectStructurallyTrustedPlanState(repositoryReal, plan);
  return { repositoryReal, recordTarget, record, plan, state };
}

export function inspectPersistentLearningCaptureTransaction(repository, { challengeId, challengeNonce } = {}) {
  try {
    const loaded = loadPersistentAction(repository, challengeId, challengeNonce);
    return deepFreeze({ decision: loaded.state.decision, executable: false, persistentChallengeId: challengeId,
      planRef: loaded.record.plan_ref, planDigest: loaded.record.plan_digest,
      checkpoint: loaded.state.checkpoint ?? 0, reason: loaded.state.reason ?? "",
      recoveryEvidencePreserved: loaded.record.status === "planned" });
  } catch (error) {
    return deepFreeze({ decision: "persistent-learning-capture-inspect-denied", reason: error.message, executable: false });
  }
}

function physicalPlanTarget(repositoryReal, ref) {
  if (typeof ref !== "string" || ref.includes("\\") || ref.includes(":") || isAbsolute(ref)
    || ref.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("transaction target is not one portable relative reference");
  }
  const parts = ref.split("/"); let cursor = repositoryReal;
  for (const part of parts.slice(0, -1)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) mkdirSync(cursor);
    const info = lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("transaction target parent crosses a link or non-directory");
    ensureInside(repositoryReal, realpathSync(cursor));
  }
  const target = resolve(repositoryReal, ...parts); ensureInside(repositoryReal, target);
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("transaction target is not a physical file");
    ensureInside(repositoryReal, realpathSync(target));
  }
  return target;
}

function physicalPlanTargetWithoutCreate(repositoryReal, ref) {
  if (typeof ref !== "string" || ref.includes("\\") || ref.includes(":") || isAbsolute(ref)
    || ref.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("transaction target is not one portable relative reference");
  }
  const parts = ref.split("/"); let cursor = repositoryReal;
  for (const part of parts.slice(0, -1)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) return resolve(repositoryReal, ...parts);
    const info = lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || info.isReparsePoint?.()) {
      throw new Error("transaction target parent crosses a link or non-directory");
    }
    ensureInside(repositoryReal, realpathSync(cursor));
  }
  const target = resolve(repositoryReal, ...parts); ensureInside(repositoryReal, target);
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.isReparsePoint?.()) {
      throw new Error("transaction target is not a physical file");
    }
    ensureInside(repositoryReal, realpathSync(target));
  }
  return target;
}

function readOwnedAtomicArtifact(target, maxBytes, label) {
  const info = lstatSync(target, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.isReparsePoint?.()
    || info.size > BigInt(maxBytes)) throw new Error(`${label} is not a bounded physical file`);
  const descriptor = openSync(target, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true }); const buffer = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) throw new Error(`${label} ended during read`); offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`${label} changed during read`);
    }
    return Object.freeze({ digest: sha256(buffer), byteLength: buffer.length });
  } finally { closeSync(descriptor); }
}

function recoverOwnedPlanAtomicArtifacts(repositoryReal, plan) {
  const token = plan.planDigest.slice("sha256:".length, "sha256:".length + 16);
  const preimages = new Map(plan.preimages.map((item) => [item.target, item]));
  const byTarget = new Map();
  for (const step of plan.steps) {
    const list = byTarget.get(step.target) ?? []; list.push(step); byTarget.set(step.target, list);
  }
  for (const [ref, steps] of byTarget) {
    const target = physicalPlanTargetWithoutCreate(repositoryReal, ref);
    const stage = `${target}.learning-capture-${token}.stage`;
    const backup = `${target}.learning-capture-${token}.backup`;
    const hasStage = existsSync(stage); const hasBackup = existsSync(backup);
    if (!hasStage && !hasBackup) continue;
    const preimage = preimages.get(ref);
    const maxBytes = Math.max(preimage?.byteLength ?? 0, ...steps.map((step) => step.proposedByteLength), 1);
    const stageArtifact = hasStage ? readOwnedAtomicArtifact(stage, maxBytes, "transaction stage artifact") : null;
    const backupArtifact = hasBackup ? readOwnedAtomicArtifact(backup, maxBytes, "transaction backup artifact") : null;
    const matches = steps.filter((step) => (!stageArtifact || stageArtifact.digest === step.proposedDigest)
      && (!backupArtifact || (step.preconditionDigest !== "absent" && backupArtifact.digest === step.preconditionDigest)));
    if (matches.length === 0) throw new Error(`transaction artifact digest does not match the sealed plan at ${ref}`);
    const currentDigest = digestAt(repositoryReal, { target: ref });
    const exact = matches.find((step) => (hasBackup && hasStage
      ? currentDigest === "absent"
      : hasBackup ? currentDigest === step.proposedDigest
        : currentDigest === step.preconditionDigest));
    if (!exact) throw new Error(`transaction artifact topology is not one owned crash window at ${ref}`);
    if (hasBackup && hasStage) {
      renameSync(backup, target);
      if (digestAt(repositoryReal, { target: ref }) !== exact.preconditionDigest) {
        throw new Error(`transaction backup did not restore its sealed preimage at ${ref}`);
      }
      unlinkSync(stage);
    } else if (hasBackup) {
      // The new target is already exact; the process stopped immediately before
      // removing the old preimage backup.
      unlinkSync(backup);
    } else {
      // The process stopped after staging but before moving the original target.
      // Dropping the exact proposed stage restores the sealed preimage state.
      unlinkSync(stage);
    }
  }
}

function atomicPlanStep(repositoryReal, step, planDigest) {
  const target = physicalPlanTarget(repositoryReal, step.target);
  const token = planDigest.slice("sha256:".length, "sha256:".length + 16);
  const stage = `${target}.learning-capture-${token}.stage`; const backup = `${target}.learning-capture-${token}.backup`;
  if (existsSync(stage) || existsSync(backup)) throw new Error("owned atomic artifacts require sealed-plan recovery before execution");
  const current = digestAt(repositoryReal, { target: step.target });
  if (current !== step.preconditionDigest) throw new Error(`transaction precondition drifted at step ${step.ordinal}`);
  const content = Buffer.from(step.contentBase64, "base64");
  if (content.length !== step.proposedByteLength || sha256(content) !== step.proposedDigest) {
    throw new Error(`transaction proposed bytes are invalid at step ${step.ordinal}`);
  }
  writeFileSync(stage, content, { flag: "wx" });
  try {
    if (existsSync(target)) renameSync(target, backup);
    renameSync(stage, target);
    if (digestAt(repositoryReal, { target: step.target }) !== step.proposedDigest) {
      throw new Error(`transaction readback failed at step ${step.ordinal}`);
    }
    if (existsSync(backup)) unlinkSync(backup);
  } catch (error) {
    if (existsSync(stage)) unlinkSync(stage);
    if (existsSync(backup)) {
      if (existsSync(target)) unlinkSync(target);
      renameSync(backup, target);
    }
    throw error;
  }
}

function applyBestEffortProjections(repositoryReal, plan) {
  const steps = Array.isArray(plan.projections) ? plan.projections : [];
  const pending = [];
  for (const issue of plan.projectionIssues ?? []) {
    if (issue === "dashboard-snapshot-refresh-pending") {
      pending.push("dashboard-public-snapshot", "dashboard-dist-snapshot");
    } else if (issue === "dashboard-projection-cleanup-pending") {
      pending.push("dashboard-projection-cleanup");
    } else if (issue === "learning-derived-state-refresh-pending") {
      pending.push("candidate-index", "learning-signal-source", "time-projection",
        "startup-signal-projection", "control-clean", "dashboard-public-snapshot", "dashboard-dist-snapshot");
    }
  }
  let applied = 0;
  let reason = pending.length > 0 ? "projection-could-not-be-prepared" : "";
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const current = digestAt(repositoryReal, { target: step.target });
    if (current === step.proposedDigest) {
      applied += 1;
      continue;
    }
    if (current !== step.preconditionDigest) {
      reason = "projection-source-drifted";
      pending.push(...steps.slice(index).map((item) => item.phase));
      break;
    }
    try {
      atomicPlanStep(repositoryReal, step, plan.planDigest);
      applied += 1;
    } catch {
      reason = "projection-refresh-failed";
      pending.push(...steps.slice(index).map((item) => item.phase));
      break;
    }
  }
  return Object.freeze({
    state: pending.length === 0 ? "current" : "refresh-pending",
    appliedCount: applied,
    pending: Object.freeze([...new Set(pending)]),
    reason,
  });
}

function finalizePersistentCompletion(loaded) {
  atomicJson(loaded.recordTarget, { ...loaded.record, status: "completed", plan_ref: "" }, { replace: true });
  const planTarget = persistentPlanPath(loaded.repositoryReal, loaded.record.challenge_id);
  if (existsSync(planTarget)) unlinkSync(planTarget);
  removeEmptyPersistentDirectories(loaded.repositoryReal);
}

function finishPersistentExecution(loaded, { idempotent, writeCount }) {
  const projection = applyBestEffortProjections(loaded.repositoryReal, loaded.plan);
  finalizePersistentCompletion(loaded);
  return deepFreeze({
    decision: "persistent-learning-capture-execution-complete", executable: false,
    persistentChallengeId: loaded.record.challenge_id, planDigest: loaded.plan.planDigest,
    idempotent, writeCount, temporarySemanticPlanRemoved: true,
    projectionState: projection.state, projectionAppliedCount: projection.appliedCount,
    projectionPending: projection.pending, projectionReason: projection.reason,
    ordinaryTasksContinue: true,
  });
}

export function executePersistentLearningCaptureTransaction(repository, { challengeId, challengeNonce } = {}) {
  let loaded;
  try {
    loaded = loadPersistentAction(repository, challengeId, challengeNonce);
    if (loaded.record.status === "completed") return deepFreeze({ decision: "persistent-learning-capture-execution-complete",
      executable: false, persistentChallengeId: challengeId, planDigest: loaded.record.plan_digest,
      idempotent: true, temporarySemanticPlanRemoved: true });
    if (loaded.state.decision === "learning-capture-already-committed") {
      return finishPersistentExecution(loaded, { idempotent: true, writeCount: 0 });
    }
    if (loaded.state.decision !== "learning-capture-ready-for-host-execution") {
      return deepFreeze({ decision: loaded.state.decision === "learning-capture-rollback-required"
        ? "persistent-learning-capture-execution-rollback-required" : "persistent-learning-capture-execution-recovery-required",
      executable: false, persistentChallengeId: challengeId, checkpoint: loaded.state.checkpoint ?? 0,
      reason: loaded.state.reason ?? "", planRef: loaded.record.plan_ref, recoveryEvidencePreserved: true });
    }
    for (const step of loaded.plan.steps) atomicPlanStep(loaded.repositoryReal, step, loaded.plan.planDigest);
    const finalState = inspectStructurallyTrustedPlanState(loaded.repositoryReal, loaded.plan);
    if (finalState.decision !== "learning-capture-already-committed") throw new Error("transaction final state did not close exactly");
    return finishPersistentExecution(loaded, { idempotent: false, writeCount: loaded.plan.steps.length });
  } catch (error) {
    let state;
    try { if (loaded?.plan) state = inspectStructurallyTrustedPlanState(loaded.repositoryReal, loaded.plan); } catch { /* preserve evidence */ }
    return deepFreeze({ decision: state?.decision === "learning-capture-rollback-required"
      ? "persistent-learning-capture-execution-rollback-required" : "persistent-learning-capture-execution-denied",
    reason: error.message, executable: false, persistentChallengeId: challengeId ?? "",
    checkpoint: state?.checkpoint ?? 0, recoveryEvidencePreserved: loaded?.record?.status === "planned" });
  }
}

function cleanupKnownEmptyTransactionDirectories(repositoryReal) {
  for (const ref of ["instance/signals/count", "instance/signals", "instance/evolution", "instance/memory",
    "instance/capabilities", "instance/sops", "instance/experiences"]) {
    const target = resolve(repositoryReal, ...ref.split("/"));
    if (existsSync(target) && lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink()
      && readdirSync(target).length === 0) rmdirSync(target);
  }
}

export function rollbackPersistentLearningCaptureTransaction(repository, { challengeId, challengeNonce } = {}) {
  let loaded;
  try {
    loaded = loadPersistentAction(repository, challengeId, challengeNonce);
    if (loaded.record.status === "completed") throw new Error("a completed transaction cannot be rolled back through crash recovery");
    if (loaded.state.decision === "learning-capture-already-committed") throw new Error("a fully committed transaction requires a separate authorized change, not crash rollback");
    if (!["learning-capture-rollback-required", "learning-capture-ready-for-host-execution"].includes(loaded.state.decision)) {
      throw new Error("non-prefix drift cannot be automatically rolled back");
    }
    for (const item of loaded.plan.rollback) {
      const target = physicalPlanTarget(loaded.repositoryReal, item.target);
      if (item.restoreDigest === "absent") {
        if (existsSync(target)) unlinkSync(target);
      } else {
        atomicPlanStep(loaded.repositoryReal, {
          ordinal: 0, target: item.target, preconditionDigest: digestAt(loaded.repositoryReal, { target: item.target }),
          proposedDigest: item.restoreDigest, proposedByteLength: Buffer.from(item.contentBase64, "base64").length,
          contentBase64: item.contentBase64,
        }, loaded.plan.planDigest);
      }
      if (digestAt(loaded.repositoryReal, { target: item.target }) !== item.restoreDigest) {
        throw new Error(`rollback readback failed for ${item.target}`);
      }
    }
    const restored = inspectStructurallyTrustedPlanState(loaded.repositoryReal, loaded.plan);
    if (restored.decision !== "learning-capture-ready-for-host-execution") throw new Error("rollback did not restore all exact preimages");
    const planTarget = persistentPlanPath(loaded.repositoryReal, challengeId);
    if (existsSync(planTarget)) unlinkSync(planTarget); unlinkSync(loaded.recordTarget);
    cleanupKnownEmptyTransactionDirectories(loaded.repositoryReal); removeEmptyPersistentDirectories(loaded.repositoryReal);
    return deepFreeze({ decision: "persistent-learning-capture-rollback-complete", executable: false,
      persistentChallengeId: challengeId, restoredTargetCount: loaded.plan.preimages.length,
      temporarySemanticPlanRemoved: true, operationalRecordRemoved: true });
  } catch (error) {
    return deepFreeze({ decision: "persistent-learning-capture-rollback-denied", reason: error.message,
      executable: false, persistentChallengeId: challengeId ?? "", recoveryEvidencePreserved: loaded?.record?.status === "planned" });
  }
}
