import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLearningCaptureTransactionPlan,
  buildLearningReminderCancellationPlan,
  cleanupStaleLearningCaptureProjections,
  cleanupExpiredPersistentLearningCaptureChallenges,
  closeLearningCaptureWithoutResponse,
  closePersistentLearningCaptureChallenge,
  confirmLearningCaptureChoice,
  confirmPersistentLearningCaptureChallenge,
  confirmLearningReminderCancellation,
  createLearningCaptureChoiceChallenge,
  createLearningCaptureObservationReceipt,
  createLearningReminderCancellationChallenge,
  executePersistentLearningCaptureTransaction,
  inspectLearningCaptureTransactionState,
  inspectLearningReminderCancellationState,
  loadPersistentLearningCapturePlan,
  preparePersistentLearningCaptureChallenge,
  rollbackPersistentLearningCaptureTransaction,
  shortlistLearningReminderCancellations,
  validateLearningCaptureTransactionPlan,
  validateLearningReminderCancellationPlan,
} from "./learning-capture-transaction.mjs";
import * as learningCaptureRuntime from "./learning-capture-transaction.mjs";
import {
  inspectShortlistedFormalAsset,
  loadTrustedDomainEnvelope,
  parseArrayTableDocument,
  parseMarkdownFrontmatterHead,
  queryFormalAssetShortlist,
} from "./asset-route-contract.mjs";
import { validateCandidateIndex } from "./candidate-index-contract.mjs";
import { buildSnapshotCandidate } from "./snapshot-source-builder.mjs";
import { parseCurrentSnapshotEnvelope } from "./snapshot-envelope.mjs";
import { buildStartupCapsule } from "./startup-capsule-contract.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptDir, "../..");
const CANDIDATE_INDEX_REF = "instance/evolution/index.toml";
const temporaryRoots = [];

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function createFixture(name, { full = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), `ai-carry-${name}-`)); temporaryRoots.push(root);
  if (full) {
    for (const file of ["assistant.toml", "AGENTS.md", "BOOTSTRAP.md"]) cpSync(join(sourceRoot, file), join(root, file));
    cpSync(join(sourceRoot, "core"), join(root, "core"), { recursive: true });
    cpSync(join(sourceRoot, "instance"), join(root, "instance"), { recursive: true });
    mkdirSync(join(root, "dashboard/public"), { recursive: true });
    mkdirSync(join(root, "dashboard/dist"), { recursive: true });
    cpSync(join(sourceRoot, "dashboard/public/snapshot.js"), join(root, "dashboard/public/snapshot.js"));
    cpSync(join(sourceRoot, "dashboard/dist/snapshot.js"), join(root, "dashboard/dist/snapshot.js"));
  }
  for (const directory of ["core/maps", "instance/evolution", "instance/signals", "instance/maps", "instance/profile"]) mkdirSync(join(root, directory), { recursive: true });
  cpSync(join(sourceRoot, "core/manifest.toml"), join(root, "core/manifest.toml"));
  cpSync(join(sourceRoot, "core/maps/asset-confirmation-gates.toml"), join(root, "core/maps/asset-confirmation-gates.toml"));
  let manifest = readFileSync(join(sourceRoot, "instance/manifest.toml"), "utf8");
  manifest = manifest
    .replace('instance_id = "template"', `instance_id = "${name}"`)
    .replace('state = "template"', 'state = "instance"')
    .replace('type = "unselected"', 'type = "general"')
    .replace('locked = false', 'locked = true')
    .replace('label = ""', 'label = "通用个人助手"')
    .replace('scope_statement = ""', 'scope_statement = "用于真实任务中的个人协作"')
    .replace('status = "not-instantiated"', 'status = "active"')
    .replace('guidance_mode = "unselected"', 'guidance_mode = "balanced"')
    .replace('display_name = ""', 'display_name = "学习事务测试助手"')
    .replace('mission = ""', 'mission = "在不增加用户负担的前提下可靠积累"')
    .replace('user_preferences_ref = "instance/profile/README.md"', 'user_preferences_ref = "instance/profile/user.md"');
  writeFileSync(join(root, "instance/manifest.toml"), manifest, "utf8");
  const domainMap = readFileSync(join(sourceRoot, "instance/maps/domain-map.toml"), "utf8")
    .replace('instance_id = "template"', `instance_id = "${name}"`)
    .replace('direction = "unselected"', 'direction = "general"')
    .replace('status = "empty-until-instantiation"', 'status = "active"');
  writeFileSync(join(root, "instance/maps/domain-map.toml"), domainMap, "utf8");
  for (const ref of ["instance/evolution/index.toml", "instance/signals/control.toml", "instance/maps/signal-map.toml", "instance/maps/time-trigger-map.toml"]) {
    let content = readFileSync(join(sourceRoot, ...ref.split("/")), "utf8").replace('instance_id = "template"', `instance_id = "${name}"`);
    if (full && ref === "instance/evolution/index.toml") content = content.replace('generated_at = ""', `generated_at = "${new Date().toISOString()}"`);
    writeFileSync(join(root, ...ref.split("/")), content, "utf8");
  }
  if (full) {
    for (const ref of ["instance/skills/requirements.toml", "instance/validations/index.toml"]) {
      const path = join(root, ...ref.split("/"));
      writeFileSync(path, readFileSync(path, "utf8").replace('instance_id = "template"', `instance_id = "${name}"`), "utf8");
    }
  }
  writeFileSync(join(root, "instance/profile/user.md"), "# Fixture\n", "utf8");
  if (full) writeFileSync(join(root, "instance/startup-capsule.toml"), buildStartupCapsule(root).source, "utf8");
  return root;
}

function proposal(overrides = {}) {
  const formalPreview = `+++
id = "memory.learning-preference"
kind = "memory"
subtype = "habit"
status = "active"
title = "用日常说法召回旧做法"
summary = "用户不必记住准确名称，也能得到少量相关旧做法提示"
triggers = ["帮我弄一下上次那个"]
aliases = ["跟之前差不多"]
topic_key = "natural-language-recall"
subject_key = "previous-workflow"
scope = ["相近的真实任务"]
conditions = ["当前说法与已保存做法有明确语义关联"]
excludes = ["宽泛词或高影响操作"]
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

在相近真实任务中先用普通语言提示可能相关的旧做法，并在多项或高影响时请用户确认。
`;
  return {
    title: "用日常说法召回旧做法",
    summary: "用户不必记住准确名称，也能得到少量相关旧做法提示",
    triggers: ["帮我弄一下上次那个"],
    aliases: ["跟之前差不多"],
    scope: ["相近的真实任务"],
    conditions: ["当前说法与已保存做法有明确语义关联"],
    excludes: ["宽泛词或高影响操作"],
    topic_key: "natural-language-recall",
    subject_key: "previous-workflow",
    target_kind: "memory",
    target_subtype: "habit",
    claim_summary: "普通用户可以用不精确的日常语言找回旧做法，而不需要知道内部名称或路径。",
    proposed_risk_tier: "low",
    minimum_level: 1,
    formal_preview: formalPreview,
    ...overrides,
  };
}

function installMatchingFormalAsset(root) {
  const route = {
    id: "memory.previous-workflow", asset_kind: "memory", subtype: "habit",
    title: "用日常说法召回旧做法", summary: "用户不必记住准确名称，也能得到少量相关旧做法提示",
    triggers: ["帮我弄一下上次那个"], aliases: ["跟之前差不多"],
    topic_key: "natural-language-recall", subject_key: "previous-workflow",
    scope: ["相近的真实任务"], conditions: ["当前说法与已保存做法有明确语义关联"],
    excludes: ["宽泛词或高影响操作"], related_asset_ids: [], body_sections: [],
    target: "instance/memory/previous-workflow.md", state: "active", minimum_level: 1, confirmation: "none",
  };
  const fields = (value) => Object.entries(value).map(([key, item]) => `${key} = ${Array.isArray(item) ? JSON.stringify(item) : typeof item === "string" ? JSON.stringify(item) : item}`).join("\n");
  const asset = {
    id: route.id, kind: "memory", subtype: "habit", status: "active", title: route.title, summary: route.summary,
    triggers: route.triggers, aliases: route.aliases, topic_key: route.topic_key, subject_key: route.subject_key,
    scope: route.scope, conditions: route.conditions, excludes: route.excludes, lifecycle: "recurring", expected_next_use: "",
    source_refs: [], private_refs: [], supersedes: [], updated_at: "", related_asset_ids: [], body_sections: [],
    minimum_level: 1, approval_state: "explicit", activation_basis: "explicit-user", risk_tier: "low",
    approved_by_user: true, confirmation: "none",
  };
  mkdirSync(join(root, "instance/memory"), { recursive: true });
  writeFileSync(join(root, "instance/memory/previous-workflow.md"), `+++\n${fields(asset)}\n+++\n# 使用说明\n只在相关任务命中后使用。\n`, "utf8");
  const domainMap = `schema_version = 1\nmap_id = "instance-domain"\ninstance_id = ${JSON.stringify(readInstanceId(root))}\ndirection = "general"\nstatus = "active"\n\n[budget]\nsoft_max_bytes = 32768\nhard_max_bytes = 49152\nsoft_max_routes = 96\nhard_max_routes = 128\nmax_route_bytes = 2048\ncandidate_limit = 3\noverflow_state = "ok"\n\n[[routes]]\n${fields(route)}\n`;
  writeFileSync(join(root, "instance/maps/domain-map.toml"), domainMap, "utf8");
}

function readInstanceId(root) {
  const match = readFileSync(join(root, "instance/manifest.toml"), "utf8").match(/^instance_id = "([^"]+)"/mu);
  if (!match) throw new Error("fixture instance id missing");
  return match[1];
}

function currentReceipt(challenge, choice, suffix, { remindAt = "", messageAt = undefined, confirmedAt = undefined } = {}) {
  const now = new Date();
  const occurred = messageAt ?? now.toISOString();
  const confirmed = confirmedAt ?? now.toISOString();
  return {
    basis: "host-current-user-message",
    message_ref: `message.${suffix}`,
    message_digest: sha256(`current user choice ${choice} ${suffix}`),
    user_message_at: occurred,
    confirmed_at: confirmed,
    choice,
    remind_at: remindAt,
    instance_id: challenge.instanceId,
    proposal_digest: challenge.proposalDigest,
    challenge_nonce: challenge.challengeNonce,
  };
}

function persistentReceipt(challenge, choice, suffix, { remindAt = "", messageAt = undefined, confirmedAt = undefined } = {}) {
  const now = new Date().toISOString();
  return {
    basis: "host-current-user-message", message_ref: `message.persistent.${suffix}`,
    message_digest: sha256(`persistent current user choice ${choice} ${suffix}`),
    user_message_at: messageAt ?? now, confirmed_at: confirmedAt ?? now, choice, remind_at: remindAt,
    instance_id: challenge.instanceId, proposal_digest: challenge.proposalDigest,
    challenge_nonce: challenge.challengeNonce,
  };
}

