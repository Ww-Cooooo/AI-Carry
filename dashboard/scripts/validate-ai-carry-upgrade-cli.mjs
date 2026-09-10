import {
  createHash,
} from "node:crypto";
import {
  execFileSync,
} from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInPlaceSwitchPlan,
  buildUpgradeBinding,
  chooseOperationPaths,
  confirmUpgrade,
  inspectInstalledSourceLayout,
  installLegacyProfileMigration,
  installMemoryGovernanceBrandMigration,
  migrateMemoryGovernanceBrand,
  migrateInstanceManifest,
  pathIsInside,
  planLegacyProfileMigration,
  planMemoryGovernanceBrandMigration,
  releaseBoundaryFrom,
  releasePathPolicyFrom,
  targetWritePaths,
  validateUpgradeRuntimeContract,
  verifyLegacyProfileMigration,
  verifyMemoryGovernanceBrandMigration,
} from "./ai-carry-upgrade-cli.mjs";
import {
  OFFICIAL_RELEASE_REQUEST_BUDGET,
  officialAuthorityFingerprint,
  verifyOfficialAiCarryRelease,
} from "./verify-official-ai-carry-release.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = mkdtempSync(resolve(tmpdir(), "ai-carry-upgrade-cli-contract-"));
let passed = false;

function expect(condition, message) {
  if (!condition) throw new Error(`AI Carry upgrade CLI validation failed: ${message}`);
}

