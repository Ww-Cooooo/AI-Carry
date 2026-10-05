import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectShortlistedFormalAsset, loadTrustedDomainEnvelope, parseMarkdownFrontmatterHead,
  parseSectionedToml, queryFormalAssetShortlist, validateInstanceManifestStructure, validateProposedFormalAsset } from "./asset-route-contract.mjs";
import { buildSnapshotCandidate } from "./snapshot-source-builder.mjs";
import { executeFirstInstantiation } from "./first-instantiation-transaction.mjs";
import { prepareAgentSwitch } from "./prepare-agent-switch.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, "../..");
const cli = resolve(scriptDirectory, "learning-save-cli.mjs");
const root = mkdtempSync(resolve(tmpdir(), "ai-carry-learning-journey-"));
let complete = false;

function assert(condition, message) {
  if (!condition) throw new Error(`Learning journey failed: ${message}`);
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copyTemplate(target, source = repository) {
  const manifest = validateInstanceManifestStructure(parseSectionedToml(readFileSync(resolve(source, "instance/manifest.toml"), "utf8"), "journey source"));
  assert(manifest.root.state === "template" && manifest.root.instance_id === "template", "journey source must be a blank template, not a real instance");
  cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    filter(path) {
      const parts = relative(source, path).split(sep);
      return ![".git", ".planning", ".assistant-local", ".assistant-private", ".agents", ".claude",
        "maintainer-private", "AGENTS.override.md", "workspace", "skills-lock.json"].includes(parts[0])
        && !parts.includes("node_modules");
    },
  });
}

function testTemplateCopyExclusions() {
  const source = resolve(root, "copy-source"); const target = resolve(root, "copy-target");
  mkdirSync(resolve(source, "instance"), { recursive: true });
  const manifest = readFileSync(resolve(repository, "instance/manifest.toml"), "utf8");
  writeFileSync(resolve(source, "instance/manifest.toml"), manifest);
  const denied = [".assistant-local/value.txt", ".assistant-private/value.txt", ".agents/value.txt", ".claude/worktrees/value.txt",
    "AGENTS.override.md", "workspace/value.txt", "skills-lock.json", "node_modules/value.txt",
    "dashboard/deep/node_modules/value.txt", "core/tools/nested/node_modules/value.txt"];
  for (const ref of [...denied, "core/retained.txt"]) {
    const path = resolve(source, ref); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "synthetic fixture marker");
  }
  copyTemplate(target, source);
  assert(denied.every((ref) => !existsSync(resolve(target, ref))) && existsSync(resolve(target, "core/retained.txt")),
    "journey template copy included private/local/host/workspace or nested dependencies");
  writeFileSync(resolve(source, "instance/manifest.toml"), manifest.replace('state = "template"', 'state = "instance"'));
  let refused = false; try { copyTemplate(resolve(root, "must-not-copy-instance"), source); } catch { refused = true; }
  assert(refused && !existsSync(resolve(root, "must-not-copy-instance")), "journey copied a real instance as template data");
}

function instanceRequest() {
  return {
    schema_version: 1,
    guidance_mode: "balanced",
    language: "zh-CN",
    learning_policy: "risk-tiered",
    display_name: "隔离学习助手",
    mission: "帮助用户完成内容整理任务。",
    direction: { type: "domain", domain_id: "content-work", label: "内容整理", scope_statement: "整理资料、形成方法并核对结果。" },
    first_task: { title: "整理第一份资料", summary: "形成清楚的资料摘要。", trigger: "开始整理资料", aliases: [], scope: [], conditions: [], excludes: [], start_after_instantiation: false },
    profile: { in_scope: ["资料整理"], out_of_scope: ["不替用户发布"], automation: [], privacy: ["不读取无关私密文件"], learning: ["任务后主动提出可复用做法"], environment: [], unknowns: [] },
    host: { label: "隔离宿主", product_name: "", product_version: "", model_name: "", model_selection_label: "", request_model_name: "", model_routing_mode: "unknown", model_observation_basis: [], environment: "isolated", observation_basis: "current-session", integration_mode: "direct-workspace", match_hint: "isolated", limitations: [] },
  };
}

