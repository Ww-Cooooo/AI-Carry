import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";

const SKIP_ANYWHERE = new Set([".git", "node_modules"]);
const SKIP_ROOT_DIRECTORIES = new Set([".cache", "cache", "tmp"]);
const LOCAL_RUNTIME_SKIP = new Set([".assistant-local/cache", ".assistant-local/runtime", ".assistant-local/tmp"]);
const SECRET_FILE_NAME = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|credentials?(?:\.[^\\/]*)?|tokens?(?:\.[^\\/]*)?|cookies?(?:\.[^\\/]*)?|secrets?(?:\.[^\\/]*)?|.*\.(?:pem|key|p12|pfx))$/iu;

function fail(message) {
  throw new Error(`Agent switch preparation failed: ${message}`);
}

function absoluteDirectory(value, label, { mustExist = true } = {}) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is missing`);
  const resolved = resolve(value);
  if (!mustExist) return resolved;
  let info;
  try { info = lstatSync(resolved); } catch { fail(`${label} does not exist`); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.isReparsePoint?.()) fail(`${label} is not a physical directory`);
  return realpathSync(resolved);
}

function inside(candidate, owner) {
  const fromOwner = relative(owner, candidate);
  return fromOwner === "" || (fromOwner !== ".." && !fromOwner.startsWith(`..${sep}`) && !/^[A-Za-z]:[\\/]/u.test(fromOwner));
}

function rejectLinks(root, current = root) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || info.isReparsePoint?.()) fail(`source contains a link or reparse point: ${relative(root, path)}`);
    if (entry.isDirectory()) rejectLinks(root, path);
  }
}

function shouldSkip(relativePath, entry) {
  if (!entry.isDirectory()) return false;
  if (SKIP_ANYWHERE.has(entry.name)) return true;
  if (!relativePath.includes("\\") && SKIP_ROOT_DIRECTORIES.has(entry.name)) return true;
  return LOCAL_RUNTIME_SKIP.has(relativePath.replaceAll("\\", "/"));
}

function copySource(source, stage, skippedFiles, relativePath = "") {
  for (const entry of readdirSync(join(source, relativePath), { withFileTypes: true })) {
    const childRelative = relativePath ? join(relativePath, entry.name) : entry.name;
    const sourcePath = join(source, childRelative);
    const targetPath = join(stage, childRelative);
    if (shouldSkip(childRelative, entry)) continue;
    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      copySource(source, stage, skippedFiles, childRelative);
      continue;
    }
    if (!entry.isFile()) fail(`unsupported source entry: ${childRelative}`);
    const normalized = childRelative.replaceAll("\\", "/");
    const sourceBytes = readFileSync(sourcePath);
    const text = sourceBytes.includes(0) || sourceBytes.length > 1024 * 1024 ? null : sourceBytes.toString("utf8");
    const hasSecret = SECRET_FILE_NAME.test(normalized)
      || (text !== null && locateHighConfidenceSecretCandidates(text).blocked);
    if (hasSecret) {
      skippedFiles.push(normalized);
      continue;
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath, { force: false, errorOnExist: true });
  }
}

function readInstanceIdentity(source) {
  const manifest = join(source, "instance", "manifest.toml");
  if (!existsSync(manifest)) return { instanceId: "unknown", manifestDigest: null };
  const bytes = readFileSync(manifest);
  const match = bytes.toString("utf8").match(/^instance_id\s*=\s*"([^"]+)"/mu);
  return {
    instanceId: match?.[1] ?? "unknown",
    manifestDigest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function writeHandoff(stage, { instanceId, manifestDigest, copyId, skippedFiles = [] }) {
  const local = join(stage, ".assistant-local");
  mkdirSync(local, { recursive: true });
  const marker = join(local, "host-switch.toml");
  const handoff = join(local, "HOST-SWITCH-START.md");
  // A copied assistant may itself already be an independent copy. These two
  // files are our generated handoff metadata, so refresh them for the new
  // source rather than making a second switch impossible.
  if (existsSync(marker)) rmSync(marker, { force: true });
  if (existsSync(handoff)) rmSync(handoff, { force: true });
  writeFileSync(marker, [
    "schema_version = 1",
    'record_type = "independent-host-copy"',
    `copy_id = "${copyId}"`,
    `instance_id = "${instanceId}"`,
    'mode = "independent"',
    `source_manifest_digest = "${manifestDigest ?? "unknown"}"`,
    'sync_policy = "none"',
    'path_review = "required-before-host-specific-tool-use"',
    `credential_files_skipped = ${skippedFiles.length}`,
    "",
  ].join("\n"), "utf8");
  writeFileSync(handoff, `# AI Carry：换 Agent 后先读这里\n\n这是一份与原目录分开的本地副本。它保留原助手的实例身份和积累，但从现在起**不与原目录自动同步**；两个目录中的新修改不能互相假定已经存在。\n\n请先完成这些事：\n\n1. 读取当前目录的正式入口、实例清单、当前进度和相关资产；不要重新实例化，也不要清空原有记忆、SOP、能力、经验或 Skill。\n2. 检查 \`.assistant-local/\` 中与本机 Agent、工具副本、工作区或运行时有关的绑定。指向旧目录的路径只在本副本中逐项重连；不要对用户正文、历史记录或所有同名字符串做全局替换。\n3. 原 Agent 的宿主指令、记忆和启动文件只作为迁移参考，不要把旧宿主伪装成当前 Agent。为当前 Agent 建立自己的宿主档案；读取不到的部分标为未知或受限。\n4. 如果某个本机工具无法重连，只暂停这个工具，保留其他对话和能力继续工作，并用自然语言说明原因和下一步。\n5. 完成后报告：本副本实际读取了什么、哪些路径已重连、哪些仍待确认，以及当前 Agent 接下来可以做什么。\n\n原目录不会被本副本自动改写。需要把两个副本的后续修改合并时，必须另行比较并由用户选择。\n`, "utf8");
}