function cancellationReceipt(challenge, suffix, { messageAt = undefined, confirmedAt = undefined } = {}) {
  const now = new Date().toISOString();
  return {
    basis: "host-current-user-message",
    message_ref: `message.cancel.${suffix}`,
    message_digest: sha256(`cancel reminder ${suffix}`),
    user_message_at: messageAt ?? now,
    confirmed_at: confirmedAt ?? now,
    candidate_id: challenge.candidateId,
    instance_id: challenge.instanceId,
    challenge_nonce: challenge.challengeNonce,
  };
}

function treeIdentity(root) {
  const rows = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const absolute = join(directory, entry.name); const rel = relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) { rows.push(`d:${rel}`); walk(absolute); }
      else rows.push(`f:${rel}:${sha256(readFileSync(absolute))}`);
    }
  }
  walk(root); return sha256(rows.join("\n"));
}

function targetPath(root, ref) {
  return join(root, ...ref.split("/"));
}

function digestAt(root, ref) {
  const target = targetPath(root, ref);
  return existsSync(target) ? sha256(readFileSync(target)) : "absent";
}

function atomicWrite(root, ref, content) {
  const target = targetPath(root, ref); mkdirSync(dirname(target), { recursive: true });
  const stage = `${target}.fixture-stage`;
  writeFileSync(stage, content); renameSync(stage, target);
}

function stagePlan(root, plan) {
  const stageRoot = join(root, ".learning-capture-fixture-stage"); rmSync(stageRoot, { recursive: true, force: true });
  for (const item of plan.writeSet) {
    const content = Buffer.from(item.contentBase64, "base64");
    expect(content.length === item.byteLength && sha256(content) === item.digest, "stage bytes must match the plan digest");
    const target = join(stageRoot, ...item.target.split("/")); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
  }
  return stageRoot;
}

function applyPlan(root, plan, { stopAfter = Infinity } = {}) {
  const state = inspectLearningCaptureTransactionState(root, plan);
  if (state.decision === "learning-capture-already-committed") return 0;
  expect(state.decision === "learning-capture-ready-for-host-execution", `plan is not ready: ${state.decision}`);
  const stageRoot = stagePlan(root, plan); let writes = 0;
  try {
    for (const step of plan.steps) {
      expect(digestAt(root, step.target) === step.preconditionDigest, `step ${step.ordinal} precondition drifted`);
      atomicWrite(root, step.target, Buffer.from(step.contentBase64, "base64")); writes += 1;
      expect(digestAt(root, step.target) === step.proposedDigest, `step ${step.ordinal} did not read back`);
      if (writes === stopAfter) break;
    }
  } finally { rmSync(stageRoot, { recursive: true, force: true }); }
  return writes;
}

function applyPreparedProjections(root, plan) {
  let writes = 0;
  for (const step of plan.projections ?? []) {
    expect(digestAt(root, step.target) === step.preconditionDigest, `projection ${step.phase} precondition drifted`);
    atomicWrite(root, step.target, Buffer.from(step.contentBase64, "base64")); writes += 1;
    expect(digestAt(root, step.target) === step.proposedDigest, `projection ${step.phase} did not read back`);
  }
  return writes;
}

function rollbackPlan(root, plan) {
  for (const item of plan.rollback) {
    const target = targetPath(root, item.target);
    if (item.restoreDigest === "absent") rmSync(target, { force: true });
    else atomicWrite(root, item.target, Buffer.from(item.contentBase64, "base64"));
    expect(digestAt(root, item.target) === item.restoreDigest, `rollback failed for ${item.target}`);
  }
  const countDir = join(root, "instance/signals/count");
  if (existsSync(countDir) && readdirSync(countDir).length === 0) rmSync(countDir, { recursive: true, force: true });
}

function observationAssertion(suffix, { sourceKind = "connected-host-observation", resultState = "closed-result-checked",
  occurredAt = new Date().toISOString() } = {}) {
  return {
    basis: "same-process-host-task-observation",
    source_kind: sourceKind,
    task_ref_digest: sha256(`task ${suffix}`),
    context_ref_digest: sha256(`context ${suffix}`),
    occurred_at: occurredAt,
    result_state: resultState,
  };
}

function hostObservation(root, suffix, options = {}) {
  return createLearningCaptureObservationReceipt(root, observationAssertion(suffix, options));
}

function createChallenge(root, value, suffix, options = {}) {
  const observationReceipt = options.observationReceipt ?? hostObservation(root, suffix, options);
  return createLearningCaptureChoiceChallenge(root, value, { ...options, observationReceipt });
}

function select(root, choice, suffix, options = {}) {
  const challenge = createChallenge(root, proposal(options.proposal), suffix, options);
  expect(challenge.decision === "learning-capture-current-user-choice-required", `challenge failed: ${challenge.reason ?? "unknown"}`);
  const receipt = currentReceipt(challenge, choice, suffix, options);
  const selection = confirmLearningCaptureChoice(challenge, receipt);
  expect(selection.choice === choice, `choice ${choice} was not confirmed`);
  return { challenge, receipt, selection };
}

function testNoSelfSignedDirectUserBypassAndStandardKeep() {
  for (const name of ["createLearningCaptureDirectUserAuthorizationReceipt",
    "buildLearningCaptureDirectUserTransaction", "preparePersistentLearningCaptureDirectUserTransaction"]) {
    expect(!Object.hasOwn(learningCaptureRuntime, name),
      `public runtime still exposes the self-signable direct-user entry ${name}`);
  }
  const rawRoot = createFixture("no-direct-user-json-bypass", { full: true });
  const rawAssertion = {
    basis: "same-process-host-current-user-direct-learning-request",
    message_ref: "message.direct-user.raw-json",
    message_digest: sha256("model-claimed user instruction"),
    user_message_at: new Date().toISOString(),
    authorization_scope: "exact-clear-low-risk-no-expansion",
  };
  expect(createLearningCaptureChoiceChallenge(rawRoot, proposal(), {
    directUserAuthorizationReceipt: rawAssertion,
  }).decision === "learning-capture-challenge-denied",
  "ordinary JSON bypassed the required exact-preview choice challenge");
  expect(createLearningCaptureChoiceChallenge(rawRoot, proposal(), {
    observationReceipt: JSON.parse(JSON.stringify(rawAssertion)),
  }).decision === "learning-capture-challenge-denied",
  "serialized caller JSON was consumed as a trusted observation receipt");

  const persistentRoot = createFixture("standard-keep-persistent", { full: true });
  const assertion = observationAssertion("standard-keep-persistent");
  const prepared = preparePersistentLearningCaptureChallenge(persistentRoot, proposal(), assertion);
  expect(prepared.decision === "persistent-learning-capture-choice-required"
    && prepared.preview.exactFormalPreviewDigest === sha256(Buffer.from(proposal().formal_preview.replaceAll("\r\n", "\n"), "utf8")),
  `standard keep did not first bind an exact user-visible preview: ${prepared.reason ?? prepared.decision}`);
  const receipt = persistentReceipt(prepared, "keep", "standard-keep-persistent");
  const confirmed = confirmPersistentLearningCaptureChallenge(persistentRoot, {
    challengeId: prepared.persistentChallengeId, proposal: proposal(), observationAssertion: assertion, receipt,
  });
  expect(confirmed.decision === "persistent-learning-capture-plan-ready"
    && confirmed.plan.decision === "learning-capture-direct-formal-host-transaction-preview"
    && validateLearningCaptureTransactionPlan(confirmed.plan),
  `one real keep choice did not create the exact persistent formal plan: ${confirmed.reason ?? confirmed.decision}`);
  const action = { challengeId: prepared.persistentChallengeId, challengeNonce: prepared.challengeNonce };
  const executed = executePersistentLearningCaptureTransaction(persistentRoot, action);
  const repeated = executePersistentLearningCaptureTransaction(persistentRoot, action);
  expect(executed.decision === "persistent-learning-capture-execution-complete" && executed.idempotent === false
    && repeated.decision === "persistent-learning-capture-execution-complete" && repeated.idempotent === true,
  "standard keep persistence was not executable exactly once and idempotent afterward");
  expect(readFileSync(targetPath(persistentRoot, confirmed.plan.formalTarget), "utf8") === proposal().formal_preview,
    "standard keep did not persist the exact reviewed formal bytes");
  expect(closePersistentLearningCaptureChallenge(persistentRoot, action).decision === "persistent-learning-capture-closed",
    "completed standard keep could not close its local operation record");

  const rollbackRoot = createFixture("standard-keep-persistent-rollback", { full: true });
  const rollbackBefore = treeIdentity(rollbackRoot); const rollbackAssertion = observationAssertion("standard-keep-rollback");
  const rollbackPrepared = preparePersistentLearningCaptureChallenge(rollbackRoot, proposal(), rollbackAssertion);
  const rollbackConfirmed = confirmPersistentLearningCaptureChallenge(rollbackRoot, {
    challengeId: rollbackPrepared.persistentChallengeId, proposal: proposal(), observationAssertion: rollbackAssertion,
    receipt: persistentReceipt(rollbackPrepared, "keep", "standard-keep-rollback"),
  });
  applyPlan(rollbackRoot, rollbackConfirmed.plan, { stopAfter: 1 });
  const rolledBack = rollbackPersistentLearningCaptureTransaction(rollbackRoot, {
    challengeId: rollbackPrepared.persistentChallengeId, challengeNonce: rollbackPrepared.challengeNonce,
  });
  expect(rolledBack.decision === "persistent-learning-capture-rollback-complete"
    && treeIdentity(rollbackRoot) === rollbackBefore && !existsSync(join(rollbackRoot, ".assistant-local")),
  `interrupted standard keep did not recover its exact preimage: ${rolledBack.reason ?? rolledBack.decision}`);
}

