import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  parseArrayTableDocument,
  parseSectionedToml,
  validateInstanceManifestStructure,
} from "./asset-route-contract.mjs";
import {
  PRODUCT_IDENTITY,
  acceptedComponentRecordTypes,
  acceptedComponentRegistryRecordTypes,
  hasAcceptedComponentInterface,
} from "./product-identity.mjs";

const REGISTRY_REF = "instance/components/registry.toml";
const REGISTRY_LIMIT = 32 * 1024;
const MANIFEST_LIMIT = 32 * 1024;
const COMPONENT_LIMIT = 128;
const ENTRY_LIMIT = 4096;
const PORTABLE_FILE_LIMIT = 64 * 1024 * 1024;
const PORTABLE_TOTAL_LIMIT = 256 * 1024 * 1024;
const USER_REPORT_DETAIL_LIMIT = 12;
const stableId = /^[a-z0-9](?:[a-z0-9.-]{1,62}[a-z0-9])$/u;
const interfaceId = /^[a-z0-9](?:[a-z0-9.-]{1,94}[a-z0-9])@[0-9]+$/u;
const semver = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const componentKinds = new Set(["instance-module", "capability-adapter", "local-tool-adapter", "integration-adapter"]);
const componentStates = new Set(["review", "active", "disabled"]);
const adoptionStates = new Set(["template", "required", "current", "conflict"]);
const activations = new Set(["immediate", "next-session", "restart-required", "migration-required"]);
const rootFields = new Set(["schema_version", "record_type", "component_id", "instance_id", "kind", "status", "title", "summary", "component_version", "root", "load_policy"]);
const ownershipFields = new Set(["portable_paths", "derived_paths", "device_local_paths", "private_collection_refs", "unclassified_policy"]);
const interfaceFields = new Set(["provides", "requires"]);
const upgradeFields = new Set(["criticality", "activation", "compatible_action", "incompatible_action", "migration_ids", "second_run"]);
const nativeInstancePrefixes = [
  "instance/memory/",
  "instance/capabilities/",
  "instance/sops/",
  "instance/experiences/",
  "instance/evolution/",
  "instance/todo/",
  "instance/deferred/",
  "instance/skills/",
  "instance/signals/",
  "instance/hosts/",
  "instance/validations/",
  "instance/governance/",
  "instance/profile/",
  "instance/maps/",
];
const nativeInstanceFiles = new Set(["instance/manifest.toml", "instance/startup-capsule.toml"]);
const frameworkLocalPrefixes = [
  ".assistant-local/runtime/",
  ".assistant-local/dashboard/",
  ".assistant-local/indexes/",
  ".assistant-local/skills/",
  ".assistant-local/upgrade-inbox/",
  ".assistant-local/task-handoffs/",
];
const templateRootFiles = new Set([
  "README.md", "README.en.md", "INSTALL.md", "INSTALL.en.md", "START-HERE.txt", "START-HERE.en.txt",
  "AGENTS.md", "BOOTSTRAP.md", "assistant.toml", ".gitattributes", ".gitignore", "LICENSE",
  "THIRD_PARTY_NOTICES.md", "CONTRIBUTING.md", "SECURITY.md", "dashboard.html", "dashboard.en.html",
]);
const templatePrefixes = ["core/", "docs/", "dashboard/", "_data/", ".github/"];
const compatibilityOutcomeRank = new Map([
  ["normal", 0],
  ["auto-repairable", 1],
  ["migration-needed", 2],
  ["component-isolated", 3],
  ["user-decision-needed", 4],
]);

function fail(message) {
  throw new Error(`Instance component contract failed: ${message}`);
}

function compatibilityIssue({ code, outcome, scope, path = "", notice, repair = "", componentId = "", criticality = "unknown" }) {
  if (!compatibilityOutcomeRank.has(outcome)) fail(`compatibility issue has an unknown outcome: ${outcome}`);
  return Object.freeze({ code, outcome, scope, path, componentId, criticality, notice, repair, executable: false });
}

function compatibilityOutcome(issues) {
  return issues.reduce((current, issue) => compatibilityOutcomeRank.get(issue.outcome) > compatibilityOutcomeRank.get(current) ? issue.outcome : current, "normal");
}

function boundedUserDetails(issues) {
  const visibleIssueCount = issues.length > USER_REPORT_DETAIL_LIMIT ? USER_REPORT_DETAIL_LIMIT - 1 : issues.length;
  const details = issues.slice(0, visibleIssueCount).map((issue) => issue.notice);
  const omittedDetailCount = issues.length - visibleIssueCount;
  if (omittedDetailCount > 0) details.push(`另有 ${omittedDetailCount} 条有界诊断保留在详细结果中；这里只展示最相关摘要，避免占满对话。`);
  return Object.freeze({ details: Object.freeze(details), omittedDetailCount });
}

function compatibilityUserReport(outcome, issues, isolatedComponents = []) {
  const { details, omittedDetailCount } = boundedUserDetails(issues);
  if (outcome === "normal") {
    return Object.freeze({
      headline: "实例变化兼容检查正常。",
      impact: "当前变化可以继续，未发现需要修复、迁移或隔离的组件问题。",
      dataSafety: "没有改写或删除任何实例内容。",
      details: Object.freeze([]),
      omittedDetailCount: 0,
      recommendation: "继续当前任务即可，不需要额外操作。",
      requiresUserDecision: false,
      sourceLanguage: "zh-CN",
      renderingPolicy: "render-in-the-current-user-language-without-dropping-impact-safety-or-next-step",
    });
  }
  const isolatedLabels = [...new Set(isolatedComponents.map((item) => stableId.test(item.id ?? "") ? item.id : "未命名组件项"))];
  const isolatedPreview = isolatedLabels.slice(0, 8).join("、");
  const isolated = isolatedComponents.length
    ? `已把 ${isolatedPreview}${isolatedLabels.length > 8 ? ` 等 ${isolatedLabels.length} 项` : ""} 限制在各自组件范围内；其他无关能力仍可继续。`
    : "没有扩大故障范围；未受影响的能力仍可继续。";
  const recommendation = outcome === "auto-repairable"
    ? "建议由当前 Agent 在本次已授权事务中完成这些确定性修复，回读通过后继续；无需为兼容登记重复确认。"
    : outcome === "migration-needed"
      ? "建议先在隔离候选中完成兼容迁移并重新检查；原实例继续可用。"
      : outcome === "component-isolated"
        ? "可以继续使用未受影响的功能；需要使用被隔离组件时，再按提示修复或重新登记该组件。"
        : "可以继续使用未受影响的功能；在安装、启用或正式切换涉及这部分内容前，请让当前 Agent 先展示一个只包含关键后果的选择。";
  return Object.freeze({
    headline: outcome === "auto-repairable" ? "发现可自动修复的兼容信息。"
      : outcome === "migration-needed" ? "发现需要兼容迁移的信息。"
        : outcome === "component-isolated" ? "一个或多个组件已被局部隔离。" : "发现一项需要用户决定的兼容问题。",
    impact: isolated,
    dataSafety: "原文件和用户数据保持原样；未知内容没有被执行、覆盖或删除。",
    details,
    omittedDetailCount,
    recommendation,
    requiresUserDecision: outcome === "user-decision-needed",
    sourceLanguage: "zh-CN",
    renderingPolicy: "render-in-the-current-user-language-without-dropping-impact-safety-or-next-step",
  });
}

function mutationCompatibilityUserReport(outcome, diagnostics, blockedPaths) {
  const { details, omittedDetailCount } = boundedUserDetails(diagnostics);
  return Object.freeze({
    headline: "当前变化中有一部分越过了声明的所有权边界。",
    impact: `只阻止 ${blockedPaths.length} 条冲突路径；其他路径、现有数据、对话和无关能力不受影响。`,
    dataSafety: "冲突路径没有被写入、覆盖或删除，原内容保持不变。",
    details,
    omittedDetailCount,
    recommendation: "建议由当前 Agent 把冲突内容改放到正式所有者、专业工作区或有界组件中，重新检查后继续。",
    requiresUserDecision: outcome === "user-decision-needed",
    sourceLanguage: "zh-CN",
    renderingPolicy: "render-in-the-current-user-language-without-dropping-impact-safety-or-next-step",
  });
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key) && !["__proto__", "prototype", "constructor"].includes(key));
}

