import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import { parseArrayTableDocument, parseMarkdownFrontmatterHead, readTrustedInstanceIdentity, resolvePhysicalAssetTarget, stableAssetId } from "./asset-route-contract.mjs";
import { normalizeRetrievalRequest, rankRetrievalEntries } from "./bounded-retrieval.mjs";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";
import { containsForbiddenLocationReference, containsForbiddenStructuredLocation } from "./safe-output-boundary.mjs";

const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const rootFields = new Set(["schema_version", "index_id", "instance_id", "state", "source_revision", "generated_at", "budget_bytes", "overflow", "candidate_count", "indexed_count", "active_count"]);
const entryFields = new Set(["id", "title", "summary", "topic_key", "subject_key", "triggers", "aliases", "scope", "conditions", "excludes", "target_kind", "target_subtype", "candidate_relation", "status", "observation_state", "observation_basis", "risk_tier", "independent_event_count", "last_evidence_at", "source_ref", "source_revision"]);
const publicEntryFields = [...entryFields].filter((field) => field !== "source_ref");
const revisionedEntryFields = [...entryFields].filter((field) => field !== "source_revision");
const trustedCandidateViews = new WeakMap();
const trustedPromotionCandidateRecords = new WeakMap();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const candidateSourceFields = new Set([
  "id", "kind", "status", "title", "summary", "triggers", "scope", "excludes", "lifecycle", "expected_next_use",
  "topic_key", "subject_key", "aliases", "conditions", "target_kind", "target_subtype", "candidate_relation",
  "observation_state", "observation_basis", "observation_event_ref", "claim_summary", "proposed_risk_tier",
  "independent_event_count", "successful_event_count", "failed_event_count", "distinct_context_count",
  "representative_event_ids", "last_evidence_at", "remind_at", "snoozed_until", "trigger_revision", "source_revision",
  "source_refs", "private_refs", "supersedes", "minimum_level", "approval_state", "activation_basis", "risk_tier",
  "approved_by_user", "updated_at", "resolution", "resolved_to",
]);
const candidateResolutions = new Set(["promoted", "merged", "superseded", "rejected"]);

