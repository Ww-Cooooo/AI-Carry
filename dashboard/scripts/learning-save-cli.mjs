#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closePersistentLearningCaptureChallenge,
  confirmPersistentLearningCaptureChallenge,
  executePersistentLearningCaptureTransaction,
  preparePersistentLearningCaptureChallenge,
  rollbackPersistentLearningCaptureTransaction,
} from "./learning-capture-transaction.mjs";
import { loadTrustedDomainEnvelope, queryFormalAssetShortlist } from "./asset-route-contract.mjs";
import { withOperationalUserReport } from "./operational-user-report.mjs";
import { containsForbiddenLocationReference } from "./safe-output-boundary.mjs";
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const confirmationPattern = /^(capture\.[a-f0-9]{32})~([a-f0-9]{36})$/u;
const knownRequestFields = new Set([
  "kind", "subtype", "title", "summary", "triggers", "aliases", "scope", "conditions", "excludes",
  "steps", "failure_handling", "completion_checks", "notes", "risk_tier",
]);
const kindAliases = new Map([
  ["sop", "sop"], ["workflow", "sop"], ["procedure", "sop"], ["流程", "sop"],
  ["capability", "capability"], ["ability", "capability"], ["能力", "capability"],
  ["memory", "memory"], ["记忆", "memory"],
  ["experience", "experience"], ["经验", "experience"],
]);
const highConsequenceAction = /(?:删除|覆盖|清空|发布|推送|上传|外发|发送给|付款|转账|交易|下单|登录|授权|修改权限|更换权限|密钥|密码|令牌|cookie|医疗|法律|投资|公开仓库|强推|delete|overwrite|publish|push|upload|send\s+to|payment|transfer|trade|login|permission|credential|token|cookie)/iu;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanText(value, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new Error("学习内容必须使用文字");
  const normalized = value.trim().normalize("NFC");
  if ((!allowEmpty && normalized.length === 0) || [...normalized].length > maximum || unsafeText.test(normalized)) {
    throw new Error("学习内容为空、过长或包含不安全控制字符");
  }
  return normalized;
}

function cleanList(value, { field, maximumItems, maximumChars, required = false } = {}) {
  const source = typeof value === "string" ? [value] : value === undefined ? [] : value;
  if (!Array.isArray(source) || source.length > maximumItems) throw new Error(`${field} 需要一个有界的文字列表`);
  const normalized = [...new Set(source.map((item) => cleanText(item, maximumChars)))];
  if (required && normalized.length === 0) throw new Error(`${field} 至少需要一项`);
  return normalized;
}

function stableReadJson(path, label) {
  const absolute = realpathSync(resolve(path));
  const info = lstatSync(absolute, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.isReparsePoint?.() || info.size > 64n * 1024n) {
    throw new Error(`${label} 必须是一个不超过 64 KiB 的本地 JSON 文件`);
  }
  const descriptor = openSync(absolute, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== bytes.length || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`${label} 在读取过程中发生了变化`);
    }
    const observedAt = new Date(Number(before.mtimeNs / 1_000_000n)).toISOString();
    return Object.freeze({ value: JSON.parse(decoder.decode(bytes)), observedAt, digest: sha256(bytes), absolute });
  } finally {
    closeSync(descriptor);
  }
}

function toml(value) {
  if (typeof value === "string" || Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "boolean" || Number.isSafeInteger(value)) return String(value);
  throw new Error("产品生成的学习字段类型无效");
}

function normalizeRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 24) {
    throw new Error("学习请求必须是一个小型 JSON 对象");
  }
  const serialized = JSON.stringify(raw);
  if (locateHighConfidenceSecretCandidates(serialized).blocked || containsForbiddenLocationReference(serialized)) {
    throw new Error("学习请求含有秘密或设备专用绝对位置；本次只暂停保存，普通任务仍可继续");
  }
  const kind = kindAliases.get(String(raw.kind ?? "").trim().toLocaleLowerCase("zh-CN"));
  if (!kind) throw new Error("kind 只支持 SOP、能力、记忆或普通任务经验");
  let subtype = "";
  if (kind === "memory") {
    subtype = raw.subtype === undefined ? "general" : cleanText(raw.subtype, 16).toLowerCase();
    if (!["general", "habit"].includes(subtype)) throw new Error("memory 的 subtype 只支持 general 或 habit");
  } else if (raw.subtype !== undefined) {
    throw new Error("只有 memory 可以在简洁入口中指定 subtype");
  }
  const title = cleanText(raw.title, 80);
  const summary = cleanText(raw.summary, 240);
  const triggers = cleanList(raw.triggers, { field: "triggers", maximumItems: 8, maximumChars: 80, required: true });
  const aliases = cleanList(raw.aliases, { field: "aliases", maximumItems: 8, maximumChars: 80 });
  const scope = cleanList(raw.scope ?? "与这套方法相同或相近的任务", {
    field: "scope", maximumItems: 8, maximumChars: 120, required: true,
  });
  const conditions = cleanList(raw.conditions, { field: "conditions", maximumItems: 6, maximumChars: 120 });
  const excludes = cleanList(raw.excludes ?? "超出已说明范围或需要额外授权的动作", {
    field: "excludes", maximumItems: 6, maximumChars: 120, required: true,
  });
  const steps = cleanList(raw.steps, { field: "steps", maximumItems: 16, maximumChars: 240, required: true });
  const failureHandling = cleanList(raw.failure_handling ?? "说明具体错误和仍可用范围，只修复当前步骤，不让局部故障拖垮整个助手", {
    field: "failure_handling", maximumItems: 8, maximumChars: 240, required: true,
  });
  const completionChecks = cleanList(raw.completion_checks ?? "回读实际结果；未验证的部分明确标注，不把预览或计划说成完成", {
    field: "completion_checks", maximumItems: 8, maximumChars: 240, required: true,
  });
  const notes = cleanList(raw.notes, { field: "notes", maximumItems: 6, maximumChars: 240 });
  const riskTier = raw.risk_tier === undefined ? "low" : cleanText(raw.risk_tier, 16).toLowerCase();
  if (riskTier !== "low" || steps.some((step) => highConsequenceAction.test(step))) {
    throw new Error("这套做法包含中高影响动作或风险仍不清楚，需要定向复核；当前简洁入口不会把它误标成低风险");
  }
  const ignoredFields = Object.keys(raw).filter((field) => !knownRequestFields.has(field)).sort();
  return Object.freeze({ kind, subtype, title, summary, triggers, aliases, scope, conditions, excludes,
    steps, failureHandling, completionChecks, notes, riskTier, ignoredFields });
}