function clean(value, maximum, allowEmpty = false) {
  return typeof value === "string" && (allowEmpty || value.length > 0) && [...value].length <= maximum
    && value.normalize("NFC") === value && !unsafeText.test(value);
}

function cleanList(value, maximumItems, validator) {
  return Array.isArray(value) && value.length <= maximumItems && new Set(value).size === value.length && value.every(validator);
}

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function portableSegment(part) {
  const base = part.replace(/\..*$/u, "").toLowerCase();
  return part && part !== "." && part !== ".." && !/[. ]$/u.test(part) && !/[<>"|*]/u.test(part)
    && !["con", "prn", "aux", "nul", "clock$"].includes(base) && !/^(?:com|lpt)[1-9]$/u.test(base);
}

function portableRef(value, { prefix = "", maximum = 240 } = {}) {
  if (!clean(value, maximum) || value.includes("\\") || value.includes(":") || value.includes("?") || value.includes("#")) return false;
  if (!value.split("/").every(portableSegment)) return false;
  return !prefix || value.startsWith(prefix);
}

function componentRelativeRef(value) {
  return portableRef(value, { maximum: 200 }) && !value.startsWith("instance/") && !value.startsWith(".assistant-");
}

function privateRef(value) {
  return clean(value, 240) && /^private:\/\/[a-z0-9][a-z0-9._:-]{0,159}\/[a-z0-9][a-z0-9._/-]{0,199}$/u.test(value)
    && !value.slice("private://".length).includes("//")
    && value.slice("private://".length).split("/").every((part) => part !== "." && part !== "..");
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function resolvePhysical(repositoryReal, ref, label, { allowMissing = false } = {}) {
  if (!portableRef(ref)) fail(`${label} has an unsafe path: ${ref}`);
  let cursor = repositoryReal;
  try {
    for (const part of ref.split("/")) {
      cursor = resolve(cursor, part);
      const info = lstatSync(cursor, { bigint: true });
      if (info.isSymbolicLink()) fail(`${label} crosses a link or reparse point: ${ref}`);
    }
  } catch (error) {
    if (String(error?.message ?? "").startsWith("Instance component contract failed:")) throw error;
    if (allowMissing && error?.code === "ENOENT") return null;
    fail(`${label} does not exist: ${ref}`);
  }
  const physical = realpathSync(cursor);
  const fromRoot = relative(repositoryReal, physical);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) fail(`${label} escapes AI Carry: ${ref}`);
  return physical;
}

function readBounded(repositoryReal, ref, label, maximum) {
  const path = resolvePhysical(repositoryReal, ref, label);
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) fail(`${label} is not a regular file or exceeds ${maximum} bytes`);
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== buffer.length || !sameIdentity(before, after)) fail(`${label} changed during its bounded read`);
    let decoded;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { fail(`${label} is not valid UTF-8`); }
    if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || buffer.includes(0) || decoded.includes("\r")) {
      fail(`${label} is not portable UTF-8 LF text`);
    }
    return Object.freeze({ text: decoded, sha256: digest(buffer), byteLength: buffer.length });
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedCompatible(repositoryReal, ref, label, maximum) {
  const path = resolvePhysical(repositoryReal, ref, label);
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) fail(`${label} is not a regular file or exceeds ${maximum} bytes`);
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== buffer.length || !sameIdentity(before, after)) fail(`${label} changed during its bounded read`);
    const hasBom = buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const content = hasBom ? buffer.subarray(3) : buffer;
    let decoded;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(content); }
    catch { fail(`${label} is not valid UTF-8`); }
    if (content.includes(0)) fail(`${label} contains a NUL byte`);
    const hasCr = decoded.includes("\r");
    const hasLoneCr = decoded.replaceAll("\r\n", "").includes("\r");
    if (hasLoneCr) fail(`${label} contains unsupported lone carriage returns`);
    return Object.freeze({
      text: decoded.replaceAll("\r\n", "\n"),
      sha256: digest(buffer),
      byteLength: buffer.length,
      formatIssues: Object.freeze([...(hasBom ? ["utf8-bom"] : []), ...(hasCr ? ["crlf"] : [])]),
    });
  } finally {
    closeSync(descriptor);
  }
}

function inspectInstanceIdentity(repository) {
  let repositoryReal;
  try { repositoryReal = realpathSync(repository); } catch { fail("AI Carry root does not exist"); }
  const instanceRead = readBounded(repositoryReal, "instance/manifest.toml", "instance manifest", 2560);
  const instance = validateInstanceManifestStructure(parseSectionedToml(instanceRead.text, "instance manifest"));
  return Object.freeze({ repositoryReal, instanceRead, instance });
}

function hashFileIdentity(path, relativeRef, hasher, budget) {
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) fail(`portable component path is not a regular file: ${relativeRef}`);
    if (before.size > BigInt(PORTABLE_FILE_LIMIT)) fail(`portable component file exceeds ${PORTABLE_FILE_LIMIT} bytes: ${relativeRef}`);
    if (budget) {
      budget.portableBytes += before.size;
      if (budget.portableBytes > BigInt(PORTABLE_TOTAL_LIMIT)) fail(`portable component inspection exceeds ${PORTABLE_TOTAL_LIMIT} bytes`);
    }
    hasher.update(`file\0${relativeRef}\0${before.size}\0`);
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0n;
    while (offset < before.size) {
      const wanted = Number(before.size - offset > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - offset);
      const count = readSync(descriptor, buffer, 0, wanted, null);
      if (count === 0) break;
      hasher.update(buffer.subarray(0, count));
      offset += BigInt(count);
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== before.size || !sameIdentity(before, after)) fail(`portable component path changed during hashing: ${relativeRef}`);
  } finally {
    closeSync(descriptor);
  }
}

function collectTree(repositoryReal, ref, { hashBytes, allowMissing = false, budget } = {}) {
  const rootPath = resolvePhysical(repositoryReal, ref, `declared component path ${ref}`, { allowMissing });
  if (!rootPath) return Object.freeze({ entries: Object.freeze([]), fingerprint: `missing:${ref}` });
  const hasher = createHash("sha256");
  const entries = [];
  const queue = [{ physical: rootPath, ref }];
  while (queue.length) {
    const current = queue.shift();
    if (budget && !budget.entries.has(current.ref)) {
      budget.entries.add(current.ref);
      if (budget.entries.size > ENTRY_LIMIT) fail(`component inspection exceeds ${ENTRY_LIMIT} unique entries`);
    }
    const info = lstatSync(current.physical, { bigint: true });
    if (info.isSymbolicLink()) fail(`declared component path crosses a link or reparse point: ${current.ref}`);
    if (info.isDirectory()) {
      hasher.update(`dir\0${current.ref}\0`);
      entries.push(current.ref);
      const children = readdirSync(current.physical, { withFileTypes: true }).sort((left, right) => ordinal(left.name.normalize("NFC"), right.name.normalize("NFC")));
      for (const child of children) {
        if (child.name.normalize("NFC") !== child.name || !portableSegment(child.name)) fail(`component tree has a non-portable entry: ${current.ref}/${child.name}`);
        queue.push({ physical: resolve(current.physical, child.name), ref: `${current.ref}/${child.name}` });
      }
    } else if (info.isFile()) {
      entries.push(current.ref);
      if (hashBytes) hashFileIdentity(current.physical, current.ref, hasher, budget);
      else hasher.update(`local\0${current.ref}\0${info.size}\0${info.mtimeNs}\0${info.ctimeNs}\0`);
    } else {
      fail(`component tree contains a non-regular entry: ${current.ref}`);
    }
  }
  return Object.freeze({ entries: Object.freeze(entries), fingerprint: hasher.digest("hex") });
}