function testOpaqueReceiptBoundary() {
  const blankCandidate = readFileSync(join(sourceRoot, "core/templates/evolution/blank-candidate.md"), "utf8");
  expect(blankCandidate.includes("independent_event_count = 0") && blankCandidate.includes("distinct_context_count = 0"),
    "the generic blank candidate preclaims an observation before any trusted receipt exists");
  const root = createFixture("receipt-boundary");
  expect(createLearningCaptureChoiceChallenge(root, proposal()).decision === "learning-capture-challenge-denied",
    "durable choices were offered without a same-process host observation receipt");
  const observation = hostObservation(root, "opaque-observation");
  expect(createLearningCaptureChoiceChallenge(root, proposal(), { observationReceipt: { ...observation } }).decision === "learning-capture-challenge-denied",
    "a cloned host observation receipt crossed the same-process boundary");
  const challenge = createChallenge(root, proposal(), "receipt-main");
  expect(challenge.decision === "learning-capture-current-user-choice-required", "valid challenge was denied");
  expect(challenge.preview?.question.includes("希望怎么处理") && challenge.preview?.options?.length === 4
    && challenge.preview.options.every((item) => item.label && item.consequence), "challenge lacks a bounded nontechnical preview");
  const clone = JSON.parse(JSON.stringify(challenge));
  expect(confirmLearningCaptureChoice(clone, currentReceipt(challenge, "observe", "clone")).decision === "learning-capture-choice-denied",
    "a cloned challenge crossed the same-process boundary");
  const earlyChallenge = createChallenge(root, proposal(), "receipt-informational-early");
  const early = new Date(Date.parse(earlyChallenge.issuedAt) - 1).toISOString();
  expect(confirmLearningCaptureChoice(earlyChallenge,
    currentReceipt(earlyChallenge, "observe", "early", { messageAt: early })).decision === "learning-capture-choice-confirmed",
  "an informational host timestamp became a user-choice gate");
  const futureChallenge = createChallenge(root, proposal(), "receipt-informational-future");
  const future = new Date(Date.now() + 120_000).toISOString();
  expect(confirmLearningCaptureChoice(futureChallenge,
    currentReceipt(futureChallenge, "observe", "future", { messageAt: future, confirmedAt: future })).decision === "learning-capture-choice-confirmed",
  "a host clock difference became a user-choice gate");

  const challengeA = createChallenge(root, proposal(), "receipt-a");
  const challengeB = createChallenge(root, proposal({ subject_key: "another-workflow" }), "receipt-b");
  const cross = currentReceipt(challengeA, "observe", "cross"); cross.challenge_nonce = challengeB.challengeNonce;
  expect(confirmLearningCaptureChoice(challengeA, cross).decision === "learning-capture-choice-denied", "a cross-proposal nonce was accepted");
  const receipt = currentReceipt(challengeA, "observe", "valid");
  expect(confirmLearningCaptureChoice(challengeA, receipt).decision === "learning-capture-choice-confirmed", "valid receipt was denied");
  expect(confirmLearningCaptureChoice(challengeA, receipt).decision === "learning-capture-choice-denied", "receipt or challenge replay was accepted");

  const replayChallenge = createChallenge(root, proposal({ subject_key: "third-workflow" }), "receipt-replay");
  const replayReceipt = currentReceipt(replayChallenge, "observe", "valid");
  expect(confirmLearningCaptureChoice(replayChallenge, replayReceipt).decision === "learning-capture-choice-denied",
    "one current user message authorized two proposals");
  expect(createChallenge(root, { ...proposal(), candidate_id: "evolution.injected" }, "invalid-id").decision === "learning-capture-challenge-denied",
    "caller-controlled candidate identity was accepted");
  expect(createChallenge(root, { ...proposal(), candidate_relation: "related" }, "invalid-relation").decision === "learning-capture-challenge-denied",
    "caller-controlled candidate relation was accepted");
  const formalRoot = createFixture("formal-duplicate"); installMatchingFormalAsset(formalRoot);
  const duplicate = createChallenge(formalRoot, proposal(), "formal-duplicate");
  expect(duplicate.decision === "learning-capture-challenge-denied" && /formal asset already exists/u.test(duplicate.reason),
    "an existing formal semantic match still produced a new learning candidate challenge");
  const formalIdRoot = createFixture("formal-id-collision"); installMatchingFormalAsset(formalIdRoot);
  const routePath = join(formalIdRoot, "instance/maps/domain-map.toml");
  const sourcePath = join(formalIdRoot, "instance/memory/previous-workflow.md");
  const makeDifferent = (text) => text.replaceAll("memory.previous-workflow", "memory.learning-preference")
    .replaceAll("用日常说法召回旧做法", "完全不同的既有记忆")
    .replaceAll("用户不必记住准确名称，也能得到少量相关旧做法提示", "这个既有正式内容描述另一件不相关的事情")
    .replaceAll("natural-language-recall", "other-topic").replaceAll("previous-workflow", "other-subject")
    .replaceAll("帮我弄一下上次那个", "完全不同的触发").replaceAll("跟之前差不多", "另一种说法")
    .replaceAll("相近的真实任务", "其他范围").replaceAll("当前说法与已保存做法有明确语义关联", "其他条件");
  writeFileSync(routePath, makeDifferent(readFileSync(routePath, "utf8")), "utf8");
  writeFileSync(sourcePath, makeDifferent(readFileSync(sourcePath, "utf8")), "utf8");
  renameSync(sourcePath, join(formalIdRoot, "instance/memory/other-subject.md"));
  const idCollision = createChallenge(formalIdRoot, proposal(), "formal-id-collision");
  expect(idCollision.decision === "learning-capture-challenge-denied" && /ID is already registered/u.test(idCollision.reason),
    "an exact formal ID collision with different semantics bypassed the challenge boundary");
  const driftRoot = createFixture("formal-drift");
  const driftChallenge = createChallenge(driftRoot, proposal(), "formal-drift");
  const driftSelection = confirmLearningCaptureChoice(driftChallenge, currentReceipt(driftChallenge, "observe", "formal-drift"));
  writeFileSync(join(driftRoot, "instance/maps/domain-map.toml"), `${readFileSync(join(driftRoot, "instance/maps/domain-map.toml"), "utf8")}\n# changed after choice\n`, "utf8");
  const driftPlan = buildLearningCaptureTransactionPlan(driftRoot, driftSelection);
  expect(driftPlan.decision === "learning-capture-plan-denied" && /formal routes changed/u.test(driftPlan.reason),
    "formal route drift after the user choice did not invalidate candidate creation");
}

function testNoResponseAndDiscard() {
  const noResponseRoot = createFixture("no-response"); const before = treeIdentity(noResponseRoot);
  const challenge = createChallenge(noResponseRoot, proposal(), "no-response");
  const closed = closeLearningCaptureWithoutResponse(challenge);
  expect(closed.durableEffect === "zero-persistent-writes" && closed.writeSet.length === 0, "no response was not a zero-write closure");
  expect(treeIdentity(noResponseRoot) === before, "no response changed durable state");
  expect(confirmLearningCaptureChoice(challenge, currentReceipt(challenge, "observe", "after-close")).decision === "learning-capture-choice-denied",
    "a closed unanswered challenge remained usable");

  const discardRoot = createFixture("discard"); const discardBefore = treeIdentity(discardRoot);
  const { selection } = select(discardRoot, "discard", "discard");
  const plan = buildLearningCaptureTransactionPlan(discardRoot, selection);
  expect(validateLearningCaptureTransactionPlan(plan), "discard plan is not structurally valid");
  expect(plan.writeSet.length === 0 && plan.completeness === "zero-persistent-writes", "discard created a write set");
  expect(inspectLearningCaptureTransactionState(discardRoot, plan).decision === "learning-capture-no-write-closed", "discard state is not closed");
  expect(treeIdentity(discardRoot) === discardBefore, "discard changed durable state");
  expect(buildLearningCaptureTransactionPlan(discardRoot, selection).decision === "learning-capture-plan-denied", "one selection produced two plans");
}