function fail(message) { throw new Error(`Candidate index contract failed: ${message}`); }
function decodeUtf8(buffer, label) { try { return utf8Decoder.decode(buffer); } catch { fail(`${label} is not valid UTF-8`); } }
function clean(value, max, allowEmpty = true) { return typeof value === "string" && (allowEmpty || value.length > 0) && [...value].length <= max && value.normalize("NFC") === value && !unsafeText.test(value); }
function cleanList(value, maxItems, maxChars) { return Array.isArray(value) && value.length <= maxItems && value.every((item) => clean(item, maxChars, false)); }
function stableList(value, maxItems) { return Array.isArray(value) && value.length <= maxItems && new Set(value).size === value.length && value.every((item) => stableAssetId.test(item)); }
function validPrivateReference(ref) {
  if (!clean(ref, 240, false) || locateHighConfidenceSecretCandidates(ref).blocked) return false;
  const match = /^private:\/\/([a-z0-9][a-z0-9._:-]{0,159})\/(.+)$/u.exec(ref);
  const relativeRef = match ? match[2] : ref.startsWith(".assistant-private/assets/") ? ref.slice(".assistant-private/assets/".length) : "";
  return relativeRef.length > 0 && relativeRef.normalize("NFC") === relativeRef && !relativeRef.includes("\\")
    && !relativeRef.includes(":") && !relativeRef.includes("?") && !relativeRef.includes("#")
    && relativeRef.split("/").every((part) => part && part !== "." && part !== ".." && !/[. ]$/u.test(part) && !/[<>"|*]/u.test(part));
}
function normalizedSourceRef(value) {
  if (!clean(value, 240, false) || !value.startsWith("instance/evolution/") || !value.endsWith(".md") || value.includes("\\") || value.includes(":") || value.includes("?") || value.includes("#")) return false;
  return value.split("/").every((part) => {
    const base = part.replace(/\..*$/u, "").toLowerCase();
    return part && part !== "." && part !== ".." && !/[. ]$/u.test(part) && !/[<>"|*]/u.test(part)
      && !["con", "prn", "aux", "nul", "clock$"].includes(base) && !/^(?:com|lpt)[1-9]$/u.test(base);
  });
}
function strictZonedDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value ?? "");
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return false;
  if (match[7] !== "Z") {
    const offsetHour = Number(match[9]); const offsetMinute = Number(match[10]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}
function counts(entries) {
  return {
    indexed: entries.length,
    active: entries.filter(activeCandidateEntry).length,
  };
}
const ordinaryCandidateRelations = new Set(["new", "refine", "condition-variant", "related"]);
const candidateRelations = new Set([...ordinaryCandidateRelations, "duplicate", "conflict", "replace", "uncertain"]);
function activeCandidateEntry(entry) {
  return entry.status === "candidate" && entry.observation_state === "explicit"
    && ["explicit-user", "existing-approved-migration"].includes(entry.observation_basis)
    && ordinaryCandidateRelations.has(entry.candidate_relation)
    && candidateTargetSubtypeDisposition(entry.target_kind, entry.target_subtype ?? "") === "valid";
}
export function candidateTargetSubtypeDisposition(kind, subtype) {
  if (kind === "memory") {
    if (["general", "habit"].includes(subtype)) return "valid";
    if (subtype === "") return "legacy-review-only";
    return "invalid";
  }
  if (kind === "experience") return ["task", "host-execution"].includes(subtype) ? "valid" : "invalid";
  if (["capability", "sop", "preference", "unknown"].includes(kind)) return subtype === "" ? "valid" : "invalid";
  return "invalid";
}
function entryValid(entry) {
  return Object.keys(entry).every((key) => entryFields.has(key))
    && !locateHighConfidenceSecretCandidates(JSON.stringify(entry)).blocked
    && Buffer.byteLength(JSON.stringify(entry), "utf8") <= 2048
    && stableAssetId.test(entry.id ?? "")
    && clean(entry.title, 80, false) && clean(entry.summary, 240, false)
    && clean(entry.topic_key ?? "", 120) && clean(entry.subject_key ?? "", 120)
    && clean(entry.target_kind, 40, false) && clean(entry.target_subtype ?? "", 80)
    && candidateRelations.has(entry.candidate_relation)
    && clean(entry.risk_tier, 16, false) && clean(entry.last_evidence_at ?? "", 64)
    && (entry.last_evidence_at === "" || strictZonedDate(entry.last_evidence_at))
    && cleanList(entry.triggers ?? [], 8, 80) && cleanList(entry.aliases ?? [], 8, 80)
    && cleanList(entry.scope ?? [], 8, 120) && cleanList(entry.conditions ?? [], 8, 120) && cleanList(entry.excludes ?? [], 8, 120)
    && ["candidate", "review"].includes(entry.status)
    && ["memory", "capability", "sop", "experience", "preference", "unknown"].includes(entry.target_kind)
    && candidateTargetSubtypeDisposition(entry.target_kind, entry.target_subtype ?? "") !== "invalid"
    && ["low", "medium", "high"].includes(entry.risk_tier)
    && Number.isSafeInteger(entry.independent_event_count) && entry.independent_event_count >= 0
    && ((entry.observation_state === "explicit" && ["explicit-user", "existing-approved-migration"].includes(entry.observation_basis))
      || (entry.observation_state === "pending" && entry.observation_basis === "unknown")
      || (entry.observation_state === "revoked" && ["explicit-user", "existing-approved-migration"].includes(entry.observation_basis)))
    && normalizedSourceRef(entry.source_ref)
    && Number.isSafeInteger(entry.source_revision) && entry.source_revision > 0;
}

function candidateSourceMatchesEntry(source, entry) {
  const independent = source?.independent_event_count;
  const successful = source?.successful_event_count;
  const failed = source?.failed_event_count;
  const contexts = source?.distinct_context_count;
  const exactSafeMetadata = source && typeof source === "object" && !Array.isArray(source)
    && Object.keys(source).every((field) => candidateSourceFields.has(field) && !["__proto__", "prototype", "constructor"].includes(field))
    && !locateHighConfidenceSecretCandidates(JSON.stringify(source)).blocked
    && !containsForbiddenStructuredLocation(source)
    && clean(source.lifecycle ?? "", 40) && clean(source.expected_next_use ?? "", 120)
    && clean(source.observation_event_ref ?? "", 160) && clean(source.claim_summary ?? "", 240)
    && stableList(source.representative_event_ids ?? [], 5) && stableList(source.source_refs ?? [], 16)
    && stableList(source.supersedes ?? [], 8)
    && Array.isArray(source.private_refs ?? []) && (source.private_refs ?? []).length <= 32 && (source.private_refs ?? []).every(validPrivateReference)
    && Number.isSafeInteger(independent) && independent >= 0 && Number.isSafeInteger(successful) && successful >= 0
    && Number.isSafeInteger(failed) && failed >= 0 && Number.isSafeInteger(contexts) && contexts >= 0
    && successful <= independent && failed <= independent && successful + failed <= independent && contexts <= independent
    && Number.isSafeInteger(source.trigger_revision ?? 0) && (source.trigger_revision ?? 0) >= 0
    && ["last_evidence_at", "remind_at", "snoozed_until", "updated_at"].every((field) => (source[field] ?? "") === "" || strictZonedDate(source[field]));
  const unresolvedResolution = !Object.hasOwn(source, "resolution") && !Object.hasOwn(source, "resolved_to")
    || ((source.resolution ?? "") === "" && (source.resolved_to ?? "") === "");
  return exactSafeMetadata && unresolvedResolution && source?.id === entry.id && source?.kind === "evolution-candidate" && source?.status === entry.status
    && source?.source_revision === entry.source_revision && source?.observation_state === entry.observation_state
    && source?.observation_basis === entry.observation_basis && source?.proposed_risk_tier === entry.risk_tier
    && source?.target_kind === entry.target_kind && (source?.target_subtype ?? "") === entry.target_subtype
    && source?.candidate_relation === entry.candidate_relation
    && source?.independent_event_count === entry.independent_event_count && source?.title === entry.title && source?.summary === entry.summary
    && source?.approval_state === "pending" && source?.activation_basis === "candidate" && source?.approved_by_user === false
    && source?.risk_tier === entry.risk_tier && [1, 2, 3].includes(source?.minimum_level)
    && (source?.last_evidence_at ?? "") === entry.last_evidence_at
    && (source?.topic_key ?? "") === entry.topic_key && (source?.subject_key ?? "") === entry.subject_key
    && ["triggers", "aliases", "scope", "conditions", "excludes"].every((field) => JSON.stringify(source?.[field] ?? []) === JSON.stringify(entry[field]));
}

export function validateCandidateRevisionTransition(previous, next) {
  if (!entryValid(previous) || !entryValid(next) || previous.id !== next.id) return false;
  const projectionChanged = revisionedEntryFields.some((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]));
  return projectionChanged
    ? next.source_revision === previous.source_revision + 1
    : next.source_revision === previous.source_revision;
}

export function selectCandidateShortlist(entries, queryText, intentHints = [], { limit = 3 } = {}) {
  if (!Array.isArray(entries)) return [];
  const request = normalizeRetrievalRequest(queryText, intentHints);
  if (!request.ok) return [];
  const eligible = entries
    .filter((entry) => entryValid(entry) && activeCandidateEntry(entry));
  return rankRetrievalEntries(eligible, request, { limit }).map(({ entry }) => entry);
}

function validateCandidateIndexMetadata(index, { expectedInstanceId, actualFileBytes } = {}) {
  if (!index || typeof index !== "object" || !Array.isArray(index.candidates) || !stableAssetId.test(expectedInstanceId ?? "")) return false;
  if (Object.keys(index).some((key) => key !== "candidates" && !rootFields.has(key))) return false;
  const calculated = counts(index.candidates);
  const ids = index.candidates.map((entry) => entry.id);
  const refs = index.candidates.map((entry) => String(entry.source_ref ?? "").toLowerCase());
  const empty = index.state === "empty" && index.candidates.length === 0;
  const stateUsable = index.state === "current" || empty;
  const timeValid = empty
    ? (expectedInstanceId === "template" ? index.generated_at === "" : index.generated_at === "" || strictZonedDate(index.generated_at))
    : strictZonedDate(index.generated_at);
  const templateValid = expectedInstanceId !== "template" || (index.state === "empty" && index.candidates.length === 0);
  return index.schema_version === 1 && index.index_id === "evolution-candidates" && index.instance_id === expectedInstanceId
    && clean(index.generated_at ?? "", 64) && timeValid && templateValid && stateUsable
    && index.candidates.length <= 128 && new Set(ids).size === ids.length && new Set(refs).size === refs.length
    && Number.isSafeInteger(index.source_revision) && index.source_revision >= 0 && index.budget_bytes === 32768
    && Number.isSafeInteger(actualFileBytes) && actualFileBytes >= 0 && actualFileBytes <= 32768 && index.overflow === false
    && index.indexed_count === calculated.indexed && index.candidate_count === calculated.indexed && index.active_count === calculated.active && index.active_count <= index.indexed_count
    && index.candidates.every(entryValid);
}

export function validateCandidateIndex(index, candidateSources, { expectedInstanceId, actualFileBytes } = {}) {
  if (!(candidateSources instanceof Map) || !validateCandidateIndexMetadata(index, { expectedInstanceId, actualFileBytes })) return false;
  const refs = index.candidates.map((entry) => entry.source_ref);
  return candidateSources.size === refs.length
    && [...candidateSources.keys()].every((ref) => refs.includes(ref))
    && index.candidates.every((entry) => candidateSourceMatchesEntry(candidateSources.get(entry.source_ref), entry));
}

function stableRead(path, maxBytes, label) {
  const realBefore = realpathSync(path);
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
    const same = before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
    const afterPath = lstatSync(path);
    if (offset !== buffer.length || !same || !afterPath.isFile() || afterPath.isSymbolicLink() || realpathSync(path) !== realBefore) fail(`${label} changed during its bounded read`);
    return Object.freeze({ buffer, text: decodeUtf8(buffer, label), fileBytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") });
  } finally { closeSync(descriptor); }
}
function resolveIndex(repository) {
  const root = realpathSync(repository); let cursor = root;
  for (const part of ["instance", "evolution", "index.toml"]) { cursor = resolve(cursor, part); const info = lstatSync(cursor); if (info.isSymbolicLink()) fail("index path crosses a link or reparse point"); }
  if (!lstatSync(cursor).isFile()) fail("index is not a regular file");
  const fromRoot = relative(root, realpathSync(cursor));
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) fail("index escapes AI Carry");
  return cursor;
}

function readIndexSnapshot(repository) {
  return stableRead(resolveIndex(repository), 32768, "candidate index");
}

function readCandidateSnapshot(repository, entry) {
  const path = resolvePhysicalAssetTarget(repository, entry.source_ref, "evolution");
  return stableRead(path, 32 * 1024, `candidate ${entry.id}`);
}

function unresolvedCandidateSourceRefs(repository) {
  const rootDirectory = dirname(resolveIndex(repository));
  const refs = new Set();
  const queue = [rootDirectory];
  let visited = 0;
  while (queue.length) {
    const directory = queue.shift();
    if (++visited > 512) fail("candidate source tree exceeds the bounded maintenance scan");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const info = lstatSync(path);
      // Never follow unreferenced links. Archived history is intentionally not
      // part of the unresolved-source completeness set.
      if (info.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (entry.name.toLowerCase() !== "archive") queue.push(path); continue; }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || entry.name.toLowerCase() === "readme.md") continue;
      const fromRepository = relative(realpathSync(repository), realpathSync(path)).split(sep).join("/").normalize("NFC");
      const source = stableRead(path, 32 * 1024, "candidate source closure");
      let parsed;
      try { parsed = parseMarkdownFrontmatterHead(source.text, undefined).values; } catch { fail("candidate source tree contains invalid frontmatter"); }
      if (parsed.kind !== "evolution-candidate") fail("candidate source tree contains an unexpected Markdown asset");
      if (["candidate", "review"].includes(parsed.status)) refs.add(fromRepository.toLowerCase());
      else if (parsed.status !== "archived") fail("candidate source has an unsupported lifecycle state");
    }
  }
  return refs;
}

