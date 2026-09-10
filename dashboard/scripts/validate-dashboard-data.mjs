// Exercise the shipped reader, not a second implementation. No files or browser
// globals outside the VM are changed; TypeScript is the existing build dependency.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("../src/lib/data.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const actions = JSON.parse(readFileSync(new URL("../src/generated/dashboard-actions.json", import.meta.url), "utf8"));
const clean = () => ({
  meta: { state: "instance", product_version: "2.0.9" }, overview: { state: "instance" },
  profile: { display_name: "before" }, assets: {},
  memories: [], sops: [], capabilities: [], experiences: [], evolution: [], governance: [], todo: [], deferred: [], changes: [],
  skills: { items: [{ id: "good", title: "Good Skill", state: "available" }], exports: [] },
});
function load(snapshot) {
  const api = {};
  runInNewContext(code, {
    exports: api, window: { AI_CARRY_SNAPSHOT: snapshot, AI_CARRY_IS_REAL: true },
    require(id) {
      if (id === "./i18n") return { dashboardLanguageTag: () => "zh-CN" };
      if (id === "../generated/dashboard-actions.json") return actions;
      throw new Error(`Unexpected import: ${id}`);
    },
  }, { timeout: 2000 });
  return api;
}

const mixed = clean();
for (const area of ["memories", "sops", "capabilities", "experiences", "evolution", "governance", "deferred", "changes"]) {
  mixed[area] = [{ id: `good-${area}`, title: "kept", summary: "kept", triggers: {}, status: "active" }, null];
}
mixed.todo = {};
mixed.skills.items.push(null);
mixed.skills.exports = [null, { id: "export-kept", title: "kept", state: "ready" }];
const sourceBefore = JSON.stringify(mixed);
const api = load(mixed);
assert.equal(api.skills.items.length, 1);
assert.equal(api.skills.exports.length, 1);
assert.equal(api.memories.length, 1);
assert.equal(api.governance.length, 1);
assert.equal(api.todo.length, 0);
assert.equal(api.getSnapshotStatus().key, "degraded");
assert.equal(api.snapshotAreaDegraded("todos"), true);
assert.equal(api.snapshotAreaDegraded("skills"), true);
assert.equal(JSON.stringify(mixed), sourceBefore, "display isolation rewrote the input");
const profileRef = api.profile;
const memoryRef = api.memories;
const repaired = clean();
repaired.profile.display_name = "after";
assert.equal(api.applyDashboardSnapshot(repaired), true);
assert.equal(api.profile, profileRef);
assert.equal(api.memories, memoryRef);
assert.equal(api.profile.displayName, "after");
assert.notEqual(api.getSnapshotStatus().key, "degraded");
assert.equal(api.snapshotAreaDegraded("todos"), false);

// Force an unexpected late projection failure; no exported state may change.
const failing = clean();
failing.profile.display_name = "must-not-appear";
failing.skills.items = [{ get title() { throw new Error("injected projection failure"); } }];
assert.throws(() => api.applyDashboardSnapshot(failing), /injected projection failure/);
assert.equal(api.profile.displayName, "after");
assert.equal(api.skills.items[0].id, "good");
assert.equal(api.applyDashboardSnapshot({ meta: null, profile: {} }), false);
assert.equal(api.profile.displayName, "after");
assert.equal(load(null).getSnapshotStatus().key, "unavailable");
assert.equal(load({ meta: [], profile: {} }).getSnapshotStatus().key, "unavailable");
console.log("dashboard-data-passed: mixed rows, invalid lists, honest warning, recovery, atomic refresh and unchanged source");