function buildFormalProposal(request) {
  const habit = request.kind === "memory" && request.subtype === "habit";
  const semanticCore = {
    kind: request.kind, title: request.title, summary: request.summary, triggers: request.triggers,
    aliases: request.aliases, scope: request.scope, conditions: request.conditions, excludes: request.excludes,
    steps: request.steps, failureHandling: request.failureHandling,
    completionChecks: request.completionChecks, notes: request.notes,
  };
  // Keep existing general-memory and non-memory IDs stable. Only the newly
  // supported habit variant needs subtype in its semantic identity.
  if (request.kind === "memory" && request.subtype === "habit") semanticCore.subtype = request.subtype;
  const semanticDigest = sha256(canonical(semanticCore));
  const token = semanticDigest.slice("sha256:".length, "sha256:".length + 24);
  const id = `${request.kind}.learned.${token}`;
  const subtype = request.kind === "memory" ? request.subtype : request.kind === "experience" ? "task" : "";
  const habitSubject = request.scope.find((item) => [...item].length <= 80) ?? request.triggers[0];
  const asset = {
    id, kind: request.kind, subtype, status: "active", title: request.title, summary: request.summary,
    triggers: request.triggers, scope: request.scope, excludes: request.excludes, lifecycle: "recurring",
    expected_next_use: "", topic_key: habit ? request.triggers[0] : `learned-${request.kind}`,
    subject_key: habit ? habitSubject : `${request.kind}.${token}`,
    aliases: request.aliases, conditions: request.conditions, body_sections: [], related_asset_ids: [],
    source_refs: [], private_refs: [], supersedes: [], minimum_level: 1,
    confirmation: "risk-dependent-before-action", approval_state: "explicit",
    activation_basis: "explicit-user", risk_tier: "low", approved_by_user: true, updated_at: "",
  };
  if (["sop", "capability"].includes(request.kind)) Object.assign(asset, {
    maturity: "unvalidated", independent_task_count: 0, successful_use_count: 0,
    failed_use_count: 0, distinct_context_count: 0, distinct_host_count: 0,
    last_validated_at: "", validation_refs: [], host_experience_refs: [],
  });
  const order = [
    "id", "kind", "subtype", "status", "title", "summary", "triggers", "scope", "excludes", "lifecycle",
    "expected_next_use", "topic_key", "subject_key", "aliases", "conditions", "body_sections", "related_asset_ids",
    "source_refs", "private_refs", "supersedes", "minimum_level", "confirmation", "approval_state", "activation_basis",
    "risk_tier", "approved_by_user", "updated_at", "maturity", "independent_task_count", "successful_use_count",
    "failed_use_count", "distinct_context_count", "distinct_host_count", "last_validated_at", "validation_refs",
    "host_experience_refs",
  ];
  const frontmatter = order.filter((field) => Object.hasOwn(asset, field)).map((field) => `${field} = ${toml(asset[field])}`).join("\n");
  const list = (items) => items.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const optionalNotes = request.notes.length ? `\n\n# 补充说明\n\n${request.notes.map((item) => `- ${item}`).join("\n")}` : "";
  const correction = habit
    ? "\n\n# 纠正与停止\n\n用户当前明确要求始终优先。用户可以随时用自然语言纠正、暂停或停止沿用这项习惯。"
    : "";
  const body = `# ${habit ? "当前有效习惯与边界" : "目的与适用边界"}\n\n${request.summary}\n\n适用于：\n${request.scope.map((item) => `- ${item}`).join("\n")}\n\n不用于：\n${request.excludes.map((item) => `- ${item}`).join("\n")}\n\n# ${habit ? "以后怎样采用" : "执行步骤"}\n\n${list(request.steps)}\n\n# ${habit ? "不适用或出现冲突时" : "失败处理"}\n\n${request.failureHandling.map((item) => `- ${item}`).join("\n")}\n\n# ${habit ? "怎样判断采用正确" : "完成检查"}\n\n${request.completionChecks.map((item) => `- ${item}`).join("\n")}${correction}${optionalNotes}\n`;
  const formalPreview = `+++\n${frontmatter}\n+++\n${body}`;
  const proposal = Object.freeze({
    title: request.title, summary: request.summary, triggers: request.triggers, aliases: request.aliases,
    scope: request.scope, conditions: request.conditions, excludes: request.excludes,
    topic_key: asset.topic_key, subject_key: asset.subject_key,
    target_kind: request.kind, target_subtype: subtype, claim_summary: request.summary,
    proposed_risk_tier: "low", minimum_level: 1, formal_preview: formalPreview,
  });
  return Object.freeze({ proposal, asset: Object.freeze(asset), formalPreview, semanticDigest });
}

function contentLabel(request) {
  if (request.kind === "memory") return request.subtype === "habit" ? "习惯" : "记忆";
  if (request.kind === "capability") return "能力";
  if (request.kind === "experience") return "经验";
  return "做法";
}

function buildObservation(requestRead) {
  return Object.freeze({
    basis: "same-process-host-task-observation", source_kind: "unknown",
    task_ref_digest: sha256(`simple-learning-task\u0000${requestRead.digest}`),
    context_ref_digest: sha256(`simple-learning-context\u0000${requestRead.digest}`),
    occurred_at: requestRead.observedAt, result_state: "closed-unverified",
  });
}