function validateRegistry(parsed, instanceId, instanceState) {
  const expectedRoot = new Set(["schema_version", "record_type", "instance_id", "adoption_state", "revision", "component_count"]);
  if (!exactKeys(parsed.root, expectedRoot)
    || parsed.root.schema_version !== 1
    || !acceptedComponentRegistryRecordTypes.has(parsed.root.record_type)
    || parsed.root.instance_id !== instanceId
    || !adoptionStates.has(parsed.root.adoption_state)
    || !Number.isSafeInteger(parsed.root.revision) || parsed.root.revision < 0
    || !Number.isSafeInteger(parsed.root.component_count) || parsed.root.component_count !== parsed.entries.length
    || parsed.entries.length > COMPONENT_LIMIT) fail("component registry root, identity, count or budget is invalid");
  if (instanceState === "template" && (parsed.root.adoption_state !== "template" || parsed.entries.length !== 0)) fail("blank template component registry is not empty");
  if (instanceState === "instance" && parsed.root.adoption_state === "template") fail("instantiated component registry still claims template state");
  let previous = "";
  const expectedEntry = new Set(["id", "kind", "manifest_ref", "state"]);
  for (const entry of parsed.entries) {
    if (!exactKeys(entry, expectedEntry) || !stableId.test(entry.id ?? "") || !componentKinds.has(entry.kind)
      || !componentStates.has(entry.state) || entry.manifest_ref !== `instance/components/${entry.id}/component.toml`
      || (previous && ordinal(previous, entry.id) >= 0)) fail("component registry entries are malformed, duplicated or unsorted");
    previous = entry.id;
  }
  return parsed;
}

function validateManifest(parsed, entry, instanceId) {
  const sections = Object.keys(parsed);
  if (sections.length !== 4 || !["", "ownership", "interfaces", "upgrade"].every((name) => sections.includes(name))) fail(`component ${entry.id} has unknown or missing sections`);
  const root = parsed[""] ?? {};
  const ownership = parsed.ownership ?? {};
  const interfaces = parsed.interfaces ?? {};
  const upgrade = parsed.upgrade ?? {};
  if (!exactKeys(root, rootFields) || !exactKeys(ownership, ownershipFields) || !exactKeys(interfaces, interfaceFields) || !exactKeys(upgrade, upgradeFields)) fail(`component ${entry.id} has unknown or missing fields`);
  if (root.schema_version !== 1 || !acceptedComponentRecordTypes.has(root.record_type) || root.component_id !== entry.id
    || root.instance_id !== instanceId || root.kind !== entry.kind || root.status !== entry.state
    || !clean(root.title, 120) || !clean(root.summary, 500) || !semver.test(root.component_version ?? "")
    || root.root !== `instance/components/${entry.id}` || root.load_policy !== "on-demand-only") fail(`component ${entry.id} identity or root is invalid`);
  if (!cleanList(ownership.portable_paths, 128, componentRelativeRef) || !ownership.portable_paths.includes("component.toml")
    || !cleanList(ownership.derived_paths, 128, componentRelativeRef)
    || !cleanList(ownership.device_local_paths, 32, (value) => portableRef(value, { prefix: ".assistant-local/" }))
    || ownership.device_local_paths.some((value) => frameworkLocalPrefixes.some((prefix) => pathsOverlap(value, prefix.slice(0, -1))))
    || !cleanList(ownership.private_collection_refs, 32, privateRef)
    || ownership.unclassified_policy !== "stop-and-preview") fail(`component ${entry.id} ownership is invalid`);
  const allComponentPaths = [...ownership.portable_paths, ...ownership.derived_paths];
  for (let left = 0; left < allComponentPaths.length; left += 1) {
    for (let right = left + 1; right < allComponentPaths.length; right += 1) {
      if (pathsOverlap(allComponentPaths[left], allComponentPaths[right])) fail(`component ${entry.id} has overlapping portable or derived paths`);
    }
  }
  if (!cleanList(interfaces.provides, 32, (value) => interfaceId.test(value))
    || !cleanList(interfaces.requires, 32, (value) => interfaceId.test(value))
    || !hasAcceptedComponentInterface(interfaces.requires)) fail(`component ${entry.id} interface declaration is invalid`);
  if (!new Set(["optional", "required"]).has(upgrade.criticality) || !activations.has(upgrade.activation)
    || upgrade.compatible_action !== "preserve"
    || (upgrade.criticality === "optional" && upgrade.incompatible_action !== "disable-and-preserve")
    || (upgrade.criticality === "required" && upgrade.incompatible_action !== "stop-and-preserve")
    || !cleanList(upgrade.migration_ids, 32, (value) => stableId.test(value))
    || upgrade.second_run !== "no-change") fail(`component ${entry.id} upgrade declaration is invalid`);
  return Object.freeze({ root, ownership, interfaces, upgrade });
}

function parseComponentManifest(source, label) {
  const headers = [...source.matchAll(/^\[([^\]]+)\]\s*$/gmu)].map((match) => match[1]);
  if (JSON.stringify(headers) !== JSON.stringify(["ownership", "interfaces", "upgrade"])) {
    fail(`${label} has duplicated, missing, unknown or reordered sections`);
  }
  return parseSectionedToml(source, label);
}

function addFormatCompatibilityIssues(issues, read, { scope, path, componentId = "", criticality = "unknown" }) {
  for (const format of read.formatIssues) {
    issues.push(compatibilityIssue({
      code: format === "crlf" ? "portable-text-crlf" : "portable-text-bom",
      outcome: "auto-repairable",
      scope,
      path,
      componentId,
      criticality,
      notice: `${path} 使用了可兼容读取但不是规范写出的文本格式；当前内容未丢失，后续事务会规范为 UTF-8 无 BOM、LF。`,
      repair: "normalize-portable-text-without-changing-toml-values",
    }));
  }
}

function knownSection(source, allowed) {
  const result = Object.create(null);
  if (!source || typeof source !== "object" || Array.isArray(source)) return result;
  for (const [key, value] of Object.entries(source)) if (allowed.has(key)) result[key] = value;
  return result;
}

function compatibleManifest(parsed, source, entry, instanceId, issues) {
  const path = entry.manifest_ref;
  const componentId = entry.id;
  const headers = [...source.matchAll(/^\[([^\]]+)\]\s*$/gmu)].map((match) => match[1]);
  const expectedHeaders = ["ownership", "interfaces", "upgrade"];
  const unknownSections = Object.keys(parsed).filter((name) => !["", ...expectedHeaders].includes(name));
  if (unknownSections.length) {
    issues.push(compatibilityIssue({
      code: "unknown-component-sections",
      outcome: "migration-needed",
      scope: "component",
      path,
      componentId,
      notice: `组件 ${componentId} 含有当前版本不认识的章节；这些内容已原样保留且不会执行，已知所有权字段仍按当前 Schema 解析。`,
      repair: "preserve-unknown-sections-and-run-versioned-migration",
    }));
  }
  if (JSON.stringify(headers) !== JSON.stringify(expectedHeaders)) {
    const onlyKnownHeaders = headers.every((name) => expectedHeaders.includes(name));
    issues.push(compatibilityIssue({
      code: onlyKnownHeaders && new Set(headers).size === expectedHeaders.length ? "component-section-order" : "component-section-layout",
      outcome: onlyKnownHeaders && new Set(headers).size === expectedHeaders.length ? "auto-repairable" : "migration-needed",
      scope: "component",
      path,
      componentId,
      notice: onlyKnownHeaders && new Set(headers).size === expectedHeaders.length
        ? `组件 ${componentId} 的章节顺序不是规范写法；已按章节语义读取，后续事务可确定性规范化。`
        : `组件 ${componentId} 的章节布局与当前版本不同；未知布局已保留且不会被当作指令执行。`,
      repair: onlyKnownHeaders && new Set(headers).size === expectedHeaders.length
        ? "canonicalize-known-section-order"
        : "preserve-layout-and-run-versioned-migration",
    }));
  }
  const sections = [
    ["", rootFields],
    ["ownership", ownershipFields],
    ["interfaces", interfaceFields],
    ["upgrade", upgradeFields],
  ];
  const unknownFields = sections.flatMap(([name, allowed]) => Object.keys(parsed[name] ?? {})
    .filter((field) => !allowed.has(field)).map((field) => `${name || "root"}.${field}`));
  if (unknownFields.length) {
    issues.push(compatibilityIssue({
      code: "unknown-component-fields",
      outcome: "migration-needed",
      scope: "component",
      path,
      componentId,
      notice: `组件 ${componentId} 多出 ${unknownFields.length} 个当前版本不认识的字段；字段已保留但不会执行，不会因此停止整个 Agent。`,
      repair: "preserve-unknown-fields-and-run-versioned-migration",
    }));
  }

  const root = knownSection(parsed[""], rootFields);
  const ownership = knownSection(parsed.ownership, ownershipFields);
  const interfaces = knownSection(parsed.interfaces, interfaceFields);
  const upgrade = knownSection(parsed.upgrade, upgradeFields);
  const deterministicRepairs = [];
  if (root.instance_id !== instanceId) { root.instance_id = instanceId; deterministicRepairs.push("instance_id"); }
  const expectedRoot = `instance/components/${componentId}`;
  if (root.root !== expectedRoot) { root.root = expectedRoot; deterministicRepairs.push("root"); }
  if (root.load_policy !== "on-demand-only") { root.load_policy = "on-demand-only"; deterministicRepairs.push("load_policy"); }
  for (const field of ["derived_paths", "device_local_paths", "private_collection_refs"]) {
    if (!Object.hasOwn(ownership, field)) { ownership[field] = []; deterministicRepairs.push(`ownership.${field}`); }
  }
  if (Array.isArray(ownership.portable_paths) && !ownership.portable_paths.includes("component.toml")) {
    ownership.portable_paths = ["component.toml", ...ownership.portable_paths];
    deterministicRepairs.push("ownership.portable_paths");
  }
  if (ownership.unclassified_policy !== "stop-and-preview") {
    ownership.unclassified_policy = "stop-and-preview";
    deterministicRepairs.push("ownership.unclassified_policy");
  }
  if (Array.isArray(interfaces.requires) && !hasAcceptedComponentInterface(interfaces.requires)) {
    interfaces.requires = [PRODUCT_IDENTITY.componentInterface, ...interfaces.requires];
    deterministicRepairs.push("interfaces.requires");
  }
  if (upgrade.compatible_action !== "preserve") { upgrade.compatible_action = "preserve"; deterministicRepairs.push("upgrade.compatible_action"); }
  const expectedIncompatible = upgrade.criticality === "required" ? "stop-and-preserve" : "disable-and-preserve";
  if (["optional", "required"].includes(upgrade.criticality) && upgrade.incompatible_action !== expectedIncompatible) {
    upgrade.incompatible_action = expectedIncompatible;
    deterministicRepairs.push("upgrade.incompatible_action");
  }
  if (upgrade.second_run !== "no-change") { upgrade.second_run = "no-change"; deterministicRepairs.push("upgrade.second_run"); }
  if (deterministicRepairs.length) {
    issues.push(compatibilityIssue({
      code: "component-derived-metadata-drift",
      outcome: "auto-repairable",
      scope: "component",
      path,
      componentId,
      criticality: ["optional", "required"].includes(upgrade.criticality) ? upgrade.criticality : "unknown",
      notice: `组件 ${componentId} 有 ${deterministicRepairs.length} 项可从实例身份和安全默认值确定恢复的元数据；当前检查已按确定值继续，正式写回必须进入同一可回滚事务并再次回读。`,
      repair: `synchronize:${deterministicRepairs.join(",")}`,
    }));
  }
  return validateManifest({ "": root, ownership, interfaces, upgrade }, entry, instanceId);
}

