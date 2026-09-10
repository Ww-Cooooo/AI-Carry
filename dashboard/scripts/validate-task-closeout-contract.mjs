import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_TASK_CLOSEOUT_INPUT_BYTES, evaluateTaskCloseout } from "./task-closeout-contract.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const closeoutCli = resolve(scriptDirectory, "task-closeout-contract.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(`Task closeout contract self-test failed: ${message}`);
}

function incidentFacts(draft, continuation = "same-context") {
  return {
    schema_version: 1,
    language: "zh-CN",
    event: "complete",
    continuation,
    complex: true,
    draft,
    actual_uses: [
      { kind: "skill", title: "视频深读 Skill", effect: "定位关键画面和证据", receipt_visible_at_handoff: false },
      { kind: "skill", title: "浏览器能力", effect: "复用已授权连接完成核验", receipt_visible_at_handoff: false },
      { kind: "preference", title: "本地连接复用偏好", effect: "避免重复要求用户授权", receipt_visible_at_handoff: false },
    ],
    learning: {
      state: "observed",
      finding: "可恢复的媒体参数错误不应迫使整项任务重跑",
      status: "已在本次任务验证，尚未保存为长期资产",
      future_use: "以后先隔离失败步骤并复用已完成产物",
      receipt_visible_at_handoff: false,
    },
    files: {
      state: "decision-needed",
      known_location: "C:\\demo-output",
      decision_summary: "这些视频目前保留在本机，尚未决定是否纳入以后迁移",
    },
    next: {
      overall_goal: "手偶 AI 口播受控试剪还没有完成。",
      overall_goal_state: "in-progress",
      action: "建议先选择 A、B、C 或一种混搭风格。",
      reason: "这样我才能按你认可的方向进入真实素材前的首项任务交接门。",
      owner: "这一步由你选择风格；你选定后由我继续执行，交接门以前不会索取真实素材。",
      user_decision: "required",
      decision_prompt: "请同时确认这些视频只留本机，还是也纳入以后迁移。",
    },
  };
}

const omitted = evaluateTaskCloseout(incidentFacts([
  "三支演示视频已经生成并核验。",
  "文件位于 C:\\demo-output。",
  "有一个媒体参数错误已自动修复。",
  "任务开始前曾计划使用视频深读 Skill 和浏览器能力。",
].join("\n")));
assert(omitted.decision === "task-closeout-repair-required", "the incident-shaped omission was accepted");
assert(["use-receipt", "learning-receipt", "file-disposition", "next-action"]
  .every((section) => omitted.missingSections.includes(section)),
"the incident omission did not identify all four missing closeout responsibilities");
assert(omitted.businessDeliveryAllowed === true && omitted.closeoutOnly === true,
  "a closeout omission incorrectly blocked the completed business result");
assert(omitted.userReport.user_summary.includes("实际使用回执")
  && !omitted.userReport.user_summary.includes("use-receipt"),
"the repair report exposed internal section codes instead of novice-facing language");

const correctedDraft = [
  "三支演示视频已经生成并核验。",
  "文件位于 C:\\demo-output。",
  "这些视频目前保留在本机，尚未决定是否纳入以后迁移",
  "",
  "**🧠 这次用上了**",
  "- 视频深读 Skill：定位关键画面和证据",
  "- 浏览器能力：复用已授权连接完成核验",
  "- 本地连接复用偏好：避免重复要求用户授权",
  "",
  "| 🌱 这一步还在学习 | 内容 |",
  "| --- | --- |",
  "| 💡 发现 | 可恢复的媒体参数错误不应迫使整项任务重跑 |",
  "| 📌 状态 | 已在本次任务验证，尚未保存为长期资产 |",
  "| ➡️ 以后会这样做 | 以后先隔离失败步骤并复用已完成产物 |",
  "",
  "**👉 接下来**",
  "手偶 AI 口播受控试剪还没有完成。",
  "建议先选择 A、B、C 或一种混搭风格。",
  "这样我才能按你认可的方向进入真实素材前的首项任务交接门。",
  "这一步由你选择风格；你选定后由我继续执行，交接门以前不会索取真实素材。",
  "请同时确认这些视频只留本机，还是也纳入以后迁移。",
].join("\n");
const corrected = evaluateTaskCloseout(incidentFacts(correctedDraft));
assert(corrected.validationScope === "receipt-completeness-only-not-application-or-task-success",
  "complete receipts were presented as proof of correct application or task success");
assert(corrected.decision === "task-closeout-ready" && corrected.missingSections.length === 0,
  "the corrected incident closeout did not pass");

const compacted = evaluateTaskCloseout(JSON.parse(JSON.stringify(incidentFacts(correctedDraft, "context-compacted"))));
assert(compacted.decision === "task-closeout-ready" && compacted.continuation === "context-compacted",
  "serialized context-compaction facts changed the closeout result");

