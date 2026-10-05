import fs, { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCrossSessionSignalTransactionPlan,
  cleanupExpiredPersistentCrossSessionSignalTransactions,
  closePersistentCrossSessionSignalTransaction,
  confirmCrossSessionSignalEvent,
  createCrossSessionSignalEventChallenge,
  createHostTaskObservationReceipt,
  executeCrossSessionSignalTransaction,
  inspectPersistentCrossSessionSignalTransaction,
  inspectCrossSessionSignalRecovery,
  inspectCrossSessionSignalStartup,
  getOperationalDerivedStateReport,
  repairOperationalDerivedStateOnce,
  resumePersistentCrossSessionSignalTransaction,
  rollbackPersistentCrossSessionSignalTransaction,
  validateCrossSessionSignalTransactionPlan,
} from "./cross-session-signal-transaction.mjs";
import {
  confirmPersistentLearningCaptureChallenge,
  createLearningCaptureObservationReceipt,
  executePersistentLearningCaptureTransaction,
  preparePersistentLearningCaptureChallenge,
  validateLearningCaptureTransactionPlan,
} from "./learning-capture-transaction.mjs";
import { parseArrayTableDocument, parseMarkdownFrontmatterHead } from "./asset-route-contract.mjs";
import { buildSnapshotCandidate } from "./snapshot-source-builder.mjs";
import { buildStartupCapsule } from "./startup-capsule-contract.mjs";

const assert = (condition, message) => { if (!condition) throw new Error(`Cross-session signal transaction self-test failed: ${message}`); };
const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptDir, "../..");
const cliPath = resolve(scriptDir, "cross-session-signal-cli.mjs");
const skipJunctionFixtures = process.argv.includes("--skip-junction-fixtures");
if (skipJunctionFixtures) console.log("SKIPPED: OS junction projection fixture (--skip-junction-fixtures).");
let fixture = mkdtempSync(join(tmpdir(), "ai-carry-signal-transaction-"));
const candidateRef = "instance/evolution/grade-workflow.md";
const signalRef = "instance/signals/count/signal.grade-workflow.toml";
const candidateId = "evolution.grade-workflow";
const signalId = "signal.grade-workflow";
const oldGeneratedAt = "2026-08-23T12:00:00+08:00";
const fixtureClockMs = Date.now();
const nextWakeupAt = new Date(fixtureClockMs + 7 * 24 * 60 * 60_000).toISOString();
const wrongNextWakeupAt = new Date(fixtureClockMs + 8 * 24 * 60 * 60_000).toISOString();
const q = JSON.stringify;
const messageDigest = `sha256:${"a".repeat(64)}`;
const derivedFixtureId = (prefix, basis) => `${prefix}.${createHash("sha256")
  .update(`ac-signal-fixture\u0000${candidateId}\u0000${signalId}\u0000${prefix}\u0000${basis}`).digest("hex").slice(0, 32)}`;
let operationId; let transactionAt; let eventTwo; let eventReceipt;

function mintHostObservation({ taskBasis = "task-grade-2", taskBasisStable = true, contextBasis = "grade-workflow",
  observationBasis = "message-grade-2", occurredAt = new Date(Date.now() - 60_000).toISOString(), sourceKind = "current-user",
  forCandidateId = candidateId, forSignalId = signalId, forSignalRef = signalRef } = {}) {
  return createHostTaskObservationReceipt(fixture, {
    candidateId: forCandidateId, signalId: forSignalId, signalSourceRef: forSignalRef,
    taskBasis, taskBasisStable, contextBasis, observationBasis, occurredAt, sourceKind,
  });
}

function mintChallenge(options = {}) {
  const hostTaskObservationReceipt = mintHostObservation(options);
  assert(hostTaskObservationReceipt.decision === "host-task-observation-attested", "host adapter did not mint an opaque task observation");
  const challenge = createCrossSessionSignalEventChallenge(fixture, { hostTaskObservationReceipt });
  return { hostTaskObservationReceipt, challenge };
}

function confirmationFor(challenge, { messageRef = "message.confirm-grade-2", relation = "supporting", confirmedAt = challenge.issuedAt } = {}) {
  return {
    basis: "host-current-user-message", message_ref: messageRef, message_digest: messageDigest,
    confirmed_at: confirmedAt, relation, summary: "", challenge_nonce: challenge.challengeNonce,
  };
}

function write(ref, content) {
  const target = resolve(fixture, ...ref.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}
function fieldLines(value) {
  return Object.entries(value).map(([key, item]) => `${key} = ${Array.isArray(item) ? q(item) : typeof item === "string" ? q(item) : item}`).join("\n");
}
function parseSignalFixture(source) {
  const root = {}; const matchSection = {}; const triggerSection = {}; const evidence = []; let target = root;
  for (const raw of source.replaceAll("\r\n", "\n").split("\n")) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    if (line === "[match]") { target = matchSection; continue; }
    if (line === "[trigger]") { target = triggerSection; continue; }
    if (line === "[[evidence]]") { target = {}; evidence.push(target); continue; }
    const field = /^([a-z0-9_]+)\s*=\s*(.+)$/u.exec(line);
    assert(field, `interop fixture signal contains unsupported TOML: ${line}`);
    const rawValue = field[2];
    target[field[1]] = rawValue === "true" || rawValue === "false" ? rawValue === "true"
      : /^-?(?:0|[1-9][0-9]*)$/u.test(rawValue) ? Number(rawValue) : JSON.parse(rawValue);
  }
  return { root, match: matchSection, trigger: triggerSection, evidence };
}
function serializeArrayFixture(root, table, entries) {
  return `${fieldLines(root)}${entries.map((entry) => `\n\n[[${table}]]\n${fieldLines(entry)}`).join("")}\n`;
}
function serializeSignalFixture({ root, match: matchSection, trigger: triggerSection, evidence }) {
  return `${fieldLines(root)}\n\n[match]\n${fieldLines(matchSection)}\n\n[trigger]\n${fieldLines(triggerSection)}`
    + `${evidence.map((item) => `\n\n[[evidence]]\n${fieldLines(item)}`).join("")}\n`;
}
function fixtureText(root, ref) { return readFileSync(resolve(root, ...ref.split("/")), "utf8"); }
function fixtureWrite(root, ref, content) {
  const target = resolve(root, ...ref.split("/")); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
}

function createInteropFixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-carry-capture-signal-interop-"));
  for (const file of ["assistant.toml", "AGENTS.md", "BOOTSTRAP.md"]) cpSync(resolve(sourceRoot, file), resolve(root, file));
  cpSync(resolve(sourceRoot, "core"), resolve(root, "core"), { recursive: true });
  cpSync(resolve(sourceRoot, "instance"), resolve(root, "instance"), { recursive: true });
  mkdirSync(resolve(root, "dashboard/public"), { recursive: true }); mkdirSync(resolve(root, "dashboard/dist"), { recursive: true });
  cpSync(resolve(sourceRoot, PUBLIC_SNAPSHOT_REF), resolve(root, PUBLIC_SNAPSHOT_REF));
  cpSync(resolve(sourceRoot, DIST_SNAPSHOT_REF), resolve(root, DIST_SNAPSHOT_REF));
  const instanceId = "capture-signal-interop";
  const instanceManifest = fixtureText(root, "instance/manifest.toml")
    .replace('instance_id = "template"', `instance_id = "${instanceId}"`)
    .replace('state = "template"', 'state = "instance"').replace('type = "unselected"', 'type = "general"')
    .replace('locked = false', 'locked = true').replace('label = ""', 'label = "通用个人助手"')
    .replace('scope_statement = ""', 'scope_statement = "验证捕获与信号累计互操作"')
    .replace('status = "not-instantiated"', 'status = "active"').replace('guidance_mode = "unselected"', 'guidance_mode = "balanced"')
    .replace('display_name = ""', 'display_name = "捕获信号互操作测试助手"')
    .replace('mission = ""', 'mission = "验证规范来源枚举可跨事务累计"')
    .replace('user_preferences_ref = "instance/profile/README.md"', 'user_preferences_ref = "instance/profile/user.md"');
  fixtureWrite(root, "instance/manifest.toml", instanceManifest);
  fixtureWrite(root, "instance/maps/domain-map.toml", fixtureText(root, "instance/maps/domain-map.toml")
    .replace('instance_id = "template"', `instance_id = "${instanceId}"`).replace('direction = "unselected"', 'direction = "general"')
    .replace('status = "empty-until-instantiation"', 'status = "active"'));
  for (const ref of ["instance/evolution/index.toml", "instance/signals/control.toml", "instance/maps/signal-map.toml",
    "instance/maps/time-trigger-map.toml", "instance/skills/requirements.toml", "instance/validations/index.toml"]) {
    let content = fixtureText(root, ref).replace('instance_id = "template"', `instance_id = "${instanceId}"`);
    if (ref === "instance/evolution/index.toml") content = content.replace('generated_at = ""', `generated_at = "${new Date().toISOString()}"`);
    fixtureWrite(root, ref, content);
  }
  fixtureWrite(root, "instance/profile/user.md", "# Fixture\n");
  fixtureWrite(root, "instance/startup-capsule.toml", buildStartupCapsule(root).source);
  const snapshot = buildSnapshotCandidate(root, { existingSource: fixtureText(root, PUBLIC_SNAPSHOT_REF), now: new Date() });
  fixtureWrite(root, PUBLIC_SNAPSHOT_REF, snapshot.source); fixtureWrite(root, DIST_SNAPSHOT_REF, snapshot.source);
  return root;
}

function interopProposal() {
  const formalPreview = `+++
id = "memory.capture-signal-interop"
kind = "memory"
subtype = "habit"
status = "active"
title = "在同类任务中复用已观察做法"
summary = "在明确匹配的后续任务中继续验证同一做法"
triggers = ["继续验证刚才那种做法"]
aliases = ["还是按那种办法"]
topic_key = "capture-signal-interop"
subject_key = "followup-task"
scope = ["明确同类的后续任务"]
conditions = ["用户已经允许先观察"]
excludes = ["高影响自动操作"]
lifecycle = "recurring"
expected_next_use = ""
source_refs = []
private_refs = []
supersedes = []
related_asset_ids = []
body_sections = []
minimum_level = 1
confirmation = "none"
approval_state = "explicit"
activation_basis = "explicit-user"
risk_tier = "low"
approved_by_user = true
updated_at = ""
+++
# 已登记内容

在明确同类的后续任务中继续验证同一做法。
`;
  return {
    title: "在同类任务中复用已观察做法", summary: "在明确匹配的后续任务中继续验证同一做法",
    triggers: ["继续验证刚才那种做法"], aliases: ["还是按那种办法"], scope: ["明确同类的后续任务"],
    conditions: ["用户已经允许先观察"], excludes: ["高影响自动操作"], topic_key: "capture-signal-interop",
    subject_key: "followup-task", target_kind: "memory", target_subtype: "habit",
    claim_summary: "后续同类任务可以继续验证这项已经允许观察的做法。", proposed_risk_tier: "low", minimum_level: 1,
    formal_preview: formalPreview,
  };
}

