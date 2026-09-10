#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArrayTableDocument, parseSectionedToml, stableAssetId } from "./asset-route-contract.mjs";
import { compareSkillPackages, createSkillDelivery, inspectSkillSource } from "./skill-package.mjs";
import { withOperationalUserReport } from "./operational-user-report.mjs";
import { containsForbiddenLocationReference } from "./safe-output-boundary.mjs";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const confirmationPattern = /^(skill-install\.[a-f0-9]{32})~([a-f0-9]{36})$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stableRead(path, maximum, label) {
  const absolute = realpathSync(resolve(path));
  const info = lstatSync(absolute, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.isReparsePoint?.() || info.size > BigInt(maximum)) {
    throw new Error(`${label}必须是一个可安全回读的本地普通文件`);
  }
  const descriptor = openSync(absolute, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== bytes.length || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`${label}在读取过程中发生了变化`);
    }
    return Object.freeze({ absolute, bytes, text: decoder.decode(bytes), digest: sha256(bytes) });
  } finally {
    closeSync(descriptor);
  }
}

function ensurePhysicalDirectory(root, ref) {
  let cursor = root;
  for (const part of ref.split("/")) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) {
      mkdirSync(cursor);
      continue;
    }
    const info = lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || info.isReparsePoint?.()) {
      throw new Error(`本机 Skill 目录不是可安全使用的物理目录：${ref}`);
    }
  }
  return cursor;
}

function cleanText(value, maximum, fallback = "") {
  const normalized = String(value ?? fallback).trim().normalize("NFC");
  if (!normalized || unsafeText.test(normalized)) throw new Error("Skill 展示信息为空或含不安全控制字符");
  const characters = [...normalized];
  return characters.length <= maximum ? normalized : `${characters.slice(0, maximum - 1).join("")}…`;
}

function q(value) { return JSON.stringify(value); }

function compareVersions(left, right) {
  if (!versionPattern.test(left ?? "") || !versionPattern.test(right ?? "")) return null;
  const a = left.split(".").map(Number); const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function loadInstanceState(root) {
  const manifestRead = stableRead(resolve(root, "instance/manifest.toml"), 2560, "实例清单");
  const manifest = parseSectionedToml(manifestRead.text, "instance manifest");
  const identity = manifest[""] ?? {};
  if (identity.schema_version !== 1 || !stableAssetId.test(identity.instance_id ?? "")
    || identity.instance_id === "template" || identity.state === "template") {
    throw new Error("当前目录还不是可登记 Skill 的正式实例；本次只暂停这个 Skill 的安装");
  }
  const requirementsPath = resolve(root, "instance/skills/requirements.toml");
  const requirementsRead = stableRead(requirementsPath, 32 * 1024, "Skill 小地图");
  if (requirementsRead.text.includes("\r") || requirementsRead.text.startsWith("\uFEFF")
    || locateHighConfidenceSecretCandidates(requirementsRead.text).blocked
    || containsForbiddenLocationReference(requirementsRead.text)) {
    throw new Error("Skill 小地图不是可安全增量更新的规范文本；原文件保持不变");
  }
  const parsed = parseArrayTableDocument(requirementsRead.text, "skills", "skill requirements");
  const lazyTemplateMap = parsed.root.instance_id === "template" && parsed.entries.length === 0;
  if (parsed.root.schema_version !== 1 || (!lazyTemplateMap && parsed.root.instance_id !== identity.instance_id) || parsed.entries.length >= 256) {
    throw new Error("Skill 小地图身份或容量不一致；原文件保持不变");
  }
  const ids = new Set();
  for (const entry of parsed.entries) {
    if (!stableAssetId.test(entry.id ?? "") || ids.has(entry.id)) throw new Error("Skill 小地图含重复或无效 ID；原文件保持不变");
    ids.add(entry.id);
  }
  if (!lazyTemplateMap) return Object.freeze({ instanceId: identity.instance_id, requirementsPath, requirementsRead, parsed, lazyInitialized: false });
  const initializedText = replaceRootField(
    replaceRootField(requirementsRead.text, "instance_id", identity.instance_id),
    "status",
    "current",
  );
  return Object.freeze({
    instanceId: identity.instance_id,
    requirementsPath,
    requirementsRead: Object.freeze({ ...requirementsRead, text: initializedText }),
    parsed: Object.freeze({ root: Object.freeze({ ...parsed.root, instance_id: identity.instance_id, status: "current" }), entries: parsed.entries }),
    lazyInitialized: true,
  });
}

function sourceIdentity(inspection) {
  const exactDigest = inspection.sourceKind === "zip" ? inspection.archiveDigest : inspection.sourceDigest;
  if (!digestPattern.test(exactDigest ?? "") || !digestPattern.test(inspection.sourceDigest ?? "")) {
    throw new Error("Skill 来源没有形成稳定摘要");
  }
  return Object.freeze({
    exactDigest,
    sourceRef: `shared-local-${inspection.sourceKind}:${exactDigest}`,
  });
}

function desiredRequirement(inspection, platform, confirmedAt = "") {
  const identity = sourceIdentity(inspection);
  const name = inspection.name;
  return Object.freeze({
    id: inspection.skillId || `skill.${name}`,
    title: cleanText(name, 160),
    summary: cleanText(inspection.description, 240),
    triggers: Object.freeze([cleanText(`使用 ${name}`, 80)]),
    platform: cleanText(platform || "current-host", 80),
    entry: `.assistant-local/skills/${name}/SKILL.md`,
    source: identity.sourceRef,
    version: inspection.version || "",
    content_digest: inspection.sourceDigest,
    state: "available",
    confirmed_at: confirmedAt,
  });
}

function inspectCurrentTarget(root, desired, sourceDigest) {
  const target = resolve(root, ...dirname(desired.entry).split("/"));
  if (!existsSync(target)) return Object.freeze({ target, exists: false, same: false });
  const info = lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink() || info.isReparsePoint?.()) {
    return Object.freeze({ target, exists: true, same: false, conflict: "同名安装位置不是物理目录" });
  }
  try {
    const current = inspectSkillSource(target);
    const same = current.decision === "ready" && current.sourceDigest === sourceDigest;
    return Object.freeze({ target, exists: true, same, inspection: current, contentDigest: current.sourceDigest,
      conflict: same ? "" : current.decision === "ready" ? "同名 Skill 已存在且内容不同" : "同名 Skill 需要复核" });
  } catch (error) {
    return Object.freeze({ target, exists: true, same: false, conflict: `同名 Skill 无法安全回读：${error.message}` });
  }
}

