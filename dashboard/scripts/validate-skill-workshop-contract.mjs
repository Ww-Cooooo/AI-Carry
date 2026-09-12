import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSkillPackage } from "./skill-workshop-contract.mjs";
import { createSkillDelivery, inspectSkillSource } from "./skill-package.mjs";
import { recommendForSkillWorkshop } from "../src/lib/skill-workshop.ts";

const assert = (condition, message) => { if (!condition) throw new Error(`Skill workshop contract failed: ${message}`); };
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "ai-carry-skill-workshop-"));
let passed = false;
const source = (ref) => readFileSync(resolve(repository, ...ref.split("/")), "utf8");
const write = (base, ref, content) => {
  const target = resolve(base, ...ref.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
};

try {
  // Copy and tooltip appearance need a targeted UI review when changed, not
  // frozen prose or a magic z-index in the package-behavior test.
  // Actual detail and copy actions are exercised in the shared-page browser journey;
  // this test owns package behavior, not the names of a retired UI component.

  const actions = source("core/maps/dashboard-actions.toml");
  for (const id of ["skill.create-from-asset", "skill.continue-export", "skill.install-shared"]) {
    assert(actions.includes(`action_id = "${id}"`), `missing dashboard action ${id}`);
  }

  // Empty public templates must not contain a user's generated Skills.
  assert(!source("dashboard/public/snapshot.js").includes('"exports": ['), "public template contains exported Skill data");
  assert(!source("dashboard/dist/snapshot.js").includes('"exports": ['), "built template contains exported Skill data");

  // Recommendations remain advisory and distinguish a workflow from a capability.
  const mature = { id: "sop.example", title: "示例", summary: "示例", status: "active", approvalState: "explicit", activationBasis: "explicit-user", approvedByUser: true, riskTier: "low", reliability: "practiced", say: "", triggers: [] };
  assert(recommendForSkillWorkshop("sop", mature).state === "ready", "a practiced SOP is not recommendable");
  assert(recommendForSkillWorkshop("capability", mature).state === "inspect", "a capability bypassed workflow inspection");
  assert(recommendForSkillWorkshop("sop", { ...mature, reliability: "unvalidated" }).state === "refine", "an unvalidated SOP appears share-ready");

  // A text Skill with a script is inspected without executing the script.
  const clean = resolve(root, "clean");
  write(clean, "SKILL.md", "---\nname: reusable-checklist\ndescription: Apply a reusable checklist after the user asks for a review.\nmetadata:\n  ai-carry-skill-id: skill.reusable-checklist\n  ai-carry-version: \"1.0.0\"\n---\n# Workflow\nAsk for the target, review it, and report limits.\n");
  write(clean, "agents/openai.yaml", "interface:\n  display_name: Reusable checklist\n");
  write(clean, "examples/finished-review.md", "# Example\nInput: a supplied draft. Output: checked items and remaining questions.\n");
  write(clean, "scripts/check.mjs", "throw new Error('must never execute during inspection');\n");
  const cleanResult = inspectSkillPackage(clean, { mode: "export", sourceAssetId: "sop.private-source" });
  assert(cleanResult.decision === "ready" && cleanResult.skillId === "skill.reusable-checklist" && cleanResult.version === "1.0.0"
    && cleanResult.scripts.includes("scripts/check.mjs"), "standard portable package inspection failed or executed a script");

  // Legacy top-level identity remains readable; conflicting old/new identity
  // pauses only that package instead of breaking the workshop.
  const legacy = resolve(root, "legacy");
  write(legacy, "SKILL.md", "---\nname: legacy-checklist\ndescription: Keep an older AI Carry Skill readable when the user imports it.\nskill_id: skill.legacy-checklist\nversion: 1.0.0\n---\n# Workflow\nPreserve the existing workflow.\n");
  const legacyResult = inspectSkillPackage(legacy);
  assert(legacyResult.decision === "ready" && legacyResult.skillId === "skill.legacy-checklist" && legacyResult.version === "1.0.0",
    "legacy Skill identity stopped being readable");
  const conflicting = resolve(root, "conflicting-metadata");
  write(conflicting, "SKILL.md", "---\nname: conflicting-checklist\ndescription: Keep conflicting identity local for review.\nskill_id: skill.old-checklist\nversion: 1.0.0\nmetadata:\n  ai-carry-skill-id: skill.new-checklist\n  ai-carry-version: \"2.0.0\"\n---\n# Workflow\nDo not guess the shared identity.\n");
  const conflictingResult = inspectSkillPackage(conflicting);
  assert(conflictingResult.decision === "review" && conflictingResult.issues.some((item) => item.code === "identity-metadata-conflict")
    && inspectSkillPackage(clean).decision === "ready", "identity conflict escaped its single-package boundary");

  // The same source makes real ZIP and folder carriers; existing output is never overwritten.
  const deliveryRoot = resolve(root, "delivery");
  const zipPath = resolve(deliveryRoot, "reusable-checklist.zip");
  const zipDelivery = createSkillDelivery(clean, { format: "zip", outputPath: zipPath });
  assert(zipDelivery.decision === "ready" && existsSync(zipPath), "ZIP carrier was not created");
  const cliZipPath = resolve(deliveryRoot, "reusable-checklist-cli.zip");
  const cliDelivery = spawnSync(process.execPath, [resolve(repository, "dashboard/scripts/skill-package.mjs"), "create",
    "--source", clean, "--format", "zip", "--output", cliZipPath], { encoding: "utf8", windowsHide: true });
  assert(cliDelivery.status === 0 && cliDelivery.stdout.includes('"packageCheck": "passed"')
    && !/digest|sha256/iu.test(cliDelivery.stdout), "normal Skill delivery output exposed internal integrity fields");
  const imported = inspectSkillSource(zipPath, { extractTo: resolve(root, "received-zip") });
  assert(imported.decision === "ready" && existsSync(resolve(imported.packageRoot, "SKILL.md")), "ZIP did not survive isolated inspection");
  assert(readFileSync(resolve(imported.packageRoot, "examples/finished-review.md"), "utf8") === readFileSync(resolve(clean, "examples/finished-review.md"), "utf8"),
    "a normal example was rejected or dropped during delivery");
  const folderPath = resolve(deliveryRoot, "reusable-checklist-folder");
  assert(createSkillDelivery(clean, { format: "folder", outputPath: folderPath }).decision === "ready", "folder carrier was not created");
  let overwriteStopped = false;
  try { createSkillDelivery(clean, { format: "zip", outputPath: zipPath }); } catch { overwriteStopped = true; }
  assert(overwriteStopped, "carrier creation overwrote existing output");

  // A path traversal is rejected before extraction creates a destination.
  const traversalZip = resolve(deliveryRoot, "traversal.zip");
  const archive = Buffer.from(readFileSync(zipPath));
  const safeName = Buffer.from("reusable-checklist/SKILL.md", "utf8");
  const unsafeName = Buffer.from(`../${"x".repeat(safeName.length - 3)}`, "utf8");
  let replaced = 0;
  for (let offset = archive.indexOf(safeName); offset >= 0; offset = archive.indexOf(safeName, offset + safeName.length)) {
    unsafeName.copy(archive, offset); replaced += 1;
  }
  assert(replaced === 2, "unsafe ZIP fixture was not created");
  writeFileSync(traversalZip, archive);
  const traversalOutput = resolve(root, "traversal-output");
  let traversalStopped = false;
  try { inspectSkillSource(traversalZip, { extractTo: traversalOutput }); } catch { traversalStopped = true; }
  assert(traversalStopped && !existsSync(traversalOutput), "unsafe ZIP escaped or left an extraction directory");

  // Dangerous content, opaque assets, and a transient filesystem error stay local to one package.
  const malicious = resolve(root, "malicious");
  write(malicious, "SKILL.md", "---\nname: unsafe-skill\ndescription: Read C:/Users/example/private.txt and use private://customer/data.\n---\n# Unsafe\n");
  assert(inspectSkillPackage(malicious).decision === "isolated", "private-path package was not isolated");

  const exampleLeak = resolve(root, "example-leak");
  write(exampleLeak, "SKILL.md", readFileSync(resolve(clean, "SKILL.md"), "utf8"));
  write(exampleLeak, "examples/private.md", "Do not share private://customer/data.\n");
  const leakedExample = inspectSkillPackage(exampleLeak);
  assert(leakedExample.decision === "isolated" && leakedExample.issues.some(item => item.code === "private-boundary" && item.message.includes("examples/private.md")),
    "recognizing examples skipped their privacy inspection");
  const unknownRoot = resolve(root, "unknown-root");
  write(unknownRoot, "SKILL.md", readFileSync(resolve(clean, "SKILL.md"), "utf8"));
  write(unknownRoot, "unrelated/notes.md", "Unclassified material still requires review.\n");
  assert(inspectSkillPackage(unknownRoot).decision === "review", "unclassified roots bypassed review");

  const opaque = resolve(root, "opaque");
  write(opaque, "SKILL.md", "---\nname: image-helper\ndescription: Use a supplied visual reference when the user asks.\n---\n# Workflow\nReview the reference first.\n");
  const opaquePath = resolve(opaque, "assets/sample.png");
  mkdirSync(dirname(opaquePath), { recursive: true });
  writeFileSync(opaquePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert(inspectSkillPackage(opaque).decision === "review", "opaque asset was globally accepted or rejected");

  const unstable = resolve(root, "unstable");
  write(unstable, "SKILL.md", "---\nname: unstable-skill\ndescription: Keep the Agent available when one package directory cannot be read.\n---\n# Workflow\nInspect without executing.\n");
  write(unstable, "references/guide.md", "# Reference\n");
  const unstableResult = inspectSkillPackage(unstable, { fileSystem: {
    lstatSync,
    readdirSync(directory, options) {
      if (resolve(directory) === resolve(unstable, "references")) throw new Error("simulated transient directory read failure");
      return readdirSync(directory, options);
    },
  } });
  assert(unstableResult.decision === "isolated" && unstableResult.issues.some((item) => item.code === "directory-read-failed"), "nested read fault escaped package isolation");

  passed = true;
  console.log("Skill workshop journey passed recommendations, standard and legacy identity reading, single-package conflict isolation, ZIP/folder delivery, and local package fault isolation without running scripts. UI copy and tooltip appearance are not covered by this check.");
} finally {
  if (passed) {
    try { rmSync(root, { recursive: true, force: false }); }
    catch { console.warn(`Skill workshop checks passed; temporary cleanup incomplete at ${root}`); }
  } else console.error(`Skill workshop failure scene preserved at ${root}`);
}
