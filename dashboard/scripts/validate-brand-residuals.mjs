import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scannerRef = "dashboard/scripts/validate-brand-residuals.mjs";
const legacyDisplay = ["Agent", "Carry"].join(" ");
const legacyDashed = ["Agent", "Carry"].join("-");
const legacyPattern = new RegExp(`${legacyDisplay}|${legacyDashed}|agent-carry|AGENT_CARRY|AgentCarry|agentCarry|agent_carry`, "gu");
const legacyPathPattern = new RegExp(`${legacyDisplay}|${legacyDashed}|agent-carry|AGENT_CARRY|AgentCarry|agent_carry`, "u");
const textExtensions = new Set(["", ".md", ".toml", ".mjs", ".js", ".ts", ".tsx", ".json", ".html", ".txt", ".py", ".yml", ".yaml"]);
const skippedRoots = new Set([".git", ".planning", ".assistant-local", ".assistant-private", ".agents", ".claude", "maintainer-private", "node_modules", "workspace", "instance"]);

const compatibilityFiles = new Set([
  "assistant.toml", "BOOTSTRAP.md", "README.md", "README.en.md", "INSTALL.md", "INSTALL.en.md",
  "core/maps/root-map.toml", "core/maps/assistant-maintenance.toml", "core/protocols/PRODUCT_IDENTITY.md",
  "core/schemas/extension-manifest.schema.md", "core/schemas/host-integration.schema.md",
  "core/schemas/instance-component.schema.md", "core/schemas/migration-kit.schema.md",
  "core/schemas/private-asset-catalog.schema.md", "core/schemas/startup-capsule.schema.md",
  "core/tools/private_data_migration.py",
  "core/upgrade/official-source.toml", "core/guides/upgrade-guide.md",
  "dashboard/scripts/ai-carry-upgrade-cli.mjs", "dashboard/scripts/product-identity.mjs",
  "dashboard/scripts/snapshot-envelope.mjs", "dashboard/scripts/validate-product-identity-contract.mjs",
  "dashboard/scripts/validate-snapshot-source-builder.mjs", "dashboard/scripts/validate-startup-capsule-contract.mjs",
  "dashboard/public/snapshot.js", "dashboard/dist/snapshot.js", "dashboard/dist/index.html",
  "dashboard/src/Dashboard.tsx", "dashboard/src/app/client-state.tsx", "dashboard/src/lib/data.ts", "dashboard/src/lib/i18n.tsx",
  "_data/example-snapshot.js", "dashboard.html", "dashboard.en.html",
]);

const repositoryLocations = ["Ww-Cooooo/Agent-Carry", "ww-cooooo.github.io/Agent-Carry", "Agent-Carry-main"];
const legacyOutputPrefixes = ["Agent-Carry-Migration-", "Agent-Carry-Private-Export-"];
const compatibilityContext = /旧名|旧版|旧.{0,16}(?:实例|组件|专业|隐私|宿主|接口|快照|产品)|历史|兼容|更名|曾用名|仓库名|地址|只读|不得继续生成|legacy|histor|compatib|renamed?|old\s+(?:name|version|identity|instance)|repository|slug|read-only|1\.[0-9]/iu;
const machineAlias = /agent-carry-(?:core|startup|instance-component|professional-extension|private|official)|agent-carry\.(?:instance-component)|agent-carry-root|AGENT_CARRY|agent_carry_written/iu;