function candidateViewFresh(repository, trust) {
  try {
    const identity = readTrustedInstanceIdentity(repository, trust.instanceContext);
    return Boolean(identity && identity.instanceId === trust.instanceId && readIndexSnapshot(repository).sha256 === trust.indexDigest);
  } catch { return false; }
}

function selectTrustedCandidate(repository, view, candidateId, { review = false } = {}) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return null; }
  const trust = trustedCandidateViews.get(view);
  if (!trust || trust.repository !== repositoryReal || !stableAssetId.test(candidateId ?? "") || !candidateViewFresh(repository, trust)) return null;
  if (review) return trust.explicitId === candidateId ? trust.entries.get(candidateId) ?? null : null;
  return trust.allowedIds.has(candidateId) ? trust.entries.get(candidateId) ?? null : null;
}

export function inspectCandidateSource(repository, view, candidateId) {
  const entry = selectTrustedCandidate(repository, view, candidateId);
  if (!entry || !entryValid(entry)) return { decision: "deny-untrusted-index-view", executable: false };
  let read;
  try { read = readCandidateSnapshot(repository, entry); }
  catch { return { decision: "deny-path-size-or-race", executable: false }; }
  const fileBytes = read.fileBytes;
  let parsed;
  try { parsed = parseMarkdownFrontmatterHead(read.text, entry.id); }
  catch { return { decision: "deny-frontmatter", executable: false, fileBytes }; }
  if (!candidateSourceMatchesEntry(parsed.values, entry)) return { decision: "deny-source-drift", executable: false, fileBytes };
  if (![1, 2, 3].includes(parsed.values.minimum_level)) return { decision: "deny-model-level-metadata", executable: false, fileBytes };
  if (entry.status !== "candidate" || entry.observation_state !== "explicit" || !["explicit-user", "existing-approved-migration"].includes(entry.observation_basis)) return { decision: "frontmatter-review-only", executable: false, fileBytes };
  const trust = trustedCandidateViews.get(view);
  if (!trust || !candidateViewFresh(repository, trust)) return { decision: "deny-stale-index-view", executable: false, fileBytes };
  const source = read.text.replaceAll("\r\n", "\n");
  const body = source.slice(parsed.bodyOffset);
  const secrets = locateHighConfidenceSecretCandidates(body);
  return secrets.blocked || containsForbiddenLocationReference(body)
    ? { decision: "deny-sensitive-or-nonportable-candidate", executable: false, fileBytes, secretFindingCount: secrets.count, secretFindingCategories: Object.freeze([...new Set(secrets.findings.map((finding) => finding.category))]) }
    : { decision: "load-bounded-body", executable: false, contentRole: "candidate-evidence-only", authorizedActions: Object.freeze([]), recommendedLevel: parsed.values.minimum_level, fileBytes, body };
}

