import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSkillPackage, readBoundedSkillDirectory, SKILL_PACKAGE_LIMITS } from "./skill-workshop-contract.mjs";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";

const MAX_FILES = 128;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(message) { throw new Error(`Skill package failed: ${locateHighConfidenceSecretCandidates(message).blocked ? "unsafe diagnostic content was redacted" : message}`); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function portableSegment(value) {
  if (typeof value !== "string" || !value || value === "." || value === ".." || value.normalize("NFC") !== value) return false;
  const stem = value.replace(/\..*$/u, "").toLowerCase();
  return [...value].length <= 120 && !/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/u.test(value) && !/[. ]$/u.test(value)
    && !["con", "prn", "aux", "nul", "clock$"].includes(stem) && !/^(?:com|lpt)[1-9]$/u.test(stem);
}
function portableRef(value) {
  return typeof value === "string" && value.length <= 480 && !value.startsWith("/") && !value.includes("\\")
    && !/^[a-zA-Z]:/u.test(value) && value.split("/").every(portableSegment);
}
function stableRead(path, maximum, label) {
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) fail(`${label} exceeds its bounded size`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== bytes.length || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      fail(`${label} changed while it was being read`);
    }
    return bytes;
  } finally { closeSync(descriptor); }
}

function collectSkillFiles(packageRoot) {
  let root;
  try {
    const rootInfo = lstatSync(packageRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("source is not a physical directory");
    root = realpathSync(packageRoot);
  } catch (error) {
    if (error?.message?.startsWith("Skill package failed:")) throw error;
    fail("source is not a readable physical directory");
  }
  const files = [];
  let totalBytes = 0; let directoryCount = 0;
  const walk = (directory, depth = 0) => {
    directoryCount += 1;
    if (directoryCount > SKILL_PACKAGE_LIMITS.directories || depth > SKILL_PACKAGE_LIMITS.depth) fail("source exceeds the directory-count or nesting-depth limit");
    const entries = readBoundedSkillDirectory(directory);
    if (entries.length > MAX_FILES) fail("one directory exceeds the 128-entry limit");
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const ref = relative(root, path).split(sep).join("/");
      if (!portableRef(ref)) fail(`source contains a non-portable path: ${ref}`);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) fail(`source contains a link: ${ref}`);
      if (info.isDirectory()) { walk(path, depth + 1); continue; }
      if (!info.isFile()) fail(`source contains a special file: ${ref}`);
      if (info.size > MAX_FILE_BYTES) fail(`source file exceeds 512 KiB: ${ref}`);
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES) fail("source exceeds the 2 MiB package limit");
      files.push({ path, ref, bytes: stableRead(path, MAX_FILE_BYTES, ref) });
      if (files.length > MAX_FILES) fail("source exceeds the 128-file limit");
    }
  };
  walk(root);
  files.sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0);
  return files;
}

function contentDigest(files) {
  const manifest = files.map((file) => `${sha256(file.bytes)}  ${file.ref}\n`).join("");
  return `sha256:${sha256(Buffer.from(manifest, "utf8"))}`;
}

/** Compare two bounded physical Skill folders without executing package code. */
export function compareSkillPackages(beforeRoot, afterRoot) {
  const beforeFiles = collectSkillFiles(beforeRoot);
  const afterFiles = collectSkillFiles(afterRoot);
  const before = new Map(beforeFiles.map((file) => [file.ref, sha256(file.bytes)]));
  const after = new Map(afterFiles.map((file) => [file.ref, sha256(file.bytes)]));
  const added = []; const changed = []; const removed = []; const unchanged = [];
  for (const [ref, digest] of after) {
    if (!before.has(ref)) added.push(ref);
    else if (before.get(ref) === digest) unchanged.push(ref);
    else changed.push(ref);
  }
  for (const ref of before.keys()) if (!after.has(ref)) removed.push(ref);
  return Object.freeze({
    beforeDigest: contentDigest(beforeFiles),
    afterDigest: contentDigest(afterFiles),
    added: Object.freeze(added),
    changed: Object.freeze(changed),
    removed: Object.freeze(removed),
    unchanged: Object.freeze(unchanged),
  });
}

const CRC_TABLE = Object.freeze(Array.from({ length: 256 }, (_, seed) => {
  let value = seed;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
}));
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function u16(value) { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value, 0); return bytes; }
function u32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0, 0); return bytes; }

function buildStoredZip(skillName, files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(`${skillName}/${file.ref}`, "utf8");
    const checksum = crc32(file.bytes);
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021), u32(checksum),
      u32(file.bytes.length), u32(file.bytes.length), u16(name.length), u16(0), name,
    ]);
    local.push(localHeader, file.bytes);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(0x0314), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021), u32(checksum),
      u32(file.bytes.length), u32(file.bytes.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32((0o100644 << 16) >>> 0), u32(offset), name,
    ]));
    offset += localHeader.length + file.bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBytes.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...local, centralBytes, end]);
}