function inspectComponentRoot(repositoryReal, entry, manifest, sourceParts, budget) {
  const rootRef = `instance/components/${entry.id}`;
  const rootPath = resolvePhysical(repositoryReal, rootRef, `component ${entry.id} root`);
  const rootInfo = lstatSync(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail(`component ${entry.id} root is not a physical directory`);
  const declared = [...manifest.ownership.portable_paths, ...manifest.ownership.derived_paths];
  const rootTree = collectTree(repositoryReal, rootRef, { hashBytes: false, budget });
  sourceParts.push(`${entry.id}:root:${rootTree.fingerprint}`);
  const unclassified = rootTree.entries
    .filter((value) => value !== rootRef)
    .map((value) => value.slice(rootRef.length + 1))
    .filter((value) => !declared.some((owner) => value === owner || value.startsWith(`${owner}/`))
      // A declared nested file needs container directories, not ownership of
      // every sibling. Only actual directories can serve as those ancestors.
      && !(declared.some((owner) => owner.startsWith(`${value}/`))
        && lstatSync(resolve(rootPath, ...value.split("/"))).isDirectory()));
  if (unclassified.length) fail(`component ${entry.id} has unclassified paths: ${unclassified.slice(0, 4).join(", ")}`);
  const portableFingerprints = [];
  for (const item of manifest.ownership.portable_paths) {
    const snapshot = collectTree(repositoryReal, `${rootRef}/${item}`, { hashBytes: true, budget });
    portableFingerprints.push(`${item}:${snapshot.fingerprint}`);
  }
  const derivedFingerprints = [];
  for (const item of manifest.ownership.derived_paths) {
    const snapshot = collectTree(repositoryReal, `${rootRef}/${item}`, { hashBytes: false, allowMissing: true, budget });
    derivedFingerprints.push(`${item}:${snapshot.fingerprint}`);
  }
  const localFingerprints = [];
  for (const item of manifest.ownership.device_local_paths) {
    const snapshot = collectTree(repositoryReal, item, { hashBytes: false, allowMissing: true, budget });
    localFingerprints.push(`${item}:${snapshot.fingerprint}`);
  }
  sourceParts.push(`${entry.id}:portable:${portableFingerprints.join("|")}`);
  sourceParts.push(`${entry.id}:derived:${derivedFingerprints.join("|")}`);
  sourceParts.push(`${entry.id}:local:${localFingerprints.join("|")}`);
  return Object.freeze({
    unclassified: Object.freeze(unclassified),
    portableFingerprints: Object.freeze(portableFingerprints),
    derivedFingerprints: Object.freeze(derivedFingerprints),
    localFingerprints: Object.freeze(localFingerprints),
  });
}

export function inspectInstanceComponents(repository) {
  const inspectionBudget = { entries: new Set(), portableBytes: 0n };
  const { repositoryReal, instanceRead, instance } = inspectInstanceIdentity(repository);
  const registryRead = readBounded(repositoryReal, REGISTRY_REF, "instance component registry", REGISTRY_LIMIT);
  const registry = validateRegistry(
    parseArrayTableDocument(registryRead.text, "components", "instance component registry"),
    instance.root.instance_id,
    instance.root.state,
  );
  const registeredIds = new Set(registry.entries.map((entry) => entry.id));
  const componentRoot = resolvePhysical(repositoryReal, "instance/components", "instance component root");
  const unregistered = [];
  for (const item of readdirSync(componentRoot, { withFileTypes: true })) {
    if (["README.md", "registry.toml"].includes(item.name)) continue;
    if (!item.isDirectory() || item.isSymbolicLink() || !registeredIds.has(item.name)) unregistered.push(`instance/components/${item.name}`);
  }
  const sourceParts = [`manifest:${instanceRead.sha256}`, `registry:${registryRead.sha256}`];
  const components = [];
  for (const entry of registry.entries) {
    const read = readBounded(repositoryReal, entry.manifest_ref, `component ${entry.id} manifest`, MANIFEST_LIMIT);
    const manifest = validateManifest(parseComponentManifest(read.text, `component ${entry.id} manifest`), entry, instance.root.instance_id);
    sourceParts.push(`${entry.id}:manifest:${read.sha256}`);
    const tree = inspectComponentRoot(repositoryReal, entry, manifest, sourceParts, inspectionBudget);
    components.push(Object.freeze({
      id: entry.id,
      kind: entry.kind,
      state: entry.state,
      provides: Object.freeze([...manifest.interfaces.provides]),
      requires: Object.freeze([...manifest.interfaces.requires]),
      portablePaths: Object.freeze([...manifest.ownership.portable_paths]),
      derivedPaths: Object.freeze([...manifest.ownership.derived_paths]),
      deviceLocalPaths: Object.freeze([...manifest.ownership.device_local_paths]),
      privateCollectionRefs: Object.freeze([...manifest.ownership.private_collection_refs]),
      criticality: manifest.upgrade.criticality,
      activation: manifest.upgrade.activation,
      incompatibleAction: manifest.upgrade.incompatible_action,
      migrationIds: Object.freeze([...manifest.upgrade.migration_ids]),
      tree,
    }));
  }
  for (let left = 0; left < components.length; left += 1) {
    for (let right = left + 1; right < components.length; right += 1) {
      for (const leftPath of components[left].deviceLocalPaths) {
        if (components[right].deviceLocalPaths.some((rightPath) => pathsOverlap(leftPath, rightPath))) {
          fail(`components ${components[left].id} and ${components[right].id} overlap device-local ownership`);
        }
      }
    }
  }
  sourceParts.push(`unregistered:${unregistered.sort(ordinal).join("|")}`);
  return Object.freeze({
    decision: unregistered.length ? "instance-components-conflict" : "instance-components-valid",
    instanceId: instance.root.instance_id,
    instanceState: instance.root.state,
    adoptionState: registry.root.adoption_state,
    revision: registry.root.revision,
    componentCount: components.length,
    components: Object.freeze(components),
    unregisteredPaths: Object.freeze(unregistered),
    sourceFingerprint: digest(Buffer.from(sourceParts.join("\n"), "utf8")),
    bodyReads: 0,
    executable: false,
  });
}

function compatibleRegistry(read, instance, issues) {
  addFormatCompatibilityIssues(issues, read, { scope: "registry", path: REGISTRY_REF });
  let parsed;
  try { parsed = parseArrayTableDocument(read.text, "components", "instance component registry"); }
  catch (error) {
    issues.push(compatibilityIssue({
      code: "registry-unreadable",
      outcome: "user-decision-needed",
      scope: "registry",
      path: REGISTRY_REF,
      notice: "组件登记表无法安全解析；它已保持原样，组件相关变化暂不启用，但实例的其他无关功能仍可继续。",
      repair: "preserve-and-reconstruct-from-bounded-component-manifests-in-isolated-candidate",
    }));
    return Object.freeze({ usable: false, root: Object.freeze({ adoption_state: "conflict", revision: 0 }), entries: Object.freeze([]), parseError: String(error?.message ?? error) });
  }
  const expectedRoot = new Set(["schema_version", "record_type", "instance_id", "adoption_state", "revision", "component_count"]);
  const unknownRoot = Object.keys(parsed.root).filter((field) => !expectedRoot.has(field));
  if (unknownRoot.length) {
    issues.push(compatibilityIssue({
      code: "unknown-registry-fields",
      outcome: "migration-needed",
      scope: "registry",
      path: REGISTRY_REF,
      notice: `组件登记表多出 ${unknownRoot.length} 个当前版本不认识的字段；字段已保留且不会执行，登记项仍按已知字段解析。`,
      repair: "preserve-unknown-fields-and-run-versioned-migration",
    }));
  }
  if (parsed.root.schema_version !== 1 || !acceptedComponentRegistryRecordTypes.has(parsed.root.record_type)) {
    issues.push(compatibilityIssue({
      code: "registry-schema-migration-required",
      outcome: "user-decision-needed",
      scope: "registry",
      path: REGISTRY_REF,
      notice: "组件登记表使用了当前版本不能确认的 Schema 或记录类型；原字节已保留，组件子系统暂时隔离，未受影响的实例功能仍可继续。",
      repair: "run-explicit-versioned-registry-migration",
    }));
    return Object.freeze({ usable: false, root: Object.freeze({ adoption_state: "conflict", revision: 0 }), entries: Object.freeze([]), parseError: "unsupported-schema" });
  }

  const root = { ...parsed.root };
  if (parsed.entries.length > COMPONENT_LIMIT) {
    issues.push(compatibilityIssue({
      code: "registry-component-budget",
      outcome: "user-decision-needed",
      scope: "registry",
      path: REGISTRY_REF,
      notice: `组件登记项超过 ${COMPONENT_LIMIT} 项的维护上限；未继续展开组件正文，原文件保持不变。`,
      repair: "review-component-scope-without-raising-the-startup-budget",
    }));
    return Object.freeze({ usable: false, root: Object.freeze(root), entries: Object.freeze([]), parseError: "component-budget" });
  }
  const deterministicRepairs = [];
  if (root.instance_id !== instance.root.instance_id) { root.instance_id = instance.root.instance_id; deterministicRepairs.push("instance_id"); }
  if (!Number.isSafeInteger(root.revision) || root.revision < 0) {
    root.revision = instance.root.state === "template" ? 0 : 1;
    deterministicRepairs.push("revision");
  }
  if (!adoptionStates.has(root.adoption_state)) {
    root.adoption_state = instance.root.state === "template" ? "template" : parsed.entries.length ? "required" : "current";
    if (instance.root.state === "instance" && parsed.entries.length) {
      issues.push(compatibilityIssue({
        code: "registry-adoption-state-migration",
        outcome: "migration-needed",
        scope: "registry",
        path: REGISTRY_REF,
        notice: "已有组件的纳管状态无法由一个字段值单独证明；已保留全部内容，需要在隔离候选重新闭合活跃资源后再写为 current。",
        repair: "recheck-complete-adoption-before-setting-current",
      }));
    } else deterministicRepairs.push("adoption_state");
  } else if (instance.root.state === "instance" && root.adoption_state === "template" && parsed.entries.length === 0) {
    root.adoption_state = "current";
    root.revision = Math.max(root.revision, 1);
    deterministicRepairs.push("adoption_state");
    if (!deterministicRepairs.includes("revision") && parsed.root.revision !== root.revision) deterministicRepairs.push("revision");
  }
  if (root.component_count !== parsed.entries.length) {
    root.component_count = parsed.entries.length;
    deterministicRepairs.push("component_count");
  }
  if (deterministicRepairs.length) {
    issues.push(compatibilityIssue({
      code: "registry-derived-metadata-drift",
      outcome: "auto-repairable",
      scope: "registry",
      path: REGISTRY_REF,
      notice: `组件登记表有 ${deterministicRepairs.length} 项可从严格实例身份和实际条目确定恢复的元数据；当前检查已按确定值继续，正式写回必须与当前变化同事务并回读。`,
      repair: `synchronize:${deterministicRepairs.join(",")}`,
    }));
  }

  const expectedEntry = new Set(["id", "kind", "manifest_ref", "state"]);
  const accepted = [];
  const blockedIds = new Set();
  const observedIds = [];
  for (const [index, entry] of parsed.entries.entries()) {
    const entryId = stableId.test(entry.id ?? "") ? entry.id : `registry-entry-${index + 1}`;
    const unknown = Object.keys(entry).filter((field) => !expectedEntry.has(field));
    if (unknown.length) {
      issues.push(compatibilityIssue({
        code: "unknown-registry-entry-fields",
        outcome: "migration-needed",
        scope: "component",
        path: REGISTRY_REF,
        componentId: entryId,
        notice: `组件 ${entryId} 的登记项多出 ${unknown.length} 个当前版本不认识的字段；字段已保留但不会执行。`,
        repair: "preserve-unknown-entry-fields-and-run-versioned-migration",
      }));
    }
    const valid = stableId.test(entry.id ?? "") && componentKinds.has(entry.kind) && componentStates.has(entry.state)
      && entry.manifest_ref === `instance/components/${entry.id}/component.toml`;
    if (!valid) {
      issues.push(compatibilityIssue({
        code: "malformed-registry-entry",
        outcome: "component-isolated",
        scope: "component",
        path: REGISTRY_REF,
        componentId: entryId,
        notice: `登记项 ${entryId} 的身份、类型、状态或清单路径无法安全确定；该项已原样保留并局部隔离，不影响其他组件和原生资产。`,
        repair: "repair-or-reregister-this-entry-without-deleting-its-files",
      }));
      continue;
    }
    observedIds.push(entry.id);
    if (accepted.some((item) => item.id === entry.id)) {
      blockedIds.add(entry.id);
      issues.push(compatibilityIssue({
        code: "duplicate-registry-entry",
        outcome: "component-isolated",
        scope: "component",
        path: REGISTRY_REF,
        componentId: entry.id,
        notice: `组件 ${entry.id} 在登记表中重复出现；所有原字节已保留，该组件已隔离，其他组件仍可继续检查。`,
        repair: "deduplicate-after-comparing-the-duplicate-entry-semantics",
      }));
      continue;
    }
    accepted.push(Object.freeze({ id: entry.id, kind: entry.kind, manifest_ref: entry.manifest_ref, state: entry.state }));
  }
  const sortedIds = [...observedIds].sort(ordinal);
  if (JSON.stringify(observedIds) !== JSON.stringify(sortedIds)) {
    issues.push(compatibilityIssue({
      code: "registry-entry-order",
      outcome: "auto-repairable",
      scope: "registry",
      path: REGISTRY_REF,
      notice: "组件登记项顺序不是规范写法；当前检查已按稳定 ID 排序读取，后续事务可确定性重排且不改变组件内容。",
      repair: "sort-registry-entries-by-stable-id",
    }));
  }
  const entries = accepted.filter((entry) => !blockedIds.has(entry.id)).sort((left, right) => ordinal(left.id, right.id));
  if (instance.root.state === "template" && (root.adoption_state !== "template" || parsed.entries.length !== 0)) {
    issues.push(compatibilityIssue({
      code: "template-registry-not-empty",
      outcome: "user-decision-needed",
      scope: "registry",
      path: REGISTRY_REF,
      notice: "空模板的组件区已经包含实例内容；内容已保留，不能把它当作干净模板继续实例化，但其他只读诊断仍可进行。",
      repair: "choose-the-intended-template-or-adopt-content-in-an-isolated-instance-candidate",
    }));
  }
  if (instance.root.state === "instance" && root.adoption_state === "template" && parsed.entries.length > 0) {
    root.adoption_state = "required";
    issues.push(compatibilityIssue({
      code: "registry-adoption-required",
      outcome: "migration-needed",
      scope: "registry",
      path: REGISTRY_REF,
      notice: "实例已有组件但登记表仍处于模板态；原组件可继续原样保留，需要在隔离候选完成一次兼容纳管后再宣称完整升级兼容。",
      repair: "perform-one-time-component-adoption-in-an-isolated-candidate",
    }));
  }
  return Object.freeze({ usable: true, root: Object.freeze(root), entries: Object.freeze(entries), parseError: "" });
}

export function inspectInstanceComponentCompatibility(repository) {
  const issues = [];
  const isolatedComponents = [];
  const inspectionBudget = { entries: new Set(), portableBytes: 0n };
  const { repositoryReal, instanceRead, instance } = inspectInstanceIdentity(repository);
  let registryRead;
  let registry;
  try {
    registryRead = readBoundedCompatible(repositoryReal, REGISTRY_REF, "instance component registry", REGISTRY_LIMIT);
    registry = compatibleRegistry(registryRead, instance, issues);
  } catch (error) {
    issues.push(compatibilityIssue({
      code: "registry-unavailable",
      outcome: "user-decision-needed",
      scope: "registry",
      path: REGISTRY_REF,
      notice: "组件登记表不存在、超限、编码损坏或读取期间发生变化；它没有被覆盖，组件相关操作已隔离，实例其他功能仍可继续。",
      repair: "preserve-the-existing-path-and-reconstruct-only-in-an-isolated-candidate",
    }));
    registryRead = Object.freeze({ sha256: `unavailable:${digest(Buffer.from(String(error?.message ?? error), "utf8"))}`, formatIssues: Object.freeze([]) });
    registry = Object.freeze({ usable: false, root: Object.freeze({ adoption_state: "conflict", revision: 0 }), entries: Object.freeze([]), parseError: "unavailable" });
  }
  for (const issue of issues.filter((item) => item.outcome === "component-isolated" && item.scope === "component" && item.componentId)) {
    isolatedComponents.push(Object.freeze({
      id: issue.componentId,
      path: issue.path,
      criticality: issue.criticality,
      reason: issue.code,
    }));
  }

  const registeredIds = new Set(registry.entries.map((entry) => entry.id));
  const unregistered = [];
  let unregisteredOverflow = 0;
  let componentRootFingerprint = "unavailable";
  let componentRootEntries = [];
  try {
    const componentRoot = resolvePhysical(repositoryReal, "instance/components", "instance component root");
    const rootInfo = lstatSync(componentRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("instance component root is not a physical directory");
    componentRootEntries = readdirSync(componentRoot, { withFileTypes: true })
      .sort((left, right) => ordinal(left.name.normalize("NFC"), right.name.normalize("NFC")));
    componentRootFingerprint = digest(Buffer.from(componentRootEntries.map((item) => `${item.name}\0${item.isDirectory() ? "d" : item.isFile() ? "f" : "o"}`).join("\n"), "utf8"));
    for (const item of componentRootEntries) {
      if (["README.md", "registry.toml"].includes(item.name)) continue;
      if (!item.isDirectory() || item.isSymbolicLink() || !registeredIds.has(item.name)) {
        if (unregistered.length < COMPONENT_LIMIT) unregistered.push(`instance/components/${item.name}`);
        else unregisteredOverflow += 1;
      }
    }
  } catch (error) {
    issues.push(compatibilityIssue({
      code: "component-root-unavailable",
      outcome: "user-decision-needed",
      scope: "registry",
      path: "instance/components",
      notice: "组件目录无法安全枚举；目录保持原样，组件操作暂时隔离，但不影响不依赖组件的实例功能。",
      repair: "inspect-the-component-root-without-following-links-before-changing-components",
    }));
  }
  if (componentRootEntries.length > COMPONENT_LIMIT + 2) {
    issues.push(compatibilityIssue({
      code: "component-root-budget",
      outcome: "user-decision-needed",
      scope: "registry",
      path: "instance/components",
      notice: `组件目录超过 ${COMPONENT_LIMIT} 个实例组件的维护上限；没有递归展开或删除任何目录。`,
      repair: "review-component-scope-in-an-isolated-candidate",
    }));
  }
  if (unregistered.length || unregisteredOverflow) {
    const unregisteredCount = unregistered.length + unregisteredOverflow;
    issues.push(compatibilityIssue({
      code: "unregistered-component-paths",
      outcome: "component-isolated",
      scope: "component",
      path: "instance/components",
      notice: `发现 ${unregisteredCount} 个未登记的组件路径；它们已原样保留且不会执行，已登记组件和原生实例内容仍可继续。`,
      repair: "classify-and-register-or-leave-disabled-without-deleting-content",
    }));
    for (const path of unregistered) isolatedComponents.push(Object.freeze({ id: path.slice("instance/components/".length), path, criticality: "unknown", reason: "unregistered" }));
  }

  const sourceParts = [`manifest:${instanceRead.sha256}`, `registry:${registryRead.sha256}`, `component-root:${componentRootFingerprint}`];
  const components = [];
  for (const entry of registry.entries) {
    let manifestRead;
    let parsed;
    let manifest;
    let criticality = "unknown";
    try {
      manifestRead = readBoundedCompatible(repositoryReal, entry.manifest_ref, `component ${entry.id} manifest`, MANIFEST_LIMIT);
      sourceParts.push(`${entry.id}:manifest:${manifestRead.sha256}`);
      addFormatCompatibilityIssues(issues, manifestRead, { scope: "component", path: entry.manifest_ref, componentId: entry.id });
      parsed = parseSectionedToml(manifestRead.text, `component ${entry.id} manifest`);
      criticality = ["optional", "required"].includes(parsed.upgrade?.criticality) ? parsed.upgrade.criticality : "unknown";
      manifest = compatibleManifest(parsed, manifestRead.text, entry, instance.root.instance_id, issues);
      const tree = inspectComponentRoot(repositoryReal, entry, manifest, sourceParts, inspectionBudget);
      components.push({
        id: entry.id,
        kind: entry.kind,
        state: entry.state,
        provides: Object.freeze([...manifest.interfaces.provides]),
        requires: Object.freeze([...manifest.interfaces.requires]),
        portablePaths: Object.freeze([...manifest.ownership.portable_paths]),
        derivedPaths: Object.freeze([...manifest.ownership.derived_paths]),
        deviceLocalPaths: Object.freeze([...manifest.ownership.device_local_paths]),
        privateCollectionRefs: Object.freeze([...manifest.ownership.private_collection_refs]),
        criticality: manifest.upgrade.criticality,
        activation: manifest.upgrade.activation,
        incompatibleAction: manifest.upgrade.incompatible_action,
        migrationIds: Object.freeze([...manifest.upgrade.migration_ids]),
        tree,
      });
    } catch (error) {
      sourceParts.push(`${entry.id}:isolated:${digest(Buffer.from(String(error?.message ?? error), "utf8"))}`);
      issues.push(compatibilityIssue({
        code: "component-isolated-after-validation",
        outcome: "component-isolated",
        scope: "component",
        path: entry.manifest_ref,
        componentId: entry.id,
        criticality,
        notice: `组件 ${entry.id} 的清单、所有权或文件树未通过安全检查；该组件已原样保留并局部隔离，其他组件与原生实例功能继续可用。`,
        repair: "repair-this-component-in-isolation-and-recheck-before-reactivation",
      }));
      isolatedComponents.push(Object.freeze({
        id: entry.id,
        path: entry.manifest_ref,
        criticality,
        reason: "validation",
        portablePaths: Object.freeze([...(manifest?.ownership?.portable_paths ?? [])]),
        derivedPaths: Object.freeze([...(manifest?.ownership?.derived_paths ?? [])]),
        deviceLocalPaths: Object.freeze([...(manifest?.ownership?.device_local_paths ?? [])]),
      }));
    }
  }

  const overlapIds = new Set();
  for (let left = 0; left < components.length; left += 1) {
    for (let right = left + 1; right < components.length; right += 1) {
      if (components[left].deviceLocalPaths.some((leftPath) => components[right].deviceLocalPaths.some((rightPath) => pathsOverlap(leftPath, rightPath)))) {
        overlapIds.add(components[left].id);
        overlapIds.add(components[right].id);
        issues.push(compatibilityIssue({
          code: "overlapping-device-local-ownership",
          outcome: "component-isolated",
          scope: "component",
          path: ".assistant-local",
          componentId: `${components[left].id},${components[right].id}`,
          notice: `组件 ${components[left].id} 与 ${components[right].id} 声明了重叠的本机所有权；两个组件都已隔离，重叠路径未被修改。`,
          repair: "separate-device-local-ownership-without-moving-user-data-until-reviewed",
        }));
      }
    }
  }
  for (const component of components.filter((item) => overlapIds.has(item.id))) {
    isolatedComponents.push(Object.freeze({
      id: component.id,
      path: `instance/components/${component.id}`,
      criticality: component.criticality,
      reason: "ownership-overlap",
      portablePaths: component.portablePaths,
      derivedPaths: component.derivedPaths,
      deviceLocalPaths: component.deviceLocalPaths,
    }));
  }
  const usableComponents = components.filter((item) => !overlapIds.has(item.id)).map((item) => Object.freeze(item));
  sourceParts.push(`unregistered:${unregistered.join("|")}:overflow:${unregisteredOverflow}`);
  sourceParts.push(`issues:${issues.map((issue) => `${issue.code}:${issue.componentId}`).join("|")}`);
  const outcome = compatibilityOutcome(issues);
  const repairPlan = issues.filter((issue) => issue.repair).map((issue) => Object.freeze({
    outcome: issue.outcome,
    scope: issue.scope,
    path: issue.path,
    componentId: issue.componentId,
    action: issue.repair,
  }));
  const frozenIssues = Object.freeze(issues);
  const isolatedById = new Map();
  for (const item of isolatedComponents) {
    const existing = isolatedById.get(item.id);
    if (!existing || (existing.criticality === "unknown" && item.criticality !== "unknown")) isolatedById.set(item.id, item);
  }
  const frozenIsolated = Object.freeze([...isolatedById.values()].sort((left, right) => ordinal(String(left.id), String(right.id))));
  return Object.freeze({
    decision: outcome === "normal" ? "instance-components-operational" : "instance-components-operational-with-diagnostics",
    outcome,
    instanceId: instance.root.instance_id,
    instanceState: instance.root.state,
    adoptionState: registry.root.adoption_state,
    revision: registry.root.revision,
    componentCount: usableComponents.length,
    registeredComponentCount: registry.entries.length,
    components: Object.freeze(usableComponents),
    isolatedComponents: frozenIsolated,
    unregisteredPaths: Object.freeze(unregistered),
    diagnostics: frozenIssues,
    repairPlan: Object.freeze(repairPlan),
    userReport: compatibilityUserReport(outcome, frozenIssues, frozenIsolated),
    sourceFingerprint: digest(Buffer.from(sourceParts.join("\n"), "utf8")),
    bodyReads: 0,
    executable: false,
  });
}

function coveredByComponent(component, ref) {
  const componentRoot = `instance/components/${component.id}`;
  if (ref === componentRoot || ref.startsWith(`${componentRoot}/`)) {
    const relativeRef = ref === componentRoot ? "" : ref.slice(componentRoot.length + 1);
    return (component.portablePaths ?? []).some((owner) => relativeRef === owner || relativeRef.startsWith(`${owner}/`))
      || (component.derivedPaths ?? []).some((owner) => relativeRef === owner || relativeRef.startsWith(`${owner}/`));
  }
  return (component.deviceLocalPaths ?? []).some((owner) => ref === owner || ref.startsWith(`${owner}/`));
}

export function classifyInstanceMutation(repository, { paths = [], componentId = "" } = {}) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 128 || new Set(paths).size !== paths.length
    || paths.some((value) => !portableRef(value))) fail("mutation path set is empty, duplicated, oversized or unsafe");
  if (componentId && !stableId.test(componentId)) fail("mutation component ID is invalid");
  const requiresComponentInspection = Boolean(componentId) || paths.some((ref) => ref.startsWith("instance/components/")
    || (ref.startsWith(".assistant-local/") && !frameworkLocalPrefixes.some((prefix) => ref.startsWith(prefix))));
  let inspection;
  if (requiresComponentInspection) inspection = inspectInstanceComponentCompatibility(repository);
  else {
    const { instanceRead } = inspectInstanceIdentity(repository);
    inspection = Object.freeze({
      outcome: "normal",
      components: Object.freeze([]),
      isolatedComponents: Object.freeze([]),
      diagnostics: Object.freeze([]),
      repairPlan: Object.freeze([]),
      sourceFingerprint: digest(Buffer.from(`manifest:${instanceRead.sha256}\nstatic-write-set\n${paths.join("\n")}`, "utf8")),
    });
  }
  const component = componentId ? inspection.components.find((item) => item.id === componentId) : null;
  const isolatedComponent = componentId ? inspection.isolatedComponents.find((item) => item.id === componentId) : null;
  const ownershipComponents = [...inspection.components, ...inspection.isolatedComponents.filter((item) => item.portablePaths || item.deviceLocalPaths)];
  const actions = paths.map((ref) => {
    const componentOwners = ownershipComponents.filter((item) => coveredByComponent(item, ref));
    const ownedBySelectedComponent = component && componentOwners.some((item) => item.id === component.id);
    if (templateRootFiles.has(ref) || templatePrefixes.some((prefix) => ref.startsWith(prefix))) return Object.freeze({ path: ref, action: "deny-template-core-direct-write" });
    if (ref === "instance/components/registry.toml" || ref === "instance/components/README.md") return Object.freeze({ path: ref, action: componentId ? "deny-registry-owner-mismatch" : "native-instance-metadata" });
    if (ref.startsWith("instance/components/")) return Object.freeze({ path: ref, action: ownedBySelectedComponent ? "registered-component" : "deny-unregistered-component-path" });
    if (ref.startsWith(".assistant-local/")) {
      if (ownedBySelectedComponent) return Object.freeze({ path: ref, action: "registered-device-local" });
      if (componentOwners.length) return Object.freeze({ path: ref, action: "deny-component-owner-mismatch" });
      if (!componentId && frameworkLocalPrefixes.some((prefix) => ref.startsWith(prefix))) return Object.freeze({ path: ref, action: "native-framework-local" });
      return Object.freeze({ path: ref, action: "deny-unregistered-device-local" });
    }
    if (nativeInstanceFiles.has(ref) || nativeInstancePrefixes.some((prefix) => ref.startsWith(prefix))) return Object.freeze({ path: ref, action: componentId ? "deny-native-owner-mismatch" : "native-instance-owner" });
    if (ref.startsWith("workspace/")) return Object.freeze({ path: ref, action: componentId ? "deny-professional-extension-owner-mismatch" : "delegate-professional-extension-contract" });
    if (ref.startsWith(".assistant-private/")) return Object.freeze({ path: ref, action: componentId ? "deny-private-owner-mismatch" : "delegate-private-asset-contract" });
    return Object.freeze({ path: ref, action: "deny-unowned-path" });
  });
  const conflict = actions.some((item) => item.action.startsWith("deny-"));
  const decision = isolatedComponent ? "instance-mutation-component-isolated"
    : componentId && !component ? "instance-mutation-component-unavailable"
      : conflict ? "instance-mutation-conflict" : "instance-mutation-compatible";
  const mutationIssues = actions.filter((item) => item.action.startsWith("deny-")).map((item) => compatibilityIssue({
    code: item.action,
    outcome: "component-isolated",
    scope: "mutation",
    path: item.path,
    componentId,
    notice: `当前变化中的 ${item.path} 不属于声明的写入所有者；只阻止这一路径，其他任务和数据保持不变。`,
    repair: "route-the-path-through-its-formal-owner-or-register-a-bounded-component",
  }));
  const diagnostics = Object.freeze([...inspection.diagnostics, ...mutationIssues]);
  const outcome = compatibilityOutcome(diagnostics);
  const userReport = mutationIssues.length
    ? mutationCompatibilityUserReport(outcome, diagnostics, mutationIssues.map((issue) => issue.path))
    : compatibilityUserReport(outcome, diagnostics, inspection.isolatedComponents);
  return Object.freeze({
    decision,
    componentId,
    actions: Object.freeze(actions),
    sourceFingerprint: inspection.sourceFingerprint,
    compatibilityOutcome: outcome,
    diagnostics,
    repairPlan: inspection.repairPlan,
    userReport,
    compatibilityRegistrationAddsConfirmation: false,
    executable: false,
  });
}