export function inspectCandidateForReview(repository, view, candidateId, { explicitRequestedId, reviewEvidenceRequested = false } = {}) {
  if (explicitRequestedId !== candidateId || !stableAssetId.test(explicitRequestedId ?? "")) return { decision: "deny-explicit-review-id", executable: false };
  const entry = selectTrustedCandidate(repository, view, candidateId, { review: true });
  if (!entry || !entryValid(entry)) return { decision: "deny-untrusted-index-view", executable: false };
  if (entry.status !== "review" || reviewEvidenceRequested !== true) return {
    decision: "frontmatter-review-only", executable: false, id: entry.id, status: entry.status,
    observationState: entry.observation_state, observationBasis: entry.observation_basis,
  };
  let read;
  try { read = readCandidateSnapshot(repository, entry); }
  catch { return { decision: "deny-path-size-or-race", executable: false }; }
  const fileBytes = read.fileBytes;
  let parsed;
  try { parsed = parseMarkdownFrontmatterHead(read.text, entry.id); }
  catch { return { decision: "deny-frontmatter", executable: false, fileBytes }; }
  const sourceAsset = parsed.values;
  if (!candidateSourceMatchesEntry(sourceAsset, entry)) return { decision: "deny-source-drift", executable: false, fileBytes };
  if (![1, 2, 3].includes(sourceAsset.minimum_level)) return { decision: "deny-model-level-metadata", executable: false, fileBytes };
  const trust = trustedCandidateViews.get(view);
  if (!trust || !candidateViewFresh(repository, trust)) return { decision: "deny-stale-index-view", executable: false, fileBytes };
  const source = read.text.replaceAll("\r\n", "\n");
  const body = source.slice(parsed.bodyOffset);
  const secrets = locateHighConfidenceSecretCandidates(body);
  return secrets.blocked || containsForbiddenLocationReference(body)
    ? { decision: "deny-sensitive-or-nonportable-candidate", executable: false, fileBytes, secretFindingCount: secrets.count, secretFindingCategories: Object.freeze([...new Set(secrets.findings.map((finding) => finding.category))]) }
    : { decision: "review-evidence-only", executable: false, contentRole: "candidate-review-evidence-only", authorizedActions: Object.freeze([]), recommendedLevel: sourceAsset.minimum_level, fileBytes, body };
}

