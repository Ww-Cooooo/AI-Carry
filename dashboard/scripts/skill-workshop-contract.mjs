import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";
import { containsForbiddenLocationReference } from "./safe-output-boundary.mjs";
import { stableAssetId } from "./asset-route-contract.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const skillName = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const skillVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
// Layout alone is not trust: examples receive the same content/path inspection.
const allowedRoots = new Set(["SKILL.md", "LICENSE", "LICENSE.md", "agents", "references", "examples", "scripts", "assets"]);
const textExtensions = new Set([".md", ".txt", ".json", ".toml", ".yaml", ".yml", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".ps1", ".sh", ".bat", ".cmd", ".css", ".html", ".xml", ".csv", ".tsv", ".svg", ".sql", ".ini", ".cfg"]);
const forbiddenPrivateMarkers = ["private://", ".assistant-private", ".assistant-local", "maintainer-private", "AGENTS.override.md"];

function issue(code, message) { return Object.freeze({ code, message }); }
function textFile(ref) {
  if (["SKILL.md", "LICENSE", "LICENSE.md"].includes(ref)) return true;
  const dot = basename(ref).lastIndexOf(".");
  return dot >= 0 && textExtensions.has(basename(ref).slice(dot).toLowerCase());
}
function safeSegment(value) {
  const stem = value.replace(/\..*$/u, "").toLowerCase();
  return typeof value === "string" && value.length > 0 && [...value].length <= 120 && value !== "." && value !== ".."
    && value.normalize("NFC") === value && !/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/u.test(value)
    && !/[. ]$/u.test(value) && !["con", "prn", "aux", "nul", "clock$"].includes(stem) && !/^(?:com|lpt)[1-9]$/u.test(stem);
}
function boundedRead(path, maxBytes, label) {
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error(`${label} exceeds the per-file limit`);
    const buffer = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < buffer.length) { const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset); if (count === 0) break; offset += count; }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== buffer.length || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`${label} changed during inspection`);
    return buffer;
  } finally { closeSync(descriptor); }
}
function scalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}
function parseSkillHead(source) {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0 || end > 8192) return null;
  const values = {}; const metadata = {};
  let section = "";
  for (const rawLine of normalized.slice(4, end).split("\n")) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    if (/^\s/u.test(rawLine)) {
      if (section !== "metadata") continue;
      if (/^\t/u.test(rawLine)) return null;
      const nested = /^\s+([a-zA-Z0-9_.-]+):\s*(.*?)\s*$/u.exec(rawLine);
      if (!nested || Object.hasOwn(metadata, nested[1])) return null;
      metadata[nested[1]] = scalar(nested[2]);
      continue;
    }
    const match = /^([a-zA-Z0-9_-]+):\s*(.*?)\s*$/u.exec(rawLine);
    if (!match || Object.hasOwn(values, match[1])) return null;
    if (match[1] === "metadata" && !match[2]) {
      values.metadata = metadata;
      section = "metadata";
      continue;
    }
    values[match[1]] = scalar(match[2]);
    section = "";
  }
  return values;
}

/**
 * Bounded, read-only inspection. It never executes package scripts, installs
 * dependencies, follows links, or modifies the package.
 */
