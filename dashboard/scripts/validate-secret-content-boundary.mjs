import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const assert = (condition, message) => { if (!condition) throw new Error(`Secret boundary vector failed: ${message}`); };

function validateVectors() {
  const vectors = JSON.parse(readFileSync(resolve(root, "core/schemas/secret-boundary-test-vectors.json"), "utf8"));
  assert(vectors.schema_version === 1 && Array.isArray(vectors.blocked) && Array.isArray(vectors.allowed), "vector document shape");
  for (const vector of vectors.blocked) {
    const result = locateHighConfidenceSecretCandidates(vector.parts.join(""));
    assert(result.blocked && result.findings.some((finding) => finding.category === vector.category), `missed ${vector.category}`);
  }
  for (const value of vectors.allowed) assert(!locateHighConfidenceSecretCandidates(value).blocked, `false positive: ${value}`);
  return vectors;
}

function publicCandidateFiles(scanRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolute = resolve(directory, entry.name);
      const metadata = lstatSync(absolute);
      const relativePath = relative(scanRoot, absolute).split(sep).join("/");
      assert(!metadata.isSymbolicLink(), `public candidate contains a link: ${relativePath}`);
      if (metadata.isDirectory()) visit(absolute);
      else if (metadata.isFile()) files.push([relativePath, absolute]);
      else assert(false, `public candidate contains a non-file entry: ${relativePath}`);
    }
  };
  visit(scanRoot);
  return files;
}