export function loadCandidateIndex(repository, { instanceContext, explicitRequestedId, queryText, intentHints = [] } = {}) {
  if (explicitRequestedId !== undefined && !stableAssetId.test(explicitRequestedId)) fail("explicit candidate request has an invalid stable ID");
  const trustedIdentity = readTrustedInstanceIdentity(repository, instanceContext);
  if (!trustedIdentity) fail("candidate index lacks an identity minted from the installed instance manifest");
  const indexRead = readIndexSnapshot(repository); const actualFileBytes = indexRead.fileBytes;
  const parsed = parseArrayTableDocument(indexRead.text, "candidates", "candidate index");
  const index = { ...parsed.root, candidates: parsed.entries };
  const readableRoot = index.schema_version === 1 && index.index_id === "evolution-candidates"
    && index.instance_id === trustedIdentity.instanceId && parsed.entries.length <= 128
    && Number.isSafeInteger(actualFileBytes) && actualFileBytes >= 0 && actualFileBytes <= 32768;
  if (!readableRoot) fail("candidate index or trusted instance identity is invalid");
  const idCounts = new Map(); const refCounts = new Map();
  for (const entry of parsed.entries) {
    if (stableAssetId.test(entry?.id ?? "")) idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
    const ref = String(entry?.source_ref ?? "").toLowerCase();
    if (normalizedSourceRef(entry?.source_ref)) refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
  }
  const usableEntries = parsed.entries.filter((entry) => entryValid(entry)
    && idCounts.get(entry.id) === 1 && refCounts.get(entry.source_ref.toLowerCase()) === 1);
  const isolatedEntryCount = parsed.entries.length - usableEntries.length;
  const calculated = counts(usableEntries);
  const metadataDrift = !["empty", "current"].includes(index.state)
    || !Number.isSafeInteger(index.source_revision) || index.source_revision < 0
    || index.budget_bytes !== 32768 || index.overflow !== false
    || index.candidate_count !== parsed.entries.length || index.indexed_count !== parsed.entries.length
    || index.active_count !== counts(parsed.entries.filter(entryValid)).active
    || !clean(index.generated_at ?? "", 64)
    || (usableEntries.length === 0
      ? !(index.generated_at === "" || strictZonedDate(index.generated_at))
      : !strictZonedDate(index.generated_at));
  const retrievalRequest = queryText === undefined ? null : normalizeRetrievalRequest(queryText, intentHints);
  if (retrievalRequest && !retrievalRequest.ok) fail(`candidate query rejected: ${retrievalRequest.reason}`);
  const verifySelectedSource = (entry) => {
    const read = readCandidateSnapshot(repository, entry);
    const asset = parseMarkdownFrontmatterHead(read.text, entry.id).values;
    if (!candidateSourceMatchesEntry(asset, entry)) fail(`selected candidate source drift: ${entry.source_ref}`);
    return entry;
  };
  const project = (entry) => Object.freeze(Object.fromEntries(publicEntryFields
    .filter((field) => Object.hasOwn(entry, field))
    .map((field) => [field, Array.isArray(entry[field]) ? Object.freeze([...entry[field]]) : entry[field]])));
  const rankedEntries = retrievalRequest
    ? selectCandidateShortlist(usableEntries, retrievalRequest.query, retrievalRequest.hints, { limit: Math.max(1, Math.min(usableEntries.length, 128)) })
    : [];
  const selectedEntries = [];
  let rejectedSourceCount = 0;
  for (const entry of rankedEntries) {
    if (selectedEntries.length >= 3) break;
    try { selectedEntries.push(verifySelectedSource(entry)); }
    catch { rejectedSourceCount += 1; }
  }
  const matchingCandidates = Object.freeze(selectedEntries.map(project));
  const metadata = Object.freeze({ ...Object.fromEntries([...rootFields]
    .filter((field) => Object.hasOwn(index, field))
    .map((field) => [field, index[field]])), state: calculated.indexed === 0 ? "empty" : "current",
    budget_bytes: 32768, overflow: false, candidate_count: calculated.indexed,
    indexed_count: calculated.indexed, active_count: calculated.active });
  const explicitlySelected = explicitRequestedId ? usableEntries.find((entry) => entry.id === explicitRequestedId) : undefined;
  const view = Object.freeze({ metadata, matchingCandidates, explicitCandidate: explicitlySelected ? project(verifySelectedSource(explicitlySelected)) : null,
    integrityState: rejectedSourceCount === 0 && isolatedEntryCount === 0 && !metadataDrift
      ? "verified" : "degraded-valid-matches-only",
    rejectedSourceCount, isolatedEntryCount, metadataRepairPending: metadataDrift, actualFileBytes });
  const fullEntries = new Map();
  for (const entry of [...selectedEntries, ...(explicitlySelected ? [explicitlySelected] : [])]) fullEntries.set(entry.id, Object.freeze({ ...entry }));
  trustedCandidateViews.set(view, Object.freeze({
    repository: trustedIdentity.repository,
    instanceContext,
    instanceId: trustedIdentity.instanceId,
    indexDigest: indexRead.sha256,
    entries: fullEntries,
    allowedIds: new Set(matchingCandidates.map((entry) => entry.id).concat(explicitlySelected ? [explicitlySelected.id] : [])),
    explicitId: explicitlySelected?.id ?? null,
  }));
  return view;
}

