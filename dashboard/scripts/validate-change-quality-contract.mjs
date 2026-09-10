import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { firstInstantiationWriteSet } from "./first-instantiation-transaction.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(message) {
  throw new Error(`Formal change-quality contract check failed: ${message}`);
}

function source(ref) {
  return readFileSync(resolve(repository, ...ref.split("/")), "utf8");
}

function includesAll(ref, fragments) {
  const text = source(ref);
  for (const fragment of fragments) if (!text.includes(fragment)) fail(`${ref} is missing: ${fragment}`);
  return text;
}

function excludesAll(ref, fragments) {
  const text = source(ref);
  for (const fragment of fragments) if (text.includes(fragment)) fail(`${ref} still carries retired coupling: ${fragment}`);
}

const expectedFirstCreation = [
  "instance/manifest.toml",
  "instance/profile/approved-profile.md",
  "instance/maps/domain-map.toml",
];
if (firstInstantiationWriteSet.length !== expectedFirstCreation.length
  || !expectedFirstCreation.every((ref) => firstInstantiationWriteSet.includes(ref))) {
  fail("first creation is no longer the three-file identity transaction");
}

// Verify the actual route, not a frozen slogan. This check cannot decide whether
// an Agent has applied a principle or delivered a good user-facing result.
includesAll("AGENTS.md", ["core/protocols/COMPONENT_CHANGE.md"]);
includesAll("core/protocols/COMPONENT_CHANGE.md", [
  "core/maps/component-map.toml",
  "INSTANCE_EVOLUTION_COMPATIBILITY.md",
]);
excludesAll("core/protocols/COMPONENT_CHANGE.md", [
  "只要一次正式动作会同时改变两个或更多耐久文件",
  "必须由 Level 3 负责判断与验收",
  "每次正式修改的完成流程",
]);

excludesAll("core/guides/first-use-execution-gates.md", [
  "三张长期治理卡单独计为",
  "只有用户已经明确确认当前模型处于 Level 3",
]);

const maintenanceMap = source("core/maps/assistant-maintenance.toml");
function maintenanceRoute(id) {
  return maintenanceMap.match(new RegExp(`\\[\\[routes\\]\\]\\s*id = "${id}"[\\s\\S]*?(?=\\n\\[\\[routes\\]\\]|$)`, "u"))?.[0] ?? "";
}
const compatibilityRoute = maintenanceRoute("instance-evolution-compatibility");
if (!compatibilityRoute.includes('target = "core/protocols/INSTANCE_EVOLUTION_COMPATIBILITY.md"')) {
  fail("durable instance changes do not converge on the shared compatibility agreement");
}
const dashboardActions = JSON.parse(source("dashboard/src/generated/dashboard-actions.json"));
const upgradeAction = dashboardActions.find((action) => action.action_id === "instance.upgrade-template");
if (!upgradeAction?.request.includes("core/protocols/INSTANCE_EVOLUTION_COMPATIBILITY.md")) {
  fail("the executable upgrade request does not use the shared compatibility agreement");
}

excludesAll("core/protocols/TASK_ORCHESTRATION_SOP.md", [
  "00-START-HERE.md",
  "10-CONTEXT.md",
  "result/EVIDENCE.md",
]);

includesAll("BOOTSTRAP.md", [
  "👉 接下来",
]);

includesAll("core/maps/component-map.toml", [
  "find-owner-and-affected-boundary",
  "update-smallest-true-source-while-preserving-user-private-and-unknown-content",
  "verify-only-the-affected-user-journey-and-local-failure-scope",
  "report-result-and-next-step",
]);

const lifecycle = source("core/maps/domain-lifecycle.toml");
const instantiationBlock = lifecycle.match(/\[\[routes\]\]\s*id = "instantiation"[\s\S]*?(?=\n\[\[routes\]\]|$)/u)?.[0] ?? "";
if (!instantiationBlock.includes("minimum_level = 1") || !instantiationBlock.includes("explicit-complete-preview-before-write")) {
  fail("instantiation route still treats a model label as an authorization gate");
}

const packageRoot = JSON.parse(source("dashboard/package.json"));
if (packageRoot.scripts.build.includes("check:change-quality") || packageRoot.scripts.build.includes("check:release")) {
  fail("ordinary build still replays maintenance or release audits");
}
if (!packageRoot.scripts.build.includes("check:actions") || packageRoot.scripts.build.includes("check:journeys")
  || !packageRoot.scripts["check:release"].includes("check:journeys")) {
  fail("ordinary build and once-per-release journey checks are not separated");
}

process.stdout.write(JSON.stringify({
  decision: "change-quality-contract-passed",
  first_creation_core_files: expectedFirstCreation.length,
  verification_scope: "source-policy-links-and-test-scheduling-not-runtime-behavior",
  ordinary_build_uses_release_audit: false,
}) + "\n");
