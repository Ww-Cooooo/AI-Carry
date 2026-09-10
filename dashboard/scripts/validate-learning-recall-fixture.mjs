import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as assetContract from "./asset-route-contract.mjs";
import { auditCandidateSourceClosure, inspectCandidateForReview, inspectCandidateSource, loadCandidateIndex } from "./candidate-index-contract.mjs";

const { auditFormalSourceClosure, inspectAssetForReview, inspectAssetMetadata, inspectAssetRoute,
  inspectShortlistedFormalAsset, inspectTaskFamilyRoute, loadTrustedDomainEnvelope, queryFormalAssetShortlist } = assetContract;
const assert = (condition, message) => { if (!condition) throw new Error(`Learning/recall disk fixture failed: ${message}`); };
const root = mkdtempSync(join(tmpdir(), "ai-carry-learning-fixture-"));
let complete = false;
const q = (value) => JSON.stringify(value);
const write = (ref, content) => {
  const target = resolve(root, ...ref.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
};

function fields(source) {
  return Object.entries(source).map(([key, value]) => `${key} = ${Array.isArray(value) ? q(value) : typeof value === "string" ? q(value) : value}`).join("\n");
}

function route(overrides = {}) {
  return {
    id: "sop.learning-platform-grade-summary", asset_kind: "sop", title: "汇总学习平台成绩",
    summary: "把学习平台成绩整理成容易核对的汇总。", triggers: ["帮我弄一下学习通上成绩", "汇总一下网课分数"],
    aliases: ["上次那种成绩汇总"], topic_key: "grade-analysis", subject_key: "learning-platform",
    scope: ["学习平台导出的成绩"], conditions: ["用户需要汇总或核对成绩"], excludes: ["只修改单个学生的原始分数"],
    related_asset_ids: [], body_sections: [], target: "instance/sops/grade-summary.md", state: "active", minimum_level: 1, confirmation: "none",
    ...overrides,
  };
}

function assetDocument(item, body = "# 正文第一行\n只对当前任务需要的内容进行处理。", overrides = {}, omit = []) {
  const values = {
    id: item.id, kind: item.asset_kind, ...(Object.hasOwn(item, "subtype") ? { subtype: item.subtype } : {}), status: item.state,
    title: item.title, summary: item.summary, triggers: item.triggers, aliases: item.aliases, topic_key: item.topic_key,
    subject_key: item.subject_key, scope: item.scope, conditions: item.conditions, excludes: item.excludes,
    lifecycle: "recurring", expected_next_use: "", source_refs: [], private_refs: [], supersedes: [], updated_at: "",
    related_asset_ids: item.related_asset_ids, body_sections: item.body_sections, minimum_level: item.minimum_level,
    approval_state: "explicit", activation_basis: "explicit-user", risk_tier: "low", approved_by_user: true, confirmation: item.confirmation,
    ...(["capability", "sop"].includes(item.asset_kind) ? { maturity: "unvalidated", independent_task_count: 0, successful_use_count: 0,
      failed_use_count: 0, distinct_context_count: 0, distinct_host_count: 0, last_validated_at: "", validation_refs: [], host_experience_refs: [] } : {}),
    ...overrides,
  };
  for (const key of omit) delete values[key];
  return `+++\n${fields(values)}\n+++\n${body}`;
}

function mapDocument(routes, { instanceId = "ac-fixture", overflowState = "ok" } = {}) {
  const head = `schema_version = 1\nmap_id = "instance-domain"\ninstance_id = ${q(instanceId)}\ndirection = "education"\nstatus = "active"\n\n[budget]\nsoft_max_bytes = 32768\nhard_max_bytes = 49152\nsoft_max_routes = 96\nhard_max_routes = 128\nmax_route_bytes = 2048\ncandidate_limit = 3\noverflow_state = ${q(overflowState)}\n`;
  return `${head}${routes.map((item) => `\n[[routes]]\n${fields(item)}\n`).join("")}`;
}

function installMap(routes, options = {}) {
  write("instance/maps/domain-map.toml", mapDocument(routes, options));
  return loadTrustedDomainEnvelope(root, options.explicitRequestedId ? { explicitRequestedId: options.explicitRequestedId } : {});
}

function candidateSource(entry, overrides = {}) {
  const values = {
    id: entry.id, kind: "evolution-candidate", status: entry.status, title: entry.title, summary: entry.summary,
    triggers: entry.triggers, aliases: entry.aliases, topic_key: entry.topic_key, subject_key: entry.subject_key,
    scope: entry.scope, conditions: entry.conditions, excludes: entry.excludes, target_kind: entry.target_kind,
    target_subtype: entry.target_subtype, candidate_relation: entry.candidate_relation, observation_state: entry.observation_state, observation_basis: entry.observation_basis,
    proposed_risk_tier: entry.risk_tier, independent_event_count: entry.independent_event_count, last_evidence_at: entry.last_evidence_at,
    successful_event_count: 0, failed_event_count: 0, distinct_context_count: entry.independent_event_count,
    representative_event_ids: [], source_refs: [], private_refs: [], supersedes: [], trigger_revision: 0,
    source_revision: entry.source_revision, minimum_level: 2, approval_state: "pending", activation_basis: "candidate",
    risk_tier: entry.risk_tier, approved_by_user: false, ...overrides,
  };
  return `+++\n${fields(values)}\n+++\n# 候选证据\n只保存用户已同意观察的低敏结论。`;
}

function candidateIndex(entries, { revision = 1 } = {}) {
  const active = entries.filter((entry) => entry.status === "candidate" && entry.observation_state === "explicit"
    && ["explicit-user", "existing-approved-migration"].includes(entry.observation_basis)
    && ["new", "refine", "condition-variant", "related"].includes(entry.candidate_relation)
    && !(entry.target_kind === "memory" && entry.target_subtype === "")).length;
  return `schema_version = 1\nindex_id = "evolution-candidates"\ninstance_id = "ac-fixture"\nstate = "current"\nsource_revision = ${revision}\ngenerated_at = "2026-08-24T03:00:00+08:00"\nbudget_bytes = 32768\noverflow = false\ncandidate_count = ${entries.length}\nindexed_count = ${entries.length}\nactive_count = ${active}\n${entries.map((entry) => `\n[[candidates]]\n${fields(entry)}\n`).join("")}`;
}

function validationIndex(records) {
  const current = records.length > 0;
  return `schema_version = 1\nindex_id = "result-validations"\ninstance_id = "ac-fixture"\nstate = "${current ? "current" : "empty"}"\nsource_revision = ${current ? 1 : 0}\ngenerated_at = "${current ? "2026-08-24T03:30:00+08:00" : ""}"\nbudget_bytes = 262144\noverflow = false\nrecord_count = ${records.length}\n${records.map((record) => `\n[[validations]]\n${fields(record)}\n`).join("")}`;
}

function validationRecord(id, assetId, taskEventId, contextId, overrides = {}) {
  return {
    id, asset_id: assetId, outcome: "success", task_event_id: taskEventId, context_id: contextId,
    host_experience_ref: "", environment_ref: "", validated_at: "2026-08-24T03:20:00+08:00",
    result_protocol: "result-validation-v1", source_revision: 1, ...overrides,
  };
}

try {
  write("core/manifest.toml", `schema_version = 1\ncore_id = "ai-carry-core"\nversion = "fixture"\nasset_schema = "1.2"\nevolution_candidate_index_schema = "1.0"\nasset_confirmation_gate_schema = "1.0"\nresult_validation_evidence_schema = "1.0"\n\n[entry]\nresult_validation_evidence_index = "instance/validations/index.toml"\n\n[contracts]\nasset_confirmation_gate_registry = "core/maps/asset-confirmation-gates.toml"\nasset_confirmation_gate_schema = "core/schemas/asset-confirmation-gates.schema.md"\nresult_validation_evidence_schema = "core/schemas/result-validation-evidence-index.schema.md"\n`);
  write("core/schemas/asset-confirmation-gates.schema.md", "# fixture schema\n");
  write("core/schemas/result-validation-evidence-index.schema.md", "# fixture schema\n");
  write("core/maps/asset-confirmation-gates.toml", `schema_version = 1\nregistry_id = "asset-confirmation-gates"\n\n[[gates]]\nid = "none"\nphase = "none"\nsummary = "没有额外资产级动作确认。"\nlegacy_aliases = []\n\n[[gates]]\nid = "risk-dependent-before-action"\nphase = "before-action"\nsummary = "真实动作仍按风险确认。"\nlegacy_aliases = ["risk-dependent"]\n\n[[gates]]\nid = "explicit-before-action"\nphase = "before-action"\nsummary = "真实动作前取得明确确认。"\nlegacy_aliases = ["explicit"]\n\n[[gates]]\nid = "before-durable-change"\nphase = "before-action"\nsummary = "持久修改前确认。"\nlegacy_aliases = ["before-write"]\n\n[[gates]]\nid = "before-sensitive-context"\nphase = "before-read"\nsummary = "受保护正文读取前确认。"\nlegacy_aliases = []\n`);
  write("instance/profile/approved-profile.md", "# 已确认实例档案\n");
  for (const ref of ["instance/memory/README.md", "instance/capabilities/README.md", "instance/sops/README.md", "instance/experiences/README.md"]) write(ref, "# fixture root\n");
  const manifest = `schema_version = 1\ninstance_id = "ac-fixture"\nstate = "instance"\ncreated_from = "ai-carry@fixture"\ncreated_at = ""\n\n[direction]\ntype = "domain"\nlocked = true\ndomain_id = "education"\nlabel = "教育助手"\nscope_statement = "测试自然语言召回"\nout_of_scope_policy = "create-new-instance"\n\n[profile]\nstatus = "active"\nguidance_mode = "balanced"\nuser_preferences_ref = "instance/profile/approved-profile.md"\ndomain_map_ref = "instance/maps/domain-map.toml"\nsignal_control_ref = "instance/signals/control.toml"\nsignal_map_ref = "instance/maps/signal-map.toml"\ntime_trigger_map_ref = "instance/maps/time-trigger-map.toml"\nhost_registry_ref = "instance/hosts/registry.toml"\n\n[learning]\npolicy = "risk-tiered"\nlow_risk_promotion = "explicit-confirmation-after-notice"\nmedium_high = "explicit-confirmation"\ndirect_user_instruction = "direct-authorization"\n\n[validation]\nevidence_index_ref = "instance/validations/index.toml"\n\n[versions]\nasset_schema = "1.2"\nevolution_candidate_index_schema = "1.0"\nasset_confirmation_gate_schema = "1.0"\nresult_validation_evidence_schema = "1.0"\n`;
  write("instance/manifest.toml", manifest);
  write("instance/validations/index.toml", validationIndex([]));

  assert(assetContract.validateDomainMapEnvelope === undefined && assetContract.loadTrustedInstanceContext === undefined, "caller-controlled envelope minting remained exported");

  const main = route();
  write(main.target, assetDocument(main));
  let loaded = installMap([main]);
  assert(loaded.envelope.routes.length === 1, "physical manifest -> map envelope did not load");
  const exactBody = inspectAssetRoute(root, loaded.envelope, main.id);
  assert(exactBody.decision === "load-bounded-body" && exactBody.executable === false && exactBody.body.startsWith("# 正文第一行"), "Chinese frontmatter corrupted the exact body boundary");
  assert(auditFormalSourceClosure(root).decision === "formal-source-closure-complete", "maintenance formal projection closure rejected an exact source/map pair");

  const futureRoute = route({ id: "sop.future-description", title: "未来字段兼容路线",
    target: "instance/sops/future-description.md", triggers: ["使用未来字段路线"], future_note: "只作描述，不是指令" });
  write(futureRoute.target, assetDocument(futureRoute));
  write("instance/maps/domain-map.toml", mapDocument([main, futureRoute]));
  const futureCompatible = queryFormalAssetShortlist(root, { queryText: "帮我弄一下学习通上成绩" });
  assert(futureCompatible.candidates.some((item) => item.id === main.id) && futureCompatible.isolatedRouteCount === 0,
    "one unknown descriptive route field disabled ordinary recall");
  let strictFutureFieldRejected = false;
  try { loadTrustedDomainEnvelope(root); } catch { strictFutureFieldRejected = true; }
  assert(strictFutureFieldRejected, "maintenance closure silently accepted an unknown route field");

  const malformedRoute = route({ id: "sop.malformed-neighbour", title: "" });
  write("instance/maps/domain-map.toml", mapDocument([main, malformedRoute]));
  const isolatedNeighbour = queryFormalAssetShortlist(root, { queryText: "帮我弄一下学习通上成绩" });
  assert(isolatedNeighbour.candidates.some((item) => item.id === main.id) && isolatedNeighbour.isolatedRouteCount === 1
    && isolatedNeighbour.integrityState === "degraded-valid-matches-only",
  "one malformed neighbouring route disabled a valid recalled asset instead of being isolated");
  write("instance/maps/domain-map.toml", mapDocument([main]));

  write(main.target, assetDocument(main, "# 正文第一行\n只对当前任务需要的内容进行处理。", { summary: "与地图不一致" }));
  let formalDriftBlocked = false;
  try { auditFormalSourceClosure(root); } catch { formalDriftBlocked = true; }
  assert(formalDriftBlocked, "formal maintenance closure missed a non-title route/source projection drift");
  write(main.target, assetDocument(main));

  const reliable = route({ id: "capability.grade-normalizer", asset_kind: "capability", title: "核对成绩表结构",
    target: "instance/capabilities/grade-normalizer.md", triggers: ["核对成绩表结构"], aliases: ["检查成绩列"],
    topic_key: "grade-normalization", subject_key: "learning-platform" });
  const reliableRefs = ["validation.grade-1", "validation.grade-2", "validation.grade-3"];
  const reliableRecords = [
    validationRecord(reliableRefs[0], reliable.id, "task-event.grade-1", "context.grade-import"),
    validationRecord(reliableRefs[1], reliable.id, "task-event.grade-2", "context.grade-import"),
    validationRecord(reliableRefs[2], reliable.id, "task-event.grade-3", "context.grade-review"),
  ];
  write(reliable.target, assetDocument(reliable, "# 使用方法\n核对成绩列，不修改原始成绩。", {
    maturity: "reliable", independent_task_count: 3, successful_use_count: 3, failed_use_count: 0,
    distinct_context_count: 2, distinct_host_count: 0, last_validated_at: "2026-08-24T03:20:00+08:00",
    validation_refs: reliableRefs, host_experience_refs: [],
  }));
  write("instance/validations/index.toml", validationIndex(reliableRecords));
  loaded = installMap([reliable]);
  const reliableRead = inspectAssetRoute(root, loaded.envelope, reliable.id);
  assert(reliableRead.decision === "load-bounded-body" && reliableRead.executionMetadata.maturity === "reliable"
    && reliableRead.executionMetadata.distinctContextCount === 2, "three independent successes across two contexts did not establish reliable maturity");

  write(reliable.target, assetDocument(reliable, "# 使用方法\n核对成绩列，不修改原始成绩。", {
    maturity: "practiced", independent_task_count: 1, successful_use_count: 1, failed_use_count: 0,
    distinct_context_count: 1, distinct_host_count: 0, last_validated_at: "2026-08-24T03:20:00+08:00",
    validation_refs: [reliableRefs[0]], host_experience_refs: [],
  }));
  write("instance/validations/index.toml", validationIndex([reliableRecords[0]]));
  loaded = installMap([reliable]);
  assert(inspectAssetRoute(root, loaded.envelope, reliable.id).executionMetadata?.maturity === "practiced", "one closed successful task did not establish practiced maturity");

  const invalidReliable = (records, refs = reliableRefs, assetOverrides = {}) => {
    write(reliable.target, assetDocument(reliable, "# 使用方法\n核对成绩列，不修改原始成绩。", {
      maturity: "reliable", independent_task_count: 3, successful_use_count: 3, failed_use_count: 0,
      distinct_context_count: 2, distinct_host_count: 0, last_validated_at: "2026-08-24T03:20:00+08:00",
      validation_refs: refs, host_experience_refs: [], ...assetOverrides,
    }));
    write("instance/validations/index.toml", validationIndex(records));
    const envelope = installMap([reliable]).envelope;
    return inspectAssetRoute(root, envelope, reliable.id);
  };
  assert(invalidReliable(reliableRecords.slice(0, 2)).decision !== "load-bounded-body", "reliable maturity accepted a missing evidence reference");
  assert(invalidReliable([reliableRecords[0], { ...reliableRecords[1], task_event_id: reliableRecords[0].task_event_id }, reliableRecords[2]]).decision !== "load-bounded-body",
    "two records for the same asset/task event inflated independent success");
  assert(invalidReliable(reliableRecords.map((record) => ({ ...record, context_id: "context.grade-import" })), reliableRefs, { distinct_context_count: 1 }).decision !== "load-bounded-body",
    "three successes in one context established reliable maturity");
  assert(invalidReliable(reliableRecords.map((record, index) => index === 2 ? { ...record, asset_id: "capability.other" } : record)).decision !== "load-bounded-body",
    "evidence belonging to another asset closed reliable maturity");
  assert(invalidReliable(reliableRecords, reliableRefs, { independent_task_count: 100, successful_use_count: 100 }).decision !== "load-bounded-body",
    "frontmatter self-reported more successes than the complete evidence registry contains");
  const hiddenFailure = validationRecord("validation.grade-hidden-failure", reliable.id, "task-event.grade-hidden-failure", "context.grade-review", { outcome: "failure" });
  assert(invalidReliable([...reliableRecords, hiddenFailure], reliableRefs, { independent_task_count: 4, successful_use_count: 3, failed_use_count: 1 }).decision !== "load-bounded-body",
    "an unreferenced failure record was hidden from reliable maturity");

  const manyRecords = Array.from({ length: 129 }, (_, index) => validationRecord(`validation.scale-${index}`, reliable.id,
    `task-event.scale-${index}`, index % 2 === 0 ? "context.scale-a" : "context.scale-b"));
  const manyRefs = manyRecords.slice(0, 3).map((record) => record.id);
  write(reliable.target, assetDocument(reliable, "# 使用方法\n核对大规模当前证据索引。", {
    maturity: "reliable", independent_task_count: 129, successful_use_count: 129, failed_use_count: 0,
    distinct_context_count: 2, distinct_host_count: 0, last_validated_at: "2026-08-24T03:20:00+08:00",
    validation_refs: manyRefs, host_experience_refs: [],
  }));
  write("instance/validations/index.toml", validationIndex(manyRecords));
  loaded = installMap([reliable]);
  assert(inspectAssetRoute(root, loaded.envelope, reliable.id).executionMetadata?.maturity === "reliable",
    "a bounded current evidence set above the old 128-record ceiling invalidated mature assets");

  const hostOne = route({ id: "experience.host.codex", asset_kind: "experience", subtype: "host-execution", title: "Codex 宿主执行经验",
    target: "instance/experiences/host-codex.md", triggers: ["在 Codex 执行"], aliases: [], topic_key: "host-execution", subject_key: "codex" });
  const hostTwo = route({ ...hostOne, id: "experience.host.trae", title: "Trae 宿主执行经验", target: "instance/experiences/host-trae.md",
    triggers: ["在 Trae 执行"], subject_key: "trae" });
  const hostAssetOverrides = { maturity: "unvalidated", independent_task_count: 0, successful_use_count: 0, failed_use_count: 0,
    distinct_context_count: 0, last_validated_at: "", validation_refs: [], portable_core_ref: reliable.id,
    host_profile_refs: ["host.profile"], environment_scope: ["local desktop"], validity_signals: ["host profile matched"] };
  write(hostOne.target, assetDocument(hostOne, "# 宿主经验\n仅在宿主匹配后按需加载。", hostAssetOverrides));
  write(hostTwo.target, assetDocument(hostTwo, "# 宿主经验\n仅在宿主匹配后按需加载。", hostAssetOverrides));
  const portableRecords = reliableRecords.map((record, index) => ({ ...record, host_experience_ref: index === 1 ? hostTwo.id : hostOne.id }));
  write(reliable.target, assetDocument(reliable, "# 使用方法\n跨宿主核对成绩列。", {
    maturity: "portable", independent_task_count: 3, successful_use_count: 3, failed_use_count: 0,
    distinct_context_count: 2, distinct_host_count: 2, last_validated_at: "2026-08-24T03:20:00+08:00",
    validation_refs: reliableRefs, host_experience_refs: [hostOne.id, hostTwo.id],
  }));
  write("instance/validations/index.toml", validationIndex(portableRecords));
  loaded = installMap([reliable, hostOne, hostTwo]);
  assert(inspectAssetRoute(root, loaded.envelope, reliable.id).executionMetadata?.maturity === "portable", "closed evidence across two registered hosts did not establish portable maturity");
  write(reliable.target, assetDocument(reliable, "# 使用方法\n跨宿主核对成绩列。", {
    maturity: "portable", independent_task_count: 3, successful_use_count: 3, failed_use_count: 0,
    distinct_context_count: 2, distinct_host_count: 1, last_validated_at: "2026-08-24T03:20:00+08:00",
    validation_refs: reliableRefs, host_experience_refs: [hostOne.id],
  }));
  write("instance/validations/index.toml", validationIndex(portableRecords.map((record) => ({ ...record, host_experience_ref: hostOne.id }))));
  loaded = installMap([reliable, hostOne, hostTwo]);
  assert(inspectAssetRoute(root, loaded.envelope, reliable.id).decision !== "load-bounded-body", "one host was accepted as portable maturity");

  write("instance/validations/index.toml", validationIndex([]));
  write(main.target, assetDocument(main));
  loaded = installMap([main]);

  const privateMemory = route({ id: "memory.private-teacher-files", asset_kind: "memory", subtype: "general", title: "教师资料引用",
    target: "instance/memory/private-teacher-files.md", triggers: ["使用我的教师资料"], aliases: ["教师私密资料"], topic_key: "teacher-files", subject_key: "private-catalog" });
  write(privateMemory.target, assetDocument(privateMemory, "# 使用说明\n只有任务命中后才通过隐私目录门读取。", { private_refs: ["private://teacher-records/class-a"] }));
  loaded = installMap([privateMemory]);
  const privateMemoryRead = inspectAssetRoute(root, loaded.envelope, privateMemory.id);
  assert(privateMemoryRead.decision === "load-bounded-body" && privateMemoryRead.executionMetadata.privateReferenceCount === 1
    && !JSON.stringify(privateMemoryRead).includes("private://"), "a valid private locator was rejected or leaked into model-visible output");

  const staleEnvelope = loaded.envelope;
  write("instance/maps/domain-map.toml", mapDocument([{ ...main, summary: "已经改变的路线摘要。" }]));
  assert(inspectAssetRoute(root, staleEnvelope, main.id).decision === "deny-untrusted-envelope", "stale map envelope remained usable");
  write("instance/maps/domain-map.toml", mapDocument([main]));

  const unknown = route({ id: "sop.unknown-gate", title: "旧确认语义待迁移", target: "instance/sops/unknown-gate.md", confirmation: "mystery-before-send" });
  write(unknown.target, assetDocument(unknown));
  loaded = installMap([main, unknown]);
  assert(loaded.envelope.routes.length === 1 && loaded.envelope.routes[0].id === main.id, "unknown confirmation gate weakened or disabled valid neighbouring routes");
  const unknownExplicit = installMap([main, unknown], { explicitRequestedId: unknown.id });
  assert(inspectAssetRoute(root, unknownExplicit.envelope, unknown.id).decision === "deny-untrusted-envelope", "unknown confirmation gate reached a body");
  const legacyGate = route({ id: "sop.legacy-gate", title: "旧版确认门", target: "instance/sops/legacy-gate.md", confirmation: "before-write" });
  write(legacyGate.target, assetDocument(legacyGate));
  loaded = installMap([legacyGate]);
  const legacyRead = inspectAssetRoute(root, loaded.envelope, legacyGate.id);
  assert(legacyRead.decision === "load-bounded-body" && legacyRead.metadataMigrationRequired === true
    && legacyRead.requiredConfirmationGates.some((gate) => gate.id === "before-durable-change"), "registered legacy confirmation alias was not conservatively migrated");

  const missingApproval = route({ id: "sop.missing-approval", title: "缺授权字段", target: "instance/sops/missing-approval.md" });
  write(missingApproval.target, assetDocument(missingApproval, "不应加载", {}, ["approved_by_user"]));
  loaded = installMap([missingApproval]);
  assert(inspectAssetRoute(root, loaded.envelope, missingApproval.id).decision === "deny-frontmatter-contract", "missing approved_by_user loaded a formal body");

  const habit = route({ id: "memory.habit.concise-updates", asset_kind: "memory", subtype: "habit", title: "偏好简短进度", target: "instance/memory/habit-concise.md",
    triggers: ["进度简短一点"], aliases: ["少说步骤"], topic_key: "communication", subject_key: "progress-updates",
    scope: ["工作进度更新"], conditions: ["当前任务需要进度更新"], excludes: [] });
  write(habit.target, assetDocument(habit));
  loaded = installMap([habit]);
  const habitMetadata = inspectAssetMetadata(root, loaded.envelope, habit.id);
  assert(habitMetadata.decision === "metadata-verified" && habitMetadata.selectionMode === "automatic-confirmed-habit-if-scope-clear" && !Object.hasOwn(habitMetadata, "body"), "confirmed habit metadata did not stay body-free or use the narrow automatic mode");
  const proactiveHabit = queryFormalAssetShortlist(root, { queryText: "", workSignals: [
    "进度简短一点", "communication", "progress-updates", "工作进度更新", "当前任务需要进度更新",
  ] });
  assert(proactiveHabit.decision === "shortlist-ready" && proactiveHabit.candidates.length === 1
    && proactiveHabit.candidates[0].retrievalEvidence.workSignalMatch
    && proactiveHabit.candidates[0].retrievalEvidence.automaticEvidenceSource === "work-context",
  "a verified current-work signal did not produce one bounded proactive habit selection");
  const proactiveHabitBody = inspectShortlistedFormalAsset(root, proactiveHabit, habit.id);
  assert(proactiveHabitBody.decision === "load-bounded-body" && proactiveHabitBody.body.includes("只对当前任务需要的内容进行处理")
    && proactiveHabitBody.recallUse?.state === "asset-body-loaded"
    && proactiveHabitBody.recallUse?.assetKind === "memory"
    && proactiveHabitBody.recallUse?.triggerSources.includes("work-context")
    && proactiveHabitBody.recallUse?.userReportRequired === false
    && proactiveHabitBody.recallUse?.userReportContract === "report-actual-application-only-not-body-loading",
    "a proactive habit selection did not read the exact verified body");
  const higherRiskHabit = { ...habit, confirmation: "risk-dependent-before-action" };
  write(habit.target, assetDocument(higherRiskHabit, "# 需按动作风险确认", { risk_tier: "medium" }));
  loaded = installMap([higherRiskHabit]);
  const guardedHabit = inspectAssetMetadata(root, loaded.envelope, habit.id);
  assert(guardedHabit.selectionMode === "confirm-fuzzy-before-body" && guardedHabit.requiresUserConfirmation,
    "a higher-risk habit received the low-risk automatic reuse exemption");
  const policyHabit = route({ ...habit, id: "memory.habit.policy", title: "未获明确授权的习惯", target: "instance/memory/habit-policy.md" });
  write(policyHabit.target, assetDocument(policyHabit, "不应加载", { approval_state: "policy-authorized", activation_basis: "low-risk-evidence-policy", approved_by_user: false }));
  loaded = installMap([policyHabit]);
  assert(inspectAssetRoute(root, loaded.envelope, policyHabit.id).decision === "frontmatter-review-only", "policy-authorized habit bypassed explicit user approval");

  const review = route({ id: "sop.review-only", title: "待复核流程", target: "instance/sops/review.md", state: "review" });
  write(review.target, assetDocument(review, "# 待复核\n仅用于理解旧证据。"));
  loaded = installMap([review], { explicitRequestedId: review.id });
  assert(inspectAssetRoute(root, loaded.envelope, review.id).decision === "deny-untrusted-envelope", "review route entered ordinary loading");
  const reviewEvidence = inspectAssetForReview(root, loaded.envelope, review.id, { explicitRequestedId: review.id });
  assert(reviewEvidence.decision === "review-evidence-only" && reviewEvidence.recommendedLevel === 1,
    "explicit review did not return bounded evidence with advisory model guidance");
  const family = route({ id: "task-family.grade", asset_kind: "task-family", title: "成绩任务入口", target: "instance/profile/approved-profile.md", state: "on-demand" });
  loaded = installMap([family]);
  assert(inspectTaskFamilyRoute(root, loaded.envelope, family.id).decision === "load-bounded-task-family", "registered task-family entry failed");

  // Exercise the actual stdin/stdout boundary, not just its internal reader.
  // This prelinked fixture tests navigation ONLY: it does not test an Agent
  // creating links during save or choosing the right next task after recall.
  // All documents are synthetic; no real instance or private corpus is copied.
  const scripts = resolve(root, "dashboard/scripts");
  mkdirSync(scripts, { recursive: true });
  for (const name of readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".mjs"))) {
    copyFileSync(new URL(name, import.meta.url), resolve(scripts, name));
  }
  const runCli = (input) => {
    const result = spawnSync(process.execPath, [resolve(scripts, "query-assets.mjs")],
      { input: JSON.stringify(input), encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 });
    return { status: result.status, output: JSON.parse(result.stdout) };
  };
  const profile = "# 当前任务\n[工作索引](../../workspace/example/index.md)\n";
  const index = "# 当前进度\n- 已接受且已完成：[练习 A](./accepted.md)\n- 已撤回：[练习 B](./withdrawn.md)\n- 下一步：练习 C，比较不同条件，不重复 A。\n";
  write(family.target, profile);
  write("workspace/example/index.md", index);
  write("workspace/example/accepted.md", "# 练习 A\n用户已接受，保留原稿。\n");
  write("workspace/example/withdrawn.md", "# 练习 B\n重复了 A，用户要求撤回，不是当前版本。\n");
  const request = { operation: "query", queryText: "上次那种成绩汇总" };
  const shortlist = runCli(request);
  assert(shortlist.status === 0 && shortlist.output.formal.candidates.some((item) => item.id === family.id),
    "natural task request could not find its navigation entry");
  const resumed = runCli({ ...request, operation: "query-read", selectedId: family.id });
  assert(resumed.status === 0 && resumed.output.decision === "load-bounded-task-family" && resumed.output.body === profile,
    "the final CLI rejected a task entry containing a relative workspace link");
  const ref = resumed.output.body.match(/\]\(([^)]+)\)/u)?.[1];
  const indexPath = resolve(dirname(resolve(root, family.target)), ref ?? "");
  assert(relative(root, indexPath) === ["workspace", "example", "index.md"].join(sep), "entry did not resolve inside the fixture");
  assert(readFileSync(indexPath, "utf8") === index, "continuation lost accepted, withdrawn or next-step context");
  for (const child of ["accepted.md", "withdrawn.md"]) {
    assert(readFileSync(resolve(dirname(indexPath), child), "utf8").includes(child === "accepted.md" ? "保留原稿" : "不是当前版本"),
      "current index did not reach the relevant task document");
  }
  assert(resumed.output.recallUse.userReportRequired === false && resumed.output.executable === false,
    "a successful navigation read claimed actual use or execution permission");
  write(family.target, profile + "\n/workspace/private/report.md\n");
  assert(runCli({ ...request, operation: "query-read", selectedId: family.id }).output.reason === "unsafe-output",
    "a relative link allowed an independent absolute location through the final CLI");
  write(family.target, profile);
  assert(runCli({ ...request, operation: "query-read", selectedId: family.id }).status === 0,
    "repairing the one profile did not recover navigation");
  loaded = installMap([family]);

  const candidate = {
    id: "evolution.grade-column-order", title: "观察成绩列顺序偏好", summary: "观察用户是否持续沿用同一成绩列顺序。",
    topic_key: "grade-layout", subject_key: "learning-platform", triggers: ["成绩列还是按上次顺序"], aliases: ["上次的列顺序"],
    scope: ["学习平台成绩整理"], conditions: ["用户已选择先观察"], excludes: ["其他表格"], target_kind: "sop", target_subtype: "",
    candidate_relation: "new",
    status: "candidate", observation_state: "explicit", observation_basis: "explicit-user", risk_tier: "low", independent_event_count: 1,
    last_evidence_at: "", source_ref: "instance/evolution/evolution.grade-column-order.md", source_revision: 1,
  };
  write(candidate.source_ref, candidateSource(candidate, { private_refs: ["private://teacher-records/class-a"] }));
  write("instance/evolution/index.toml", candidateIndex([candidate]));
  assert(auditCandidateSourceClosure(root, { instanceContext: loaded.context }).decision === "candidate-source-closure-complete", "maintenance candidate closure rejected an exact index/source pair");
  write(candidate.source_ref, candidateSource(candidate, { summary: "与索引不一致" }));
  let candidateDriftBlocked = false;
  try { auditCandidateSourceClosure(root, { instanceContext: loaded.context }); } catch { candidateDriftBlocked = true; }
  assert(candidateDriftBlocked, "candidate maintenance closure checked only source refs and missed field drift");
  write(candidate.source_ref, candidateSource(candidate));
  loaded = installMap([main]);
  const view = loadCandidateIndex(root, { instanceContext: loaded.context, queryText: "成绩列还是按上次顺序" });
  assert(view.matchingCandidates.length === 1 && !Object.hasOwn(view.matchingCandidates[0], "source_ref"), "candidate shortlist leaked its physical source location");
  const candidateBody = inspectCandidateSource(root, view, candidate.id);
  assert(candidateBody.decision === "load-bounded-body" && candidateBody.executable === false && candidateBody.recommendedLevel === 2
    && candidateBody.body.startsWith("# 候选证据"), "selected candidate body was not exact, bounded, non-executable, and advisory");
  assert(inspectCandidateSource(root, { ...view }, candidate.id).decision === "deny-untrusted-index-view", "cloned candidate view was accepted");

  const malformedCandidate = { ...candidate, id: "evolution.malformed-neighbour", title: "",
    source_ref: "instance/evolution/evolution.malformed-neighbour.md" };
  write("instance/evolution/index.toml", candidateIndex([candidate, malformedCandidate]));
  const isolatedCandidate = loadCandidateIndex(root, { instanceContext: loaded.context, queryText: "成绩列还是按上次顺序" });
  assert(isolatedCandidate.matchingCandidates.length === 1 && isolatedCandidate.matchingCandidates[0].id === candidate.id
    && isolatedCandidate.isolatedEntryCount === 1 && isolatedCandidate.integrityState === "degraded-valid-matches-only",
  "one malformed neighbouring candidate disabled a valid candidate recall instead of being isolated");
  let strictCandidateRejected = false;
  try { auditCandidateSourceClosure(root, { instanceContext: loaded.context }); } catch { strictCandidateRejected = true; }
  assert(strictCandidateRejected, "maintenance candidate closure accepted a malformed neighbouring entry");
  write("instance/evolution/index.toml", candidateIndex([candidate]));

  write("instance/evolution/index.toml", candidateIndex([{ ...candidate, source_revision: 2 }], { revision: 2 }));
  assert(inspectCandidateSource(root, view, candidate.id).decision === "deny-untrusted-index-view", "old candidate view survived an index revision");
  write("instance/evolution/index.toml", candidateIndex([candidate]));

  const legacyCandidate = { ...candidate, id: "evolution.legacy-memory", title: "旧记忆候选", target_kind: "memory", target_subtype: "", source_ref: "instance/evolution/evolution.legacy-memory.md" };
  write(legacyCandidate.source_ref, candidateSource(legacyCandidate));
  write("instance/evolution/index.toml", candidateIndex([legacyCandidate]));
  const legacyView = loadCandidateIndex(root, { instanceContext: loaded.context, queryText: "旧记忆候选" });
  assert(legacyView.metadata.active_count === 0 && legacyView.matchingCandidates.length === 0, "legacy unclassified memory candidate entered ordinary recall");

  write(candidate.source_ref, candidateSource(candidate));
  write("instance/evolution/index.toml", candidateIndex([candidate]));
  write("instance/evolution/archive/oversized-history.md", "x".repeat(40 * 1024));
  const outside = resolve(root, "outside-candidates");
  mkdirSync(outside, { recursive: true });
  try { symlinkSync(outside, resolve(root, "instance/evolution/unreferenced-link"), "junction"); } catch (error) { if (!["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) throw error; }
  const archiveIndependent = loadCandidateIndex(root, { instanceContext: loaded.context, queryText: "成绩列还是按上次顺序" });
  assert(archiveIndependent.matchingCandidates.length === 1, "unreferenced archive volume or link blocked the bounded active index");

  write("instance/manifest.toml", manifest.replace('instance_id = "ac-fixture"', 'instance_id = "ac-changed"'));
  let staleContextFailed = false;
  try { loadCandidateIndex(root, { instanceContext: loaded.context, queryText: "成绩列还是按上次顺序" }); } catch { staleContextFailed = true; }
  assert(staleContextFailed, "candidate index accepted a stale manifest-bound context");
  write("instance/manifest.toml", manifest);

  const evidence = createHash("sha256").update(readFileSync(resolve(root, "instance/evolution/index.toml"))).digest("hex");
  assert(/^[a-f0-9]{64}$/.test(evidence), "fixture evidence digest was not produced");
  complete = true;
  console.log("Learning/recall disk fixture passed trusted-entry, UTF-8 body, confirmation migration, risk-scoped habit reuse, candidate receipt, stale-context, and no-location-leak checks.");
} finally {
  if (complete) rmSync(root, { recursive: true, force: true });
  else console.error(`Recall failure evidence kept at ${root}`);
}