export function inspectSkillPackage(packageRoot, { mode = "import", sourceAssetId = "", fileSystem = undefined } = {}) {
  const isolated = []; const review = []; const scripts = []; const opaqueFiles = [];
  const readDirectory = typeof fileSystem?.readdirSync === "function" ? fileSystem.readdirSync : readdirSync;
  const readEntry = typeof fileSystem?.lstatSync === "function" ? fileSystem.lstatSync : lstatSync;
  if (!["import", "export"].includes(mode)) isolated.push(issue("mode-invalid", "检查模式无效。"));
  let root;
  try {
    const rootInfo = readEntry(packageRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("root is not a physical directory");
    root = realpathSync(packageRoot);
  } catch {
    return Object.freeze({ decision: "isolated", name: "", description: "", fileCount: 0, totalBytes: 0, scripts: Object.freeze([]), opaqueFiles: Object.freeze([]), issues: Object.freeze([issue("root-invalid", "Skill 来源不是可安全读取的本地物理目录。")]) });
  }

  const files = []; let walkStopped = false;
  const walk = (directory) => {
    if (walkStopped) return;
    let entries;
    try { entries = readDirectory(directory, { withFileTypes: true }); }
    catch {
      const directoryRef = relative(root, directory).split(sep).join("/") || ".";
      isolated.push(issue("directory-read-failed", `暂时无法读取 Skill 包目录：${directoryRef}`));
      return;
    }
    if (entries.length > 128) { isolated.push(issue("directory-entry-limit", "单个目录超过 128 项的有界检查上限。")); walkStopped = true; return; }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const ref = relative(root, path).split(sep).join("/");
      const parts = ref.split("/");
      if (parts.some((part) => !safeSegment(part))) { isolated.push(issue("path-invalid", `存在不可携带路径：${ref}`)); continue; }
      let info;
      try { info = readEntry(path); }
      catch { isolated.push(issue("entry-read-failed", `暂时无法读取 Skill 包条目：${ref}`)); continue; }
      if (info.isSymbolicLink()) { isolated.push(issue("link-rejected", `不跟随链接：${ref}`)); continue; }
      if (info.isDirectory()) { walk(path); continue; }
      if (!info.isFile()) { isolated.push(issue("special-file", `存在非常规文件：${ref}`)); continue; }
      files.push({ path, ref, size: Number(info.size) });
      if (files.length > 128) { isolated.push(issue("file-count-limit", "文件数量超过 128 项的有界检查上限。")); walkStopped = true; return; }
    }
  };
  walk(root);

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > 2 * 1024 * 1024) isolated.push(issue("package-size-limit", "包大小超过 2 MiB 的自动检查上限。"));
  if (!files.some((file) => file.ref === "SKILL.md")) isolated.push(issue("skill-entry-missing", "缺少根目录 SKILL.md。"));
  if (totalBytes > 2 * 1024 * 1024) {
    return Object.freeze({ decision: "isolated", name: "", description: "", fileCount: files.length, totalBytes, scripts: Object.freeze([]), opaqueFiles: Object.freeze([]), issues: Object.freeze(isolated) });
  }
  for (const file of files) {
    const rootName = file.ref.split("/")[0];
    if (!allowedRoots.has(rootName)) review.push(issue("extra-root-entry", `根目录额外内容需要人工判断：${rootName}`));
    const loweredRef = file.ref.toLowerCase();
    if (forbiddenPrivateMarkers.some((marker) => loweredRef.includes(marker.toLowerCase()))) isolated.push(issue("private-boundary", `发现 AI Carry 私密或本地维护文件：${file.ref}`));
    if (mode === "export" && sourceAssetId && file.ref.includes(sourceAssetId)) isolated.push(issue("source-id-leak", `共享包文件名泄露了本地来源资产 ID：${file.ref}`));
    if (file.ref.startsWith("scripts/")) scripts.push(file.ref);
    if (!textFile(file.ref)) { opaqueFiles.push(file.ref); review.push(issue("opaque-file", `不透明或二进制内容需要人工判断：${file.ref}`)); continue; }
    let source;
    try { source = decoder.decode(boundedRead(file.path, 512 * 1024, file.ref)); }
    catch { isolated.push(issue("text-read-failed", `文本文件不是稳定 UTF-8 或超过单文件上限：${file.ref}`)); continue; }
    if (locateHighConfidenceSecretCandidates(source).blocked) isolated.push(issue("secret-detected", `发现疑似秘密内容：${file.ref}`));
    if (containsForbiddenLocationReference(source)) isolated.push(issue("local-path-detected", `发现不可分享的本机绝对位置：${file.ref}`));
    const lowered = source.toLowerCase();
    if (forbiddenPrivateMarkers.some((marker) => lowered.includes(marker.toLowerCase()))) isolated.push(issue("private-boundary", `发现 AI Carry 私密或本地维护引用：${file.ref}`));
    if (mode === "export" && sourceAssetId && source.includes(sourceAssetId)) isolated.push(issue("source-id-leak", `共享包泄露了本地来源资产 ID：${file.ref}`));
  }

  let name = ""; let description = ""; let skillId = ""; let version = "";
  const skillEntry = files.find((file) => file.ref === "SKILL.md");
  if (skillEntry) {
    try {
      const head = parseSkillHead(decoder.decode(boundedRead(skillEntry.path, 512 * 1024, "SKILL.md")));
      name = typeof head?.name === "string" ? head.name : "";
      description = typeof head?.description === "string" ? head.description : "";
      const metadata = head?.metadata && typeof head.metadata === "object" ? head.metadata : {};
      const standardSkillId = typeof metadata["ai-carry-skill-id"] === "string" ? metadata["ai-carry-skill-id"] : "";
      const standardVersion = typeof metadata["ai-carry-version"] === "string" ? metadata["ai-carry-version"] : "";
      const legacySkillId = typeof head?.skill_id === "string" ? head.skill_id : "";
      const legacyVersion = typeof head?.version === "string" ? head.version : "";
      skillId = standardSkillId || legacySkillId;
      version = standardVersion || legacyVersion;
      if (!skillName.test(name)) isolated.push(issue("name-invalid", "SKILL.md 的 name 必须是小写字母、数字和连字符组成的稳定名称。"));
      if (!description.trim() || [...description].length > 1024) isolated.push(issue("description-invalid", "SKILL.md 缺少有界、可理解的 description。"));
      if (skillId && !stableAssetId.test(skillId)) review.push(issue("skill-id-invalid", "SKILL.md 的共享身份不是可识别的稳定 ID。"));
      if (version && !skillVersion.test(version)) review.push(issue("version-invalid", "SKILL.md 的共享版本必须是三段数字，例如 1.2.0。"));
      if ((standardSkillId && legacySkillId && standardSkillId !== legacySkillId)
        || (standardVersion && legacyVersion && standardVersion !== legacyVersion)) {
        review.push(issue("identity-metadata-conflict", "SKILL.md 的新旧共享身份元数据互相冲突；本包保持原样并只进入复核。"));
      }
      if (Boolean(standardSkillId) !== Boolean(standardVersion) || Boolean(legacySkillId) !== Boolean(legacyVersion)) {
        review.push(issue("upgrade-metadata-format-incomplete", "SKILL.md 的同一套共享身份和版本没有成对出现；本包仍可保留，但不能自动判断升级。"));
      }
      if (Boolean(skillId) !== Boolean(version)) review.push(issue("upgrade-metadata-incomplete", "共享身份和版本需要同时提供；本包仍可保留，但不能自动判断升级。"));
    } catch { isolated.push(issue("skill-entry-read-failed", "无法稳定读取 SKILL.md。")); }
  }

  const issues = isolated.length ? isolated : review;
  return Object.freeze({
    decision: isolated.length ? "isolated" : review.length ? "review" : "ready",
    name,
    description,
    skillId,
    version,
    fileCount: files.length,
    totalBytes,
    scripts: Object.freeze([...new Set(scripts)].sort()),
    opaqueFiles: Object.freeze([...new Set(opaqueFiles)].sort()),
    issues: Object.freeze(issues),
  });
}