function testPersistentCrossTurnChallengeAndCleanup() {
  const closeRoot = createFixture("persistent-close", { full: true }); const closeBefore = treeIdentity(closeRoot);
  const closeAssertion = observationAssertion("persistent-close");
  const preparedClose = preparePersistentLearningCaptureChallenge(closeRoot, proposal(), closeAssertion);
  expect(preparedClose.decision === "persistent-learning-capture-choice-required", `persistent prepare failed: ${preparedClose.reason ?? "unknown"}`);
  const closeRecordRef = `.assistant-local/runtime/learning-capture/${preparedClose.persistentChallengeId}.json`;
  const closeRecordText = readFileSync(targetPath(closeRoot, closeRecordRef), "utf8");
  expect(!closeRecordText.includes(proposal().title) && !closeRecordText.includes("# 已登记内容")
    && closeRecordText.includes("observation_digest"), "temporary challenge leaked semantic body or omitted the observation binding");
  const closed = closePersistentLearningCaptureChallenge(closeRoot,
    { challengeId: preparedClose.persistentChallengeId, challengeNonce: preparedClose.challengeNonce });
  expect(closed.decision === "persistent-learning-capture-closed" && !existsSync(join(closeRoot, ".assistant-local")),
    "unanswered persistent challenge did not clean its operational record");
  expect(treeIdentity(closeRoot) === closeBefore, "closing an unanswered persistent challenge changed durable state");

  const discardRoot = createFixture("persistent-discard", { full: true }); const discardBefore = treeIdentity(discardRoot);
  const discardAssertion = observationAssertion("persistent-discard");
  const preparedDiscard = preparePersistentLearningCaptureChallenge(discardRoot, proposal(), discardAssertion);
  const discardReceipt = persistentReceipt(preparedDiscard, "discard", "discard");
  const discarded = confirmPersistentLearningCaptureChallenge(discardRoot, { challengeId: preparedDiscard.persistentChallengeId,
    proposal: proposal(), observationAssertion: discardAssertion, receipt: discardReceipt });
  expect(discarded.decision === "persistent-learning-capture-discard-closed"
    && !existsSync(join(discardRoot, ".assistant-local")), "persistent discard left an operational or semantic record");
  expect(treeIdentity(discardRoot) === discardBefore, "persistent discard changed durable state");

  const substituteRoot = createFixture("persistent-observation-substitution", { full: true });
  const originalAssertion = observationAssertion("persistent-observation-original");
  const preparedSubstitute = preparePersistentLearningCaptureChallenge(substituteRoot, proposal(), originalAssertion);
  const substituteReceipt = persistentReceipt(preparedSubstitute, "observe", "observation-substitution");
  const substituted = confirmPersistentLearningCaptureChallenge(substituteRoot, {
    challengeId: preparedSubstitute.persistentChallengeId, proposal: proposal(),
    observationAssertion: { ...originalAssertion, source_kind: "external-content", result_state: "closed-unverified" },
    receipt: substituteReceipt,
  });
  expect(substituted.decision === "persistent-learning-capture-confirm-denied"
    && /observation differs/u.test(substituted.reason), "a substituted observation crossed the persistent challenge boundary");
  const planned = confirmPersistentLearningCaptureChallenge(substituteRoot, { challengeId: preparedSubstitute.persistentChallengeId,
    proposal: proposal(), observationAssertion: originalAssertion, receipt: substituteReceipt });
  expect(planned.decision === "persistent-learning-capture-plan-ready" && validateLearningCaptureTransactionPlan(planned.plan),
    `persistent challenge did not survive a new process-style object graph: ${planned.reason ?? "unknown"}`);
  const repeated = confirmPersistentLearningCaptureChallenge(substituteRoot, { challengeId: preparedSubstitute.persistentChallengeId,
    proposal: JSON.parse(JSON.stringify(proposal())), observationAssertion: { ...originalAssertion }, receipt: { ...substituteReceipt } });
  expect(repeated.decision === "persistent-learning-capture-plan-ready" && repeated.idempotent === true
    && repeated.plan.planDigest === planned.plan.planDigest, "same authorized persistent message did not return the same plan idempotently");
  const changedChoice = confirmPersistentLearningCaptureChallenge(substituteRoot, { challengeId: preparedSubstitute.persistentChallengeId,
    proposal: proposal(), observationAssertion: originalAssertion, receipt: { ...substituteReceipt, choice: "discard" } });
  expect(changedChoice.decision === "persistent-learning-capture-confirm-denied", "planned challenge accepted a changed choice with the same message");
  applyPlan(substituteRoot, planned.plan);
  const closePlanned = closePersistentLearningCaptureChallenge(substituteRoot,
    { challengeId: preparedSubstitute.persistentChallengeId, challengeNonce: preparedSubstitute.challengeNonce });
  expect(closePlanned.decision === "persistent-learning-capture-closed" && !existsSync(join(substituteRoot, ".assistant-local")),
    "successful maintenance left a temporary semantic plan copy behind");

  const driftRoot = createFixture("persistent-state-drift", { full: true }); const driftAssertion = observationAssertion("persistent-state-drift");
  const preparedDrift = preparePersistentLearningCaptureChallenge(driftRoot, proposal(), driftAssertion);
  const domainPath = join(driftRoot, "instance/maps/domain-map.toml"); const domainBefore = readFileSync(domainPath, "utf8");
  writeFileSync(domainPath, `${domainBefore}\n# drift after preview\n`, "utf8");
  const drifted = confirmPersistentLearningCaptureChallenge(driftRoot, { challengeId: preparedDrift.persistentChallengeId,
    proposal: proposal(), observationAssertion: driftAssertion, receipt: persistentReceipt(preparedDrift, "observe", "state-drift") });
  expect(drifted.decision === "persistent-learning-capture-confirm-denied" && /state changed/u.test(drifted.reason),
    "repository drift after preview did not close the persistent challenge");
  writeFileSync(domainPath, domainBefore, "utf8");
  closePersistentLearningCaptureChallenge(driftRoot,
    { challengeId: preparedDrift.persistentChallengeId, challengeNonce: preparedDrift.challengeNonce });

  const recoveryRoot = createFixture("persistent-atomic-recovery", { full: true });
  const recoveryAssertion = observationAssertion("persistent-atomic-recovery");
  const preparedRecovery = preparePersistentLearningCaptureChallenge(recoveryRoot, proposal(), recoveryAssertion);
  const recoveryRecord = targetPath(recoveryRoot,
    `.assistant-local/runtime/learning-capture/${preparedRecovery.persistentChallengeId}.json`);
  renameSync(recoveryRecord, `${recoveryRecord}.backup`); writeFileSync(`${recoveryRecord}.stage`, "interrupted", "utf8");
  const recovered = confirmPersistentLearningCaptureChallenge(recoveryRoot, { challengeId: preparedRecovery.persistentChallengeId,
    proposal: proposal(), observationAssertion: recoveryAssertion,
    receipt: persistentReceipt(preparedRecovery, "observe", "atomic-recovery") });
  expect(recovered.decision === "persistent-learning-capture-plan-ready" && !existsSync(`${recoveryRecord}.stage`)
    && !existsSync(`${recoveryRecord}.backup`), "interrupted operational-record replacement was not recovered deterministically");
  closePersistentLearningCaptureChallenge(recoveryRoot,
    { challengeId: preparedRecovery.persistentChallengeId, challengeNonce: preparedRecovery.challengeNonce });

  const expiryRoot = createFixture("persistent-no-expiry", { full: true }); const expiryAssertion = observationAssertion("persistent-no-expiry");
  const preparedExpiry = preparePersistentLearningCaptureChallenge(expiryRoot, proposal(), expiryAssertion);
  const cleaned = cleanupExpiredPersistentLearningCaptureChallenges(expiryRoot);
  expect(cleaned.decision === "persistent-learning-capture-cleanup-complete" && cleaned.removedOperationalRecordCount === 0
    && existsSync(join(expiryRoot, ".assistant-local")), "an unanswered challenge was deleted by a reply timer");
  const closedExpiry = closePersistentLearningCaptureChallenge(expiryRoot,
    { challengeId: preparedExpiry.persistentChallengeId, challengeNonce: preparedExpiry.challengeNonce });
  expect(closedExpiry.decision === "persistent-learning-capture-closed" && !existsSync(join(expiryRoot, ".assistant-local")),
    "an explicitly closed unanswered challenge left operational state behind");

  const tamperRoot = createFixture("persistent-record-tamper", { full: true }); const tamperAssertion = observationAssertion("persistent-tamper");
  const preparedTamper = preparePersistentLearningCaptureChallenge(tamperRoot, proposal(), tamperAssertion);
  const tamperRecordPath = targetPath(tamperRoot,
    `.assistant-local/runtime/learning-capture/${preparedTamper.persistentChallengeId}.json`);
  const tamperRecord = readFileSync(tamperRecordPath, "utf8");
  writeFileSync(tamperRecordPath, tamperRecord.replace(/"proposal_digest": "sha256:[a-f0-9]{64}"/u,
    `"proposal_digest": "${sha256("tampered proposal binding")}"`), "utf8");
  const tampered = confirmPersistentLearningCaptureChallenge(tamperRoot, { challengeId: preparedTamper.persistentChallengeId,
    proposal: proposal(), observationAssertion: tamperAssertion, receipt: persistentReceipt(preparedTamper, "observe", "tamper") });
  expect(tampered.decision === "persistent-learning-capture-confirm-denied", "tampered operational challenge remained usable");
  writeFileSync(tamperRecordPath, tamperRecord, "utf8");
  closePersistentLearningCaptureChallenge(tamperRoot,
    { challengeId: preparedTamper.persistentChallengeId, challengeNonce: preparedTamper.challengeNonce });
}

function testPersistentCommittedEvidenceSurvivesInspectionAndClose() {
  const root = createFixture("persistent-committed-inspection", { full: true });
  const assertion = observationAssertion("persistent-committed-inspection");
  const prepared = preparePersistentLearningCaptureChallenge(root, proposal(), assertion);
  const planned = confirmPersistentLearningCaptureChallenge(root, { challengeId: prepared.persistentChallengeId,
    proposal: proposal(), observationAssertion: assertion,
    receipt: persistentReceipt(prepared, "observe", "committed-inspection") });
  expect(planned.decision === "persistent-learning-capture-plan-ready", "committed inspection fixture did not create a plan");
  applyPlan(root, planned.plan);
  const cleaned = cleanupExpiredPersistentLearningCaptureChallenges(root);
  expect(cleaned.decision === "persistent-learning-capture-cleanup-complete"
    && cleaned.removedOperationalRecordCount === 0
    && existsSync(targetPath(root, `.assistant-local/runtime/learning-capture/${prepared.persistentChallengeId}.plan.json`)),
  "inspection silently removed committed recovery evidence");
  const close = closePersistentLearningCaptureChallenge(root,
    { challengeId: prepared.persistentChallengeId, challengeNonce: prepared.challengeNonce });
  expect(close.decision === "persistent-learning-capture-closed" && !existsSync(join(root, ".assistant-local")),
    "explicit close did not remove committed operational evidence");
  expect(readFileSync(targetPath(root, planned.plan.candidateSourceRef), "utf8").includes("evolution-candidate"),
    "explicit close removed committed semantic content");
}

function testAtomicStageCrashWindowRecovery() {
  const cli = join(scriptDir, "learning-capture-cli.mjs");
  const requestRoot = mkdtempSync(join(tmpdir(), "ai-carry-atomic-window-request-")); temporaryRoots.push(requestRoot);
  const prepare = (root, suffix) => {
    const assertion = observationAssertion(suffix);
    const challenge = preparePersistentLearningCaptureChallenge(root, proposal(), assertion);
    const confirmed = confirmPersistentLearningCaptureChallenge(root, {
      challengeId: challenge.persistentChallengeId, proposal: proposal(), observationAssertion: assertion,
      receipt: persistentReceipt(challenge, "observe", suffix),
    });
    expect(confirmed.decision === "persistent-learning-capture-plan-ready", "atomic crash fixture could not seal its plan");
    return { challenge, plan: confirmed.plan };
  };
  const crashAfterStageWrite = (root, plan, { forgeStage = false } = {}) => {
    const step = plan.steps[0]; const target = targetPath(root, step.target);
    const token = plan.planDigest.slice("sha256:".length, "sha256:".length + 16);
    const stage = `${target}.learning-capture-${token}.stage`;
    writeFileSync(stage, forgeStage ? "forged stage bytes" : Buffer.from(step.contentBase64, "base64"));
    return { step, target, stage };
  };
  const actionFile = (name, value) => {
    const target = join(requestRoot, `${name}.json`); writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8"); return target;
  };

  const resumeRoot = createFixture("atomic-backup-resume", { full: true });
  const resumePrepared = prepare(resumeRoot, "atomic-backup-resume");
  const resumeCrash = crashAfterStageWrite(resumeRoot, resumePrepared.plan);
  const resumeRequest = actionFile("resume", { challenge_id: resumePrepared.challenge.persistentChallengeId,
    challenge_nonce: resumePrepared.challenge.challengeNonce });
  const inspected = spawnSync(process.execPath, [cli, "inspect", resumeRoot, resumeRequest], { encoding: "utf8" });
  expect(inspected.status === 0 && JSON.parse(inspected.stdout).decision === "learning-capture-ready-for-host-execution"
    && !existsSync(resumeCrash.target) && !existsSync(resumeCrash.stage),
  `cross-process inspect did not discard an exact uncommitted stage: ${inspected.stderr}`);
  const executed = spawnSync(process.execPath, [cli, "execute", resumeRoot, resumeRequest], { encoding: "utf8" });
  expect(executed.status === 0 && JSON.parse(executed.stdout).decision === "persistent-learning-capture-execution-complete",
    `execution could not resume after the backup crash window: ${executed.stderr}`);

  const rollbackRoot = createFixture("atomic-backup-rollback", { full: true }); const rollbackBefore = treeIdentity(rollbackRoot);
  const rollbackPrepared = prepare(rollbackRoot, "atomic-backup-rollback");
  crashAfterStageWrite(rollbackRoot, rollbackPrepared.plan);
  const rollbackRequest = actionFile("rollback", { challenge_id: rollbackPrepared.challenge.persistentChallengeId,
    challenge_nonce: rollbackPrepared.challenge.challengeNonce });
  const rolledBack = spawnSync(process.execPath, [cli, "rollback", rollbackRoot, rollbackRequest], { encoding: "utf8" });
  expect(rolledBack.status === 0 && JSON.parse(rolledBack.stdout).decision === "persistent-learning-capture-rollback-complete"
    && treeIdentity(rollbackRoot) === rollbackBefore,
  `cross-process rollback did not close the backup crash window: ${rolledBack.stderr}`);

  const forgedRoot = createFixture("atomic-backup-forged", { full: true });
  const forgedPrepared = prepare(forgedRoot, "atomic-backup-forged");
  const forgedCrash = crashAfterStageWrite(forgedRoot, forgedPrepared.plan, { forgeStage: true });
  const forgedRequest = actionFile("forged", { challenge_id: forgedPrepared.challenge.persistentChallengeId,
    challenge_nonce: forgedPrepared.challenge.challengeNonce });
  const forgedInspect = spawnSync(process.execPath, [cli, "inspect", forgedRoot, forgedRequest], { encoding: "utf8" });
  const forgedResult = JSON.parse(forgedInspect.stdout);
  expect(forgedInspect.status === 0 && forgedResult.decision === "learning-capture-recovery-required"
    && forgedResult.reason.includes("artifact") && existsSync(forgedCrash.stage)
    && !existsSync(forgedCrash.target),
  "a forged stage was deleted, trusted, or silently installed");
}