function buildInteropAccumulationProposal(root, receipt, capturePlan) {
  const candidateSource = fixtureText(root, capturePlan.candidateSourceRef);
  const candidateHead = parseMarkdownFrontmatterHead(candidateSource, "interop candidate");
  const candidate = { ...candidateHead.values, independent_event_count: candidateHead.values.independent_event_count + 1,
    distinct_context_count: candidateHead.values.distinct_context_count + 1,
    representative_event_ids: [...new Set([...candidateHead.values.representative_event_ids, receipt.eventId])].slice(0, 5),
    last_evidence_at: receipt.occurredAt, source_revision: candidateHead.values.source_revision + 1, updated_at: receipt.transactionAt };
  const candidateBytes = `+++\n${fieldLines(candidate)}\n+++\n${candidateSource.slice(candidateHead.bodyCharOffset)}`;
  const index = parseArrayTableDocument(fixtureText(root, "instance/evolution/index.toml"), "candidates", "interop index");
  const indexEntries = index.entries.map((entry) => entry.id !== capturePlan.candidateId ? entry : ({ ...entry,
    independent_event_count: candidate.independent_event_count, last_evidence_at: candidate.last_evidence_at,
    source_revision: candidate.source_revision }));
  const indexBytes = serializeArrayFixture({ ...index.root, source_revision: index.root.source_revision + 1,
    generated_at: receipt.transactionAt }, "candidates", indexEntries);
  const parsedSignal = parseSignalFixture(fixtureText(root, capturePlan.signalSourceRef));
  const canonicalSource = (value) => value === "connected-host-task" ? "connected-host-observation"
    : value === "host-collaboration-memory" ? "host-collaborative-memory" : value;
  const canonicalProvenance = (value) => value === "host-asserted-connected-host-task" ? "host-asserted-connected-host-observation"
    : value === "host-asserted-host-collaboration-memory" ? "host-asserted-host-collaborative-memory"
      : canonicalSource(value);
  const signal = { ...parsedSignal, root: { ...parsedSignal.root, provenance: canonicalProvenance(parsedSignal.root.provenance) },
    evidence: parsedSignal.evidence.map((item) => ({ ...item, event_source: canonicalSource(item.event_source),
      source_kind: canonicalSource(item.source_kind) })) };
  const nextEvidence = [...signal.evidence, { event_id: receipt.eventId, event_source: receipt.eventSource,
    task_id: receipt.taskId, context_id: receipt.contextId, occurred_at: receipt.occurredAt, source_kind: receipt.sourceKind,
    source_ref: receipt.sourceRef, independent: true, relation: receipt.relation, summary: "" }];
  const nextCount = signal.trigger.independent_event_count + 1;
  const nextStatus = nextEvidence.some((item) => ["contradicting", "superseding"].includes(item.relation)) ? "conflict"
    : nextEvidence.filter((item) => item.independent && item.relation === "supporting").length >= signal.trigger.threshold_value
      ? "pending-review" : "observing";
  const signalRoot = { ...signal.root, status: nextStatus, revision: signal.root.revision + 1,
    updated_at: receipt.transactionAt, candidate_source_revision: candidate.source_revision };
  const signalTrigger = { ...signal.trigger, independent_event_count: nextCount,
    progress_summary: `${nextCount} 个宿主区分出的任务观察`,
    next_event: nextStatus === "pending-review" ? "请用户复核是否采用、限定试用或继续观察"
      : nextStatus === "conflict" ? "读取候选与冲突证据，交由用户判断" : "等待下一次宿主可区分的任务观察" };
  const signalBytes = serializeSignalFixture({ ...signal, root: signalRoot, trigger: signalTrigger, evidence: nextEvidence });
  const controlState = parseArrayTableDocument(fixtureText(root, "instance/signals/control.toml"), "unused", "interop control").root;
  const nextRevision = controlState.source_revision + 1;
  const time = parseArrayTableDocument(fixtureText(root, "instance/maps/time-trigger-map.toml"), "triggers", "interop time map");
  const timeBytes = serializeArrayFixture({ ...time.root, source_revision: nextRevision, generated_at: receipt.transactionAt }, "triggers", time.entries);
  const signalMapState = parseArrayTableDocument(fixtureText(root, "instance/maps/signal-map.toml"), "signals", "interop signal map");
  const visible = ["near-trigger", "pending-review", "conflict", "uncertain", "stale"].includes(nextStatus);
  const projectionEntry = { id: signalRoot.id, signal_type: signalRoot.signal_type, status: signalRoot.status, reason: signalRoot.reason,
    progress: signalTrigger.progress_summary, next_event: signalTrigger.next_event, domain: signalRoot.domain, route_id: signalRoot.route_id,
    source_ref: capturePlan.signalSourceRef, source_signal_revision: signalRoot.revision, provenance: signalRoot.provenance,
    trust_state: signalRoot.trust_state, minimum_level: signalRoot.minimum_level, confirmation: signalRoot.confirmation };
  const signalEntries = signalMapState.entries.filter((entry) => entry.id !== signalRoot.id);
  if (visible) signalEntries.push(projectionEntry);
  signalEntries.sort((left, right) => left.id.localeCompare(right.id, "en"));
  const signalMapBytes = serializeArrayFixture({ ...signalMapState.root,
    state: signalEntries.length === 0 && time.entries.length === 0 ? "empty" : "current", source_revision: nextRevision,
    generated_at: receipt.transactionAt, active_count: signalEntries.length }, "signals", signalEntries);
  const pending = { ...controlState, source_revision: nextRevision, update_state: "pending",
    pending_operation_id: receipt.operationId, pending_event_id: receipt.eventId, pending_signal_id: capturePlan.signalId,
    pending_trigger_id: capturePlan.signalId, pending_source_ref: capturePlan.candidateSourceRef,
    base_revision: controlState.projection_revision, updated_at: receipt.transactionAt };
  const cleanState = { ...pending, projection_revision: nextRevision, update_state: "clean", pending_operation_id: "",
    pending_event_id: "", pending_signal_id: "", pending_trigger_id: "", pending_source_ref: "", base_revision: nextRevision };
  return { eventReceipt: receipt, candidateId: capturePlan.candidateId, candidateSourceRef: capturePlan.candidateSourceRef,
    signalId: capturePlan.signalId, signalSourceRef: capturePlan.signalSourceRef, proposed: {
      pendingControl: `${fieldLines(pending)}\n`, candidateSource: candidateBytes, candidateIndex: indexBytes,
      signalSource: signalBytes, timeProjection: timeBytes, signalProjection: signalMapBytes, cleanControl: `${fieldLines(cleanState)}\n`,
    } };
}
function control({ sourceRevision, projectionRevision, state, operation = "", event = "", signal = "", trigger = "", sourceRef = "", baseRevision, updatedAt }) {
  return `${fieldLines({
    schema_version: 1, record_type: "cross-session-signal-control", instance_id: "ac-signal-fixture",
    source_revision: sourceRevision, projection_revision: projectionRevision, update_state: state,
    pending_operation_id: operation, pending_event_id: event, pending_signal_id: signal, pending_trigger_id: trigger,
    pending_source_ref: sourceRef, base_revision: baseRevision, updated_at: updatedAt,
  })}\n`;
}
const manifest = readFileSync(resolve(sourceRoot, "instance/manifest.toml"), "utf8")
  .replace('instance_id = "template"', 'instance_id = "ac-signal-fixture"')
  .replace('state = "template"', 'state = "instance"')
  .replace('type = "unselected"', 'type = "domain"')
  .replace('locked = false', 'locked = true')
  .replace('domain_id = ""', 'domain_id = "education"')
  .replace('label = ""', 'label = "教育助手"')
  .replace('scope_statement = ""', 'scope_statement = "测试跨会话信号事务"')
  .replace('status = "not-instantiated"', 'status = "active"')
  .replace('guidance_mode = "unselected"', 'guidance_mode = "balanced"')
  .replace('display_name = ""', 'display_name = "跨会话事务测试助手"')
  .replace('mission = ""', 'mission = "验证跨进程恢复与看板一致性"')
  .replace('user_preferences_ref = "instance/profile/README.md"', 'user_preferences_ref = "instance/profile/user.md"');
const candidateBase = {
  id: candidateId, kind: "evolution-candidate", status: "candidate", title: "成绩整理流程候选", summary: "观察可复用的成绩整理流程。",
  triggers: ["按之前的方法整理成绩"], scope: ["学习平台成绩整理"], excludes: ["修改原始成绩"], lifecycle: "review",
  expected_next_use: "", topic_key: "grade-workflow", subject_key: "learning-platform", aliases: ["成绩整理流程"],
  conditions: ["用户已经允许观察"], target_kind: "sop", target_subtype: "", candidate_relation: "new",
  observation_state: "explicit", observation_basis: "explicit-user", observation_event_ref: "event.grade-1", claim_summary: "",
  proposed_risk_tier: "low", independent_event_count: 1, successful_event_count: 0, failed_event_count: 0,
  distinct_context_count: 1, representative_event_ids: ["event.grade-1"], last_evidence_at: "2026-08-20T10:00:00+08:00",
  remind_at: "", snoozed_until: "", trigger_revision: 0, source_revision: 4, source_refs: [], private_refs: [], supersedes: [],
  minimum_level: 2, approval_state: "pending", activation_basis: "candidate", risk_tier: "low", approved_by_user: false,
  updated_at: "2026-08-20T10:00:00+08:00",
};
const candidateBody = "# 候选证据\n\n正文保持逐字不变；累计事务只更新极小 frontmatter 与独立信号卡。\n";
function candidateSource(values = candidateBase, extra = "") { return `+++\n${fieldLines(values)}${extra}\n+++\n${candidateBody}`; }
function candidateEntry(values = candidateBase) {
  return {
    id: values.id, title: values.title, summary: values.summary, topic_key: values.topic_key, subject_key: values.subject_key,
    triggers: values.triggers, aliases: values.aliases, scope: values.scope, conditions: values.conditions, excludes: values.excludes,
    target_kind: values.target_kind, target_subtype: values.target_subtype, candidate_relation: values.candidate_relation,
    status: values.status, observation_state: values.observation_state, observation_basis: values.observation_basis,
    risk_tier: values.proposed_risk_tier, independent_event_count: values.independent_event_count,
    last_evidence_at: values.last_evidence_at, source_ref: candidateRef, source_revision: values.source_revision,
  };
}
function candidateIndex({ rootRevision = 9, generatedAt = oldGeneratedAt, entries = [candidateEntry()] } = {}) {
  const active = entries.filter((entry) => entry.status === "candidate" && entry.observation_state === "explicit"
    && ["explicit-user", "existing-approved-migration"].includes(entry.observation_basis)
    && ["new", "refine", "condition-variant", "related"].includes(entry.candidate_relation)).length;
  const state = entries.length === 0 ? "empty" : "current";
  return `${fieldLines({
    schema_version: 1, index_id: "evolution-candidates", instance_id: "ac-signal-fixture", state,
    source_revision: rootRevision, generated_at: generatedAt, budget_bytes: 32768, overflow: false,
    candidate_count: entries.length, indexed_count: entries.length, active_count: active,
  })}${entries.map((entry) => `\n\n[[candidates]]\n${fieldLines(entry)}`).join("")}\n`;
}
const eventOne = {
  event_id: "event.grade-1", event_source: "current-user",
  task_id: derivedFixtureId("task.observation", "task-grade-1"),
  context_id: derivedFixtureId("context.observation", "grade-workflow"), occurred_at: "2026-08-20T10:00:00+08:00",
  source_kind: "current-user", source_ref: "message.grade-1", independent: true, relation: "supporting", summary: "",
};
const signalRootBase = {
  schema_version: 1, record_type: "cross-session-signal", id: signalId, signal_type: "asset-learning",
  evaluation_family: "count", status: "observing", title: "已获准观察的学习候选", reason: "按稳定候选引用累计去重事件",
  domain: "evolution-model", route_id: "evolution-review", revision: 2, created_at: "2026-08-20T10:00:00+08:00",
  updated_at: "2026-08-20T10:00:00+08:00", last_verified_at: "", asset_refs: [candidateId], candidate_source_revision: 4,
  related_signal_ids: [], minimum_level: 2, confirmation: "risk-dependent", provenance: "user-explicit", trust_state: "candidate",
};
const match = { asset_kind: "", subject: "", claim: "", scope: [], conditions: [], aliases: [] };
const triggerBase = {
  mode: "count", independent_event_count: 1, threshold_value: 2, progress_summary: "1 个宿主区分出的任务观察",
  next_event: "等待下一次宿主可区分的任务观察", next_check_at: "",
};
function signalSource({ root = signalRootBase, trigger = triggerBase, evidence = [eventOne] } = {}) {
  return `${fieldLines(root)}\n\n[match]\n${fieldLines(match)}\n\n[trigger]\n${fieldLines(trigger)}${evidence.map((item) => `\n\n[[evidence]]\n${fieldLines(item)}`).join("")}\n`;
}
const governanceTrigger = {
  id: "governance.memory-review", kind: "governance", status: "scheduled", title: "记忆治理检查",
  next_check_at: nextWakeupAt, effective_check_at: nextWakeupAt, domain: "assistant-maintenance",
  route_id: "governance-memory-research", source_ref: "instance/governance/memory-governance-card.md",
  source_trigger_revision: 1, minimum_level: 3, confirmation: "user-starts-review",
};
function timeMap({ revision = 7, generatedAt = oldGeneratedAt, next = nextWakeupAt, entries = [governanceTrigger] } = {}) {
  return `${fieldLines({
    schema_version: 1, map_id: "time-triggers", instance_id: "ac-signal-fixture", state: entries.length ? "current" : "empty",
    source_revision: revision, generated_at: generatedAt, scheduled_count: entries.length, next_wakeup_at: next,
  })}${entries.map((entry) => `\n\n[[triggers]]\n${fieldLines(entry)}`).join("")}\n`;
}
function signalProjectionEntry({ root, trigger }) {
  return {
    id: root.id, signal_type: root.signal_type, status: root.status, reason: root.reason, progress: trigger.progress_summary,
    next_event: trigger.next_event, domain: root.domain, route_id: root.route_id, source_ref: signalRef,
    source_signal_revision: root.revision, provenance: root.provenance, trust_state: root.trust_state,
    minimum_level: root.minimum_level, confirmation: root.confirmation,
  };
}
function signalMap({ revision = 7, generatedAt = oldGeneratedAt, entries = [], scheduledCount = 1, next = nextWakeupAt } = {}) {
  const state = entries.length === 0 && scheduledCount === 0 ? "empty" : "current";
  return `${fieldLines({
    schema_version: 1, map_id: "cross-session-signals", instance_id: "ac-signal-fixture", state,
    source_revision: revision, generated_at: generatedAt, budget_bytes: 1536, overflow: false,
    active_count: entries.length, scheduled_count: scheduledCount, next_wakeup_at: next,
    next_wakeup_ref: "instance/maps/time-trigger-map.toml",
  })}${entries.map((entry) => `\n\n[[signals]]\n${fieldLines(entry)}`).join("")}\n`;
}