// Explicit learning-maintenance boundary. It is intentionally separate from
// ordinary shortlist reads and returns an opaque record whose origin/freshness
// can be verified without trusting caller-supplied candidate JSON.
export function loadTrustedPromotionCandidateRecord(repository, { instanceContext, candidateId } = {}) {
  if (!stableAssetId.test(candidateId ?? "")) fail("promotion candidate ID is invalid");
  const trustedIdentity = readTrustedInstanceIdentity(repository, instanceContext);
  if (!trustedIdentity || trustedIdentity.manifestState !== "instance") fail("promotion requires a trusted instantiated AI Carry");
  const indexRead = readIndexSnapshot(repository);
  const parsedIndex = parseArrayTableDocument(indexRead.text, "candidates", "candidate index");
  const index = { ...parsedIndex.root, candidates: parsedIndex.entries };
  if (!validateCandidateIndexMetadata(index, { expectedInstanceId: trustedIdentity.instanceId, actualFileBytes: indexRead.fileBytes })) fail("promotion candidate index is invalid");
  const entry = index.candidates.find((item) => item.id === candidateId);
  if (!entry) fail("promotion candidate is not in the current index");
  const read = readCandidateSnapshot(repository, entry);
  const source = parseMarkdownFrontmatterHead(read.text, entry.id).values;
  if (!candidateSourceMatchesEntry(source, entry)) fail("promotion candidate index and source differ");
  const record = Object.freeze({
    id: entry.id, status: entry.status, sourceRevision: entry.source_revision, candidateRelation: entry.candidate_relation,
    title: entry.title, summary: entry.summary, triggers: Object.freeze([...(entry.triggers ?? [])]), aliases: Object.freeze([...(entry.aliases ?? [])]),
    targetKind: entry.target_kind, targetSubtype: entry.target_subtype, riskTier: entry.risk_tier,
    observationState: entry.observation_state, observationBasis: entry.observation_basis,
    topicKey: entry.topic_key, subjectKey: entry.subject_key,
    scope: Object.freeze([...(entry.scope ?? [])]), conditions: Object.freeze([...(entry.conditions ?? [])]),
    independentEventCount: entry.independent_event_count,
    successfulEventCount: Number.isSafeInteger(source.successful_event_count) ? source.successful_event_count : 0,
    failedEventCount: Number.isSafeInteger(source.failed_event_count) ? source.failed_event_count : 0,
    distinctContextCount: Number.isSafeInteger(source.distinct_context_count) ? source.distinct_context_count : 0,
    representativeEventIds: Object.freeze(Array.isArray(source.representative_event_ids) ? [...source.representative_event_ids] : []),
    executable: false,
  });
  trustedPromotionCandidateRecords.set(record, Object.freeze({
    repository: trustedIdentity.repository, instanceContext, instanceId: trustedIdentity.instanceId,
    indexDigest: indexRead.sha256, sourceDigest: read.sha256, sourceRef: entry.source_ref,
  }));
  return record;
}

export function verifyTrustedPromotionCandidateRecord(repository, record) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { return null; }
  const trust = trustedPromotionCandidateRecords.get(record);
  if (!trust || trust.repository !== repositoryReal || !candidateViewFresh(repository, {
    instanceContext: trust.instanceContext, instanceId: trust.instanceId, indexDigest: trust.indexDigest,
  })) return null;
  try {
    const entry = { id: record.id, source_ref: trust.sourceRef };
    const read = readCandidateSnapshot(repository, entry);
    if (read.sha256 !== trust.sourceDigest) return null;
  } catch { return null; }
  return Object.freeze({ repository: repositoryReal, instanceId: trust.instanceId, instanceContext: trust.instanceContext,
    indexDigest: trust.indexDigest, sourceDigest: trust.sourceDigest });
}

