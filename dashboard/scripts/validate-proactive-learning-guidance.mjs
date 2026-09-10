import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (ref) => readFileSync(resolve(repository, ...ref.split("/")), "utf8").replaceAll("\r\n", "\n");
const assert = (condition, message) => { if (!condition) throw new Error(`Proactive learning guidance failed: ${message}`); };
const matches = (source, patterns, label) => {
  for (const pattern of patterns) assert(pattern.test(source), `${label}: ${pattern}`);
};

const assistant = read("assistant.toml");
const root = read("AGENTS.md");
const guidance = read("core/protocols/USER_GUIDANCE.md");
const lifecycle = read("core/protocols/ASSET_LIFECYCLE.md");
const readmeZh = read("README.md");
const readmeEn = read("README.en.md");
const packageSource = read("dashboard/package.json");
const componentMap = read("core/maps/component-map.toml");

// Documentation coherence only. Executable recall/save/closeout checks cover
// behavior; this check must not freeze heading numbers or prose wording.
matches(assistant, [/proactive_learning\s*=\s*"[^"]+"/u, /formal_asset_activation\s*=\s*"explicit-user-or-verified-existing-approval-only"/u], "assistant policy");
matches(root, [/🌱/u, /🧠/u, /USER_GUIDANCE\.md/u], "root guidance");
matches(guidance, [/🌱 这一步还在学习/u, /🌱 这一步我学到了/u, /🧠 这次用上了/u, /👉/u, /task-closeout-contract/u], "user-requested receipt identity and closeout route");

matches(lifecycle, [
  /留下/u,
  /先观察/u,
  /以后提醒/u,
  /不保存/u,
  /learning-save-cli\.mjs/u,
], "asset lifecycle");
assert(!/(十分钟|10\s*分钟).*?(失效|过期|必须)/u.test(lifecycle), "an arbitrary reply timer returned as a learning gate");

matches(readmeZh, [/🧠 这次用上了/u, /🌱 这一步我学到了/u, /👉 接下来/u], "Chinese README receipt examples");
matches(readmeEn, [/🧠 Used this time/u, /🌱 Learned this step/u, /👉 What's next/u], "English README receipt examples");

assert(packageSource.includes('"check:proactive-learning": "node scripts/validate-proactive-learning-guidance.mjs"'), "package script is missing");
assert(packageSource.includes("npm run check:task-closeout"), "release path lost the closeout journey");
assert(componentMap.includes("dashboard/scripts/validate-proactive-learning-guidance.mjs"), "component ownership is missing");

console.log("Proactive learning documentation references and user-requested receipt labels are coherent; this is not a user-journey result.");