const currentControl = control({ sourceRevision: 7, projectionRevision: 7, state: "clean", baseRevision: 7, updatedAt: oldGeneratedAt });
const currentCandidateSource = candidateSource();
const currentCandidateIndex = candidateIndex();
const currentSignalSource = signalSource();
const currentTimeMap = timeMap();
const currentSignalMap = signalMap();
let proposedCandidateSource; let proposedCandidateIndex; let proposedSignalSource; let proposedTimeMap;
let proposedSignalMap; let pendingControl; let cleanControl; let request;
function requestForReceipt(receipt, { independent, distinctContextDelta = independent ? 1 : 0, successfulEventCount = 0, failedEventCount = 0,
  replaceEvent = null } = {}) {
  const event = {
    event_id: receipt.eventId, event_source: receipt.eventSource, task_id: receipt.taskId, context_id: receipt.contextId,
    occurred_at: receipt.occurredAt, source_kind: receipt.sourceKind, source_ref: receipt.sourceRef,
    independent, relation: receipt.relation, summary: "",
  };
  if (replaceEvent) {
    event.context_id = replaceEvent.context_id;
    event.independent = replaceEvent.independent;
  }
  const independentDelta = replaceEvent ? 0 : independent ? 1 : 0;
  const representativeEventIds = replaceEvent
    ? ["event.grade-1"].map((id) => id === replaceEvent.event_id ? event.event_id : id)
    : ["event.grade-1", event.event_id];
  const proposedCandidateValues = {
    ...candidateBase, independent_event_count: 1 + independentDelta,
    successful_event_count: successfulEventCount, failed_event_count: failedEventCount, distinct_context_count: 1 + distinctContextDelta,
    representative_event_ids: [...new Set(representativeEventIds)], last_evidence_at: event.occurred_at,
    source_revision: 5, updated_at: receipt.transactionAt,
  };
  const candidateSourceBytes = candidateSource(proposedCandidateValues);
  const candidateIndexBytes = candidateIndex({ rootRevision: 10, generatedAt: receipt.transactionAt, entries: [candidateEntry(proposedCandidateValues)] });
  const proposedEvidence = replaceEvent ? [event] : [eventOne, event];
  const expectedStatus = proposedEvidence.some((item) => ["contradicting", "superseding"].includes(item.relation)) ? "conflict"
    : proposedEvidence.filter((item) => item.independent && item.relation === "supporting").length >= triggerBase.threshold_value
      ? "pending-review" : "observing";
  const signalRoot = {
    ...signalRootBase, status: expectedStatus, revision: 3,
    updated_at: receipt.transactionAt, candidate_source_revision: 5,
  };
  const trigger = {
    ...triggerBase, independent_event_count: 1 + independentDelta,
    progress_summary: `${1 + independentDelta} 个宿主区分出的任务观察`,
    next_event: expectedStatus === "pending-review" ? "请用户复核是否采用、限定试用或继续观察"
      : expectedStatus === "conflict" ? "读取候选与冲突证据，交由用户判断" : "等待下一次宿主可区分的任务观察",
  };
  const signalSourceBytes = signalSource({ root: signalRoot, trigger, evidence: proposedEvidence });
  const timeProjectionBytes = timeMap({ revision: 8, generatedAt: receipt.transactionAt });
  const entries = signalRoot.status === "observing" ? [] : [signalProjectionEntry({ root: signalRoot, trigger })];
  const signalProjectionBytes = signalMap({ revision: 8, generatedAt: receipt.transactionAt, entries });
  const pendingControlBytes = control({
    sourceRevision: 8, projectionRevision: 7, state: "pending", operation: receipt.operationId, event: event.event_id,
    signal: signalId, trigger: signalId, sourceRef: candidateRef, baseRevision: 7, updatedAt: receipt.transactionAt,
  });
  const cleanControlBytes = control({ sourceRevision: 8, projectionRevision: 8, state: "clean", baseRevision: 8, updatedAt: receipt.transactionAt });
  return {
    event,
    artifacts: {
      proposedCandidateSource: candidateSourceBytes, proposedCandidateIndex: candidateIndexBytes,
      proposedSignalSource: signalSourceBytes, proposedTimeMap: timeProjectionBytes,
      proposedSignalMap: signalProjectionBytes, pendingControl: pendingControlBytes, cleanControl: cleanControlBytes,
    },
    request: {
      eventReceipt: receipt, candidateId, candidateSourceRef: candidateRef, signalId, signalSourceRef: signalRef,
      proposed: {
        pendingControl: pendingControlBytes, candidateSource: candidateSourceBytes, candidateIndex: candidateIndexBytes,
        signalSource: signalSourceBytes, timeProjection: timeProjectionBytes, signalProjection: signalProjectionBytes,
        cleanControl: cleanControlBytes,
      },
    },
  };
}

function initializeFullFixture() {
  for (const file of ["assistant.toml", "AGENTS.md", "BOOTSTRAP.md"]) cpSync(resolve(sourceRoot, file), resolve(fixture, file));
  cpSync(resolve(sourceRoot, "core"), resolve(fixture, "core"), { recursive: true });
  cpSync(resolve(sourceRoot, "instance"), resolve(fixture, "instance"), { recursive: true });
  mkdirSync(resolve(fixture, "dashboard/public"), { recursive: true });
  mkdirSync(resolve(fixture, "dashboard/dist"), { recursive: true });
  cpSync(resolve(sourceRoot, PUBLIC_SNAPSHOT_REF), resolve(fixture, PUBLIC_SNAPSHOT_REF));
  cpSync(resolve(sourceRoot, DIST_SNAPSHOT_REF), resolve(fixture, DIST_SNAPSHOT_REF));
  write("instance/manifest.toml", manifest);
  const domainMap = readFileSync(resolve(sourceRoot, "instance/maps/domain-map.toml"), "utf8")
    .replace('instance_id = "template"', 'instance_id = "ac-signal-fixture"')
    .replace('direction = "unselected"', 'direction = "education"')
    .replace('status = "empty-until-instantiation"', 'status = "active"');
  write("instance/maps/domain-map.toml", domainMap);
  for (const ref of ["instance/skills/requirements.toml", "instance/validations/index.toml"]) {
    write(ref, readFileSync(resolve(fixture, ...ref.split("/")), "utf8").replace('instance_id = "template"', 'instance_id = "ac-signal-fixture"'));
  }
  write("instance/profile/user.md", "# Fixture\n");
}

const PUBLIC_SNAPSHOT_REF = "dashboard/public/snapshot.js";
const DIST_SNAPSHOT_REF = "dashboard/dist/snapshot.js";

function writeInitial() {
  write("instance/manifest.toml", manifest);
  write("instance/signals/control.toml", currentControl);
  write(candidateRef, currentCandidateSource);
  write("instance/evolution/index.toml", currentCandidateIndex);
  write(signalRef, currentSignalSource);
  write("instance/maps/time-trigger-map.toml", currentTimeMap);
  write("instance/maps/signal-map.toml", currentSignalMap);
  write("instance/startup-capsule.toml", buildStartupCapsule(fixture).source);
  const existing = readFileSync(resolve(fixture, PUBLIC_SNAPSHOT_REF), "utf8");
  const snapshot = buildSnapshotCandidate(fixture, { existingSource: existing, now: new Date(oldGeneratedAt) });
  write(PUBLIC_SNAPSHOT_REF, snapshot.source);
  write(DIST_SNAPSHOT_REF, snapshot.source);
}
function applyProposalStep(step) {
  const bytesByPhase = {
    "control-pending": pendingControl, "candidate-source": proposedCandidateSource, "candidate-index": proposedCandidateIndex,
    "learning-signal-source": proposedSignalSource, "time-projection": proposedTimeMap,
    "startup-signal-projection": proposedSignalMap, "control-clean": cleanControl,
  };
  write(step.target, bytesByPhase[step.phase]);
}

function runCli(command, operation = "") {
  const args = [cliPath, command, fixture, ...(operation ? [operation] : [])];
  const result = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
  assert(Buffer.byteLength(result.stdout, "utf8") <= 4096, `${command} CLI stdout exceeded its byte ceiling`);
  assert(!result.stdout.includes(candidateBody.trim()) && !result.stdout.includes("contentBase64")
    && !result.stdout.includes(Buffer.from(candidateBody, "utf8").toString("base64"))
    && !result.stdout.includes(fixture), `${command} CLI stdout exposed content, base64, or an absolute location`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error(`Cross-session signal transaction self-test failed: ${command} CLI did not return bounded JSON: ${result.stderr}`); }
  return { ...result, parsed };
}