export function prepareAgentSwitch({ sourceRoot, destinationRoot, mode = "independent" } = {}) {
  const source = absoluteDirectory(sourceRoot, "source root");
  if (mode === "shared") {
    return Object.freeze({ mode, decision: "shared-folder", sourceRoot: source, destinationRoot: null, syncPolicy: "reread-before-write-no-automatic-sync" });
  }
  if (mode !== "independent") fail(`unknown mode: ${mode}`);
  const destination = absoluteDirectory(destinationRoot, "destination root", { mustExist: false });
  if (inside(destination, source) || inside(source, destination)) fail("source and destination roots overlap");
  if (existsSync(destination)) fail("destination already exists; choose a new empty location");
  rejectLinks(source);
  const identity = readInstanceIdentity(source);
  const copyId = `host-copy-${randomUUID()}`;
  mkdirSync(dirname(destination), { recursive: true });
  const stage = mkdtempSync(join(dirname(destination), ".ai-carry-host-switch-"));
  const skippedFiles = [];
  try {
    copySource(source, stage, skippedFiles);
    writeHandoff(stage, { ...identity, copyId, skippedFiles });
    renameSync(stage, destination);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    mode,
    decision: "independent-copy-ready",
    sourceRoot: source,
    destinationRoot: destination,
    copyId,
    instanceId: identity.instanceId,
    manifestDigest: identity.manifestDigest,
    syncPolicy: "none",
    skipped: [...SKIP_ANYWHERE, ...SKIP_ROOT_DIRECTORIES, ...LOCAL_RUNTIME_SKIP].map((item) => item),
    skippedFiles: [...skippedFiles],
  });
}

function parseArgs(args) {
  const options = { mode: "independent" };
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i];
    const value = args[i + 1];
    if (!["--source", "--destination", "--mode"].includes(option) || value === undefined) fail(`unknown or incomplete option: ${String(option)}`);
    options[option.slice(2) === "source" ? "sourceRoot" : option.slice(2) === "destination" ? "destinationRoot" : "mode"] = value;
    i += 1;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(`${JSON.stringify(prepareAgentSwitch(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 2;
  }
}
