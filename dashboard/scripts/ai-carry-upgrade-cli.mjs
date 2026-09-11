#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSectionedToml, validateInstanceManifestStructure } from "./asset-route-contract.mjs";
import { PRODUCT_IDENTITY, LEGACY_PRODUCT_IDENTITY } from "./product-identity.mjs";
import { parseCurrentSnapshotEnvelope } from "./snapshot-envelope.mjs";
import { validateSnapshotSemantics } from "./snapshot-semantics.mjs";
import { inspectStartupCapsule } from "./startup-capsule-contract.mjs";
import { syncStartupCapsule } from "./sync-startup-capsule.mjs";
import {
  AUTHORITY_FINGERPRINT_SCHEMA,
  OFFICIAL_RELEASE_REQUEST_BUDGET,
  officialAuthorityFingerprint,
} from "./verify-official-ai-carry-release.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(moduleDirectory, "..", "..");
const runtimeAssistant = parseSectionedToml(readFileSync(resolve(runtimeRoot, "assistant.toml"), "utf8"), "runtime assistant manifest");
const runtimeAssistantRoot = runtimeAssistant[""] ?? {};
const TARGET_VERSION = runtimeAssistantRoot.product_version;
const runtimeReleaseRef = runtimeAssistant.maintenance?.release_manifest;
if (typeof TARGET_VERSION !== "string" || !/^\d+\.\d+\.\d+$/u.test(TARGET_VERSION)
  || runtimeReleaseRef !== `core/upgrade/release-manifest-${TARGET_VERSION}.toml`) {
  throw new Error("AI Carry upgrade failed: assistant manifest does not identify one current release manifest");
}
const runtimeReleaseSource = readFileSync(resolve(runtimeRoot, ...runtimeReleaseRef.split("/")), "utf8");
const runtimeReleaseRoot = runtimeReleaseSource.split(/^\[/mu, 1)[0];
const runtimeReleaseVersion = /^release\s*=\s*"([^"]+)"\s*$/mu.exec(runtimeReleaseRoot)?.[1];
const directSourceLiteral = /^from_versions\s*=\s*(\[[^\n]+\])\s*$/mu.exec(runtimeReleaseRoot)?.[1];
let directSourceVersions;
try { directSourceVersions = JSON.parse(directSourceLiteral ?? "null"); } catch { directSourceVersions = null; }
if (runtimeReleaseVersion !== TARGET_VERSION || !Array.isArray(directSourceVersions)
  || directSourceVersions.some((value) => typeof value !== "string" || !/^\d+\.\d+\.\d+$/u.test(value))) {
  throw new Error("AI Carry upgrade failed: current release manifest does not match the assistant version");
}
const DIRECT_SOURCE_VERSIONS = new Set(directSourceVersions);
const MAX_TARGET_FILES = 8192;
const MAX_TARGET_BYTES = 1024 * 1024 * 1024;
const MAX_OPERATION_ATTEMPTS = 32;
const releaseVerifierPath = resolve(moduleDirectory, "verify-official-ai-carry-release.mjs");
const snapshotPaths = new Set(["dashboard/public/snapshot.js", "dashboard/dist/snapshot.js"]);
const windowsMetadataPreflightPath = resolve(moduleDirectory, "windows-upgrade-metadata-preflight.ps1");
const confirmationPattern = /^ai-carry-upgrade\.([a-f0-9]{32})~([a-f0-9]{32})~([1-9][0-9]{0,2})$/u;
const acceptedConfirmationReplies = new Set(["升级", "确认升级"]);
const exactInstanceGuides = Object.freeze([
  "instance/profile/README.md",
  "instance/memory/README.md",
  "instance/capabilities/README.md",
  "instance/sops/README.md",
  "instance/experiences/README.md",
  "instance/evolution/README.md",
  "instance/todo/README.md",
  "instance/deferred/README.md",
  "instance/governance/README.md",
  "instance/signals/README.md",
  "instance/hosts/README.md",
  "instance/validations/README.md",
  "instance/components/README.md",
]);
const legacyProfileRef = "instance/profile/README.md";
const approvedProfileRef = "instance/profile/approved-profile.md";
const memoryGovernanceRef = "instance/governance/memory-governance-card.md";
const noGovernanceBrandMigration = Object.freeze({ required: false, sourceSha256: "", migratedSha256: "" });
const legacyProductDisplayName = LEGACY_PRODUCT_IDENTITY.productNames[0];
const memoryGovernanceBrandPhrases = Object.freeze([
  Object.freeze([
    `周期性研究更适合 ${legacyProductDisplayName} 的记忆、检索与自我进化技术。`,
    "周期性研究更适合 AI Carry 的记忆、检索与自我进化技术。",
  ]),
  Object.freeze([
    `寻找比现有方案更适合 ${legacyProductDisplayName} 的记忆治理方式`,
    "寻找比现有方案更适合 AI Carry 的记忆治理方式",
  ]),
]);

function fail(message) { throw new Error(`AI Carry upgrade failed: ${message}`); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function normalizeRef(path) { return path.split(sep).join("/"); }
function q(value) { return JSON.stringify(value); }

export function validateUpgradeRuntimeContract(releaseManifestSource, actions) {
  if (!releaseManifestSource.includes('required_preview_executor = "dashboard/scripts/ai-carry-upgrade-cli.mjs"')) {
    fail("target release manifest does not bind the official preview executor");
  }
  const upgradeAction = Array.isArray(actions) ? actions.find((item) => item?.action_id === "instance.upgrade-template") : null;
  if (!upgradeAction || upgradeAction.label !== "检查并升级 AI Carry"
    || upgradeAction.routeId !== "template-upgrade"
    || upgradeAction.target !== "core/guides/upgrade-guide.md"
    || !upgradeAction.request?.includes("confirmCommand")
    || !upgradeAction.request?.includes("会话采用")
    || !upgradeAction.request?.includes("代表行为")) {
    fail("session reentry representative AI Carry upgrade behavior is unavailable");
  }
  return upgradeAction;
}

function resolvePhysicalDirectory(path, label) {
  const absolute = resolve(path);
  let original;
  try { original = lstatSync(absolute); } catch { fail(`${label} does not exist`); }
  if (!original.isDirectory() || original.isSymbolicLink() || original.isReparsePoint?.()) {
    fail(`${label} is not a direct physical directory`);
  }
  let physical;
  try { physical = realpathSync(absolute); } catch { fail(`${label} does not exist`); }
  const info = lstatSync(physical);
  if (!info.isDirectory() || info.isSymbolicLink() || info.isReparsePoint?.()) fail(`${label} is not a physical directory`);
  return physical;
}

export function pathIsInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function readUtf8(path, label, maximum = 512 * 1024) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.isReparsePoint?.() || info.size > maximum) fail(`${label} is not a bounded regular file`);
  const bytes = readFileSync(path);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(`${label} is not UTF-8`); }
  if (text.startsWith("\uFEFF") || text.includes("\r")) fail(`${label} must be UTF-8 without BOM and use LF`);
  return text;
}

function walkTree(root, { maxFiles = MAX_TARGET_FILES, maxBytes = MAX_TARGET_BYTES, label = "tree" } = {}) {
  const files = [];
  let totalBytes = 0;
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = resolve(directory, name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink() || info.isReparsePoint?.()) fail(`tree contains a link: ${normalizeRef(relative(root, absolute))}`);
      if (info.isDirectory()) visit(absolute);
      else if (info.isFile()) {
        if (info.nlink > 1) fail(`${label} contains a hardlink: ${normalizeRef(relative(root, absolute))}`);
        totalBytes += info.size;
        if (files.length >= maxFiles || totalBytes > maxBytes) fail(`${label} exceeds the bounded upgrade budget`);
        const bytes = readFileSync(absolute);
        files.push(Object.freeze({ path: normalizeRef(relative(root, absolute)), bytes: bytes.length, sha256: sha256(bytes) }));
      } else fail(`tree contains a non-file entry: ${normalizeRef(relative(root, absolute))}`);
    }
  };
  visit(root);
  const fingerprint = sha256(Buffer.from(files.map((item) => `${item.path}\0${item.bytes}\0${item.sha256}\n`).join(""), "utf8"));
  return Object.freeze({ files: Object.freeze(files), fileCount: files.length, totalBytes, fingerprint });
}

function manifestIdentity(root, label, { allowLegacyProfileReadme = false } = {}) {
  const source = readUtf8(resolve(root, "instance/manifest.toml"), `${label} instance manifest`, 2560);
  const parsed = parseSectionedToml(source, `${label} instance manifest`);
  const validated = validateInstanceManifestStructure(parsed, { allowUnknownFields: true, allowLegacyProfileReadme });
  const version = parsed.versions?.product;
  if (typeof version !== "string") fail(`${label} instance product version is missing`);
  return Object.freeze({ source, parsed, validated, version, instanceId: validated.root.instance_id, state: validated.root.state });
}

