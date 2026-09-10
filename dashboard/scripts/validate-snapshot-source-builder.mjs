import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildSnapshotCandidate, computeSnapshotSourceDigest } from "./snapshot-source-builder.mjs";
import { parseCurrentSnapshotEnvelope } from "./snapshot-envelope.mjs";
import { validateSnapshotSemantics } from "./snapshot-semantics.mjs";
import { buildStartupCapsule } from "./startup-capsule-contract.mjs";
import { createSkillDelivery } from "./skill-package.mjs";

const assert = (condition, message) => { if (!condition) throw new Error(`Snapshot source builder contract failed: ${message}`); };
const root = mkdtempSync(join(tmpdir(), "ai-carry-snapshot-builder-"));
let complete = false;
const write = (ref, source) => { const path = resolve(root, ...ref.split("/")); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source, "utf8"); };
const manifest = (mission = "帮助用户整理学习平台成绩。") => `schema_version = 1
instance_id = "ac-snapshot-fixture"
state = "instance"
created_from = "ai-carry@test"
created_at = "2026-08-24T00:00:00+08:00"

[direction]
type = "domain"
locked = true
domain_id = "education"
label = "教育"
scope_statement = "教育工作"
out_of_scope_policy = "create-new-instance"

[profile]
status = "active"
guidance_mode = "balanced"
display_name = "学习平台成绩助手"
mission = ${JSON.stringify(mission)}
language = "zh-CN"
user_preferences_ref = "instance/profile/approved-profile.md"
domain_map_ref = "instance/maps/domain-map.toml"
signal_control_ref = "instance/signals/control.toml"
signal_map_ref = "instance/maps/signal-map.toml"
time_trigger_map_ref = "instance/maps/time-trigger-map.toml"
host_registry_ref = "instance/hosts/registry.toml"

[learning]
policy = "risk-tiered"
low_risk_promotion = "explicit-confirmation-after-notice"
medium_high = "explicit-confirmation"
direct_user_instruction = "direct-authorization"

[validation]
evidence_index_ref = "instance/validations/index.toml"

[versions]
product = "2.0.8"
asset_schema = "1.2"
evolution_candidate_index_schema = "1.0"
asset_confirmation_gate_schema = "1.0"
result_validation_evidence_schema = "1.0"
`;