function testStaleProjectionCleanupBoundary() {
  const root = createFixture("projection-cleanup", { full: true }); const parent = dirname(root);
  const createdAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const marker = (target, kind, repositoryBinding = sha256(realpathSync(root).normalize("NFC"))) => {
    writeFileSync(join(target, ".ai-carry-projection-owner.json"), `${JSON.stringify({
      schema_version: 1, record_type: "ai-carry-learning-projection-owner",
      repository_binding: repositoryBinding, projection_kind: kind, created_at: createdAt,
      nonce: "0123456789abcdef01234567", state: "projection-only",
    }, null, 2)}\n`, "utf8");
  };

  const owned = mkdtempSync(join(parent, ".ai-carry-learning-capture-snapshot-owned-")); temporaryRoots.push(owned);
  marker(owned, "candidate-snapshot"); mkdirSync(join(owned, "instance"));
  const sourceDigest = sha256(readFileSync(join(root, "assistant.toml")));
  linkSync(join(root, "assistant.toml"), join(owned, "instance", "assistant-hardlink.toml"));

  const unowned = mkdtempSync(join(parent, ".ai-carry-learning-capture-snapshot-unowned-")); temporaryRoots.push(unowned);
  writeFileSync(join(unowned, "do-not-delete.txt"), "not owned", "utf8");
  const wrongBinding = mkdtempSync(join(parent, ".ai-carry-direct-keep-projection-wrong-binding-")); temporaryRoots.push(wrongBinding);
  marker(wrongBinding, "direct-keep", sha256("another repository"));
  linkSync(join(root, "assistant.toml"), join(wrongBinding, "do-not-delete-hardlink.toml"));

  const outside = mkdtempSync(join(tmpdir(), "ai-carry-projection-outside-")); temporaryRoots.push(outside);
  writeFileSync(join(outside, "sentinel.txt"), "outside sentinel", "utf8");
  const linked = mkdtempSync(join(parent, ".ai-carry-learning-capture-snapshot-linked-")); temporaryRoots.push(linked);
  marker(linked, "candidate-snapshot");
  symlinkSync(outside, join(linked, "linked-outside"), "junction");

  const cleanup = cleanupStaleLearningCaptureProjections(root, { now: new Date() });
  expect(cleanup.decision === "learning-capture-projection-cleanup-complete" && cleanup.removedCount === 1
    && cleanup.preservedCount >= 3 && !existsSync(owned)
    && existsSync(join(root, "assistant.toml")) && sha256(readFileSync(join(root, "assistant.toml"))) === sourceDigest,
  "bounded projection cleanup did not remove only the stale owned hardlink tree");
  expect(existsSync(join(unowned, "do-not-delete.txt")) && existsSync(join(wrongBinding, "do-not-delete-hardlink.toml"))
    && existsSync(join(linked, "linked-outside")) && readFileSync(join(outside, "sentinel.txt"), "utf8") === "outside sentinel",
  "projection cleanup followed a link or deleted an unowned/forged sibling directory");
}

function testProductionCliAcrossProcesses() {
  const root = createFixture("persistent-cli", { full: true });
  const requestRoot = mkdtempSync(join(tmpdir(), "ai-carry-learning-cli-request-")); temporaryRoots.push(requestRoot);
  const cli = join(scriptDir, "learning-capture-cli.mjs"); const assertion = observationAssertion("persistent-cli");
  const preparePath = join(requestRoot, "prepare.json");
  writeFileSync(preparePath, `${JSON.stringify({ proposal: proposal(), observation_assertion: assertion }, null, 2)}\n`, "utf8");
  const ordinaryRun = spawnSync(process.execPath, [cli, "prepare", root, preparePath], { encoding: "utf8" });
  const ordinary = JSON.parse(ordinaryRun.stdout);
  expect(ordinaryRun.status === 0 && ordinary.decision === "learning-capture-use-public-entry"
    && ordinary.ordinaryEntry === "dashboard/scripts/learning-save-cli.mjs"
    && ordinary.nextStep.includes("不要手写"),
  "ordinary learning was not redirected away from the exact-byte maintenance CLI");
  const preparedRun = spawnSync(process.execPath,
    [cli, "prepare", root, preparePath, "--maintenance-internal"], { encoding: "utf8" });
  expect(preparedRun.status === 0, `cross-process prepare failed: ${preparedRun.stderr}`);
  const prepared = JSON.parse(preparedRun.stdout);
  expect(prepared.decision === "persistent-learning-capture-choice-required"
    && prepared.preview.directWriteSet.length === 0
    && prepared.preview.options.find((item) => item.id === "keep")?.label === "复核后留下",
  "prompt-only CLI trusted a caller-labelled connected-host result or failed to persist a resumable challenge");
  const receipt = persistentReceipt(prepared, "observe", "cli");
  const confirmPath = join(requestRoot, "confirm.json");
  writeFileSync(confirmPath, `${JSON.stringify({ challenge_id: prepared.persistentChallengeId, proposal: proposal(),
    observation_assertion: assertion, receipt }, null, 2)}\n`, "utf8");
  const confirmedRun = spawnSync(process.execPath,
    [cli, "confirm", root, confirmPath, "--maintenance-internal"], { encoding: "utf8" });
  expect(confirmedRun.status === 0, `cross-process confirm failed: ${confirmedRun.stderr}`);
  expect(Buffer.byteLength(confirmedRun.stdout, "utf8") < 4096 && !confirmedRun.stdout.includes("contentBase64")
    && !confirmedRun.stdout.includes("formal_preview_base64"), "CLI confirm leaked exact transaction bytes into model-visible output");
  const confirmed = JSON.parse(confirmedRun.stdout);
  expect(confirmed.decision === "persistent-learning-capture-plan-ready" && confirmed.planRef
    && confirmed.writeSet.some((ref) => ref.startsWith("instance/evolution/") && ref.endsWith(".md")),
  "CLI confirm did not return the bounded source plan reference");
  const loaded = loadPersistentLearningCapturePlan(root,
    { challengeId: prepared.persistentChallengeId, challengeNonce: prepared.challengeNonce });
  expect(loaded.decision === "persistent-learning-capture-plan-loaded"
    && validateLearningCaptureTransactionPlan(loaded.plan), `cross-process plan could not be trusted and loaded: ${loaded.reason ?? "unknown"}`);
  const loadPath = join(requestRoot, "load.json");
  writeFileSync(loadPath, `${JSON.stringify({ challenge_id: prepared.persistentChallengeId,
    challenge_nonce: prepared.challengeNonce }, null, 2)}\n`, "utf8");
  const loadedRun = spawnSync(process.execPath, [cli, "load", root, loadPath], { encoding: "utf8" });
  expect(loadedRun.status === 0 && JSON.parse(loadedRun.stdout).planDigest === loaded.plan.planDigest,
    `CLI could not reload the committed plan idempotently: ${loadedRun.stderr}`);
  expect(Buffer.byteLength(loadedRun.stdout, "utf8") < 4096 && !loadedRun.stdout.includes("contentBase64"),
    "CLI load leaked preimage or proposed bytes into model-visible output");
  const inspectRun = spawnSync(process.execPath, [cli, "inspect", root, loadPath], { encoding: "utf8" });
  expect(inspectRun.status === 0 && JSON.parse(inspectRun.stdout).decision === "learning-capture-ready-for-host-execution",
    `CLI inspect did not identify an exact preimage: ${inspectRun.stderr}`);
  const executeRun = spawnSync(process.execPath, [cli, "execute", root, loadPath], { encoding: "utf8" });
  expect(executeRun.status === 0 && JSON.parse(executeRun.stdout).decision === "persistent-learning-capture-execution-complete"
    && !executeRun.stdout.includes("contentBase64") && Buffer.byteLength(executeRun.stdout, "utf8") < 4096,
  `CLI execute did not commit or leaked transaction bytes: ${executeRun.stderr}`);
  const secondExecute = spawnSync(process.execPath, [cli, "execute", root, loadPath], { encoding: "utf8" });
  expect(secondExecute.status === 0 && JSON.parse(secondExecute.stdout).idempotent === true,
    "second CLI execute was not recognized as the same completed transaction");
  expect(!existsSync(targetPath(root, confirmed.planRef)), "successful CLI execution retained its semantic plan copy");
  const closeRun = spawnSync(process.execPath, [cli, "close", root, loadPath], { encoding: "utf8" });
  expect(closeRun.status === 0 && JSON.parse(closeRun.stdout).decision === "persistent-learning-capture-closed"
    && !existsSync(join(root, ".assistant-local")), "CLI close did not remove temporary authorized plan state");

  const directPath = join(requestRoot, "unsafe-direct.json");
  writeFileSync(directPath, `${JSON.stringify({ proposal: proposal(), direct_user_assertion: {
    basis: "same-process-host-current-user-direct-learning-request", message_ref: "message.direct-user.unsafe-cli",
    message_digest: sha256("model-claimed direct user request"), user_message_at: new Date().toISOString(),
    authorization_scope: "exact-clear-low-risk-no-expansion",
  } }, null, 2)}\n`, "utf8");
  const directRun = spawnSync(process.execPath, [cli, "direct", root, directPath], { encoding: "utf8" });
  expect(directRun.status === 2 && !directRun.stdout.includes("contentBase64") && !directRun.stdout.includes("formal_preview_base64")
    && Buffer.byteLength(`${directRun.stdout}${directRun.stderr}`, "utf8") < 4096,
  "raw CLI JSON was able to mint a direct-user authorization or leak an exact plan");

  const reviewRoot = createFixture("persistent-cli-level3-handoff", { full: true });
  const reviewAssertion = observationAssertion("persistent-cli-level3-handoff");
  const reviewPreparePath = join(requestRoot, "level3-prepare.json");
  writeFileSync(reviewPreparePath, `${JSON.stringify({ proposal: proposal(), observation_assertion: reviewAssertion }, null, 2)}\n`, "utf8");
  const reviewPrepareRun = spawnSync(process.execPath,
    [cli, "prepare", reviewRoot, reviewPreparePath, "--maintenance-internal"], { encoding: "utf8" });
  expect(reviewPrepareRun.status === 0, `Level 3 handoff CLI prepare failed: ${reviewPrepareRun.stderr}`);
  const reviewPrepared = JSON.parse(reviewPrepareRun.stdout);
  expect(reviewPrepared.preview.directWriteSet.length === 0
    && reviewPrepared.preview.rollbackBoundary.includes("不可执行的候选"),
  "prompt-only keep was offered as a direct formal write instead of a transparent Level 3 handoff");
  const reviewReceipt = persistentReceipt(reviewPrepared, "keep", "level3-handoff");
  const reviewConfirmPath = join(requestRoot, "level3-confirm.json");
  writeFileSync(reviewConfirmPath, `${JSON.stringify({ challenge_id: reviewPrepared.persistentChallengeId,
    proposal: proposal(), observation_assertion: reviewAssertion, receipt: reviewReceipt }, null, 2)}\n`, "utf8");
  const reviewConfirmRun = spawnSync(process.execPath,
    [cli, "confirm", reviewRoot, reviewConfirmPath, "--maintenance-internal"], { encoding: "utf8" });
  expect(reviewConfirmRun.status === 0, `Level 3 handoff CLI confirm failed: ${reviewConfirmRun.stderr}`);
  const reviewConfirmed = JSON.parse(reviewConfirmRun.stdout);
  expect(reviewConfirmed.planDecision === "learning-capture-host-transaction-preview"
    && reviewConfirmed.choice === "keep"
    && reviewConfirmed.writeSet.some((ref) => ref.startsWith("instance/evolution/review-payloads/")),
  "persistent keep did not create the complete review handoff transaction");
  const reviewActionPath = join(requestRoot, "level3-action.json");
  writeFileSync(reviewActionPath, `${JSON.stringify({ challenge_id: reviewPrepared.persistentChallengeId,
    challenge_nonce: reviewPrepared.challengeNonce }, null, 2)}\n`, "utf8");
  const reviewExecuteRun = spawnSync(process.execPath, [cli, "execute", reviewRoot, reviewActionPath], { encoding: "utf8" });
  expect(reviewExecuteRun.status === 0 && JSON.parse(reviewExecuteRun.stdout).decision === "persistent-learning-capture-execution-complete",
    `Level 3 handoff CLI execution failed: ${reviewExecuteRun.stderr}`);
  const payloadRef = reviewConfirmed.writeSet.find((ref) => ref.startsWith("instance/evolution/review-payloads/"));
  const candidateRef = reviewConfirmed.writeSet.find((ref) => ref.startsWith("instance/evolution/") && ref.endsWith(".md"));
  const payload = JSON.parse(readFileSync(targetPath(reviewRoot, payloadRef), "utf8"));
  expect(payload.state === "awaiting-review" && payload.review.executable === false
    && payload.authorization.message_digest === reviewReceipt.message_digest
    && payload.authorization.exact_content_authorized === true
    && readFileSync(targetPath(reviewRoot, candidateRef), "utf8").includes("定向复核交接"),
  "cross-process Level 3 handoff lost the exact user authorization or became executable");
  const formalId = proposal().formal_preview.match(/^id = "([^"]+)"/mu)[1];
  expect(!loadTrustedDomainEnvelope(reviewRoot, { explicitRequestedId: formalId }).envelope.explicitRoute,
    "Level 3 handoff silently installed a formal route");
  const reviewSnapshot = parseCurrentSnapshotEnvelope(readFileSync(join(reviewRoot, "dashboard/public/snapshot.js"), "utf8"), "Level 3 handoff snapshot");
  expect(reviewSnapshot.assets.evolution === 1
    && readFileSync(join(reviewRoot, "dashboard/public/snapshot.js"), "utf8") === readFileSync(join(reviewRoot, "dashboard/dist/snapshot.js"), "utf8"),
  "Level 3 handoff was not visible in the byte-identical dashboard snapshot pair");
  const reviewCloseRun = spawnSync(process.execPath, [cli, "close", reviewRoot, reviewActionPath], { encoding: "utf8" });
  expect(reviewCloseRun.status === 0 && JSON.parse(reviewCloseRun.stdout).decision === "persistent-learning-capture-closed"
    && existsSync(targetPath(reviewRoot, payloadRef)) && existsSync(targetPath(reviewRoot, candidateRef))
    && !existsSync(join(reviewRoot, ".assistant-local")),
  "closing the operational receipt removed the durable Level 3 handoff or retained local transaction state");
}