// Maintenance-only identity closure used before a candidate is promoted to a
// formal asset. Candidate IDs remain reserved in active, review and archived
// history; the new formal asset receives its own ID and links back through the
// promotion transaction instead of reusing the source candidate identity.
export function auditFormalIdAgainstCandidateHistory(repository, { instanceContext, proposedFormalId, sourceCandidateId } = {}) {
  const identity = readTrustedInstanceIdentity(repository, instanceContext);
  if (!identity || !stableAssetId.test(proposedFormalId ?? "") || !stableAssetId.test(sourceCandidateId ?? "")
    || proposedFormalId === sourceCandidateId) fail("formal ID is invalid or reuses its source candidate ID");
  const evolutionRoot = dirname(resolveIndex(repository));
  const queue = [evolutionRoot];
  const seenIds = new Set();
  let visited = 0;
  while (queue.length) {
    const directory = queue.shift();
    if (++visited > 1024) fail("candidate history identity scan exceeds its bounded directory budget");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name); const info = lstatSync(path);
      if (info.isSymbolicLink()) fail("candidate history identity scan crosses a link or reparse point");
      if (entry.isDirectory()) { queue.push(path); continue; }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || entry.name.toLowerCase() === "readme.md") continue;
      const read = stableRead(path, 32 * 1024, "candidate history identity source");
      let source;
      try { source = parseMarkdownFrontmatterHead(read.text).values; } catch { fail("candidate history contains invalid frontmatter"); }
      const unresolvedResolution = !Object.hasOwn(source, "resolution") && !Object.hasOwn(source, "resolved_to")
        || ((source.resolution ?? "") === "" && (source.resolved_to ?? "") === "");
      const archivedResolution = candidateResolutions.has(source.resolution)
        && (source.resolution === "rejected" ? (source.resolved_to ?? "") === "" : stableAssetId.test(source.resolved_to ?? ""));
      if (source.kind !== "evolution-candidate" || !stableAssetId.test(source.id ?? "") || !["candidate", "review", "archived"].includes(source.status)
        || Object.keys(source).some((field) => !candidateSourceFields.has(field))
        || locateHighConfidenceSecretCandidates(JSON.stringify(source)).blocked || containsForbiddenStructuredLocation(source)
        || (source.status === "archived" ? !archivedResolution : !unresolvedResolution)) fail("candidate history contains an invalid candidate identity record");
      if (seenIds.has(source.id)) fail("candidate history contains duplicate stable IDs");
      seenIds.add(source.id);
    }
  }
  if (seenIds.has(proposedFormalId)) fail("formal ID collides with candidate history");
  if (!seenIds.has(sourceCandidateId)) fail("source candidate is absent from candidate history");
  return Object.freeze({ decision: "formal-id-available-across-candidate-history", candidateHistoryCount: seenIds.size, executable: false });
}

// Explicit maintenance/transaction audit only. Ordinary learning queries use
// the bounded index and selected sources; they do not enumerate the directory.
export function auditCandidateSourceClosure(repository, { instanceContext } = {}) {
  const identity = readTrustedInstanceIdentity(repository, instanceContext);
  if (!identity) fail("candidate closure audit lacks a trusted instance identity");
  const indexRead = readIndexSnapshot(repository);
  const parsed = parseArrayTableDocument(indexRead.text, "candidates", "candidate index");
  const index = { ...parsed.root, candidates: parsed.entries };
  if (!validateCandidateIndexMetadata(index, { expectedInstanceId: identity.instanceId, actualFileBytes: indexRead.fileBytes })) fail("candidate closure audit found an invalid index");
  const unresolvedRefs = unresolvedCandidateSourceRefs(repository);
  const indexedRefs = new Set(index.candidates.map((entry) => entry.source_ref.toLowerCase()));
  if (unresolvedRefs.size !== indexedRefs.size || [...unresolvedRefs].some((ref) => !indexedRefs.has(ref))) fail("candidate index does not cover every unresolved candidate source exactly once");
  for (const entry of index.candidates) {
    const read = readCandidateSnapshot(repository, entry);
    let parsed;
    try { parsed = parseMarkdownFrontmatterHead(read.text, entry.id); }
    catch { fail("candidate closure audit found invalid source frontmatter"); }
    if (!candidateSourceMatchesEntry(parsed.values, entry)) fail("candidate closure audit found an index/source projection drift");
    const body = read.text.replaceAll("\r\n", "\n").slice(parsed.bodyOffset);
    if (locateHighConfidenceSecretCandidates(body).blocked || containsForbiddenLocationReference(body)) fail("candidate closure audit found secret-bearing or non-portable body content");
  }
  return Object.freeze({ decision: "candidate-source-closure-complete", candidateCount: indexedRefs.size, executable: false });
}

// Explicit snapshot-maintenance projection. It is deliberately separate from
// ordinary candidate retrieval and never exposes source refs, event IDs, paths
// or candidate bodies.
function projectCandidateSnapshotEntry(entry) {
  const sourceSummary = entry.independent_event_count > 0
    ? `宿主已区分出 ${entry.independent_event_count} 次不同任务观察；这只用于安排复核，不代表任务结果已经验证`
    : "现有记录尚无宿主可区分的任务观察，也没有任务结果验证";
  const nextStep = entry.status === "review" || ["conflict", "duplicate", "replace", "uncertain"].includes(entry.candidate_relation)
    ? "先核对冲突、重复关系或建议去向，再决定是否保留"
    : entry.observation_state !== "explicit"
      ? "先用普通语言询问用户是否允许继续观察"
      : ["medium", "high"].includes(entry.risk_tier)
        ? "在下一次合适的真实任务中核验证据，再做一次定向复核并向用户展示完整预览"
        : "在下一次合适的真实任务中继续验证，满足政策后再向用户展示可撤销的保留建议";
  return Object.freeze({
    id: entry.id, title: entry.title, summary: entry.summary, status: entry.status,
    source_summary: sourceSummary, target_kind: entry.target_kind, target_subtype: entry.target_subtype ?? "",
    next_step: nextStep, observation_state: entry.observation_state, observation_basis: entry.observation_basis,
  });
}