try {
  write("AGENTS.md", "# fixture\n"); write("BOOTSTRAP.md", "# fixture\n"); write("core/maps/root-map.toml", "schema_version = 1\n");
  write("assistant.toml", `schema_version = 1
product_id = "ai-carry"
product_name = "AI Carry"
product_version = "2.0.8"
core_version = "2.0.8"

[bootstrap]
maximum_characters = 20000
`);
  write("core/manifest.toml", `schema_version = 1
core_id = "ai-carry-core"
version = "2.0.8"
asset_schema = "1.2"
evolution_candidate_index_schema = "1.0"
asset_confirmation_gate_schema = "1.0"
result_validation_evidence_schema = "1.0"

[entry]
root_map = "core/maps/root-map.toml"
result_validation_evidence_index = "instance/validations/index.toml"

[contracts]
asset_confirmation_gate_registry = "core/maps/asset-confirmation-gates.toml"
asset_confirmation_gate_schema = "core/schemas/asset-confirmation-gates.schema.md"
result_validation_evidence_schema = "core/schemas/result-validation-evidence-index.schema.md"
`);
  write("core/schemas/asset-confirmation-gates.schema.md", "# fixture\n");
  write("core/schemas/result-validation-evidence-index.schema.md", "# fixture\n");
  write("core/maps/asset-confirmation-gates.toml", `schema_version = 1
registry_id = "asset-confirmation-gates"

[[gates]]
id = "none"
phase = "none"
summary = "无需额外确认。"
legacy_aliases = []

[[gates]]
id = "risk-dependent-before-action"
phase = "before-action"
summary = "按风险确认。"
legacy_aliases = []
`);
  write("instance/manifest.toml", manifest());
  write("instance/validations/index.toml", `schema_version = 1
index_id = "result-validations"
instance_id = "ac-snapshot-fixture"
state = "empty"
source_revision = 0
generated_at = ""
budget_bytes = 262144
overflow = false
record_count = 0
`);
  write("instance/startup-capsule.toml", buildStartupCapsule(root).source);
  write("instance/profile/approved-profile.md", "# 已确认档案\n");
  for (const directory of ["memory", "capabilities", "sops", "experiences", "evolution", "todo", "governance", "deferred"]) write(`instance/${directory}/README.md`, "# fixture\n");
  write("instance/signals/control.toml", "schema_version = 1\n"); write("instance/maps/signal-map.toml", "schema_version = 1\n");
  write("instance/skills/requirements.toml", `schema_version = 1
instance_id = "ac-snapshot-fixture"
generated_at = "2026-08-24T00:00:00+08:00"
status = "current"

[[skills]]
id = "skill.grade-review"
title = "成绩复核 Skill"
summary = "按需复核成绩汇总结果。"
triggers = ["帮我复核成绩"]
platform = "fixture"
entry = "skills/grade-review/SKILL.md"
source = "https://example.invalid/grade-review"
state = "available"
confirmed_at = "2026-08-24T00:00:00+08:00"
`);
  write("instance/skills/exports/index.toml", `schema_version = 1
index_id = "skill-exports"
instance_id = "ac-snapshot-fixture"
generated_at = "2026-08-24T00:00:00+08:00"
export_count = 1

[[exports]]
id = "grade-summary-share"
title = "成绩汇总方法"
summary = "把通用成绩汇总步骤整理为可复用方法。"
source_asset_id = "sop.grade-summary"
source_kind = "sop"
state = "ready"
entry = "instance/skills/exports/grade-summary-share/SKILL.md"
generated_at = "2026-08-24T00:00:00+08:00"
`);
  write("instance/skills/exports/grade-summary-share/SKILL.md", `---
name: grade-summary-share
description: Summarize and review tabular results when the user asks.
---
# Workflow
Confirm the input columns, produce a summary, and review the result.
`);
  write("instance/evolution/index.toml", `schema_version = 1
index_id = "evolution-candidates"
instance_id = "ac-snapshot-fixture"
state = "empty"
source_revision = 0
generated_at = "2026-08-24T00:00:00+08:00"
budget_bytes = 32768
overflow = false
candidate_count = 0
indexed_count = 0
active_count = 0
`);
  write("instance/components/audio-transcriber/component.toml", `schema_version = 1
record_type = "ai-carry-instance-component"
component_id = "audio-transcriber"
instance_id = "ac-snapshot-fixture"
kind = "local-tool-adapter"
status = "active"
title = "离线转写适配器"
summary = "验证结构化本机绑定和私密引用不会泄漏到快照。"
component_version = "1.0.0"
root = "instance/components/audio-transcriber"
load_policy = "on-demand-only"

[ownership]
portable_paths = ["component.toml"]
derived_paths = []
device_local_paths = [".assistant-local/tools/offline-transcriber"]
private_collection_refs = ["private://component/audio-transcriber"]
unclassified_policy = "stop-and-preview"

[interfaces]
provides = ["capability.audio-transcription@1"]
requires = ["ai-carry.instance-component@1"]

[upgrade]
criticality = "optional"
activation = "next-session"
compatible_action = "preserve"
incompatible_action = "disable-and-preserve"
migration_ids = []
second_run = "no-change"
`);
  write("instance/sops/grade-summary.md", `+++
id = "sop.grade-summary"
kind = "sop"
status = "active"
title = "汇总学习平台成绩"
summary = "按用户确认的方法汇总并核对成绩。"
triggers = ["帮我整理学习平台成绩"]
aliases = ["上次的成绩整理方法"]
topic_key = "grade-summary"
subject_key = "learning-platform"
scope = ["学习平台成绩汇总"]
conditions = ["用户要求汇总"]
excludes = ["修改原始成绩"]
lifecycle = "recurring"
expected_next_use = ""
related_asset_ids = []
body_sections = []
source_refs = []
private_refs = ["private://private.collection.grade-workflow/context.md"]
supersedes = []
minimum_level = 2
confirmation = "none"
approval_state = "explicit"
activation_basis = "explicit-user"
risk_tier = "low"
approved_by_user = true
maturity = "unvalidated"
independent_task_count = 0
successful_use_count = 0
failed_use_count = 0
distinct_context_count = 0
distinct_host_count = 0
last_validated_at = ""
validation_refs = []
host_experience_refs = []
updated_at = ""
+++
# 使用方法
先核对输入列，再生成可回读结果。
`);
  write("instance/maps/domain-map.toml", `schema_version = 1
map_id = "instance-domain"
instance_id = "ac-snapshot-fixture"
direction = "education"
status = "active"

[budget]
soft_max_bytes = 32768
hard_max_bytes = 49152
soft_max_routes = 96
hard_max_routes = 128
max_route_bytes = 2048
candidate_limit = 3
overflow_state = "ok"

[[routes]]
id = "sop.grade-summary"
asset_kind = "sop"
title = "汇总学习平台成绩"
summary = "按用户确认的方法汇总并核对成绩。"
triggers = ["帮我整理学习平台成绩"]
aliases = ["上次的成绩整理方法"]
topic_key = "grade-summary"
subject_key = "learning-platform"
scope = ["学习平台成绩汇总"]
conditions = ["用户要求汇总"]
excludes = ["修改原始成绩"]
related_asset_ids = []
body_sections = []
target = "instance/sops/grade-summary.md"
state = "active"
minimum_level = 2
confirmation = "none"
`);

  const first = buildSnapshotCandidate(root, { now: new Date("2026-08-24T04:00:00+08:00") });
  const snapshot = parseCurrentSnapshotEnvelope(first.source, "generated fixture");
  validateSnapshotSemantics(snapshot, "generated fixture");
  const expectedIdentity = `ac-${createHash("sha256").update("ac-snapshot-fixture", "utf8").digest("hex").slice(0, 12)}`;
  assert(first.updated && first.identityRef === expectedIdentity && snapshot.meta.identity_ref === expectedIdentity, "instance identity was not derived from instance_id");
  assert(snapshot.assets.sops === 1 && snapshot.sops[0]?.id === "sop.grade-summary" && snapshot.sops[0]?.maturity === "unvalidated", "formal source was not projected from the trusted map/body pair");
  assert(snapshot.assets.skills === 1 && snapshot.skills.items?.[0]?.id === "skill.grade-review"
    && snapshot.skills.items[0].title === "成绩复核 Skill" && snapshot.skills.items[0].entry === undefined
    && snapshot.skills.items[0].source === undefined && snapshot.skills.exports?.[0]?.id === "grade-summary-share"
    && snapshot.skills.exports[0].delivery_method === "" && snapshot.skills.exports[0].delivery_state === "unselected"
    && snapshot.skills.exports[0].source_asset_id === undefined && snapshot.skills.exports[0].entry === undefined,
  "Skill workshop projection did not expose exactly the low-sensitivity installed/export metadata");
  assert(!first.source.includes("private://") && !first.source.includes("private.collection.grade-workflow"), "a validated private locator leaked into the snapshot projection");
  assert(!first.source.includes("audio-transcriber") && !first.source.includes(".assistant-local"), "component-local or private locator metadata leaked into the snapshot projection");
  assert(snapshot.meta.source_digest === computeSnapshotSourceDigest(root).digest, "source digest did not match an independent deterministic rebuild");
  const repeated = buildSnapshotCandidate(root, { existingSource: first.source, now: new Date("2026-08-24T05:00:00+08:00") });
  assert(!repeated.updated && repeated.source === first.source, "unchanged formal truth refreshed generated_at or bytes");
  const legacyEnvelope = `// Agent Carry snapshot envelope v1\nwindow.AGENT_CARRY_IS_REAL = true;\nwindow.AGENT_CARRY_SNAPSHOT = ${JSON.stringify(snapshot, null, 2)};\n`;
  const normalizedLegacy = buildSnapshotCandidate(root, { existingSource: legacyEnvelope, now: new Date("2026-08-24T04:00:00+08:00") });
  assert(normalizedLegacy.updated && normalizedLegacy.source === first.source,
    "a legacy Agent Carry envelope suppressed current AI Carry snapshot normalization");

  const exportIndexPath = resolve(root, "instance/skills/exports/index.toml");
  const exportIndexBytes = readFileSync(exportIndexPath);
  const exportIndexSource = exportIndexBytes.toString("utf8");
  const exportSourcePath = resolve(root, "instance/skills/exports/grade-summary-share/SKILL.md");
  const exportSourceBytes = readFileSync(exportSourcePath);
  const delivery = createSkillDelivery(resolve(root, "instance/skills/exports/grade-summary-share"), {
    format: "zip",
    outputPath: resolve(root, "instance/skills/shares/grade-summary-share/grade-summary-share-fixture.zip"),
  });
  const deliveryFields = `delivery_method = "zip"
delivery_state = "artifact-ready"
delivery_ref = "instance/skills/shares/grade-summary-share/grade-summary-share-fixture.zip"
delivery_source_digest = "${delivery.sourceDigest}"
delivery_digest = "${delivery.artifactDigest}"
delivery_generated_at = "2026-08-24T04:30:00+08:00"
`;
  writeFileSync(exportIndexPath, exportIndexBytes.toString("utf8").replace(
    'entry = "instance/skills/exports/grade-summary-share/SKILL.md"\ngenerated_at = "2026-08-24T00:00:00+08:00"\n',
    `entry = "instance/skills/exports/grade-summary-share/SKILL.md"\ngenerated_at = "2026-08-24T00:00:00+08:00"\n${deliveryFields}`,
  ));
  const delivered = buildSnapshotCandidate(root, { existingSource: first.source, now: new Date("2026-08-24T05:01:00+08:00") });
  assert(delivered.snapshot.skills.exports?.[0]?.delivery_method === "zip"
    && delivered.snapshot.skills.exports[0].delivery_state === "artifact-ready"
    && !delivered.source.includes("grade-summary-share-fixture.zip") && !delivered.source.includes(delivery.artifactDigest),
  "a verified delivery carrier was not projected as low-sensitivity artifact-ready state");
  writeFileSync(exportSourcePath, Buffer.concat([exportSourceBytes, Buffer.from("\n# changed\n", "utf8")]));
  const staleDelivery = buildSnapshotCandidate(root, { existingSource: delivered.source, now: new Date("2026-08-24T05:02:00+08:00") });
  assert(staleDelivery.snapshot.skills.exports?.[0]?.delivery_state === "stale", "changed editable Skill content did not locally mark its old carrier stale");
  writeFileSync(exportSourcePath, exportSourceBytes);
  rmSync(resolve(root, "instance/skills/shares/grade-summary-share/grade-summary-share-fixture.zip"), { force: false });
  const missingDelivery = buildSnapshotCandidate(root, { existingSource: delivered.source, now: new Date("2026-08-24T05:02:30+08:00") });
  assert(missingDelivery.snapshot.skills.exports?.[0]?.delivery_state === "stale",
    "a missing Skill carrier did not stay local and degrade its artifact-ready projection to stale");
  writeFileSync(exportIndexPath, exportIndexBytes);
  rmSync(resolve(root, "instance/skills/shares"), { recursive: true, force: true });
  const restoredDelivery = buildSnapshotCandidate(root, { existingSource: first.source, now: new Date("2026-08-24T05:03:00+08:00") });
  assert(!restoredDelivery.updated && restoredDelivery.source === first.source, "delivery projection fixture did not restore its exact legacy source state");

  const compatibleExports = exportIndexSource.replace(/^generated_at = .*$/gmu, 'generated_at = ""')
    .replace("export_count = 1", "export_count = 99");
  writeFileSync(exportIndexPath, compatibleExports);
  const undatedExports = buildSnapshotCandidate(root, { mode: "operational" });
  assert(undatedExports.snapshot.skills.exports.length === 1
    && readFileSync(exportIndexPath, "utf8") === compatibleExports,
  "unused timestamps or stale counts hid a usable export or caused an implicit write");
  const mixedExports = `${compatibleExports}\n[[exports]]\nid = "broken-export"\nstate = "unknown"\n`;
  writeFileSync(exportIndexPath, mixedExports);
  const partiallyAvailableExports = buildSnapshotCandidate(root, { mode: "operational" });
  assert(partiallyAvailableExports.snapshot.skills.exports.length === 1
    && partiallyAvailableExports.snapshot.skills.exports[0].id === "grade-summary-share"
    && partiallyAvailableExports.diagnostics.some((item) => item.code === "skill-export-entry-invalid")
    && readFileSync(exportIndexPath, "utf8") === mixedExports,
  "one invalid export hid a valid sibling, was not reported, or rewrote source bytes");
  let requiredExportBlocked = false;
  try { buildSnapshotCandidate(root, { mode: "operational", requiredSourceRefs: ["instance/skills/exports/index.toml"] }); }
  catch { requiredExportBlocked = true; }
  assert(requiredExportBlocked, "a transaction's required export source bypassed validation");
  writeFileSync(exportIndexPath, exportIndexSource);

  const skillRequirementsPath = resolve(root, "instance/skills/requirements.toml");
  const skillRequirementsBytes = readFileSync(skillRequirementsPath);
  write("instance/skills/requirements.toml", `${skillRequirementsBytes.toString("utf8")}
[[skills]]
id = "skill.grade-review"
title = "重复的成绩复核 Skill"
summary = "用于验证重复 ID 只隔离 Skill 区域。"
triggers = ["重复测试"]
platform = "fixture"
state = "review"

[[skills]]
id = "skill.independent"
title = "独立有效 Skill"
summary = "另一个条目重复不应隐藏我。"
state = "available"
`);
  const duplicateSkillBytes = readFileSync(skillRequirementsPath);
  let strictDuplicateSkillBlocked = false;
  try { buildSnapshotCandidate(root, { existingSource: first.source, now: new Date("2026-08-24T05:05:00+08:00") }); }
  catch { strictDuplicateSkillBlocked = true; }
  assert(strictDuplicateSkillBlocked, "strict snapshot mode accepted duplicate installed Skill IDs");
  const operationalSkills = buildSnapshotCandidate(root, { existingSource: first.source,
    now: new Date("2026-08-24T05:05:00+08:00"), mode: "operational" });
  validateSnapshotSemantics(operationalSkills.snapshot, "operational duplicate-Skill fixture");
  assert(operationalSkills.snapshot.assets.sops === 1 && operationalSkills.snapshot.sops[0]?.id === "sop.grade-summary"
    && operationalSkills.snapshot.assets.skills === 1 && operationalSkills.snapshot.skills.count === 1
    && operationalSkills.snapshot.skills.items?.[0]?.id === "skill.independent"
    && operationalSkills.diagnostics.some((item) => item.area === "skills" && item.code === "skill-entry-invalid")
    && operationalSkills.snapshot.health?.state === "degraded",
  "operational snapshot did not isolate both duplicate IDs while preserving the valid sibling and other assets");
  assert(readFileSync(skillRequirementsPath).equals(duplicateSkillBytes),
    "operational duplicate-Skill isolation changed the source bytes");
  writeFileSync(skillRequirementsPath, skillRequirementsBytes);

  const brokenTodoRef = "instance/todo/broken-unrelated.md";
  const brokenTodoSource = `+++
id = "todo.broken-unrelated"
kind = "todo"
status = "pending"
visible = true
title = "暂时无效但必须原样保留"
summary = "这个条目用于验证局部隔离。"
unexpected_field = "must-survive-byte-for-byte"
+++
# fixture
`;
  write(brokenTodoRef, brokenTodoSource);
  const brokenTodoBytes = readFileSync(resolve(root, brokenTodoRef));
  let strictBrokenTodoBlocked = false;
  try { buildSnapshotCandidate(root, { existingSource: first.source, now: new Date("2026-08-24T05:10:00+08:00") }); }
  catch { strictBrokenTodoBlocked = true; }
  assert(strictBrokenTodoBlocked, "strict snapshot mode accepted an invalid unrelated TODO");
  const operational = buildSnapshotCandidate(root, { existingSource: first.source, now: new Date("2026-08-24T05:10:00+08:00"), mode: "operational" });
  const operationalSnapshot = parseCurrentSnapshotEnvelope(operational.source, "operational degraded fixture");
  validateSnapshotSemantics(operationalSnapshot, "operational degraded fixture");
  assert(operational.updated && operational.mode === "operational" && operational.diagnostics.length === 1
    && operational.diagnostics[0].area === "todo" && operationalSnapshot.health?.state === "degraded"
    && operationalSnapshot.health?.isolated_item_count === 1 && operationalSnapshot.health?.source_data_preserved === true
    && operationalSnapshot.todo.length === 0 && operationalSnapshot.assets.todo === 0,
  "operational snapshot did not isolate exactly one unrelated invalid TODO with a bounded health warning");
  assert(operational.sourceDigest === computeSnapshotSourceDigest(root).digest,
    "operational isolation removed the preserved source bytes from the deterministic digest");
  assert(readFileSync(resolve(root, brokenTodoRef)).equals(brokenTodoBytes),
    "operational isolation changed the invalid TODO source bytes");
  let currentTargetBlocked = false;
  try {
    buildSnapshotCandidate(root, { existingSource: first.source, now: new Date("2026-08-24T05:10:00+08:00"), mode: "operational",
      requiredSourceRefs: [brokenTodoRef] });
  } catch { currentTargetBlocked = true; }
  assert(currentTargetBlocked && readFileSync(resolve(root, brokenTodoRef)).equals(brokenTodoBytes),
    "an invalid current target was isolated instead of being denied with zero source writes");
  rmSync(resolve(root, brokenTodoRef), { force: true });

  // 输出上限不是故障上限：超过 64 个坏项也保留健康内容和全部真源。
  const manyBadRefs = Array.from({ length: 65 }, (_, index) => `instance/todo/broken-${index}.md`);
  for (const ref of manyBadRefs) write(ref, brokenTodoSource);
  const manyBad = buildSnapshotCandidate(root, { mode: "operational" });
  assert(manyBad.snapshot.health?.isolated_item_count === 65 && manyBad.diagnostics.length === 64
    && manyBad.snapshot.sops.length > 0 && manyBad.snapshot.skills.items.length > 0,
  "diagnostic output limit stopped healthy content or misreported the isolated total");
  for (const ref of manyBadRefs) {
    assert(readFileSync(resolve(root, ref), "utf8") === brokenTodoSource, "diagnostic aggregation modified source content");
    rmSync(resolve(root, ref));
  }

  const formalRef = "instance/sops/grade-summary.md";
  const formalBytes = readFileSync(resolve(root, formalRef));
  // Loss of authorization is a real isolation boundary. An unknown harmless
  // field is covered by the compatible-reader journey, not treated as damage.
  write(formalRef, readFileSync(resolve(root, formalRef), "utf8").replace("approved_by_user = true", "approved_by_user = false"));
  const corruptedFormalBytes = readFileSync(resolve(root, formalRef));
  const candidateRef = "instance/evolution/unindexed-broken.md";
  write(candidateRef, "not candidate frontmatter; preserve exactly\n");
  const candidateBytes = readFileSync(resolve(root, candidateRef));
  let strictFormalCandidateBlocked = false;
  try { buildSnapshotCandidate(root, { existingSource: first.source, now: new Date("2026-08-24T05:20:00+08:00") }); }
  catch { strictFormalCandidateBlocked = true; }
  assert(strictFormalCandidateBlocked, "strict snapshot mode accepted invalid formal/candidate sources");
  const boundedAssets = buildSnapshotCandidate(root, { existingSource: first.source,
    now: new Date("2026-08-24T05:20:00+08:00"), mode: "operational" });
  assert(boundedAssets.snapshot.health?.isolated_item_count === 2
    && boundedAssets.diagnostics.some((item) => item.area === "sops")
    && boundedAssets.diagnostics.some((item) => item.area === "evolution")
    && boundedAssets.snapshot.sops.length === 0 && boundedAssets.snapshot.evolution.length === 0
    && readFileSync(resolve(root, formalRef)).equals(corruptedFormalBytes)
    && readFileSync(resolve(root, candidateRef)).equals(candidateBytes),
  "operational snapshot did not isolate unrelated formal/candidate sources without changing bytes");
  let requiredFormalBlocked = false; let requiredCandidateBlocked = false;
  try { buildSnapshotCandidate(root, { mode: "operational", requiredSourceRefs: [formalRef] }); }
  catch { requiredFormalBlocked = true; }
  try { buildSnapshotCandidate(root, { mode: "operational", requiredSourceRefs: [candidateRef] }); }
  catch { requiredCandidateBlocked = true; }
  assert(requiredFormalBlocked && requiredCandidateBlocked && readFileSync(resolve(root, candidateRef)).equals(candidateBytes),
    "an invalid required formal/candidate target was silently isolated");
  writeFileSync(resolve(root, formalRef), formalBytes);
  rmSync(resolve(root, candidateRef), { force: true });

  write("instance/sops/unsafe-private-ref.md", "+++\nprivate_refs = [\"C:/Users/example/private.txt\"]\n+++\n# fixture\n");
  let unsafePrivateRefBlocked = false; try { computeSnapshotSourceDigest(root); } catch { unsafePrivateRefBlocked = true; }
  assert(unsafePrivateRefBlocked, "an absolute location hidden in private_refs bypassed source safety");
  rmSync(resolve(root, "instance/sops/unsafe-private-ref.md"), { force: true });

  const validComponentManifest = readFileSync(resolve(root, "instance/components/audio-transcriber/component.toml"), "utf8");
  write("instance/components/audio-transcriber/component.toml", validComponentManifest.replace(
    'private_collection_refs = ["private://component/audio-transcriber"]',
    'private_collection_refs = ["C:/Users/example/private.txt"]',
  ));
  let unsafeComponentPrivateRefBlocked = false; try { computeSnapshotSourceDigest(root); } catch { unsafeComponentPrivateRefBlocked = true; }
  assert(unsafeComponentPrivateRefBlocked, "an absolute component private_collection_ref bypassed source safety");
  write("instance/components/audio-transcriber/component.toml", validComponentManifest.replace(
    'device_local_paths = [".assistant-local/tools/offline-transcriber"]',
    'device_local_paths = ["C:/Users/example/tool"]',
  ));
  let unsafeComponentLocalPathBlocked = false; try { computeSnapshotSourceDigest(root); } catch { unsafeComponentLocalPathBlocked = true; }
  assert(unsafeComponentLocalPathBlocked, "an absolute component device_local_path bypassed source safety");
  write("instance/components/audio-transcriber/component.toml", validComponentManifest);

  const forged = JSON.parse(JSON.stringify(snapshot)); forged.meta.source_digest = `sha256:${"a".repeat(64)}`;
  const forgedSource = first.source.replace(JSON.stringify(snapshot, null, 2), JSON.stringify(forged, null, 2));
  assert(buildSnapshotCandidate(root, { existingSource: forgedSource, now: new Date("2026-08-24T05:00:00+08:00") }).updated, "a self-consistent-looking forged digest suppressed a real rebuild");

  write("instance/manifest.toml", manifest("帮助用户安全整理与复核学习平台成绩。"));
  let staleCapsuleBlocked = false; try { buildSnapshotCandidate(root, { existingSource: first.source }); } catch { staleCapsuleBlocked = true; }
  assert(staleCapsuleBlocked, "a stale startup capsule was ignored during snapshot maintenance");
  write("instance/startup-capsule.toml", buildStartupCapsule(root).source);
  const changed = buildSnapshotCandidate(root, { existingSource: first.source, now: new Date("2026-08-24T06:00:00+08:00") });
  assert(changed.updated && changed.sourceDigest !== first.sourceDigest && changed.snapshot.profile.mission.includes("安全整理"), "changed current truth did not produce a new deterministic candidate");

  write("instance/profile/local-note.md", ["token = sk", "-", "abcdefghijklmnopqrstuvwxyz123456", "\n"].join(""));
  let secretBlocked = false; try { buildSnapshotCandidate(root); } catch { secretBlocked = true; }
  assert(secretBlocked, "a secret hidden in an otherwise unprojected instance file entered the snapshot source set");
  rmSync(resolve(root, "instance/profile/local-note.md"), { force: true });

  write("instance/profile/local-note.md", "location = C:/Users/example/private.txt\n");
  let locationBlocked = false; try { buildSnapshotCandidate(root); } catch { locationBlocked = true; }
  assert(locationBlocked, "an absolute local location hidden in the instance source set was accepted");
  rmSync(resolve(root, "instance/profile/local-note.md"), { force: true });

  complete = true;
  console.log("Snapshot source builder passed mixed valid/invalid Skill lists, count/date tolerance, strict source boundaries, stale delivery, local isolation and unchanged source bytes.");
} finally {
  if (complete) rmSync(root, { recursive: true, force: true });
  else console.error(`Snapshot failure evidence kept at ${root}`);
}