function ensureNewOutput(outputPath) {
  const output = resolve(outputPath);
  if (existsSync(output)) fail("output already exists; choose a new path");
  mkdirSync(dirname(output), { recursive: true });
  return output;
}
function partialPath(output) { return `${output}.partial-${process.pid}-${randomBytes(4).toString("hex")}`; }

/** Create one real, non-overwriting delivery carrier from the canonical Skill folder. */
export function createSkillDelivery(packageRoot, { format, outputPath } = {}) {
  if (!["zip", "folder"].includes(format)) fail("format must be zip or folder");
  if (typeof outputPath !== "string" || !outputPath.trim()) fail("output path is required");
  const inspection = inspectSkillPackage(packageRoot, { mode: "export" });
  if (inspection.decision !== "ready") fail(`source inspection is ${inspection.decision}; resolve this Skill before packaging`);
  const files = collectSkillFiles(packageRoot);
  if (!files.some((file) => file.ref === "SKILL.md")) fail("source is missing SKILL.md");
  const sourceDigest = contentDigest(files);
  const output = ensureNewOutput(outputPath);
  const partial = partialPath(output);
  if (format === "zip") {
    const archive = buildStoredZip(inspection.name, files);
    try {
      writeFileSync(partial, archive, { flag: "wx" });
      renameSync(partial, output);
    } catch (error) {
      fail(`ZIP creation did not finish; the source stayed unchanged${existsSync(partial) ? ` and the partial scene is ${partial}` : ""}: ${error.message}`);
    }
    return Object.freeze({ decision: "ready", format, output, name: inspection.name, fileCount: files.length,
      sourceDigest, artifactDigest: `sha256:${sha256(archive)}`, artifactBytes: archive.length });
  }
  try {
    mkdirSync(partial);
    for (const file of files) {
      const target = resolve(partial, ...file.ref.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes, { flag: "wx" });
    }
    renameSync(partial, output);
  } catch (error) {
    fail(`folder creation did not finish; the source stayed unchanged${existsSync(partial) ? ` and the partial scene is ${partial}` : ""}: ${error.message}`);
  }
  return Object.freeze({ decision: "ready", format, output, name: inspection.name, fileCount: files.length,
    sourceDigest, artifactDigest: sourceDigest, artifactBytes: files.reduce((sum, file) => sum + file.bytes.length, 0) });
}

function findEndOfCentralDirectory(bytes) {
  const start = Math.max(0, bytes.length - 65557);
  for (let cursor = bytes.length - 22; cursor >= start; cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + bytes.readUInt16LE(cursor + 20) === bytes.length) return cursor;
  }
  fail("ZIP end record is missing or ambiguous");
}
function decodeZipName(bytes, flags) {
  if ((flags & 0x0800) === 0 && bytes.some((byte) => byte > 0x7f)) fail("ZIP uses an unsupported non-UTF-8 file name");
  try { return decoder.decode(bytes); } catch { fail("ZIP contains an invalid UTF-8 file name"); }
}
function safeArchiveRef(name) {
  const directory = name.endsWith("/");
  const ref = directory ? name.slice(0, -1) : name;
  if (!ref || !portableRef(ref)) fail(`ZIP contains an unsafe path: ${name}`);
  return { ref, directory };
}

