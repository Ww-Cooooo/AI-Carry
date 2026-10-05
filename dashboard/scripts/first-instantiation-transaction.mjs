import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSectionedToml, stableAssetId, validateInstanceManifestStructure } from "./asset-route-contract.mjs";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";
import { parseCurrentSnapshotEnvelope } from "./snapshot-envelope.mjs";
import { validateSnapshotSemantics } from "./snapshot-semantics.mjs";
import { inspectStartupCapsule, MAX_MANIFEST_BYTES } from "./startup-capsule-contract.mjs";
import { syncStartupCapsule } from "./sync-startup-capsule.mjs";
import { getInstanceWriteLockCleanup, withInstanceWriteLock } from "./instance-write-lock.mjs";

const JOURNAL_REF = ".assistant-local/runtime/first-instantiation.json";
const coreFileLimitBytes = 128 * 1024;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepository = resolve(scriptDirectory, "../..");
const decoder = new TextDecoder("utf-8", { fatal: true });
const requestLimitBytes = 64 * 1024;
const forbiddenControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;
const zonedDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

// First creation owns only the identity and the user's confirmed starting
// route. Empty indexes, host records, signals, governance schedules, Skills
// and Dashboard projections initialize when their capability is first used.
export const firstInstantiationWriteSet = Object.freeze([
  "instance/manifest.toml",
  "instance/profile/approved-profile.md",
  "instance/maps/domain-map.toml",
]);

const requestExample = Object.freeze({
  schema_version: 1,
  guidance_mode: "balanced",
  language: "zh-CN",
  learning_policy: "risk-tiered",
  display_name: "我的助手",
  mission: "一句话说明这个助手长期帮助我完成什么。",
  direction: { type: "domain", domain_id: "", label: "内容研究助手", scope_statement: "帮助研究公开内容并形成可复用的方法。" },
  first_task: {
    title: "完成第一项真实任务", summary: "说明预期结果，但不要写成已经完成。", trigger: "帮我开始第一项任务",
    aliases: [], scope: [], conditions: [], excludes: [], start_after_instantiation: false,
  },
  profile: { in_scope: [], out_of_scope: [], automation: [], privacy: [], learning: [], environment: [], unknowns: [] },
  host: { label: "当前宿主", product_name: "", product_version: "", model_name: "", model_selection_label: "",
    request_model_name: "", model_routing_mode: "unknown", model_observation_basis: [], environment: "",
    observation_basis: "current-session", integration_mode: "direct-workspace", match_hint: "current-host", limitations: [] },
});

function fail(message) { throw new Error("First instantiation failed: " + message); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function q(value) { return JSON.stringify(value); }

function oneLine(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string") fail(label + " must be text");
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if ((!allowEmpty && normalized === "") || normalized.length > maximum || forbiddenControls.test(normalized)) {
    fail(label + " is empty, too long, or contains unsafe control text");
  }
  return normalized;
}

function textList(value, label, maximumItems, maximumLength) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > maximumItems) fail(label + " must be a short text list");
  return Object.freeze(value.map((item, index) => oneLine(item, label + "[" + index + "]", maximumLength)));
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label + " must be an object");
  return value;
}

function collectUnknownKeys(value, allowed, prefix, warnings) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) warnings.push("Ignored unknown request field: " + prefix + key);
}

function stableDerivedId(prefix, preferred, seed, maximum = 64) {
  const normalized = typeof preferred === "string" ? preferred.normalize("NFC").trim().toLowerCase() : "";
  if (normalized && normalized.length <= maximum && stableAssetId.test(normalized)) return normalized;
  const room = Math.max(3, maximum - prefix.length - 1);
  const ascii = seed.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, room);
  return (prefix + "-" + (ascii.length >= 3 ? ascii : hash(Buffer.from(seed, "utf8")).slice(0, 12))).slice(0, maximum);
}