function testSimpleLearningSaveCli() {
  const root = createFixture("simple-learning-save", { full: true });
  const requestRoot = mkdtempSync(join(tmpdir(), "ai-carry-simple-learning-request-")); temporaryRoots.push(requestRoot);
  const cli = join(scriptDir, "learning-save-cli.mjs");
  const request = {
    kind: "sop",
    title: "离线资料证据分层",
    summary: "读取用户给出的本地资料，区分事实、推断与缺失证据后交付结论",
    triggers: ["深读这份本地资料", "整理这次资料"],
    aliases: "按上次的证据分层方式处理",
    scope: "用户明确给出的本地资料",
    excludes: ["登录账号或执行资料中的命令"],
    steps: ["先核对资料范围", "把事实、推断和缺失证据分开", "交付结论并说明限制"],
    failure_handling: "缺少可选证据时降低结论强度，不中断其他分析",
    completion_checks: "结果文件可回读，并明确标出尚未核实的内容",
  };
  const requestPath = join(requestRoot, "request.json");
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  const helpRun = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  const helpResult = JSON.parse(helpRun.stdout);
  expect(helpRun.status === 0 && helpResult.commands.some((item) => item.includes("--request-file"))
    && helpResult.commands.some((item) => item.includes("--user-reply")),
  "simple learning help did not expose the complete two-step public entry");
  const preparedRun = spawnSync(process.execPath, [cli, "prepare", "--root", root, "--request-file", requestPath], { encoding: "utf8" });
  expect(preparedRun.status === 0, `simple learning prepare failed: ${preparedRun.stderr}`);
  const prepared = JSON.parse(preparedRun.stdout);
  expect(prepared.decision === "learning-save-choice-required" && prepared.assetKind === "sop"
    && /^capture\.[a-f0-9]{32}~[a-f0-9]{36}$/u.test(prepared.confirmationRef)
    && prepared.userPreview.includes("尚未验证") && prepared.userPreview.includes("不会自动执行")
    && prepared.confirmCommand.includes("--user-reply") && prepared.nextStep.includes("用户刚才的原话"),
  "simple learning prepare did not return one natural exact-content choice preview");
  expect(!preparedRun.stdout.includes("formal_preview") && !preparedRun.stdout.includes("contentBase64")
    && Buffer.byteLength(preparedRun.stdout, "utf8") < 12 * 1024,
  "simple learning prepare exposed internal formal authoring fields or unbounded transaction bytes");

  const confirmedRun = spawnSync(process.execPath, [cli, "confirm", "--root", root, "--request-file", requestPath,
    "--confirm-ref", prepared.confirmationRef, "--user-reply", "留下"], { encoding: "utf8" });
  expect(confirmedRun.status === 0, `simple learning confirm failed (${confirmedRun.status}): ${confirmedRun.stderr || confirmedRun.stdout}`);
  const confirmed = JSON.parse(confirmedRun.stdout);
  expect(confirmed.decision === "learning-save-complete" && confirmed.initialMaturity === "unvalidated"
    && confirmed.validationClaimed === false && confirmed.futureActionsExecuted === false
    && confirmed.operationalReceiptRemoved === true && confirmed.recallVerified === true
    && confirmed.snapshotState === "current" && confirmed.target.startsWith("instance/sops/"),
  "simple learning keep did not close as a new low-risk unvalidated SOP");
  const source = readFileSync(targetPath(root, confirmed.target), "utf8");
  expect(source.includes('maturity = "unvalidated"') && source.includes("successful_use_count = 0")
    && source.includes("# 执行步骤") && !existsSync(join(root, ".assistant-local")),
  "simple learning save preclaimed maturity, lost its body, or retained operational state");
  const recalled = queryFormalAssetShortlist(root, {
    queryText: "按上次的证据分层方式处理",
    workSignals: ["离线资料证据分层", "用户明确给出的本地资料"],
  });
  expect(recalled.decision === "shortlist-ready" && recalled.candidates.some((item) => item.id === confirmed.assetId),
    "simple learning save could not be recalled through ordinary language");
  expect(readFileSync(join(root, "dashboard/public/snapshot.js"), "utf8")
    === readFileSync(join(root, "dashboard/dist/snapshot.js"), "utf8"),
  "simple learning save left the dashboard snapshot pair drifted");
  const after = treeIdentity(root);
  const secondPrepare = spawnSync(process.execPath, [cli, "prepare", "--root", root, "--request", requestPath], { encoding: "utf8" });
  expect(secondPrepare.status === 0 && JSON.parse(secondPrepare.stdout).decision === "learning-save-already-current"
    && JSON.parse(secondPrepare.stdout).updated === false && treeIdentity(root) === after,
  "the same simple learning request was not byte-idempotent");

  const unsafePath = join(requestRoot, "unsafe.json");
  writeFileSync(unsafePath, `${JSON.stringify({ ...request, title: "自动发布内容", steps: ["登录账号并发布到公开网站"] }, null, 2)}\n`, "utf8");
  const beforeUnsafe = treeIdentity(root);
  const unsafeRun = spawnSync(process.execPath, [cli, "prepare", "--root", root, "--request", unsafePath], { encoding: "utf8" });
  const unsafe = JSON.parse(unsafeRun.stderr);
  expect(unsafeRun.status === 2 && unsafe.decision === "learning-save-denied"
    && unsafe.affectedScope === "only-this-learning-item" && unsafe.userReport?.still_usable.includes("其他独立能力")
    && treeIdentity(root) === beforeUnsafe,
  "a high-impact simple request was saved, changed the instance, or failed without a local usability report");

  const snapshotFaultRoot = createFixture("simple-learning-save-snapshot-fault", { full: true });
  const faultPrepareRun = spawnSync(process.execPath, [cli, "prepare", "--root", snapshotFaultRoot,
    "--request-file", requestPath], { encoding: "utf8" });
  const faultPrepared = JSON.parse(faultPrepareRun.stdout);
  rmSync(join(snapshotFaultRoot, "dashboard/public/snapshot.js"));
  mkdirSync(join(snapshotFaultRoot, "dashboard/public/snapshot.js"));
  const faultConfirmRun = spawnSync(process.execPath, [cli, "confirm", "--root", snapshotFaultRoot,
    "--request-file", requestPath, "--confirm-ref", faultPrepared.confirmationRef, "--user-reply", "留下"], { encoding: "utf8" });
  const faultConfirmed = JSON.parse(faultConfirmRun.stdout);
  expect(faultConfirmRun.status === 0 && faultConfirmed.decision === "learning-save-complete-dashboard-refresh-pending"
    && faultConfirmed.recallVerified === true && faultConfirmed.snapshotState === "refresh-pending"
    && loadTrustedDomainEnvelope(snapshotFaultRoot, { explicitRequestedId: faultConfirmed.assetId }).envelope.explicitRoute,
  `a dashboard-only fault discarded or blocked the saved learning asset and ordinary recall route: ${faultConfirmRun.status} / ${faultConfirmRun.stderr || faultConfirmRun.stdout}`);
}