function readZipEntries(zipPath) {
  const bytes = stableRead(zipPath, MAX_ARCHIVE_BYTES, "ZIP source");
  if (bytes.length < 22) fail("ZIP is too short");
  const end = findEndOfCentralDirectory(bytes);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) fail("multi-disk ZIP is unsupported");
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail("ZIP64 is outside the bounded Skill package format");
  if (count > MAX_FILES + 64 || centralOffset + centralSize !== end) fail("ZIP central directory is outside its bounded structure");
  const files = [];
  const seen = new Set();
  let totalBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail("ZIP central directory is malformed");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > end || diskStart !== 0) fail("ZIP central entry is malformed");
    const name = decodeZipName(bytes.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    const { ref, directory } = safeArchiveRef(name);
    const unixType = ((externalAttributes >>> 16) & 0xf000);
    if (unixType === 0xa000 || unixType === 0x2000 || unixType === 0x6000) fail(`ZIP contains a link or device entry: ${ref}`);
    if (!directory) {
      if ((flags & 0x0001) !== 0) fail("encrypted ZIP entries are unsupported");
      if (![0, 8].includes(method)) fail(`ZIP compression method ${method} is unsupported`);
      if (uncompressedSize > MAX_FILE_BYTES) fail(`ZIP entry exceeds 512 KiB: ${ref}`);
      totalBytes += uncompressedSize;
      if (totalBytes > MAX_TOTAL_BYTES) fail("ZIP expands beyond the 2 MiB package limit");
      if (uncompressedSize > 0 && compressedSize > 0 && uncompressedSize / compressedSize > 100) fail(`ZIP entry has an unsafe compression ratio: ${ref}`);
      const portableKey = ref.toLowerCase();
      if (seen.has(portableKey)) fail(`ZIP contains a duplicate portable path: ${ref}`);
      seen.add(portableKey);
      if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) fail(`ZIP local entry is malformed: ${ref}`);
      const localFlags = bytes.readUInt16LE(localOffset + 6);
      const localMethod = bytes.readUInt16LE(localOffset + 8);
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset > centralOffset || localMethod !== method || (localFlags & 0x0001) !== 0 || dataOffset + compressedSize > centralOffset) fail(`ZIP local metadata conflicts with its central entry: ${ref}`);
      const localName = decodeZipName(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength), localFlags);
      const localRef = safeArchiveRef(localName);
      if (localRef.ref !== ref || localRef.directory !== directory) fail(`ZIP local name conflicts with its central entry: ${ref}`);
      const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
      let content;
      try { content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_FILE_BYTES }); }
      catch { fail(`ZIP entry cannot be decompressed safely: ${ref}`); }
      if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) fail(`ZIP entry size or CRC does not match: ${ref}`);
      files.push({ ref, bytes: content });
      if (files.length > MAX_FILES) fail("ZIP contains more than 128 files");
    }
    cursor = recordEnd;
  }
  if (cursor !== end) fail("ZIP central directory size does not close");
  const portableFiles = new Set(files.map((file) => file.ref.toLowerCase()));
  for (const file of files) {
    const parts = file.ref.toLowerCase().split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (portableFiles.has(parts.slice(0, index).join("/"))) fail(`ZIP contains a file-directory collision: ${file.ref}`);
    }
  }
  const fileRefs = new Set(files.map((file) => file.ref));
  let rootPrefix = "";
  if (!fileRefs.has("SKILL.md")) {
    const roots = new Set(files.map((file) => file.ref.split("/")[0]));
    if (roots.size !== 1) fail("ZIP must contain SKILL.md at its root or inside one outer folder");
    rootPrefix = `${[...roots][0]}/`;
    if (!fileRefs.has(`${rootPrefix}SKILL.md`)) fail("ZIP does not contain a discoverable SKILL.md");
  }
  const directories = new Set([""]);
  for (const file of files) {
    const parts = file.ref.slice(rootPrefix.length).split("/");
    if (parts.length - 1 > SKILL_PACKAGE_LIMITS.depth) fail("ZIP exceeds the nesting-depth limit");
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
    if (directories.size > SKILL_PACKAGE_LIMITS.directories) fail("ZIP exceeds the directory-count limit");
  }
  return { files, rootPrefix, archiveDigest: `sha256:${sha256(bytes)}` };
}

/** Extract a bounded ZIP into a new directory, then reuse the read-only Skill inspector. */
export function inspectSkillSource(sourcePath, { extractTo = "" } = {}) {
  const source = resolve(sourcePath);
  let info;
  try { info = lstatSync(source); } catch { fail("source does not exist"); }
  if (info.isSymbolicLink()) fail("source is a link and will not be followed");
  if (info.isDirectory()) {
    const packageRoot = realpathSync(source);
    return Object.freeze({ ...inspectSkillPackage(packageRoot, { mode: "import" }), sourceKind: "folder",
      packageRoot, sourceDigest: contentDigest(collectSkillFiles(packageRoot)) });
  }
  if (!info.isFile() || extname(source).toLowerCase() !== ".zip") fail("source must be a physical Skill folder or ZIP file");
  if (typeof extractTo !== "string" || !extractTo.trim()) fail("ZIP inspection requires a new isolation directory");
  const output = ensureNewOutput(extractTo);
  const { files, rootPrefix, archiveDigest } = readZipEntries(source);
  mkdirSync(output);
  try {
    for (const file of files) {
      const target = resolve(output, ...file.ref.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes, { flag: "wx" });
    }
  } catch (error) {
    fail(`ZIP extraction did not finish; the isolated failure scene remains at ${output}: ${error.message}`);
  }
  const packageRoot = rootPrefix ? resolve(output, rootPrefix.slice(0, -1)) : output;
  return Object.freeze({ ...inspectSkillPackage(packageRoot, { mode: "import" }), sourceKind: "zip", packageRoot,
    isolationRoot: output, archiveDigest, sourceDigest: contentDigest(collectSkillFiles(packageRoot)) });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
function userFacingResult(result) {
  const { sourceDigest: _sourceDigest, artifactDigest: _artifactDigest, archiveDigest: _archiveDigest, ...visible } = result;
  return Object.freeze({ ...visible, packageCheck: result.decision === "ready" ? "passed" : result.decision });
}
function printResult(result) { process.stdout.write(`${JSON.stringify(userFacingResult(result), null, 2)}\n`); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const command = process.argv[2];
    if (command === "create") printResult(createSkillDelivery(argument("--source"), { format: argument("--format"), outputPath: argument("--output") }));
    else if (command === "inspect") printResult(inspectSkillSource(argument("--source"), { extractTo: argument("--extract-to") }));
    else fail("use create --source <folder> --format <zip|folder> --output <new-path>, or inspect --source <folder|zip> [--extract-to <new-directory>]");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