export function normalizeFirstInstantiationRequest(input) {
  const value = objectValue(input, "request");
  const warnings = [];
  collectUnknownKeys(value, new Set(["schema_version", "guidance_mode", "language", "learning_policy", "display_name", "mission", "direction", "first_task", "profile", "host"]), "", warnings);
  if (value.schema_version !== 1) fail("request schema_version must be 1");
  if (!["step-by-step", "balanced", "direct"].includes(value.guidance_mode)) fail("guidance_mode is unsupported");
  const language = value.language ?? "zh-CN";
  const learningPolicy = value.learning_policy ?? "risk-tiered";
  if (!["zh-CN", "en", "en-US"].includes(language)) fail("language is unsupported");
  if (!["risk-tiered", "manual-only"].includes(learningPolicy)) fail("learning_policy is unsupported");

  const directionInput = objectValue(value.direction, "direction");
  collectUnknownKeys(directionInput, new Set(["type", "domain_id", "label", "scope_statement"]), "direction.", warnings);
  if (!["general", "domain"].includes(directionInput.type)) fail("direction.type must be general or domain");
  const directionLabel = oneLine(directionInput.label, "direction.label", 80);
  const directionScope = oneLine(directionInput.scope_statement, "direction.scope_statement", 240);
  const domainId = directionInput.type === "general" ? "" : stableDerivedId("domain", directionInput.domain_id, directionLabel + "\n" + directionScope, 96);

  const taskInput = objectValue(value.first_task, "first_task");
  collectUnknownKeys(taskInput, new Set(["title", "summary", "trigger", "aliases", "scope", "conditions", "excludes", "start_after_instantiation"]), "first_task.", warnings);
  const taskTitle = oneLine(taskInput.title, "first_task.title", 80);
  const taskSummary = oneLine(taskInput.summary, "first_task.summary", 240);
  const taskTrigger = oneLine(taskInput.trigger, "first_task.trigger", 80);
  const startAfterInstantiation = taskInput.start_after_instantiation ?? false;
  if (typeof startAfterInstantiation !== "boolean") fail("first_task.start_after_instantiation must be true or false");
  const taskScope = textList(taskInput.scope, "first_task.scope", 8, 120);
  const taskConditions = textList(taskInput.conditions, "first_task.conditions", 8, 120);
  const taskExcludes = textList(taskInput.excludes, "first_task.excludes", 8, 120);

  const profileInput = value.profile === undefined ? {} : objectValue(value.profile, "profile");
  collectUnknownKeys(profileInput, new Set(["in_scope", "out_of_scope", "automation", "privacy", "learning", "environment", "unknowns"]), "profile.", warnings);
  const profile = Object.freeze({
    inScope: textList(profileInput.in_scope, "profile.in_scope", 12, 240),
    outOfScope: textList(profileInput.out_of_scope, "profile.out_of_scope", 12, 240),
    automation: textList(profileInput.automation, "profile.automation", 12, 240),
    privacy: textList(profileInput.privacy, "profile.privacy", 12, 240),
    learning: textList(profileInput.learning, "profile.learning", 12, 240),
    environment: textList(profileInput.environment, "profile.environment", 12, 240),
    unknowns: textList(profileInput.unknowns, "profile.unknowns", 12, 240),
  });

  // Host facts are preview-only here. A durable host profile is created by the
  // host integration route, not guessed during first creation.
  const hostInput = value.host === undefined ? {} : objectValue(value.host, "host");
  collectUnknownKeys(hostInput, new Set(["label", "product_name", "product_version", "model_name", "model_selection_label", "request_model_name", "model_routing_mode", "model_observation_basis", "environment", "observation_basis", "integration_mode", "match_hint", "limitations"]), "host.", warnings);
  const routingMode = hostInput.model_routing_mode ?? "unknown";
  if (!["manual", "auto", "host-managed", "unknown"].includes(routingMode)) fail("host.model_routing_mode is unsupported");
  const modelBasis = textList(hostInput.model_observation_basis, "host.model_observation_basis", 8, 80);
  const rawModel = oneLine(hostInput.model_name ?? "", "host.model_name", 160, { allowEmpty: true });
  const rawSelection = oneLine(hostInput.model_selection_label ?? "", "host.model_selection_label", 160, { allowEmpty: true });
  const rawRequest = oneLine(hostInput.request_model_name ?? "", "host.request_model_name", 160, { allowEmpty: true });
  const requestVerified = modelBasis.some((item) => ["current-request-metadata", "host-receipt"].includes(item));
  const selectionVerified = modelBasis.some((item) => ["user-visible-selection", "user-stated-selection"].includes(item));
  if ((rawModel || rawRequest) && !requestVerified && !selectionVerified) warnings.push("Ignored an unverified host model name; it remains unknown until host integration can verify it.");
  if (rawSelection && !selectionVerified) warnings.push("Ignored an unverified model selection label.");
  const requestModelName = requestVerified ? (rawRequest || rawModel) : "";
  const modelSelectionLabel = selectionVerified ? (rawSelection || (!requestVerified ? rawModel : "")) : "";
  const host = Object.freeze({
    label: oneLine(hostInput.label ?? "当前宿主", "host.label", 120),
    productName: oneLine(hostInput.product_name ?? "", "host.product_name", 160, { allowEmpty: true }),
    productVersion: oneLine(hostInput.product_version ?? "", "host.product_version", 80, { allowEmpty: true }),
    modelName: requestModelName || modelSelectionLabel,
    modelSelectionLabel,
    requestModelName,
    modelRoutingMode: routingMode,
    modelObservationBasis: modelBasis,
    environment: oneLine(hostInput.environment ?? "", "host.environment", 240, { allowEmpty: true }),
    observationBasis: oneLine(hostInput.observation_basis ?? "current-session", "host.observation_basis", 120),
    integrationMode: oneLine(hostInput.integration_mode ?? "direct-workspace", "host.integration_mode", 120),
    matchHint: oneLine(hostInput.match_hint ?? "current-host", "host.match_hint", 120),
    limitations: textList(hostInput.limitations, "host.limitations", 12, 160),
  });

  const displayName = oneLine(value.display_name, "display_name", 160);
  const mission = oneLine(value.mission, "mission", 512);
  return Object.freeze({
    schemaVersion: 1, guidanceMode: value.guidance_mode, language, learningPolicy, displayName, mission,
    direction: Object.freeze({ type: directionInput.type, domainId, label: directionLabel, scopeStatement: directionScope }),
    firstTask: Object.freeze({
      id: "task-family." + stableDerivedId("task", "", taskTitle + "\n" + taskSummary, 48),
      title: taskTitle, summary: taskSummary, trigger: taskTrigger,
      aliases: textList(taskInput.aliases, "first_task.aliases", 8, 80),
      scope: taskScope.length ? taskScope : Object.freeze([directionScope]),
      conditions: taskConditions.length ? taskConditions : Object.freeze(["真实任务完成后再进入结果验证和资产生命周期"]),
      excludes: taskExcludes.length ? taskExcludes : Object.freeze(["不把尚未执行的任务写成正式资产"]),
      topicKey: stableDerivedId("topic", "", taskTitle + "\n" + taskTrigger, 64),
      subjectKey: directionInput.type === "domain" ? domainId : "general-personal-work",
      startAfterInstantiation,
    }),
    profile, host, warnings: Object.freeze(warnings),
  });
}

function decodeUtf8(bytes, label) {
  try { return decoder.decode(bytes); } catch { fail(label + " is not UTF-8"); }
}