function runCaptureSignalInteropFixture() {
  const root = createInteropFixture();
  let nonOwnedProjection = ""; let forgedProjectionLink = ""; let forgedProjectionTarget = "";
  try {
    const proposal = interopProposal();
    const observedAt = new Date(Date.now() - 120_000).toISOString();
    const assertion = { basis: "same-process-host-task-observation", source_kind: "connected-host-observation",
      task_ref_digest: `sha256:${createHash("sha256").update("capture task one").digest("hex")}`,
      context_ref_digest: `sha256:${createHash("sha256").update("capture context one").digest("hex")}`,
      occurred_at: observedAt, result_state: "closed-result-checked" };
    assert(createLearningCaptureObservationReceipt(root, { ...assertion, source_kind: "connected-host-task" }).decision
      === "learning-capture-host-observation-denied", "learning capture still accepted the retired connected-host-task producer value");
    assert(createLearningCaptureObservationReceipt(root, { ...assertion, source_kind: "host-collaboration-memory" }).decision
      === "learning-capture-host-observation-denied", "learning capture still accepted the misspelled host memory producer value");
    const memoryReceipt = createLearningCaptureObservationReceipt(root,
      { ...assertion, source_kind: "host-collaborative-memory", result_state: "closed-unverified" });
    assert(memoryReceipt.decision === "learning-capture-host-observation-bound"
      && memoryReceipt.sourceKind === "host-collaborative-memory", "canonical host collaborative memory was not retained exactly");

    const prepared = preparePersistentLearningCaptureChallenge(root, proposal, assertion);
    assert(prepared.decision === "persistent-learning-capture-choice-required", `canonical capture prepare failed: ${prepared.reason ?? "unknown"}`);
    const choiceAt = new Date().toISOString();
    const choice = { basis: "host-current-user-message", message_ref: "message.capture-signal-observe",
      message_digest: `sha256:${createHash("sha256").update("observe capture signal interoperability").digest("hex")}`,
      user_message_at: choiceAt, confirmed_at: choiceAt, choice: "observe", remind_at: "",
      instance_id: prepared.instanceId, proposal_digest: prepared.proposalDigest, challenge_nonce: prepared.challengeNonce };
    const planned = confirmPersistentLearningCaptureChallenge(root, { challengeId: prepared.persistentChallengeId,
      proposal, observationAssertion: assertion, receipt: choice });
    assert(planned.decision === "persistent-learning-capture-plan-ready" && validateLearningCaptureTransactionPlan(planned.plan),
      `canonical capture plan failed: ${planned.reason ?? "unknown"}`);
    assert(executePersistentLearningCaptureTransaction(root, { challengeId: prepared.persistentChallengeId,
      challengeNonce: prepared.challengeNonce }).decision === "persistent-learning-capture-execution-complete",
    "canonical capture product did not commit through its real executor");
    const capturedSignal = fixtureText(root, planned.plan.signalSourceRef);
    assert(capturedSignal.includes('event_source = "connected-host-observation"')
      && capturedSignal.includes('source_kind = "connected-host-observation"')
      && capturedSignal.includes('provenance = "host-asserted-connected-host-observation"')
      && !capturedSignal.includes("connected-host-task"), "new capture signal did not use only canonical source values");

    const signalRequestBase = { candidateId: planned.plan.candidateId, signalId: planned.plan.signalId,
      signalSourceRef: planned.plan.signalSourceRef, taskBasisStable: true };
    const oldSignalReceipt = createHostTaskObservationReceipt(root, { ...signalRequestBase, taskBasis: "legacy-source-rejected",
      contextBasis: "legacy-source-rejected", observationBasis: "legacy-source-rejected",
      occurredAt: new Date(Date.now() - 60_000).toISOString(), sourceKind: "connected-host-task" });
    const oldMemoryReceipt = createHostTaskObservationReceipt(root, { ...signalRequestBase, taskBasis: "legacy-memory-rejected",
      contextBasis: "legacy-memory-rejected", observationBasis: "legacy-memory-rejected",
      occurredAt: new Date(Date.now() - 60_000).toISOString(), sourceKind: "host-collaboration-memory" });
    assert(oldSignalReceipt.decision === "host-task-observation-denied" && oldMemoryReceipt.decision === "host-task-observation-denied",
      "signal event producer still accepted a retired source alias");

    const mintReceipt = (suffix, taskBasis) => {
      const hostReceipt = createHostTaskObservationReceipt(root, { ...signalRequestBase, taskBasis,
        contextBasis: `interop-context-${suffix}`, observationBasis: `interop-observation-${suffix}`,
        occurredAt: new Date(Date.now() - 30_000).toISOString(), sourceKind: "connected-host-observation" });
      assert(hostReceipt.decision === "host-task-observation-attested" && hostReceipt.independent === true,
        `canonical follow-up ${suffix} was not attested as an independent host observation`);
      const challenge = createCrossSessionSignalEventChallenge(root, { hostTaskObservationReceipt: hostReceipt });
      assert(challenge.decision === "signal-event-receipt-required", `canonical follow-up ${suffix} did not reach confirmation`);
      const receipt = confirmCrossSessionSignalEvent(challenge, { basis: "host-current-user-message",
        message_ref: `message.capture-signal-${suffix}`,
        message_digest: `sha256:${createHash("sha256").update(`capture signal ${suffix}`).digest("hex")}`,
        confirmed_at: challenge.issuedAt, relation: "supporting", summary: "", challenge_nonce: challenge.challengeNonce });
      assert(receipt.decision === "trusted-signal-event", `canonical follow-up ${suffix} did not mint a trusted event`);
      return receipt;
    };

    const followup = mintReceipt("followup", "capture-followup-task");
    const accumulation = buildInteropAccumulationProposal(root, followup, planned.plan);
    const signalPlan = buildCrossSessionSignalTransactionPlan(root, accumulation);
    assert(signalPlan.decision === "transaction-preview" && validateCrossSessionSignalTransactionPlan(signalPlan),
      `capture output could not be read by signal runtime: ${signalPlan.reason ?? "unknown"}`);
    assert(executeCrossSessionSignalTransaction(root, signalPlan).decision === "persistent-cross-session-signal-resume-complete",
      "capture output did not accumulate through the persistent signal executor");
    assert(closePersistentCrossSessionSignalTransaction(root, { operationId: signalPlan.operationId }).decision
      === "persistent-cross-session-signal-closed", "canonical interop transaction did not close at final");
    const accumulatedSignal = fixtureText(root, planned.plan.signalSourceRef);
    const accumulatedCandidate = fixtureText(root, planned.plan.candidateSourceRef);
    assert((accumulatedSignal.match(/\[\[evidence\]\]/gu) ?? []).length === 2
      && accumulatedSignal.includes("independent_event_count = 2")
      && accumulatedCandidate.includes("independent_event_count = 2")
      && !accumulatedSignal.includes("connected-host-task"), "capture-to-signal accumulation did not advance exactly once canonically");

    const beforeRetry = createHash("sha256").update(accumulatedSignal + accumulatedCandidate).digest("hex");
    const retry = mintReceipt("retry", "capture-followup-task");
    const retryResult = buildCrossSessionSignalTransactionPlan(root, { eventReceipt: retry,
      candidateId: planned.plan.candidateId, candidateSourceRef: planned.plan.candidateSourceRef,
      signalId: planned.plan.signalId, signalSourceRef: planned.plan.signalSourceRef, proposed: {} });
    assert(retryResult.decision === "transaction-noop" && retryResult.reason === "same-task-observation-already-represented",
      "same captured follow-up task duplicated durable evidence");
    assert(createHash("sha256").update(fixtureText(root, planned.plan.signalSourceRef)
      + fixtureText(root, planned.plan.candidateSourceRef)).digest("hex") === beforeRetry,
    "same-task interop retry changed candidate or signal bytes");

    // A 1.3 signal is accepted only as a read-time migration input. The next
    // real write canonicalizes the complete structured signal and projection.
    fixtureWrite(root, planned.plan.signalSourceRef, accumulatedSignal.replaceAll("connected-host-observation", "connected-host-task"));
    const migrationEvent = mintReceipt("legacy-migration", "capture-followup-task-three");
    const migrationRequest = buildInteropAccumulationProposal(root, migrationEvent, planned.plan);
    const migrationPlan = buildCrossSessionSignalTransactionPlan(root, migrationRequest);
    assert(migrationPlan.decision === "transaction-preview", `legacy 1.3 signal was not migration-readable: ${migrationPlan.reason ?? "unknown"}`);
    assert(executeCrossSessionSignalTransaction(root, migrationPlan).decision === "persistent-cross-session-signal-resume-complete",
      "legacy source alias did not migrate through a canonical signal write");
    const migratedSignal = fixtureText(root, planned.plan.signalSourceRef);
    assert((migratedSignal.match(/\[\[evidence\]\]/gu) ?? []).length === 3
      && migratedSignal.includes("independent_event_count = 3") && migratedSignal.includes('status = "pending-review"')
      && migratedSignal.includes("connected-host-observation") && !migratedSignal.includes("connected-host-task")
      && !migratedSignal.includes("host-collaboration-memory"),
    "legacy migration did not emit one canonical three-event signal without duplication");
    assert(closePersistentCrossSessionSignalTransaction(root, { operationId: migrationPlan.operationId }).decision
      === "persistent-cross-session-signal-closed", "legacy migration transaction did not close at final");

    // A killed snapshot build can leave hardlinks in a repository sibling.
    // Explicit transaction maintenance removes only a dead, marker-bound root
    // for this exact repository and never follows a forged junction.
    const repositoryReal = realpathSync(root); const projectionParent = dirname(repositoryReal);
    const repositoryHex = createHash("sha256").update(repositoryReal.normalize("NFC")).digest("hex");
    const projectionPrefix = `.ai-carry-cross-session-snapshot-${repositoryHex.slice(0, 16)}-`;
    const staleProjection = resolve(projectionParent, `${projectionPrefix}stale-fixture`);
    mkdirSync(staleProjection); linkSync(resolve(repositoryReal, "instance/manifest.toml"), resolve(staleProjection, "manifest-hardlink.toml"));
    writeFileSync(resolve(staleProjection, ".ai-carry-cross-session-owner.json"), `${JSON.stringify({
      schema_version: 1, record_type: "cross-session-snapshot-projection",
      repository_binding: `sha256:${repositoryHex}`, directory_name: staleProjection.slice(projectionParent.length + 1),
      pid: 2147483647, created_at: new Date(Date.now() - 60_000).toISOString(),
    })}\n`, "utf8");
    const unique = repositoryHex.slice(16, 28);
    nonOwnedProjection = resolve(projectionParent, `.ai-carry-cross-session-snapshot-foreign-${unique}`);
    mkdirSync(nonOwnedProjection); writeFileSync(resolve(nonOwnedProjection, "sentinel.txt"), "preserve", "utf8");
    if (!skipJunctionFixtures) {
      forgedProjectionTarget = mkdtempSync(join(tmpdir(), `ai-carry-forged-projection-${unique}-`));
      writeFileSync(resolve(forgedProjectionTarget, "sentinel.txt"), "do-not-follow", "utf8");
      forgedProjectionLink = resolve(projectionParent, `${projectionPrefix}linked-fixture`);
      symlinkSync(forgedProjectionTarget, forgedProjectionLink, "junction");
    }
    const projectionCleanup = cleanupExpiredPersistentCrossSessionSignalTransactions(root);
    assert(projectionCleanup.decision === "persistent-cross-session-signal-cleanup-complete" && !existsSync(staleProjection),
      "dead marker-bound sibling hardlink projection was not cleaned by explicit maintenance");
    assert(existsSync(resolve(nonOwnedProjection, "sentinel.txt")) && (skipJunctionFixtures
      || (existsSync(forgedProjectionLink) && existsSync(resolve(forgedProjectionTarget, "sentinel.txt")))),
    "projection cleanup deleted a non-owned sibling or followed a forged link");
  } finally {
    if (forgedProjectionLink && existsSync(forgedProjectionLink)) unlinkSync(forgedProjectionLink);
    if (nonOwnedProjection && existsSync(nonOwnedProjection)) {
      const sentinel = resolve(nonOwnedProjection, "sentinel.txt"); if (existsSync(sentinel)) unlinkSync(sentinel); rmdirSync(nonOwnedProjection);
    }
    if (forgedProjectionTarget && existsSync(forgedProjectionTarget)) {
      const sentinel = resolve(forgedProjectionTarget, "sentinel.txt"); if (existsSync(sentinel)) unlinkSync(sentinel); rmdirSync(forgedProjectionTarget);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function runOperationalDerivedRepairFixture() {
  const roots = [];
  const refs = ["instance/evolution/index.toml", "instance/maps/time-trigger-map.toml", "instance/maps/signal-map.toml"];
  const digestRows = (root) => refs.map((ref) => createHash("sha256").update(fixtureText(root, ref)).digest("hex"));
  const breakRepairableMetadata = (root) => {
    fixtureWrite(root, refs[0], fixtureText(root, refs[0]).replace("candidate_count = 0", "candidate_count = 7").replaceAll("\n", "\r\n"));
    fixtureWrite(root, refs[1], fixtureText(root, refs[1]).replace("scheduled_count = 0", "scheduled_count = 5").replaceAll("\n", "\r\n"));
    fixtureWrite(root, refs[2], fixtureText(root, refs[2]).replace("active_count = 0", "active_count = 3").replaceAll("\n", "\r\n"));
  };
  try {
    const root = createInteropFixture(); roots.push(root);
    const candidateGeneratedAt = parseArrayTableDocument(fixtureText(root, refs[0]), "candidates", "repair fixture candidate").root.generated_at;
    breakRepairableMetadata(root);
    const repaired = repairOperationalDerivedStateOnce(root);
    assert(repaired.decision === "operational-derived-state-repaired" && repaired.attemptCount === 1
      && repaired.repairedTargetCount === 3 && repaired.userReport?.data_state.includes("用户数据")
      && repaired.userReport?.still_usable.includes("原来的学习动作已继续"),
    "repairable candidate/signal/time metadata drift did not repair once and report the resumed action");
    const repairedCandidate = parseArrayTableDocument(fixtureText(root, refs[0]), "candidates", "repaired candidate").root;
    const repairedTime = parseArrayTableDocument(fixtureText(root, refs[1]), "triggers", "repaired time").root;
    const repairedSignal = parseArrayTableDocument(fixtureText(root, refs[2]), "signals", "repaired signal").root;
    assert(repairedCandidate.candidate_count === 0 && repairedCandidate.indexed_count === 0 && repairedCandidate.active_count === 0
      && repairedCandidate.generated_at === candidateGeneratedAt && repairedTime.scheduled_count === 0
      && repairedTime.next_wakeup_at === "" && repairedSignal.active_count === 0 && repairedSignal.scheduled_count === 0
      && !fixtureText(root, refs[0]).includes("\r") && !fixtureText(root, refs[1]).includes("\r")
      && !fixtureText(root, refs[2]).includes("\r"),
    "derived repair changed time/revision semantics or failed to canonicalize only deterministic metadata and LF bytes");
    const after = digestRows(root);
    const repeated = repairOperationalDerivedStateOnce(root);
    assert(repeated.decision === "operational-derived-state-current" && repeated.attempted === false
      && JSON.stringify(digestRows(root)) === JSON.stringify(after),
    "a second operational repair refreshed healthy derived bytes");

    const faultRoot = createInteropFixture(); roots.push(faultRoot); breakRepairableMetadata(faultRoot);
    const beforeFault = digestRows(faultRoot);
    const failed = repairOperationalDerivedStateOnce(faultRoot, { testFaultAfterInstall: 1 });
    assert(failed.decision === "operational-derived-state-related-capability-paused" && failed.attemptCount === 1
      && failed.ordinaryTasksContinue === true && JSON.stringify(digestRows(faultRoot)) === JSON.stringify(beforeFault),
    "an interrupted derived repair did not restore the exact three-file preimage and bound the fault to related capabilities");
    assert(repairOperationalDerivedStateOnce(faultRoot).decision === "operational-derived-state-repaired",
      "a clean retry could not repair the preserved derived state after one rolled-back failure");

    const unknownRoot = createInteropFixture(); roots.push(unknownRoot);
    const unknownCandidate = `${fixtureText(unknownRoot, refs[0]).trimEnd()}\nfuture_field = "preserve-me"\n`;
    fixtureWrite(unknownRoot, refs[0], unknownCandidate);
    const beforeUnknown = digestRows(unknownRoot);
    const paused = repairOperationalDerivedStateOnce(unknownRoot);
    assert(paused.decision === "operational-derived-state-related-capability-paused" && paused.attemptCount === 1
      && paused.ordinaryTasksContinue === true && paused.pausedCapabilities.includes("learning-capture")
      && paused.userReport?.impact.includes("暂时暂停") && paused.userReport?.data_state.includes("保持原样")
      && paused.userReport?.recoverability && paused.userReport?.still_usable.includes("普通对话")
      && paused.userReport?.next_step && JSON.stringify(digestRows(unknownRoot)) === JSON.stringify(beforeUnknown),
    "an unknown candidate field was dropped, globally fatal, silently retried, or missing the five-part user report");
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

try {
  runOperationalDerivedRepairFixture();
  initializeFullFixture();
  writeInitial();
  const rawIdsRejected = createCrossSessionSignalEventChallenge(fixture, {
    candidateId, signalId, signalSourceRef: signalRef, contextId: "context.grade-2",
  });
  assert(rawIdsRejected.decision === "signal-event-challenge-denied", "raw caller task/context IDs minted a signal challenge");
  const initial = mintChallenge();
  const { hostTaskObservationReceipt, challenge } = initial;
  assert(challenge.decision === "signal-event-receipt-required", "runtime did not mint an opaque event challenge");
  assert(createCrossSessionSignalEventChallenge(fixture, { hostTaskObservationReceipt: { ...hostTaskObservationReceipt } }).decision === "signal-event-challenge-denied",
    "a cloned host task observation minted a trusted challenge");
  const receiptPayload = confirmationFor(challenge);
  assert(confirmCrossSessionSignalEvent({ ...challenge }, receiptPayload).decision === "signal-event-receipt-denied",
    "a cloned challenge minted a trusted event receipt");
  eventReceipt = confirmCrossSessionSignalEvent(challenge, receiptPayload);
  assert(eventReceipt.decision === "trusted-signal-event", "a current host-bound user event did not mint an opaque receipt");
  assert(eventReceipt.occurredAt === hostTaskObservationReceipt.occurredAt && eventReceipt.confirmationTrust.includes("observation-not-result-validation"),
    "a real task event that occurred before the learning stop point was rewritten or mislabeled as result validation");
  ({ operationId, transactionAt } = eventReceipt);
  const primary = requestForReceipt(eventReceipt, { independent: true, distinctContextDelta: 0 });
  eventTwo = primary.event; request = primary.request;
  ({ proposedCandidateSource, proposedCandidateIndex, proposedSignalSource, proposedTimeMap,
    proposedSignalMap, pendingControl, cleanControl } = primary.artifacts);

  writeInitial();

  // Ordinary startup is deliberately blind to candidate/index/signal bodies and to the non-due time map.
  write(candidateRef, "THIS FILE WOULD FAIL EVERY CANDIDATE PARSER IF STARTUP LOADED IT\n");
  const startupReads = [];
  const startup = inspectCrossSessionSignalStartup(fixture, { now: transactionAt, onRead: (ref) => startupReads.push(ref) });
  assert(startup.decision === "startup-ordinary-route" && startup.bodyReads === 0, "ordinary startup did not stay on the minimal route");
  assert(JSON.stringify(startupReads) === JSON.stringify(["instance/manifest.toml", "instance/signals/control.toml", "instance/maps/signal-map.toml"]),
    "ordinary startup loaded the time index, candidate index, candidate source, or learning signal source");
  const due = inspectCrossSessionSignalStartup(fixture, { now: nextWakeupAt });
  assert(due.decision === "startup-time-index-due" && !due.readSet.includes("instance/maps/time-trigger-map.toml"),
    "due detection preloaded the non-startup time projection");
  write(candidateRef, currentCandidateSource);

  const shortRoute = (id, ref) => ({
    id, signal_type: "state", status: "conflict", reason: "需定向处理", progress: "", next_event: "读取一条来源",
    domain: "evolution-model", route_id: "evolution-review", source_ref: ref, source_signal_revision: 1,
    provenance: "user-explicit", trust_state: "candidate", minimum_level: 2, confirmation: "risk-dependent",
  });
  const overflowEntries = [
    shortRoute("signal.b", "instance/signals/state/signal.b.toml"),
    shortRoute("signal.a", "instance/signals/state/signal.a.toml"),
  ];
  const boundedOverflowMap = `${fieldLines({
    schema_version: 1, map_id: "cross-session-signals", instance_id: "ac-signal-fixture", state: "overflow",
    source_revision: 7, generated_at: oldGeneratedAt, budget_bytes: 1536, overflow: true, active_count: 2,
    scheduled_count: 1, next_wakeup_at: nextWakeupAt, next_wakeup_ref: "instance/maps/time-trigger-map.toml",
  })}${overflowEntries.map((entry) => `\n\n[[signals]]\n${fieldLines(entry)}`).join("")}\n`;
  assert(Buffer.byteLength(boundedOverflowMap, "utf8") <= 1536, "overflow test capsule itself exceeded the hard budget");
  write("instance/maps/signal-map.toml", boundedOverflowMap);
  const fairOverflow = inspectCrossSessionSignalStartup(fixture, { now: transactionAt });
  assert(fairOverflow.decision === "startup-signal-route-ready" && fairOverflow.overflow === true
    && fairOverflow.signalId === "signal.b" && fairOverflow.selectionPolicy === "severity-first-revision-rotated-equal-priority",
  "legal bounded overflow or deterministic equal-priority rotation failed");
  const dueWithSignal = inspectCrossSessionSignalStartup(fixture, { now: nextWakeupAt });
  assert(dueWithSignal.decision === "startup-time-index-due" && dueWithSignal.deferredSignalId === "signal.b",
    "a persistent visible signal starved an already-due time trigger");
  const overflowAccumulation = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(overflowAccumulation.decision === "transaction-recovery-required"
    && overflowAccumulation.reason === "startup-projection-rebuild-required-before-accumulation",
  "ordinary evidence accumulation silently cleared a legal overflow/rebuild state");
  write("instance/maps/signal-map.toml", currentSignalMap);

  const nakedEvent = buildCrossSessionSignalTransactionPlan(fixture, {
    ...request, eventReceipt: undefined, event: eventTwo, operationId, transactionAt,
  });
  assert(nakedEvent.reason === "raw-event-or-caller-time-not-accepted", "naked caller event JSON entered durable accumulation");
  const crossCandidateReplay = buildCrossSessionSignalTransactionPlan(fixture, { ...request, candidateId: "evolution.other" });
  assert(crossCandidateReplay.reason === "trusted-current-event-receipt-required", "an opaque event receipt replayed across candidates");
  const futureAt = new Date(Date.now() + 120_000).toISOString();
  const futureObservation = mintHostObservation({ taskBasis: "task-future", contextBasis: "future", observationBasis: "message-future", occurredAt: futureAt });
  assert(futureObservation.decision === "host-task-observation-denied", "a future-dated host observation entered the trusted boundary");
  const futureChallenge = mintChallenge({ taskBasis: "task-future-valid", contextBasis: "future", observationBasis: "message-future-valid" }).challenge;
  const futureReceipt = confirmCrossSessionSignalEvent(futureChallenge, {
    ...confirmationFor(futureChallenge, { messageRef: "message.confirm-future" }), confirmed_at: futureAt,
  });
  assert(futureReceipt.decision === "signal-event-receipt-denied", "a future-dated event poisoned durable learning time");
  const unclosedResultChallenge = mintChallenge({ taskBasis: "task-unclosed", contextBasis: "unclosed", observationBasis: "validation-unclosed" }).challenge;
  const unclosedResult = confirmCrossSessionSignalEvent(unclosedResultChallenge, {
    ...confirmationFor(unclosedResultChallenge, { messageRef: "message.confirm-unclosed" }), basis: "result-validation-receipt",
  });
  assert(unclosedResult.decision === "signal-event-receipt-denied", "a caller string masqueraded as a closed result-validation receipt");
  const replayChallenge = mintChallenge({ taskBasis: "task-other", contextBasis: "other", observationBasis: "message-other",
    forCandidateId: "evolution.other", forSignalId: "signal.other", forSignalRef: "instance/signals/count/signal.other.toml" }).challenge;
  const reusedMessage = confirmCrossSessionSignalEvent(replayChallenge, {
    ...confirmationFor(replayChallenge, { messageRef: receiptPayload.message_ref }),
  });
  assert(reusedMessage.decision === "signal-event-receipt-denied", "one host message was consumed as evidence for two candidates");

  // A caller-reported candidate revision is never trusted: source, index, and signal must all close on the same parsed revision.
  const revisionMismatchSignal = proposedSignalSource.replace("candidate_source_revision = 5", "candidate_source_revision = 999");
  const revisionMismatch = buildCrossSessionSignalTransactionPlan(fixture, {
    ...request, candidateSourceRevision: 999, proposed: { ...request.proposed, signalSource: revisionMismatchSignal },
  });
  assert(revisionMismatch.decision === "transaction-denied", "caller-supplied candidate/source revision bypassed the parsed revision closure");
  write(signalRef, currentSignalSource.replace("candidate_source_revision = 4", "candidate_source_revision = 999"));
  const staleSignalRevision = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(staleSignalRevision.decision === "transaction-denied", "a current learning signal accumulated against a stale candidate_source_revision");
  write(signalRef, currentSignalSource);

  const wrongEarliest = buildCrossSessionSignalTransactionPlan(fixture, {
    ...request, proposed: { ...request.proposed, timeProjection: proposedTimeMap.replace(`next_wakeup_at = ${q(nextWakeupAt)}`, `next_wakeup_at = ${q(wrongNextWakeupAt)}`) },
  });
  assert(wrongEarliest.decision === "transaction-denied", "an incorrect earliest wakeup was accepted");
  const overBudget = buildCrossSessionSignalTransactionPlan(fixture, {
    ...request, proposed: { ...request.proposed, signalProjection: `${proposedSignalMap}#${"x".repeat(1600)}\n` },
  });
  assert(overBudget.decision === "transaction-denied", "an over-budget startup capsule was accepted");

  const callerKeepsObserving = buildCrossSessionSignalTransactionPlan(fixture, {
    ...request, proposed: { ...request.proposed, signalSource: proposedSignalSource.replace('status = "pending-review"', 'status = "observing"') },
  });
  assert(callerKeepsObserving.decision === "transaction-denied", "caller kept a threshold-hit learning signal in observing state");

  for (const [relation, expectedStatus, suffix] of [["contradicting", "conflict", "conflict"], ["neutral", "observing", "neutral"]]) {
    const stateChallenge = mintChallenge({ taskBasis: `task-${suffix}`, contextBasis: suffix, observationBasis: `message-${suffix}` }).challenge;
    const stateReceipt = confirmCrossSessionSignalEvent(stateChallenge,
      confirmationFor(stateChallenge, { messageRef: `message.confirm-${suffix}`, relation }));
    const stateRequest = requestForReceipt(stateReceipt, { independent: true });
    const statePlan = buildCrossSessionSignalTransactionPlan(fixture, stateRequest.request);
    assert(stateRequest.artifacts.proposedSignalSource.includes(`status = "${expectedStatus}"`)
      && statePlan.decision === "transaction-preview",
    `${relation} evidence did not deterministically produce ${expectedStatus}: ${statePlan.detail ?? statePlan.reason ?? statePlan.decision}`);
  }

  const forgedSuccess = requestForReceipt(eventReceipt, { independent: true, successfulEventCount: 1 });
  const forgedSuccessResult = buildCrossSessionSignalTransactionPlan(fixture, forgedSuccess.request);
  assert(forgedSuccessResult.decision === "transaction-denied" && forgedSuccessResult.reason === "proposal-or-source-closure-invalid",
    "a host-attested supporting observation inflated validated success counters");

  const unknownIndex = `${currentCandidateIndex.trimEnd()}\nfuture_field = "preserve-current-action"\n`;
  write("instance/evolution/index.toml", unknownIndex);
  const pausedCurrentAction = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(pausedCurrentAction.decision === "cross-session-signal-related-capability-paused"
    && pausedCurrentAction.ordinaryTasksContinue === true && pausedCurrentAction.userReport?.next_step
    && readFileSync(resolve(fixture, "instance/evolution/index.toml"), "utf8") === unknownIndex,
  "an unclosable derived field consumed the event receipt, changed source bytes, or stopped the whole assistant");

  write("instance/evolution/index.toml", currentCandidateIndex.replace("candidate_count = 1", "candidate_count = 9").replaceAll("\n", "\r\n"));
  write("instance/maps/time-trigger-map.toml", currentTimeMap.replace("scheduled_count = 1", "scheduled_count = 9").replaceAll("\n", "\r\n"));
  write("instance/maps/signal-map.toml", currentSignalMap.replace("active_count = 0", "active_count = 9").replaceAll("\n", "\r\n"));
  const plan = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(plan.decision === "transaction-preview" && plan.executable === false && plan.contentIncluded === false
    && plan.steps.map((step) => step.phase).join(",") === "control-pending,candidate-source,candidate-index,learning-signal-source,time-projection,startup-signal-projection,dashboard-public-snapshot,dashboard-dist-snapshot,control-clean",
  "the transaction plan did not close the required pending-to-clean write order");
  assert(validateCrossSessionSignalTransactionPlan(plan) && plan.preimages.every((item) => !Object.hasOwn(item, "content"))
    && plan.steps.every((item) => !Object.hasOwn(item, "content")), "plan was not digest-bound or exposed proposed contents");
  const resumedReport = getOperationalDerivedStateReport(plan);
  assert(resumedReport?.impact.includes("重建") && resumedReport?.data_state.includes("用户数据")
    && resumedReport?.recoverability && resumedReport?.still_usable.includes("原来的学习动作已继续")
    && resumedReport?.next_step,
  "repairable derived drift did not resume the original signal action in the same call with a five-part report");
  const repeatedPlan = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(repeatedPlan.reason === "event-receipt-already-bound-to-a-plan", "one opaque event receipt minted more than one live plan");
  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.steps[1].proposedDigest = `sha256:${"0".repeat(64)}`;
  assert(!validateCrossSessionSignalTransactionPlan(tampered), "a changed candidate digest retained a valid transaction seal");

  // First preserve the legacy plan-only inspector contract with an exact three-step prefix.
  for (const step of plan.steps.slice(0, 3)) applyProposalStep(step);
  const interruptedStartup = inspectCrossSessionSignalStartup(fixture, { now: transactionAt });
  assert(interruptedStartup.decision === "startup-targeted-recovery" && interruptedStartup.readSet.length === 3,
    "pending startup did not select bounded targeted recovery");
  const blockedOverwrite = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(blockedOverwrite.decision === "transaction-recovery-required" && blockedOverwrite.readSet.length === 3,
    "a new durable update read bodies or overwrote an unfinished operation");
  assert(inspectCrossSessionSignalRecovery(fixture, {}).decision === "recovery-required",
    "pending state without its original digest-bound plan was guessed into a recovery action");
  const resume = inspectCrossSessionSignalRecovery(fixture, JSON.parse(JSON.stringify(plan)));
  assert(resume.decision === "transaction-resume-required" && resume.checkpoint === 3
    && resume.nextSteps[0].phase === "learning-signal-source", "recovery did not identify the exact prefix checkpoint");
  const rollback = inspectCrossSessionSignalRecovery(fixture, plan, { strategy: "rollback" });
  assert(rollback.decision === "transaction-rollback-required" && rollback.rollbackSteps.map((step) => step.target).join(",")
    === "instance/evolution/index.toml,instance/evolution/grade-workflow.md,instance/signals/control.toml",
  "failure rollback did not restore the changed prefix in reverse dependency order");
  write("instance/evolution/index.toml", currentCandidateIndex);
  write(candidateRef, currentCandidateSource);
  write("instance/signals/control.toml", currentControl);
  const restored = inspectCrossSessionSignalRecovery(fixture, plan, { strategy: "rollback" });
  assert(restored.decision === "transaction-not-started" && restored.retrySafe, "verified rollback did not return to the frozen preimage state");

  // Fault after 1/2/3/more complete writes, then inspect and recover in a fresh process through the public CLI.
  for (const stopAfter of [1, 2, 3, 8]) {
    writeInitial();
    const interrupted = executeCrossSessionSignalTransaction(fixture, plan, { hooks: {
      afterStep: ({ ordinal }) => { if (ordinal === stopAfter) throw new Error(`injected-stop-${stopAfter}`); },
    } });
    assert(interrupted.decision === "persistent-cross-session-signal-resume-interrupted"
      && interrupted.checkpoint === stopAfter, `fault after step ${stopAfter} did not preserve an exact prefix`);
    if (stopAfter === 1) {
      const persistedStartupReads = [];
      const persistedStartup = inspectCrossSessionSignalStartup(fixture, { now: transactionAt,
        onRead: (ref) => persistedStartupReads.push(ref) });
      assert(persistedStartup.decision === "startup-targeted-recovery"
        && JSON.stringify(persistedStartupReads) === JSON.stringify(["instance/manifest.toml", "instance/signals/control.toml", "instance/maps/signal-map.toml"]),
      "ordinary startup enumerated or loaded the local persistent transaction store");
    }
    const inspected = runCli("inspect", plan.operationId);
    assert(inspected.status === 0 && inspected.parsed.state === "prefix" && inspected.parsed.checkpoint === stopAfter,
      `fresh-process inspect did not recognize prefix ${stopAfter}`);
    if (stopAfter === 1) {
      const cleanupSummary = runCli("cleanup");
      assert(cleanupSummary.status === 0 && cleanupSummary.parsed.removedCount === 0,
        "public cleanup CLI changed a non-expired transaction");
    }
    const refusedClose = closePersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId });
    assert(refusedClose.decision === "persistent-cross-session-signal-close-rollback-required",
      `close removed the legal prefix after step ${stopAfter}`);
    if (stopAfter === 2) {
      const rolledBack = runCli("rollback", plan.operationId);
      assert(rolledBack.status === 0 && rolledBack.parsed.decision === "persistent-cross-session-signal-rollback-complete",
        "fresh-process rollback did not restore the exact preimage");
      const rolledBackAgain = runCli("rollback", plan.operationId);
      assert(rolledBackAgain.status === 0 && rolledBackAgain.parsed.idempotent === true,
        "cross-process rollback was not idempotent");
    } else {
      const resumed = runCli("resume", plan.operationId);
      assert(resumed.status === 0 && resumed.parsed.decision === "persistent-cross-session-signal-resume-complete",
        `fresh-process resume did not close prefix ${stopAfter}`);
      const targets = plan.preimages.map((item) => item.target);
      const beforeSecondResume = targets.map((ref) => createHash("sha256").update(readFileSync(resolve(fixture, ...ref.split("/")))).digest("hex"));
      const resumedAgain = runCli("resume", plan.operationId);
      const afterSecondResume = targets.map((ref) => createHash("sha256").update(readFileSync(resolve(fixture, ...ref.split("/")))).digest("hex"));
      assert(resumedAgain.status === 0 && resumedAgain.parsed.idempotent === true && resumedAgain.parsed.writeCount === 0
        && JSON.stringify(beforeSecondResume) === JSON.stringify(afterSecondResume),
      "second cross-process resume changed bytes or repeated a durable step");
      const publicSnapshot = readFileSync(resolve(fixture, PUBLIC_SNAPSHOT_REF), "utf8");
      const distSnapshot = readFileSync(resolve(fixture, DIST_SNAPSHOT_REF), "utf8");
      const rebuilt = buildSnapshotCandidate(fixture, { existingSource: publicSnapshot, now: new Date(plan.transactionAt) });
      assert(publicSnapshot === distSnapshot && rebuilt.updated === false && rebuilt.source === publicSnapshot
        && publicSnapshot.includes("宿主已区分出 2 次不同任务观察"),
      "pending-review did not immediately rebuild a byte-identical public/dist pair from merged truth");
    }
    const closed = runCli("close", plan.operationId);
    assert(closed.status === 0 && closed.parsed.operationalBundleRemoved === true,
      `safe ${stopAfter === 2 ? "preimage" : "final"} close did not remove only the operational bundle`);
  }

  writeInitial();
  const afterFinalWriteStop = executeCrossSessionSignalTransaction(fixture, plan, { hooks: {
    afterStep: ({ ordinal }) => { if (ordinal === 9) throw new Error("after-final-write-before-validation"); },
  } });
  const finalWriteInspect = runCli("inspect", plan.operationId);
  assert(afterFinalWriteStop.decision === "persistent-cross-session-signal-resume-interrupted"
    && finalWriteInspect.parsed.state === "final" && finalWriteInspect.parsed.checkpoint === 9
    && runCli("resume", plan.operationId).parsed.idempotent === true,
  "a process stop after all writes but before final validation was not recovered idempotently");
  assert(runCli("close", plan.operationId).parsed.decision === "persistent-cross-session-signal-closed",
    "post-final-validation bundle did not close safely");

  // Simulate a hard stop between moving one preimage aside and installing its staged replacement.
  writeInitial();
  executeCrossSessionSignalTransaction(fixture, plan, { hooks: {
    afterStep: ({ ordinal }) => { if (ordinal === 1) throw new Error("mid-swap-fixture"); },
  } });
  const swapToken = `${plan.planDigest.slice("sha256:".length, "sha256:".length + 16)}-02`;
  const candidateTarget = resolve(fixture, ...candidateRef.split("/"));
  const candidateStage = `${candidateTarget}.cross-session-${swapToken}.stage`;
  const candidateBackup = `${candidateTarget}.cross-session-${swapToken}.backup`;
  const bundleStep = resolve(fixture, ".assistant-local/runtime/cross-session-signals", plan.operationId, "step-02.bin");
  cpSync(bundleStep, candidateStage); renameSync(candidateTarget, candidateBackup);
  const atomicInterrupted = runCli("inspect", plan.operationId);
  assert(atomicInterrupted.status === 0 && atomicInterrupted.parsed.state === "prefix"
    && atomicInterrupted.parsed.checkpoint === 1 && atomicInterrupted.parsed.atomicRepairRequired === true,
  "fresh-process inspect did not recognize the recoverable mid-swap prefix");
  assert(closePersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId }).decision
    === "persistent-cross-session-signal-close-rollback-required",
  "close removed a bundle while atomic swap evidence still required repair");
  assert(runCli("resume", plan.operationId).parsed.decision === "persistent-cross-session-signal-resume-complete",
    "fresh-process resume did not repair the bounded mid-swap evidence before continuing");
  assert(runCli("close", plan.operationId).parsed.decision === "persistent-cross-session-signal-closed",
    "mid-swap recovery bundle did not close from its exact final state");
  const complete = inspectCrossSessionSignalRecovery(fixture, plan);
  assert(complete.decision === "transaction-complete" && complete.idempotent, "complete transaction was not recognized by all final digests");
  const secondExecution = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(secondExecution.decision === "transaction-noop" && secondExecution.reason === "event-already-applied",
    "second execution accumulated the same source-plus-event identity twice");

  // Rollback has its own bounded swap ordinals. Reproduce exact disk states
  // at each hard-stop boundary, including a retry after prior targets restored.
  for (const [stopAfter, restoredBeforeCrash] of [[3, 0], [3, 1], [8, 7]]) {
    for (const phase of ["stage-written", "backup-moved", "preimage-installed"]) {
      writeInitial();
      executeCrossSessionSignalTransaction(fixture, plan, { hooks: {
        afterStep: ({ ordinal }) => { if (ordinal === stopAfter) throw new Error("rollback-crash-fixture"); },
      } });
      const bundle = resolve(fixture, ".assistant-local/runtime/cross-session-signals", plan.operationId);
      const record = JSON.parse(readFileSync(resolve(bundle, "record.json"), "utf8"));
      const changed = plan.rollback.filter((item) => plan.steps.find((step) => step.target === item.target).ordinal <= stopAfter);
      const preimageFile = (item) => resolve(bundle, record.preimages.find((entry) => entry.target === item.target).file);
      for (const item of changed.slice(0, restoredBeforeCrash)) cpSync(preimageFile(item), resolve(fixture, item.target));
      const item = changed[restoredBeforeCrash]; const target = resolve(fixture, item.target);
      const token = `${plan.planDigest.slice("sha256:".length, "sha256:".length + 16)}-${90 + restoredBeforeCrash}`;
      const stage = `${target}.cross-session-${token}.stage`; const backup = `${target}.cross-session-${token}.backup`;
      cpSync(preimageFile(item), stage);
      if (phase !== "stage-written") renameSync(target, backup);
      if (phase === "preimage-installed") renameSync(stage, target);
      if (stopAfter === 3 && restoredBeforeCrash === 0 && phase === "stage-written") {
        const exactStage = readFileSync(stage); writeFileSync(stage, "unbound rollback stage\n");
        const corrupted = runCli("rollback", plan.operationId);
        assert(corrupted.parsed.decision === "persistent-cross-session-signal-rollback-recovery-required"
          && readFileSync(stage, "utf8") === "unbound rollback stage\n",
        "rollback guessed through or deleted an unbound swap carrier");
        writeFileSync(stage, exactStage);
      }
      const crashed = runCli("inspect", plan.operationId);
      assert(crashed.parsed.state === "prefix" && crashed.parsed.atomicRepairRequired === true
        && crashed.parsed.checkpoint === stopAfter - restoredBeforeCrash - (phase === "preimage-installed" ? 1 : 0),
      `rollback ${phase} at ordinal ${90 + restoredBeforeCrash} was not recognized as a bound swap`);
      assert(runCli("rollback", plan.operationId).parsed.decision === "persistent-cross-session-signal-rollback-complete"
        && runCli("inspect", plan.operationId).parsed.state === "preimage" && !existsSync(stage) && !existsSync(backup),
      `fresh-process rollback could not recover ${phase} at ordinal ${90 + restoredBeforeCrash}`);
      assert(runCli("rollback", plan.operationId).parsed.idempotent === true,
        "rollback recovery did not remain idempotent");
      assert(runCli("close", plan.operationId).parsed.decision === "persistent-cross-session-signal-closed",
        "recovered rollback bundle did not close from its exact preimage state");
    }
  }

  // Stop after the precondition read but before even publishing a stage file:
  // no carrier exists yet that could incidentally make the contender see drift.
  // A different operation must not commit into this shared-control race window.
  writeInitial();
  const contenderChallenge = mintChallenge({ taskBasis: "task-grade-contender", observationBasis: "message-grade-contender" }).challenge;
  const contenderReceipt = confirmCrossSessionSignalEvent(contenderChallenge,
    confirmationFor(contenderChallenge, { messageRef: "message.confirm-grade-contender" }));
  const contenderRequest = requestForReceipt(contenderReceipt, { independent: true, distinctContextDelta: 0 });
  const contenderPlan = buildCrossSessionSignalTransactionPlan(fixture, contenderRequest.request);
  assert(contenderPlan.decision === "transaction-preview" && contenderPlan.operationId !== plan.operationId,
    "concurrency fixture did not create two valid, distinct operation IDs");
  executeCrossSessionSignalTransaction(fixture, contenderPlan, { hooks: {
    afterStep: ({ ordinal }) => { if (ordinal === 1) throw new Error("persist-contender-bundle"); },
  } });
  assert(rollbackPersistentCrossSessionSignalTransaction(fixture, { operationId: contenderPlan.operationId }).decision
    === "persistent-cross-session-signal-rollback-complete", "contender bundle did not return to the common preimage");
  const ordinaryOpen = fs.openSync; let raceWindowReached = false; let writerResult;
  const sharedControl = resolve(realpathSync(fixture), "instance/signals/control.toml");
  const controlStage = `${sharedControl}.cross-session-${plan.planDigest.slice("sha256:".length, "sha256:".length + 16)}-01.stage`;
  try {
    fs.openSync = (path, flags, ...options) => {
      if (!raceWindowReached && flags === "wx" && typeof path === "string" && resolve(path) === controlStage) {
        raceWindowReached = true;
        const before = readFileSync(sharedControl);
        for (const command of ["resume", "rollback", "close", "cleanup"]) {
          const contender = runCli(command, command === "cleanup" ? "" : contenderPlan.operationId);
          assert(contender.status === 2 && contender.parsed.reason === "instance-write-busy",
            `different-operation ${command} bypassed the instance write lock`);
        }
        assert(runCli("inspect", contenderPlan.operationId).parsed.decision === "persistent-cross-session-signal-transaction-inspected"
          && readFileSync(sharedControl).equals(before),
        "write contention blocked a read-only inspection or changed shared control bytes");
      }
      return ordinaryOpen(path, flags, ...options);
    };
    syncBuiltinESMExports();
    writerResult = executeCrossSessionSignalTransaction(fixture, plan);
  } finally {
    fs.openSync = ordinaryOpen;
    syncBuiltinESMExports();
  }
  assert(raceWindowReached && writerResult.decision === "persistent-cross-session-signal-resume-complete"
    && inspectPersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId }).state === "final",
  `competing operation corrupted the winning transaction or the race seam was not exercised: ${JSON.stringify({ raceWindowReached, decision: writerResult?.decision, reason: writerResult?.reason })}`);
  assert(runCli("close", plan.operationId).parsed.decision === "persistent-cross-session-signal-closed",
    "winner could not close after distinct-operation contention");
  writeInitial();
  assert(runCli("close", contenderPlan.operationId).parsed.decision === "persistent-cross-session-signal-closed",
    "preserved contender bundle could not close after exact preimage restoration");

  // TTL cleanup removes only exact preimage/final bundles and preserves prefix/drift evidence.
  const expiredAt = new Date(Date.parse(plan.expiresAt) + 1);
  writeInitial();
  executeCrossSessionSignalTransaction(fixture, plan, { hooks: { afterStep: () => { throw new Error("ttl-preimage"); } } });
  assert(rollbackPersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId }).decision
    === "persistent-cross-session-signal-rollback-complete", "TTL preimage fixture could not roll back");
  const preimageCleanup = cleanupExpiredPersistentCrossSessionSignalTransactions(fixture, { now: expiredAt });
  assert(preimageCleanup.decision === "persistent-cross-session-signal-cleanup-complete" && preimageCleanup.removedCount === 1,
    "expired exact preimage bundle was not safely cleaned");

  writeInitial();
  assert(executeCrossSessionSignalTransaction(fixture, plan).decision === "persistent-cross-session-signal-resume-complete",
    "TTL final fixture did not commit");
  const finalCleanup = cleanupExpiredPersistentCrossSessionSignalTransactions(fixture, { now: expiredAt });
  assert(finalCleanup.decision === "persistent-cross-session-signal-cleanup-complete" && finalCleanup.removedCount === 1,
    "expired exact final bundle was not safely cleaned");

  writeInitial();
  executeCrossSessionSignalTransaction(fixture, plan, { hooks: {
    afterStep: ({ ordinal }) => { if (ordinal === 3) throw new Error("ttl-prefix"); },
  } });
  const prefixCleanup = cleanupExpiredPersistentCrossSessionSignalTransactions(fixture, { now: expiredAt });
  assert(prefixCleanup.decision === "persistent-cross-session-signal-cleanup-rollback-required"
    && prefixCleanup.rollbackRequiredCount === 1
    && inspectPersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId }).state === "prefix",
  "expired legal prefix was deleted instead of preserving rollback evidence");
  assert(rollbackPersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId }).decision
    === "persistent-cross-session-signal-rollback-complete", "expired prefix could not be rolled back across the persistent boundary");
  assert(closePersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId }).decision
    === "persistent-cross-session-signal-closed", "rolled-back expired prefix could not be safely closed");

  writeInitial();
  executeCrossSessionSignalTransaction(fixture, plan, { hooks: {
    afterStep: ({ ordinal }) => { if (ordinal === 2) throw new Error("ttl-drift"); },
  } });
  write(candidateRef, `${readFileSync(resolve(fixture, ...candidateRef.split("/")), "utf8")}# external drift\n`);
  const driftBytes = readFileSync(resolve(fixture, ...candidateRef.split("/")));
  const driftCleanup = cleanupExpiredPersistentCrossSessionSignalTransactions(fixture, { now: expiredAt });
  const driftResume = runCli("resume", plan.operationId);
  const driftRollback = rollbackPersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId });
  assert(driftCleanup.decision === "persistent-cross-session-signal-cleanup-recovery-required"
    && driftCleanup.recoveryRequiredCount === 1
    && driftResume.status === 2 && driftResume.parsed.decision === "persistent-cross-session-signal-resume-recovery-required"
    && driftRollback.decision === "persistent-cross-session-signal-rollback-recovery-required"
    && readFileSync(resolve(fixture, ...candidateRef.split("/"))).equals(driftBytes)
    && closePersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId }).decision
      === "persistent-cross-session-signal-close-recovery-required",
  "expired drift was deleted or closable instead of preserving recovery evidence");
  writeInitial();
  assert(closePersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId }).decision
    === "persistent-cross-session-signal-closed", "drift evidence could not be closed after exact preimage restoration");

  // A non-prefix combination of individually bound digests is still drift and is never guessed into rollback.
  writeInitial();
  executeCrossSessionSignalTransaction(fixture, plan, { hooks: {
    afterStep: ({ ordinal }) => { if (ordinal === 1) throw new Error("non-prefix-fixture"); },
  } });
  const boundOutOfOrderIndex = resolve(fixture, ".assistant-local/runtime/cross-session-signals", plan.operationId, "step-03.bin");
  writeFileSync(resolve(fixture, "instance/evolution/index.toml"), readFileSync(boundOutOfOrderIndex));
  const nonPrefix = inspectPersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId });
  assert(nonPrefix.state === "drift"
    && resumePersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId }).decision
      === "persistent-cross-session-signal-resume-recovery-required"
    && rollbackPersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId }).decision
      === "persistent-cross-session-signal-rollback-recovery-required",
  "a non-prefix combination of bound digests was guessed into resume or rollback");
  writeInitial();
  assert(closePersistentCrossSessionSignalTransaction(fixture, { operationId: plan.operationId }).decision
    === "persistent-cross-session-signal-closed", "non-prefix evidence could not close after exact restoration");

  // Revocation, promotion/archive, and deletion all stop accumulation before trusting caller proposals.
  writeInitial();
  const revokedValues = { ...candidateBase, status: "review", observation_state: "revoked" };
  write(candidateRef, candidateSource(revokedValues));
  write("instance/evolution/index.toml", candidateIndex({ entries: [candidateEntry(revokedValues)] }));
  const revoked = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(revoked.reason === "candidate-observation-revoked-no-further-accumulation", "revoked observation continued to accumulate");

  writeInitial();
  const archivedValues = { ...candidateBase, status: "archived" };
  write(candidateRef, candidateSource(archivedValues, `\nresolution = "promoted"\nresolved_to = "sop.grade-workflow"`));
  write("instance/evolution/index.toml", candidateIndex({ rootRevision: 10, entries: [] }));
  const archived = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(archived.reason === "candidate-promoted-or-archived-no-further-accumulation", "promoted or archived candidate continued to accumulate");
  write(candidateRef, candidateSource(archivedValues, `\nresolution = "invalid-disposition"\nresolved_to = "sop.grade-workflow"`));
  const poisonedArchive = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(poisonedArchive.reason === "proposal-or-source-closure-invalid" && poisonedArchive.detail.includes("resolution"),
    "an archived status bypassed terminal disposition validation");
  write(candidateRef, candidateSource({ ...archivedValues, summary: ["sk", "-", "abcdefghijklmnopqrstuvwxyz123456"].join("") }, `\nresolution = "promoted"\nresolved_to = "sop.grade-workflow"`));
  const secretArchive = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(secretArchive.reason === "proposal-or-source-closure-invalid", "an archived status bypassed secret-content validation");

  writeInitial();
  rmSync(resolve(fixture, ...candidateRef.split("/")), { force: true });
  write("instance/evolution/index.toml", candidateIndex({ rootRevision: 10, entries: [] }));
  const deleted = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(deleted.reason === "candidate-deleted-no-further-accumulation", "deleted candidate continued to accumulate");

  // A different task ID inside an already-counted context is another independent task, but not another context.
  writeInitial();
  const sameContextChallenge = mintChallenge({ taskBasis: "task-grade-3", contextBasis: "grade-workflow", observationBasis: "message-grade-3" }).challenge;
  const sameContextReceipt = confirmCrossSessionSignalEvent(sameContextChallenge,
    confirmationFor(sameContextChallenge, { messageRef: "message.confirm-grade-3" }));
  const sameContext = requestForReceipt(sameContextReceipt, { independent: true, distinctContextDelta: 0 });
  const sameContextPlan = buildCrossSessionSignalTransactionPlan(fixture, sameContext.request);
  assert(sameContextPlan.decision === "transaction-preview" && sameContextReceipt.contextId === eventOne.context_id,
    "a second real task in an existing semantic context could not advance task evidence without inflating context count");

  // The same opaque host task basis is deduplicated even when a later message has a new observation identity.
  const repeatTaskChallenge = mintChallenge({ taskBasis: "task-grade-1", contextBasis: "grade-workflow", observationBasis: "message-grade-1-repeat" }).challenge;
  const repeatTaskReceipt = confirmCrossSessionSignalEvent(repeatTaskChallenge,
    confirmationFor(repeatTaskChallenge, { messageRef: "message.confirm-grade-1-repeat" }));
  assert(repeatTaskReceipt.taskId === eventOne.task_id, "the same host task basis produced a different opaque task identity");
  const repeatTask = requestForReceipt(repeatTaskReceipt, { independent: false, distinctContextDelta: 0 });
  const repeatedTaskPlan = buildCrossSessionSignalTransactionPlan(fixture, repeatTask.request);
  assert(repeatedTaskPlan.decision === "transaction-noop" && repeatedTaskPlan.reason === "same-task-observation-already-represented",
    "a repeated same-relation task observation created durable evidence instead of becoming a no-op");

  const stableBeforeRetryStorm = [candidateRef, "instance/evolution/index.toml", signalRef, "instance/signals/control.toml",
    "instance/maps/time-trigger-map.toml", "instance/maps/signal-map.toml"]
    .map((ref) => readFileSync(resolve(fixture, ...ref.split("/")))).map((bytes) => createHash("sha256").update(bytes).digest("hex"));
  for (let retryIndex = 0; retryIndex < 100; retryIndex += 1) {
    const repeated = mintChallenge({ taskBasis: "task-grade-1", contextBasis: "grade-workflow",
      observationBasis: `message-grade-1-retry-${retryIndex}` }).challenge;
    const repeatedReceipt = confirmCrossSessionSignalEvent(repeated,
      confirmationFor(repeated, { messageRef: `message.confirm-grade-1-retry-${retryIndex}` }));
    const repeatedRequest = requestForReceipt(repeatedReceipt, { independent: false, distinctContextDelta: 0 });
    const retryPlan = buildCrossSessionSignalTransactionPlan(fixture, repeatedRequest.request);
    assert(retryPlan.decision === "transaction-noop" && retryPlan.reason === "same-task-observation-already-represented",
      `same-task retry ${retryIndex + 1} created a durable revision`);
  }
  const stableAfterRetryStorm = [candidateRef, "instance/evolution/index.toml", signalRef, "instance/signals/control.toml",
    "instance/maps/time-trigger-map.toml", "instance/maps/signal-map.toml"]
    .map((ref) => readFileSync(resolve(fixture, ...ref.split("/")))).map((bytes) => createHash("sha256").update(bytes).digest("hex"));
  assert(JSON.stringify(stableAfterRetryStorm) === JSON.stringify(stableBeforeRetryStorm),
    "100 same-task retries changed bytes or revisions");

  // A real relation change for the same task replaces its one bounded observation instead of appending forever.
  const correctionChallenge = mintChallenge({ taskBasis: "task-grade-1", contextBasis: "grade-workflow",
    observationBasis: "message-grade-1-correction" }).challenge;
  const correctionReceipt = confirmCrossSessionSignalEvent(correctionChallenge,
    confirmationFor(correctionChallenge, { messageRef: "message.confirm-grade-1-correction", relation: "contradicting" }));
  const correction = requestForReceipt(correctionReceipt, { independent: false, distinctContextDelta: 0, replaceEvent: eventOne });
  const correctionPlan = buildCrossSessionSignalTransactionPlan(fixture, correction.request);
  assert(correctionPlan.decision === "transaction-preview", "a same-task relation correction could not form a bounded replacement transaction");
  const beforeConflictSnapshot = readFileSync(resolve(fixture, PUBLIC_SNAPSHOT_REF), "utf8");
  ({ proposedCandidateSource, proposedCandidateIndex, proposedSignalSource, proposedTimeMap,
    proposedSignalMap, pendingControl, cleanControl } = correction.artifacts);
  assert(executeCrossSessionSignalTransaction(fixture, correctionPlan).decision === "persistent-cross-session-signal-resume-complete",
    "same-task relation correction did not execute through the persistent exact-byte boundary");
  const correctedSignal = readFileSync(resolve(fixture, ...signalRef.split("/")), "utf8");
  const conflictPublicSnapshot = readFileSync(resolve(fixture, PUBLIC_SNAPSHOT_REF), "utf8");
  const conflictDistSnapshot = readFileSync(resolve(fixture, DIST_SNAPSHOT_REF), "utf8");
  const conflictRebuild = buildSnapshotCandidate(fixture, { existingSource: conflictPublicSnapshot, now: new Date(correctionPlan.transactionAt) });
  assert((correctedSignal.match(/\[\[evidence\]\]/g) ?? []).length === 1
    && correctedSignal.includes('relation = "contradicting"')
    && correctedSignal.includes('independent_event_count = 1')
    && conflictPublicSnapshot === conflictDistSnapshot && conflictPublicSnapshot !== beforeConflictSnapshot
    && conflictRebuild.updated === false && conflictRebuild.source === conflictPublicSnapshot,
  "same-task relation correction did not replace exactly one bounded observation while preserving its count");
  assert(closePersistentCrossSessionSignalTransaction(fixture, { operationId: correctionPlan.operationId }).decision
    === "persistent-cross-session-signal-closed", "conflict transaction did not close from its exact final state");
  writeInitial();

  // A host that cannot provide a reusable task key gets an explicitly non-independent observation.
  const unstableChallengeBundle = mintChallenge({ taskBasis: "", taskBasisStable: false, contextBasis: "", observationBasis: "message-unstable-task" });
  assert(unstableChallengeBundle.hostTaskObservationReceipt.independent === false
    && unstableChallengeBundle.challenge.taskIdentityTrust === "non-independent-observation",
  "an unavailable stable task basis was silently treated as independent");
  const unstableReceipt = confirmCrossSessionSignalEvent(unstableChallengeBundle.challenge,
    confirmationFor(unstableChallengeBundle.challenge, { messageRef: "message.confirm-unstable-task" }));
  const unstableRequest = requestForReceipt(unstableReceipt, { independent: false, distinctContextDelta: 0 });
  assert(buildCrossSessionSignalTransactionPlan(fixture, unstableRequest.request).decision === "transaction-preview",
    "a non-independent observation could not be retained without advancing the task counter");

  // Corruption is not treated as absence and cannot be converted into a fresh transaction.
  writeInitial();
  write(candidateRef, "not frontmatter\n");
  const corrupt = buildCrossSessionSignalTransactionPlan(fixture, request);
  assert(corrupt.reason === "proposal-or-source-closure-invalid" && corrupt.detail.includes("frontmatter"),
    "an existing corrupt candidate was treated as a missing candidate");

  // Corrupt private payload is recovery evidence, never executable content or TTL garbage.
  writeInitial();
  executeCrossSessionSignalTransaction(fixture, plan, { hooks: {
    afterStep: ({ ordinal }) => { if (ordinal === 1) throw new Error("bundle-corruption-fixture"); },
  } });
  const corruptPayload = resolve(fixture, ".assistant-local/runtime/cross-session-signals", plan.operationId, "step-09.bin");
  writeFileSync(corruptPayload, Buffer.concat([readFileSync(corruptPayload), Buffer.from("drift", "utf8")]));
  const corruptBundleInspect = runCli("inspect", plan.operationId);
  const corruptBundleCleanup = cleanupExpiredPersistentCrossSessionSignalTransactions(fixture, { now: expiredAt });
  assert(corruptBundleInspect.status === 2 && corruptBundleInspect.parsed.decision === "persistent-cross-session-signal-inspect-denied"
    && corruptBundleCleanup.decision === "persistent-cross-session-signal-cleanup-recovery-required"
    && existsSync(resolve(fixture, ".assistant-local/runtime/cross-session-signals", plan.operationId)),
  "corrupt private payload was executed, exposed, or deleted instead of preserving recovery evidence");

  runCaptureSignalInteropFixture();

  console.log("Cross-session signal transaction passed opaque host receipts, canonical capture-to-signal accumulation and legacy alias migration, bounded dead sibling-projection cleanup, honest review-only evidence, 100-retry zero growth, bounded same-task relation replacement, private exact-byte persistence, 1/2/3/8-step cross-process recovery, rollback swap crashes at ordinals 90/91/97, competing-operation serialization, TTL/close/drift preservation, merged-truth byte-identical snapshots, bounded CLI output, minimal startup, recovery, corruption, and idempotence checks.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