function assessInstall(root, state, inspection, platform) {
  const desired = desiredRequirement(inspection, platform);
  const matching = state.parsed.entries.filter((entry) => entry.id === desired.id);
  const entryCollision = state.parsed.entries.find((entry) => entry.entry === desired.entry && entry.id !== desired.id);
  const target = inspectCurrentTarget(root, desired, inspection.sourceDigest);
  if (entryCollision) return Object.freeze({ decision: "conflict", desired, target,
    reason: "安装入口已经被另一个 Skill ID 登记；不会猜测合并或覆盖" });
  if (matching.length === 1) {
    const current = matching[0];
    const compatible = current.entry === desired.entry && current.state === "available";
    if (!compatible) return Object.freeze({ decision: "conflict", desired, target,
      reason: "同一 Skill ID 已登记为不同入口或状态；旧条目保持不变" });
    if (target.same) return Object.freeze({ decision: "current", desired, target, existing: current });
    if (!target.exists || target.inspection?.decision !== "ready") return Object.freeze({ decision: "conflict", desired, target,
      reason: target.conflict || "已登记 Skill 的本机副本无法安全回读" });
    const registeredDigest = digestPattern.test(current.content_digest ?? "")
      ? current.content_digest
      : /^shared-local-folder:(sha256:[a-f0-9]{64})$/u.exec(current.source ?? "")?.[1] ?? "";
    if (!registeredDigest) return Object.freeze({ decision: "conflict", desired, target,
      reason: "旧登记缺少可核对的内容摘要；先复核当前本机副本，再决定是否采用新版" });
    if (registeredDigest !== target.contentDigest) return Object.freeze({ decision: "conflict", desired, target,
      reason: "已安装 Skill 在上次登记后发生了本地变化；不会用共享新版静默覆盖这些变化" });
    const currentSkillId = target.inspection.skillId || current.id;
    const currentVersion = current.version || target.inspection.version;
    if (!inspection.skillId || !inspection.version || currentSkillId !== inspection.skillId
      || !versionPattern.test(currentVersion ?? "") || (current.version && current.version !== target.inspection.version)) {
      return Object.freeze({ decision: "conflict", desired, target,
        reason: "两份 Skill 缺少一致的共享身份或版本；不能只凭同名猜测升级" });
    }
    const order = compareVersions(inspection.version, currentVersion);
    if (order === 0) return Object.freeze({ decision: "conflict", desired, target,
      reason: "同一版本出现不同字节；不会猜测哪一份才是正式内容" });
    if (order < 0) return Object.freeze({ decision: "conflict", desired, target,
      reason: `导入包版本 ${inspection.version} 早于已安装版本 ${currentVersion}；不会把降级当成升级` });
    const diff = compareSkillPackages(target.target, inspection.packageRoot);
    return Object.freeze({ decision: "upgrade", desired, target, existing: current,
      previousVersion: currentVersion, nextVersion: inspection.version, diff });
  }
  if (target.exists && !target.same) return Object.freeze({ decision: "conflict", desired, target, reason: target.conflict });
  return Object.freeze({ decision: "ready", desired, target, targetAlreadyPresent: target.same });
}