function readRequestFile(path) {
  if (typeof path !== "string" || /^[\s\uFEFF]*[\[{]/u.test(path)) fail("--request-file expects a UTF-8 JSON file path, not pasted JSON text");
  const absolute = resolve(path);
  if (!existsSync(absolute)) fail("request file was not found");
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > requestLimitBytes) fail("request file must be a bounded physical file");
  const source = decodeUtf8(readFileSync(absolute), "request file");
  if (locateHighConfidenceSecretCandidates(source).blocked) fail("request file appears to contain a secret; remove credentials and retry");
  try { return JSON.parse(source); } catch { fail("request file is not valid JSON"); }
}

function canonicalSource(source) { return source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n"); }

function readManifest(root) {
  const source = decodeUtf8(boundedPhysicalBytes(root, "instance/manifest.toml", MAX_MANIFEST_BYTES), "instance manifest");
  const canonical = canonicalSource(source);
  return Object.freeze({ source, canonical, parsed: validateInstanceManifestStructure(parseSectionedToml(canonical, "instance manifest")) });
}

function replaceUnique(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0 || text.indexOf(from, first + from.length) >= 0) fail(label + " replacement is not unique");
  return text.slice(0, first) + to + text.slice(first + from.length);
}

function identityForRequest(testIdentity) {
  const identity = Object.freeze({ instanceId: testIdentity?.instanceId ?? ("ac-" + randomUUID()), createdAt: testIdentity?.createdAt ?? new Date().toISOString() });
  if (!stableAssetId.test(identity.instanceId) || !zonedDate.test(identity.createdAt) || !Number.isFinite(Date.parse(identity.createdAt))) fail("generated instance identity or time is invalid");
  return identity;
}

function manifestSource(templateSource, request, identity) {
  let source = canonicalSource(templateSource);
  for (const [from, to, label] of [
    ['instance_id = "template"', "instance_id = " + q(identity.instanceId), "manifest instance_id"],
    ['state = "template"', 'state = "instance"', "manifest state"],
    ['created_at = ""', "created_at = " + q(identity.createdAt), "manifest created_at"],
    ['type = "unselected"', "type = " + q(request.direction.type), "manifest direction type"],
    ["locked = false", "locked = true", "manifest direction lock"],
    ['domain_id = ""', "domain_id = " + q(request.direction.domainId), "manifest domain_id"],
    ['label = ""', "label = " + q(request.direction.label), "manifest direction label"],
    ['scope_statement = ""', "scope_statement = " + q(request.direction.scopeStatement), "manifest direction scope"],
    ['status = "not-instantiated"', 'status = "active"', "manifest profile status"],
    ['guidance_mode = "unselected"', "guidance_mode = " + q(request.guidanceMode), "manifest guidance mode"],
    ['display_name = ""', "display_name = " + q(request.displayName), "manifest display name"],
    ['mission = ""', "mission = " + q(request.mission), "manifest mission"],
    ['language = "zh-CN"', "language = " + q(request.language), "manifest language"],
    ['user_preferences_ref = "instance/profile/README.md"', 'user_preferences_ref = "instance/profile/approved-profile.md"', "manifest profile ref"],
    ['policy = "risk-tiered"', "policy = " + q(request.learningPolicy), "manifest learning policy"],
  ]) source = replaceUnique(source, from, to, label);
  if (Buffer.byteLength(source, "utf8") > MAX_MANIFEST_BYTES) fail("generated manifest exceeds the startup budget; shorten the direction scope");
  return source;
}

function markdownList(items, emptyText) { return (items.length ? items : [emptyText]).map((item) => "- " + item).join("\n"); }

function approvedProfileSource(request, identity) {
  const english = request.language === "en" || request.language === "en-US";
  return [
    english ? "# Approved instance profile" : "# 已确认实例档案", "",
    "- instance_id: " + identity.instanceId,
    (english ? "- Direction: " : "- 实例方向：") + request.direction.label,
    (english ? "- Collaboration style: " : "- 协作方式：") + request.guidanceMode,
    (english ? "- Mission: " : "- 长期使命：") + request.mission,
    (english ? "- First real task: " : "- 第一项真实任务：") + request.firstTask.title + (english ? ". This task has not started." : "；本任务尚未开始。"),
    "", english ? "## In scope" : "## 范围内", "", markdownList(request.profile.inScope, request.direction.scopeStatement),
    "", english ? "## Out of scope" : "## 范围外", "", markdownList(request.profile.outOfScope, english ? "Use a separate instance outside this direction." : "超出当前方向时建立独立实例。"),
    "", english ? "## Automation and confirmation" : "## 自动化与确认", "", markdownList(request.profile.automation, english ? "Follow current authorization." : "沿用当前任务授权。"),
    "", english ? "## Privacy" : "## 隐私", "", markdownList(request.profile.privacy, english ? "Use task-needed context; credentials never enter model context." : "只使用任务需要的最小上下文；秘密凭据不进入模型上下文。"),
    "", english ? "## Learning" : "## 学习", "", markdownList(request.profile.learning, english ? "Offer reusable learning; formal saving still needs confirmation." : "自然提出可复用学习；正式保存仍需明确确认。"),
    "", english ? "## Environment assumptions" : "## 环境假设", "", markdownList(request.profile.environment, english ? "Unknown host facts stay unknown until needed." : "宿主事实未知时保持未知，需要时再核验。"),
    "", english ? "## Unknowns" : "## 仍未知", "", markdownList(request.profile.unknowns, english ? "None recorded." : "当前没有额外记录。"), "",
  ].join("\n");
}

function domainMapSource(request, identity) {
  return [
    "schema_version = 1", 'map_id = "instance-domain"', "instance_id = " + q(identity.instanceId),
    "direction = " + q(request.direction.type === "domain" ? request.direction.domainId : "general"), 'status = "active"', "",
    "[budget]", "soft_max_bytes = 32768", "hard_max_bytes = 49152", "soft_max_routes = 96", "hard_max_routes = 128", "max_route_bytes = 2048", "candidate_limit = 3", 'overflow_state = "ok"', "",
    "[[routes]]", "id = " + q(request.firstTask.id), "title = " + q(request.firstTask.title), "summary = " + q(request.firstTask.summary),
    "triggers = " + q([request.firstTask.trigger]), 'asset_kind = "task-family"', "topic_key = " + q(request.firstTask.topicKey), "subject_key = " + q(request.firstTask.subjectKey),
    "aliases = " + q(request.firstTask.aliases), "scope = " + q(request.firstTask.scope), "conditions = " + q(request.firstTask.conditions), "excludes = " + q(request.firstTask.excludes),
    "related_asset_ids = []", 'target = "instance/profile/approved-profile.md"', 'state = "on-demand"', "minimum_level = 1", 'confirmation = "none"', "",
  ].join("\n");
}

function buildCoreSources(root, request, identity) {
  return new Map([
    ["instance/manifest.toml", manifestSource(readManifest(root).source, request, identity)],
    ["instance/profile/approved-profile.md", approvedProfileSource(request, identity)],
    ["instance/maps/domain-map.toml", domainMapSource(request, identity)],
  ]);
}

function verifyCoreInMemory(sources, request, identity) {
  const manifest = validateInstanceManifestStructure(parseSectionedToml(sources.get("instance/manifest.toml"), "generated instance manifest"));
  if (manifest.root.instance_id !== identity.instanceId || manifest.root.state !== "instance" || manifest.direction.locked !== true
    || manifest.profile.display_name !== request.displayName || manifest.profile.mission !== request.mission) fail("generated core sources are invalid");
  if (!sources.get("instance/profile/approved-profile.md").includes("instance_id: " + identity.instanceId)) fail("generated profile identity is missing");
  if (!sources.get("instance/maps/domain-map.toml").includes("id = " + q(request.firstTask.id))) fail("generated first task route is missing");
}

function verifyCoreOnDisk(root, request, identity, sources) {
  for (const [ref, expected] of sources) {
    const actual = readFileSync(resolve(root, ...ref.split("/")), "utf8");
    if (actual !== expected || actual.includes("\r") || actual.startsWith("\uFEFF")) fail("core source readback drifted: " + ref);
  }
  verifyCoreInMemory(sources, request, identity);
  return Object.freeze({ core: "current", identityRef: "ac-" + hash(Buffer.from(identity.instanceId, "utf8")).slice(0, 12) });
}

function physicalTarget(root, ref) {
  const target = resolve(root, ...ref.split("/"));
  let cursor = root;
  for (const part of ref.split("/").slice(0, -1)) {
    cursor = resolve(cursor, part);
    const info = lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || info.isReparsePoint?.()) fail("write target parent is unsafe: " + ref);
    const fromRoot = relative(root, realpathSync(cursor));
    if (fromRoot === ".." || fromRoot.startsWith(".." + sep)) fail("write target escapes the repository: " + ref);
  }
  try {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.isReparsePoint?.()) fail("write target is not a physical file: " + ref);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return target;
}

