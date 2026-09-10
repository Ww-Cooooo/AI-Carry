import { readSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_TASK_CLOSEOUT_INPUT_BYTES = 65_536;

const topLevelFields = Object.freeze([
  "schema_version", "language", "event", "continuation", "complex", "draft",
  "actual_uses", "learning", "files", "next",
]);
const useFields = Object.freeze(["kind", "title", "effect", "receipt_visible_at_handoff"]);
const learningFields = Object.freeze(["state", "finding", "status", "future_use", "receipt_visible_at_handoff"]);
const fileFields = Object.freeze(["state", "known_location", "decision_summary"]);
const nextFields = Object.freeze([
  "overall_goal", "overall_goal_state", "action", "reason", "owner", "user_decision", "decision_prompt",
]);
const useKinds = new Set(["memory", "capability", "sop", "experience", "skill", "preference"]);
const languages = new Set(["zh-CN", "en", "en-US"]);
const events = new Set(["complete", "paused", "limited"]);
const continuations = new Set(["same-context", "context-compacted", "resumed"]);
const learningStates = new Set(["none", "observed", "saved"]);
const fileStates = new Set(["none", "resolved", "decision-needed"]);
const goalStates = new Set(["in-progress", "complete", "blocked"]);
const decisionStates = new Set(["none", "required"]);
const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactObject(value, fields, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  assert(keys.length === expected.length && keys.every((key, index) => key === expected[index]),
    `${label} fields are unavailable or unexpected`);
  return value;
}

function boundedText(value, label, { max = 1_200, empty = false } = {}) {
  assert(typeof value === "string", `${label} must be text`);
  assert((empty || value.length > 0) && value.length <= max, `${label} length is invalid`);
  assert(!unsafeControls.test(value), `${label} contains unsafe control characters`);
  return value;
}

function oneOf(value, values, label) {
  assert(values.has(value), `${label} is invalid`);
  return value;
}

function normalizeFacts(input) {
  const root = exactObject(input, topLevelFields, "task closeout facts");
  assert(root.schema_version === 1, "schema_version is unsupported");
  assert(typeof root.complex === "boolean", "complex must be true or false");
  const draft = boundedText(root.draft, "draft", { max: MAX_TASK_CLOSEOUT_INPUT_BYTES });
  const actualUses = root.actual_uses;
  assert(Array.isArray(actualUses) && actualUses.length <= 3, "actual_uses must contain at most three items");
  const uses = actualUses.map((entry, index) => {
    const item = exactObject(entry, useFields, `actual_uses[${index}]`);
    assert(typeof item.receipt_visible_at_handoff === "boolean",
      `actual_uses[${index}].receipt_visible_at_handoff must be boolean`);
    return Object.freeze({
      kind: oneOf(item.kind, useKinds, `actual_uses[${index}].kind`),
      title: boundedText(item.title, `actual_uses[${index}].title`, { max: 160 }),
      effect: boundedText(item.effect, `actual_uses[${index}].effect`, { max: 360 }),
      receipt_visible_at_handoff: item.receipt_visible_at_handoff,
    });
  });

  const rawLearning = exactObject(root.learning, learningFields, "learning");
  assert(typeof rawLearning.receipt_visible_at_handoff === "boolean",
    "learning.receipt_visible_at_handoff must be boolean");
  const learning = Object.freeze({
    state: oneOf(rawLearning.state, learningStates, "learning.state"),
    finding: boundedText(rawLearning.finding, "learning.finding", { max: 480, empty: true }),
    status: boundedText(rawLearning.status, "learning.status", { max: 240, empty: true }),
    future_use: boundedText(rawLearning.future_use, "learning.future_use", { max: 480, empty: true }),
    receipt_visible_at_handoff: rawLearning.receipt_visible_at_handoff,
  });
  if (learning.state === "none") {
    assert(!learning.finding && !learning.status && !learning.future_use && !learning.receipt_visible_at_handoff,
      "empty learning facts cannot claim content or an earlier receipt");
  } else {
    assert(learning.finding && learning.status && learning.future_use,
      "learning facts require finding, status, and future_use");
  }

  const rawFiles = exactObject(root.files, fileFields, "files");
  const files = Object.freeze({
    state: oneOf(rawFiles.state, fileStates, "files.state"),
    known_location: boundedText(rawFiles.known_location, "files.known_location", { max: 1_024, empty: true }),
    decision_summary: boundedText(rawFiles.decision_summary, "files.decision_summary", { max: 480, empty: true }),
  });
  if (files.state === "none") {
    assert(!files.known_location && !files.decision_summary,
      "empty file facts cannot claim a location or disposition");
  } else {
    assert(files.known_location && files.decision_summary,
      "delivered files require a known location and disposition summary");
  }

  const rawNext = exactObject(root.next, nextFields, "next");
  const next = Object.freeze({
    overall_goal: boundedText(rawNext.overall_goal, "next.overall_goal", { max: 480 }),
    overall_goal_state: oneOf(rawNext.overall_goal_state, goalStates, "next.overall_goal_state"),
    action: boundedText(rawNext.action, "next.action", { max: 1_200 }),
    reason: boundedText(rawNext.reason, "next.reason", { max: 720 }),
    owner: boundedText(rawNext.owner, "next.owner", { max: 480 }),
    user_decision: oneOf(rawNext.user_decision, decisionStates, "next.user_decision"),
    decision_prompt: boundedText(rawNext.decision_prompt, "next.decision_prompt", { max: 720, empty: true }),
  });
  assert(next.user_decision === "required" ? next.decision_prompt.length > 0 : next.decision_prompt.length === 0,
    "next.decision_prompt must match whether a user decision is required");
  if (files.state === "decision-needed") {
    assert(next.user_decision === "required", "an unresolved file disposition requires a user decision in next");
  }

  return Object.freeze({
    schema_version: 1,
    language: oneOf(root.language, languages, "language"),
    event: oneOf(root.event, events, "event"),
    continuation: oneOf(root.continuation, continuations, "continuation"),
    complex: root.complex,
    draft,
    actual_uses: Object.freeze(uses),
    learning,
    files,
    next,
  });
}

function localizedTitles(language) {
  const chinese = language === "zh-CN";
  return Object.freeze({
    use: chinese ? "🧠 这次用上了" : "🧠 Used this time",
    learningObserved: chinese ? "🌱 这一步还在学习" : "🌱 Still learning",
    learningSaved: chinese ? "🌱 这一步我学到了" : "🌱 Learned this step",
    next: chinese ? "👉 接下来" : "👉 What's next",
  });
}

function normalizeStandaloneHeading(line) {
  let value = line.trim().replace(/^>\s*/u, "").replace(/^#{1,6}\s+/u, "").trim();
  if (value.startsWith("**") && value.endsWith("**") && value.length > 4) value = value.slice(2, -2).trim();
  return value;
}

function titlePosition(draft, title) {
  let offset = 0;
  for (const line of draft.split("\n")) {
    const trimmed = line.trim();
    const tableTitle = trimmed.startsWith("|") && trimmed.split("|").some((cell) => cell.trim() === title);
    if (normalizeStandaloneHeading(line) === title || tableTitle) return offset + line.indexOf(title);
    offset += line.length + 1;
  }
  return -1;
}

function hasHeadingAfter(draft, position) {
  const remainder = draft.slice(position).split("\n").slice(1);
  return remainder.some((line) => /^\s*>?\s*#{1,6}\s+\S/u.test(line));
}

function unique(values) {
  return [...new Set(values)];
}

function closeoutReport(issues, language) {
  const chinese = language === "zh-CN";
  const labels = chinese
    ? {
      "use-receipt": "实际使用回执",
      "learning-receipt": "阶段学习回执",
      "file-disposition": "文件去向说明",
      "next-action": "真实下一步",
    }
    : {
      "use-receipt": "actual-use receipt",
      "learning-receipt": "stage-learning receipt",
      "file-disposition": "file disposition",
      "next-action": "real next action",
    };
  const resolved = issues.map((issue) => labels[issue] ?? (chinese ? "收尾顺序" : "closeout order"));
  const summary = resolved.length > 0
    ? resolved.join(chinese ? "、" : ", ")
    : (chinese ? "收尾信息" : "closeout details");
  if (!chinese) {
    return Object.freeze({
      impact: `The completed result remains deliverable, but the final reply is missing or misplacing: ${summary}.`,
      data_state: "Completed work, files, and user data remain unchanged; only the current reply closeout is repaired.",
      recoverability: "The missing closeout can be rebuilt from current task facts and the draft without rerunning the task.",
      still_usable: "The conversation, completed result, and unrelated capabilities remain available.",
      next_step: "Complete the missing closeout and keep “👉 What's next” as the final visible block before sending the reply.",
      user_summary: `The completed result remains deliverable; repair only ${summary}, without rerunning finished work.`,
    });
  }
  return Object.freeze({
    impact: `业务结果仍可交付，但最终回复还缺少或放错了${summary}。`,
    data_state: "已完成的任务结果、文件和用户数据保持不变；这里只修复当前回复的收尾。",
    recoverability: "可以从当前任务事实和草稿重建缺失部分，不需要重跑业务任务。",
    still_usable: "对话、已完成结果和其他能力继续可用。",
    next_step: "请补齐缺失收尾、保持“👉 接下来”为最后一个用户可见区块，再发送最终回复。",
    user_summary: `业务结果仍可交付；只需补齐${summary}，不重跑已经完成的工作。`,
  });
}

export function degradedTaskCloseout(reason = "closeout facts are unavailable", language = "zh-CN") {
  if (language !== "zh-CN") {
    return Object.freeze({
      decision: "task-closeout-degraded",
      executable: false,
      businessDeliveryAllowed: true,
      closeoutOnly: true,
      requiredSections: Object.freeze(["next-action"]),
      missingSections: Object.freeze(["closeout-facts"]),
      issues: Object.freeze(["closeout-facts-unavailable"]),
      reason: String(reason).slice(0, 240),
      userReport: Object.freeze({
        impact: "The complex-task closeout facts cannot be fully confirmed, but the completed result is not withheld.",
        data_state: "Completed work, files, and user data remain unchanged; uncertain claims are not fabricated.",
        recoverability: "Closeout facts can be rebuilt from the current task record, tool results, or continuation summary.",
        still_usable: "The conversation, completed result, and unrelated capabilities remain available.",
        next_step: "Deliver confirmed results, report the local closeout degradation, then rebuild only the missing receipt and real next action.",
        user_summary: "The completed result remains deliverable; closeout checking degraded locally and missing facts must be rebuilt truthfully.",
      }),
    });
  }
  return Object.freeze({
    decision: "task-closeout-degraded",
    executable: false,
    businessDeliveryAllowed: true,
    closeoutOnly: true,
    requiredSections: Object.freeze(["next-action"]),
    missingSections: Object.freeze(["closeout-facts"]),
    issues: Object.freeze(["closeout-facts-unavailable"]),
    reason: String(reason).slice(0, 240),
    userReport: Object.freeze({
      impact: "复杂任务的收尾事实暂时不能完整确认，但业务结果不会因此被扣住。",
      data_state: "已完成结果、文件和用户数据保持不变；没有把不确定信息伪造成回执。",
      recoverability: "可以从当前任务记录、工具结果或续接摘要重建收尾事实。",
      still_usable: "对话、已完成结果和其他能力继续可用。",
      next_step: "先如实交付已确认结果并说明收尾检查已降级，再重建缺失回执和真实下一步。",
      user_summary: "业务结果可继续交付；收尾检查已局部降级，缺失事实需要如实重建。",
    }),
  });
}

export function taskCloseoutInputTemplate(language = "zh-CN") {
  return Object.freeze({
    schema_version: 1,
    language: languages.has(language) ? language : "zh-CN",
    event: "complete",
    continuation: "same-context",
    complex: true,
    draft: "",
    actual_uses: Object.freeze([]),
    learning: Object.freeze({
      state: "none", finding: "", status: "", future_use: "", receipt_visible_at_handoff: false,
    }),
    files: Object.freeze({ state: "none", known_location: "", decision_summary: "" }),
    next: Object.freeze({
      overall_goal: "",
      overall_goal_state: "in-progress",
      action: "",
      reason: "",
      owner: "",
      user_decision: "none",
      decision_prompt: "",
    }),
  });
}

export function evaluateTaskCloseout(input) {
  let facts;
  try {
    facts = normalizeFacts(input);
  } catch (error) {
    const language = input && typeof input === "object" && languages.has(input.language) ? input.language : "zh-CN";
    return degradedTaskCloseout(error instanceof Error ? error.message : String(error), language);
  }

  const titles = localizedTitles(facts.language);
  const unreportedUses = facts.actual_uses.filter((item) => !item.receipt_visible_at_handoff);
  const learningNeedsReceipt = facts.learning.state !== "none" && !facts.learning.receipt_visible_at_handoff;
  const requiredSections = ["next-action"];
  if (unreportedUses.length > 0) requiredSections.unshift("use-receipt");
  if (learningNeedsReceipt) requiredSections.splice(requiredSections.length - 1, 0, "learning-receipt");
  if (facts.files.state !== "none") requiredSections.splice(requiredSections.length - 1, 0, "file-disposition");

  const positions = {
    use: titlePosition(facts.draft, titles.use),
    learningObserved: titlePosition(facts.draft, titles.learningObserved),
    learningSaved: titlePosition(facts.draft, titles.learningSaved),
    next: titlePosition(facts.draft, titles.next),
  };
  const expectedLearningPosition = facts.learning.state === "saved"
    ? positions.learningSaved
    : positions.learningObserved;
  const issues = [];
  const missingSections = [];

  if (positions.next < 0) {
    missingSections.push("next-action");
    issues.push("missing-next-heading");
  } else {
    const nextBlock = facts.draft.slice(positions.next);
    const nextStatements = [
      facts.next.overall_goal,
      facts.next.action,
      facts.next.reason,
      facts.next.owner,
      ...(facts.next.user_decision === "required" ? [facts.next.decision_prompt] : []),
    ];
    if (nextStatements.some((statement) => !nextBlock.includes(statement))) {
      missingSections.push("next-action");
      issues.push("next-action-is-incomplete");
    }
    if (hasHeadingAfter(facts.draft, positions.next)) issues.push("next-is-not-final-visible-block");
  }

  if (unreportedUses.length > 0) {
    if (positions.use < 0) {
      missingSections.push("use-receipt");
      issues.push("missing-use-receipt");
    } else {
      const useBlock = facts.draft.slice(positions.use, positions.next >= 0 ? positions.next : undefined);
      for (const item of unreportedUses) {
        if (!useBlock.includes(item.title) || !useBlock.includes(item.effect)) {
          missingSections.push("use-receipt");
          issues.push(`use-receipt-missing-${item.kind}`);
        }
      }
    }
  } else if (positions.use >= 0) {
    issues.push("unneeded-use-receipt");
  }

  if (learningNeedsReceipt) {
    if (expectedLearningPosition < 0) {
      missingSections.push("learning-receipt");
      issues.push("missing-learning-receipt");
    } else {
      const learningBlock = facts.draft.slice(expectedLearningPosition, positions.next >= 0 ? positions.next : undefined);
      for (const required of ["💡", "📌", "➡️", facts.learning.finding, facts.learning.status, facts.learning.future_use]) {
        if (!learningBlock.includes(required)) {
          missingSections.push("learning-receipt");
          issues.push("incomplete-learning-receipt");
          break;
        }
      }
    }
  } else if (positions.learningObserved >= 0 || positions.learningSaved >= 0) {
    issues.push("unneeded-learning-receipt");
  }

  if (facts.files.state !== "none") {
    if (!facts.draft.includes(facts.files.known_location) || !facts.draft.includes(facts.files.decision_summary)) {
      missingSections.push("file-disposition");
      issues.push("missing-file-disposition");
    }
  }

  for (const position of [positions.use, positions.learningObserved, positions.learningSaved]) {
    if (position >= 0 && positions.next >= 0 && position > positions.next) issues.push("receipt-after-next-action");
  }

  const uniqueIssues = unique(issues);
  const uniqueMissing = unique(missingSections);
  const ready = uniqueIssues.length === 0;
  return Object.freeze({
    decision: ready ? "task-closeout-ready" : "task-closeout-repair-required",
    validationScope: "receipt-completeness-only-not-application-or-task-success",
    executable: false,
    businessDeliveryAllowed: true,
    closeoutOnly: true,
    requiredSections: Object.freeze(unique(requiredSections)),
    missingSections: Object.freeze(uniqueMissing),
    issues: Object.freeze(uniqueIssues),
    continuation: facts.continuation,
    userReport: ready ? null : closeoutReport(uniqueMissing.length > 0 ? uniqueMissing : uniqueIssues, facts.language),
  });
}

function runCli() {
  try {
    if (process.argv.includes("--template")) {
      const language = process.argv.includes("--english") ? "en" : "zh-CN";
      process.stdout.write(`${JSON.stringify(taskCloseoutInputTemplate(language), null, 2)}\n`);
      return;
    }
    const chunks = [];
    let total = 0;
    while (total <= MAX_TASK_CLOSEOUT_INPUT_BYTES) {
      const buffer = Buffer.alloc(Math.min(8_192, MAX_TASK_CLOSEOUT_INPUT_BYTES + 1 - total));
      const count = readSync(0, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    if (total > MAX_TASK_CLOSEOUT_INPUT_BYTES) {
      process.stdout.write(`${JSON.stringify(degradedTaskCloseout("task closeout input exceeds the local byte budget"))}\n`);
      return;
    }
    const raw = Buffer.concat(chunks, total);
    const parsed = JSON.parse(raw.toString("utf8"));
    process.stdout.write(`${JSON.stringify(evaluateTaskCloseout(parsed))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(degradedTaskCloseout(error instanceof Error ? error.message : String(error)))}\n`);
  }
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) runCli();