function assistantIdentity(root, label) {
  const source = readUtf8(resolve(root, "assistant.toml"), `${label} assistant manifest`, 64 * 1024);
  const parsed = parseSectionedToml(source, `${label} assistant manifest`);
  const values = parsed[""] ?? {};
  return Object.freeze({ source, parsed, productId: values.product_id, productName: values.product_name, version: values.product_version });
}

const acceptedPublicGitOrigins = new Set([
  "https://github.com/Ww-Cooooo/AI-Carry",
  "https://github.com/Ww-Cooooo/AI-Carry.git",
  "git@github.com:Ww-Cooooo/AI-Carry.git",
  "ssh://git@github.com/Ww-Cooooo/AI-Carry.git",
  "https://github.com/Ww-Cooooo/Agent-Carry",
  "https://github.com/Ww-Cooooo/Agent-Carry.git",
  "git@github.com:Ww-Cooooo/Agent-Carry.git",
  "ssh://git@github.com/Ww-Cooooo/Agent-Carry.git",
]);

export function inspectInstalledSourceLayout(source) {
  // A pure release package and an installed assistant have different owners.
  // Local plans, host overrides and installed tools stay outside the product
  // write set; their presence says nothing about the assistant's identity.
  if (existsSync(resolve(source, "maintainer-private"))) {
    fail("source contains maintainer-private and is a maintainer tree; choose the installed assistant as the upgrade source, without deleting or moving this directory");
  }
  const gitRoot = resolve(source, ".git");
  if (!existsSync(gitRoot)) return Object.freeze({ kind: "archive-install", embeddedGit: false });
  const gitInfo = lstatSync(gitRoot);
  if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink() || gitInfo.isReparsePoint?.()) {
    fail("embedded Git metadata is not a direct physical public-clone directory");
  }
  const configPath = resolve(gitRoot, "config");
  const configInfo = lstatSync(configPath);
  if (!configInfo.isFile() || configInfo.isSymbolicLink() || configInfo.isReparsePoint?.() || configInfo.size > 64 * 1024) {
    fail("embedded Git source identity is unavailable");
  }
  let config;
  try { config = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(configPath)); }
  catch { fail("embedded Git source identity is unreadable"); }
  const originSection = /\[remote\s+"origin"\]([\s\S]*?)(?=\n\s*\[|$)/u.exec(config.replaceAll("\r\n", "\n"));
  const origin = /^\s*url\s*=\s*(\S+)\s*$/mu.exec(originSection?.[1] ?? "")?.[1] ?? "";
  if (!acceptedPublicGitOrigins.has(origin)) fail("embedded Git source is not the official public AI Carry repository");
  return Object.freeze({ kind: "official-public-clone-install", embeddedGit: true });
}

function validateSource(source) {
  const sourceLayout = inspectInstalledSourceLayout(source);
  const assistant = assistantIdentity(source, "source");
  const acceptedIds = new Set([PRODUCT_IDENTITY.productId, ...LEGACY_PRODUCT_IDENTITY.productIds]);
  if (!acceptedIds.has(assistant.productId)) fail("source product identity is not recognized");
  const instance = manifestIdentity(source, "source", { allowLegacyProfileReadme: true });
  if (assistant.version !== instance.version) fail("source assistant and instance versions disagree");
  if (instance.version === TARGET_VERSION && assistant.productId === PRODUCT_IDENTITY.productId) {
    validateInstalledCurrentCore(source, instance);
    return Object.freeze({ assistant, instance, sourceLayout, alreadyCurrent: true,
      snapshotHealth: inspectInstalledSnapshot(source, instance) });
  }
  if (!DIRECT_SOURCE_VERSIONS.has(instance.version)) fail(`source version ${instance.version} is not a direct ${TARGET_VERSION} source`);
  return Object.freeze({ assistant, instance, sourceLayout, alreadyCurrent: false });
}

function validateInstalledCurrentCore(source, instance) {
  if (instance.validated.legacyProfileMigrationRequired) fail("current AI Carry still uses the legacy profile README as user content");
  if (inspectStartupCapsule(source).decision !== "startup-capsule-valid") fail("current AI Carry startup capsule is invalid");
  const capsule = parseSectionedToml(readUtf8(resolve(source, "instance/startup-capsule.toml"), "current AI Carry startup capsule", 16 * 1024), "current AI Carry startup capsule")[""] ?? {};
  const core = parseSectionedToml(readUtf8(resolve(source, "core/manifest.toml"), "current AI Carry core manifest", 64 * 1024), "current AI Carry core manifest")[""] ?? {};
  if (capsule.capsule_id !== PRODUCT_IDENTITY.startupCapsuleId || capsule.product_version !== TARGET_VERSION
    || capsule.instance_id !== instance.instanceId || core.core_id !== PRODUCT_IDENTITY.coreId || core.version !== TARGET_VERSION) {
    fail("current AI Carry startup or core product identity is incomplete");
  }
}

function inspectInstalledSnapshot(source, instance) {
  try {
    const publicBytes = readFileSync(resolve(source, "dashboard/public/snapshot.js"));
    const distBytes = readFileSync(resolve(source, "dashboard/dist/snapshot.js"));
    if (!publicBytes.equals(distBytes)) fail("current AI Carry snapshot pair differs");
    const snapshot = parseCurrentSnapshotEnvelope(publicBytes.toString("utf8"), "current AI Carry snapshot");
    validateSnapshotSemantics(snapshot, "current AI Carry snapshot");
    if (snapshot.overview?.product !== PRODUCT_IDENTITY.productName
      || snapshot.meta?.product_version !== TARGET_VERSION
      || snapshot.meta?.identity_ref !== (instance.state === "template" ? "template" : `ac-${sha256(Buffer.from(instance.instanceId, "utf8")).slice(0, 12)}`)) {
      fail("current AI Carry snapshot identity is incomplete");
    }
    return Object.freeze({ snapshotState: "current", snapshotWarning: "" });
  } catch (error) {
    // Report the cache failure separately; it cannot veto a valid new core or
    // the current conversation's adoption of that core. No repair is implied.
    return Object.freeze({ snapshotState: "pending", snapshotWarning: String(error?.message ?? error).slice(0, 500),
      snapshotRefreshCommand: `node ${q(resolve(source, "dashboard/scripts/sync-snapshot.mjs"))} ${q(source)}` });
  }
}

function releaseBoundaryFrom(source) {
  const start = source.indexOf("[release_boundary]");
  if (start < 0) fail("target release manifest lacks release_boundary");
  const tail = source.slice(start);
  const next = tail.slice("[release_boundary]".length).search(/^\[/mu);
  const section = next < 0 ? tail : tail.slice(0, "[release_boundary]".length + next);
  const parsed = parseSectionedToml(section, "target release boundary").release_boundary ?? {};
  if (parsed.status !== "published-release" || parsed.release_ref !== `v${TARGET_VERSION}`
    || parsed.publication_authorized !== true || parsed.instance_replacement_authorized !== true) {
    fail("target release boundary does not authorize published instance replacement");
  }
  return Object.freeze(parsed);
}

function validReleasePattern(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.includes("\\") || pattern.startsWith("/")
    || pattern.includes(":") || pattern.includes("?") || pattern.includes("#")) return false;
  const base = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
  return base.length > 0 && !base.includes("*") && base.split("/").every((part) => part && part !== "." && part !== "..");
}

