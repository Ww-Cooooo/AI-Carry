const stableId = /^[a-z0-9][a-z0-9._:-]{0,159}$/;
const identityRef = /^ac-[0-9a-f]{12}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const riskTiers = new Set(["low", "medium", "high"]);
const formalStatuses = new Set(["active", "provisional", "review", "history", "paused", "archived"]);
const candidateStatuses = new Set(["candidate", "review"]);
const maturityValues = new Set(["unvalidated", "practiced", "reliable", "portable"]);
const memorySubtypes = new Set(["general", "habit"]);
const experienceSubtypes = new Set(["task", "host-execution"]);
const evolutionTargets = new Set(["memory", "capability", "sop", "experience", "preference", "unknown"]);
const todoStatuses = new Set(["pending", "done", "paused", "cancelled", "history"]);
const rootKeys = new Set(["meta", "overview", "profile", "model", "health", "assets", "memories", "sops", "capabilities", "experiences", "evolution", "governance", "todo", "deferred", "skills", "changes", "advanced"]);
const formalItemKeys = new Set(["id", "title", "summary", "subtype", "triggers", "scope_summary", "source_summary", "evidence_summary", "reliability", "status", "approval_state", "activation_basis", "risk_tier", "approved_by_user", "maturity"]);
const candidateItemKeys = new Set(["id", "title", "summary", "status", "source_summary", "target_kind", "target_subtype", "next_step", "observation_state", "observation_basis"]);
const skillItemKeys = new Set(["id", "title", "summary", "triggers", "platform", "state"]);
const skillExportKeys = new Set(["id", "title", "summary", "state", "delivery_method", "delivery_state"]);

function fail(label, message) {
  throw new Error(`${label} semantic validation failed: ${message}`);
}

function object(value, label, path) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(label, `${path} must be a plain JSON object`);
  }
  return value;
}

function exactKeys(value, allowed, required, label, path) {
  object(value, label, path);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) fail(label, `${path} has an unknown field or is missing a required field`);
}

function text(value, label, path, { max = 2048, allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "") || [...value].length > max || value.normalize("NFC") !== value || unsafeText.test(value)) {
    fail(label, `${path} must be bounded NFC text without control or bidi characters`);
  }
  return value;
}

function count(value, label, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(label, `${path} must be a nonnegative safe integer`);
  return value;
}

function textList(value, label, path, { maxItems = 16, maxText = 1000, allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) fail(label, `${path} must be an array with at most ${maxItems} entries`);
  value.forEach((item, index) => text(item, label, `${path}[${index}]`, { max: maxText, allowEmpty }));
  return value;
}

function validateAllProjectedData(value, label, path = "$", depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 10000 || depth > 12) fail(label, `${path} exceeds the bounded projection structure`);
  if (typeof value === "string") { text(value, label, path, { max: 4096, allowEmpty: true }); return; }
  if (typeof value === "number") { if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail(label, `${path} must be a finite safe integer`); return; }
  if (["boolean", "undefined"].includes(typeof value) || value === null) return;
  if (Array.isArray(value)) {
    if (value.length > 1024) fail(label, `${path} has too many projected entries`);
    value.forEach((item, index) => validateAllProjectedData(item, label, `${path}[${index}]`, depth + 1, budget));
    return;
  }
  object(value, label, path);
  const keys = Object.keys(value);
  if (keys.length > 128) fail(label, `${path} has too many object fields`);
  for (const [key, item] of Object.entries(value)) {
    text(key, label, `${path}.<key>`, { max: 160 });
    validateAllProjectedData(item, label, `${path}.${key}`, depth + 1, budget);
  }
}

function usableAuthorization(item) {
  if (!riskTiers.has(item.risk_tier)) return false;
  if (item.status === "provisional" && item.risk_tier !== "low") return false;
  return item.approval_state === "explicit"
    && ["explicit-user", "existing-approved-migration"].includes(item.activation_basis)
    && item.approved_by_user === true;
}