function write(root, ref, content) {
  const path = resolve(root, ...ref.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function gitBlobSha(bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash("sha1").update(Buffer.from(`blob ${value.length}\0`, "utf8")).update(value).digest("hex");
}

try {
  let localBoundaryRejected = false;
  try {
    releaseBoundaryFrom(`[release_boundary]\nstatus = "local-unreleased-candidate"\nrelease_ref = "v2.0.10"\npublication_authorized = false\ninstance_replacement_authorized = false\n`);
  } catch { localBoundaryRejected = true; }
  expect(localBoundaryRejected, "a local candidate release boundary could authorize instance replacement");
  const published = releaseBoundaryFrom(`[release_boundary]\nstatus = "published-release"\nrelease_ref = "v2.0.10"\npublication_authorized = true\ninstance_replacement_authorized = true\n`);
  expect(published.status === "published-release", "a published replacement boundary was not recognized");

  const archiveInstall = resolve(fixture, "archive-install");
  mkdirSync(archiveInstall);
  expect(inspectInstalledSourceLayout(archiveInstall).kind === "archive-install", "an archive installation was not recognized");
  const publicClone = resolve(fixture, "public-clone-install");
  mkdirSync(resolve(publicClone, ".git"), { recursive: true });
  write(publicClone, ".git/config", `[core]\nrepositoryformatversion = 0\n[remote "origin"]\nurl = https://github.com/Ww-Cooooo/AI-Carry.git\n`);
  expect(inspectInstalledSourceLayout(publicClone).kind === "official-public-clone-install",
    "an official public clone installation was rejected");
  const legacyPublicClone = resolve(fixture, "legacy-public-clone-install");
  mkdirSync(resolve(legacyPublicClone, ".git"), { recursive: true });
  write(legacyPublicClone, ".git/config", `[core]\nrepositoryformatversion = 0\n[remote "origin"]\nurl = https://github.com/Ww-Cooooo/Agent-Carry.git\n`);
  expect(inspectInstalledSourceLayout(legacyPublicClone).kind === "official-public-clone-install",
    "a clone using the redirected legacy repository address was rejected");
  write(publicClone, "maintainer-private/private-marker.txt", "private\n");
  let privateCloneRejected = false;
  try { inspectInstalledSourceLayout(publicClone); } catch { privateCloneRejected = true; }
  expect(privateCloneRejected, "a private development checkout was accepted as an installed public clone");
  if (process.platform === "win32") {
    expect(!pathIsInside("C:\\AI\\old", "D:\\Downloads\\AI-new") && !pathIsInside("D:\\Downloads\\AI-new", "C:\\AI\\old"),
      "separate Windows volumes were classified as nested trees");
  }

  const legacyManifest = `schema_version = 1\nfuture_vendor_field = "preserve-me"\nuser_preferences_ref = "instance/profile/README.md"\nproduct = "1.4.8"\n`;
  const migratedManifest = migrateInstanceManifest(legacyManifest, "1.4.8", { migrateLegacyProfile: true });
  expect(migratedManifest.includes('future_vendor_field = "preserve-me"')
    && migratedManifest.includes('user_preferences_ref = "instance/profile/approved-profile.md"')
    && migratedManifest.includes('product = "2.0.10"'),
  "manifest migration did not preserve an unknown field while moving the legacy profile reference");
  const legacyProfileRoot = resolve(fixture, "legacy-profile-source");
  const legacyProfileCandidate = resolve(fixture, "legacy-profile-candidate");
  mkdirSync(legacyProfileRoot); mkdirSync(legacyProfileCandidate);
  write(legacyProfileRoot, "instance/profile/README.md", "# User profile\nkeep these bytes\n");
  const profilePlan = planLegacyProfileMigration(legacyProfileRoot, { validated: { legacyProfileMigrationRequired: true } });
  expect(profilePlan.required && !profilePlan.conflict, "a bounded legacy profile migration was not planned");
  installLegacyProfileMigration(legacyProfileRoot, legacyProfileCandidate, profilePlan);
  verifyLegacyProfileMigration(legacyProfileCandidate, {
    validated: { profile: { user_preferences_ref: "instance/profile/approved-profile.md" } },
  }, profilePlan);

  const governanceSourceRoot = resolve(fixture, "legacy-governance-source");
  const governanceCandidate = resolve(fixture, "legacy-governance-candidate");
  mkdirSync(governanceSourceRoot); mkdirSync(governanceCandidate);
  const legacyGovernance = `+++
id = "governance.memory-technology-review"
summary = "周期性研究更适合 Agent Carry 的记忆、检索与自我进化技术。"
schedule_anchor_at = "2026-08-01T09:00:00+08:00"
+++
寻找比现有方案更适合 Agent Carry 的记忆治理方式。
用户历史备注仍可提到 Agent Carry，不属于当前产品自述。
`;
  write(governanceSourceRoot, "instance/governance/memory-governance-card.md", legacyGovernance);
  const governancePlan = planMemoryGovernanceBrandMigration(governanceSourceRoot, { state: "instance" });
  expect(governancePlan.required, "the known active memory-governance brand residual was not planned for a bounded repair");
  installMemoryGovernanceBrandMigration(governanceSourceRoot, governanceCandidate, governancePlan);
  verifyMemoryGovernanceBrandMigration(governanceCandidate, governancePlan);
  const migratedGovernance = readFileSync(resolve(governanceCandidate, "instance/governance/memory-governance-card.md"), "utf8");
  expect(migratedGovernance.includes("周期性研究更适合 AI Carry 的记忆、检索与自我进化技术。")
    && migratedGovernance.includes("寻找比现有方案更适合 AI Carry 的记忆治理方式。")
    && migratedGovernance.includes('schedule_anchor_at = "2026-08-01T09:00:00+08:00"')
    && migratedGovernance.includes("用户历史备注仍可提到 Agent Carry，不属于当前产品自述。"),
  "the memory-governance brand repair changed schedule or user history instead of only the two current-product phrases");
  expect(migrateMemoryGovernanceBrand(legacyGovernance.replace(
    'id = "governance.memory-technology-review"', 'id = "governance.user-owned"'))
    === legacyGovernance.replace('id = "governance.memory-technology-review"', 'id = "governance.user-owned"'),
  "an unrelated governance card could be rewritten by the product-brand repair");

  const releasePolicy = releasePathPolicyFrom(readFileSync(resolve(repository, "core/upgrade/release-manifest-2.0.10.toml"), "utf8"));
  const targetTree = {
    files: [
      { path: ".assistant-local/.gitkeep", bytes: 0 },
      { path: "assistant.toml", bytes: 12 },
      { path: "core/current.md", bytes: 12 },
      { path: "instance/manifest.toml", bytes: 12 },
      { path: "instance/profile/README.md", bytes: 12 },
      { path: "instance/profile/approved-profile.md", bytes: 12 },
    ],
  };
  const instancePaths = targetWritePaths(targetTree, "instance", releasePolicy);
  expect(instancePaths.includes("assistant.toml") && instancePaths.includes("core/current.md")
    && instancePaths.includes("instance/manifest.toml") && instancePaths.includes("instance/profile/README.md"),
  "manifest-owned product paths were omitted");
  expect(!instancePaths.includes("instance/profile/approved-profile.md")
    && !instancePaths.some((path) => path.startsWith(".assistant-local/")),
  "instance-owned, workspace, or local paths entered the product write set");
  const templatePaths = targetWritePaths(targetTree, "template", releasePolicy);
  expect(templatePaths.length === targetTree.files.length, "a clean template did not receive every classified target path");
  let unlistedRejected = false;
  try { targetWritePaths({ files: [...targetTree.files, { path: "unlisted-user-name.keep", bytes: 1 }] }, "instance", releasePolicy); }
  catch { unlistedRejected = true; }
  expect(unlistedRejected, "an unlisted target path entered the release write set");
  let privateInjectionRejected = false;
  try { targetWritePaths({ files: [...targetTree.files, { path: ".assistant-private/secret.txt", bytes: 1 }] }, "template", releasePolicy); }
  catch { privateInjectionRejected = true; }
  expect(privateInjectionRejected, "a non-empty private target path entered the template write set");

  const source = resolve(fixture, "source");
  const candidate = resolve(fixture, "candidate");
  mkdirSync(source); mkdirSync(candidate);
  write(source, "assistant.toml", "old\n");
  write(source, "workspace/media/video.bin", Buffer.alloc(1024, 7));
  write(source, "unknown-root.keep", "user-owned\n");
  write(candidate, "assistant.toml", "new\n");
  write(candidate, "core/current.md", "new product file\n");
  const plan = buildInPlaceSwitchPlan(source, candidate, ["assistant.toml", "core/current.md"]);
  expect(plan.writes.length === 2 && plan.removals.length === 0,
    "path-scoped switch plan inferred removals or missed changed product paths");
  expect(existsSync(resolve(source, "unknown-root.keep")) && existsSync(resolve(source, "workspace/media/video.bin")),
    "planning touched an unknown root file or workspace body");

  const token = "a".repeat(64);
  const first = chooseOperationPaths(source, token);
  mkdirSync(first.candidate);
  const retry = chooseOperationPaths(source, token);
  expect(first.attempt === 1 && retry.attempt === 2 && retry.candidate !== first.candidate,
    "a preserved scene permanently blocked a same-state retry");

  const releaseTarget = resolve(fixture, "release-target");
  mkdirSync(releaseTarget);
  const releaseFiles = new Map([
    ["README.md", Buffer.from("AI Carry fixture\n")],
    ["core/upgrade/release-manifest-2.0.10.toml", Buffer.from("release = \"2.0.10\"\n")],
  ]);
  for (const [ref, bytes] of releaseFiles) write(releaseTarget, ref, bytes);
  const commitSha = "c".repeat(40);
  const treeSha = "d".repeat(40);
  const releaseObject = {
    tag_name: "v2.0.10",
    draft: false,
    prerelease: false,
    id: 200,
    html_url: "https://github.com/Ww-Cooooo/AI-Carry/releases/tag/v2.0.10",
  };
  let requestCount = 0;
  const requestJson = async (path) => {
    requestCount += 1;
    if (path === "/releases/tags/v2.0.10") return releaseObject;
    if (path === "/releases/latest") return releaseObject;
    if (path === "/git/ref/tags/v2.0.10") return { object: { type: "commit", sha: commitSha } };
    if (path === "/git/ref/heads/main") throw new Error("main is moving and must not be consulted for release authority");
    if (path === `/git/commits/${commitSha}`) return { sha: commitSha, tree: { sha: treeSha } };
    if (path === `/git/trees/${treeSha}?recursive=1`) return {
      truncated: false,
      tree: [...releaseFiles].map(([pathName, bytes]) => ({ path: pathName, type: "blob", mode: "100644", sha: gitBlobSha(bytes) })),
    };
    throw new Error(`unexpected fixture request: ${path}`);
  };
  const official = await verifyOfficialAiCarryRelease({
    target: releaseTarget,
    requestJson,
    verifiedAt: "2026-08-31T00:00:00.000Z",
  });
  expect(official.authority === "github-api-live-https" && official.fixture === false
    && official.commit_sha === commitSha && !("main_commit_sha" in official)
    && official.latest_release_id === releaseObject.id && official.target_file_count === releaseFiles.size
    && official.request_count > 0 && official.request_count <= OFFICIAL_RELEASE_REQUEST_BUDGET
    && official.request_budget === OFFICIAL_RELEASE_REQUEST_BUDGET
    && official.authority_fingerprint === officialAuthorityFingerprint(official),
  "the official verifier did not bind the latest Release, lightweight tag, tree, and exact local bytes independently of main");
  const officialLater = await verifyOfficialAiCarryRelease({
    target: releaseTarget,
    requestJson,
    verifiedAt: "2026-08-31T00:00:01.000Z",
  });
  expect(officialLater.verified_at !== official.verified_at
    && officialLater.authority_fingerprint === official.authority_fingerprint
    && createHash("sha256").update(JSON.stringify(officialLater)).digest("hex")
      !== createHash("sha256").update(JSON.stringify(official)).digest("hex")
    && requestCount === official.request_count + officialLater.request_count,
  "observation time changed the stable authority fingerprint or the bounded request count drifted");
  const bindingInput = (authorityFingerprint) => ({
    source: "C:/fixture/source",
    target: "C:/fixture/target",
    sourceProductFingerprint: "source-fingerprint",
    targetTreeFingerprint: "target-fingerprint",
    protectedManifestFingerprint: "protected-fingerprint",
    componentSourceFingerprint: "component-fingerprint",
    workspaces: { registered: [], review: [] },
    profileMigration: { required: false, conflict: false },
    authorityFingerprint,
    instanceId: "ac.fixture",
    sourceVersion: "2.0.0",
  });
  expect(buildUpgradeBinding(bindingInput(official.authority_fingerprint))
    === buildUpgradeBinding(bindingInput("f".repeat(64))),
  "the local confirmation binding still depends on repeating remote authority evidence after preview");
  const authorityDrifts = [
    { release_id: official.release_id + 1, latest_release_id: official.latest_release_id + 1 },
    { commit_sha: "e".repeat(40) },
    { git_tree_sha: "f".repeat(40) },
    { target_tree_sha256: `sha256:${"1".repeat(64)}` },
    { release_manifest_sha256: `sha256:${"2".repeat(64)}` },
    { target_file_count: official.target_file_count + 1 },
  ];
  for (const drift of authorityDrifts) {
    const changed = { ...official, ...drift };
    expect(officialAuthorityFingerprint(changed) !== official.authority_fingerprint,
      `stable authority drift was not bound: ${Object.keys(drift).join(",")}`);
  }
  const releaseBytesBeforeNetworkFailure = [...releaseFiles].map(([ref, bytes]) => [ref, Buffer.from(bytes)]);
  let networkFailureRejected = false;
  try {
    await verifyOfficialAiCarryRelease({
      target: releaseTarget,
      requestJson: async () => { throw new Error("GitHub HTTP 403"); },
    });
  } catch { networkFailureRejected = true; }
  expect(networkFailureRejected && releaseBytesBeforeNetworkFailure.every(([ref, bytes]) =>
    Buffer.compare(readFileSync(resolve(releaseTarget, ...ref.split("/"))), bytes) === 0),
  "a recoverable network failure changed the inspected target or was accepted as authority");
  let draftRejected = false;
  try {
    await verifyOfficialAiCarryRelease({
      target: releaseTarget,
      requestJson: async (path, label) => path === "/releases/tags/v2.0.10"
        ? { ...releaseObject, draft: true }
        : requestJson(path, label),
    });
  } catch { draftRejected = true; }
  expect(draftRejected, "a draft Release was accepted as upgrade authority");
  let annotatedTagRejected = false;
  try {
    await verifyOfficialAiCarryRelease({
      target: releaseTarget,
      requestJson: async (path, label) => path === "/git/ref/tags/v2.0.10"
        ? { object: { type: "tag", sha: "e".repeat(40) } }
        : requestJson(path, label),
    });
  } catch { annotatedTagRejected = true; }
  expect(annotatedTagRejected, "an annotated tag was accepted where the release contract requires a lightweight tag");
  expect(officialAuthorityFingerprint({ ...official, main_commit_sha: "f".repeat(40), request_count: 6 })
    === official.authority_fingerprint, "moving main or diagnostic request counts changed immutable release authority");
  let latestMismatchRejected = false;
  try {
    await verifyOfficialAiCarryRelease({
      target: releaseTarget,
      requestJson: async (path, label) => path === "/releases/latest"
        ? { ...releaseObject, id: releaseObject.id + 1 }
        : requestJson(path, label),
    });
  } catch { latestMismatchRejected = true; }
  expect(latestMismatchRejected, "a different latest Release was accepted as the fixed-version authority");
  let byteMismatchRejected = false;
  try {
    await verifyOfficialAiCarryRelease({
      target: releaseTarget,
      requestJson: async (path, label) => path === `/git/trees/${treeSha}?recursive=1`
        ? { truncated: false, tree: [...releaseFiles].map(([pathName]) => ({ path: pathName, type: "blob", mode: "100644", sha: "0".repeat(40) })) }
        : requestJson(path, label),
    });
  } catch { byteMismatchRejected = true; }
  expect(byteMismatchRejected, "target bytes differing from the fixed tag were accepted");

  const vagueReply = confirmUpgrade("", "", "", "迁移升级");
  expect(vagueReply.decision === "ai-carry-upgrade-confirmation-unverified" && vagueReply.updated === false,
    "a vague or pre-preview reply could authorize writes");

  const releaseManifestSource = readFileSync(resolve(repository, "core/upgrade/release-manifest-2.0.10.toml"), "utf8");
  const supportedSources = JSON.parse(/^from_versions\s*=\s*(\[[^\n]*\])/mu.exec(releaseManifestSource)?.[1] ?? "null");
  expect(Array.isArray(supportedSources) && ["1.4.8", "1.4.9", "2.0.0", "2.0.1", "2.0.2", "2.0.3", "2.0.4", "2.0.5", "2.0.6", "2.0.7", "2.0.8", "2.0.9"]
    .every((version) => supportedSources.includes(version)),
  "a supported older version is missing from the direct 2.0.10 upgrade sources");
  const dashboardActions = JSON.parse(readFileSync(resolve(repository, "dashboard/src/generated/dashboard-actions.json"), "utf8"));
  expect(validateUpgradeRuntimeContract(releaseManifestSource, dashboardActions).action_id === "instance.upgrade-template",
    "the generated dashboard action and release manifest did not close the runtime reentry contract");
  let missingExecutorRejected = false;
  try {
    validateUpgradeRuntimeContract(releaseManifestSource.replace(
      'required_preview_executor = "dashboard/scripts/ai-carry-upgrade-cli.mjs"',
      'required_preview_executor = ""'), dashboardActions);
  } catch { missingExecutorRejected = true; }
  expect(missingExecutorRejected, "runtime reentry accepted a release manifest without the bound preview executor");

  const cli = readFileSync(resolve(repository, "dashboard/scripts/ai-carry-upgrade-cli.mjs"), "utf8");
  const prepareBody = cli.slice(cli.indexOf("function prepareUpgrade("), cli.indexOf("function confirmationUnverified("));
  expect(cli.includes("dashboard/package.json 中的开发、构建和发布 check:* 不属于已安装实例的升级验收")
    && cli.includes("不要在实例中运行开发仓库 check:* 全集"),
  "the installed-instance reentry still permits the development check suite to become an upgrade gate");
  expect(!cli.includes("walkTree(source)") && !cli.includes("cpSync(source, backup")
    && !cli.includes("sessionActivated: true") && !cli.includes("behaviorAccepted: true")
    && !cli.includes("sourceVerified: true"),
  "the CLI still scans or copies the whole source, or self-attests an authority fact");
  expect(cli.includes("verify-official-ai-carry-release.mjs")
    && !cli.includes("--source-evidence")
    && !cli.includes('overlayTree(resolve(source, "instance")')
    && !cli.includes("buildProtectedManifest(source)")
    && cli.includes("preserve-without-enumeration-and-check-on-use")
    && cli.includes('const reviewRequired = profileMigration.conflict')
    && cli.includes("--user-reply")
    && cli.includes("聊天消息角色由承载对话的宿主负责")
    && cli.includes("target path is not classified by the release manifest")
    && cli.includes("userMessageRoleAuthenticatedByCli: false")
    && cli.includes('verifyPathStates(source, sourceProductBefore, "source product paths")'),
  "one-time authority, no-enumeration preservation, path classification, or host-confirmation boundaries are missing");
  expect(prepareBody.indexOf("const targetValidation = validateTarget") < prepareBody.indexOf("if (sourceState.alreadyCurrent)")
    && prepareBody.includes("current AI Carry product path differs from the official Release")
    && prepareBody.includes("authorityVerified: verifyOfficial, networkUsed: verifyOfficial")
    && cli.includes("prepareUpgrade(sourceArgument, targetArgument, { verifyOfficial: false })")
    && cli.includes("copiedTargetTree.fingerprint !== prepared.targetTreeFingerprint")
    && cli.includes("target changed while the isolated candidate was being copied")
    && cli.includes('`.ai2-${token.slice(0, 6)}-a${attempt}-${index.toString(36)}.tmp`')
    && cli.indexOf("state.operations.push(operation);\n      copyFileSync(sourceFile, temporary);") > 0
    && cli.includes("scriptsExecuted: false, dependenciesInstalled: false, networkUsed: false")
    && cli.includes("liveOfficialReleaseAndTagTreeVerifiedInPreview: true"),
  "preview authority, offline confirm binding, copied-target drift, retry-safe staging, or truthful network reporting is missing");

  const verifier = readFileSync(resolve(repository, "dashboard/scripts/verify-official-ai-carry-release.mjs"), "utf8");
  expect(verifier.includes("/releases/tags/v${TARGET_VERSION}")
    && verifier.includes("/git/ref/tags/v${TARGET_VERSION}")
    && verifier.includes("?recursive=1")
    && verifier.includes("remote.sha !== item.gitBlobSha")
    && !verifier.includes("source-evidence"),
  "the live verifier does not bind the official Release, fixed tag tree, and exact target bytes");

  const metadataPreflight = readFileSync(resolve(repository, "dashboard/scripts/windows-upgrade-metadata-preflight.ps1"), "utf8");
  expect(metadataPreflight.includes("fsutil hardlink list")
    && metadataPreflight.includes("hardlink-inspection-failed")
    && metadataPreflight.includes("named-stream-inspection-failed")
    && metadataPreflight.includes("-ErrorAction Stop")
    && cli.includes("info.isFile() && info.nlink > 1")
    && cli.includes("contains a hardlink"),
  "Windows metadata preflight can silently miss hardlinks or stream-enumeration failures");
  if (process.platform === "win32") {
    const metadataRoot = resolve(fixture, "metadata-hardlink");
    mkdirSync(metadataRoot);
    write(metadataRoot, "first.txt", "same bytes\n");
    linkSync(resolve(metadataRoot, "first.txt"), resolve(metadataRoot, "second.txt"));
    const pathsBase64 = Buffer.from(JSON.stringify(["first.txt"]), "utf8").toString("base64");
    const result = JSON.parse(execFileSync("pwsh", ["-NoProfile", "-File",
      resolve(repository, "dashboard/scripts/windows-upgrade-metadata-preflight.ps1"),
      "-Root", metadataRoot, "-PathsBase64", pathsBase64], { encoding: "utf8", windowsHide: true }));
    expect(result.decision === "windows-upgrade-metadata-review-required"
      && result.issues.some((item) => item.path === "first.txt" && item.reason === "hardlink"),
    "a touched Windows hardlink was not stopped for local review");
  }

  passed = true;
  console.log("AI Carry upgrade CLI passed focused cases for one-time preview authority, bounded built-in governance brand repair, offline confirmation binding, bounded API requests, recoverable network refusal, real authority drift, published boundary, official already-current closure, manifest-driven template/instance write sets, unlisted/private target rejection, copied-target drift, retry-safe staging, Windows hardlink review, zero inferred removals, numbered retry, host-confirmed reply boundaries, and no self-attested session authority.");
} finally {
  if (passed) rmSync(fixture, { recursive: true, force: false });
}