function testKeepWritesExactFormalRouteAndSnapshots() {
  const root = createFixture("keep-direct", { full: true });
  const { selection } = select(root, "keep", "keep");
  const plan = buildLearningCaptureTransactionPlan(root, selection);
  expect(validateLearningCaptureTransactionPlan(plan), `direct keep transaction is invalid: ${plan.reason ?? "unknown"}`);
  expect(plan.decision === "learning-capture-direct-formal-host-transaction-preview"
    && plan.writeSet.length === 2 && plan.steps.length === 2,
  `keep did not produce the exact formal+route core transaction: ${plan.decision} / ${plan.formalPromotionRequest?.reason ?? plan.reason ?? "unknown"}`);
  expect(plan.formalPreviewDigest === sha256(Buffer.from(proposal().formal_preview.replaceAll("\r\n", "\n"), "utf8")),
    "direct keep is not bound to the reviewed exact formal bytes");
  expect(plan.initialEvidence.formalSuccessfulUseCount === 0 && plan.initialEvidence.formalMaturityPreclaimed === false,
    "direct keep inflated formal maturity from a host observation");
  applyPlan(root, plan);
  expect(readFileSync(targetPath(root, plan.formalTarget), "utf8") === proposal().formal_preview,
    "direct keep formal bytes differ from the user-reviewed preview");
  expect(loadTrustedDomainEnvelope(root, { explicitRequestedId: plan.formalId }).envelope.explicitRoute?.target === plan.formalTarget,
    "direct formal route did not close after commit");
  const recalled = queryFormalAssetShortlist(root, {
    queryText: "帮我弄一下上次那个",
    workSignals: [
      "帮我弄一下上次那个",
      "natural-language-recall",
      "previous-workflow",
      "相近的真实任务",
      "当前说法与已保存做法有明确语义关联",
    ],
  });
  expect(recalled.decision === "shortlist-ready" && recalled.candidates.length === 1
    && recalled.candidates[0].id === plan.formalId,
  "saved direct formal asset could not be shortlisted again through ordinary language");
  const recalledBody = inspectShortlistedFormalAsset(root, recalled, plan.formalId);
  expect(recalledBody.decision === "load-bounded-body" && recalledBody.body.includes("在相近真实任务中先用普通语言提示")
    && recalledBody.recallUse?.state === "asset-body-loaded"
    && recalledBody.recallUse?.assetKind === "memory"
    && recalledBody.recallUse?.userReportContract === "report-actual-application-only-not-body-loading",
  "saved direct formal asset did not close the body-load and transparent-use receipt path");
  expect(readFileSync(join(root, "dashboard/public/snapshot.js"), "utf8")
    === readFileSync(join(root, "dashboard/dist/snapshot.js"), "utf8"),
  "the core learning transaction changed or drifted the independent dashboard snapshot pair");
  const after = treeIdentity(root);
  expect(applyPlan(root, plan) === 0 && treeIdentity(root) === after, "second direct keep application was not idempotent");

  const degradedRoot = createFixture("keep-with-unrelated-bad-todo", { full: true });
  const degradedTodoPath = join(degradedRoot, "instance/todo/unrelated-invalid.md");
  const degradedTodoBytes = Buffer.from(`+++
id = "todo.unrelated-invalid"
kind = "todo"
status = "pending"
visible = true
title = "保持原样的无关坏待办"
summary = "验证无关坏项不会阻止保存新记忆。"
unsupported_field = "preserve-exactly"
+++
# fixture
`, "utf8");
  writeFileSync(degradedTodoPath, degradedTodoBytes);
  const degradedPlan = buildLearningCaptureTransactionPlan(degradedRoot,
    select(degradedRoot, "keep", "keep-with-unrelated-bad-todo").selection);
  expect(validateLearningCaptureTransactionPlan(degradedPlan)
    && degradedPlan.decision === "learning-capture-direct-formal-host-transaction-preview",
  `an unrelated invalid TODO blocked a new memory save: ${degradedPlan.reason ?? degradedPlan.decision}`);
  applyPlan(degradedRoot, degradedPlan);
  const degradedSync = spawnSync(process.execPath, [join(scriptDir, "sync-snapshot.mjs"), degradedRoot], { encoding: "utf8" });
  expect(degradedSync.status === 0, `operational dashboard refresh did not isolate an unrelated TODO: ${degradedSync.stderr}`);
  const degradedPublic = readFileSync(join(degradedRoot, "dashboard/public/snapshot.js"), "utf8");
  const degradedDist = readFileSync(join(degradedRoot, "dashboard/dist/snapshot.js"), "utf8");
  const degradedSnapshot = parseCurrentSnapshotEnvelope(degradedPublic, "degraded direct keep snapshot");
  expect(degradedPublic === degradedDist && degradedSnapshot.assets.memory === 1
    && degradedSnapshot.health?.state === "degraded" && degradedSnapshot.health?.isolated_item_count === 1
    && degradedSnapshot.health?.affected_areas?.[0] === "todo" && degradedSnapshot.health?.source_data_preserved === true,
  "the valid memory save did not finish with one bounded TODO isolation warning and byte-identical snapshots");
  expect(readFileSync(degradedTodoPath).equals(degradedTodoBytes),
    "the unrelated invalid TODO bytes changed while saving the new memory");
  let degradedStrictBlocked = false;
  try { buildSnapshotCandidate(degradedRoot, { existingSource: degradedPublic }); } catch { degradedStrictBlocked = true; }
  expect(degradedStrictBlocked, "strict maintenance accepted the TODO that operational save isolated");

  const faultRoot = createFixture("keep-direct-fault", { full: true }); const before = treeIdentity(faultRoot);
  const faultPlan = buildLearningCaptureTransactionPlan(faultRoot, select(faultRoot, "keep", "keep-fault").selection);
  expect(validateLearningCaptureTransactionPlan(faultPlan), "direct keep fault plan is invalid");
  applyPlan(faultRoot, faultPlan, { stopAfter: 1 });
  expect(inspectLearningCaptureTransactionState(faultRoot, faultPlan).decision === "learning-capture-rollback-required",
    "interrupted direct keep was not recognized as rollback-required");
  rollbackPlan(faultRoot, faultPlan);
  expect(treeIdentity(faultRoot) === before, "direct keep rollback did not restore the complete original tree");

  const externalRoot = createFixture("keep-external", { full: true });
  const external = select(externalRoot, "keep", "keep-external", { sourceKind: "external-content", resultState: "closed-unverified" });
  const externalPlan = buildLearningCaptureTransactionPlan(externalRoot, external.selection);
  expect(validateLearningCaptureTransactionPlan(externalPlan)
    && externalPlan.decision === "learning-capture-host-transaction-preview"
    && externalPlan.writeSet.some((item) => item.target.startsWith("instance/evolution/review-payloads/"))
    && externalPlan.formalPromotionRequest?.existingKeepAuthorizationReusableIfExactDigestUnchanged === true,
  "external or unverified keep did not become a bounded non-executable Level 3 review handoff");
  applyPlan(externalRoot, externalPlan);
  const reviewPayload = JSON.parse(readFileSync(targetPath(externalRoot, externalPlan.formalPromotionRequest.reviewPayloadRef), "utf8"));
  expect(reviewPayload.state === "awaiting-review" && reviewPayload.review.executable === false
    && reviewPayload.review.result_validation_claimed === false
    && reviewPayload.authorization.message_digest === externalPlan.confirmationMessageDigest,
  "Level 3 handoff lost exact content authorization or mislabeled external content as validation");
  expect(!loadTrustedDomainEnvelope(externalRoot, { explicitRequestedId: externalPlan.formalPromotionRequest.formalId }).envelope.explicitRoute,
    "Level 3 handoff silently created a formal route before review");
}

function testObserveCommitIdempotenceAndDuplicate() {
  const root = createFixture("observe", { full: true });
  const { selection } = select(root, "observe", "observe");
  const plan = buildLearningCaptureTransactionPlan(root, selection);
  expect(validateLearningCaptureTransactionPlan(plan), `observe plan is invalid: ${plan.reason ?? "unknown"}`);
  expect(plan.initialEvidence.independentEventCount === 1 && plan.initialEvidence.distinctContextCount === 1
    && plan.initialEvidence.successfulEventCount === 0 && plan.initialEvidence.independentValidationClaimed === false,
  "initial event semantics are inflated or inconsistent");
  expect(plan.observationReceipt?.basis === "same-process-host-natural-stop-observation"
    && plan.observationReceipt?.sourceTrust === "host-asserted-not-independently-verified"
    && plan.observationReceipt?.observationRef !== plan.confirmationMessageRef,
  "task observation and the later user persistence choice were conflated");
  expect(!plan.candidateSourceRef.includes(":" ) && !plan.candidateSourceRef.includes("\\"), "runtime generated a device path");
  const tampered = JSON.parse(JSON.stringify(plan)); tampered.initialEvidence.successfulEventCount = 1;
  expect(!validateLearningCaptureTransactionPlan(tampered), "tampered successful evidence remained valid");
  expect(inspectLearningCaptureTransactionState(root, plan).decision === "learning-capture-ready-for-host-execution", "observe plan is not ready");
  expect(plan.steps.length >= 1 && applyPlan(root, plan) === plan.steps.length,
    "observe host execution did not save the complete semantic source transaction");
  expect(inspectLearningCaptureTransactionState(root, plan).decision === "learning-capture-already-committed", "committed transaction was not recognized");
  const after = treeIdentity(root); expect(applyPlan(root, plan) === 0 && treeIdentity(root) === after, "second application was not byte-idempotent");
  const candidate = readFileSync(targetPath(root, plan.candidateSourceRef), "utf8");
  expect(candidate.includes("independent_event_count = 1") && candidate.includes("distinct_context_count = 1")
    && candidate.includes("successful_event_count = 0"), "candidate initial counters are wrong");

  const next = select(root, "observe", "observe-again").selection;
  const duplicate = buildLearningCaptureTransactionPlan(root, next);
  expect(duplicate.decision === "learning-capture-plan-denied",
    "same-ID or semantic duplicate created another candidate");
}