function displayPreview(request) {
  const section = (label, items) => `${label}：\n${items.map((item) => `- ${item}`).join("\n")}`;
  const habit = request.kind === "memory" && request.subtype === "habit";
  return [
    `我准备把“${request.title}”保存为一项以后可按需使用的${contentLabel(request)}。`,
    `用途：${request.summary}`,
    section("会在这些情况想到它", request.triggers),
    section("适用范围", request.scope),
    section("不适用范围", request.excludes),
    section(habit ? "以后怎样采用" : "具体步骤", request.steps),
    section(habit ? "不适用或出现冲突时" : "出错时", request.failureHandling),
    section(habit ? "怎样判断采用正确" : "怎样算完成", request.completionChecks),
    habit
      ? "采用规则：只有你确认后才会生效；当前要求始终优先，你可以随时纠正、暂停或停止沿用。"
      : "初始状态：只表示你同意保存，仍是“尚未验证”；不会伪造成功次数，也不会自动执行里面描述的未来动作。",
    "你可以回复“留下”“先观察”“以后提醒”或“不保存”。",
  ].join("\n\n");
}

function existingState(repositoryReal, formal) {
  const loaded = loadTrustedDomainEnvelope(repositoryReal, { explicitRequestedId: formal.asset.id });
  const route = loaded.envelope.explicitRoute;
  if (!route) return null;
  if (route.id !== formal.asset.id || typeof route.target !== "string") throw new Error("同一稳定 ID 已存在，但正式路线无法唯一回读");
  const target = resolve(repositoryReal, ...route.target.split("/"));
  const relativeTarget = relative(repositoryReal, target);
  if (relativeTarget === "" || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    throw new Error("已有正式路线越出了当前实例");
  }
  const read = stableReadText(target, 128 * 1024, "已有学习资产");
  return Object.freeze({ exact: read === formal.formalPreview, target: route.target, id: route.id });
}

function stableReadText(path, maximum, label) {
  const absolute = realpathSync(resolve(path));
  const info = lstatSync(absolute, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.isReparsePoint?.() || info.size > BigInt(maximum)) {
    throw new Error(`${label}不是一个可安全回读的有界文件`);
  }
  const descriptor = openSync(absolute, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (count === 0) break; offset += count; }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== bytes.length || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`${label}在回读时发生变化`);
    return decoder.decode(bytes).replaceAll("\r\n", "\n");
  } finally { closeSync(descriptor); }
}

function parseConfirmationRef(value) {
  const match = confirmationPattern.exec(String(value ?? ""));
  if (!match) throw new Error("确认引用无效；请复用刚才预览返回的 confirmationRef");
  return Object.freeze({ challengeId: match[1], challengeNonce: match[2] });
}

function persistentRecord(repositoryReal, challengeId) {
  const target = resolve(repositoryReal, ".assistant-local/runtime/learning-capture", `${challengeId}.json`);
  const value = JSON.parse(stableReadText(target, 32 * 1024, "学习确认回执"));
  if (value.challenge_id !== challengeId || !digestPattern.test(value.proposal_digest ?? "")
    || typeof value.instance_id !== "string" || typeof value.issued_at !== "string") {
    throw new Error("学习确认回执与当前预览不一致");
  }
  return value;
}

// Verify the saved route is reachable, not that a host understood an unseen
// paraphrase or applied the learning successfully in a real task.
function verifyOrdinaryRecall(repositoryReal, request, assetId) {
  const queryText = request.aliases[0] ?? request.triggers[0] ?? request.title;
  const result = queryFormalAssetShortlist(repositoryReal, {
    queryText,
    workSignals: [request.title, request.summary, ...request.scope].slice(0, 6),
  });
  return result.decision === "shortlist-ready" && result.candidates.some((item) => item.id === assetId);
}

