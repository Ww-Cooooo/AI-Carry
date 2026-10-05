import { createHash } from "node:crypto";
import fs, { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getInstanceWriteLockCleanup, withInstanceWriteLock } from "./instance-write-lock.mjs";
import {
  executeFirstInstantiation,
  firstInstantiationWriteSet,
  inspectFirstInstantiationRequest,
  normalizeFirstInstantiationRequest,
} from "./first-instantiation-transaction.mjs";
import { parseSectionedToml, validateInstanceManifestStructure } from "./asset-route-contract.mjs";
import { inspectStartupCapsule } from "./startup-capsule-contract.mjs";
import { parseCurrentSnapshotEnvelope } from "./snapshot-envelope.mjs";
import { validateSnapshotSemantics } from "./snapshot-semantics.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, "../..");
const createdAt = "2026-01-02T03:04:05.000Z";

function assert(condition, message) {
  if (!condition) throw new Error("First-run journey failed: " + message);
}

function request() {
  return {
    schema_version: 1,
    guidance_mode: "balanced",
    language: "zh-CN",
    learning_policy: "risk-tiered",
    display_name: "隔离剪辑助手",
    mission: "帮助我规划和完成视频剪辑任务。",
    direction: { type: "domain", domain_id: "video-editing", label: "视频剪辑", scope_statement: "规划素材、剪辑步骤与交付检查。" },
    first_task: { title: "规划第一条视频", summary: "形成一份可执行剪辑计划。", trigger: "开始规划第一条视频", aliases: [], scope: [], conditions: [], excludes: [], start_after_instantiation: false },
    profile: { in_scope: ["视频剪辑规划"], out_of_scope: ["不替用户发布"], automation: [], privacy: ["不读取无关私密文件"], learning: ["任务后主动提出可复用方法"], environment: [], unknowns: [] },
    host: { label: "隔离宿主", product_name: "", product_version: "", model_name: "unverified-alias", model_selection_label: "", request_model_name: "", model_routing_mode: "unknown", model_observation_basis: [], environment: "isolated", observation_basis: "current-session", integration_mode: "direct-workspace", match_hint: "isolated", limitations: [] },
  };
}

function copyTemplate(target, source = repository) {
  const manifest = validateInstanceManifestStructure(parseSectionedToml(read(source, "instance/manifest.toml"), "fixture source"));
  assert(manifest.root.state === "template" && manifest.root.instance_id === "template", "fixture source must be a blank template, not a real instance");
  cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    filter(path) {
      const parts = relative(source, path).split(sep);
      return ![".git", ".planning", ".assistant-local", ".assistant-private", ".agents", ".claude",
        "maintainer-private", "AGENTS.override.md", "workspace", "skills-lock.json"].includes(parts[0])
        && !parts.includes("node_modules");
    },
  });
}

function testTemplateCopyExclusions(parent) {
  const source = resolve(parent, "copy-source"); const target = resolve(parent, "copy-target");
  mkdirSync(resolve(source, "instance"), { recursive: true });
  writeFileSync(resolve(source, "instance/manifest.toml"), read(repository, "instance/manifest.toml"));
  const denied = [".assistant-local/value.txt", ".assistant-private/value.txt", ".agents/value.txt", ".claude/worktrees/value.txt",
    "AGENTS.override.md", "workspace/value.txt", "skills-lock.json", "node_modules/value.txt",
    "dashboard/deep/node_modules/value.txt", "core/tools/nested/node_modules/value.txt"];
  for (const ref of [...denied, "core/retained.txt"]) {
    const path = resolve(source, ref); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "synthetic fixture marker");
  }
  copyTemplate(target, source);
  assert(denied.every((ref) => !existsSync(resolve(target, ref))) && existsSync(resolve(target, "core/retained.txt")),
    "template fixture copy included private/local/host/workspace or nested dependency content");
  writeFileSync(resolve(source, "instance/manifest.toml"), read(source, "instance/manifest.toml").replace('state = "template"', 'state = "instance"'));
  let refused = false; try { copyTemplate(resolve(parent, "must-not-copy-instance"), source); } catch { refused = true; }
  assert(refused && !existsSync(resolve(parent, "must-not-copy-instance")), "fixture copy read a real instance as template data");
}