const simple = evaluateTaskCloseout({
  schema_version: 1,
  language: "en",
  event: "complete",
  continuation: "same-context",
  complex: false,
  draft: [
    "The typo is fixed.",
    "",
    "**👉 What's next**",
    "The page-label correction is complete.",
    "Open the page and confirm the label.",
    "This confirms the visible result in your actual environment.",
    "You only need to look; the Agent will handle any correction you report.",
  ].join("\n"),
  actual_uses: [],
  learning: { state: "none", finding: "", status: "", future_use: "", receipt_visible_at_handoff: false },
  files: { state: "none", known_location: "", decision_summary: "" },
  next: {
    overall_goal: "The page-label correction is complete.",
    overall_goal_state: "complete",
    action: "Open the page and confirm the label.",
    reason: "This confirms the visible result in your actual environment.",
    owner: "You only need to look; the Agent will handle any correction you report.",
    user_decision: "none",
    decision_prompt: "",
  },
});
assert(simple.decision === "task-closeout-ready" && simple.requiredSections.length === 1,
  "a simple task was burdened with empty use, learning, or file receipts");

const alreadyReportedFacts = incidentFacts([
  "结果已经交付。",
  "文件位于 C:\\demo-output。",
  "这些视频目前保留在本机，尚未决定是否纳入以后迁移",
  "",
  "**👉 接下来**",
  "手偶 AI 口播受控试剪还没有完成。",
  "建议先选择 A、B、C 或一种混搭风格。",
  "这样我才能按你认可的方向进入真实素材前的首项任务交接门。",
  "这一步由你选择风格；你选定后由我继续执行，交接门以前不会索取真实素材。",
  "请同时确认这些视频只留本机，还是也纳入以后迁移。",
].join("\n"));
alreadyReportedFacts.actual_uses = alreadyReportedFacts.actual_uses
  .map((item) => ({ ...item, receipt_visible_at_handoff: true }));
alreadyReportedFacts.learning = { ...alreadyReportedFacts.learning, receipt_visible_at_handoff: true };
const alreadyReported = evaluateTaskCloseout(alreadyReportedFacts);
assert(alreadyReported.decision === "task-closeout-ready"
  && !alreadyReported.requiredSections.includes("use-receipt")
  && !alreadyReported.requiredSections.includes("learning-receipt"),
"a timely earlier receipt was forced to repeat at final handoff");

const degraded = evaluateTaskCloseout({ schema_version: 1, draft: "partial" });
assert(degraded.decision === "task-closeout-degraded"
  && degraded.businessDeliveryAllowed === true
  && degraded.missingSections.includes("closeout-facts")
  && degraded.userReport.still_usable.includes("继续可用"),
"invalid closeout metadata did not degrade locally while preserving the business result");
const englishDegraded = evaluateTaskCloseout({ schema_version: 1, language: "en", draft: "partial" });
assert(englishDegraded.decision === "task-closeout-degraded"
  && englishDegraded.userReport.user_summary.includes("completed result remains deliverable"),
"an English closeout degradation did not stay in the user's language");

const wrongOrder = evaluateTaskCloseout(incidentFacts(`${correctedDraft}\n\n## 详细证据`));
assert(wrongOrder.decision === "task-closeout-repair-required"
  && wrongOrder.issues.includes("next-is-not-final-visible-block"),
"a next-action block followed by another visible section was accepted");

const cliReadyRun = spawnSync(process.execPath, [closeoutCli], {
  input: JSON.stringify(incidentFacts(correctedDraft)), encoding: "utf8", windowsHide: true,
});
assert(cliReadyRun.status === 0 && JSON.parse(cliReadyRun.stdout).decision === "task-closeout-ready",
  "the real stdin CLI path did not accept the corrected closeout");
const cliTemplateRun = spawnSync(process.execPath, [closeoutCli, "--template"], {
  encoding: "utf8", windowsHide: true,
});
const cliTemplate = JSON.parse(cliTemplateRun.stdout);
assert(cliTemplateRun.status === 0 && cliTemplate.schema_version === 1
  && Array.isArray(cliTemplate.actual_uses) && cliTemplate.next.overall_goal_state === "in-progress",
"the local CLI did not expose a bounded fill-in template");
const cliOversizeRun = spawnSync(process.execPath, [closeoutCli], {
  input: Buffer.alloc(MAX_TASK_CLOSEOUT_INPUT_BYTES + 1, 0x61), encoding: "utf8", windowsHide: true,
});
const cliOversize = JSON.parse(cliOversizeRun.stdout);
assert(cliOversizeRun.status === 0 && cliOversize.decision === "task-closeout-degraded"
  && cliOversize.businessDeliveryAllowed === true,
"oversized local input was not bounded and degraded without blocking the business result");

console.log("Task closeout contract passed the incident omission, corrected closeout, context compaction, simple task, earlier receipt, local degradation, final-block, real CLI, fill-in template, and byte-budget checks.");