function refreshDashboardSnapshot(repositoryReal) {
  try {
    execFileSync(process.execPath, [resolve(scriptDirectory, "sync-snapshot.mjs"), repositoryReal], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return Object.freeze({ state: "current", reason: "" });
  } catch {
    return Object.freeze({ state: "refresh-pending", reason: "看板刷新没有完成；学习资产和召回路线不受影响" });
  }
}

function prepare(repositoryReal, requestRead) {
  const request = normalizeRequest(requestRead.value);
  const formal = buildFormalProposal(request);
  const label = contentLabel(request);
  const existing = existingState(repositoryReal, formal);
  if (existing) {
    if (!existing.exact) return Object.freeze({
      decision: "learning-save-review-required", executable: false, affectedScope: "only-this-learning-item",
      reason: "同一稳定内容 ID 已存在但字节不同；产品保留原资产，不会覆盖或猜测合并",
      existingAssetId: existing.id, existingTarget: existing.target,
      nextStep: "请让 Agent 只比较这两份内容并说明差异，再由你决定保留、修改还是另存。",
    });
    return Object.freeze({
      decision: "learning-save-already-current", executable: false, updated: false,
      assetId: existing.id, target: existing.target,
      userSummary: `这项${label}已经完整保存，本次没有重复写入、增加计数或刷新时间。`,
      nextStep: "可以继续当前任务；以后出现相近说法时，AI Carry 会从正式路线按需召回它。",
    });
  }
  const observation = buildObservation(requestRead);
  const result = preparePersistentLearningCaptureChallenge(repositoryReal, formal.proposal, observation,
    { allowPromptOnlyLowRiskKeep: true });
  if (result.decision !== "persistent-learning-capture-choice-required") return result;
  const confirmationRef = `${result.persistentChallengeId}~${result.challengeNonce}`;
  return Object.freeze({
    decision: "learning-save-choice-required", executable: false,
    confirmationRef,
    assetId: formal.asset.id, assetKind: formal.asset.kind, ignoredRequestFields: request.ignoredFields,
    userPreview: `${displayPreview(request)}\n\n选择“留下”后：${result.preview.options.find((option) => option.id === "keep").consequence}`,
    ...(result.userReport ? { userReport: result.userReport } : {}),
    userInstruction: "展示 userReport（如有）和 userPreview。用户可以自然回复；Agent 根据当前预览把明确意思归为 keep、observe、remind 或 discard，通过 --choice 传入，同时用 --user-reply 保留原话。不要替用户选择；回复有歧义或未解决条件时只问清该点，不让用户填写内部字段。原话与选择是宿主判断，不是程序验证过的语义。",
    confirmCommand: `node dashboard/scripts/learning-save-cli.mjs confirm --root ${JSON.stringify(repositoryReal)} --request-file ${JSON.stringify(requestRead.absolute)} --confirmation-ref ${JSON.stringify(confirmationRef)} --choice <keep|observe|remind|discard> --user-reply ${JSON.stringify("<用户刚才的原话>")}`,
    nextStep: "用户明确同意当前预览后，Agent 传入对应选择和原话；已经明确的意思不必再要求用户复述固定口令。",
  });
}

function confirm(repositoryReal, requestRead, options) {
  const request = normalizeRequest(requestRead.value);
  const formal = buildFormalProposal(request);
  const label = contentLabel(request);
  const observation = buildObservation(requestRead);
  const confirmation = parseConfirmationRef(options.confirmationRef);
  const record = persistentRecord(repositoryReal, confirmation.challengeId);
  const choiceAliases = new Map([
    ["keep", "keep"], ["留下", "keep"], ["保存", "keep"],
    ["observe", "observe"], ["先观察", "observe"],
    ["remind", "remind"], ["以后提醒", "remind"],
    ["discard", "discard"], ["不保存", "discard"],
  ]);
  const userReply = String(options.userReply ?? "").trim();
  const literalChoice = choiceAliases.get(userReply.toLocaleLowerCase("zh-CN"));
  const hostChoice = choiceAliases.get(String(options.choice ?? "").trim().toLocaleLowerCase("zh-CN"));
  if ((options.choice && !hostChoice) || (literalChoice && hostChoice && literalChoice !== hostChoice)) {
    throw new Error("选择无效或与用户原话冲突；只澄清当前这项学习，不执行保存");
  }
  const choice = hostChoice || literalChoice;
  if (!choice) throw new Error("请 Agent 结合当前预览理解用户原话，用 --choice 传入 keep、observe、remind 或 discard；有歧义或未解决条件时先澄清，不猜测同意");
  const message = cleanText(userReply || options.message, 240);
  const now = new Date().toISOString();
  const receipt = {
    basis: "host-current-user-message",
    message_ref: `message.learning.${sha256(`${confirmation.challengeId}\u0000${message}`).slice("sha256:".length, "sha256:".length + 24)}`,
    message_digest: sha256(message), user_message_at: now, confirmed_at: now, choice,
    remind_at: choice === "remind" ? cleanText(options.remindAt, 64) : "",
    instance_id: record.instance_id, proposal_digest: record.proposal_digest,
    challenge_nonce: confirmation.challengeNonce,
  };
  const planned = confirmPersistentLearningCaptureChallenge(repositoryReal, {
    challengeId: confirmation.challengeId, proposal: formal.proposal, observationAssertion: observation,
    receipt, allowPromptOnlyLowRiskKeep: true,
  });
  if (planned.decision === "persistent-learning-capture-discard-closed") return Object.freeze({
    decision: "learning-save-discarded", executable: false, updated: false,
    userSummary: "这次发现没有保存，也没有创建候选、提醒或正式资产。",
    nextStep: "可以继续原任务；以后再次需要时仍可重新提出保存。",
  });
  if (planned.decision !== "persistent-learning-capture-plan-ready") return planned;
  const executed = executePersistentLearningCaptureTransaction(repositoryReal, confirmation);
  if (executed.decision !== "persistent-learning-capture-execution-complete") {
    if (executed.decision === "persistent-learning-capture-execution-rollback-required") {
      const rolledBack = rollbackPersistentLearningCaptureTransaction(repositoryReal, confirmation);
      return Object.freeze({
        decision: rolledBack.decision === "persistent-learning-capture-rollback-complete"
          ? "learning-save-failed-rolled-back" : "learning-save-recovery-required",
        executable: false, affectedScope: "only-this-learning-item", reason: executed.reason ?? "学习保存中断",
        rollbackDecision: rolledBack.decision, recoveryEvidencePreserved: rolledBack.decision !== "persistent-learning-capture-rollback-complete",
        userSummary: rolledBack.decision === "persistent-learning-capture-rollback-complete"
          ? "这条学习没有保存成功，但已经完整回到保存前；普通对话和其他能力仍可继续。"
          : "这条学习没有保存成功，恢复证据已经保留；普通对话和其他独立能力仍可继续。",
        nextStep: rolledBack.decision === "persistent-learning-capture-rollback-complete"
          ? "请修正当前这条简短请求后再试，不需要重建整个实例。"
          : "请让 Agent 只检查这条学习事务的恢复状态，不要删除现场。",
      });
    }
    return executed;
  }
  const target = planned.plan?.formalTarget ?? "";
  const planDecision = planned.plan?.decision ?? "";
  const planChoice = planned.plan?.choice ?? choice;
  const direct = planDecision === "learning-capture-direct-formal-host-transaction-preview";
  const assetId = planned.plan?.formalId ?? "";
  const candidateId = planned.plan?.candidateId ?? "";
  const candidateSourceRef = planned.plan?.candidateSourceRef ?? "";
  const projectionPending = Array.isArray(executed.projectionPending) ? executed.projectionPending : [];
  let recallVerified = !direct;
  if (direct) {
    try { recallVerified = verifyOrdinaryRecall(repositoryReal, request, assetId); } catch { recallVerified = false; }
  }
  const snapshot = direct ? refreshDashboardSnapshot(repositoryReal) : Object.freeze({ state: "not-applicable", reason: "" });
  const closed = closePersistentLearningCaptureChallenge(repositoryReal, confirmation);
  if (closed.decision !== "persistent-learning-capture-closed") return Object.freeze({
    decision: "learning-save-complete-operational-cleanup-pending", executable: false, updated: !executed.idempotent,
    assetId, target, planDecision, recallVerified, snapshotState: snapshot.state,
    userSummary: "学习内容已经保存并回读，但本机短期操作回执尚未清理；这不影响资产使用。",
    nextStep: "让 Agent 只重试清理这条操作回执，不要重写已经保存的资产。",
  });
  if (!direct && projectionPending.length > 0) return Object.freeze({
    decision: "learning-save-complete-projection-refresh-pending", status: "limited", executable: false,
    updated: !executed.idempotent, candidateId, candidateSourceRef,
    projectionPending, ordinaryTasksContinue: true, validationClaimed: false, futureActionsExecuted: false,
    operationalReceiptRemoved: true,
    userSummary: planChoice === "remind"
      ? "学习候选已经安全保存，提醒时间也留在候选真源里；但提醒索引还没刷新，所以暂时不能承诺到时自动提醒。普通任务和已有资产仍可继续。"
      : planChoice === "keep"
        ? "定向复核内容已经安全保存；索引或看板还有局部刷新待完成，其他任务和已有资产仍可继续。"
        : "观察候选已经安全保存；索引或看板还有局部刷新待完成，其他任务和已有资产仍可继续。",
    nextStep: planChoice === "remind"
      ? "请让 Agent 只刷新这条学习候选的索引和提醒投影；不需要重写候选，也不用重建整个实例。"
      : "请让 Agent 只刷新这条候选的索引和看板；不需要重写候选，也不用重建整个实例。",
  });
  if (direct && !recallVerified) return Object.freeze({
    decision: "learning-save-complete-recall-repair-required", status: "limited", executable: false,
    updated: !executed.idempotent, assetId, target, snapshotState: snapshot.state,
    userSummary: "学习内容已经安全保存，但普通说法召回还没有验证通过；其他能力仍可继续使用。",
    nextStep: "让 Agent 只修复这条资产的召回路线并重试召回，不要重写或删除已经保存的内容。",
  });
  if (direct && snapshot.state !== "current") return Object.freeze({
    decision: "learning-save-complete-dashboard-refresh-pending", status: "limited", executable: false,
    updated: !executed.idempotent, assetId, target, initialMaturity: planned.plan?.initialMaturity ?? "unvalidated",
    recallVerified: true, snapshotState: snapshot.state, validationClaimed: false, futureActionsExecuted: false,
    operationalReceiptRemoved: true,
    userSummary: `这项${label}已经保存并能被日常语言召回；只是看板还没刷新，普通任务可以继续。`,
    nextStep: `方便时只重试看板刷新：node dashboard/scripts/sync-snapshot.mjs ${JSON.stringify(repositoryReal)}`,
  });
  return Object.freeze({
    decision: direct ? "learning-save-complete"
      : planChoice === "keep" ? "learning-save-review-handoff-complete"
        : planChoice === "remind" ? "learning-save-reminder-complete" : "learning-save-observation-complete",
    executable: false, updated: !executed.idempotent, assetId, target,
    initialMaturity: direct ? planned.plan?.initialMaturity ?? "unvalidated" : "not-formal-yet",
    recallVerified, snapshotState: snapshot.state,
    recallVerificationScope: direct ? "registered-route-discovery-not-host-semantic-acceptance" : "not-applicable",
    validationClaimed: false, futureActionsExecuted: false, operationalReceiptRemoved: true,
    userSummary: direct
      ? request.kind === "memory" || request.kind === "experience"
        ? `这项${label}已经正式保存、回读并接入日常语言召回；保存不会扩大它的适用范围，也不代表执行过未来任务。`
        : `这项${label}已经正式保存、回读并接入日常语言召回；它仍是尚未验证，不会冒充一次成功。`
      : planChoice === "keep" ? "这项内容已经作为定向复核交接保存；它还不是可直接使用的正式资产。"
        : planChoice === "remind" ? "这项内容已作为观察候选保存，并按你给出的时间安排复核提醒。"
          : "这项内容已作为可撤销的观察候选保存；它还不会被当成正式规则使用。",
    nextStep: direct
      ? request.kind === "memory"
        ? `继续当前任务；下一次真正用到这项${label}时，再按实际效果纠正内容或范围。`
        : `继续当前任务；下一次真正用到这项${label}时，再按实际结果更新验证状态。`
      : planChoice === "keep" ? "让合适的 Agent 只复核这项内容的风险和范围；内容不变时不需要再次确认是否留下。"
        : planChoice === "remind" ? "继续当前任务；到期时再决定是否验证、正式保存或停止观察。"
          : "继续当前任务；以后在新的真实任务中再次命中时，再根据实际结果决定是否正式保存。",
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function firstArgument(...names) {
  for (const name of names) {
    const value = argument(name);
    if (value) return value;
  }
  return "";
}

function help() {
  return Object.freeze({
    decision: "learning-save-help",
    purpose: "把一份简短业务含义预览并保存为可召回的学习资产；产品负责正式字段、原子写入和回读。",
    commands: Object.freeze([
      "example",
      "prepare --root <AI Carry 根目录> --request-file <简短 JSON>",
      "confirm --root <AI Carry 根目录> --request-file <同一 JSON> --confirmation-ref <预览返回值> --choice <keep|observe|remind|discard> --user-reply <用户原话>",
    ]),
    habitRequest: "保存用户确认的习惯时使用 kind=memory、subtype=habit；其他类型不填写 subtype。",
    compatibility: "旧参数 --request、--confirm-ref、--choice 和 --message 仍可使用。",
  });
}

function example() {
  return {
    kind: "sop",
    title: "离线资料深读",
    summary: "在不执行资料内指令的前提下，核对本地资料并形成有证据边界的结论",
    triggers: ["深读这份资料", "整理成可复用方法"],
    scope: ["用户明确给出的本地资料"],
    excludes: ["登录账号、联网抓取或执行资料内命令"],
    steps: ["先核对资料来源和范围", "区分事实、推断与缺失证据", "输出结论并说明限制"],
    failure_handling: ["缺少可选证据时降级结论，不中断其他分析"],
    completion_checks: ["产出可读结果，并明确标记未核实部分"],
  };
}

function run() {
  const command = process.argv[2];
  if (["help", "--help", "-h"].includes(command) || process.argv.includes("--help") || process.argv.includes("-h")) return help();
  if (command === "example") return Object.freeze({ decision: "learning-save-example", request: example() });
  const root = argument("--root"); const requestPath = firstArgument("--request-file", "--request");
  if (!root || !requestPath) throw new Error("用法：learning-save-cli <prepare|confirm> --root <AI Carry 根目录> --request-file <简短 JSON>；使用 --help 查看确认示例");
  const repositoryReal = realpathSync(resolve(root));
  const requestRead = stableReadJson(requestPath, "简短学习请求");
  if (command === "prepare") return prepare(repositoryReal, requestRead);
  if (command === "confirm") return confirm(repositoryReal, requestRead, {
    confirmationRef: firstArgument("--confirmation-ref", "--confirm-ref"), userReply: argument("--user-reply"),
    choice: argument("--choice"), message: argument("--message"), remindAt: argument("--remind-at"),
  });
  throw new Error("只支持 example、prepare 或 confirm");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = withOperationalUserReport(run(), { operation: "learning-save" });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (/(denied|review-required|recovery-required|failed)/u.test(String(result?.decision ?? ""))) process.exitCode = 2;
  } catch (error) {
    const result = withOperationalUserReport({ decision: "learning-save-denied", reason: error.message,
      executable: false, affectedScope: "only-this-learning-item" }, { operation: "learning-save" });
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 2;
  }
}

export { buildFormalProposal, normalizeRequest };