function read(root, ref) { return readFileSync(resolve(root, ...ref.split("/")), "utf8"); }

function treeFingerprint(root) {
  const rows = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = resolve(current, entry.name);
      const info = lstatSync(path);
      const ref = relative(root, path).split(sep).join("/");
      assert(!info.isSymbolicLink(), "fixture contains a link");
      if (info.isDirectory()) queue.push(path);
      else if (info.isFile()) rows.push(ref + "\0" + createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  }
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex");
}

function instanceId(root, ref) {
  const match = /^instance_id = "([^"]+)"$/mu.exec(read(root, ref));
  return match?.[1] ?? "";
}

function verifyUsableInstance(root, expectedId) {
  const manifest = validateInstanceManifestStructure(parseSectionedToml(read(root, "instance/manifest.toml"), "journey manifest"));
  assert(manifest.root.state === "instance" && manifest.root.instance_id === expectedId && manifest.direction.locked === true, "core identity is invalid");
  assert(read(root, "instance/profile/approved-profile.md").includes("instance_id: " + expectedId), "approved profile is missing");
  assert(read(root, "instance/maps/domain-map.toml").includes('asset_kind = "task-family"'), "first task route is missing");
  assert(inspectStartupCapsule(root).decision === "startup-capsule-valid", "startup capsule did not refresh");
  assert(instanceId(root, "instance/validations/index.toml") === "template", "empty validation index was eagerly rebound");
  assert(instanceId(root, "instance/evolution/index.toml") === "template", "empty evolution index was eagerly rebound");
  assert(instanceId(root, "instance/components/registry.toml") === "template", "empty component registry was eagerly rebound");
  assert(instanceId(root, "instance/hosts/registry.toml") === "template", "empty host registry was eagerly rebound");
  assert(!existsSync(resolve(root, "instance/hosts/profiles")) || readdirSync(resolve(root, "instance/hosts/profiles")).length === 0, "first creation invented a host profile");
  for (const name of ["consistency-governance-card.md", "memory-governance-card.md", "network-security-governance-card.md"]) {
    const card = read(root, "instance/governance/" + name);
    assert(card.includes('schedule_state = "uninitialized"') && card.includes("approved_by_user = false"), "first creation scheduled governance work");
  }
  const publicBytes = readFileSync(resolve(root, "dashboard/public/snapshot.js"));
  const distBytes = readFileSync(resolve(root, "dashboard/dist/snapshot.js"));
  assert(publicBytes.equals(distBytes), "snapshot copies differ");
  const snapshot = parseCurrentSnapshotEnvelope(publicBytes.toString("utf8"), "first-run journey snapshot");
  validateSnapshotSemantics(snapshot, "first-run journey snapshot");
  assert(snapshot.meta.state === "instance" && snapshot.assets.memory === 0 && snapshot.assets.sops === 0
    && snapshot.assets.capabilities === 0 && snapshot.assets.experiences === 0 && snapshot.assets.evolution === 0
    && snapshot.assets.todo === 0 && snapshot.assets.governance === 0 && snapshot.assets.skills === 0,
  "new instance snapshot contains invented assets");
}

const lockModule = pathToFileURL(resolve(scriptDirectory, "instance-write-lock.mjs")).href;
const creationModule = pathToFileURL(resolve(scriptDirectory, "first-instantiation-transaction.mjs")).href;
function child(source) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 30_000, windowsHide: true });
}
function deadLock(root) {
  const run = child(`import {withInstanceWriteLock as lock} from ${JSON.stringify(lockModule)}; lock(${JSON.stringify(root)}, 'crash-owner', () => process.exit(71));`);
  assert(run.status === 71, `dead lock fixture failed: ${run.stderr}`);
}

