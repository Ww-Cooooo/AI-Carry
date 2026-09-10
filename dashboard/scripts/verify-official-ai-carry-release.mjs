#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_VERSION = "2.0.10";
const REPOSITORY = "Ww-Cooooo/AI-Carry";
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`;
const MAX_FILES = 8192;
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const AUTHORITY_FINGERPRINT_SCHEMA = 2;
export const OFFICIAL_RELEASE_REQUEST_BUDGET = 6;

function fail(message) { throw new Error(`Official AI Carry release verification failed: ${message}`); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function gitBlobSha(bytes) {
  return createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`, "utf8")).update(bytes).digest("hex");
}
function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
function normalizeRef(path) { return path.split(sep).join("/"); }

function physicalDirectory(path) {
  const absolute = resolve(path);
  let original;
  try { original = lstatSync(absolute); } catch { fail("target does not exist"); }
  if (!original.isDirectory() || original.isSymbolicLink() || original.isReparsePoint?.()) fail("target is not a direct physical directory");
  const physical = realpathSync(absolute);
  const info = lstatSync(physical);
  if (!info.isDirectory() || info.isSymbolicLink() || info.isReparsePoint?.()) fail("target physical directory is invalid");
  return physical;
}

function localTree(root) {
  const files = [];
  let totalBytes = 0;
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = resolve(directory, name);
      const info = lstatSync(absolute);
      const ref = normalizeRef(relative(root, absolute));
      if (info.isSymbolicLink() || info.isReparsePoint?.()) fail(`target contains a link: ${ref}`);
      if (info.isDirectory()) visit(absolute);
      else if (info.isFile()) {
        const bytes = readFileSync(absolute);
        totalBytes += bytes.length;
        if (files.length >= MAX_FILES || totalBytes > MAX_BYTES) fail("target exceeds the bounded release-verification budget");
        files.push(Object.freeze({ path: ref, bytes: bytes.length, sha256: sha256(bytes), gitBlobSha: gitBlobSha(bytes) }));
      } else fail(`target contains a non-file entry: ${ref}`);
    }
  };
  visit(root);
  const fingerprint = sha256(Buffer.from(files.map((item) => `${item.path}\0${item.bytes}\0${item.sha256}\n`).join(""), "utf8"));
  return Object.freeze({ files: Object.freeze(files), fileCount: files.length, totalBytes, fingerprint });
}

async function apiJson(path, label, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") fail("HTTPS client is unavailable");
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "AI-Carry-release-verifier/2.0.10",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`${label} returned GitHub HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail(`${label} response is oversized`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) fail(`${label} response is oversized`);
  try { return JSON.parse(text); } catch { fail(`${label} response is not JSON`); }
}

async function resolveTagCommit(requestJson = apiJson) {
  const object = (await requestJson(`/git/ref/tags/v${TARGET_VERSION}`, "fixed lightweight tag reference")).object;
  if (object?.type !== "commit" || !/^[a-f0-9]{40}$/u.test(object.sha ?? "")) fail("fixed tag is not a lightweight tag pointing directly to one commit");
  return object.sha;
}

function releaseMatchesFixedVersion(release) {
  return release?.tag_name === `v${TARGET_VERSION}` && release.draft === false && release.prerelease === false
    && Number.isSafeInteger(release.id) && release.id > 0
    && release.html_url === `https://github.com/${REPOSITORY}/releases/tag/v${TARGET_VERSION}`;
}

function stableAuthorityFacts(record) {
  return Object.freeze({
    schema_version: AUTHORITY_FINGERPRINT_SCHEMA,
    record_type: record.record_type,
    authority: record.authority,
    repository: record.repository,
    release_ref: record.release_ref,
    release_id: record.release_id,
    latest_release_id: record.latest_release_id,
    release_url: record.release_url,
    draft: record.draft,
    prerelease: record.prerelease,
    commit_sha: record.commit_sha,
    git_tree_sha: record.git_tree_sha,
    target_tree_sha256: record.target_tree_sha256,
    release_manifest_sha256: record.release_manifest_sha256,
    target_file_count: record.target_file_count,
  });
}

