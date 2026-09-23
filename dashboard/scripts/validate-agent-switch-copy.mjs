import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareAgentSwitch } from "./prepare-agent-switch.mjs";

const root = mkdtempSync(join(tmpdir(), "ai-carry-agent-switch-test-"));
try {
  const source = join(root, "source");
  const destination = join(root, "copy");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  cpSync(join(root, "seed.txt"), join(root, "seed-copy.txt"));
  writeFileSync(join(root, "placeholder"), "placeholder\n");
  // The fixture is intentionally small but includes the user-owned areas that must survive.
  const fs = await import("node:fs");
  fs.mkdirSync(join(source, "instance", "memory"), { recursive: true });
  fs.mkdirSync(join(source, "instance", "sops"), { recursive: true });
  fs.mkdirSync(join(source, "instance", "cache"), { recursive: true });
  fs.mkdirSync(join(source, "cache"), { recursive: true });
  fs.mkdirSync(join(source, ".assistant-local"), { recursive: true });
  fs.mkdirSync(join(source, ".git"), { recursive: true });
  fs.mkdirSync(join(source, "node_modules"), { recursive: true });
  writeFileSync(join(source, "instance", "manifest.toml"), 'instance_id = "demo.instance"\nstate = "instance"\n');
  writeFileSync(join(source, "instance", "memory", "kept.md"), "user memory\n");
  writeFileSync(join(source, "instance", "sops", "kept.md"), "user workflow\n");
  writeFileSync(join(source, "instance", "cache", "kept.md"), "user cache\n");
  writeFileSync(join(source, "cache", "skip.md"), "runtime cache\n");
  writeFileSync(join(source, ".assistant-local", "binding.json"), JSON.stringify({ executable: "C:/old/tool.exe" }));
  writeFileSync(join(source, ".assistant-local", "credentials.json"), JSON.stringify({ marker: "credential-fixture" }));
  writeFileSync(join(source, ".git", "must-not-copy"), "git\n");
  writeFileSync(join(source, "node_modules", "must-not-copy"), "dependency\n");

  const sourceManifestBefore = readFileSync(join(source, "instance", "manifest.toml"));
  const result = prepareAgentSwitch({ sourceRoot: source, destinationRoot: destination });
  assert.equal(result.decision, "independent-copy-ready");
  assert.equal(result.syncPolicy, "none");
  assert.deepEqual(readFileSync(join(source, "instance", "manifest.toml")), sourceManifestBefore);
  assert.equal(readFileSync(join(destination, "instance", "memory", "kept.md"), "utf8"), "user memory\n");
  assert.equal(readFileSync(join(destination, "instance", "sops", "kept.md"), "utf8"), "user workflow\n");
  assert.equal(readFileSync(join(destination, "instance", "cache", "kept.md"), "utf8"), "user cache\n");
  assert.equal(readFileSync(join(destination, ".assistant-local", "binding.json"), "utf8"), JSON.stringify({ executable: "C:/old/tool.exe" }));
  assert(!existsSync(join(destination, ".git")), "git metadata was copied");
  assert(!existsSync(join(destination, "node_modules")), "node_modules was copied");
  assert(!existsSync(join(destination, "cache")), "root runtime cache was copied");
  assert(!existsSync(join(destination, ".assistant-local", "credentials.json")), "credential file was copied");
  assert(result.skippedFiles.includes(".assistant-local/credentials.json"), "credential file was not reported as skipped");
  assert(readFileSync(join(destination, ".assistant-local", "host-switch.toml"), "utf8").includes('mode = "independent"'));
  assert(readFileSync(join(destination, ".assistant-local", "HOST-SWITCH-START.md"), "utf8").includes("不与原目录自动同步"));

  const secondDestination = join(root, "copy-again");
  const second = prepareAgentSwitch({ sourceRoot: destination, destinationRoot: secondDestination });
  assert.equal(second.decision, "independent-copy-ready", "a copied assistant could not be switched again");
  assert(readFileSync(join(secondDestination, ".assistant-local", "HOST-SWITCH-START.md"), "utf8").includes("不与原目录自动同步"));

  const shared = prepareAgentSwitch({ sourceRoot: source, mode: "shared" });
  assert.equal(shared.decision, "shared-folder");
  assert.equal(shared.syncPolicy, "reread-before-write-no-automatic-sync");
  let rejected = false;
  try { prepareAgentSwitch({ sourceRoot: source, destinationRoot: destination }); } catch { rejected = true; }
  assert(rejected, "an existing destination was silently replaced");
  console.log("Agent switch copy passed independent-copy, shared-folder, preservation, and collision checks.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
