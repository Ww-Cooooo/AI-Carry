// Structured gate for the two formal, distributable template snapshots.
// It deliberately does not inspect source text with regular expressions: valid
// JSON-style quoted keys, comments, or formatting changes must not alter truth.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCurrentSnapshotEnvelope,
  parseSnapshotEnvelope,
  serializeSnapshotEnvelope,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_PREFIX,
  SNAPSHOT_SUFFIX,
} from "./snapshot-envelope.mjs";
import { validateSnapshotSemantics } from "./snapshot-semantics.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const root = resolve(option("--root") ?? fileURLToPath(new URL("../..", import.meta.url)));
const runSelfTest = args.includes("--self-test");

function assert(condition, message) {
  if (!condition) throw new Error(`Formal template snapshot validation failed: ${message}`);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function validateFormalTemplateSnapshot(snapshot, label = "snapshot") {
  assert(snapshot?.meta?.schema_version === "1.1", `${label} must use Snapshot Schema 1.1.`);
  assert(snapshot?.meta?.state === "template", `${label} meta.state must be template.`);
  assert(snapshot?.overview?.state === "template", `${label} overview.state must be template.`);
  assert(snapshot?.meta?.identity_ref === "template", `${label} identity_ref must be template.`);
  assert(snapshot?.profile?.guidance_mode === "unselected", `${label} guidance mode must remain unselected.`);
  assert(snapshot?.profile?.learning_policy === "unselected", `${label} learning policy must remain unselected.`);
  assert(snapshot?.profile?.domain_id === "uninstantiated", `${label} domain must remain uninstantiated.`);

  const emptyArrays = ["memories", "sops", "capabilities", "experiences", "evolution", "todo", "governance", "deferred", "changes"];
  for (const key of emptyArrays) {
    assert(Array.isArray(snapshot[key]), `${label}.${key} must be an array.`);
    assert(snapshot[key].length === 0, `${label}.${key} must be empty.`);
  }

  const assetKeys = ["memory", "sops", "capabilities", "experiences", "evolution", "todo", "governance", "skills"];
  assert(snapshot.assets && typeof snapshot.assets === "object" && !Array.isArray(snapshot.assets), `${label}.assets is missing.`);
  assert(Object.keys(snapshot.assets).sort().join("|") === [...assetKeys].sort().join("|"), `${label}.assets has an unexpected key set.`);
  for (const key of assetKeys) assert(snapshot.assets[key] === 0, `${label}.assets.${key} must be 0.`);
  assert(snapshot?.skills?.count === 0, `${label}.skills.count must be 0.`);

  const walk = (value, path = "$") => {
    if (typeof value === "string") {
      assert(!/(^|[^a-z0-9])mock[._:-]/i.test(value), `${label} contains a mock identifier at ${path}.`);
      assert(!/(maintainer[-_ ]only|synthetic[-_ ]demo|demo[-_ ]habit)/i.test(value), `${label} contains a private/demo marker at ${path}.`);
      return;
    }
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`));
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
    }
  };
  walk(snapshot);
}

function expectFailure(name, mutate, base) {
  const candidate = deepClone(base);
  mutate(candidate);
  let failed = false;
  try {
    validateFormalTemplateSnapshot(candidate, `self-test:${name}`);
  } catch {
    failed = true;
  }
  assert(failed, `negative self-test did not fail: ${name}`);
}

const publicPath = resolve(root, "dashboard/public/snapshot.js");
const distPath = resolve(root, "dashboard/dist/snapshot.js");
const [publicBytes, distBytes] = await Promise.all([readFile(publicPath), readFile(distPath)]);
assert(publicBytes.equals(distBytes), "dashboard/public/snapshot.js and dashboard/dist/snapshot.js are not byte-identical.");
const snapshot = parseCurrentSnapshotEnvelope(publicBytes.toString("utf8"), "formal snapshot");
validateSnapshotSemantics(snapshot, "formal snapshot");
validateFormalTemplateSnapshot(snapshot, "formal snapshot");

if (runSelfTest) {
  expectFailure("quoted-habit", (value) => {
    value.memories.push({ "id": ["mock", "memory", "habit"].join("."), "kind": "memory", "subtype": "habit", "status": "active" });
    value.assets.memory = 1;
  }, snapshot);
  expectFailure("ordinary-mock-memory", (value) => {
    value.memories.push({ id: ["mock", "memory", "general"].join("."), kind: "memory", subtype: "general", status: "active" });
    value.assets.memory = 1;
  }, snapshot);
  expectFailure("nonzero-asset", (value) => { value.assets.sops = 1; }, snapshot);
  expectFailure("instance-identity", (value) => { value.meta.identity_ref = "ac-123"; }, snapshot);
  expectFailure("demo-marker", (value) => { value.profile.mission = "synthetic-demo content"; }, snapshot);

  const instance = deepClone(snapshot);
  instance.meta.state = "instance";
  instance.meta.identity_ref = "ac-0123456789ab";
  instance.meta.generated_at = "2026-08-24T00:00:00+08:00";
  instance.meta.source_digest = `sha256:${"a".repeat(64)}`;
  instance.overview.state = "instance";
  instance.profile.display_name = "示例助手";
  instance.profile.guidance_mode = "balanced";
  instance.profile.learning_policy = "manual-only";
  instance.sops.push({
    id: "sop.example",
    title: "示例流程",
    summary: "只用于结构验证的本地数据",
    status: "active",
    approval_state: "explicit",
    activation_basis: "explicit-user",
    approved_by_user: true,
    risk_tier: "low",
    maturity: "unvalidated",
  });
  instance.assets.sops = 1;
  instance.experiences.push({
    id: "experience.task-example",
    subtype: "task",
    title: "示例经验",
    summary: "普通任务经验可以不声明能力成熟度",
    status: "active",
    approval_state: "explicit",
    activation_basis: "explicit-user",
    approved_by_user: true,
    risk_tier: "low",
  });
  instance.assets.experiences = 1;
  instance.memories.push({
    id: "memory.habit-example",
    subtype: "habit",
    title: "示例习惯",
    summary: "只用于验证明确授权布尔值",
    status: "active",
    approval_state: "explicit",
    activation_basis: "explicit-user",
    approved_by_user: true,
    risk_tier: "low",
  });
  instance.assets.memory = 1;
  validateSnapshotSemantics(instance, "self-test:valid-instance");
  for (const [name, mutate] of [
    ["count-drift", (value) => { value.assets.sops = 0; }],
    ["invalid-authorization", (value) => { value.sops[0].approval_state = "pending"; }],
    ["invalid-risk", (value) => { value.sops[0].risk_tier = "unknown"; }],
    ["candidate-in-formal-array", (value) => { value.sops[0].status = "candidate"; }],
    ["missing-maturity", (value) => { delete value.sops[0].maturity; }],
    ["invalid-instance-identity", (value) => { value.meta.identity_ref = "template"; }],
    ["bidi-title", (value) => { value.sops[0].title = "安全\u202Etxt"; }],
    ["wrong-schema", (value) => { value.meta.schema_version = "9.9"; }],
    ["authorization-boolean-conflict", (value) => { value.sops[0].approved_by_user = false; }],
    ["missing-explicit-authorization-boolean", (value) => { delete value.sops[0].approved_by_user; }],
    ["missing-policy-authorization-boolean", (value) => { value.sops[0].approval_state = "policy-authorized"; value.sops[0].activation_basis = "low-risk-evidence-policy"; delete value.sops[0].approved_by_user; }],
    ["legacy-policy-authorization-false", (value) => { value.sops[0].approval_state = "policy-authorized"; value.sops[0].activation_basis = "low-risk-evidence-policy"; value.sops[0].approved_by_user = false; }],
    ["legacy-policy-authorization-true", (value) => { value.sops[0].approval_state = "policy-authorized"; value.sops[0].activation_basis = "low-risk-evidence-policy"; value.sops[0].approved_by_user = true; }],
    ["missing-habit-authorization-boolean", (value) => { delete value.memories[0].approved_by_user; }],
    ["bad-trigger", (value) => { value.sops[0].triggers = ["safe\u202Etxt"]; }],
    ["bad-model-level", (value) => { value.model = { level: 9, name: "x", platform: "x", confirmed_at: "", status: "confirmed" }; }],
    ["bad-deferred-level", (value) => { value.deferred = [{ summary: "稍后", level: 9, remind: "" }]; }],
    ["bad-change-text", (value) => { value.changes = [{ date: "today", summary: "bad\u0000text" }]; }],
    ["bad-advanced-entry", (value) => { value.advanced.entry_files = ["bad\u202Etxt"]; }],
    ["invented-maturity", (value) => { value.sops[0].maturity = "provisional"; }],
    ["host-experience-missing-maturity", (value) => { value.experiences[0].subtype = "host-execution"; }],
  ]) {
    const candidate = deepClone(instance);
    mutate(candidate);
    let failed = false;
    try { validateSnapshotSemantics(candidate, `self-test:${name}`); } catch { failed = true; }
    assert(failed, `generic semantic negative self-test did not fail: ${name}`);
  }

  const injectionValue = deepClone(snapshot);
  injectionValue.profile.mission = `\";globalThis.compromised=true;//\n下一行`;
  const safeEnvelope = serializeSnapshotEnvelope(injectionValue);
  assert(parseSnapshotEnvelope(safeEnvelope, "self-test:escaped-injection").profile.mission === injectionValue.profile.mission, "escaped injection text did not round-trip as data");

  const envelopeFailures = [
    ["extra-statement", `${serializeSnapshotEnvelope(snapshot)}globalThis.compromised=true;\n`],
    ["raw-breakout", `${SNAPSHOT_PREFIX}{\"profile\":{\"mission\":\"\"};globalThis.compromised=true;//\"}}${SNAPSHOT_SUFFIX}`],
    ["function-value", `${SNAPSHOT_PREFIX}{\"value\":()=>true}${SNAPSHOT_SUFFIX}`],
    ["prototype-key", `${SNAPSHOT_PREFIX}{\"__proto__\":{\"polluted\":true}}${SNAPSHOT_SUFFIX}`],
    ["oversized", `${SNAPSHOT_PREFIX}${JSON.stringify({ value: "x".repeat(SNAPSHOT_MAX_BYTES) })}${SNAPSHOT_SUFFIX}`],
  ];
  for (const [name, source] of envelopeFailures) {
    let failed = false;
    try { parseSnapshotEnvelope(source, `self-test:${name}`); } catch { failed = true; }
    assert(failed, `negative envelope self-test did not fail: ${name}`);
  }
}

console.log(`Formal template snapshots passed non-executing JSON-envelope validation${runSelfTest ? " plus semantic and envelope self-tests" : ""}: ${publicPath}`);
