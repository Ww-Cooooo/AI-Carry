import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectStartupCapsule } from "./startup-capsule-contract.mjs";

const rootOption = process.argv.indexOf("--root");
const repository = rootOption < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
  : resolve(process.argv[rootOption + 1]);
const forPublication = process.argv.includes("--for-publication");
const read = (ref) => readFileSync(resolve(repository, ...ref.split("/")), "utf8").replaceAll("\r\n", "\n");
const expect = (condition, message) => { if (!condition) throw new Error(`Release authority validation failed: ${message}`); };

function section(source, name = "") {
  if (name === "") return source.split(/^\[/mu, 1)[0];
  const match = new RegExp(`^\\[${name.replaceAll(".", "\\.")}\\]\\s*$`, "mu").exec(source);
  expect(match, `missing [${name}] section`);
  const tail = source.slice(match.index + match[0].length);
  const next = tail.search(/^\[/mu);
  return next < 0 ? tail : tail.slice(0, next);
}

function stringValue(source, key) {
  return new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, "mu").exec(source)?.[1];
}

function booleanValue(source, key) {
  const value = new RegExp(`^${key}\\s*=\\s*(true|false)\\s*$`, "mu").exec(source)?.[1];
  return value === undefined ? undefined : value === "true";
}

function arrayValue(source, key) {
  const literal = new RegExp(`^${key}\\s*=\\s*(\\[[^\\n]*\\])\\s*$`, "mu").exec(source)?.[1];
  try { return JSON.parse(literal ?? "null"); } catch { return null; }
}

function includesEvery(items, required, label) {
  expect(Array.isArray(items), `${label} is not an array`);
  for (const item of required) expect(items.includes(item), `${label} is missing ${item}`);
}

const assistant = read("assistant.toml");
const assistantRoot = section(assistant);
const version = stringValue(assistantRoot, "product_version");
expect(/^\d+\.\d+\.\d+$/u.test(version ?? ""), "assistant.toml does not provide one semantic product version");
expect(stringValue(assistantRoot, "product_id") === "ai-carry" && stringValue(assistantRoot, "product_name") === "AI Carry",
  "current product identity is not AI Carry");
expect(stringValue(assistantRoot, "core_version") === version, "assistant product and core versions differ");

const maintenance = section(assistant, "maintenance");
const releaseRef = stringValue(maintenance, "release_manifest");
expect(releaseRef === `core/upgrade/release-manifest-${version}.toml`, "assistant does not point to the current version manifest");

const manifest = read(releaseRef);
const manifestRoot = section(manifest);
expect(stringValue(manifestRoot, "release") === version && stringValue(manifestRoot, "core") === version,
  "current release manifest version differs from assistant.toml");
expect(stringValue(manifestRoot, "required_preview_executor") === "dashboard/scripts/ai-carry-upgrade-cli.mjs",
  "current release does not use the bundled upgrade entrypoint");
const sources = arrayValue(manifestRoot, "from_versions");
expect(Array.isArray(sources) && sources.length > 0 && new Set(sources).size === sources.length
  && sources.every((item) => /^\d+\.\d+\.\d+$/u.test(item) && item !== version),
"direct source versions are empty, duplicated, invalid, or include the target itself");

includesEvery(arrayValue(manifestRoot, "migrate"), ["instance/manifest.toml", "instance/startup-capsule.toml"], "migrate");
includesEvery(arrayValue(manifestRoot, "preserve"), [
  "instance/memory/**", "instance/capabilities/**", "instance/sops/**", "instance/experiences/**",
  "instance/evolution/**", "instance/skills/**", "instance/components/**", "instance/validations/**",
  "workspace/**", ".assistant-private/**", ".assistant-local/**",
], "preserve");
expect(Array.isArray(arrayValue(manifestRoot, "remove")), "remove must be an explicit array even when empty");

const targetSelection = section(manifest, "target_selection");
includesEvery(arrayValue(targetSelection, "forbidden_segments"), [
  ".git", "node_modules", "maintainer-private", ".assistant-private", ".assistant-local",
], "target selection forbidden segments");
const overrides = arrayValue(targetSelection, "allow_overrides_deny_for_exact_paths");
expect(Array.isArray(overrides) && overrides.every((ref) => /^\.assistant-(?:local|private)\/(?:[^/]+\/)*\.gitkeep$/u.test(ref)),
  "private/local overrides must be exact placeholder files only");

const boundary = section(manifest, "release_boundary");
const status = stringValue(boundary, "status");
expect(["local-unreleased-candidate", "published-release"].includes(status), "release boundary status is invalid");
expect(!forPublication || status === "published-release",
  "final public candidate still declares a local unreleased boundary; instances cannot install it");
expect(stringValue(boundary, "release_ref") === `v${version}`, "release boundary does not name the current fixed tag");
expect(booleanValue(boundary, "future_publication_or_repository_operation_authorized") === false,
  "the current release incorrectly authorizes future publication actions");
if (status === "published-release") {
  expect(booleanValue(boundary, "publication_authorized") === true
    && booleanValue(boundary, "repository_operation_authorized") === true
    && booleanValue(boundary, "instance_replacement_authorized") === true,
  "published boundary does not authorize this fixed release consistently");
} else {
  expect(booleanValue(boundary, "publication_authorized") === false
    && booleanValue(boundary, "repository_operation_authorized") === false
    && booleanValue(boundary, "instance_replacement_authorized") === false,
  "an unreleased candidate authorizes publication or instance replacement");
}
includesEvery(arrayValue(boundary, "authority_requires"), [
  `official-release-object-v${version}`, `official-lightweight-tag-v${version}`,
  "manifest-and-extracted-tree-match-the-fixed-tag", "user-explicitly-authorized-this-upgrade",
], "release authority requirements");

const packageSource = JSON.parse(read("dashboard/package.json"));
expect(packageSource.version === version, "Dashboard package version differs from assistant.toml");
expect(packageSource.scripts?.upgrade === "node scripts/ai-carry-upgrade-cli.mjs"
  && packageSource.scripts?.["check:release"]?.includes("check:release-authority")
  && packageSource.scripts?.["check:release"]?.includes("check:compliance")
  && packageSource.scripts?.["check:release"]?.includes("check:journeys")
  && !packageSource.scripts?.build?.includes("check:journeys")
  && !packageSource.scripts?.build?.includes("check:release-authority"),
"ordinary compilation and once-per-release journey checks are not separated");
expect(inspectStartupCapsule(repository).decision === "startup-capsule-valid",
  "checked-in blank-template startup capsule is not synchronized with current truth");

console.log(`AI Carry ${version} ${forPublication ? "final public candidate" : "local development"} release boundary passed. This check does not authorize publishing.`);