function boundedPhysicalBytes(root, ref, maximum = coreFileLimitBytes, allowMissing = false) {
  const target = physicalTarget(root, ref);
  let fd;
  try { fd = openSync(target, "r"); } catch (error) { if (allowMissing && error.code === "ENOENT") return null; throw error; }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) fail("bounded physical file required: " + ref);
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail("file changed during read: " + ref); offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(target, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()) fail("file changed during read: " + ref);
    return bytes;
  } finally { closeSync(fd); }
}

function freezeCore(root) {
  return new Map(firstInstantiationWriteSet.map((ref) => [ref, boundedPhysicalBytes(root, ref, coreFileLimitBytes, true)]));
}

function sameBytes(left, right) { return left === null ? right === null : right !== null && left.equals(right); }
function verifyFrozenCore(root, frozen) {
  for (const [ref, bytes] of frozen) if (!sameBytes(bytes, boundedPhysicalBytes(root, ref, coreFileLimitBytes, true))) fail("core preimage changed: " + ref);
}

function firstJournal(root, request, sources, frozen, identity) {
  const journal = {
    schema_version: 1, operation_id: randomUUID(), repository_binding: hash(root), request_digest: hash(JSON.stringify(request)), identity,
    files: firstInstantiationWriteSet.map((ref) => ({ ref, before: frozen.get(ref)?.toString("base64") ?? null,
      after: Buffer.from(sources.get(ref), "utf8").toString("base64") })),
  };
  const target = physicalTarget(root, JOURNAL_REF);
  const stage = `${target}.publish-${journal.operation_id}`;
  try {
    writeFileSync(stage, `${JSON.stringify(journal)}\n`, { flag: "wx", mode: 0o600 });
    const fd = openSync(stage, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
    if (existsSync(target)) fail("first creation journal became occupied");
    renameSync(stage, target); // Atomically publish under the shared instance lease before any core write.
  } finally { if (existsSync(stage)) unlinkSync(stage); }
  return journal;
}

function readFirstJournal(root, request) {
  const bytes = boundedPhysicalBytes(root, JOURNAL_REF, 1024 * 1024, true);
  if (!bytes) return null;
  let journal;
  try { journal = JSON.parse(decodeUtf8(bytes, "first creation journal")); } catch { fail("first creation journal is invalid; recovery evidence was preserved"); }
  if (journal.schema_version !== 1 || !/^[a-f0-9-]{36}$/u.test(journal.operation_id ?? "")
    || journal.repository_binding !== hash(root) || journal.request_digest !== hash(JSON.stringify(request))
    || !Array.isArray(journal.files) || journal.files.length !== firstInstantiationWriteSet.length) {
    fail("interrupted first creation must resume the same request and repository; recovery evidence was preserved");
  }
  const identity = identityForRequest(journal.identity);
  const frozen = new Map(); const sources = new Map();
  for (const [index, file] of journal.files.entries()) {
    if (file.ref !== firstInstantiationWriteSet[index]) fail("first creation journal write set is invalid");
    const decodeBase64 = (value) => {
      if (typeof value !== "string" || value.length > 4 * coreFileLimitBytes / 3 + 4) fail("first creation journal bytes are invalid");
      const decoded = Buffer.from(value, "base64");
      if (decoded.toString("base64") !== value || decoded.length > coreFileLimitBytes) fail("first creation journal bytes are invalid");
      return decoded;
    };
    frozen.set(file.ref, file.before === null ? null : decodeBase64(file.before));
    sources.set(file.ref, decodeUtf8(decodeBase64(file.after), "first creation proposed source"));
  }
  if (frozen.get("instance/manifest.toml") === null || frozen.get("instance/profile/approved-profile.md") !== null
    || sources.get("instance/manifest.toml") !== manifestSource(decodeUtf8(frozen.get("instance/manifest.toml"), "template preimage"), request, identity)
    || sources.get("instance/profile/approved-profile.md") !== approvedProfileSource(request, identity)
    || sources.get("instance/maps/domain-map.toml") !== domainMapSource(request, identity)) fail("first creation journal does not match the confirmed request");
  verifyCoreInMemory(sources, request, identity);
  return { journal, sources, frozen, identity };
}

function verifyJournalState(root, journal, sources, frozen) {
  // Validate the entire set before changing anything. External edits, including
  // edits to a not-yet-written target, must survive both resume and rollback.
  for (const [ref, source] of sources) {
    const after = Buffer.from(source, "utf8");
    const current = boundedPhysicalBytes(root, ref, coreFileLimitBytes, true);
    if (!sameBytes(current, frozen.get(ref)) && !sameBytes(current, after)) fail("first creation source changed externally: " + ref);
    const stageRef = `${ref}.ai-carry-stage-${journal.operation_id}`;
    const stage = boundedPhysicalBytes(root, stageRef, coreFileLimitBytes, true);
    if (stage !== null && !sameBytes(stage, frozen.get(ref)) && !sameBytes(stage, after)) fail("first creation stage changed externally: " + ref);
  }
}

function installJournalBytes(root, journal, ref, desired, allowed) {
  const target = physicalTarget(root, ref);
  const current = boundedPhysicalBytes(root, ref, coreFileLimitBytes, true);
  if (!allowed.some((bytes) => sameBytes(bytes, current))) fail("first creation source changed before replacement: " + ref);
  const stageRef = `${ref}.ai-carry-stage-${journal.operation_id}`;
  const stage = physicalTarget(root, stageRef);
  const staged = boundedPhysicalBytes(root, stageRef, coreFileLimitBytes, true);
  if (staged !== null) {
    if (!allowed.some((bytes) => sameBytes(bytes, staged))) fail("first creation stage changed before replacement: " + ref);
    unlinkSync(stage);
  }
  if (sameBytes(current, desired)) return false;
  if (desired === null) { unlinkSync(target); return true; }
  writeFileSync(stage, desired, { flag: "wx", mode: 0o600 });
  const fd = openSync(stage, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
  if (!sameBytes(current, boundedPhysicalBytes(root, ref, coreFileLimitBytes, true))) fail("first creation source changed while staging: " + ref);
  // Replacing a single file is atomic; exact preimages already live in the
  // durable journal, so there is no manifest-missing rename-to-backup window.
  renameSync(stage, target);
  if (!sameBytes(desired, boundedPhysicalBytes(root, ref))) fail("first creation readback changed: " + ref);
  return true;
}

function installCore(root, request, sources, frozen, identity, testFaultAfterInstall, existingJournal = null) {
  if (!existingJournal) verifyFrozenCore(root, frozen);
  const journal = existingJournal ?? firstJournal(root, request, sources, frozen, identity);
  verifyJournalState(root, journal, sources, frozen);
  try {
    let installedCount = 0;
    for (const [ref, source] of sources) {
      const after = Buffer.from(source, "utf8");
      if (installJournalBytes(root, journal, ref, after, [frozen.get(ref), after])) installedCount += 1;
      if (testFaultAfterInstall === installedCount && installedCount > 0) throw new Error("injected-after-core-write-" + installedCount);
    }
    const verification = verifyCoreOnDisk(root, request, identity, sources);
    let cleanupWarning = "";
    try { unlinkSync(physicalTarget(root, JOURNAL_REF)); }
    catch { cleanupWarning = "The committed core is valid; its first-creation recovery receipt remains pending cleanup."; }
    return Object.freeze({ verification, installedCount, cleanupWarning, recovered: existingJournal !== null });
  } catch (error) {
    try {
      verifyJournalState(root, journal, sources, frozen);
      for (const [ref, before] of [...frozen].reverse()) {
        installJournalBytes(root, journal, ref, before, [before, Buffer.from(sources.get(ref), "utf8")]);
      }
      verifyFrozenCore(root, frozen);
      unlinkSync(physicalTarget(root, JOURNAL_REF));
      error.templatePreserved = true;
    } catch (rollbackError) { error.templatePreserved = false; error.rollbackError = rollbackError.message; }
    throw error;
  }
}

function requestMatchesExisting(manifest, request) {
  return manifest.direction.type === request.direction.type && manifest.direction.domain_id === request.direction.domainId
    && manifest.direction.label === request.direction.label && manifest.direction.scope_statement === request.direction.scopeStatement
    && manifest.profile.guidance_mode === request.guidanceMode && manifest.profile.display_name === request.displayName
    && manifest.profile.mission === request.mission && (manifest.profile.language ?? "zh-CN") === request.language
    && manifest.learningPolicy === request.learningPolicy;
}

function inspectSnapshot(root, instanceId) {
  try {
    const publicBytes = readFileSync(resolve(root, "dashboard/public/snapshot.js"));
    const distBytes = readFileSync(resolve(root, "dashboard/dist/snapshot.js"));
    if (!publicBytes.equals(distBytes)) throw new Error("snapshot copies differ");
    const snapshot = parseCurrentSnapshotEnvelope(publicBytes.toString("utf8"), "first-instantiation snapshot");
    validateSnapshotSemantics(snapshot, "first-instantiation snapshot");
    const expected = "ac-" + hash(Buffer.from(instanceId, "utf8")).slice(0, 12);
    if (snapshot.meta.state !== "instance" || snapshot.meta.identity_ref !== expected) throw new Error("snapshot identity is stale");
    return Object.freeze({ decision: "snapshot-current", status: "passed", updated: false, identity_ref: expected });
  } catch (error) { return Object.freeze({ decision: "snapshot-refresh-pending", status: "limited", updated: false, reason: error.message }); }
}

function runSnapshotSync(root) {
  const result = spawnSync(process.execPath, [resolve(root, "dashboard/scripts/sync-snapshot.mjs")], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim() || "snapshot synchronization failed");
  return Object.freeze({ ...JSON.parse(result.stdout.trim()), status: "passed" });
}

function userPreview(request) {
  const english = request.language === "en" || request.language === "en-US";
  const hostFacts = [request.host.productName, request.host.productVersion, request.host.requestModelName || request.host.modelSelectionLabel, request.host.environment].filter(Boolean);
  if (english) return [
    "# Create my AI Carry assistant", "", "- Name: " + request.displayName, "- Direction: " + request.direction.label + " (locked after creation)",
    "- Scope: " + request.direction.scopeStatement, "- Mission: " + request.mission, "- Collaboration: " + request.guidanceMode, "- Learning: " + request.learningPolicy,
    "", "## First real task", "", "- " + request.firstTask.title + ": " + request.firstTask.summary,
    "- It has not run and is not a saved memory, SOP, capability, or validation record.",
    request.firstTask.startAfterInstantiation ? "- Creation continues directly into this task." : "- Ask once after creation whether to begin.",
    "", "## Confirmed boundaries", "", "In scope:\n" + markdownList(request.profile.inScope, request.direction.scopeStatement),
    "Out of scope:\n" + markdownList(request.profile.outOfScope, "No extra boundary recorded."),
    "Privacy:\n" + markdownList(request.profile.privacy, "Use task-needed context; credentials never enter model context."),
    "Learning:\n" + markdownList(request.profile.learning, "Offer reusable learning; save formal assets only after confirmation."),
    "", "## Current host facts", "", markdownList(hostFacts, "Unknown host facts stay unknown until needed."),
    "", "## What this confirmation changes", "", "- Atomically writes only the instance identity, approved profile, and first task route.",
    "- Startup capsule, Dashboard and optional registries refresh separately; a local failure is reported and can be retried without undoing the assistant.",
    "- No memory, SOP, capability, validation, Skill, component, host profile, signal or governance schedule is invented in advance.",
    "", "If this is accurate, explicitly confirm the complete preview. You may correct any line first.",
  ].join("\n");
  return [
    "# 创建我的 AI Carry 助手", "", "- 名称：" + request.displayName, "- 方向：" + request.direction.label + "（创建后锁定）",
    "- 范围：" + request.direction.scopeStatement, "- 长期使命：" + request.mission, "- 交流方式：" + request.guidanceMode, "- 学习政策：" + request.learningPolicy,
    "", "## 第一项真实任务", "", "- " + request.firstTask.title + "：" + request.firstTask.summary,
    "- 它尚未执行，也没有被写成记忆、SOP、能力或验证记录。",
    request.firstTask.startAfterInstantiation ? "- 创建成功后直接进入这项任务，不重复询问。" : "- 创建后只询问一次是否开始。",
    "", "## 已确认边界", "", "范围内：\n" + markdownList(request.profile.inScope, request.direction.scopeStatement),
    "范围外：\n" + markdownList(request.profile.outOfScope, "当前没有补充边界。"),
    "隐私：\n" + markdownList(request.profile.privacy, "只使用任务需要的最小上下文；秘密凭据不进入模型上下文。"),
    "学习：\n" + markdownList(request.profile.learning, "自然提出可复用学习；正式保存仍需明确确认。"),
    "", "## 当前宿主事实", "", markdownList(hostFacts, "未知的宿主事实保持未知，需要时再核验。"),
    "", "## 本次确认会写入什么", "", "- 原子写入实例身份、已确认档案和第一项任务路线三项核心内容。",
    "- 启动胶囊、看板和可选登记表分开刷新；局部失败会说明并允许重试，不撤销已经可用的助手。",
    "- 不预造记忆、SOP、能力、验证、Skill、组件、宿主档案、信号或治理排期。",
    "", "如果以上准确，请明确确认完整预览；任何一行不对都可以先修改。",
  ].join("\n");
}

function inspectTemplate(root, manifest) {
  if (manifest.parsed.root.state !== "template" || manifest.parsed.root.instance_id !== "template") fail("target is not an uninstantiated template");
  if (existsSync(resolve(root, "instance/profile/approved-profile.md"))) fail("template already contains an approved instance profile");
  const notices = [];
  if (manifest.source !== manifest.canonical) notices.push("manifest line endings will be normalized during the core write");
  if (inspectStartupCapsule(root).decision !== "startup-capsule-valid") notices.push("startup capsule is stale and will be refreshed after core creation");
  return Object.freeze(notices);
}

function previewManifestBytes(root, request) {
  const identity = { instanceId: "ac-00000000-0000-4000-8000-000000000000", createdAt: "2000-01-01T00:00:00.000Z" };
  return Buffer.byteLength(manifestSource(readManifest(root).source, request, identity), "utf8");
}

export function inspectFirstInstantiationRequest(repository, input) {
  const root = realpathSync(repository);
  const request = normalizeFirstInstantiationRequest(input);
  if (existsSync(resolve(root, JOURNAL_REF))) {
    const pending = readFirstJournal(root, request);
    verifyJournalState(root, pending.journal, pending.sources, pending.frozen);
    return Object.freeze({ decision: "first-instantiation-recovery-ready", status: "limited", executable: false,
      user_report: { summary: "上次首次创建被中断，原确认内容和恢复记录仍在；本次只读检查没有改动文件。",
        next_step: "复用同一份已确认请求执行首次创建入口，它会只完成这次被中断的核心事务；不要重建或删除现场。" } });
  }
  const manifest = readManifest(root);
  if (manifest.parsed.root.state !== "template") return Object.freeze({ decision: "first-instantiation-not-applicable", status: "unchanged", reason: "target-is-already-an-instance", executable: false,
    user_report: { summary: "当前 AI Carry 已经是正式实例，本次没有重做首次创建。", next_step: "继续使用当前实例；另一个方向请从干净模板建立独立实例。" } });
  const notices = inspectTemplate(root, manifest);
  return Object.freeze({ decision: "first-instantiation-request-valid", status: "ready", executable: false,
    direction: request.direction.type, display_name: request.displayName, first_task: request.firstTask.title,
    write_target_count: firstInstantiationWriteSet.length, manifest_bytes: previewManifestBytes(root, request), manifest_limit: MAX_MANIFEST_BYTES,
    user_preview: userPreview(request), notices, warnings: request.warnings,
    user_report: { summary: "创建请求已通过本地检查；模板尚未改动。", next_step: "展示完整预览并得到明确确认后，再执行同一请求。" } });
}

function commitFirstInstantiationCore(root, request, { testIdentity, testFaultAfterInstall }) {
  const resumed = readFirstJournal(root, request);
  if (resumed) {
    const { sources, frozen, identity, journal } = resumed;
    const installed = installCore(root, request, sources, frozen, identity, testFaultAfterInstall, journal);
    return { identity, installed, notices: Object.freeze(["interrupted first creation resumed from its bound exact-byte journal"]) };
  }
  const manifest = readManifest(root);
  if (manifest.parsed.root.state === "instance") {
    if (!requestMatchesExisting(manifest.parsed, request)) return Object.freeze({ decision: "first-instantiation-not-applicable", status: "unchanged", reason: "existing-instance-does-not-match-request", updated: false, executable: false,
      user_report: { summary: "当前目录已经是另一份正式实例，本次没有覆盖或重做。", next_step: "继续当前实例，或从干净模板创建另一个实例。" } });
    const identity = { instanceId: manifest.parsed.root.instance_id, createdAt: manifest.parsed.root.created_at };
    const profilePath = resolve(root, "instance/profile/approved-profile.md");
    if (!existsSync(profilePath) || readFileSync(profilePath, "utf8") !== approvedProfileSource(request, identity)) return Object.freeze({ decision: "first-instantiation-not-applicable", status: "unchanged", reason: "existing-instance-has-evolved", updated: false, executable: false,
      user_report: { summary: "当前实例已有后续变化，本次没有把它重置。", next_step: "继续普通使用或升级，不要重跑首次创建。" } });
    const capsule = inspectStartupCapsule(root);
    const snapshot = inspectSnapshot(root, identity.instanceId);
    const pending = [];
    if (capsule.decision !== "startup-capsule-valid") pending.push("startup-capsule");
    if (snapshot.decision !== "snapshot-current") pending.push("dashboard-snapshot");
    return Object.freeze({ decision: "first-instantiation-current", status: pending.length ? "limited" : "passed", updated: false,
      instance_id: identity.instanceId, created_at: identity.createdAt, auxiliary_pending: Object.freeze(pending),
      capsuleResult: { decision: capsule.decision, updated: false }, snapshotResult: snapshot, executable: false,
      user_report: { summary: pending.length ? "同一份创建请求已经生效；可选投影稍后可单独刷新，不影响继续使用。" : "同一份创建请求已经生效；第二次执行没有改动任何文件。", next_step: "直接开始第一项真实任务。" } });
  }

  const notices = inspectTemplate(root, manifest);
  previewManifestBytes(root, request);
  const identity = identityForRequest(testIdentity);
  const sources = buildCoreSources(root, request, identity);
  verifyCoreInMemory(sources, request, identity);
  const frozen = freezeCore(root);
  const installed = installCore(root, request, sources, frozen, identity, testFaultAfterInstall);
  return { identity, installed, notices };
}

export function executeFirstInstantiation(repository, input, { testIdentity, testFaultAfterCapsule = false, testFaultAfterInstall = 0, testFaultBeforeSnapshot = false } = {}) {
  const root = realpathSync(repository);
  const request = normalizeFirstInstantiationRequest(input);
  let core;
  try {
    core = withInstanceWriteLock(root, "first-instantiation-core",
      () => commitFirstInstantiationCore(root, request, { testIdentity, testFaultAfterInstall }));
  } catch (error) {
    if (existsSync(resolve(root, JOURNAL_REF)) && error.templatePreserved !== true) error.templatePreserved = false;
    throw error;
  }
  if (core.decision) return core;
  const { identity, installed, notices } = core;

  // Child-process snapshot synchronization is deliberately outside the core
  // lease; it acquires the same instance lock in its own process.
  const pending = [];
  let capsuleResult;
  try {
    if (testFaultAfterCapsule) throw new Error("injected-capsule-refresh-failure");
    capsuleResult = withInstanceWriteLock(root, "first-instantiation-capsule", () => syncStartupCapsule(root, { write: true }));
    if (!["startup-capsule-updated", "startup-capsule-current"].includes(capsuleResult.decision)) throw new Error("unexpected startup capsule result");
  } catch (error) {
    pending.push("startup-capsule");
    capsuleResult = { decision: "startup-capsule-refresh-pending", status: "limited", updated: false, reason: error.message };
  }

  let snapshotResult;
  try {
    if (testFaultBeforeSnapshot) throw new Error("injected-snapshot-refresh-failure");
    snapshotResult = runSnapshotSync(root);
    const readback = inspectSnapshot(root, identity.instanceId);
    if (readback.decision !== "snapshot-current") throw new Error(readback.reason ?? "snapshot readback failed");
  } catch (error) {
    pending.push("dashboard-snapshot");
    snapshotResult = { decision: "snapshot-refresh-pending", status: "limited", updated: false, reason: error.message };
  }

  return Object.freeze({ decision: "first-instantiation-complete", status: pending.length ? "limited" : "passed", updated: true,
    instance_id: identity.instanceId, created_at: identity.createdAt, identity_ref: installed.verification.identityRef,
    write_target_count: firstInstantiationWriteSet.length, notices, warnings: request.warnings, cleanup_warning: installed.cleanupWarning,
    recovered_interrupted_creation: installed.recovered,
    ...(getInstanceWriteLockCleanup(core) ? { instanceWriteLockCleanup: getInstanceWriteLockCleanup(core) } : {}),
    auxiliary_pending: Object.freeze(pending), capsuleResult, snapshotResult,
    verification: Object.freeze({ ...installed.verification, capsule: pending.includes("startup-capsule") ? "pending" : "current", snapshot: pending.includes("dashboard-snapshot") ? "pending" : "current" }),
    executable: false,
    user_report: { summary: pending.length ? "助手核心已经创建成功；列出的可选投影稍后可单独重试，不影响对话和第一项任务。" : "助手已经创建并完成可选投影刷新。",
      next_step: request.firstTask.startAfterInstantiation ? "按已确认选择直接进入第一项真实任务；不要再次询问。" : "询问用户是否现在开始第一项真实任务。" } });
}

const cliHelp = [
  "AI Carry first instantiation", "", "1. Save the compact request JSON as a UTF-8 file (maximum 64 KiB).",
  "2. Inspect without writing:", '   node dashboard/scripts/first-instantiation-transaction.mjs --root "<AI Carry root>" --request-file "<request.json>"',
  "3. Show user_preview and wait for explicit confirmation.", "4. Write the same request:",
  '   node dashboard/scripts/first-instantiation-transaction.mjs --root "<AI Carry root>" --request-file "<request.json>" --write --acknowledge-complete-preview',
  "", "Use --example to print the JSON field shape. Do not paste JSON as a command argument.",
].join("\n");

function parseCli(argumentsList) {
  const result = { root: defaultRepository, requestFile: "", write: false, acknowledged: false, example: false, help: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--root") result.root = argumentsList[++index] ?? "";
    else if (argument === "--request-file" || argument === "--request") result.requestFile = argumentsList[++index] ?? "";
    else if (argument === "--write") result.write = true;
    else if (argument === "--acknowledge-complete-preview") result.acknowledged = true;
    else if (argument === "--example") result.example = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else fail("unknown command argument; run --help");
  }
  if (!result.example && !result.help && (!result.root || !result.requestFile)) fail("--root and --request-file are required");
  return result;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const cli = parseCli(process.argv.slice(2));
    if (cli.help) process.stdout.write(cliHelp + "\n");
    else if (cli.example) process.stdout.write(JSON.stringify(requestExample, null, 2) + "\n");
    else {
      const request = readRequestFile(cli.requestFile);
      if (!cli.write) process.stdout.write(JSON.stringify(inspectFirstInstantiationRequest(cli.root, request)) + "\n");
      else {
        if (!cli.acknowledged) fail("--write requires --acknowledge-complete-preview");
        process.stdout.write(JSON.stringify(executeFirstInstantiation(cli.root, request)) + "\n");
      }
    }
  } catch (error) {
    const templateState = error?.templatePreserved === true ? "verified-preserved"
      : error?.templatePreserved === false ? "needs-targeted-review" : "unchanged-or-not-written";
    process.stderr.write(JSON.stringify({
      decision: "first-instantiation-failed",
      status: "limited",
      executable: false,
      affected_scope: "current-first-creation",
      ordinary_work_allowed: true,
      reason: String(error?.message ?? error).slice(0, 480),
      template_state: templateState,
      user_report: {
        summary: templateState === "verified-preserved"
          ? "这次创建没有完成，模板核心已经核对为操作前状态；普通对话仍可继续。"
          : templateState === "needs-targeted-review"
            ? "这次创建没有被当作完成，恢复现场已保留；先只检查这次创建的三个核心文件，普通对话仍可继续。"
            : "这次创建没有开始或没有完成；当前错误只影响首次创建，普通对话仍可继续。",
        next_step: templateState === "needs-targeted-review"
          ? "让 Agent 只读核对 manifest、正式档案和初始任务路线，再决定重试或恢复；不要删除现场。"
          : "按上面的具体原因修正这一项后，复用原选择重新预览；不需要重装整个 AI Carry。",
      },
    }) + "\n");
    process.exitCode = 1;
  }
}