function replaceRootField(source, field, value) {
  const lines = source.split("\n");
  const boundary = lines.findIndex((line) => line.trim() === "[[skills]]");
  const end = boundary < 0 ? lines.length : boundary;
  const matches = [];
  for (let index = 0; index < end; index += 1) {
    if (new RegExp(`^${field}\\s*=`).test(lines[index].trim())) matches.push(index);
  }
  if (matches.length > 1) throw new Error(`Skill 小地图重复了 ${field}`);
  const line = `${field} = ${q(value)}`;
  if (matches.length === 1) lines[matches[0]] = line;
  else lines.splice(end, 0, line);
  return lines.join("\n");
}

function requirementFields(desired, confirmedAt) {
  return [
    ["id", desired.id],
    ["title", desired.title],
    ["summary", desired.summary],
    ["triggers", desired.triggers],
    ["platform", desired.platform],
    ["entry", desired.entry],
    ["source", desired.source],
    ...(desired.version ? [["version", desired.version]] : []),
    ["content_digest", desired.content_digest],
    ["state", desired.state],
    ["confirmed_at", confirmedAt],
  ];
}

function replaceSkillEntry(source, entryIndex, fields) {
  const lines = source.split("\n");
  const starts = lines.flatMap((line, index) => line.trim() === "[[skills]]" ? [index] : []);
  if (entryIndex < 0 || entryIndex >= starts.length) throw new Error("Skill 小地图无法定位需要更新的现有条目");
  const start = starts[entryIndex]; const end = starts[entryIndex + 1] ?? lines.length;
  const block = lines.slice(start, end);
  for (const [field, value] of fields) {
    const matches = block.flatMap((line, index) => new RegExp(`^${field}\\s*=`).test(line.trim()) ? [index] : []);
    if (matches.length > 1) throw new Error(`Skill 条目重复了 ${field}`);
    const next = `${field} = ${q(value)}`;
    if (matches.length === 1) block[matches[0]] = next;
    else block.push(next);
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

function requirementsSource(state, desired, confirmedAt) {
  let source = replaceRootField(state.requirementsRead.text, "generated_at", confirmedAt);
  source = replaceRootField(source, "status", "current");
  const existingIndex = state.parsed.entries.findIndex((entry) => entry.id === desired.id);
  if (existingIndex >= 0) return replaceSkillEntry(source, existingIndex, requirementFields(desired, confirmedAt));
  if (!source.endsWith("\n")) source += "\n";
  if (!source.endsWith("\n\n")) source += "\n";
  source += ["[[skills]]", ...requirementFields(desired, confirmedAt).map(([field, value]) => `${field} = ${q(value)}`), ""].join("\n");
  return source;
}

function runtimePaths(root, challengeId) {
  const runtime = ensurePhysicalDirectory(root, ".assistant-local/runtime/skill-install");
  return Object.freeze({
    runtime,
    record: resolve(runtime, `${challengeId}.json`),
    inspection: resolve(runtime, `${challengeId}.inspection`),
    candidate: resolve(runtime, `${challengeId}.candidate-package`),
    requirementsCandidate: resolve(runtime, `${challengeId}.requirements.candidate.toml`),
    requirementsPreimage: resolve(runtime, `${challengeId}.requirements.preimage.toml`),
    previousPackage: resolve(runtime, `${challengeId}.previous-package`),
    failedPackage: resolve(runtime, `${challengeId}.failed-package`),
    failedRequirements: resolve(runtime, `${challengeId}.failed-requirements.toml`),
  });
}

function readRecord(root, challengeId) {
  const paths = runtimePaths(root, challengeId);
  const record = JSON.parse(stableRead(paths.record, 32 * 1024, "Skill 安装确认回执").text);
  if (record.challenge_id !== challengeId || !digestPattern.test(record.source_digest ?? "")
    || !digestPattern.test(record.requirements_preimage_digest ?? "") || !stableAssetId.test(record.instance_id ?? "")
    || !["install", "upgrade"].includes(record.operation)) {
    throw new Error("Skill 安装确认回执不完整或不属于当前预览");
  }
  return Object.freeze({ record, paths });
}

function userPreview(sourcePath, inspection, assessment) {
  const { desired, target } = assessment;
  const operation = assessment.decision === "upgrade" ? "升级" : "安装";
  const versionLine = assessment.decision === "upgrade"
    ? `版本变化：${assessment.previousVersion} → ${assessment.nextVersion}`
    : inspection.version ? `版本：${inspection.version}` : "版本：共享包未声明；本次按旧版兼容安装，不会据此自动升级";
  const changeLines = assessment.decision === "upgrade" ? [
    `新增文件：${assessment.diff.added.length ? assessment.diff.added.join("、") : "0"}`,
    `修改文件：${assessment.diff.changed.length ? assessment.diff.changed.join("、") : "0"}`,
    `移除文件：${assessment.diff.removed.length ? assessment.diff.removed.join("、") : "0"}`,
  ] : [];
  return [
    `准备${operation} Skill：${desired.title}`,
    versionLine,
    ...changeLines,
    `用途与触发边界：${inspection.description}`,
    `准确来源：${sourcePath}`,
    `本机位置：${target.target}`,
    `包内脚本：${inspection.scripts.length ? inspection.scripts.join("、") : "没有"}`,
    "本次不会执行脚本、安装依赖、联网、登录或修改权限。",
    assessment.decision === "upgrade"
      ? "确认后只替换这一份 Skill：旧版先移入可回退前像，再提交新版、更新登记并逐字节回读。"
      : "确认后只会复制这一个已检查的包、逐字节回读，并把入口登记到当前实例的小地图。",
    "如果复制或登记失败，只回退这一项；原包、其他 Skill、普通对话和 AI Carry 其他能力继续可用。",
    "若本机副本、登记表或来源在确认前发生变化，会停止这一次操作并要求重新预览。",
    `如果同意，请回复“${operation}”。`,
  ].join("\n\n");
}

export function prepareSkillInstall(rootPath, sourcePath, { platform = "current-host" } = {}) {
  const root = realpathSync(resolve(rootPath));
  const state = loadInstanceState(root);
  const challengeId = `skill-install.${randomBytes(16).toString("hex")}`;
  const challengeNonce = randomBytes(18).toString("hex");
  const paths = runtimePaths(root, challengeId);
  const source = resolve(sourcePath);
  const inspection = inspectSkillSource(source, { extractTo: paths.inspection });
  const identity = sourceIdentity(inspection);
  if (inspection.decision !== "ready") return Object.freeze({
    decision: `skill-install-${inspection.decision}`, executable: false, affectedScope: "only-this-skill",
    sourceKind: inspection.sourceKind, sourceDigest: identity.exactDigest, packageName: inspection.name,
    issues: inspection.issues, scripts: inspection.scripts, originalSourcePreserved: true,
    userSummary: inspection.decision === "review"
      ? "这个 Skill 已保持原样并停在复核，不会因为格式之外的疑点被自动改写或安装。"
      : "这个 Skill 已局部隔离，没有执行其中内容，也没有影响 AI Carry 其他能力。",
    nextStep: "让 Agent 只解释这一个 Skill 的具体检查项；确认来源或内容前不要安装。",
  });
  const assessment = assessInstall(root, state, inspection, platform);
  if (assessment.decision === "current") return Object.freeze({
    decision: "skill-install-already-current", executable: false, updated: false,
    skillId: assessment.desired.id, target: assessment.desired.entry, sourceDigest: identity.exactDigest,
    userSummary: "这个 Skill 已按相同字节安装并登记，本次没有重复复制、刷新时间或执行脚本。",
    nextStep: "可以直接在匹配的任务中使用它；需要软件或权限时再单独说明和确认。",
  });
  if (assessment.decision === "conflict") return Object.freeze({
    decision: "skill-install-review-required", executable: false, affectedScope: "only-this-skill",
    reason: assessment.reason, skillId: assessment.desired.id, target: assessment.desired.entry,
    userSummary: "同名 Skill 或入口与这次来源不一致；现有可用版本和新包都保持原样，没有覆盖。",
    nextStep: "让 Agent 只比较同名两份 Skill 的来源和用途，再由你决定保留旧版、并存改名或替换。",
  });
  const operation = assessment.decision === "upgrade" ? "upgrade" : "install";
  const record = {
    schema_version: 1,
    challenge_id: challengeId,
    challenge_nonce: challengeNonce,
    operation,
    instance_id: state.instanceId,
    source_path: source,
    source_kind: inspection.sourceKind,
    source_digest: inspection.sourceDigest,
    exact_source_digest: identity.exactDigest,
    archive_digest: inspection.archiveDigest ?? "",
    package_name: inspection.name,
    description: inspection.description,
    scripts: inspection.scripts,
    package_root: inspection.packageRoot,
    platform: assessment.desired.platform,
    skill_id: assessment.desired.id,
    target_ref: assessment.desired.entry,
    source_ref: assessment.desired.source,
    version: assessment.desired.version,
    previous_version: assessment.previousVersion ?? "",
    previous_content_digest: assessment.target.contentDigest ?? "",
    diff: assessment.diff ?? { added: [], changed: [], removed: [], unchanged: [] },
    requirements_preimage_digest: state.requirementsRead.digest,
    target_already_present: assessment.targetAlreadyPresent,
    issued_at: new Date().toISOString(),
  };
  writeFileSync(paths.record, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  const confirmationRef = `${challengeId}~${challengeNonce}`;
  return Object.freeze({
    decision: operation === "upgrade" ? "skill-upgrade-confirmation-required" : "skill-install-confirmation-required", executable: false,
    operation,
    confirmationRef, skillId: assessment.desired.id, packageName: inspection.name,
    previousVersion: assessment.previousVersion ?? "", nextVersion: assessment.nextVersion ?? inspection.version ?? "",
    diff: assessment.diff ?? undefined,
    sourceKind: inspection.sourceKind, sourceDigest: identity.exactDigest, contentDigest: inspection.sourceDigest,
    scripts: inspection.scripts, issues: inspection.issues, target: assessment.desired.entry,
    originalSourcePreserved: true, isolatedInspection: inspection.isolationRoot ?? "",
    userPreview: userPreview(source, inspection, assessment),
    confirmCommand: `node dashboard/scripts/skill-install-cli.mjs confirm --root ${q(root)} --confirmation-ref ${q(confirmationRef)} --choice ${operation} --user-reply ${q("<用户刚才的原话>")}`,
    confirmationGuidance: "用户可以自然回复。Agent 只在用户明确同意当前预览、没有歧义或未解决条件时传入 --choice 和原话；拒绝、附带新条件或要求改动时不执行，先处理该点。程序核对预览与写入边界，不代替 Agent 判断语义。",
    nextStep: "展示预览，用户明确同意后执行 confirmCommand 并保留原话；有歧义或未解决条件时先澄清，不要求复述固定口令，也不让用户填写内部字段。",
  });
}

function parseConfirmationRef(value) {
  const match = confirmationPattern.exec(String(value ?? ""));
  if (!match) throw new Error("确认引用无效；请复用刚才安装预览返回的 confirmationRef");
  return Object.freeze({ challengeId: match[1], nonce: match[2] });
}

function defaultSnapshotSync(root) {
  const result = spawnSync(process.execPath, [resolve(root, "dashboard/scripts/sync-snapshot.mjs")], {
    cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error((result.stderr || result.stdout || result.error?.message || "快照同步无法启动").trim());
  return JSON.parse(result.stdout.trim());
}

function verifyInstalled(root, state, record) {
  const refreshed = loadInstanceState(root);
  const entries = refreshed.parsed.entries.filter((entry) => entry.id === record.skill_id);
  if (entries.length !== 1 || entries[0].entry !== record.target_ref || entries[0].source !== record.source_ref
    || entries[0].state !== "available" || entries[0].content_digest !== record.source_digest
    || (record.version && entries[0].version !== record.version)) throw new Error("Skill 小地图没有逐字回读到本次登记");
  const target = resolve(root, ...dirname(record.target_ref).split("/"));
  const inspection = inspectSkillSource(target);
  if (inspection.decision !== "ready" || inspection.sourceDigest !== record.source_digest) {
    throw new Error("已安装 Skill 与预览包字节不一致");
  }
  return Object.freeze({ refreshed, inspection, target });
}

export function confirmSkillInstall(rootPath, confirmationRef, userReply, {
  choice = "",
  syncSnapshot = defaultSnapshotSync,
  testFaultAfterTargetCommit = false,
} = {}) {
  const root = realpathSync(resolve(rootPath));
  const confirmation = parseConfirmationRef(confirmationRef);
  const loaded = readRecord(root, confirmation.challengeId);
  const { record, paths } = loaded;
  if (record.challenge_nonce !== confirmation.nonce) throw new Error("确认引用与安装预览不一致");
  const accepted = record.operation === "upgrade"
    ? new Set(["升级", "确认升级", "开始升级", "upgrade", "confirm"])
    : new Set(["安装", "确认安装", "开始安装", "install", "confirm"]);
  const reply = String(userReply ?? "").trim();
  const literal = reply.toLocaleLowerCase("zh-CN");
  if (!reply || (choice && choice !== record.operation)
    || ["不安装", "不升级", "取消", "拒绝", "no", "cancel"].includes(literal)
    || (record.operation === "upgrade" ? ["安装", "install"] : ["升级", "upgrade"]).includes(literal)) {
    throw new Error("选择与当前预览或用户原话冲突；这项 Skill 保持原样");
  }
  if (!choice && !accepted.has(literal)) throw new Error("请 Agent 根据当前预览理解用户原话；仅明确同意且没有未解决条件时传入 --choice install 或 upgrade，不能猜测同意");
  const state = loadInstanceState(root);
  if (state.instanceId !== record.instance_id) throw new Error("实例身份已经变化；这次安装预览已失效");
  const recheckPath = resolve(paths.runtime, `${record.challenge_id}.recheck-${randomBytes(4).toString("hex")}`);
  const inspection = inspectSkillSource(record.source_path, { extractTo: recheckPath });
  const identity = sourceIdentity(inspection);
  if (inspection.decision !== "ready" || inspection.sourceDigest !== record.source_digest
    || identity.exactDigest !== record.exact_source_digest || inspection.name !== record.package_name) {
    return Object.freeze({
      decision: "skill-install-review-required", executable: false, affectedScope: "only-this-skill",
      reason: "Skill 来源字节、名称或检查结论在确认前发生了变化；旧预览不会继续执行",
      originalSourcePreserved: true,
      nextStep: "让 Agent 重新检查当前包并展示一份新的安装预览。",
    });
  }
  const assessment = assessInstall(root, state, inspection, record.platform);
  if (assessment.decision === "current") return Object.freeze({
    decision: "skill-install-already-current", executable: false, updated: false,
    skillId: record.skill_id, target: record.target_ref, sourceDigest: record.exact_source_digest,
    scriptsExecuted: false, dependenciesInstalled: false,
    userSummary: "这个 Skill 已经按相同字节安装并登记，本次确认没有重复写入。",
    nextStep: "可以继续原任务并在真正命中时使用它。",
  });
  if (assessment.decision === "conflict") return Object.freeze({
    decision: "skill-install-review-required", executable: false, affectedScope: "only-this-skill",
    reason: assessment.reason, userSummary: "确认前出现同名冲突；旧 Skill 和新包都保持原样，没有覆盖。",
    nextStep: "让 Agent 只比较冲突的两份 Skill，再由你决定如何处理。",
  });
  const expectedAssessment = record.operation === "upgrade" ? "upgrade" : "ready";
  if (assessment.decision !== expectedAssessment || assessment.desired.id !== record.skill_id
    || assessment.desired.entry !== record.target_ref || assessment.desired.source !== record.source_ref
    || assessment.desired.version !== record.version
    || (record.operation === "upgrade" && (assessment.previousVersion !== record.previous_version
      || assessment.target.contentDigest !== record.previous_content_digest))) {
    return Object.freeze({
      decision: "skill-install-review-required", executable: false, affectedScope: "only-this-skill",
      reason: "Skill 的当前版本、共享身份、入口或升级关系在确认前发生了变化；旧预览不会继续执行",
      nextStep: "让 Agent 重新检查当前包并展示新的安装或升级预览。",
    });
  }
  if (state.requirementsRead.digest !== record.requirements_preimage_digest) return Object.freeze({
    decision: "skill-install-review-required", executable: false, affectedScope: "only-this-skill",
    reason: "Skill 小地图在预览后发生了变化；为避免覆盖其他刚完成的登记，本次预览已停止",
    nextStep: "重新运行 prepare；其他已经登记的 Skill 不受影响。",
  });

  const confirmedAt = new Date().toISOString();
  const desired = desiredRequirement(inspection, record.platform, confirmedAt);
  const nextRequirements = requirementsSource(state, desired, confirmedAt);
  if ([paths.candidate, paths.requirementsCandidate, paths.requirementsPreimage,
    paths.previousPackage, paths.failedPackage, paths.failedRequirements].some(existsSync)) {
    return Object.freeze({
      decision: "skill-install-recovery-required", executable: false, affectedScope: "only-this-skill",
      reason: "这条安装已有候选、前像或失败现场，产品不会覆盖恢复证据",
      recoveryScene: paths.runtime,
      nextStep: "让 Agent 只检查这一条 Skill 安装现场并推荐继续或回退。",
    });
  }
  let targetInstalled = false; let previousTargetMoved = false;
  let requirementsMoved = false; let requirementsInstalled = false;
  try {
    if (record.operation === "upgrade" || !assessment.targetAlreadyPresent) {
      const delivery = createSkillDelivery(inspection.packageRoot, { format: "folder", outputPath: paths.candidate });
      if (delivery.sourceDigest !== record.source_digest) throw new Error("候选 Skill 与预览内容摘要不一致");
      if (record.operation === "upgrade") {
        renameSync(assessment.target.target, paths.previousPackage);
        previousTargetMoved = true;
      }
      renameSync(paths.candidate, assessment.target.target);
      targetInstalled = true;
    }
    if (testFaultAfterTargetCommit) throw new Error("injected failure after Skill package commit");
    writeFileSync(paths.requirementsCandidate, nextRequirements, { flag: "wx" });
    if (stableRead(paths.requirementsCandidate, 32 * 1024, "Skill 小地图候选").text !== nextRequirements) {
      throw new Error("Skill 小地图候选没有逐字回读一致");
    }
    renameSync(state.requirementsPath, paths.requirementsPreimage);
    requirementsMoved = true;
    renameSync(paths.requirementsCandidate, state.requirementsPath);
    requirementsInstalled = true;
    verifyInstalled(root, state, record);
  } catch (error) {
    let rollbackComplete = true;
    try {
      if (requirementsInstalled && existsSync(state.requirementsPath)) renameSync(state.requirementsPath, paths.failedRequirements);
      if (requirementsMoved && existsSync(paths.requirementsPreimage)) renameSync(paths.requirementsPreimage, state.requirementsPath);
      if (targetInstalled && existsSync(assessment.target.target)) renameSync(assessment.target.target, paths.failedPackage);
      if (previousTargetMoved && existsSync(paths.previousPackage)) renameSync(paths.previousPackage, assessment.target.target);
    } catch { rollbackComplete = false; }
    return Object.freeze({
      decision: rollbackComplete ? "skill-install-failed-rolled-back" : "skill-install-recovery-required",
      executable: false, affectedScope: "only-this-skill", reason: error.message,
      existingSkillsPreserved: true, recoveryScene: paths.runtime,
      userSummary: rollbackComplete
        ? `这个 Skill 没有${record.operation === "upgrade" ? "升级" : "安装"}成功，但本机副本和登记表已经回到操作前；失败包和证据保留，其他能力仍可继续。`
        : `这个 Skill ${record.operation === "upgrade" ? "升级" : "安装"}没有被当作完成，恢复证据已保留；其他独立能力仍可继续。`,
      nextStep: rollbackComplete
        ? "修正这一项后重新预览，不需要重建或停止整个实例。"
        : "让 Agent 只检查这条安装的前像和失败现场，不要删除恢复材料。",
    });
  }

  let snapshot;
  try {
    snapshot = syncSnapshot(root);
  } catch (error) {
    return Object.freeze({
      decision: "skill-install-complete-snapshot-refresh-pending", executable: false, updated: true,
      skillId: record.skill_id, target: record.target_ref, sourceDigest: record.exact_source_digest,
      scriptsExecuted: false, dependenciesInstalled: false, originalSourcePreserved: true,
      reason: error.message,
      userSummary: "Skill 已复制、回读并登记成功；只有看板派生快照暂未刷新，Agent 和已安装 Skill 仍可使用。",
      nextStep: "让 Agent 只重试快照同步；不要重复安装或覆盖这个 Skill。",
    });
  }
  return Object.freeze({
    decision: record.operation === "upgrade" ? "skill-upgrade-complete" : "skill-install-complete", executable: false, updated: true,
    operation: record.operation,
    skillId: record.skill_id, title: desired.title, summary: desired.summary, target: record.target_ref,
    previousVersion: record.previous_version, version: record.version,
    diff: record.operation === "upgrade" ? record.diff : undefined,
    sourceKind: record.source_kind, sourceDigest: record.exact_source_digest, contentDigest: record.source_digest,
    requirementsRegistered: true, installedReadback: true, snapshot,
    scripts: record.scripts, scriptsExecuted: false, dependenciesInstalled: false,
    originalSourcePreserved: true, requirementsPreimage: relative(root, paths.requirementsPreimage).split(sep).join("/"),
    previousPackage: record.operation === "upgrade" ? relative(root, paths.previousPackage).split(sep).join("/") : "",
    userSummary: record.operation === "upgrade"
      ? `这个 Skill 已从 ${record.previous_version} 升级到 ${record.version}，新版逐字节回读并登记；旧版本保留在本机回退前像，没有执行脚本或安装依赖。`
      : "这个 Skill 已按预览的相同字节安装、回读并登记；没有执行脚本或安装依赖。",
    nextStep: "可以继续当前任务；真正命中这个 Skill 时先按它的适用边界使用，需要额外软件或权限再单独说明。",
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function firstArgument(...names) {
  for (const name of names) {
    const value = argument(name);
    if (value) return value;
  }
  return "";
}

function help() {
  return Object.freeze({
    decision: "skill-install-help",
    purpose: "只读检查一个本地 Skill 文件夹或 ZIP，展示一次准确预览，确认后原子复制、回读并登记。",
    commands: Object.freeze([
      "prepare --root <AI Carry 实例根目录> --source <本地文件夹或 ZIP>",
      "confirm --root <同一实例根目录> --confirmation-ref <预览返回值> --choice <install|upgrade> --user-reply <用户原话>",
    ]),
    boundaries: "不会执行包内脚本、安装依赖、联网、登录、改权限或覆盖同名 Skill。",
  });
}

function run() {
  const command = process.argv[2];
  if (["help", "--help", "-h"].includes(command) || process.argv.includes("--help") || process.argv.includes("-h")) return help();
  const root = argument("--root");
  if (!root) throw new Error("缺少 --root；使用 --help 查看两步用法");
  if (command === "prepare") {
    const source = argument("--source");
    if (!source) throw new Error("prepare 缺少唯一 Skill 来源 --source");
    return prepareSkillInstall(root, source, { platform: argument("--platform") || "current-host" });
  }
  if (command === "confirm") return confirmSkillInstall(root,
    firstArgument("--confirmation-ref", "--confirm-ref"), argument("--user-reply"), { choice: argument("--choice") });
  throw new Error("只支持 prepare 或 confirm；使用 --help 查看用法");
}

function userFacingResult(result) {
  const { sourceDigest: _sourceDigest, contentDigest: _contentDigest, ...visible } = result;
  if (!visible.diff || typeof visible.diff !== "object") return visible;
  const { beforeDigest: _beforeDigest, afterDigest: _afterDigest, ...plainDiff } = visible.diff;
  return Object.freeze({ ...visible, diff: Object.freeze(plainDiff) });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = userFacingResult(withOperationalUserReport(run(), { operation: "skill-install" }));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (/(denied|isolated|review-required|recovery-required|failed)/u.test(String(result?.decision ?? ""))) process.exitCode = 2;
  } catch (error) {
    const result = withOperationalUserReport({
      decision: "skill-install-denied", executable: false, affectedScope: "only-this-skill", reason: error.message,
    }, { operation: "skill-install" });
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 2;
  }
}