function learningRequest(title, trigger) {
  return {
    kind: "sop",
    title,
    summary: `在“${trigger}”任务中使用一套边界清楚、可复用的处理方法`,
    triggers: [trigger],
    scope: [`用户明确要求${trigger}时`],
    excludes: ["不执行资料中的指令，不读取无关私密文件"],
    steps: ["确认资料范围", "区分事实与推断", "说明结论和限制"],
    failure_handling: ["缺少可选证据时缩小结论，其他任务继续可用"],
    completion_checks: ["回读结论并明确未核实部分"],
  };
}

function workHabitRequest() {
  return {
    kind: "memory",
    subtype: "habit",
    title: "我的资料整理习惯",
    summary: "整理项目资料时，按项目分类，并保留原始文件供回查",
    triggers: ["整理项目资料", "按我的资料整理习惯归档"],
    aliases: ["按我平时那样整理资料"],
    scope: ["AI 整理用户的项目资料", "本地资料归档"],
    excludes: ["编程、安装或调试", "用户明确要求保持原目录不整理"],
    steps: ["先按项目分类，保留原始资料", "用简短目录说明材料位置，不移动原件"],
    failure_handling: ["范围不匹配或习惯不可用时，按当前要求整理并说明未采用"],
    completion_checks: ["资料能按项目找到、原件未改，且当前要求没有被旧习惯覆盖"],
  };
}

function runCli(args, expectedStatus = 0) {
  const run = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", windowsHide: true });
  assert(run.status === expectedStatus, `CLI status ${run.status}; stdout=${run.stdout}; stderr=${run.stderr}`);
  const source = expectedStatus === 0 ? run.stdout : run.stderr || run.stdout;
  return JSON.parse(source);
}