function validateFormalItem(item, kind, label, path, requireMaturity) {
  object(item, label, path);
  exactKeys(item, formalItemKeys, ["id", "title", "summary", "status", "approval_state", "activation_basis", "risk_tier", "approved_by_user"], label, path);
  text(item.id, label, `${path}.id`, { max: 160 });
  if (!stableId.test(item.id)) fail(label, `${path}.id is not a stable AI Carry ID`);
  text(item.title, label, `${path}.title`, { max: 160 });
  text(item.summary, label, `${path}.summary`, { max: 1000 });
  if (Object.hasOwn(item, "subtype")) {
    text(item.subtype, label, `${path}.subtype`, { max: 40 });
    const allowed = kind === "memory" ? memorySubtypes : kind === "experiences" ? experienceSubtypes : null;
    if (allowed && !allowed.has(item.subtype)) fail(label, `${path}.subtype is invalid for ${kind}`);
  }
  if (Object.hasOwn(item, "triggers")) textList(item.triggers, label, `${path}.triggers`, { maxItems: 8, maxText: 80, allowEmpty: false });
  for (const field of ["scope_summary", "source_summary", "evidence_summary", "reliability"]) {
    if (Object.hasOwn(item, field)) text(item[field], label, `${path}.${field}`, { max: field === "reliability" ? 80 : 1000 });
  }
  text(item.status, label, `${path}.status`, { max: 32 });
  if (!formalStatuses.has(item.status)) fail(label, `${path}.status is not a formal asset state`);
  text(item.approval_state, label, `${path}.approval_state`, { max: 40 });
  text(item.activation_basis, label, `${path}.activation_basis`, { max: 64 });
  text(item.risk_tier, label, `${path}.risk_tier`, { max: 16 });
  if (!riskTiers.has(item.risk_tier)) fail(label, `${path}.risk_tier is invalid`);
  if (typeof item.approved_by_user !== "boolean") fail(label, `${path}.approved_by_user must be an explicit boolean in Schema 1.1`);
  if (["memory", "experiences"].includes(kind) && !Object.hasOwn(item, "subtype")) {
    const legacyExplicit = item.approval_state === "explicit" && item.approved_by_user === true
      && ["explicit-user", "existing-approved-migration"].includes(item.activation_basis);
    if (!legacyExplicit) fail(label, `${path} lacks a subtype and is not an explicitly authorized legacy item`);
  }
  if (["active", "provisional"].includes(item.status) && !usableAuthorization(item)) {
    fail(label, `${path} claims a usable state with an invalid authorization combination`);
  }
  if (item.subtype === "habit" && item.status === "provisional" && !usableAuthorization(item)) {
    fail(label, `${path} claims a usable habit without explicit low-risk authorization`);
  }
  if (requireMaturity || Object.hasOwn(item, "maturity")) {
    const maturity = item.maturity ?? item.reliability;
    text(maturity, label, `${path}.maturity`, { max: 40 });
    if (!maturityValues.has(maturity)) fail(label, `${path}.maturity is invalid`);
  }
  return item.id;
}

function validateCandidate(item, label, path) {
  object(item, label, path);
  exactKeys(item, candidateItemKeys, ["id", "title", "summary", "status", "source_summary", "target_kind", "next_step", "observation_state", "observation_basis"], label, path);
  text(item.id, label, `${path}.id`, { max: 160 });
  if (!stableId.test(item.id)) fail(label, `${path}.id is not a stable AI Carry ID`);
  text(item.title, label, `${path}.title`, { max: 160 });
  text(item.summary, label, `${path}.summary`, { max: 1000 });
  text(item.status, label, `${path}.status`, { max: 32 });
  if (!candidateStatuses.has(item.status)) fail(label, `${path}.status must be candidate or review`);
  text(item.source_summary, label, `${path}.source_summary`, { max: 1000 });
  text(item.target_kind, label, `${path}.target_kind`, { max: 40 });
  if (!evolutionTargets.has(item.target_kind)) fail(label, `${path}.target_kind is invalid`);
  if (Object.hasOwn(item, "target_subtype")) text(item.target_subtype, label, `${path}.target_subtype`, { max: 80, allowEmpty: true });
  const targetSubtype = item.target_subtype ?? "";
  const subtypeValid = item.target_kind === "memory" ? ["", "general", "habit"].includes(targetSubtype)
    : item.target_kind === "experience" ? ["task", "host-execution"].includes(targetSubtype)
      : targetSubtype === "";
  if (!subtypeValid) fail(label, `${path}.target_subtype is incompatible with target_kind`);
  text(item.next_step, label, `${path}.next_step`, { max: 1000 });
  text(item.observation_state, label, `${path}.observation_state`, { max: 40 });
  text(item.observation_basis, label, `${path}.observation_basis`, { max: 64 });
  const legalObservation = (item.observation_state === "explicit" && ["explicit-user", "existing-approved-migration"].includes(item.observation_basis))
    || (item.observation_state === "pending" && item.observation_basis === "unknown")
    || (item.observation_state === "revoked" && ["explicit-user", "existing-approved-migration"].includes(item.observation_basis));
  if (!legalObservation) fail(label, `${path} has an invalid observation authorization combination`);
  return item.id;
}