export function officialAuthorityFingerprint(record) {
  return `sha256:${sha256(Buffer.from(JSON.stringify(stableAuthorityFacts(record)), "utf8"))}`;
}

export async function verifyOfficialAiCarryRelease({ target: targetArgument, requestJson = apiJson, verifiedAt = new Date().toISOString() } = {}) {
  const target = physicalDirectory(targetArgument);
  const local = localTree(target);
  let requestCount = 0;
  const boundedRequestJson = async (...args) => {
    requestCount += 1;
    if (requestCount > OFFICIAL_RELEASE_REQUEST_BUDGET) fail("GitHub API request budget exceeded");
    return requestJson(...args);
  };
  const release = await boundedRequestJson(`/releases/tags/v${TARGET_VERSION}`, "formal Release");
  if (!releaseMatchesFixedVersion(release)) {
    fail("Release object is draft, prerelease, or does not match the fixed version");
  }
  const latestRelease = await boundedRequestJson("/releases/latest", "latest formal Release");
  if (!releaseMatchesFixedVersion(latestRelease) || latestRelease.id !== release.id) {
    fail("latest formal Release does not equal the fixed versioned Release");
  }
  const commitSha = await resolveTagCommit(boundedRequestJson);
  // A moving development branch does not invalidate an immutable published release.
  const commit = await boundedRequestJson(`/git/commits/${commitSha}`, "tag commit");
  if (commit.sha !== commitSha || !/^[a-f0-9]{40}$/u.test(commit.tree?.sha ?? "")) fail("tag commit tree is unavailable");
  const tree = await boundedRequestJson(`/git/trees/${commit.tree.sha}?recursive=1`, "recursive tag tree");
  if (tree.truncated !== false || !Array.isArray(tree.tree)) fail("GitHub returned a truncated or invalid tag tree");
  const remoteFiles = tree.tree.filter((item) => item?.type === "blob");
  if (tree.tree.some((item) => !["blob", "tree"].includes(item?.type))
    || remoteFiles.some((item) => !["100644", "100755"].includes(item.mode)
      || typeof item.path !== "string" || !/^[a-f0-9]{40}$/u.test(item.sha ?? ""))) {
    fail("tag tree contains a submodule, link, or unsupported entry");
  }
  const remoteByPath = new Map(remoteFiles.map((item) => [item.path, item]));
  if (remoteByPath.size !== remoteFiles.length || remoteByPath.size !== local.files.length) fail("target path set differs from the fixed tag");
  for (const item of local.files) {
    const remote = remoteByPath.get(item.path);
    if (!remote || remote.sha !== item.gitBlobSha) fail(`target bytes differ from the fixed tag: ${item.path}`);
  }
  const releaseManifest = resolve(target, "core", "upgrade", `release-manifest-${TARGET_VERSION}.toml`);
  const releaseManifestSha256 = `sha256:${sha256(readFileSync(releaseManifest))}`;
  const record = {
    record_type: "ai-carry-live-official-release-verification",
    authority: "github-api-live-https",
    repository: REPOSITORY,
    release_ref: `v${TARGET_VERSION}`,
    release_id: release.id,
    latest_release_id: latestRelease.id,
    release_url: release.html_url,
    draft: false,
    prerelease: false,
    commit_sha: commitSha,
    git_tree_sha: commit.tree.sha,
    target_tree_sha256: `sha256:${local.fingerprint}`,
    release_manifest_sha256: releaseManifestSha256,
    verified_at: verifiedAt,
    target_file_count: local.fileCount,
    network_used: true,
    fixture: false,
  };
  return Object.freeze({
    ...record,
    authority_fingerprint_schema: AUTHORITY_FINGERPRINT_SCHEMA,
    authority_fingerprint: officialAuthorityFingerprint(record),
    request_count: requestCount,
    request_budget: OFFICIAL_RELEASE_REQUEST_BUDGET,
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.stdout.write(`${JSON.stringify(await verifyOfficialAiCarryRelease({ target: argument("--target") }))}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 2;
  }
}