function releasePathPolicyFrom(source) {
  const rulesStart = source.indexOf("[[migration_rules]]");
  if (rulesStart < 0) fail("target release manifest lacks migration rules");
  const parsed = parseSectionedToml(source.slice(0, rulesStart), "target release path policy");
  const root = parsed[""] ?? {};
  const classification = parsed.classification ?? {};
  const selection = parsed.target_selection ?? {};
  const lists = Object.freeze({
    replace: root.replace,
    replace_instance_guides: root.replace_instance_guides,
    migrate: root.migrate,
    preserve: root.preserve,
    remove: root.remove,
  });
  for (const [name, patterns] of Object.entries(lists)) {
    if (!Array.isArray(patterns) || new Set(patterns).size !== patterns.length || patterns.some((pattern) => !validReleasePattern(pattern))) {
      fail(`target release manifest ${name} classification is invalid`);
    }
  }
  if (JSON.stringify(lists.replace_instance_guides) !== JSON.stringify(exactInstanceGuides)) {
    fail("target release manifest instance guide classification drifted");
  }
  const expectedPrecedence = ["migration_rules", "replace_instance_guides", "migrate", "preserve", "replace", "remove"];
  if (JSON.stringify(classification.precedence) !== JSON.stringify(expectedPrecedence)
    || classification.overlap_policy !== "first-matching-classification-wins-after-applicable-migration-rules; every selected path must resolve to exactly one effective action"
    || selection.forbid_unlisted_files !== true
    || selection.broad_globs_are_copy_commands !== false
    || !Array.isArray(selection.forbidden_segments)
    || !Array.isArray(selection.allow_overrides_deny_for_exact_paths)
    || new Set(selection.forbidden_segments).size !== selection.forbidden_segments.length
    || new Set(selection.allow_overrides_deny_for_exact_paths).size !== selection.allow_overrides_deny_for_exact_paths.length
    || selection.forbidden_segments.some((segment) => typeof segment !== "string" || !segment || segment.includes("/") || segment === "." || segment === "..")
    || selection.allow_overrides_deny_for_exact_paths.some((path) => !validReleasePattern(path) || path.endsWith("/**"))) {
    fail("target release manifest path-selection policy is invalid");
  }
  return Object.freeze({
    lists,
    precedence: Object.freeze(expectedPrecedence.filter((name) => name !== "migration_rules")),
    forbiddenSegments: new Set(selection.forbidden_segments),
    exactZeroByteOverrides: new Set(selection.allow_overrides_deny_for_exact_paths),
  });
}

function pathMatchesReleasePattern(path, pattern) {
  if (!pattern.endsWith("/**")) return path === pattern;
  const root = pattern.slice(0, -3);
  return path === root || path.startsWith(`${root}/`);
}

function classifyReleasePath(path, policy) {
  for (const category of policy.precedence) {
    if (policy.lists[category].some((pattern) => pathMatchesReleasePattern(path, pattern))) return category;
  }
  return "";
}