function refOf(path) { return relative(repository, path).split(sep).join("/"); }
function overlaps(line, match, fragment) {
  let cursor = 0;
  while (cursor <= line.length) {
    const start = line.indexOf(fragment, cursor);
    if (start < 0) return false;
    if (match.index >= start && match.index + match[0].length <= start + fragment.length) return true;
    cursor = start + 1;
  }
  return false;
}
function archivedRelease(ref) {
  return /^core\/upgrade\/(?:release-manifest-|upgrade-).+\.(?:toml|md)$/u.test(ref)
    && !ref.endsWith("release-manifest-2.0.9.toml");
}
function classify(ref, line, match) {
  if (repositoryLocations.some((fragment) => overlaps(line, match, fragment))) return "repository-location";
  const outputPrefix = legacyOutputPrefixes.find((fragment) => overlaps(line, match, fragment));
  if (outputPrefix) return compatibilityContext.test(line) ? "legacy-output-read-only" : "invalid-new-output";
  if (archivedRelease(ref)) return "release-history";
  const quotedAlias = [`"${match[0]}"`, `'${match[0]}'`, `\`${match[0]}\``].some((value) => overlaps(line, match, value));
  if ((machineAlias.test(line) || quotedAlias) && (compatibilityFiles.has(ref)
    || /^core\/upgrade\/release-manifest-\d+\.\d+\.\d+\.toml$/u.test(ref))) return "machine-alias";
  if (compatibilityContext.test(line) && (compatibilityFiles.has(ref) || ref.startsWith("docs/")
    || ref === "CONTRIBUTING.md" || ref === "SECURITY.md" || ref.startsWith("core/upgrade/"))) return "documented-compatibility";
  return "";
}

function synthetic(ref, line, value, expected) {
  const index = line.indexOf(value);
  if (index < 0 || classify(ref, line, { 0: value, index }) !== expected) {
    throw new Error(`Brand residual validator self-check failed for ${value}`);
  }
}
synthetic("START-HERE.txt", "Agent Carry", legacyDisplay, "");
synthetic("BOOTSTRAP.md", "Agent Carry 是 AI Carry 的旧名", legacyDisplay, "documented-compatibility");
synthetic("dashboard/src/app/client-state.tsx", "window.AGENT_CARRY_SNAPSHOT", "AGENT_CARRY", "machine-alias");
synthetic("dashboard/src/app/client-state.tsx", "Agent Carry", legacyDisplay, "");
synthetic("assistant.toml", "legacy repository https://github.com/Ww-Cooooo/Agent-Carry", legacyDashed, "repository-location");
synthetic("core/schemas/migration-kit.schema.md", "new Agent-Carry-Migration-demo", legacyDashed, "invalid-new-output");
synthetic("core/schemas/migration-kit.schema.md", "旧版 Agent-Carry-Migration-demo 只读兼容", legacyDashed, "legacy-output-read-only");

const matches = [];
function visit(directory) {
  for (const name of readdirSync(directory).sort()) {
    if (skippedRoots.has(name)) continue;
    const absolute = resolve(directory, name); const ref = refOf(absolute); const info = lstatSync(absolute);
    if (info.isSymbolicLink() || info.isReparsePoint?.()) throw new Error(`Brand residual validation failed: linked product path ${ref}`);
    if (legacyPathPattern.test(ref)) throw new Error(`Brand residual validation failed: current product path uses the old identity: ${ref}`);
    if (info.isDirectory()) { visit(absolute); continue; }
    if (ref === scannerRef || ref.startsWith("dashboard/scripts/validate-") || ref.startsWith("core/tools/tests/")
      || !info.isFile() || !textExtensions.has(extname(name).toLowerCase())) continue;
    const sizeLimit = ref.startsWith("dashboard/dist/") ? 16 * 1024 * 1024 : 2 * 1024 * 1024;
    if (info.size > sizeLimit) continue;
    let source;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute)); } catch { continue; }
    if (/\bAICarry\b/u.test(source)) throw new Error(`Brand residual validation failed: AI Carry is missing its space in ${ref}`);
    for (const [lineIndex, line] of source.split("\n").entries()) {
      for (const match of line.matchAll(legacyPattern)) matches.push({ ref, line: lineIndex + 1, text: match[0], category: classify(ref, line, match) });
    }
  }
}
visit(repository);

const invalid = matches.filter((item) => !item.category || item.category === "invalid-new-output");
if (invalid.length) throw new Error(`Brand residual validation failed:\n${invalid.map((item) => `${item.ref}:${item.line}:${item.text}`).join("\n")}`);
const counts = Object.fromEntries([...new Set(matches.map((item) => item.category))].sort()
  .map((category) => [category, matches.filter((item) => item.category === category).length]));
console.log(`AI Carry brand scan passed ${matches.length} classified compatibility/history matches with no current unclassified output; ${JSON.stringify(counts)}.`);