export function projectCandidatesForSnapshot(repository, { instanceContext, onSource } = {}) {
  auditCandidateSourceClosure(repository, { instanceContext });
  const identity = readTrustedInstanceIdentity(repository, instanceContext);
  if (!identity) fail("candidate snapshot projection lacks trusted instance identity");
  const indexRead = readIndexSnapshot(repository);
  const parsed = parseArrayTableDocument(indexRead.text, "candidates", "candidate index");
  const index = { ...parsed.root, candidates: parsed.entries };
  if (!validateCandidateIndexMetadata(index, { expectedInstanceId: identity.instanceId, actualFileBytes: indexRead.fileBytes })) fail("candidate snapshot projection found an invalid index");
  return Object.freeze([...index.candidates].sort((left, right) => left.id.localeCompare(right.id, "en")).map((entry) => {
    const read = readCandidateSnapshot(repository, entry);
    const parsedSource = parseMarkdownFrontmatterHead(read.text, entry.id);
    const source = parsedSource.values;
    if (!candidateSourceMatchesEntry(source, entry)) fail("candidate snapshot projection found source drift");
    const body = read.text.replaceAll("\r\n", "\n").slice(parsedSource.bodyOffset);
    if (locateHighConfidenceSecretCandidates(body).blocked || containsForbiddenLocationReference(body)) fail("candidate snapshot projection found unsafe body content");
    onSource?.({asset: source});
    return projectCandidateSnapshotEntry(entry);
  }));
}

export function projectCandidatesForOperationalSnapshot(repository, {
  instanceContext, requiredSourceRefs = new Set(), onIssue = undefined, onSource,
} = {}) {
  if (!(requiredSourceRefs instanceof Set) || typeof onIssue !== "function") fail("operational candidate projection requires bounded isolation controls");
  const identity = readTrustedInstanceIdentity(repository, instanceContext);
  if (!identity) fail("operational candidate projection lacks trusted instance identity");
  const indexRef = "instance/evolution/index.toml";
  let index;
  try {
    const indexRead = readIndexSnapshot(repository);
    const parsed = parseArrayTableDocument(indexRead.text, "candidates", "candidate index");
    index = { ...parsed.root, candidates: parsed.entries };
    if (!validateCandidateIndexMetadata(index, { expectedInstanceId: identity.instanceId, actualFileBytes: indexRead.fileBytes })) throw new Error("invalid candidate index");
  } catch (error) {
    if (requiredSourceRefs.has(indexRef)) throw error;
    onIssue({ area: "evolution", sourceRef: indexRef, code: "candidate-index-uninitialized-or-invalid" });
    index = { candidates: [] };
  }
  const projected = [];
  const indexedRefs = new Set(index.candidates.map((entry) => entry.source_ref.toLowerCase()));
  for (const entry of [...index.candidates].sort((left, right) => left.id.localeCompare(right.id, "en"))) {
    try {
      const read = readCandidateSnapshot(repository, entry);
      const parsedSource = parseMarkdownFrontmatterHead(read.text, entry.id); const source = parsedSource.values;
      if (!candidateSourceMatchesEntry(source, entry)) fail("operational candidate source drift");
      const body = read.text.replaceAll("\r\n", "\n").slice(parsedSource.bodyOffset);
      if (locateHighConfidenceSecretCandidates(body).blocked || containsForbiddenLocationReference(body)) fail("operational candidate body is unsafe");
      projected.push(projectCandidateSnapshotEntry(entry));
      onSource?.({asset: source});
    } catch (error) {
      if (requiredSourceRefs.has(entry.source_ref)) throw error;
      onIssue({ area: "evolution", sourceRef: entry.source_ref, code: "candidate-source-invalid" });
    }
  }
  const repositoryReal = realpathSync(repository); const queue = [dirname(resolveIndex(repository))]; let visited = 0;
  while (queue.length) {
    const directory = queue.shift();
    if (++visited > 512) fail("operational candidate source scan exceeds its directory bound");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name); const info = lstatSync(path);
      if (info.isSymbolicLink()) fail("operational candidate source scan crosses a link or reparse point");
      if (entry.isDirectory()) { if (entry.name.toLowerCase() !== "archive") queue.push(path); continue; }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md") || entry.name.toLowerCase() === "readme.md") continue;
      const sourceRef = relative(repositoryReal, realpathSync(path)).split(sep).join("/").normalize("NFC");
      if (indexedRefs.has(sourceRef.toLowerCase())) continue;
      let unresolved = true;
      try {
        const source = parseMarkdownFrontmatterHead(stableRead(path, 32 * 1024, "operational candidate source").text).values;
        unresolved = source.kind !== "evolution-candidate" || ["candidate", "review"].includes(source.status);
        if (source.kind === "evolution-candidate" && source.status === "archived") unresolved = false;
      } catch { unresolved = true; }
      if (!unresolved) continue;
      if (requiredSourceRefs.has(sourceRef)) fail(`required candidate source ${sourceRef} is not indexed`);
      onIssue({ area: "evolution", sourceRef, code: "candidate-source-unindexed-or-invalid" });
    }
  }
  return Object.freeze(projected);
}