function validateTarget(target, sourceVersion) {
  if (existsSync(resolve(target, ".git")) || existsSync(resolve(target, "maintainer-private"))
    || existsSync(resolve(target, "dashboard/node_modules"))) {
    fail("target must be a pure public source package without Git metadata, private maintainer files, or dependencies");
  }
  const assistant = assistantIdentity(target, "target");
  const instance = manifestIdentity(target, "target");
  if (assistant.productId !== PRODUCT_IDENTITY.productId || assistant.productName !== PRODUCT_IDENTITY.productName
    || assistant.version !== TARGET_VERSION || instance.version !== TARGET_VERSION
    || instance.state !== "template" || instance.instanceId !== "template") {
    fail(`target is not the clean AI Carry ${TARGET_VERSION} template`);
  }
  const releaseRef = assistant.parsed.maintenance?.release_manifest;
  if (releaseRef !== `core/upgrade/release-manifest-${TARGET_VERSION}.toml`) fail("target release manifest pointer is invalid");
  const releaseSource = readUtf8(resolve(target, ...releaseRef.split("/")), "target release manifest", 256 * 1024);
  const firstTable = releaseSource.search(/^\[/mu);
  const releaseHeader = firstTable < 0 ? releaseSource : releaseSource.slice(0, firstTable);
  const release = parseSectionedToml(releaseHeader, "target release manifest header")[""] ?? {};
  if (release.release !== TARGET_VERSION || release.core !== TARGET_VERSION
    || !Array.isArray(release.from_versions)
    || (sourceVersion !== TARGET_VERSION && !release.from_versions.includes(sourceVersion))) {
    fail("target release manifest does not authorize this direct source version");
  }
  const releaseBoundary = releaseBoundaryFrom(releaseSource);
  const releasePathPolicy = releasePathPolicyFrom(releaseSource);
  for (const guide of exactInstanceGuides) if (!existsSync(resolve(target, ...guide.split("/")))) fail(`target lacks ${guide}`);
  validateInstalledCurrentCore(target, instance);
  const targetSnapshot = inspectInstalledSnapshot(target, instance);
  if (targetSnapshot.snapshotState !== "current") fail(`target snapshot is invalid: ${targetSnapshot.snapshotWarning}`);
  return Object.freeze({ assistant, instance, releaseRef, releaseBoundary, releasePathPolicy });
}

export function migrateInstanceManifest(source, fromVersion, { migrateLegacyProfile = false } = {}) {
  const oldLine = `product = ${q(fromVersion)}`;
  const occurrences = source.split(oldLine).length - 1;
  if (occurrences !== 1) fail("source instance product version is ambiguous");
  let migrated = source.replace(oldLine, `product = ${q(TARGET_VERSION)}`);
  if (migrateLegacyProfile) {
    const oldProfileLine = `user_preferences_ref = ${q(legacyProfileRef)}`;
    if (migrated.split(oldProfileLine).length - 1 !== 1) fail("legacy profile reference is ambiguous");
    migrated = migrated.replace(oldProfileLine, `user_preferences_ref = ${q(approvedProfileRef)}`);
  }
  return migrated;
}

function rebuildDerived(candidate) {
  const capsule = syncStartupCapsule(candidate, { write: true });
  if (inspectStartupCapsule(candidate).decision !== "startup-capsule-valid") fail("candidate startup capsule did not close");
  return Object.freeze({
    capsuleDecision: capsule.decision,
    sourceManifestDigest: capsule.sourceManifestDigest,
  });
}

function validateSnapshotPair(candidate) {
  const publicBytes = readFileSync(resolve(candidate, "dashboard/public/snapshot.js"));
  const distBytes = readFileSync(resolve(candidate, "dashboard/dist/snapshot.js"));
  if (Buffer.compare(publicBytes, distBytes) !== 0) fail("candidate snapshot pair is not byte-identical");
  validateSnapshotSemantics(parseCurrentSnapshotEnvelope(publicBytes.toString("utf8"), "candidate public snapshot"), "candidate public snapshot");
  return Object.freeze({ snapshotSha256: sha256(publicBytes) });
}

function runSnapshotRefresh(root) {
  const script = resolve(root, "dashboard/scripts/sync-snapshot.mjs");
  const output = execFileSync(process.execPath, [script, root], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(String(output).trim());
}

function validateCandidate(candidate, sourceIdentity, profileMigration = null, governanceBrandMigration = null, { requireSnapshot = true } = {}) {
  const identity = manifestIdentity(candidate, "candidate");
  if (identity.version !== TARGET_VERSION || identity.instanceId !== sourceIdentity.instanceId || identity.state !== sourceIdentity.state) {
    fail("candidate instance identity or product version drifted");
  }
  verifyLegacyProfileMigration(candidate, identity, profileMigration);
  verifyMemoryGovernanceBrandMigration(candidate, governanceBrandMigration);
  const snapshot = requireSnapshot ? validateSnapshotPair(candidate) : Object.freeze({ snapshotSha256: "" });
  return Object.freeze({ identity, snapshotSha256: snapshot.snapshotSha256 });
}

function validateCurrentSessionReentry(sourceArgument, transactionRef, expectedInstanceId, expectedManifestDigest, sourceVersion) {
  const source = resolvePhysicalDirectory(sourceArgument, "source");
  const match = confirmationPattern.exec(String(transactionRef ?? ""));
  if (!match) fail("session reentry transaction reference is invalid");
  const installed = validateSource(source);
  if (!installed.alreadyCurrent || installed.instance.instanceId !== expectedInstanceId) {
    fail("session reentry source is not the expected installed AI Carry instance");
  }
  const manifestDigest = `sha256:${sha256(readFileSync(resolve(source, "instance/manifest.toml")))}`;
  if (manifestDigest !== expectedManifestDigest) fail("session reentry manifest digest drifted");
  if (inspectStartupCapsule(source).decision !== "startup-capsule-valid") fail("session reentry startup capsule is invalid");

  const token = match[1] + match[2];
  const attempt = Number(match[3]);
  const rollbackPackage = operationPaths(source, token, attempt).rollbackPackage;
  const rollbackManifest = JSON.parse(readUtf8(resolve(rollbackPackage, "AI-CARRY-ROLLBACK.json"), "rollback package manifest", 2 * 1024 * 1024));
  if (rollbackManifest.record_type !== "ai-carry-upgrade-rollback-package"
    || rollbackManifest.transaction_ref !== transactionRef
    || rollbackManifest.source_version !== sourceVersion
    || rollbackManifest.target_version !== TARGET_VERSION
    || rollbackManifest.instance_id !== expectedInstanceId
    || !Array.isArray(rollbackManifest.operations)) {
    fail("rollback package does not close over the previewed file transaction");
  }

  const actions = JSON.parse(readUtf8(resolve(source, "dashboard/src/generated/dashboard-actions.json"), "session reentry actions", 2 * 1024 * 1024));
  const releaseManifestSource = readUtf8(resolve(source, `core/upgrade/release-manifest-${TARGET_VERSION}.toml`), "session reentry release manifest", 512 * 1024);
  validateUpgradeRuntimeContract(releaseManifestSource, actions);

  return Object.freeze({
    decision: "ai-carry-upgrade-target-runtime-validated",
    executable: false,
    updated: false,
    completionState: "session-observation-required",
    ...installed.snapshotHealth,
    adoptionEvidence: Object.freeze({
      targetPackageBoundaryValidated: true,
      filesInstalled: true,
      instanceSwitched: true,
      targetRuntimeFilesValidated: true,
      snapshotCurrent: installed.snapshotHealth.snapshotState === "current",
      sessionActivated: false,
      behaviorAccepted: false,
    }),
    rollbackPackage,
    scriptsExecuted: false,
    dependenciesInstalled: false,
    networkUsed: false,
    claimLimit: "这只证明已切换根中的目标启动闭包、升级入口和同次回滚包可读；双快照状态另报，不作为接续新版规则的前提。本地文件工具不能证明宿主已经把新版规则加载进当前会话，也不能把静态字符串当成真实代表行为。dashboard/package.json 中的开发、构建和发布 check:* 不属于已安装实例的升级验收。",
    userSummary: `AI Carry ${TARGET_VERSION} 的文件事务与目标运行入口已经回读通过；当前会话采用和代表行为仍由宿主实际运行事实决定，工具没有自报通过。${installed.snapshotHealth.snapshotState === "pending" ? "看板数据仍待修复，请按返回命令单独处理，不妨碍当前对话接续新版。" : ""}`,
    nextStep: "当前对话继续原工作，或由宿主完成一项与用户当前目标相关的无破坏代表行为；不要新建专门测试任务，也不要在实例中运行开发仓库 check:* 全集。宿主不能原地重载时，下一次自然打开会读取新版入口。",
  });
}

function operationPaths(source, token, attempt) {
  const parent = dirname(source); const stem = basename(source).slice(0, 48);
  const suffix = `${token.slice(0, 12)}-a${attempt}`;
  return Object.freeze({
    candidate: resolve(parent, `${stem}.ai2-candidate-${suffix}`),
    rollbackPackage: resolve(parent, `${stem}.ai2-rollback-${suffix}`),
  });
}

function chooseOperationPaths(source, token) {
  for (let attempt = 1; attempt <= MAX_OPERATION_ATTEMPTS; attempt += 1) {
    const paths = operationPaths(source, token, attempt);
    if (!Object.values(paths).some((path) => existsSync(path))) return Object.freeze({ ...paths, attempt });
  }
  fail(`all ${MAX_OPERATION_ATTEMPTS} bounded retry slots already contain preserved scenes`);
}

function targetWritePaths(targetTree, instanceState, releasePolicy) {
  if (!["template", "instance"].includes(instanceState) || !releasePolicy) fail("target write selection lacks a valid instance state or release policy");
  const selected = [];
  for (const item of targetTree.files) {
    const segments = item.path.split("/");
    const forbidden = segments.some((segment) => releasePolicy.forbiddenSegments.has(segment));
    const exactOverride = releasePolicy.exactZeroByteOverrides.has(item.path) && item.bytes === 0;
    if (forbidden && !exactOverride) fail(`target path is forbidden by the release manifest: ${item.path}`);
    const category = classifyReleasePath(item.path, releasePolicy);
    if (!category) fail(`target path is not classified by the release manifest: ${item.path}`);
    if (category === "remove") fail(`target package contains a path classified for removal: ${item.path}`);
    const writable = instanceState === "template"
      ? true
      : ["replace", "replace_instance_guides", "migrate"].includes(category);
    if (writable) selected.push(item.path);
  }
  return Object.freeze(selected.sort());
}

function validatePathSpellingAndLinks(root, paths) {
  for (const path of paths) {
    let current = root;
    const segments = path.split("/");
    for (const [index, segment] of segments.entries()) {
      if (!existsSync(current)) break;
      const names = readdirSync(current);
      const folded = segment.normalize("NFC").toLowerCase();
      const matches = names.filter((name) => name.normalize("NFC").toLowerCase() === folded);
      if (matches.length > 1 || (matches.length === 1 && matches[0] !== segment)) {
        fail(`source has a case or Unicode path collision at ${path}`);
      }
      current = resolve(current, segment);
      if (!existsSync(current)) break;
      const info = lstatSync(current);
      if (info.isSymbolicLink() || info.isReparsePoint?.()) fail(`source product path contains a link at ${path}`);
      if (info.isFile() && info.nlink > 1) fail(`source product path is a hardlink at ${path}`);
      if (index < segments.length - 1 && !info.isDirectory()) fail(`source product path parent is not a directory at ${path}`);
    }
  }
}

function validatePlatformMetadata(source, paths) {
  validatePathSpellingAndLinks(source, paths);
  if (process.platform !== "win32") return Object.freeze({ decision: "portable-path-preflight-passed", inspectedPathCount: paths.length });
  const encodedPaths = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  let output;
  try {
    output = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", windowsMetadataPreflightPath,
      "-Root", source, "-PathsBase64", encodedPaths], {
      encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 500);
    fail(`Windows metadata preflight could not complete${detail ? `: ${detail}` : ""}`);
  }
  let result;
  try { result = JSON.parse(String(output).trim()); } catch { fail("Windows metadata preflight returned invalid JSON"); }
  if (result.decision !== "windows-upgrade-metadata-preflight-passed" || result.inspected_path_count !== paths.length
    || !Array.isArray(result.issues) || result.issues.length !== 0) {
    const examples = Array.isArray(result.issues) ? result.issues.slice(0, 5).map((item) => `${item.path}:${item.reason}`).join(", ") : "unknown";
    fail(`Windows product paths use metadata this transaction cannot preserve: ${examples}`);
  }
  return Object.freeze({ decision: result.decision, inspectedPathCount: paths.length });
}

function inspectFilePath(root, path, label) {
  const segments = path.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    if (!existsSync(current)) return Object.freeze({ path, exists: false, bytes: 0, sha256: "" });
    const info = lstatSync(current);
    if (info.isSymbolicLink() || info.isReparsePoint?.()) fail(`${label} contains a link at ${path}`);
    if (index < segments.length - 1 && !info.isDirectory()) fail(`${label} parent is not a directory at ${path}`);
    if (index === segments.length - 1) {
      if (!info.isFile()) fail(`${label} destination is not a regular file at ${path}`);
      const bytes = readFileSync(current);
      return Object.freeze({ path, exists: true, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  fail(`${label} could not inspect ${path}`);
}

function snapshotPathStates(root, paths, label) {
  const entries = paths.map((path) => inspectFilePath(root, path, label));
  const totalBytes = entries.reduce((sum, item) => sum + item.bytes, 0);
  if (entries.length > MAX_TARGET_FILES || totalBytes > MAX_TARGET_BYTES) fail(`${label} exceeds the bounded product-path budget`);
  const fingerprint = sha256(Buffer.from(entries.map((item) => `${item.path}\0${item.exists ? 1 : 0}\0${item.bytes}\0${item.sha256}\n`).join(""), "utf8"));
  return Object.freeze({ entries: Object.freeze(entries), fileCount: entries.filter((item) => item.exists).length, totalBytes, fingerprint });
}

export function planLegacyProfileMigration(source, instance) {
  if (!instance.validated.legacyProfileMigrationRequired) {
    return Object.freeze({ required: false, conflict: false, sourceSha256: "", destinationExisted: false });
  }
  const sourceState = inspectFilePath(source, legacyProfileRef, "legacy profile source");
  if (!sourceState.exists || sourceState.bytes > 2 * 1024 * 1024) fail("legacy profile source is missing or exceeds its bounded migration size");
  const destinationState = inspectFilePath(source, approvedProfileRef, "approved profile destination");
  return Object.freeze({
    required: true,
    conflict: destinationState.exists && destinationState.sha256 !== sourceState.sha256,
    sourceSha256: sourceState.sha256,
    destinationExisted: destinationState.exists,
  });
}

export function installLegacyProfileMigration(source, candidate, plan) {
  if (!plan.required) return;
  const sourceBytes = readFileSync(resolve(source, ...legacyProfileRef.split("/")));
  if (sha256(sourceBytes) !== plan.sourceSha256) fail("legacy profile source drifted after preview");
  const destination = resolve(candidate, ...approvedProfileRef.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, sourceBytes);
  if (sha256(readFileSync(destination)) !== plan.sourceSha256) fail("legacy profile migration readback failed");
}

export function verifyLegacyProfileMigration(candidate, identity, plan) {
  if (!plan?.required) return;
  if (identity.validated.profile.user_preferences_ref !== approvedProfileRef) fail("candidate did not adopt the migrated approved profile reference");
  const destination = inspectFilePath(candidate, approvedProfileRef, "migrated approved profile");
  if (!destination.exists || destination.sha256 !== plan.sourceSha256) fail("migrated approved profile bytes differ from the legacy source");
}

export function migrateMemoryGovernanceBrand(source) {
  if (!/^id = "governance\.memory-technology-review"$/mu.test(source)) return source;
  return memoryGovernanceBrandPhrases.reduce(
    (result, [legacy, current]) => result.replaceAll(legacy, current),
    source,
  );
}

export function planMemoryGovernanceBrandMigration(source, instance) {
  if (instance.state !== "instance") return noGovernanceBrandMigration;
  const state = inspectFilePath(source, memoryGovernanceRef, "memory governance brand source");
  if (!state.exists || state.bytes > 128 * 1024) return noGovernanceBrandMigration;
  const current = readUtf8(resolve(source, ...memoryGovernanceRef.split("/")), "memory governance brand source", 128 * 1024);
  const migrated = migrateMemoryGovernanceBrand(current);
  if (migrated === current) return noGovernanceBrandMigration;
  return Object.freeze({
    required: true,
    sourceSha256: sha256(Buffer.from(current, "utf8")),
    migratedSha256: sha256(Buffer.from(migrated, "utf8")),
  });
}

export function installMemoryGovernanceBrandMigration(source, candidate, plan) {
  if (!plan.required) return;
  const sourcePath = resolve(source, ...memoryGovernanceRef.split("/"));
  const current = readUtf8(sourcePath, "memory governance brand source", 128 * 1024);
  if (sha256(Buffer.from(current, "utf8")) !== plan.sourceSha256) fail("memory governance card drifted after preview");
  const migrated = migrateMemoryGovernanceBrand(current);
  if (sha256(Buffer.from(migrated, "utf8")) !== plan.migratedSha256) fail("memory governance brand migration is not deterministic");
  const destination = resolve(candidate, ...memoryGovernanceRef.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, migrated, "utf8");
}

export function verifyMemoryGovernanceBrandMigration(candidate, plan) {
  if (!plan?.required) return;
  const migrated = inspectFilePath(candidate, memoryGovernanceRef, "migrated memory governance card");
  if (!migrated.exists || migrated.sha256 !== plan.migratedSha256) fail("migrated memory governance card differs from the bound preview");
}

function verifyPathStates(root, snapshot, label) {
  const actual = snapshotPathStates(root, snapshot.entries.map((item) => item.path), label);
  if (actual.fingerprint !== snapshot.fingerprint) fail(`${label} drifted`);
  return actual;
}

function buildInPlaceSwitchPlan(source, candidate, paths) {
  const before = snapshotPathStates(source, paths, "source product paths");
  const after = snapshotPathStates(candidate, paths, "candidate product paths");
  const beforeMap = new Map(before.entries.map((item) => [item.path, item]));
  const writes = after.entries.filter((item) => {
    const previous = beforeMap.get(item.path);
    return !previous.exists || previous.bytes !== item.bytes || previous.sha256 !== item.sha256;
  });
  const directories = new Set();
  for (const item of writes) {
    const segments = item.path.split("/").slice(0, -1);
    let current = source;
    let ref = "";
    for (const segment of segments) {
      current = resolve(current, segment);
      ref = ref ? `${ref}/${segment}` : segment;
      if (!existsSync(current)) directories.add(ref);
    }
  }
  const createdDirectories = [...directories].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  return Object.freeze({ before, after, writes: Object.freeze(writes), removals: Object.freeze([]), createdDirectories: Object.freeze(createdDirectories) });
}

function restoreInPlaceSwitch(state) {
  for (const operation of [...state.operations].reverse()) {
    if (operation.newInstalled && existsSync(operation.destination)) unlinkSync(operation.destination);
    if (operation.oldMoved) {
      mkdirSync(dirname(operation.destination), { recursive: true });
      renameSync(operation.rollback, operation.destination);
    }
    if (operation.temporary && existsSync(operation.temporary)) unlinkSync(operation.temporary);
  }
  verifyPathStates(state.source, state.plan.before, "restored product paths");
  for (const ref of [...state.createdDirectories].reverse()) {
    const path = resolve(state.source, ...ref.split("/"));
    if (existsSync(path) && lstatSync(path).isDirectory() && readdirSync(path).length === 0) rmdirSync(path);
  }
  state.restored = true;
}

function commitCandidateInPlace(source, candidate, rollbackRoot, token, attempt, transactionRef, paths, sourceState) {
  const plan = buildInPlaceSwitchPlan(source, candidate, paths);
  mkdirSync(rollbackRoot, { recursive: false });
  const state = { source, candidate, rollbackRoot, plan, operations: [], createdDirectories: [], restored: false };
  writeFileSync(resolve(rollbackRoot, "AI-CARRY-ROLLBACK.json"), `${JSON.stringify({
    schema_version: 1,
    record_type: "ai-carry-upgrade-rollback-package",
    transaction_ref: transactionRef,
    source_version: sourceState.instance.version,
    target_version: TARGET_VERSION,
    instance_id: sourceState.instance.instanceId,
    created_directories: plan.createdDirectories,
    operations: plan.writes.map((item) => {
      const before = plan.before.entries.find((entry) => entry.path === item.path);
      return { path: item.path, existed_before: before.exists, before_bytes: before.bytes, before_sha256: before.sha256, after_bytes: item.bytes, after_sha256: item.sha256 };
    }),
  }, null, 2)}\n`, "utf8");
  let mutationCount = 0;
  const injectIfRequested = () => {
    if (mutationCount === 1 && process.env.AI_CARRY_UPGRADE_FAIL_AT === "after-first-in-place-mutation") {
      throw new Error("injected-after-first-in-place-mutation");
    }
  };
  try {
    for (const ref of plan.createdDirectories) {
      const directory = resolve(source, ...ref.split("/"));
      mkdirSync(directory, { recursive: false });
      state.createdDirectories.push(ref);
    }
    for (const [index, item] of plan.writes.entries()) {
      const sourceFile = resolve(candidate, ...item.path.split("/"));
      const destination = resolve(source, ...item.path.split("/"));
      const rollback = resolve(rollbackRoot, ...item.path.split("/"));
      const temporary = resolve(dirname(destination), `.ai2-${token.slice(0, 6)}-a${attempt}-${index.toString(36)}.tmp`);
      if (existsSync(temporary)) fail(`temporary switch path already exists: ${item.path}`);
      const operation = { path: item.path, destination, rollback, temporary, oldMoved: false, newInstalled: false };
      state.operations.push(operation);
      copyFileSync(sourceFile, temporary);
      const staged = lstatSync(temporary);
      if (!staged.isFile() || staged.isSymbolicLink() || staged.isReparsePoint?.()
        || staged.size !== item.bytes || sha256(readFileSync(temporary)) !== item.sha256) fail(`staged bytes differ: ${item.path}`);
      if (existsSync(destination)) {
        mkdirSync(dirname(rollback), { recursive: true });
        renameSync(destination, rollback); operation.oldMoved = true; mutationCount += 1; injectIfRequested();
      }
      renameSync(temporary, destination); operation.newInstalled = true;
      if (!operation.oldMoved) { mutationCount += 1; injectIfRequested(); }
    }
    verifyPathStates(source, plan.after, "installed product paths");
    return state;
  } catch (error) {
    try {
      restoreInPlaceSwitch(state);
      error.upgradeRollback = mutationCount > 0 ? "source-restored" : "source-unchanged";
    } catch (rollbackError) {
      error.upgradeRollback = "recovery-required";
      error.upgradeRollbackReason = String(rollbackError?.message ?? rollbackError);
    }
    throw error;
  }
}

function cleanupSuccessfulSwitch(state) {
  const warnings = [];
  for (const [label, path] of [["verified-candidate", state.candidate]]) {
    try { rmSync(path, { recursive: true, force: false }); }
    catch (error) { warnings.push(`${label}:${String(error?.message ?? error)}`); }
  }
  return Object.freeze(warnings);
}

function validateOfficialReleaseLive(target, targetTree, releaseRef) {
  let output;
  try {
    output = execFileSync(process.execPath, [releaseVerifierPath, "--target", target], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 500);
    fail(`live official Release verification did not pass${detail ? `: ${detail}` : ""}`);
  }
  let record;
  try { record = JSON.parse(String(output).trim()); }
  catch { fail("live official Release verifier returned invalid JSON"); }
  const releaseManifestDigest = `sha256:${sha256(readFileSync(resolve(target, ...releaseRef.split("/"))))}`;
  const authorityFingerprint = officialAuthorityFingerprint(record);
  if (record.record_type !== "ai-carry-live-official-release-verification"
    || record.authority !== "github-api-live-https"
    || record.repository !== "Ww-Cooooo/AI-Carry"
    || record.release_ref !== `v${TARGET_VERSION}`
    || !/^[a-f0-9]{40}$/u.test(record.commit_sha ?? "")
    || !/^[a-f0-9]{40}$/u.test(record.git_tree_sha ?? "")
    || !/^[1-9][0-9]*$/u.test(String(record.release_id ?? ""))
    || record.latest_release_id !== record.release_id
    || record.release_url !== `https://github.com/Ww-Cooooo/AI-Carry/releases/tag/v${TARGET_VERSION}`
    || record.draft !== false || record.prerelease !== false || record.fixture !== false
    || record.target_tree_sha256 !== `sha256:${targetTree.fingerprint}`
    || record.release_manifest_sha256 !== releaseManifestDigest
    || record.target_file_count !== targetTree.fileCount
    || record.network_used !== true
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(record.verified_at ?? "")
    || record.authority_fingerprint_schema !== AUTHORITY_FINGERPRINT_SCHEMA
    || record.authority_fingerprint !== authorityFingerprint
    || !Number.isSafeInteger(record.request_count) || record.request_count < 1
    || !Number.isSafeInteger(record.request_budget) || record.request_budget > OFFICIAL_RELEASE_REQUEST_BUDGET
    || record.request_count > record.request_budget) {
    fail("live official Release result is incomplete or does not bind this exact target tree");
  }
  const digest = `sha256:${sha256(Buffer.from(JSON.stringify(record), "utf8"))}`;
  return Object.freeze({
    digest,
    authorityFingerprint,
    authority: record.authority,
    releaseId: String(record.release_id),
    latestReleaseId: String(record.latest_release_id),
    commitSha: record.commit_sha,
    gitTreeSha: record.git_tree_sha,
    releaseUrl: record.release_url,
    verifiedAt: record.verified_at,
    requestCount: record.request_count,
    requestBudget: record.request_budget,
    networkUsed: true,
  });
}

function buildUpgradeBinding({
  source,
  target,
  sourceProductFingerprint,
  targetTreeFingerprint,
  profileMigration,
  governanceBrandMigration = noGovernanceBrandMigration,
  instanceId,
  sourceVersion,
}) {
  return sha256(Buffer.from([
    source,
    target,
    sourceProductFingerprint,
    targetTreeFingerprint,
    profileMigration.required ? profileMigration.sourceSha256 : "",
    profileMigration.conflict ? "profile-conflict" : "",
    governanceBrandMigration.required ? governanceBrandMigration.sourceSha256 : "",
    governanceBrandMigration.required ? governanceBrandMigration.migratedSha256 : "",
    instanceId,
    sourceVersion,
    TARGET_VERSION,
  ].join("\0"), "utf8"));
}

function prepareUpgrade(sourceArgument, targetArgument, { verifyOfficial = true } = {}) {
  const source = resolvePhysicalDirectory(sourceArgument, "source");
  const target = resolvePhysicalDirectory(targetArgument, "target");
  if (pathIsInside(source, target) || pathIsInside(target, source)) fail("source and target must be separate trees");
  const sourceState = validateSource(source);
  const targetValidation = validateTarget(target, sourceState.instance.version);
  const targetTree = walkTree(target, { maxFiles: MAX_TARGET_FILES, maxBytes: MAX_TARGET_BYTES, label: "target public tree" });
  const officialEvidence = verifyOfficial
    ? validateOfficialReleaseLive(target, targetTree, targetValidation.releaseRef)
    : null;
  const profileMigration = planLegacyProfileMigration(source, sourceState.instance);
  const governanceBrandMigration = sourceState.alreadyCurrent
    ? noGovernanceBrandMigration
    : planMemoryGovernanceBrandMigration(source, sourceState.instance);
  const targetPaths = targetWritePaths(targetTree, sourceState.instance.state, targetValidation.releasePathPolicy);
  const writePaths = Object.freeze([...new Set([
    ...targetPaths,
    ...(profileMigration.required ? [approvedProfileRef] : []),
    ...(governanceBrandMigration.required ? [memoryGovernanceRef] : []),
  ])].sort());
  if (sourceState.alreadyCurrent) {
    const instanceDerived = new Set([
      "instance/manifest.toml",
      "instance/startup-capsule.toml",
      "dashboard/public/snapshot.js",
      "dashboard/dist/snapshot.js",
    ]);
    const staticPaths = writePaths.filter((path) => !snapshotPaths.has(path)
      && (sourceState.instance.state !== "instance" || !instanceDerived.has(path)));
    const currentStatic = snapshotPathStates(source, staticPaths, "current installed product paths");
    const targetByPath = new Map(targetTree.files.map((item) => [item.path, item]));
    for (const entry of currentStatic.entries) {
      const official = targetByPath.get(entry.path);
      if (!entry.exists || !official || entry.bytes !== official.bytes || entry.sha256 !== official.sha256) {
        fail(`current AI Carry product path differs from the official Release: ${entry.path}`);
      }
    }
    return Object.freeze({
      decision: "ai-carry-upgrade-already-current", executable: false, updated: false,
      productVersion: TARGET_VERSION, instanceId: sourceState.instance.instanceId,
      ...sourceState.snapshotHealth,
      officialEvidence, targetTreeFingerprint: targetTree.fingerprint,
      verifiedStaticProductFileCount: staticPaths.length,
      authorityVerified: verifyOfficial, networkUsed: verifyOfficial,
      userSummary: verifyOfficial
        ? `这份助手已经通过正式 Release 与固定目标整树回读，是 AI Carry ${TARGET_VERSION}；本次没有重复改文件、刷新时间或生成候选。`
        : `这份助手已经是 AI Carry ${TARGET_VERSION}；本次只核对本地目标与已安装产品，没有联网或重复改文件。`,
      nextStep: sourceState.snapshotHealth.snapshotState === "current"
        ? "可以继续原来的工作；本次不需要重复升级。"
        : "产品已是当前版本，但看板数据待修复；让 Agent 执行返回的 snapshotRefreshCommand 定向重建，普通工作和新版规则接续不必等待。",
    });
  }
  const platformMetadata = validatePlatformMetadata(source, writePaths);
  const sourceProductState = snapshotPathStates(source, writePaths, "source product paths");
  const reviewRequired = profileMigration.conflict;
  const binding = buildUpgradeBinding({
    source,
    target,
    sourceProductFingerprint: sourceProductState.fingerprint,
    targetTreeFingerprint: targetTree.fingerprint,
    profileMigration,
    governanceBrandMigration,
    instanceId: sourceState.instance.instanceId,
    sourceVersion: sourceState.instance.version,
  });
  const token = binding.slice(0, 32); const nonce = binding.slice(32, 64); const paths = chooseOperationPaths(source, binding);
  const confirmationRef = `ai-carry-upgrade.${token}~${nonce}~${paths.attempt}`;
  const changePreview = Object.freeze({
    replace: Object.freeze([`最多核对并切换 ${writePaths.length} 个发布清单拥有的产品路径`, `${exactInstanceGuides.length} 个目标版本实例目录说明`]),
    migrate: Object.freeze(sourceState.instance.state === "instance"
      ? ["只更新 instance/manifest.toml 的产品版本", ...(profileMigration.required
        ? ["把旧 profile/README.md 用户正文逐字节迁到 approved-profile.md 并更新引用"] : []),
      ...(governanceBrandMigration.required
        ? ["只把内置记忆治理卡中仍代表当前产品的已知旧名短语改为 AI Carry，其余内容与排期保持不变"] : []),
      "从合并后 manifest 重建 startup capsule", "从合并后正式真源重建 public/dist 双快照"]
      : ["按目标路径更新空模板，继续保持 template 身份和零业务资产"]),
    preserve: Object.freeze(sourceState.instance.state === "instance"
      ? ["除预览明确列出的最小迁移项外，实例资产、工作区、本机层、私密层和未知根文件不在产品写集内，原地不碰", "保留身份、created_from、档案、地图、资产、Skill、组件和未知字段；相关能力首次使用时再检查兼容"]
      : ["源中不属于目标产品路径的未知文件留在原位，不推断删除"]),
    remove: Object.freeze([]),
    conflicts: Object.freeze([
      ...(profileMigration.conflict ? ["profile:approved-profile-destination-conflict"] : []),
    ]),
    extensionCompatibility: Object.freeze({
      policy: "preserve-without-enumeration-and-check-on-use",
      componentStateChangeRequired: false,
    }),
  });
  const conflictText = changePreview.conflicts.length === 0
    ? "【冲突】未发现阻止本次候选组装的冲突。"
    : `【冲突】${changePreview.conflicts.join("、")}。相关内容原样保留；只暂停本次升级。`;
  const extensionText = "【扩展兼容】升级不枚举或复制工作区、组件正文和本机绑定；它们原地保留，在真正使用对应能力时再做有界兼容检查，单项问题只隔离该能力。";
  const userPreview = [
    `准备把这份 ${sourceState.assistant.productName} ${sourceState.instance.version} ${sourceState.instance.state === "template" ? "空模板" : "实例"}升级为 AI Carry ${TARGET_VERSION}。`,
    verifyOfficial
      ? `实例身份保持：${sourceState.instance.instanceId}。CLI 已通过 GitHub HTTPS API 现场核对正式 Release、固定标签和这棵目标树；目标包发布边界允许实例替换。`
      : `实例身份保持：${sourceState.instance.instanceId}。本次确认只复核预览已经绑定的本地来源和目标字节，不重复联网。`,
    `【替换】最多核对并切换 ${writePaths.length} 个发布清单明确拥有的产品路径；实际相同字节不会重复写。`,
    sourceState.instance.state === "instance"
      ? `【迁移】更新 manifest 产品版本${profileMigration.required ? "；旧 profile/README.md 用户正文会逐字节迁到 approved-profile.md 并更新引用" : ""}${governanceBrandMigration.required ? "；内置记忆治理卡中仍代表当前产品的已知旧名短语会改为 AI Carry，其他正文和排期保持不变" : ""}；随后确定性重建启动胶囊和两份真实快照。`
      : "【迁移】按目标产品路径更新空模板，继续保持 template 身份和零业务资产。",
    sourceState.instance.state === "instance"
      ? "【保留】除上面明确列出的最小迁移项外，实例资产、工作区、本机层、私密层和未知根文件保持原地，不扫描工作区正文、不复制、不删除。"
      : "【保留】不属于目标产品路径的源文件保持原地，不推断删除。",
    "【删除】0 项。当前实例根路径不移动；只为实际变化的产品文件保留有清单的回滚前像，不复制整棵用户目录。",
    conflictText,
    extensionText,
    "除刚才只读核对最新正式 Release、固定轻量标签、公开 main 与目标整树外，不会执行 Skill、组件或工作区脚本，不会安装依赖、继续联网、登录、改权限、删除旧实例或清理失败现场。",
    reviewRequired ? "兼容预检尚未闭合；本次只保留预览，不提供切换确认，旧实例继续可用。" : "如果同意这份完整预览，请在下一条独立消息中回复“升级”。",
  ].join("\n\n");
  const common = Object.freeze({
    source, target, sourceVersion: sourceState.instance.version, targetVersion: TARGET_VERSION,
    instanceId: sourceState.instance.instanceId, inspectedProductFileCount: sourceProductState.fileCount,
    inspectedProductBytes: sourceProductState.totalBytes, protectedFileCount: 0,
    preservationMethod: "not-in-product-write-set",
    targetFileCount: targetTree.fileCount, writePaths, sourceProductFingerprint: sourceProductState.fingerprint,
    profileMigration, governanceBrandMigration,
    targetTreeFingerprint: targetTree.fingerprint, officialEvidence, platformMetadata,
    targetReleaseBoundary: targetValidation.releaseBoundary,
    previewAuthority: verifyOfficial ? "live-github-release-and-exact-tag-tree-verified" : "previous-preview-bound-local-target", changePreview, userPreview,
    confirmationClaimLimit: "CLI 只核对本次预览引用和精确确认字符串，不具备聊天角色认证能力。承载对话的宿主必须只在用户看过本次预览、并在下一条独立消息明确确认后调用 confirm；这是一条产品交互边界，不伪装成对恶意 Agent 的权限沙箱。",
  });
  if (reviewRequired) return Object.freeze({
    decision: "ai-carry-upgrade-review-required", executable: false, updated: false,
    ...common,
    nextStep: "只核对旧个人档案与 approved-profile.md 的内容冲突；保留两份原文，确定正确归属后再生成升级预览。旧实例、普通对话和其他能力继续可用。",
  });
  return Object.freeze({
    decision: "ai-carry-upgrade-confirmation-required", executable: false,
    ...common,
    candidate: paths.candidate, rollbackPackage: paths.rollbackPackage, attempt: paths.attempt, confirmationRef,
    confirmCommand: `node ${q(fileURLToPath(import.meta.url))} confirm --source ${q(source)} --target ${q(target)} --confirmation-ref ${q(confirmationRef)} --user-reply ${q("升级")}`,
    nextStep: "把 userPreview 单独展示给用户。只有用户在看过本次预览后的下一条独立消息明确回复“升级”或“确认升级”，Agent 才执行这条同次绑定命令；用户不需要操作终端。CLI 会重新核对本地来源、目标和引用，但不会重复联网；聊天消息角色由承载对话的宿主负责。",
  });
}

function confirmationUnverified() {
  return Object.freeze({
    decision: "ai-carry-upgrade-confirmation-unverified",
    executable: false,
    updated: false,
    userReplyStringMatched: false,
    authorityVerified: false,
    userSummary: "升级预览可以继续查看，但模型传入的普通字符串没有被当作用户授权，实例文件没有改变。",
    nextStep: "先把本次绑定预览展示给用户；只有用户随后独立回复“升级”或“确认升级”时，宿主 Agent 才可执行同次 confirmCommand。",
  });
}

function confirmUpgrade(sourceArgument, targetArgument, confirmationRef, userReply) {
  if (!acceptedConfirmationReplies.has(String(userReply ?? "").trim())) return confirmationUnverified();
  return applyUpgradeWithHostConfirmation(sourceArgument, targetArgument, confirmationRef, String(userReply).trim());
}

function applyUpgradeWithHostConfirmation(sourceArgument, targetArgument, confirmationRef, userReply) {
  if (!acceptedConfirmationReplies.has(String(userReply ?? "").trim())) fail("user reply must be ‘升级’ or ‘确认升级’");
  const match = confirmationPattern.exec(String(confirmationRef ?? ""));
  if (!match) fail("confirmation reference is invalid");
  const prepared = prepareUpgrade(sourceArgument, targetArgument, { verifyOfficial: false });
  if (prepared.decision === "ai-carry-upgrade-already-current") return prepared;
  if (prepared.confirmationRef !== confirmationRef) fail("source or target changed after the preview; generate a fresh preview");
  const { source, target, candidate, rollbackPackage } = prepared;
  const sourceState = validateSource(source);
  const sourceProductBefore = snapshotPathStates(source, prepared.writePaths, "source product paths");
  if (sourceProductBefore.fingerprint !== prepared.sourceProductFingerprint) fail("source product paths drifted after preview");
  let switchState = null;
  try {
    cpSync(target, candidate, { recursive: true, errorOnExist: true, force: false });
    const copiedTargetTree = walkTree(candidate, { maxFiles: MAX_TARGET_FILES, maxBytes: MAX_TARGET_BYTES, label: "copied target candidate" });
    if (copiedTargetTree.fingerprint !== prepared.targetTreeFingerprint) {
      fail("target changed while the isolated candidate was being copied");
    }
    if (sourceState.instance.state === "instance") {
      installLegacyProfileMigration(source, candidate, prepared.profileMigration);
      installMemoryGovernanceBrandMigration(source, candidate, prepared.governanceBrandMigration);
      writeFileSync(resolve(candidate, "instance/manifest.toml"), migrateInstanceManifest(sourceState.instance.source, sourceState.instance.version, {
        migrateLegacyProfile: prepared.profileMigration.required,
      }), "utf8");
    }
    const derived = rebuildDerived(candidate);
    validateCandidate(candidate, sourceState.instance, prepared.profileMigration, prepared.governanceBrandMigration, { requireSnapshot: false });
    verifyPathStates(source, sourceProductBefore, "source product paths");
    if (process.env.AI_CARRY_UPGRADE_FAIL_AT === "before-switch") throw new Error("injected-before-switch");
    const token = match[1] + match[2]; const attempt = Number(match[3]);
    const paths = operationPaths(source, token, attempt);
    if (paths.rollbackPackage !== rollbackPackage) fail("rollback package path drifted after preview");
    const coreWritePaths = prepared.writePaths.filter((path) => !snapshotPaths.has(path));
    switchState = commitCandidateInPlace(source, candidate, rollbackPackage, token, attempt, confirmationRef, coreWritePaths, sourceState);
    const installed = validateCandidate(source, sourceState.instance, prepared.profileMigration, prepared.governanceBrandMigration, { requireSnapshot: false });
    const cleanupWarnings = cleanupSuccessfulSwitch(switchState);
    let snapshotResult;
    let snapshotState = "current";
    let snapshotWarning = "";
    let snapshotSha256 = "";
    try {
      snapshotResult = runSnapshotRefresh(source);
      snapshotSha256 = validateSnapshotPair(source).snapshotSha256;
    } catch (error) {
      snapshotState = "pending";
      snapshotWarning = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 500);
      snapshotResult = Object.freeze({ decision: "snapshot-refresh-pending", updated: false });
    }
    const snapshotRefreshCommand = `node ${q(resolve(source, "dashboard/scripts/sync-snapshot.mjs"))} ${q(source)}`;
    return Object.freeze({
      decision: "ai-carry-upgrade-files-switched", executable: false, updated: true,
      status: snapshotState === "current" ? "passed" : "limited",
      sourceVersion: prepared.sourceVersion, targetVersion: TARGET_VERSION,
      instanceId: installed.identity.instanceId, rollbackPackage,
      protectedFileCount: 0, preservedByteDrift: 0, preservationMethod: "not-in-product-write-set",
      startupCapsule: inspectStartupCapsule(source).decision,
      snapshotState, snapshotWarning, snapshotResult, snapshotSha256,
      componentDecision: "preserved-and-checked-on-use",
      scriptsExecuted: false, dependenciesInstalled: false, networkUsed: false,
      switchMethod: "stable-root-in-place-transaction",
      changedFileCount: switchState.plan.writes.length,
      removedFileCount: switchState.plan.removals.length,
      cleanupWarnings,
      completionState: snapshotState === "current" ? "session-activation-required" : "snapshot-refresh-required",
      adoptionEvidence: Object.freeze({
        liveOfficialReleaseAndTagTreeVerifiedInPreview: true,
        targetPackageBoundaryValidated: true,
        userReplyStringMatched: true,
        hostUserConfirmationDeclared: true,
        userMessageRoleAuthenticatedByCli: false,
        filesInstalled: true,
        instanceSwitched: true,
        snapshotCurrent: snapshotState === "current",
        sessionActivated: false,
        behaviorAccepted: false,
      }),
      sessionReentryCommand: `node ${q(resolve(source, "dashboard/scripts/ai-carry-upgrade-cli.mjs"))} reentry --source ${q(source)} --transaction-ref ${q(confirmationRef)} --expected-instance-id ${q(installed.identity.instanceId)} --expected-manifest-digest ${q(derived.sourceManifestDigest)} --source-version ${q(prepared.sourceVersion)}`,
      claimLimit: "prepare 已现场核对正式 Release 并把精确本地目标绑定进预览；confirm 只复核未漂移的本地来源、目标、发布边界和确认引用，不重复联网。CLI 不能认证聊天消息角色，也不能证明当前会话已经采用新版。宿主必须只在用户看过本次预览并独立确认后调用。",
      snapshotRefreshCommand,
      userSummary: snapshotState === "current"
        ? "AI Carry 已在不移动当前工作根的情况下完成核心产品切换与看板刷新；实例正式文件保持，工作区、本机层、私密层和未知根文件没有被枚举、复制或删除。"
        : "AI Carry 核心产品已经安全切换，实例与用户内容保持；看板刷新暂未完成，但不会撤销有效升级或影响普通对话。",
      nextStep: snapshotState === "current"
        ? "执行本次返回的 sessionReentryCommand 核对目标运行入口；随后继续当前工作或完成一项相关的无破坏代表行为。不要在实例中运行开发仓库 check:* 全集；会话采用和行为结果必须来自宿主真实事实，不能手填 passed。"
        : "执行 sessionReentryCommand 接续已经有效的新核心；另用 snapshotRefreshCommand 只重试看板刷新。看板待修复不妨碍普通工作，但不能宣称升级全部完成。",
      derived,
    });
  } catch (error) {
    let rollback = error.upgradeRollback ?? "source-unchanged";
    if (switchState && !switchState.restored) {
      try { restoreInPlaceSwitch(switchState); rollback = "source-restored"; }
      catch (rollbackError) {
        error.upgradeRollbackReason = String(rollbackError?.message ?? rollbackError);
        rollback = "recovery-required";
      }
    }
    if (rollback === "recovery-required" || error.upgradeRollbackReason) {
      return Object.freeze({
        decision: "ai-carry-upgrade-recovery-required", executable: false, updated: false,
        reason: String(error?.message ?? error), rollbackReason: error.upgradeRollbackReason,
        source, candidate, rollbackPackage: switchState?.rollbackRoot ?? operationPaths(source, match[1] + match[2], Number(match[3])).rollbackPackage,
        dataState: "源实例、候选和产品文件回滚现场均保留；只暂停本次切换。",
        nextStep: "只检查这三个已报告路径的实际状态，不删除、覆盖、改权限或重新运行首次创建。",
      });
    }
    return Object.freeze({
      decision: "ai-carry-upgrade-failed-rolled-back", executable: false, updated: false,
      reason: String(error?.message ?? error), rollback, source, candidate,
      rollbackPackage: switchState?.rollbackRoot ?? operationPaths(source, match[1] + match[2], Number(match[3])).rollbackPackage,
      dataState: "旧实例仍可使用；隔离候选或失败现场原样保留，没有执行脚本、安装依赖或删除内容。",
      nextStep: "修复这一次候选中报告的具体问题后重新生成预览；普通对话和无关能力可以继续。",
    });
  }
}

function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ""; }
function help() {
  return Object.freeze({
    decision: "ai-carry-upgrade-help",
    commands: Object.freeze([
      `prepare --source <旧实例根目录> --target <AI Carry ${TARGET_VERSION} 公开模板根目录>（显式检查更新时现场联网核对 GitHub 正式 Release 与固定标签整树）`,
      "confirm --source <同一旧实例> --target <同一目标模板> --confirmation-ref <预览返回值> --user-reply <用户本次独立确认>（宿主只可在用户看过预览并回复后调用）",
      "reentry --source <已切换实例根> --transaction-ref <同次确认引用> --expected-instance-id <实例 ID> --expected-manifest-digest <confirm 返回摘要> --source-version <升级前版本>",
    ]),
    boundary: `只支持 Agent Carry 1.4.8／本地 1.4.9／AI Carry 2.0.0 到 AI Carry ${TARGET_VERSION}；CLI 通过 GitHub HTTPS API 现场核对最新正式 Release、固定轻量标签、公开 main 和目标整树，不接受调用者自写来源 JSON。宿主只可在用户看过本次绑定预览并独立确认后调用 confirm；CLI 核对确认字符串但不冒充聊天角色认证器。只切换清单拥有的产品路径，未知路径原地不碰，变化文件保留回滚前像，不执行包内脚本。`,
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    const command = process.argv[2];
    if (!command || ["--help", "help"].includes(command)) process.stdout.write(`${JSON.stringify(help(), null, 2)}\n`);
    else if (command === "prepare") process.stdout.write(`${JSON.stringify(prepareUpgrade(argument("--source"), argument("--target")), null, 2)}\n`);
    else if (command === "confirm") process.stdout.write(`${JSON.stringify(confirmUpgrade(argument("--source"), argument("--target"), argument("--confirmation-ref"), argument("--user-reply")), null, 2)}\n`);
    else if (command === "reentry") process.stdout.write(`${JSON.stringify(validateCurrentSessionReentry(argument("--source"), argument("--transaction-ref"), argument("--expected-instance-id"), argument("--expected-manifest-digest"), argument("--source-version")), null, 2)}\n`);
    else fail("unknown command; use --help");
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      decision: "ai-carry-upgrade-denied", executable: false, updated: false,
      reason: String(error?.message ?? error),
      userSummary: "这次升级没有执行；原实例、普通对话和无关能力仍可继续。",
      nextStep: "请让 Agent 只说明当前缺少或漂移的那一项，再重新生成升级预览。",
    })}\n`);
    process.exitCode = 2;
  }
}

export {
  buildInPlaceSwitchPlan,
  buildUpgradeBinding,
  chooseOperationPaths,
  confirmUpgrade,
  prepareUpgrade,
  releaseBoundaryFrom,
  releasePathPolicyFrom,
  targetWritePaths,
  validateCurrentSessionReentry,
};