function validatedInterfaceSet(value, label) {
  if (!cleanList(value, 256, (item) => interfaceId.test(item))) fail(`${label} is invalid`);
  return new Set(value);
}

function validatedStableIdSet(value, label) {
  if (!cleanList(value, 256, (item) => stableId.test(item))) fail(`${label} is invalid`);
  return new Set(value);
}

export function planInstanceComponentUpgrade(repository, { targetInterfaces = [], migrationIds = [] } = {}) {
  const inspection = inspectInstanceComponentCompatibility(repository);
  const available = validatedInterfaceSet(targetInterfaces, "target interface set");
  const migrationSet = validatedStableIdSet(migrationIds, "migration ID set");
  const pending = inspection.components.filter((component) => component.state === "active");
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index].requires.every((required) => available.has(required))) {
        for (const provided of pending[index].provides) available.add(provided);
        pending.splice(index, 1);
        changed = true;
      }
    }
  }
  const unresolved = new Map(pending.map((component) => [component.id, component.requires.filter((required) => !available.has(required))]));
  const actions = inspection.components.map((component) => {
    if (component.state !== "active") return Object.freeze({ id: component.id, action: "preserve-disabled", missingInterfaces: Object.freeze([]), deviceLocalAction: "preserve-in-place" });
    const missing = unresolved.get(component.id) ?? [];
    if (!missing.length) return Object.freeze({ id: component.id, action: "preserve", missingInterfaces: Object.freeze([]), deviceLocalAction: component.deviceLocalPaths.length ? "preserve-in-place-and-reverify" : "none" });
    if (component.migrationIds.some((id) => migrationSet.has(id))) return Object.freeze({ id: component.id, action: "migrate-and-recheck", missingInterfaces: Object.freeze(missing), deviceLocalAction: "preserve-in-place" });
    return Object.freeze({ id: component.id, action: component.incompatibleAction, missingInterfaces: Object.freeze(missing), deviceLocalAction: "preserve-in-place" });
  });
  for (const component of inspection.isolatedComponents) {
    actions.push(Object.freeze({
      id: component.id,
      action: "isolate-and-preserve",
      missingInterfaces: Object.freeze([]),
      deviceLocalAction: "preserve-in-place",
      criticality: component.criticality,
    }));
  }
  const planIssues = [...inspection.diagnostics];
  if (inspection.instanceState === "instance" && inspection.adoptionState !== "current") {
    planIssues.push(compatibilityIssue({
      code: "upgrade-adoption-required",
      outcome: inspection.adoptionState === "conflict" ? "user-decision-needed" : "migration-needed",
      scope: "registry",
      path: REGISTRY_REF,
      notice: "当前实例尚未完成一次性组件纳管；升级只在隔离候选中暂停，原实例和日常使用不受影响。",
      repair: "complete-one-time-adoption-before-formal-switch",
    }));
  }
  for (const action of actions) {
    if (action.action === "migrate-and-recheck") {
      planIssues.push(compatibilityIssue({
        code: "component-interface-migration-required",
        outcome: "migration-needed",
        scope: "component",
        componentId: action.id,
        notice: `组件 ${action.id} 缺少目标母版接口，但存在明确迁移；先在隔离候选迁移并回读，原组件字节保持不变。`,
        repair: "run-declared-migration-and-recheck",
      }));
    } else if (action.action === "disable-and-preserve") {
      planIssues.push(compatibilityIssue({
        code: "optional-component-incompatible",
        outcome: "component-isolated",
        scope: "component",
        componentId: action.id,
        criticality: "optional",
        notice: `可选组件 ${action.id} 与目标母版不兼容；该组件会停用并原样保留，母版其他部分可以继续升级。`,
        repair: "disable-and-preserve-until-compatible",
      }));
    } else if (action.action === "stop-and-preserve") {
      planIssues.push(compatibilityIssue({
        code: "required-component-incompatible",
        outcome: "user-decision-needed",
        scope: "component",
        componentId: action.id,
        criticality: "required",
        notice: `必需组件 ${action.id} 与目标母版不兼容；只暂停正式切换并保留原实例，不会让当前 Agent 停止工作。`,
        repair: "repair-migrate-or-keep-current-instance-before-formal-switch",
      }));
    }
  }
  const unknownIsolation = inspection.isolatedComponents.some((item) => item.criticality === "unknown");
  const requiredIsolation = inspection.isolatedComponents.some((item) => item.criticality === "required");
  if (unknownIsolation) {
    planIssues.push(compatibilityIssue({
      code: "isolated-component-criticality-unknown",
      outcome: "user-decision-needed",
      scope: "component",
      notice: "至少一个被隔离组件的重要性无法安全确定；只暂停涉及它的正式升级切换，原实例与其他日常能力继续可用。",
      repair: "repair-or-classify-the-isolated-component-before-formal-switch",
    }));
  } else if (requiredIsolation) {
    planIssues.push(compatibilityIssue({
      code: "required-component-isolated",
      outcome: "user-decision-needed",
      scope: "component",
      notice: "至少一个必需组件处于隔离状态；只暂停正式升级切换并保留原实例，不中断当前 Agent。",
      repair: "repair-the-required-component-or-keep-the-current-instance",
    }));
  }
  const hasMigration = planIssues.some((issue) => issue.outcome === "migration-needed");
  const hasAutoRepair = planIssues.some((issue) => issue.outcome === "auto-repairable");
  const inspectionNeedsUserDecision = inspection.diagnostics.some((issue) => issue.outcome === "user-decision-needed");
  let decision = "instance-upgrade-compatible";
  if (inspectionNeedsUserDecision || unknownIsolation || inspection.adoptionState === "conflict") decision = "instance-upgrade-user-decision-required";
  else if (inspection.instanceState === "instance" && inspection.adoptionState !== "current") decision = "instance-upgrade-adoption-required";
  else if (actions.some((item) => item.action === "stop-and-preserve") || requiredIsolation) decision = "instance-upgrade-conflict";
  else if (actions.some((item) => item.action === "migrate-and-recheck") || hasMigration) decision = "instance-upgrade-migration-required";
  else if (hasAutoRepair) decision = "instance-upgrade-auto-repair-required";
  else if (inspection.isolatedComponents.length) decision = "instance-upgrade-compatible-with-isolated-components";
  const planOutcome = compatibilityOutcome(planIssues);
  const planIsolated = [
    ...inspection.isolatedComponents,
    ...actions.filter((item) => item.action === "disable-and-preserve").map((item) => Object.freeze({ id: item.id, criticality: "optional" })),
  ];
  return Object.freeze({
    decision,
    sourceFingerprint: inspection.sourceFingerprint,
    actions: Object.freeze(actions),
    unregisteredPaths: inspection.unregisteredPaths,
    compatibilityOutcome: planOutcome,
    diagnostics: Object.freeze(planIssues),
    repairPlan: inspection.repairPlan,
    userReport: compatibilityUserReport(planOutcome, planIssues, planIsolated),
    deviceLocalMigrationPolicy: "never-copy-or-delete-reverify-on-target-device",
    secondRun: "no-change",
    executable: false,
  });
}

export function instanceComponentPlanIsFresh(repository, plan) {
  if (!plan || typeof plan !== "object" || typeof plan.sourceFingerprint !== "string") return false;
  try { return inspectInstanceComponentCompatibility(repository).sourceFingerprint === plan.sourceFingerprint; }
  catch { return false; }
}
