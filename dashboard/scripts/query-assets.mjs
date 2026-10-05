// Optional defense-in-depth adapter for hosts that already provide a JavaScript
// runtime. AI Carry installation and the offline dashboard do not require it.
// The repository root is derived from this file; callers cannot supply a path.
//
// A body read is deliberately inseparable from the query that selected it. This
// process never accepts a bare stable ID as a body-read capability and never
// treats a caller's model-level claim as an authorization ticket.

import { readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectShortlistedFormalAsset, queryFormalAssetShortlist, stableAssetId } from "./asset-route-contract.mjs";
import { normalizeRetrievalRequest, projectRecallUse } from "./bounded-retrieval.mjs";
import { assertLocationFreeProjection } from "./safe-output-boundary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const decoder = new TextDecoder("utf-8", { fatal: true });
const queryPurposes = new Set(["task-recall", "learning-review"]);
const learningSignals = new Set(["none", "user-explicit-learning-review", "formal-no-match-with-reusable-pattern"]);
const safeReasonCodes = new Set([
  "input-size-invalid", "input-json-invalid", "query-fields-invalid", "query-invalid", "query-too-long", "query-empty",
  "intent-hints-invalid", "intent-hint-invalid", "work-signals-invalid", "work-signal-invalid", "query-purpose-or-learning-signal-invalid",
  "task-recall-cannot-assert-learning-signal", "selected-id-invalid", "selected-id-not-in-current-shortlist",
  "operation-unsupported", "output-size-exceeded", "unsafe-output",
]);

function stop(reason) {
  const code = safeReasonCodes.has(reason) ? reason : "request-failed-closed";
  process.stdout.write(`${JSON.stringify({ decision: "request-rejected", reason: code, executable: false })}\n`);
  process.exitCode = 2;
}

function exactKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).every((key) => allowed.has(key) && !["__proto__", "prototype", "constructor"].includes(key));
}

function validateQueryInput(input, { withSelection = false } = {}) {
  const allowed = new Set(["operation", "queryText", "intentHints", "workSignals", "purpose", "learningSignal"]);
  if (withSelection) allowed.add("selectedId");
  if (!exactKeys(input, allowed)) throw new Error("query-fields-invalid");
  const retrieval = normalizeRetrievalRequest(input.queryText ?? "", input.intentHints ?? [], input.workSignals ?? []);
  if (!retrieval.ok) throw new Error(retrieval.reason);
  const purpose = input.purpose ?? "task-recall";
  const learningSignal = input.learningSignal ?? "none";
  if (!queryPurposes.has(purpose) || !learningSignals.has(learningSignal)) throw new Error("query-purpose-or-learning-signal-invalid");
  if (purpose === "task-recall" && learningSignal !== "none") throw new Error("task-recall-cannot-assert-learning-signal");
  if (withSelection && !stableAssetId.test(input.selectedId ?? "")) throw new Error("selected-id-invalid");
  return Object.freeze({ retrieval, purpose, learningSignal });
}

function buildBoundedQuery(input, controls) {
  const formal = queryFormalAssetShortlist(root, { queryText: input.queryText ?? "", intentHints: input.intentHints ?? [], workSignals: input.workSignals ?? [] });
  const formalCandidates = formal.candidates.slice(0, 3);
  // Candidate evidence is more sensitive than ordinary formal-route metadata.
  // A stateless stdin caller cannot prove that the current user asked to review
  // learning, so this CLI never opens the candidate index or candidate source.
  const evolutionDecision = controls.purpose === "learning-review" || controls.learningSignal !== "none"
    ? "trusted-host-confirmation-required" : "not-opened";
  const evolutionCandidates = [];
  return Object.freeze({
    result: Object.freeze({
      decision: "query-complete", executable: false, purpose: controls.purpose, learningSignal: controls.learningSignal,
      learningSignalTrust: controls.learningSignal === "none" ? "not-applicable" : "caller-assertion-requires-conversational-grounding",
      formal,
      evolutionCandidates: Object.freeze({ decision: evolutionDecision, candidates: Object.freeze(evolutionCandidates) }),
      visibleCandidateCount: formalCandidates.length + evolutionCandidates.length, visibleCandidateLimit: 3,
      recallUse: formalCandidates.length === 0 ? projectRecallUse(null, "no-long-term-asset-used")
        : projectRecallUse(formalCandidates[0], "candidate-found-not-used"),
    }),
    formal, formalCandidates, evolutionCandidates,
  });
}

let inputBytes;
try {
  const boundedInput = Buffer.alloc(8193);
  let size = 0;
  while (size < boundedInput.length) {
    const count = readSync(0, boundedInput, size, boundedInput.length - size, null);
    if (count === 0) break;
    size += count;
  }
  inputBytes = boundedInput.subarray(0, size);
} catch { stop("request-failed-closed"); }
if (process.exitCode) process.exit();
if (inputBytes.length === 0 || inputBytes.length > 8192) stop("input-size-invalid");
if (process.exitCode) process.exit();

let input;
try { input = JSON.parse(decoder.decode(inputBytes)); } catch { stop("input-json-invalid"); }
if (process.exitCode) process.exit();

let result;
try {
  if (input.operation === "query") {
    const controls = validateQueryInput(input);
    result = buildBoundedQuery(input, controls).result;
  } else if (input.operation === "query-read") {
    const controls = validateQueryInput(input, { withSelection: true });
    const bounded = buildBoundedQuery(input, controls);
    const formal = bounded.formalCandidates.find((entry) => entry.id === input.selectedId);
    const candidate = bounded.evolutionCandidates.find((entry) => entry.id === input.selectedId);
    if (!formal && !candidate) throw new Error("selected-id-not-in-current-shortlist");
    if (formal) {
      const inspected = inspectShortlistedFormalAsset(root, bounded.formal, formal.id);
      result = Object.freeze({ ...inspected, selected: formal,
        modelGuidance: formal.requiredLevel > 1 ? `This asset recommends model level ${formal.requiredLevel}; recall remains available.` : "ordinary-model-suitable",
        recallUse: projectRecallUse(formal, ["load-bounded-body", "bounded-section-only", "load-bounded-task-family"].includes(inspected.decision)
          ? "asset-body-loaded" : "candidate-found-not-used") });
    } else {
      result = Object.freeze({ decision: "candidate-review-needs-current-conversation",
        executable: false, selected: candidate, contentRole: "candidate-metadata-only", authorizedActions: Object.freeze([]),
        recallUse: projectRecallUse(candidate, "candidate-found-not-used"),
        disposition: "Ask in the current conversation whether the user wants to review this learning candidate.",
      });
    }
  } else {
    throw new Error("operation-unsupported");
  }
  assertLocationFreeProjection(result);
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output, "utf8") > 160 * 1024) throw new Error("output-size-exceeded");
  process.stdout.write(`${output}\n`);
} catch (error) {
  stop(String(error?.message ?? "request-failed-closed"));
}
