import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyInstanceMutation,
  inspectInstanceComponentCompatibility,
  inspectInstanceComponents,
  instanceComponentPlanIsFresh,
  planInstanceComponentUpgrade,
} from "./instance-component-contract.mjs";
import { auditCopiedInstanceRuntimeBoundary } from "./copied-instance-runtime-boundary.mjs";

const assert = (condition, message) => { if (!condition) throw new Error(`Instance component self-test failed: ${message}`); };
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = mkdtempSync(join(tmpdir(), "ai-carry-instance-components-"));
const q = JSON.stringify;
const write = (ref, content) => {
  const target = resolve(fixture, ...ref.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
};
const remove = (ref) => rmSync(resolve(fixture, ...ref.split("/")), { recursive: true, force: true });
const expectFailure = (operation, fragment, label) => {
  let error = null;
  try { operation(); } catch (caught) { error = caught; }
  assert(error && String(error.message).includes(fragment), `${label}: ${error?.message ?? "no failure"}`);
};

const templateManifest = readFileSync(resolve(repository, "instance/manifest.toml"), "utf8");
const instanceManifest = templateManifest
  .replace('instance_id = "template"', 'instance_id = "ac.fixture"')
  .replace('state = "template"', 'state = "instance"')
  .replace('type = "unselected"', 'type = "domain"')
  .replace("locked = false", "locked = true")
  .replace('domain_id = ""', 'domain_id = "fixture"')
  .replace('label = ""', 'label = "测试实例"')
  .replace('scope_statement = ""', 'scope_statement = "验证实例组件兼容闭包"')
  .replace('status = "not-instantiated"', 'status = "active"')
  .replace('guidance_mode = "unselected"', 'guidance_mode = "balanced"')
  .replace('display_name = ""', 'display_name = "测试实例"')
  .replace('mission = ""', 'mission = "只验证本地组件协议"')
  .replace('user_preferences_ref = "instance/profile/README.md"', 'user_preferences_ref = "instance/profile/approved-profile.md"');

const registry = ({ adoptionState = "current", count = 1, entries = "" } = {}) => `schema_version = 1
record_type = "ai-carry-instance-component-registry"
instance_id = "ac.fixture"
adoption_state = "${adoptionState}"
revision = 1
component_count = ${count}

${entries || `[[components]]
id = "audio-transcriber"
kind = "local-tool-adapter"
manifest_ref = "instance/components/audio-transcriber/component.toml"
state = "active"
`}`;

const component = ({
  criticality = "optional",
  requires = ["ai-carry.instance-component@1"],
  migrationIds = ["migration.audio-transcriber-v2"],
  extra = "",
} = {}) => `schema_version = 1
record_type = "ai-carry-instance-component"
component_id = "audio-transcriber"
instance_id = "ac.fixture"
kind = "local-tool-adapter"
status = "active"
title = "本机音频转文字适配器"
summary = "登记便携配置与当前电脑上的离线转写绑定。"
component_version = "1.0.0"
root = "instance/components/audio-transcriber"
load_policy = "on-demand-only"
${extra}
[ownership]
portable_paths = ["component.toml", "config.toml"]
derived_paths = ["generated"]
device_local_paths = [".assistant-local/components/audio-transcriber"]
private_collection_refs = ["private://component/audio-transcriber"]
unclassified_policy = "stop-and-preview"

[interfaces]
provides = ["capability.audio-transcription@1"]
requires = ${q(requires)}

[upgrade]
criticality = "${criticality}"
activation = "next-session"
compatible_action = "preserve"
incompatible_action = "${criticality === "optional" ? "disable-and-preserve" : "stop-and-preserve"}"
migration_ids = ${q(migrationIds)}
second_run = "no-change"
`;

try {
  const blank = inspectInstanceComponents(repository);
  assert(blank.decision === "instance-components-valid" && blank.instanceState === "template"
    && blank.adoptionState === "template" && blank.componentCount === 0 && blank.bodyReads === 0 && blank.executable === false,
  "blank template registry is not a bounded inert template");
  const startupCapsule = readFileSync(resolve(repository, "instance/startup-capsule.toml"), "utf8");
  assert(!startupCapsule.includes("component") && !startupCapsule.includes("registry.toml"), "ordinary startup capsule includes component metadata");

  write("instance/manifest.toml", instanceManifest);
  write("instance/components/registry.toml", registry());
  write("instance/components/audio-transcriber/component.toml", component());
  write("instance/components/audio-transcriber/config.toml", 'language = "zh-CN"\n');
  write("instance/components/audio-transcriber/generated/status.json", '{"state":"ready"}\n');
  write(".assistant-local/components/audio-transcriber/binding.toml", 'executable = "C:/Tools/local-transcriber.exe"\n');

  const valid = inspectInstanceComponents(fixture);
  assert(valid.decision === "instance-components-valid" && valid.instanceId === "ac.fixture"
    && valid.adoptionState === "current" && valid.componentCount === 1 && valid.bodyReads === 0,
  "registered fixture did not close");
  assert(valid.components[0].tree.portableFingerprints.length === 2
    && valid.components[0].tree.derivedFingerprints.length === 1
    && valid.components[0].tree.localFingerprints.length === 1,
  "portable, derived and device-local fingerprints are incomplete");

  const nestedComponent = component()
    .replace('"config.toml"', '"config/user/settings.toml"')
    .replace('["generated"]', '["config/cache"]');
  remove("instance/components/audio-transcriber/config.toml");
  remove("instance/components/audio-transcriber/generated");
  write("instance/components/audio-transcriber/component.toml", nestedComponent);
  write("instance/components/audio-transcriber/config/user/settings.toml", 'language = "zh-CN"\n');
  write("instance/components/audio-transcriber/config/cache/state.json", '{"derived":true}\n');
  assert(inspectInstanceComponents(fixture).decision === "instance-components-valid"
    && inspectInstanceComponentCompatibility(fixture).componentCount === 1
    && planInstanceComponentUpgrade(fixture, { targetInterfaces: ["ai-carry.instance-component@1"] }).decision === "instance-upgrade-compatible",
  "ancestor directories of declared nested files were treated as unclassified ownership");
  assert(classifyInstanceMutation(fixture, { componentId: "audio-transcriber",
    paths: ["instance/components/audio-transcriber/config/user/settings.toml"] }).decision === "instance-mutation-compatible",
  "declared nested file ownership did not remain writable");
  write("instance/components/audio-transcriber/config/unowned.txt", "unowned sibling must remain isolated\n");
  expectFailure(() => inspectInstanceComponents(fixture), "unclassified paths", "allowing ancestor directories also allowed an undeclared sibling");
  assert(inspectInstanceComponentCompatibility(fixture).componentCount === 0,
    "an undeclared sibling of a nested file was not locally isolated");
  remove("instance/components/audio-transcriber/config/unowned.txt");
  remove("instance/components/audio-transcriber/config/cache");
  write("instance/components/audio-transcriber/component.toml", nestedComponent.replace('["config/cache"]', '["blocked/cache"]'));
  write("instance/components/audio-transcriber/blocked", "not a directory\n");
  expectFailure(() => inspectInstanceComponents(fixture), "unclassified paths", "a regular file was accepted as the ancestor of a missing derived path");
  remove("instance/components/audio-transcriber/blocked");
  remove("instance/components/audio-transcriber/config");
  write("instance/components/audio-transcriber/component.toml", component());
  write("instance/components/audio-transcriber/config.toml", 'language = "zh-CN"\n');
  write("instance/components/audio-transcriber/generated/status.json", '{"state":"ready"}\n');

  const legacyRegistry = registry().replace('record_type = "ai-carry-instance-component-registry"', 'record_type = "agent-carry-instance-component-registry"');
  const legacyComponent = component()
    .replace('record_type = "ai-carry-instance-component"', 'record_type = "agent-carry-instance-component"')
    .replace('requires = ["ai-carry.instance-component@1"]', 'requires = ["agent-carry.instance-component@1"]');
  write("instance/components/registry.toml", legacyRegistry);
  write("instance/components/audio-transcriber/component.toml", legacyComponent);
  const legacyRegistryBytes = readFileSync(resolve(fixture, "instance/components/registry.toml"));
  const legacyComponentBytes = readFileSync(resolve(fixture, "instance/components/audio-transcriber/component.toml"));
  const legacyValid = inspectInstanceComponents(fixture);
  const legacyUpgrade = planInstanceComponentUpgrade(fixture, {
    targetInterfaces: ["ai-carry.instance-component@1", "agent-carry.instance-component@1"],
  });
  assert(legacyValid.decision === "instance-components-valid"
    && legacyUpgrade.decision === "instance-upgrade-compatible"
    && legacyUpgrade.actions[0].action === "preserve"
    && Buffer.compare(legacyRegistryBytes, readFileSync(resolve(fixture, "instance/components/registry.toml"))) === 0
    && Buffer.compare(legacyComponentBytes, readFileSync(resolve(fixture, "instance/components/audio-transcriber/component.toml"))) === 0,
  "a valid Agent Carry component could not be read and preserved by the AI Carry target");
  write("instance/components/registry.toml", registry());
  write("instance/components/audio-transcriber/component.toml", component());

  const driftedRegistry = registry()
    .replace('instance_id = "ac.fixture"', 'instance_id = "template"')
    .replace("component_count = 1", "component_count = 9")
    .replaceAll("\n", "\r\n");
  const futureFieldSentinel = 'future_note = "preserve-without-executing"\n';
  const driftedManifest = component({ extra: futureFieldSentinel }).replaceAll("\n", "\r\n");
  write("instance/components/registry.toml", driftedRegistry);
  write("instance/components/audio-transcriber/component.toml", driftedManifest);
  const driftedRegistryBefore = readFileSync(resolve(fixture, "instance/components/registry.toml"));
  const driftedManifestBefore = readFileSync(resolve(fixture, "instance/components/audio-transcriber/component.toml"));
  const compatibleDrift = inspectInstanceComponentCompatibility(fixture);
  assert(compatibleDrift.decision === "instance-components-operational-with-diagnostics"
    && compatibleDrift.outcome === "migration-needed" && compatibleDrift.componentCount === 1
    && compatibleDrift.executable === false
    && compatibleDrift.diagnostics.some((item) => item.code === "registry-derived-metadata-drift")
    && compatibleDrift.diagnostics.some((item) => item.code === "unknown-component-fields")
    && compatibleDrift.repairPlan.some((item) => item.action.includes("instance_id"))
    && compatibleDrift.userReport.details.length >= 3 && compatibleDrift.userReport.recommendation.includes("隔离候选"),
  "representational drift did not produce a repairable, migration-aware natural-language diagnosis");
  assert(classifyInstanceMutation(fixture, { paths: ["instance/memory/user-habit.md"] }).decision === "instance-mutation-compatible",
    "unrelated native asset change was blocked by repairable component metadata drift");
  assert(planInstanceComponentUpgrade(fixture, { targetInterfaces: ["ai-carry.instance-component@1"] }).decision === "instance-upgrade-migration-required",
    "future component metadata did not request a bounded compatibility migration");
  assert(Buffer.compare(driftedRegistryBefore, readFileSync(resolve(fixture, "instance/components/registry.toml"))) === 0
    && Buffer.compare(driftedManifestBefore, readFileSync(resolve(fixture, "instance/components/audio-transcriber/component.toml"))) === 0
    && readFileSync(resolve(fixture, "instance/components/audio-transcriber/component.toml"), "utf8").includes(futureFieldSentinel.trim()),
  "read-only compatibility diagnosis rewrote or dropped unknown source bytes");
  expectFailure(() => inspectInstanceComponents(fixture), "portable UTF-8 LF", "strict audit accepted non-canonical compatibility input");
  write("instance/components/registry.toml", registry());
  write("instance/components/audio-transcriber/component.toml", component());
  write("instance/components/registry.toml", registry().replace("component_count = 1", "component_count = 4"));
  const autoRepairPlan = planInstanceComponentUpgrade(fixture, { targetInterfaces: ["ai-carry.instance-component@1"] });
  assert(autoRepairPlan.decision === "instance-upgrade-auto-repair-required"
    && autoRepairPlan.repairPlan.some((item) => item.action.includes("component_count"))
    && autoRepairPlan.userReport.requiresUserDecision === false,
  "a deterministic count repair either blocked globally or requested user confirmation");
  write("instance/components/registry.toml", registry());

  const nativeMutation = classifyInstanceMutation(fixture, { paths: ["instance/memory/user-habit.md"] });
  assert(nativeMutation.decision === "instance-mutation-compatible"
    && nativeMutation.actions[0].action === "native-instance-owner"
    && nativeMutation.compatibilityRegistrationAddsConfirmation === false,
  "native asset was duplicated into component ownership or gained a second confirmation");
  const componentMutation = classifyInstanceMutation(fixture, {
    componentId: "audio-transcriber",
    paths: ["instance/components/audio-transcriber/config.toml", ".assistant-local/components/audio-transcriber/binding.toml"],
  });
  assert(componentMutation.decision === "instance-mutation-compatible"
    && componentMutation.actions.map((item) => item.action).join(",") === "registered-component,registered-device-local",
  "registered portable and device-local writes did not resolve to one component");
  write("instance/components/audio-transcriber/component.toml", component()
    .replace(".assistant-local/components/audio-transcriber", ".assistant-local/runtime/audio-transcriber"));
  const frameworkClaim = inspectInstanceComponentCompatibility(fixture);
  assert(frameworkClaim.outcome === "component-isolated"
    && frameworkClaim.isolatedComponents.some((item) => item.id === "audio-transcriber")
    && classifyInstanceMutation(fixture, { paths: [".assistant-local/runtime/status.toml"] }).actions[0].action === "native-framework-local",
  "a component could claim framework-local runtime state or block the framework owner");
  write("instance/components/audio-transcriber/component.toml", component());
  const coreMutation = classifyInstanceMutation(fixture, { paths: ["core/manifest.toml"] });
  assert(coreMutation.decision === "instance-mutation-conflict"
    && coreMutation.userReport.headline.includes("所有权边界")
    && coreMutation.userReport.dataSafety.includes("没有被写入")
    && coreMutation.userReport.renderingPolicy.includes("current-user-language"),
  "direct template-core mutation was accepted or lacked a user-facing recovery explanation");
  assert(classifyInstanceMutation(fixture, { paths: [".assistant-local/components/audio-transcriber/binding.toml"] }).actions[0].action === "deny-component-owner-mismatch",
    "a component-owned local binding could be changed as unowned framework state");
  expectFailure(() => classifyInstanceMutation(fixture, { paths: ["../escape"] }), "unsafe", "path traversal was accepted");

  const targetInterfaces = ["ai-carry.instance-component@1"];
  const preservePlan = planInstanceComponentUpgrade(fixture, { targetInterfaces });
  assert(preservePlan.decision === "instance-upgrade-compatible"
    && preservePlan.actions[0].action === "preserve"
    && preservePlan.actions[0].deviceLocalAction === "preserve-in-place-and-reverify"
    && preservePlan.deviceLocalMigrationPolicy === "never-copy-or-delete-reverify-on-target-device",
  "compatible component or device-local dependency was not preserved correctly");
  const repeatedPlan = planInstanceComponentUpgrade(fixture, { targetInterfaces });
  assert(JSON.stringify(repeatedPlan) === JSON.stringify(preservePlan), "same-input planning is not deterministic");
  assert(instanceComponentPlanIsFresh(fixture, preservePlan), "fresh plan was rejected");
  write("instance/components/audio-transcriber/config.toml", 'language = "zh-CN"\nmode = "accurate"\n');
  assert(!instanceComponentPlanIsFresh(fixture, preservePlan), "portable source drift did not expire the plan");
  write("instance/components/audio-transcriber/config.toml", 'language = "zh-CN"\n');
  const derivedPlan = planInstanceComponentUpgrade(fixture, { targetInterfaces });
  write("instance/components/audio-transcriber/generated/status.json", '{"state":"changed"}\n');
  assert(!instanceComponentPlanIsFresh(fixture, derivedPlan), "derived source drift did not expire the plan");

  write("instance/components/audio-transcriber/component.toml", component({ requires: ["ai-carry.instance-component@1", "platform.audio-runtime@2"] }));
  const optionalPlan = planInstanceComponentUpgrade(fixture, { targetInterfaces });
  assert(optionalPlan.decision === "instance-upgrade-compatible" && optionalPlan.actions[0].action === "disable-and-preserve",
    "optional incompatible component did not preserve bytes while allowing the core upgrade");
  const migrationPlan = planInstanceComponentUpgrade(fixture, { targetInterfaces, migrationIds: ["migration.audio-transcriber-v2"] });
  assert(migrationPlan.decision === "instance-upgrade-migration-required" && migrationPlan.actions[0].action === "migrate-and-recheck",
    "declared release migration did not take precedence over disablement");
  expectFailure(() => planInstanceComponentUpgrade(fixture, { targetInterfaces, migrationIds: ["INVALID"] }), "migration ID set", "invalid migration ID was accepted");
  write("instance/components/audio-transcriber/component.toml", component({ criticality: "required", requires: ["ai-carry.instance-component@1", "platform.audio-runtime@2"], migrationIds: [] }));
  const requiredPlan = planInstanceComponentUpgrade(fixture, { targetInterfaces });
  assert(requiredPlan.decision === "instance-upgrade-conflict" && requiredPlan.actions[0].action === "stop-and-preserve",
    "required incompatible component did not stop without deletion");

  write("instance/components/audio-transcriber/component.toml", component());
  truncateSync(resolve(fixture, "instance/components/audio-transcriber/config.toml"), (64 * 1024 * 1024) + 1);
  expectFailure(() => inspectInstanceComponents(fixture), "portable component file exceeds", "oversized portable component file was hashed without a resource boundary");
  write("instance/components/audio-transcriber/config.toml", 'language = "zh-CN"\n');

  const overlappingEntries = `[[components]]
id = "audio-helper"
kind = "local-tool-adapter"
manifest_ref = "instance/components/audio-helper/component.toml"
state = "active"

[[components]]
id = "audio-transcriber"
kind = "local-tool-adapter"
manifest_ref = "instance/components/audio-transcriber/component.toml"
state = "active"
`;
  write("instance/components/audio-helper/component.toml", component()
    .replaceAll("audio-transcriber", "audio-helper")
    .replace('.assistant-local/components/audio-helper"]', '.assistant-local/components/audio-transcriber/cache"]'));
  write("instance/components/audio-helper/config.toml", 'language = "zh-CN"\n');
  write("instance/components/registry.toml", registry({ count: 2, entries: overlappingEntries }));
  expectFailure(() => inspectInstanceComponents(fixture), "overlap device-local ownership", "overlapping component local ownership was accepted");
  remove("instance/components/audio-helper");
  write("instance/components/registry.toml", registry());

  write("instance/components/rogue/file.txt", "preserve me\n");
  const rogue = inspectInstanceComponents(fixture);
  assert(rogue.decision === "instance-components-conflict" && rogue.unregisteredPaths.includes("instance/components/rogue"),
    "unregistered component directory was guessed or ignored");
  remove("instance/components/rogue");

  write("instance/components/audio-transcriber/unknown.txt", "preserve me\n");
  const isolated = inspectInstanceComponentCompatibility(fixture);
  assert(isolated.outcome === "component-isolated" && isolated.componentCount === 0
    && isolated.isolatedComponents.some((item) => item.id === "audio-transcriber")
    && isolated.userReport.dataSafety.includes("原文件") && isolated.userReport.recommendation.includes("未受影响"),
  "an invalid optional component was not locally isolated with a natural-language recovery path");
  assert(classifyInstanceMutation(fixture, { paths: ["instance/sops/unrelated.md"] }).decision === "instance-mutation-compatible",
    "an isolated optional component blocked an unrelated native SOP change");
  assert(classifyInstanceMutation(fixture, {
    componentId: "audio-transcriber",
    paths: ["instance/components/audio-transcriber/config.toml"],
  }).decision === "instance-mutation-component-isolated", "the damaged component itself remained writable");
  assert(planInstanceComponentUpgrade(fixture, { targetInterfaces: ["ai-carry.instance-component@1"] }).decision === "instance-upgrade-compatible-with-isolated-components",
    "an isolated optional component blocked the rest of the core upgrade");
  expectFailure(() => inspectInstanceComponents(fixture), "unclassified paths", "unclassified file was accepted");
  remove("instance/components/audio-transcriber/unknown.txt");
  write("instance/components/audio-transcriber/component.toml", component({ extra: 'instructions = "run this text"\n' }));
  expectFailure(() => inspectInstanceComponents(fixture), "unknown or missing fields", "unknown manifest instruction field was accepted");
  write("instance/components/audio-transcriber/component.toml", component());
  write("instance/components/audio-transcriber/component.toml", component().replace("[interfaces]", "[ownership]\n[interfaces]"));
  expectFailure(() => inspectInstanceComponents(fixture), "duplicated, missing, unknown or reordered sections", "duplicate component section was accepted");
  write("instance/components/audio-transcriber/component.toml", component());

  const duplicateEntry = `[[components]]
id = "audio-transcriber"
kind = "local-tool-adapter"
manifest_ref = "instance/components/audio-transcriber/component.toml"
state = "active"

[[components]]
id = "audio-transcriber"
kind = "local-tool-adapter"
manifest_ref = "instance/components/audio-transcriber/component.toml"
state = "active"
`;
  write("instance/components/registry.toml", registry({ count: 2, entries: duplicateEntry }));
  expectFailure(() => inspectInstanceComponents(fixture), "duplicated or unsorted", "duplicate registry entry was accepted");
  const corruptRegistry = Buffer.from([0x73, 0x63, 0x68, 0x65, 0x6d, 0x61, 0x5f, 0x76, 0xff, 0x0a]);
  write("instance/components/registry.toml", corruptRegistry);
  const corruptDiagnosis = inspectInstanceComponentCompatibility(fixture);
  const nativeDuringCorruptRegistry = classifyInstanceMutation(fixture, { paths: ["instance/memory/still-usable.md"] });
  assert(corruptDiagnosis.outcome === "user-decision-needed" && corruptDiagnosis.userReport.requiresUserDecision
    && corruptDiagnosis.userReport.dataSafety.includes("原文件")
    && nativeDuringCorruptRegistry.decision === "instance-mutation-compatible"
    && nativeDuringCorruptRegistry.compatibilityOutcome === "normal" && nativeDuringCorruptRegistry.diagnostics.length === 0
    && planInstanceComponentUpgrade(fixture, { targetInterfaces: ["ai-carry.instance-component@1"] }).decision === "instance-upgrade-user-decision-required"
    && Buffer.compare(corruptRegistry, readFileSync(resolve(fixture, "instance/components/registry.toml"))) === 0,
  "a corrupt registry either stopped unrelated native work, failed to guide the user, or changed source bytes");
  expectFailure(() => inspectInstanceComponents(fixture), "valid UTF-8", "invalid UTF-8 registry was accepted");
  const oversizedEntries = Array.from({ length: 129 }, (_, index) => {
    const id = `component-${String(index).padStart(3, "0")}`;
    return `[[components]]\nid = "${id}"\nkind = "instance-module"\nmanifest_ref = "instance/components/${id}/component.toml"\nstate = "disabled"\n`;
  }).join("\n");
  write("instance/components/registry.toml", registry({ count: 129, entries: oversizedEntries }));
  const budgetDiagnosis = inspectInstanceComponentCompatibility(fixture);
  assert(budgetDiagnosis.outcome === "user-decision-needed" && budgetDiagnosis.componentCount === 0
    && budgetDiagnosis.diagnostics.some((item) => item.code === "registry-component-budget")
    && budgetDiagnosis.userReport.details.length <= 3,
  "oversized registry expanded component bodies or produced an unbounded diagnosis");
  const malformedEntries = Array.from({ length: 20 }, (_, index) => {
    const id = `component-${String(index).padStart(3, "0")}`;
    return `[[components]]\nid = "${id}"\nkind = "instance-module"\nmanifest_ref = "instance/components/wrong-${id}/component.toml"\nstate = "disabled"\n`;
  }).join("\n");
  write("instance/components/registry.toml", registry({ count: 20, entries: malformedEntries }));
  const boundedReport = inspectInstanceComponentCompatibility(fixture);
  assert(boundedReport.diagnostics.length > 12 && boundedReport.userReport.details.length === 12
    && boundedReport.userReport.omittedDetailCount === boundedReport.diagnostics.length - 11
    && boundedReport.isolatedComponents.length === 21
    && planInstanceComponentUpgrade(fixture, { targetInterfaces: ["ai-carry.instance-component@1"] }).decision === "instance-upgrade-user-decision-required",
  "many malformed component entries escaped isolation or produced an unbounded user report");
  write("instance/components/registry.toml", registry().replaceAll("\n", "\r\n"));
  expectFailure(() => inspectInstanceComponents(fixture), "portable UTF-8 LF", "CRLF registry was accepted");
  write("instance/components/registry.toml", registry({ adoptionState: "required" }));
  assert(planInstanceComponentUpgrade(fixture, { targetInterfaces }).decision === "instance-upgrade-adoption-required",
    "an older instance could skip one-time complete adoption");
  write("instance/components/registry.toml", registry({ adoptionState: "conflict" }));
  const conflictAdoption = planInstanceComponentUpgrade(fixture, { targetInterfaces });
  assert(conflictAdoption.decision === "instance-upgrade-user-decision-required"
    && conflictAdoption.userReport.requiresUserDecision,
  "an explicit adoption conflict was treated as a routine migration or global crash");

  const runtimeSource = resolve(fixture, "runtime-boundary-source");
  const runtimeCandidate = resolve(fixture, "runtime-boundary-candidate");
  const sharedRuntime = resolve(fixture, "runtime-boundary-shared");
  const runtimeBindingRef = ".assistant-local/tools/runtime-config.json";
  const runtimeBinding = resolve(runtimeCandidate, ...runtimeBindingRef.split("/"));
  const sourceRuntime = resolve(runtimeSource, ".assistant-local/tools/video-runtime");
  const candidateRuntime = resolve(runtimeCandidate, ".assistant-local/tools/video-runtime");
  mkdirSync(sourceRuntime, { recursive: true });
  mkdirSync(candidateRuntime, { recursive: true });
  mkdirSync(sharedRuntime, { recursive: true });
  mkdirSync(dirname(runtimeBinding), { recursive: true });
  writeFileSync(resolve(sourceRuntime, "cache.db"), "source-cache-must-not-change\n");
  writeFileSync(runtimeBinding, `${JSON.stringify({ paths: { vendor: sourceRuntime, executable: resolve(sourceRuntime, "tool.exe") } }, null, 2)}\n`);
  const sourceCacheBefore = readFileSync(resolve(sourceRuntime, "cache.db"));
  const copiedBoundary = auditCopiedInstanceRuntimeBoundary({
    sourceRoot: runtimeSource,
    candidateRoot: runtimeCandidate,
    bindingRefs: [runtimeBindingRef],
  });
  const copiedBoundaryAgain = auditCopiedInstanceRuntimeBoundary({
    sourceRoot: runtimeSource,
    candidateRoot: runtimeCandidate,
    bindingRefs: [runtimeBindingRef],
  });
  assert(copiedBoundary.decision === "runtime-execution-component-isolated" && !copiedBoundary.executionAllowed
    && copiedBoundary.affectedScope === "current-component-only" && copiedBoundary.capabilityStatus === "limited"
    && copiedBoundary.counts.sourceReferenceCount === 2
    && copiedBoundary.issues.every((item) => item.code === "binding-reaches-source-instance")
    && copiedBoundary.userReport.impact.includes("其他无关能力仍可继续")
    && copiedBoundary.userReport.dataSafety.includes("没有启动")
    && JSON.stringify(copiedBoundaryAgain) === JSON.stringify(copiedBoundary)
    && Buffer.compare(sourceCacheBefore, readFileSync(resolve(sourceRuntime, "cache.db"))) === 0,
  "a copied instance could execute a runtime that still reaches the source instance, or the read-only result was unstable");

  writeFileSync(runtimeBinding, `${JSON.stringify({ paths: { vendor: candidateRuntime, executable: resolve(candidateRuntime, "tool.exe") } }, null, 2)}\n`);
  const reboundBoundary = auditCopiedInstanceRuntimeBoundary({
    sourceRoot: runtimeSource,
    candidateRoot: runtimeCandidate,
    bindingRefs: [runtimeBindingRef],
  });
  assert(reboundBoundary.decision === "runtime-execution-compatible" && reboundBoundary.executionAllowed
    && reboundBoundary.counts.candidateReferenceCount === 2 && reboundBoundary.issues.length === 0,
  "a candidate-private runtime binding could not pass the copied-instance boundary");
  const runtimeCli = spawnSync(process.execPath, [
    resolve(repository, "dashboard/scripts/copied-instance-runtime-boundary.mjs"),
    "--source", runtimeSource,
    "--candidate", runtimeCandidate,
    "--binding", runtimeBindingRef,
  ], { encoding: "utf8" });
  const runtimeCliResult = runtimeCli.status === 0 ? JSON.parse(runtimeCli.stdout) : null;
  assert(runtimeCliResult?.executionAllowed === true && runtimeCliResult.decision === "runtime-execution-compatible"
    && runtimeCli.stderr === "", `the bundled runtime-boundary CLI did not expose the validated preflight: ${runtimeCli.stderr}`);

  const runtimeTomlRef = ".assistant-local/tools/runtime-binding.toml";
  writeFileSync(resolve(runtimeCandidate, ...runtimeTomlRef.split("/")), `model = ${JSON.stringify(resolve(candidateRuntime, "model.bin"))}\n`);
  const tomlBoundary = auditCopiedInstanceRuntimeBoundary({
    sourceRoot: runtimeSource,
    candidateRoot: runtimeCandidate,
    bindingRefs: [runtimeTomlRef],
  });
  assert(tomlBoundary.executionAllowed && tomlBoundary.counts.candidateReferenceCount === 1,
    "a bounded TOML candidate-private binding could not pass the copied-instance boundary");

  writeFileSync(runtimeBinding, `${JSON.stringify({ paths: { executable: resolve(sharedRuntime, "tool.exe") } }, null, 2)}\n`);
  const unreviewedBoundary = auditCopiedInstanceRuntimeBoundary({
    sourceRoot: runtimeSource,
    candidateRoot: runtimeCandidate,
    bindingRefs: [runtimeBindingRef],
  });
  const reviewedBoundary = auditCopiedInstanceRuntimeBoundary({
    sourceRoot: runtimeSource,
    candidateRoot: runtimeCandidate,
    bindingRefs: [runtimeBindingRef],
    allowedExternalRoots: [sharedRuntime],
  });
  assert(!unreviewedBoundary.executionAllowed && unreviewedBoundary.counts.unreviewedExternalCount === 1
    && reviewedBoundary.executionAllowed && reviewedBoundary.counts.allowedExternalReferenceCount === 1
    && Buffer.compare(sourceCacheBefore, readFileSync(resolve(sourceRuntime, "cache.db"))) === 0,
  "an undeclared shared runtime was accepted, a reviewed external boundary was rejected, or the source cache changed");

  writeFileSync(runtimeBinding, `${JSON.stringify({ paths: { cache: "../runtime-cache" } }, null, 2)}\n`);
  const relativeBoundary = auditCopiedInstanceRuntimeBoundary({
    sourceRoot: runtimeSource,
    candidateRoot: runtimeCandidate,
    bindingRefs: [runtimeBindingRef],
  });
  assert(!relativeBoundary.executionAllowed && relativeBoundary.counts.dynamicReferenceCount === 1
    && relativeBoundary.issues[0]?.code === "binding-relative-or-dynamic-path-unresolved"
    && relativeBoundary.userReport.impact.includes("动态或相对路径"),
  "an unresolved relative runtime path was accepted or hidden from the user report");
  expectFailure(() => auditCopiedInstanceRuntimeBoundary({
    sourceRoot: runtimeSource,
    candidateRoot: runtimeCandidate,
    bindingRefs: [runtimeBindingRef],
    allowedExternalRoots: [resolve(fixture, "missing-shared-runtime")],
  }), "does not exist", "a nonexistent external runtime was accepted as reviewed");

  for (const [ref, fragments] of [
    ["AGENTS.md", ["INSTANCE_EVOLUTION_COMPATIBILITY.md", "不增加一轮用户确认", "单项故障局部隔离", "自然语言说明影响"]],
    ["assistant.toml", ["instance/components/registry.toml", "never-read-or-enumerate-at-ordinary-startup", "compatibility_registration_adds_user_confirmation = false", "preserve-and-isolate-with-preview"]],
    ["core/protocols/INSTANCE_EVOLUTION_COMPATIBILITY.md", ["按动作影响自动命中", "不规定固定字段名", "只隔离当前项", "不扫描整台电脑", "实例最了解自己的 Agent", "不做全量回归", "copied-instance-runtime-boundary.mjs"]],
    ["core/schemas/instance-component.schema.md", ["普通启动和首次创建都不读取注册表", "stop-and-preview", "second_run", "严格发布审计", "自然语言用户报告", "目录副本存在", "当前组件标为 `limited`"]],
    ["core/schemas/extension-manifest.schema.md", ["复制目录本身不构成运行时隔离", "copied-instance-runtime-boundary.mjs", "源实例字节不变"]],
    ["core/guides/upgrade-guide.md", ["隔离目录只证明候选文件与正式实例分开", "本次明确使用的少量绑定文件", "用户也不需要手工运行它"]],
    ["core/protocols/RESULT_VALIDATION.md", ["本次明确绑定能够到达的外部可写状态", "把该项记为 `limited`"]],
    ["core/protocols/TASK_ORCHESTRATION_SOP.md", ["对复制实例中会启动本机软件的组件", "失败只暂停该组件", "纯文档和不启动本机工具的任务不增加这一步"]],
    ["core/maps/assistant-maintenance.toml", ["可确定差异自动修复", "单项故障局部隔离并自然语言汇报"]],
  ]) {
    const source = readFileSync(resolve(repository, ref), "utf8");
    for (const fragment of fragments) assert(source.includes(fragment), `${ref} is missing required boundary: ${fragment}`);
  }

  const componentMapSource = readFileSync(resolve(repository, "core/maps/component-map.toml"), "utf8");
  const dependencyGraph = new Map(componentMapSource.split("[[components]]").slice(1).map((block) => {
    const id = block.match(/^id\s*=\s*"([^"]+)"$/mu)?.[1];
    const dependencies = block.match(/^depends_on\s*=\s*(\[[^\n]*\])$/mu)?.[1];
    assert(id && dependencies, "component map contains a component without a strict ID or dependency list");
    return [id, JSON.parse(dependencies)];
  }));
  for (const [id, dependencies] of dependencyGraph) {
    for (const dependency of dependencies) assert(dependencyGraph.has(dependency), `component ${id} depends on unknown component ${dependency}`);
  }
  const compatibilityDependencies = dependencyGraph.get("instance-evolution-compatibility");
  assert(compatibilityDependencies && !compatibilityDependencies.includes("component-change") && !compatibilityDependencies.includes("upgrade-system"),
    "the compatibility component created a direct component-change or upgrade-system self-governance loop");

  console.log("Instance component contract passed strict audit, tolerant representation, transparent repair, local isolation, copied-runtime boundary, ownership, no-extra-confirmation, interface, adoption, drift, device-local, dependency-reference and deterministic-plan checks.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