export function validateSnapshotSemantics(snapshot, label = "snapshot") {
  object(snapshot, label, "$");
  exactKeys(snapshot, rootKeys, ["meta", "overview", "profile", "assets", "memories", "sops", "capabilities", "experiences", "evolution", "governance", "todo", "deferred", "skills", "changes", "advanced"], label, "$");
  validateAllProjectedData(snapshot, label);
  const meta = object(snapshot.meta, label, "$.meta");
  const profile = object(snapshot.profile, label, "$.profile");
  const assets = object(snapshot.assets, label, "$.assets");
  const overview = object(snapshot.overview, label, "$.overview");
  exactKeys(meta, new Set(["schema_version", "generated_at", "product_version", "state", "freshness_seconds", "source_digest", "identity_ref"]), ["schema_version", "generated_at", "product_version", "state", "freshness_seconds", "source_digest", "identity_ref"], label, "$.meta");
  exactKeys(overview, new Set(["product", "state", "domain", "startup_chars", "startup_budget"]), ["product", "state", "domain", "startup_chars", "startup_budget"], label, "$.overview");
  exactKeys(profile, new Set(["display_name", "mission", "domain_id", "guidance_mode", "learning_policy", "language"]), ["display_name", "mission", "domain_id", "guidance_mode", "learning_policy", "language"], label, "$.profile");
  exactKeys(assets, new Set(["memory", "sops", "capabilities", "experiences", "evolution", "todo", "governance", "skills"]), ["memory", "sops", "capabilities", "experiences", "evolution", "todo", "governance", "skills"], label, "$.assets");
  const serialized = JSON.stringify(snapshot);
  if (locateHighConfidenceSecretCandidates(serialized).blocked || containsForbiddenLocationReference(serialized)) fail(label, "snapshot contains secret-bearing or absolute-location content");

  text(meta.schema_version, label, "$.meta.schema_version", { max: 32 });
  if (meta.schema_version !== "1.1") fail(label, "$.meta.schema_version is not supported for newly generated snapshots");
  text(meta.product_version, label, "$.meta.product_version", { max: 64 });
  text(meta.state, label, "$.meta.state", { max: 32 });
  if (!["template", "instance"].includes(meta.state)) fail(label, "$.meta.state must be template or instance for a formal local snapshot");
  text(overview.state, label, "$.overview.state", { max: 32 });
  if (overview.state !== meta.state) fail(label, "$.overview.state must equal $.meta.state");
  count(meta.freshness_seconds, label, "$.meta.freshness_seconds");
  text(meta.source_digest, label, "$.meta.source_digest", { max: 96 });
  text(meta.identity_ref, label, "$.meta.identity_ref", { max: 32 });
  text(profile.display_name, label, "$.profile.display_name", { max: 160 });
  text(profile.mission, label, "$.profile.mission", { max: 512 });
  text(profile.domain_id, label, "$.profile.domain_id", { max: 160 });
  text(profile.guidance_mode, label, "$.profile.guidance_mode", { max: 32 });
  text(profile.learning_policy, label, "$.profile.learning_policy", { max: 32 });
  text(profile.language, label, "$.profile.language", { max: 80 });
  if (!["unselected", "step-by-step", "balanced", "direct"].includes(profile.guidance_mode)) fail(label, "$.profile.guidance_mode is invalid");
  if (!["unselected", "risk-tiered", "manual-only"].includes(profile.learning_policy)) fail(label, "$.profile.learning_policy is invalid");
  if (Object.hasOwn(snapshot, "actions")) fail(label, "$.actions must be omitted from newly generated formal snapshots");

  count(overview.startup_chars, label, "$.overview.startup_chars");
  count(overview.startup_budget, label, "$.overview.startup_budget");
  text(overview.product, label, "$.overview.product", { max: 80 });
  text(overview.domain, label, "$.overview.domain", { max: 160 });

  if (Object.hasOwn(snapshot, "model")) {
    const model = object(snapshot.model, label, "$.model");
    exactKeys(model, new Set(["level", "name", "platform", "confirmed_at", "status"]), ["level", "name", "platform", "confirmed_at", "status"], label, "$.model");
    if (![1, 2, 3].includes(model.level)) fail(label, "$.model.level must be 1, 2, or 3");
    for (const field of ["name", "platform", "confirmed_at", "status"]) text(model[field], label, `$.model.${field}`, { max: field === "name" ? 160 : 80, allowEmpty: field === "confirmed_at" });
  }

  if (Object.hasOwn(snapshot, "health")) {
    const health = object(snapshot.health, label, "$.health");
    exactKeys(health,
      new Set(["state", "isolated_item_count", "affected_areas", "source_data_preserved", "summary", "next_step"]),
      ["state", "isolated_item_count", "affected_areas", "source_data_preserved", "summary", "next_step"], label, "$.health");
    if (meta.state !== "instance" || health.state !== "degraded") fail(label, "$.health is only valid for a degraded instance projection");
    const isolatedCount = count(health.isolated_item_count, label, "$.health.isolated_item_count");
    if (isolatedCount < 1) fail(label, "$.health.isolated_item_count must be a positive safe integer");
    textList(health.affected_areas, label, "$.health.affected_areas", { maxItems: 12, maxText: 40, allowEmpty: false });
    if (health.affected_areas.length < 1 || new Set(health.affected_areas).size !== health.affected_areas.length
      || health.affected_areas.some((area) => !stableId.test(area))) fail(label, "$.health.affected_areas must be unique stable category IDs");
    if (health.source_data_preserved !== true) fail(label, "$.health.source_data_preserved must explicitly preserve source data");
    text(health.summary, label, "$.health.summary", { max: 320 });
    text(health.next_step, label, "$.health.next_step", { max: 320 });
  }

  if (meta.state === "template") {
    if (meta.identity_ref !== "template" || profile.guidance_mode !== "unselected" || profile.learning_policy !== "unselected" || meta.generated_at !== "" || meta.source_digest !== "template-empty") {
      fail(label, "template identity, policy, timestamp, or digest is inconsistent with the formal empty state");
    }
  } else {
    if (!identityRef.test(meta.identity_ref) || !digest.test(meta.source_digest)) fail(label, "instance identity_ref or source_digest is invalid");
    if (profile.guidance_mode === "unselected" || profile.learning_policy === "unselected") fail(label, "an instance cannot retain unselected guidance or learning policy");
    const generated = Date.parse(meta.generated_at);
    if (!Number.isFinite(generated) || !/[zZ]|[+-]\d{2}:\d{2}$/u.test(meta.generated_at)) fail(label, "instance generated_at must be an ISO 8601 timestamp with timezone");
  }

  const arrays = {
    memory: snapshot.memories,
    sops: snapshot.sops,
    capabilities: snapshot.capabilities,
    experiences: snapshot.experiences,
    evolution: snapshot.evolution,
    todo: snapshot.todo,
    governance: snapshot.governance,
  };
  const ids = new Set();
  for (const [assetKind, value] of Object.entries(arrays)) {
    if (!Array.isArray(value)) fail(label, `$.${assetKind === "memory" ? "memories" : assetKind} must be an array`);
    if (value.length > 1024) fail(label, `$.${assetKind} exceeds the dashboard projection item limit`);
    const expected = count(assets[assetKind], label, `$.assets.${assetKind}`);
    if (expected !== value.length) fail(label, `$.assets.${assetKind} does not equal its projected array length`);

    value.forEach((item, index) => {
      const path = `$.${assetKind}[${index}]`;
      let id;
      if (assetKind === "evolution") id = validateCandidate(item, label, path);
      else if (["memory", "sops", "capabilities", "experiences"].includes(assetKind)) id = validateFormalItem(item, assetKind, label, path, ["sops", "capabilities"].includes(assetKind) || (assetKind === "experiences" && item?.subtype === "host-execution"));
      else {
        object(item, label, path);
        if (assetKind === "todo") exactKeys(item, new Set(["id", "title", "summary", "status", "visible"]), ["id", "title", "summary", "status"], label, path);
        if (assetKind === "governance") exactKeys(item, new Set(["id", "title", "summary", "frequency", "status", "purpose", "steps", "last_completed_at", "next_due_at", "schedule_state"]), ["id", "title", "summary", "frequency", "status", "purpose", "steps"], label, path);
        text(item.id, label, `${path}.id`, { max: 160 });
        if (!stableId.test(item.id)) fail(label, `${path}.id is invalid`);
        text(item.title, label, `${path}.title`, { max: 160 });
        text(item.summary, label, `${path}.summary`, { max: 1000 });
        id = item.id;
        if (assetKind === "todo") {
          text(item.status, label, `${path}.status`, { max: 32 });
          if (!todoStatuses.has(item.status)) fail(label, `${path}.status is invalid`);
          if (Object.hasOwn(item, "visible") && typeof item.visible !== "boolean") fail(label, `${path}.visible must be boolean when present`);
        }
        if (assetKind === "governance") {
          text(item.frequency, label, `${path}.frequency`, { max: 160 });
          text(item.status, label, `${path}.status`, { max: 32 });
          text(item.purpose, label, `${path}.purpose`, { max: 1000 });
          if (!Array.isArray(item.steps) || item.steps.length === 0 || item.steps.length > 20) fail(label, `${path}.steps must be a bounded nonempty array`);
          item.steps.forEach((step, stepIndex) => text(step, label, `${path}.steps[${stepIndex}]`, { max: 1000 }));
        }
      }
      if (ids.has(id)) fail(label, `duplicate stable ID across snapshot arrays: ${id}`);
      ids.add(id);
    });
  }

  const skills = object(snapshot.skills, label, "$.skills");
  exactKeys(skills, new Set(["count", "status", "path", "items", "exports"]), ["count", "status", "path"], label, "$.skills");
  const skillCount = count(skills.count, label, "$.skills.count");
  text(skills.status, label, "$.skills.status", { max: 160 });
  text(skills.path, label, "$.skills.path", { max: 512, allowEmpty: true });
  if (count(assets.skills, label, "$.assets.skills") !== skillCount) fail(label, "$.assets.skills does not equal $.skills.count");
  if (Object.hasOwn(skills, "items")) {
    if (!Array.isArray(skills.items) || skills.items.length > 256 || skills.items.length !== skillCount) fail(label, "$.skills.items must be bounded and equal $.skills.count");
    const skillIds = new Set();
    skills.items.forEach((item, index) => {
      const path = `$.skills.items[${index}]`;
      exactKeys(item, skillItemKeys, ["id", "title", "summary", "triggers", "platform", "state"], label, path);
      text(item.id, label, `${path}.id`, { max: 160 });
      if (!stableId.test(item.id) || skillIds.has(item.id)) fail(label, `${path}.id is invalid or duplicated`);
      skillIds.add(item.id);
      text(item.title, label, `${path}.title`, { max: 160 });
      text(item.summary, label, `${path}.summary`, { max: 240 });
      textList(item.triggers, label, `${path}.triggers`, { maxItems: 8, maxText: 80, allowEmpty: false });
      text(item.platform, label, `${path}.platform`, { max: 80, allowEmpty: true });
      text(item.state, label, `${path}.state`, { max: 32 });
      if (!["available", "review", "unavailable"].includes(item.state)) fail(label, `${path}.state is invalid`);
    });
  }
  if (Object.hasOwn(skills, "exports")) {
    if (!Array.isArray(skills.exports) || skills.exports.length > 128) fail(label, "$.skills.exports must be a bounded array");
    const exportIds = new Set();
    skills.exports.forEach((item, index) => {
      const path = `$.skills.exports[${index}]`;
      exactKeys(item, skillExportKeys, ["id", "title", "summary", "state"], label, path);
      text(item.id, label, `${path}.id`, { max: 160 });
      if (!stableId.test(item.id) || exportIds.has(item.id)) fail(label, `${path}.id is invalid or duplicated`);
      exportIds.add(item.id);
      text(item.title, label, `${path}.title`, { max: 160 });
      text(item.summary, label, `${path}.summary`, { max: 500 });
      text(item.state, label, `${path}.state`, { max: 32 });
      if (!["draft", "ready", "review"].includes(item.state)) fail(label, `${path}.state is invalid`);
      const hasDeliveryMethod = Object.hasOwn(item, "delivery_method");
      const hasDeliveryState = Object.hasOwn(item, "delivery_state");
      if (hasDeliveryMethod !== hasDeliveryState) fail(label, `${path} has a partial delivery projection`);
      if (hasDeliveryMethod) {
        text(item.delivery_method, label, `${path}.delivery_method`, { max: 32, allowEmpty: true });
        text(item.delivery_state, label, `${path}.delivery_state`, { max: 32 });
        if (!["", "zip", "folder", "link", "local-only"].includes(item.delivery_method)) fail(label, `${path}.delivery_method is invalid`);
        if (!["unselected", "local-only", "artifact-ready", "target-needed", "link-ready", "stale", "review"].includes(item.delivery_state)) fail(label, `${path}.delivery_state is invalid`);
      }
    });
  }

  if (!Array.isArray(snapshot.deferred) || snapshot.deferred.length > 256) fail(label, "$.deferred must be a bounded array");
  snapshot.deferred.forEach((item, index) => {
    object(item, label, `$.deferred[${index}]`);
    exactKeys(item, new Set(["summary", "level", "remind", "status"]), ["summary", "level", "remind"], label, `$.deferred[${index}]`);
    text(item.summary, label, `$.deferred[${index}].summary`, { max: 1000 });
    if (![1, 2, 3].includes(item.level)) fail(label, `$.deferred[${index}].level must be 1, 2, or 3`);
    text(item.remind, label, `$.deferred[${index}].remind`, { max: 80, allowEmpty: true });
    if (Object.hasOwn(item, "status")) text(item.status, label, `$.deferred[${index}].status`, { max: 32 });
  });
  if (!Array.isArray(snapshot.changes) || snapshot.changes.length > 256) fail(label, "$.changes must be a bounded array");
  snapshot.changes.forEach((item, index) => {
    object(item, label, `$.changes[${index}]`);
    exactKeys(item, new Set(["date", "summary"]), ["date", "summary"], label, `$.changes[${index}]`);
    text(item.date, label, `$.changes[${index}].date`, { max: 80 });
    text(item.summary, label, `$.changes[${index}].summary`, { max: 1000 });
  });
  const advanced = object(snapshot.advanced, label, "$.advanced");
  exactKeys(advanced, new Set(["file_count", "entry_files"]), ["file_count", "entry_files"], label, "$.advanced");
  count(advanced.file_count, label, "$.advanced.file_count");
  textList(advanced.entry_files, label, "$.advanced.entry_files", { maxItems: 128, maxText: 240, allowEmpty: false });

  if (meta.state === "template") {
    for (const [assetKind, value] of Object.entries(arrays)) {
      if (value.length !== 0 || assets[assetKind] !== 0) fail(label, `formal template contains nonempty ${assetKind} data`);
    }
    if (skillCount !== 0 || (skills.items?.length ?? 0) !== 0 || (skills.exports?.length ?? 0) !== 0) fail(label, "formal template contains nonempty skills data");
  }
  return snapshot;
}
import { locateHighConfidenceSecretCandidates } from "./secret-content-boundary.mjs";
import { containsForbiddenLocationReference } from "./safe-output-boundary.mjs";