const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const phonePattern = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu;
const cnIdentityPattern = /(?<!\d)\d{17}[\dXx](?!\d)/gu;
const windowsProfilePattern = /\b[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s`"'<>]+)/giu;
const posixHomePattern = /\/home\/([^/\s`"'<>]+)/giu;
const remoteWebUrlPattern = /https?:\/\/[^\s<>"'`]+/giu;
const publicProfilePlaceholders = new Set(["...", "alice", "bob", "example", "someone", "somebody", "user", "username", "yourname", "某人"]);
const bundledFontNames = new Set([
  "NotoSansMonoCJKsc-Bold.woff2", "NotoSansMonoCJKsc-Regular.woff2",
  "NotoSansSC-Variable.woff2", "SpaceGrotesk-Variable.woff2",
]);

function approvedBinary(relativePath) {
  const match = relativePath.match(/^dashboard\/(?:dist|public)\/fonts\/([^/]+)$/u);
  return match !== null && bundledFontNames.has(match[1]);
}

function addPrivacyFinding(findings, category, path, line) {
  const safePath = locateHighConfidenceSecretCandidates(path).blocked ? "[redacted-secret-bearing-path]" : path;
  if (findings.length < 32) findings.push(Object.freeze({ category, path: safePath, line }));
}

function normalizedLocalPath(value) {
  return value.replaceAll("\\", "/").replace(/\/{2,}/gu, "/").replace(/\/$/u, "").toLowerCase();
}

function privateDevicePrefixes(privateRoot) {
  const values = [privateRoot, dirname(privateRoot), process.env.USERPROFILE, process.env.HOME].filter(Boolean);
  const normalizedRoot = normalizedLocalPath(privateRoot);
  const customDriveRoot = normalizedRoot.match(/^([a-z]:)\/([^/]+)/u);
  if (customDriveRoot !== null && customDriveRoot[2] !== "users") values.push(`${customDriveRoot[1]}/${customDriveRoot[2]}`);
  return [...new Set(values.map(normalizedLocalPath).filter((value) => value.length > 3))];
}

function containsPrivateDevicePath(line, prefixes) {
  const normalized = normalizedLocalPath(line);
  return prefixes.some((prefix) => normalized.includes(prefix));
}

// Paths retain their product-relative names (Pages assets use dashboard/dist/).
// The same detector protects the install tree, Pages and individual Release Notes.
export function scanPublicFiles(files, privateRoot = root) {
  const findings = [];
  const privatePrefixes = privateDevicePrefixes(privateRoot);
  let scannedFiles = 0;
  for (const [relativePath, bytes] of files) {
    scannedFiles += 1;
    const pathSecretResult = locateHighConfidenceSecretCandidates(relativePath);
    for (const finding of pathSecretResult.findings) addPrivacyFinding(findings, finding.category, "[redacted-secret-bearing-path]", 0);
    const secretResult = locateHighConfidenceSecretCandidates(bytes.toString("latin1"));
    const safePath = pathSecretResult.blocked ? "[redacted-secret-bearing-path]" : relativePath;
    for (const finding of secretResult.findings) addPrivacyFinding(findings, finding.category, safePath, finding.line);

    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch {
      if (!approvedBinary(relativePath)) addPrivacyFinding(findings, "unexpected-binary", relativePath, 0);
      continue;
    }
    const licenseContext = /(^|\/)licenses?\//iu.test(relativePath)
      || /license/iu.test(relativePath.split("/").at(-1) ?? "")
      || relativePath === "dashboard/package-lock.json"
      || relativePath === "THIRD_PARTY_NOTICES.md";
    const generatedDashboardBundle = relativePath === "dashboard/dist/index.html" || relativePath === "dashboard/dist/index.en.html";
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (/Ww-Cooooo\/(?:AI|Agent)-Carry-Dev|maintainer\.instance-workbench\.|\.assistant-local\/instance-workbench\//iu.test(line)) {
        addPrivacyFinding(findings, "private-development-marker", safePath, index + 1);
      }
      if (!licenseContext) {
        emailPattern.lastIndex = 0;
        for (const match of line.matchAll(emailPattern)) {
          const value = match[0].toLowerCase();
          if (value !== "git@github.com" && !value.endsWith("@users.noreply.github.com")) {
            addPrivacyFinding(findings, "personal-email", relativePath, index + 1);
          }
        }
      }
      if (!generatedDashboardBundle) {
        phonePattern.lastIndex = 0;
        cnIdentityPattern.lastIndex = 0;
        if (phonePattern.test(line)) addPrivacyFinding(findings, "personal-phone", relativePath, index + 1);
        if (cnIdentityPattern.test(line)) addPrivacyFinding(findings, "personal-identity", relativePath, index + 1);
      }
      const lineWithoutWebUrls = line.replace(remoteWebUrlPattern, (value) => " ".repeat(value.length));
      if (containsPrivateDevicePath(lineWithoutWebUrls, privatePrefixes)) {
        addPrivacyFinding(findings, "private-device-path", relativePath, index + 1);
      }
      for (const pattern of [windowsProfilePattern, posixHomePattern]) {
        pattern.lastIndex = 0;
        for (const match of lineWithoutWebUrls.matchAll(pattern)) {
          if (!publicProfilePlaceholders.has(match[1].toLowerCase())) {
            addPrivacyFinding(findings, "personal-home-path", relativePath, index + 1);
          }
        }
      }
    }
  }
  return Object.freeze({ scannedFiles, findings: Object.freeze(findings) });
}

export function scanPublicCandidate(scanRoot, privateRoot = root) {
  return scanPublicFiles(publicCandidateFiles(scanRoot).map(([ref, path]) => [ref, readFileSync(path)]), privateRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argumentsGiven = process.argv.slice(2);
  assert(argumentsGiven.length === 0 || (["--scan-root", "--scan-file"].includes(argumentsGiven[0])
    && (argumentsGiven.length === 2 || (argumentsGiven.length === 4 && argumentsGiven[2] === "--private-root"))),
  "usage: validate-secret-content-boundary.mjs [--scan-root <candidate> | --scan-file <notes>] [--private-root <source>]");
  const vectors = validateVectors();
  if (argumentsGiven.length === 0) {
    console.log(`Secret boundary passed ${vectors.blocked.length} blocked and ${vectors.allowed.length} allowed shared vectors.`);
  } else {
    const requestedRoot = resolve(argumentsGiven[1]);
    const metadata = lstatSync(requestedRoot);
    const singleFile = argumentsGiven[0] === "--scan-file";
    assert((singleFile ? metadata.isFile() : metadata.isDirectory()) && !metadata.isSymbolicLink(), "scan target must be physical");
    const scanRoot = realpathSync(requestedRoot);
    const requestedPrivateRoot = resolve(argumentsGiven[3] ?? root);
    const privateRootMetadata = lstatSync(requestedPrivateRoot);
    assert(privateRootMetadata.isDirectory() && !privateRootMetadata.isSymbolicLink(), "private root must be a physical directory");
    const result = singleFile
      ? scanPublicFiles([["release-notes.md", readFileSync(scanRoot)]], realpathSync(requestedPrivateRoot))
      : scanPublicCandidate(scanRoot, realpathSync(requestedPrivateRoot));
    if (result.findings.length > 0) {
      console.error(JSON.stringify({
        decision: "public-candidate-sensitive-content-found",
        scanned_files: result.scannedFiles,
        findings: result.findings,
      }, null, 2));
      process.exitCode = 1;
    } else {
      console.log(`Public candidate content boundary passed ${result.scannedFiles} files with no sensitive-content findings.`);
    }
  }
}