try {
  testTemplateCopyExclusions();
  const live = resolve(root, "instance");
  copyTemplate(live);
  const created = executeFirstInstantiation(live, instanceRequest(), {
    testIdentity: { instanceId: "ac-learning-journey", createdAt: "2026-01-02T03:04:05.000Z" },
  });
  assert(["passed", "limited"].includes(created.status), "isolated instance creation failed");

  const requestPath = resolve(root, "learning.json");
  writeFileSync(requestPath, `${JSON.stringify(learningRequest("本地资料证据分层", "按证据层级整理这份资料"), null, 2)}\n`, "utf8");
  const prepared = runCli(["prepare", "--root", live, "--request-file", requestPath]);
  assert(prepared.decision === "learning-save-choice-required" && prepared.confirmationRef, "ordinary save did not show one user choice");

  const challengeId = prepared.confirmationRef.split("~")[0];
  const recordPath = resolve(live, ".assistant-local/runtime/learning-capture", `${challengeId}.json`);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.expires_at = "2000-01-01T00:00:00.000Z";
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  const saved = runCli(["confirm", "--root", live, "--request-file", requestPath,
    "--confirmation-ref", prepared.confirmationRef, "--user-reply", "留下"]);
  assert(saved.decision === "learning-save-complete" && saved.recallVerified === true,
    "an old informational timestamp blocked the save or ordinary recall failed");
  assert(!existsSync(resolve(live, ".assistant-local")), "successful save left operational state behind");

  const assetPath = resolve(live, ...saved.target.split("/"));
  const assetDigest = digest(assetPath);
  const current = runCli(["prepare", "--root", live, "--request-file", requestPath]);
  assert(current.decision === "learning-save-already-current" && digest(assetPath) === assetDigest,
    "second identical save changed the learned asset");

  const habitPath = resolve(root, "work-habit.json");
  const habitRequest = workHabitRequest();
  writeFileSync(habitPath, `${JSON.stringify(habitRequest, null, 2)}\n`, "utf8");
  const habitPrepared = runCli(["prepare", "--root", live, "--request-file", habitPath]);
  assert(habitPrepared.decision === "learning-save-choice-required" && habitPrepared.confirmationRef
    && habitPrepared.userPreview.includes("以后可按需使用的习惯")
    && habitPrepared.userPreview.includes("以后怎样采用")
    && habitPrepared.userPreview.includes("当前要求始终优先"),
  "work habit did not produce a clear natural-language confirmation preview");
  const ambiguous = runCli(["confirm", "--root", live, "--request-file", habitPath,
    "--confirmation-ref", habitPrepared.confirmationRef, "--user-reply", "如果只整理会议资料才可以"], 2);
  const contradictory = runCli(["confirm", "--root", live, "--request-file", habitPath,
    "--confirmation-ref", habitPrepared.confirmationRef, "--choice", "keep", "--user-reply", "不保存"], 2);
  assert(ambiguous.decision === "learning-save-denied" && contradictory.decision === "learning-save-denied",
    "unresolved natural language or a contradictory choice was treated as consent");
  const habitSaved = runCli(["confirm", "--root", live, "--request-file", habitPath,
    "--confirmation-ref", habitPrepared.confirmationRef, "--choice", "keep", "--user-reply", "可以，记住这个，以后帮我整理资料就这样"]);
  assert(habitSaved.decision === "learning-save-complete" && habitSaved.recallVerified === true
    && habitSaved.target.startsWith("instance/memory/"),
  "work habit did not close through the ordinary formal memory path");
  const habitAssetPath = resolve(live, ...habitSaved.target.split("/"));
  const habitSource = readFileSync(habitAssetPath, "utf8");
  assert(habitSource.includes('subtype = "habit"') && habitSource.includes("# 当前有效习惯与边界")
    && habitSource.includes("# 以后怎样采用") && habitSource.includes("# 纠正与停止")
    && habitSource.includes("用户当前明确要求始终优先") && !habitSource.includes("maturity ="),
  "saved work habit lost its subtype, usable body, correction path, or memory boundary");
  const proactiveHabit = queryFormalAssetShortlist(live, {
    queryText: "把这批新材料整理进各自项目，我想以后找起来方便。",
    workSignals: ["整理用户项目资料", "本地资料归档", "按项目分类"],
  });
  const proactiveCandidate = proactiveHabit.candidates.find((item) => item.id === habitSaved.assetId);
  assert(proactiveHabit.decision === "shortlist-ready" && proactiveCandidate
    && ["assess-confirmed-habit-scope", "automatic-confirmed-habit-if-scope-clear"].includes(proactiveCandidate.selectionMode)
    && proactiveCandidate.retrievalEvidence.workSignalMatch,
  "a relevant organizing task could not proactively recall the confirmed habit without its title");
  const loadedHabit = inspectShortlistedFormalAsset(live, proactiveHabit, habitSaved.assetId);
  assert(loadedHabit.decision === "load-bounded-body" && loadedHabit.body.includes("先按项目分类，保留原始资料")
    && loadedHabit.recallUse.state === "asset-body-loaded" && loadedHabit.executable === false,
  "host-selected work habit did not reach its bounded body or falsely authorized actions");
  const workOnly = queryFormalAssetShortlist(live, { workSignals: ["整理用户项目资料", "本地资料归档", "按项目分类"] });
  assert(workOnly.candidates.some((item) => item.id === habitSaved.assetId
    && ["assess-confirmed-habit-scope", "automatic-confirmed-habit-if-scope-clear"].includes(item.selectionMode)),
    "independent work facts without a user recall request could not find the work habit");
  const excludedWork = queryFormalAssetShortlist(live, {
    queryText: "整理项目资料", workSignals: ["用户明确要求保持原目录不整理"],
  });
  assert(excludedWork.candidates.find((item) => item.id === habitSaved.assetId)?.selectionMode === "do-not-apply-in-current-context",
    "positive user words overrode a verified work-context exclusion");
  const optOut = queryFormalAssetShortlist(live, { queryText: "这次不要使用我的资料整理习惯", workSignals: ["整理用户项目资料", "本地资料归档"] });
  assert(!optOut.candidates.some((item) => item.id === habitSaved.assetId && ["automatic-confirmed-habit-if-scope-clear", "assess-confirmed-habit-scope"].includes(item.selectionMode)),
    "the user's current opt-out still allowed the work habit to be applied");
  const unrelated = queryFormalAssetShortlist(live, {
    queryText: "修复本地安装脚本",
    workSignals: ["编程", "安装", "调试"],
  });
  assert(!unrelated.candidates.some((item) => item.id === habitSaved.assetId),
    "a unrelated task selected the work habit");
  const habitDigest = digest(habitAssetPath);
  const habitCurrent = runCli(["prepare", "--root", live, "--request-file", habitPath]);
  assert(habitCurrent.decision === "learning-save-already-current" && digest(habitAssetPath) === habitDigest,
    "second identical habit save changed the asset or created a duplicate");
  const habitSnapshot = readFileSync(resolve(live, "dashboard/public/snapshot.js"), "utf8");
  assert(habitSnapshot === readFileSync(resolve(live, "dashboard/dist/snapshot.js"), "utf8")
    && habitSnapshot.includes(habitRequest.title),
  "work habit did not reach the byte-identical dashboard snapshot pair");

  // 使用副本自己的运行工具，验证创建、保存、召回与换宿主不是互不相干的夹具。
  const switched = resolve(root, "换 Agent 独立副本");
  const switchedResult = prepareAgentSwitch({ sourceRoot: live, destinationRoot: switched });
  assert(switchedResult.decision === "independent-copy-ready" && switchedResult.syncPolicy === "none"
    && digest(resolve(switched, saved.target)) === assetDigest
    && digest(resolve(switched, habitSaved.target)) === habitDigest,
  "host switch lost saved assets or claimed automatic synchronization");
  const copiedRecall = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { queryFormalAssetShortlist, inspectShortlistedFormalAsset } from ${JSON.stringify(pathToFileURL(resolve(switched, "dashboard/scripts/asset-route-contract.mjs")).href)};
    const root = ${JSON.stringify(switched)};
    const result = queryFormalAssetShortlist(root, { queryText: "按我平时那样整理资料" });
    const loaded = inspectShortlistedFormalAsset(root, result, ${JSON.stringify(habitSaved.assetId)});
    if (loaded.decision !== "load-bounded-body" || !loaded.body.includes("先按项目分类，保留原始资料")) process.exit(2);
  `], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert(copiedRecall.status === 0, "copied runtime could not independently recall the saved habit");
  writeFileSync(resolve(switched, habitSaved.target), `${habitSource}\n独立副本的合成修改。\n`);
  assert(digest(habitAssetPath) === habitDigest, "independent copy modified the original learned asset");

  // Ordinary reads tolerate harmless metadata drift without modifying source
  // bytes; strict writes still reject unknown fields and authorization loss.
  const compatibleHabit = habitSource.replace('title = "我的资料整理习惯"', 'title = "项目资料整理习惯"')
    .replace(/^updated_at = .*$/mu, 'updated_at = "2026-09-08"\neditor_note = "retained, not executed"');
  writeFileSync(habitAssetPath, compatibleHabit);
  const compatibleQuery = queryFormalAssetShortlist(live, { queryText: "按我平时那样整理资料" });
  assert(compatibleQuery.candidates.some((item) => item.id === habitSaved.assetId && item.title === "项目资料整理习惯" && item.metadataMigrationRequired)
    && inspectShortlistedFormalAsset(live, compatibleQuery, habitSaved.assetId).decision === "load-bounded-body",
  "harmless unknown metadata, date or stale title blocked ordinary recall");
  const compatibleSnapshot = buildSnapshotCandidate(live, { mode: "operational" });
  assert(compatibleSnapshot.snapshot.memories.some((item) => item.id === habitSaved.assetId && item.title === "项目资料整理习惯")
    && readFileSync(habitAssetPath, "utf8") === compatibleHabit,
  "operational snapshot hid the compatible habit or rewrote its source");
  const { envelope } = loadTrustedDomainEnvelope(live);
  const parsedHabit = parseMarkdownFrontmatterHead(compatibleHabit, "compatible fixture");
  assert(validateProposedFormalAsset(live, envelope, parsedHabit.values, compatibleHabit.slice(parsedHabit.bodyOffset)).decision === "proposal-invalid",
    "operational tolerance leaked into the formal write boundary");
  writeFileSync(habitAssetPath, compatibleHabit.replace('approved_by_user = true', 'approved_by_user = false'));
  assert(!queryFormalAssetShortlist(live, { queryText: "按我平时那样整理资料" }).candidates.some((item) => item.id === habitSaved.assetId),
    "authorization loss was treated as harmless metadata drift");
  writeFileSync(habitAssetPath, habitSource);

  // 同一真实创建链的隔离副本：软线提醒不挡保存，硬线只挡当前新增。
  const capacity = resolve(root, "capacity");
  cpSync(live, capacity, { recursive: true, errorOnExist: true });
  const capacityMap = resolve(capacity, "instance/maps/domain-map.toml");
  const baseMap = readFileSync(capacityMap, "utf8");
  const baseRouteCount = loadTrustedDomainEnvelope(capacity).envelope.routeCount;
  const taskRoutes = (from, to) => Array.from({ length: to - from }, (_, index) => `\n[[routes]]
id = "task-family.capacity-${from + index}"
title = "fixture ${from + index}"
summary = "unrelated fixture"
triggers = ["fixture ${from + index}"]
asset_kind = "task-family"
target = "instance/profile/approved-profile.md"
state = "on-demand"
minimum_level = 1
confirmation = "none"
`).join("");
  writeFileSync(capacityMap, baseMap + taskRoutes(baseRouteCount, 96), "utf8");
  const capacityRequest = resolve(root, "capacity.json");
  writeFileSync(capacityRequest, JSON.stringify(learningRequest("音频字幕断句方法", "根据口语停顿划分字幕")), "utf8");
  const capacityPreview = runCli(["prepare", "--root", capacity, "--request-file", capacityRequest]);
  assert(capacityPreview.userPreview.includes("仍可保存并召回"), "the public learning entry hid the soft-cap reminder");
  const capacitySaved = runCli(["confirm", "--root", capacity, "--request-file", capacityRequest,
    "--confirmation-ref", capacityPreview.confirmationRef, "--choice", "keep", "--user-reply", "保存"]);
  assert(capacitySaved.decision === "learning-save-complete" && capacitySaved.recallVerified
    && loadTrustedDomainEnvelope(capacity).envelope.routeCount === 97,
  "crossing the soft route limit blocked a legitimate save or recall");
  assert(queryFormalAssetShortlist(capacity, { queryText: "按我平时那样整理资料" }).candidates.some((item) => item.id === habitSaved.assetId),
    "crossing the soft route limit disabled an existing habit");
  writeFileSync(capacityMap, readFileSync(capacityMap, "utf8") + taskRoutes(97, 128), "utf8");
  const hardMapBefore = readFileSync(capacityMap, "utf8");
  writeFileSync(capacityRequest, JSON.stringify(learningRequest("图表配色方法", "比较图表配色")), "utf8");
  const hardPreview = runCli(["prepare", "--root", capacity, "--request-file", capacityRequest]);
  assert(hardPreview.userPreview.includes("只会生成定向复核请求"), "exceeding the hard route limit allowed an incomplete map write");
  runCli(["confirm", "--root", capacity, "--request-file", capacityRequest,
    "--confirmation-ref", hardPreview.confirmationRef, "--choice", "discard", "--user-reply", "不保存"]);
  assert(readFileSync(capacityMap, "utf8") === hardMapBefore
    && queryFormalAssetShortlist(capacity, { queryText: "按我平时那样整理资料" }).candidates.some((item) => item.id === habitSaved.assetId),
  "a denied new route changed or disabled the previous map");

  const observePath = resolve(root, "observe.json");
  writeFileSync(observePath, `${JSON.stringify(learningRequest("采访内容结构观察", "整理采访内容结构"), null, 2)}\n`, "utf8");
  const oldRecordDirectory = resolve(live, ".assistant-local/runtime/learning-capture");
  const oldRecordPath = resolve(oldRecordDirectory, "capture.00000000000000000000000000000000.json");
  mkdirSync(oldRecordDirectory, { recursive: true });
  writeFileSync(oldRecordPath, "{\n  \"old_record\": true\n}\n", "utf8");
  const oldRecordDigest = digest(oldRecordPath);
  const observePrepared = runCli(["prepare", "--root", live, "--request-file", observePath]);
  assert(observePrepared.decision === "learning-save-choice-required" && observePrepared.userReport
    && digest(oldRecordPath) === oldRecordDigest,
  "one malformed older learning record blocked a new save, was silently changed, or was not reported");
  const observed = runCli(["confirm", "--root", live, "--request-file", observePath,
    "--confirmation-ref", observePrepared.confirmationRef, "--user-reply", "先观察"]);
  assert(observed.decision === "learning-save-observation-complete" && observed.validationClaimed === false,
    "observe choice was mislabeled or promoted as validated");

  const projectionFaultPath = resolve(root, "projection-fault.json");
  writeFileSync(projectionFaultPath,
    `${JSON.stringify(learningRequest("快照故障下仍保留候选", "在看板暂时损坏时保存观察候选"), null, 2)}\n`, "utf8");
  const projectionFaultPrepared = runCli(["prepare", "--root", live, "--request-file", projectionFaultPath]);
  const publicSnapshotPath = resolve(live, "dashboard/public/snapshot.js");
  const distSnapshotPath = resolve(live, "dashboard/dist/snapshot.js");
  const healthySnapshot = readFileSync(distSnapshotPath);
  writeFileSync(publicSnapshotPath, Buffer.concat([healthySnapshot, Buffer.from("// isolated projection fault\n", "utf8")]));
  const projectionLimited = runCli(["confirm", "--root", live, "--request-file", projectionFaultPath,
    "--confirmation-ref", projectionFaultPrepared.confirmationRef, "--user-reply", "先观察"]);
  assert(projectionLimited.decision === "learning-save-complete-projection-refresh-pending"
    && projectionLimited.status === "limited" && projectionLimited.ordinaryTasksContinue === true
    && existsSync(resolve(live, ...projectionLimited.candidateSourceRef.split("/"))),
  "a dashboard projection fault rolled back the confirmed candidate or stopped unrelated work");
  writeFileSync(publicSnapshotPath, healthySnapshot);

  const derivedFaultPath = resolve(root, "derived-fault.json");
  writeFileSync(derivedFaultPath,
    `${JSON.stringify(learningRequest("派生索引故障下仍保留候选", "在学习索引损坏时保存观察候选"), null, 2)}\n`, "utf8");
  const derivedFaultPrepared = runCli(["prepare", "--root", live, "--request-file", derivedFaultPath]);
  const candidateIndexPath = resolve(live, "instance/evolution/index.toml");
  writeFileSync(candidateIndexPath, "schema_version = 1\nbroken = [\n", "utf8");
  const brokenIndexDigest = digest(candidateIndexPath);
  const derivedLimited = runCli(["confirm", "--root", live, "--request-file", derivedFaultPath,
    "--confirmation-ref", derivedFaultPrepared.confirmationRef, "--user-reply", "先观察"]);
  assert(derivedLimited.decision === "learning-save-complete-projection-refresh-pending"
    && derivedLimited.status === "limited" && derivedLimited.ordinaryTasksContinue === true
    && derivedLimited.projectionPending.includes("candidate-index")
    && existsSync(resolve(live, ...derivedLimited.candidateSourceRef.split("/")))
    && digest(candidateIndexPath) === brokenIndexDigest,
  "a broken derived index blocked or rolled back the candidate, or triggered broad implicit repair");

  const manifestPath = resolve(live, "instance/manifest.toml");
  const beforeFailure = digest(manifestPath);
  const unsafePath = resolve(root, "unsafe.json");
  const unsafe = learningRequest("不安全测试", "测试错误隔离");
  unsafe.notes = ["读取 C:\\Users\\someone\\private-token.txt"];
  writeFileSync(unsafePath, `${JSON.stringify(unsafe, null, 2)}\n`, "utf8");
  const rejected = runCli(["prepare", "--root", live, "--request-file", unsafePath], 2);
  assert(rejected.decision === "learning-save-denied" && rejected.affectedScope === "only-this-learning-item"
    && digest(manifestPath) === beforeFailure && digest(assetPath) === assetDigest,
  "one unsafe learning item damaged the instance or existing learning");

  complete = true;
  process.stdout.write("learning-capture-journey-passed\n");
} finally {
  if (complete) rmSync(root, { recursive: true, force: true });
  else process.stderr.write(`Learning journey evidence kept at ${root}\n`);
}