async function testSharedInstanceWriteLock(parent) {
  const root = resolve(parent, "lock-tests"); mkdirSync(root);
  assert(withInstanceWriteLock(root, "outer", () => withInstanceWriteLock(root, "inner", () => 17)) === 17,
    "synchronous nested lock changed return value");
  let release;
  const held = withInstanceWriteLock(root, "async-holder", () => new Promise((done) => { release = done; }));
  let busy;
  try { withInstanceWriteLock(root, "independent-call", () => assert(false, "independent async caller entered")); } catch (error) { busy = error; }
  assert(busy?.code === "AI_CARRY_INSTANCE_WRITE_BUSY", "independent call in the same process bypassed the async holder");
  release(23); assert(await held === 23, "Promise lock changed return value");

  const noHardlinks = fs.linkSync;
  try {
    fs.linkSync = () => { const error = new Error("synthetic unsupported hardlinks"); error.code = "ENOTSUP"; throw error; };
    syncBuiltinESMExports();
    assert(withInstanceWriteLock(root, "portable-volume", () => 29) === 29, "lock depends on hardlink support");
    const portable = resolve(parent, "portable-creation"); copyTemplate(portable);
    const created = executeFirstInstantiation(portable, request(), { testFaultAfterCapsule: true, testFaultBeforeSnapshot: true });
    assert(created.decision === "first-instantiation-complete", "first creation journal depends on hardlink support");
  } finally { fs.linkSync = noHardlinks; syncBuiltinESMExports(); }

  const initCrash = child(`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const write=fs.writeFileSync; fs.writeFileSync=function(p,...args){const r=write(p,...args); if(String(p).includes('.lock.publish-'))process.exit(72);return r;};syncBuiltinESMExports();
    const {withInstanceWriteLock:lock}=await import(${JSON.stringify(lockModule)});lock(${JSON.stringify(root)},'initialize-crash',()=>{});`);
  assert(initCrash.status === 72 && !existsSync(resolve(root, ".assistant-local/runtime/instance-write.lock")), "initialization crash published an ownerless lock");
  assert(withInstanceWriteLock(root, "after-init-crash", () => 31) === 31, "initialization residue blocked a new writer");

  deadLock(root);
  const reaperCrash = child(`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.renameSync;fs.renameSync=function(a,b){const r=rename(a,b);if(/instance-write\\.lock\\.recover-[a-f0-9]{32}$/.test(String(b)))process.exit(73);return r;};syncBuiltinESMExports();
    const {withInstanceWriteLock:lock}=await import(${JSON.stringify(lockModule)});lock(${JSON.stringify(root)},'reaper-crash',()=>{});`);
  assert(reaperCrash.status === 73, `reaper interruption was not reached: ${reaperCrash.stderr}`);
  assert(withInstanceWriteLock(root, "recover-dead-reaper", () => 37) === 37, "dead reaper made the dead lock unrecoverable");

  const beforeMove = resolve(parent, "lock-before-move"); const afterMove = resolve(parent, "lock-after-move");
  mkdirSync(beforeMove); deadLock(beforeMove); renameSync(beforeMove, afterMove);
  assert(withInstanceWriteLock(afterMove, "moved-root", () => 41) === 41, "a moved root could not reclaim a provably dead local lock");

  for (const foreign of [true, false]) {
    const foreignRoot = resolve(parent, foreign ? "foreign-host-lock" : "unknown-host-lock"); mkdirSync(foreignRoot); deadLock(foreignRoot);
    const ownerPath = resolve(foreignRoot, ".assistant-local/runtime/instance-write.lock/owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (foreign) owner.host_binding = "0".repeat(64); else delete owner.host_binding;
    const before = JSON.stringify(owner); writeFileSync(ownerPath, before);
    let denied;
    try { withInstanceWriteLock(foreignRoot, "foreign-recovery", () => assert(false, "foreign lock was entered")); } catch (error) { denied = error; }
    assert(denied?.code === "AI_CARRY_INSTANCE_WRITE_BUSY" && denied.message.includes("another computer")
      && readFileSync(ownerPath, "utf8") === before, "a foreign/unknown host lock was reaped using a local dead-PID probe");
  }

  deadLock(root);
  const race = () => new Promise((done, reject) => {
    const worker = spawn(process.execPath, ["--input-type=module", "-e", `import fs from 'node:fs';import {withInstanceWriteLock as lock} from ${JSON.stringify(lockModule)};
      try{lock(${JSON.stringify(root)},'racing-reaper',()=>{const p=${JSON.stringify(resolve(root, "critical"))};fs.writeFileSync(p,'held',{flag:'wx'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80);fs.unlinkSync(p);});process.stdout.write('acquired');}
      catch(e){if(e.code==='AI_CARRY_INSTANCE_WRITE_BUSY')process.stdout.write('busy');else{process.stderr.write(e.stack);process.exitCode=1;}}`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    worker.stdout.on("data", (bytes) => { stdout += bytes; }); worker.stderr.on("data", (bytes) => { stderr += bytes; });
    worker.on("error", reject); worker.on("exit", (code) => done({ code, stdout, stderr }));
  });
  const races = await Promise.all([race(), race(), race(), race()]);
  assert(races.every((run) => run.code === 0 && ["acquired", "busy"].includes(run.stdout)) && races.some((run) => run.stdout === "acquired"),
    `concurrent dead-owner recovery entered two critical sections: ${JSON.stringify(races)}`);

  const cleanupRoot = resolve(parent, "cleanup-lock"); mkdirSync(cleanupRoot);
  const originalRename = fs.renameSync;
  const result = Object.freeze({ decision: "business-committed" });
  let returned;
  try {
    fs.renameSync = function (from, to, ...args) {
      if (String(from).endsWith("instance-write.lock") && String(to).includes(".retired-")) {
        const error = new Error("synthetic cleanup failure"); error.code = "EACCES"; throw error;
      }
      return originalRename(from, to, ...args);
    };
    syncBuiltinESMExports(); returned = withInstanceWriteLock(cleanupRoot, "cleanup-failure", () => result);
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert(returned === result && getInstanceWriteLockCleanup(result)?.state === "pending"
    && existsSync(resolve(cleanupRoot, ".assistant-local/runtime/instance-write.lock")), "lock cleanup changed a committed result or its capability identity");
  assert(withInstanceWriteLock(cleanupRoot, "retry-own-cleanup", () => 43) === 43
    && !existsSync(resolve(cleanupRoot, ".assistant-local/runtime/instance-write.lock")), "a transient cleanup failure stranded the live process's later writes");

  const replacementRoot = resolve(parent, "replacement-lock"); mkdirSync(replacementRoot);
  const replacementResult = Object.freeze({ decision: "business-committed" });
  let replacementNonce;
  const preservedResult = withInstanceWriteLock(replacementRoot, "replacement-preservation", () => {
    const path = resolve(replacementRoot, ".assistant-local/runtime/instance-write.lock/owner.json");
    const replacement = JSON.parse(readFileSync(path, "utf8")); replacement.nonce = "f".repeat(32); replacementNonce = replacement.nonce;
    writeFileSync(path, JSON.stringify(replacement));
    return replacementResult;
  });
  assert(preservedResult === replacementResult && getInstanceWriteLockCleanup(preservedResult)?.state === "pending"
    && JSON.parse(readFileSync(resolve(replacementRoot, ".assistant-local/runtime/instance-write.lock/owner.json"), "utf8")).nonce === replacementNonce,
  "lock release removed a replacement generation");

  const junctionRoot = resolve(parent, "linked-lock-parent"); const outside = resolve(parent, "lock-outside");
  mkdirSync(junctionRoot); mkdirSync(outside);
  symlinkSync(outside, resolve(junctionRoot, ".assistant-local"), process.platform === "win32" ? "junction" : "dir");
  let linkedDenied = false; try { withInstanceWriteLock(junctionRoot, "linked-parent", () => assert(false, "linked lock callback ran")); } catch { linkedDenied = true; }
  assert(linkedDenied && readdirSync(outside).length === 0, "lock created state through a linked parent");
}

function testHardCreationInterruptions(parent) {
  const contended = resolve(parent, "creation-contention"); copyTemplate(contended);
  const beforeContention = treeFingerprint(contended);
  const competing = withInstanceWriteLock(contended, "another-core-writer", () => child(`
    import {executeFirstInstantiation} from ${JSON.stringify(creationModule)};
    try{executeFirstInstantiation(${JSON.stringify(contended)},${JSON.stringify(request())});process.exitCode=1;}
    catch(e){process.stdout.write(e.code??'unexpected');}`));
  assert(competing.status === 0 && competing.stdout === "AI_CARRY_INSTANCE_WRITE_BUSY"
    && treeFingerprint(contended) === beforeContention, "first creation bypassed another process's core write lease");
  for (const stopAfter of [0, 1, 2, 3]) {
    const root = resolve(parent, `hard-crash-${stopAfter}`); copyTemplate(root);
    const identity = { instanceId: `ac-hard-crash-${stopAfter}`, createdAt };
    const run = child(`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const rename=fs.renameSync;let installed=0;fs.renameSync=function(a,b){const r=rename(a,b);
        if(${stopAfter}===0&&String(b).endsWith('first-instantiation.json'))process.exit(77);
        if(String(a).includes('.ai-carry-stage-')&&++installed===${stopAfter})process.exit(77);return r;};syncBuiltinESMExports();
      const {executeFirstInstantiation}=await import(${JSON.stringify(creationModule)});executeFirstInstantiation(${JSON.stringify(root)},${JSON.stringify(request())},{testIdentity:${JSON.stringify(identity)},testFaultBeforeSnapshot:true});`);
    assert(run.status === 77, `hard stop ${stopAfter} failed: ${run.stderr}`);
    assert(inspectFirstInstantiationRequest(root, request()).decision === "first-instantiation-recovery-ready", "read-only preview hid an interrupted core transaction");
    const resumed = executeFirstInstantiation(root, request(), { testFaultBeforeSnapshot: true });
    assert(resumed.decision === "first-instantiation-complete" && resumed.recovered_interrupted_creation === true
      && resumed.instance_id === identity.instanceId && read(root, "instance/profile/approved-profile.md").includes(identity.instanceId)
      && read(root, "instance/maps/domain-map.toml").includes(identity.instanceId)
      && !existsSync(resolve(root, ".assistant-local/runtime/first-instantiation.json")), "hard stop did not resume one consistent original identity");
  }
  const drift = resolve(parent, "creation-drift"); copyTemplate(drift);
  const stopped = child(`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;
    fs.renameSync=function(a,b){const r=rename(a,b);if(String(a).includes('manifest.toml.ai-carry-stage-'))process.exit(77);return r;};syncBuiltinESMExports();
    const {executeFirstInstantiation}=await import(${JSON.stringify(creationModule)});executeFirstInstantiation(${JSON.stringify(drift)},${JSON.stringify(request())});`);
  assert(stopped.status === 77, "external drift setup did not stop after first core write");
  const changed = `${read(drift, "instance/maps/domain-map.toml")}\n# external editor change\n`;
  writeFileSync(resolve(drift, "instance/maps/domain-map.toml"), changed);
  let preserved = false; try { executeFirstInstantiation(drift, request()); } catch (error) { preserved = error.message.includes("changed externally"); }
  assert(preserved && read(drift, "instance/maps/domain-map.toml") === changed
    && existsSync(resolve(drift, ".assistant-local/runtime/first-instantiation.json")), "creation recovery overwrote an external edit or discarded its evidence");
}

const integrationRoot = mkdtempSync(resolve(tmpdir(), "ai-carry-first-run-"));
let completed = false;
try {
  testTemplateCopyExclusions(integrationRoot);
  await testSharedInstanceWriteLock(integrationRoot);
  testHardCreationInterruptions(integrationRoot);
  const normalized = normalizeFirstInstantiationRequest(request());
  assert(normalized.host.modelName === "" && normalized.warnings.some((item) => item.includes("unverified")), "unverified model alias was promoted");
  assert(JSON.stringify(firstInstantiationWriteSet) === JSON.stringify(["instance/manifest.toml", "instance/profile/approved-profile.md", "instance/maps/domain-map.toml"]), "core write set expanded");

  const live = resolve(integrationRoot, "success");
  copyTemplate(live);
  const preview = inspectFirstInstantiationRequest(live, request());
  assert(preview.status === "ready" && preview.write_target_count === 3 && preview.user_preview.includes("不预造记忆"), "preview does not describe the lightweight boundary");
  const first = executeFirstInstantiation(live, request(), { testIdentity: { instanceId: "ac-first-run-journey", createdAt } });
  assert(first.updated === true && ["passed", "limited"].includes(first.status), "first creation did not commit its core");
  assert(!first.auxiliary_pending.includes("dashboard-snapshot"), "operational snapshot could not tolerate untouched empty registries");
  verifyUsableInstance(live, "ac-first-run-journey");
  const afterFirst = treeFingerprint(live);
  const second = executeFirstInstantiation(live, request());
  assert(second.updated === false && treeFingerprint(live) === afterFirst, "second identical creation changed bytes");

  const rollback = resolve(integrationRoot, "rollback");
  copyTemplate(rollback);
  const beforeRollback = treeFingerprint(rollback);
  let rollbackError;
  try { executeFirstInstantiation(rollback, request(), { testIdentity: { instanceId: "ac-first-run-rollback", createdAt }, testFaultAfterInstall: 2 }); }
  catch (error) { rollbackError = error; }
  assert(rollbackError?.templatePreserved === true && treeFingerprint(rollback) === beforeRollback, "core fault did not restore the template");

  const capsuleFault = resolve(integrationRoot, "capsule-fault");
  copyTemplate(capsuleFault);
  const capsuleResult = executeFirstInstantiation(capsuleFault, request(), { testIdentity: { instanceId: "ac-first-run-capsule", createdAt }, testFaultAfterCapsule: true });
  assert(capsuleResult.updated === true && capsuleResult.status === "limited" && capsuleResult.auxiliary_pending.includes("startup-capsule")
    && read(capsuleFault, "instance/manifest.toml").includes('state = "instance"'), "capsule fault rolled back the usable assistant");

  const snapshotFault = resolve(integrationRoot, "snapshot-fault");
  copyTemplate(snapshotFault);
  const snapshotResult = executeFirstInstantiation(snapshotFault, request(), { testIdentity: { instanceId: "ac-first-run-snapshot", createdAt }, testFaultBeforeSnapshot: true });
  assert(snapshotResult.updated === true && snapshotResult.status === "limited" && snapshotResult.auxiliary_pending.includes("dashboard-snapshot")
    && inspectStartupCapsule(snapshotFault).decision === "startup-capsule-valid", "snapshot fault escaped its local boundary");

  completed = true;
  process.stdout.write(JSON.stringify({ decision: "first-run-journey-passed", core_write_count: 3, lazy_optional_state: true,
    idempotent: true, core_rollback: true, durable_core_recovery: true, shared_write_lock: true,
    hardlink_independent: true, template_copy_exclusions: true, capsule_failure_local: true, snapshot_failure_local: true }) + "\n");
} finally {
  if (completed) rmSync(integrationRoot, { recursive: true, force: true });
  else process.stderr.write("First-run failure scene preserved at " + integrationRoot + "\n");
}