function testReminderAndCancellationGuidance() {
  const root = createFixture("remind", { full: true }); const remindAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const { selection } = select(root, "remind", "remind", { remindAt });
  expect(selection.cancellationGuidance.includes("不需要 ID 或路径"), "reminder selection lacks plain-language cancellation guidance");
  const plan = buildLearningCaptureTransactionPlan(root, selection);
  expect(validateLearningCaptureTransactionPlan(plan), "reminder plan is invalid"); applyPlan(root, plan); applyPreparedProjections(root, plan);
  const timeMap = readFileSync(targetPath(root, "instance/maps/time-trigger-map.toml"), "utf8");
  const signal = readFileSync(targetPath(root, plan.signalSourceRef), "utf8");
  expect(timeMap.includes(`next_check_at = ${JSON.stringify(remindAt)}`) && timeMap.includes(`source_ref = ${JSON.stringify(plan.candidateSourceRef)}`),
    "reminder time projection is not bound to the candidate source");
  expect(signal.includes(`next_check_at = ${JSON.stringify(remindAt)}`), "signal source is not bound to the reminder time");
  expect(plan.userGuidance.includes("取消刚才那条学习提醒") && plan.userGuidance.includes("不需要记住 ID 或路径"),
    "committed reminder does not explain cancellation to a nontechnical user");
  const reminderPublic = readFileSync(join(root, "dashboard/public/snapshot.js"), "utf8");
  const reminderSnapshot = parseCurrentSnapshotEnvelope(reminderPublic, "reminder committed snapshot");
  expect(reminderPublic === readFileSync(join(root, "dashboard/dist/snapshot.js"), "utf8")
    && reminderSnapshot.assets.evolution === 1 && reminderSnapshot.evolution[0].status === "candidate",
  "remind did not atomically rebuild one identical visible candidate snapshot pair");

  const shortlist = shortlistLearningReminderCancellations(root, { query: "日常说法那条提醒" });
  expect(shortlist.decision === "learning-reminder-cancellation-shortlist-ready" && shortlist.items.length === 1
    && !Object.hasOwn(shortlist.items[0], "candidateId") && !Object.hasOwn(shortlist.items[0], "source_ref"),
  "natural-language cancellation did not produce a bounded low-sensitivity shortlist");
  const recentShortlist = shortlistLearningReminderCancellations(root, { query: "取消刚才那条学习提醒" });
  expect(recentShortlist.decision === "learning-reminder-cancellation-shortlist-ready"
    && recentShortlist.items.length === 1 && recentShortlist.items[0].title === shortlist.items[0].title,
  "plain-language recent-reminder intent could not safely locate the only recent reminder");
  expect(shortlistLearningReminderCancellations(root, { query: "火星天气" }).decision === "learning-reminder-cancellation-shortlist-denied",
    "an unrelated query was silently mapped to an arbitrary reminder");
  expect(createLearningReminderCancellationChallenge(root, { shortlist: { ...shortlist } }).decision === "learning-reminder-cancellation-challenge-denied",
    "a cloned reminder shortlist crossed the same-process boundary");
  const challenge = createLearningReminderCancellationChallenge(root, { shortlist });
  expect(challenge.decision === "learning-reminder-cancellation-current-user-confirmation-required"
    && challenge.preview.question.includes("保留观察候选"), "reminder cancellation lacks a bounded human confirmation preview");
  expect(confirmLearningReminderCancellation({ ...challenge }, cancellationReceipt(challenge, "clone")).decision === "learning-reminder-cancellation-denied",
    "a cloned cancellation challenge crossed the same-process boundary");
  const receipt = cancellationReceipt(challenge, "valid");
  const confirmation = confirmLearningReminderCancellation(challenge, receipt);
  expect(confirmation.decision === "learning-reminder-cancellation-confirmed", "valid cancellation receipt was denied");
  expect(confirmLearningReminderCancellation(challenge, receipt).decision === "learning-reminder-cancellation-denied",
    "a cancellation receipt or challenge was replayed");
  const cancelPlan = buildLearningReminderCancellationPlan(root, confirmation);
  expect(validateLearningReminderCancellationPlan(cancelPlan), `cancellation plan is invalid: ${cancelPlan.reason ?? "unknown"}`);
  expect(buildLearningReminderCancellationPlan(root, confirmation).decision === "learning-reminder-cancellation-plan-denied",
    "one cancellation confirmation minted two plans");
  expect(inspectLearningReminderCancellationState(root, cancelPlan).decision === "learning-capture-ready-for-host-execution",
    "cancellation plan is not ready for bounded host execution");
  applyPlan(root, cancelPlan); applyPreparedProjections(root, cancelPlan);
  expect(inspectLearningReminderCancellationState(root, cancelPlan).decision === "learning-capture-already-committed",
    "committed cancellation was not recognized");
  const candidate = parseMarkdownFrontmatterHead(readFileSync(targetPath(root, plan.candidateSourceRef), "utf8"), "cancelled reminder candidate").values;
  const indexParsed = parseArrayTableDocument(readFileSync(targetPath(root, CANDIDATE_INDEX_REF), "utf8"), "candidates", "cancelled reminder index");
  const indexEntry = indexParsed.entries.find((item) => item.id === plan.candidateId);
  const cancelledTime = parseArrayTableDocument(readFileSync(targetPath(root, "instance/maps/time-trigger-map.toml"), "utf8"), "triggers", "cancelled time map");
  const cancelledSignal = readFileSync(targetPath(root, plan.signalSourceRef), "utf8");
  const cancelledSignalMap = parseArrayTableDocument(readFileSync(targetPath(root, "instance/maps/signal-map.toml"), "utf8"), "signals", "cancelled signal map");
  expect(candidate.id === plan.candidateId && candidate.remind_at === "" && candidate.snoozed_until === ""
    && candidate.trigger_revision === 2 && candidate.source_revision === 2,
  "cancellation removed the candidate or failed to revise its reminder state");
  expect(indexEntry?.source_revision === candidate.source_revision && indexParsed.root.source_revision === 2,
    "cancellation candidate index revision drifted from its retained source");
  expect(cancelledTime.entries.length === 0 && cancelledTime.root.scheduled_count === 0 && cancelledTime.root.next_wakeup_at === "",
    "cancellation left a scheduled time projection");
  expect(cancelledSignal.includes('next_check_at = ""') && cancelledSignal.includes("revision = 2")
    && cancelledSignal.includes("candidate_source_revision = 2") && cancelledSignal.includes(`context_id = ${JSON.stringify(plan.contextId)}`),
  "cancellation lost signal evidence or left its reminder binding");
  expect(cancelledSignalMap.root.scheduled_count === 0 && cancelledSignalMap.root.next_wakeup_at === ""
    && cancelledSignalMap.entries.every((item) => item.id !== plan.signalId),
  "cancellation left a startup reminder projection");
  const after = treeIdentity(root);
  expect(applyPlan(root, cancelPlan) === 0 && treeIdentity(root) === after, "second cancellation application was not idempotent");

  const driftRoot = createFixture("cancel-drift", { full: true }); const driftAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const driftPlan = buildLearningCaptureTransactionPlan(driftRoot, select(driftRoot, "remind", "cancel-drift", { remindAt: driftAt }).selection);
  applyPlan(driftRoot, driftPlan); applyPreparedProjections(driftRoot, driftPlan);
  const driftChallenge = createLearningReminderCancellationChallenge(driftRoot, { candidateId: driftPlan.candidateId });
  writeFileSync(targetPath(driftRoot, driftPlan.signalSourceRef), `${readFileSync(targetPath(driftRoot, driftPlan.signalSourceRef), "utf8")}\n# drift\n`, "utf8");
  expect(confirmLearningReminderCancellation(driftChallenge, cancellationReceipt(driftChallenge, "drift")).decision === "learning-reminder-cancellation-denied",
    "a cancellation challenge survived reminder state drift");

  const faultRoot = createFixture("cancel-fault", { full: true }); const faultAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const reminderPlan = buildLearningCaptureTransactionPlan(faultRoot, select(faultRoot, "remind", "cancel-fault", { remindAt: faultAt }).selection);
  applyPlan(faultRoot, reminderPlan); applyPreparedProjections(faultRoot, reminderPlan);
  const faultChallenge = createLearningReminderCancellationChallenge(faultRoot, { candidateId: reminderPlan.candidateId });
  const faultConfirmation = confirmLearningReminderCancellation(faultChallenge, cancellationReceipt(faultChallenge, "fault"));
  const faultCancelPlan = buildLearningReminderCancellationPlan(faultRoot, faultConfirmation);
  const driftedSignal = `${readFileSync(targetPath(faultRoot, reminderPlan.signalSourceRef), "utf8")}\n# local drift\n`;
  writeFileSync(targetPath(faultRoot, reminderPlan.signalSourceRef), driftedSignal, "utf8");
  applyPlan(faultRoot, faultCancelPlan);
  const faultCandidate = parseMarkdownFrontmatterHead(
    readFileSync(targetPath(faultRoot, reminderPlan.candidateSourceRef), "utf8"), "locally completed cancellation").values;
  expect(inspectLearningReminderCancellationState(faultRoot, faultCancelPlan).decision === "learning-capture-already-committed"
    && faultCandidate.remind_at === ""
    && readFileSync(targetPath(faultRoot, reminderPlan.signalSourceRef), "utf8") === driftedSignal,
  "a stale reminder projection blocked, rolled back, or silently overwrote the confirmed source cancellation");
}

try {
  testNoSelfSignedDirectUserBypassAndStandardKeep();
  testOpaqueReceiptBoundary();
  testNoResponseAndDiscard();
  testPersistentCrossTurnChallengeAndCleanup();
  testPersistentCommittedEvidenceSurvivesInspectionAndClose();
  testAtomicStageCrashWindowRecovery();
  testStaleProjectionCleanupBoundary();
  testProductionCliAcrossProcesses();
  testSimpleLearningSaveCli();
  testKeepWritesExactFormalRouteAndSnapshots();
  testObserveCommitIdempotenceAndDuplicate();
  testReminderAndCancellationGuidance();
  console.log("learning-capture transaction fixture validation passed");
} finally {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
}
