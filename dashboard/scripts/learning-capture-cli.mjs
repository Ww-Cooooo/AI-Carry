#!/usr/bin/env node

import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanupExpiredPersistentLearningCaptureChallenges,
  closePersistentLearningCaptureChallenge,
  confirmPersistentLearningCaptureChallenge,
  executePersistentLearningCaptureTransaction,
  inspectPersistentLearningCaptureTransaction,
  loadPersistentLearningCapturePlan,
  preparePersistentLearningCaptureChallenge,
  rollbackPersistentLearningCaptureTransaction,
} from "./learning-capture-transaction.mjs";
import { withOperationalUserReport } from "./operational-user-report.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });

function readBoundedJson(path, label) {
  const target = realpathSync(resolve(path)); const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) {
    throw new Error(`${label} must be one bounded physical JSON file`);
  }
  const descriptor = openSync(target, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true }); const buffer = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break; offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (offset !== buffer.length || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`${label} changed during read`);
    return JSON.parse(decoder.decode(buffer));
  } finally { closeSync(descriptor); }
}

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function promptOnlyObservationAssertion(assertion) {
  if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) return assertion;
  // The CLI can verify bytes and transaction state, but it cannot prove a
  // caller-labelled connected-host result. Preserve canonical non-host
  // provenance and fail closed for both the canonical positive host claim and
  // its retired 1.3 alias. The CLI never writes a retired alias.
  const sourceKind = assertion.source_kind === "connected-host-observation"
    || assertion.source_kind === "connected-host-task" || assertion.source_kind === "other-agent"
    ? "unknown" : assertion.source_kind === "host-collaboration-memory"
      ? "host-collaborative-memory" : assertion.source_kind;
  return {
    ...assertion,
    source_kind: sourceKind,
    result_state: "closed-unverified",
  };
}

function planSummary(result) {
  if (result.decision !== "persistent-learning-capture-plan-ready") return result;
  return {
    decision: result.decision, executable: false, persistentChallengeId: result.persistentChallengeId,
    planRef: result.planRef, planDigest: result.plan.planDigest, planDecision: result.plan.decision,
    choice: result.plan.choice, writeSet: result.plan.writeSet.map((item) => item.target),
    hostExecutionRequired: result.plan.hostExecutionRequired, idempotent: result.idempotent,
    ...(result.userReport ? { userReport: result.userReport } : {}),
  };
}

function run() {
  const [command, repository, requestPath] = process.argv.slice(2);
  if (!command || !repository) throw new Error("usage: learning-capture-cli <prepare|confirm|inspect|execute|rollback|load|close|cleanup> <repository> [request.json]");
  const repositoryReal = realpathSync(resolve(repository));
  if (["prepare", "confirm"].includes(command) && !process.argv.includes("--maintenance-internal")) {
    return Object.freeze({
      decision: "learning-capture-use-public-entry",
      executable: false,
      affectedScope: "only-this-learning-item",
      userSummary: "这次学习尚未写入；你误入了底层维护接口，普通对话和其他能力仍可继续。",
      ordinaryEntry: "dashboard/scripts/learning-save-cli.mjs",
      exampleCommand: "node dashboard/scripts/learning-save-cli.mjs example",
      nextStep: "改用 learning-save-cli 的简短请求入口；只填写标题、用途、触发、范围、步骤、失败处理和完成检查。保存用户习惯时另加 subtype=habit，其他类型不填 subtype；不要手写 ID、路径、TOML、时间、哈希、成熟度或事务回执。",
    });
  }
  if (command === "cleanup") return cleanupExpiredPersistentLearningCaptureChallenges(repositoryReal);
  if (!requestPath) throw new Error(`${command} requires one bounded request JSON file`);
  const request = readBoundedJson(requestPath, `${command} request`);
  if (command === "prepare") {
    if (!exactObject(request, ["proposal", "observation_assertion"])) throw new Error("prepare request fields are invalid");
    return preparePersistentLearningCaptureChallenge(repositoryReal, request.proposal,
      promptOnlyObservationAssertion(request.observation_assertion));
  }
  if (command === "confirm") {
    if (!exactObject(request, ["challenge_id", "proposal", "observation_assertion", "receipt"])) throw new Error("confirm request fields are invalid");
    return planSummary(confirmPersistentLearningCaptureChallenge(repositoryReal, {
      challengeId: request.challenge_id, proposal: request.proposal,
      observationAssertion: promptOnlyObservationAssertion(request.observation_assertion), receipt: request.receipt,
    }));
  }
  if (command === "close") {
    if (!exactObject(request, ["challenge_id", "challenge_nonce"])) throw new Error("close request fields are invalid");
    return closePersistentLearningCaptureChallenge(repositoryReal,
      { challengeId: request.challenge_id, challengeNonce: request.challenge_nonce });
  }
  if (command === "load") {
    if (!exactObject(request, ["challenge_id", "challenge_nonce"])) throw new Error("load request fields are invalid");
    const loaded = loadPersistentLearningCapturePlan(repositoryReal,
      { challengeId: request.challenge_id, challengeNonce: request.challenge_nonce });
    if (loaded.decision !== "persistent-learning-capture-plan-loaded") return loaded;
    return planSummary({ ...loaded, decision: "persistent-learning-capture-plan-ready", idempotent: true });
  }
  if (["inspect", "execute", "rollback"].includes(command)) {
    if (!exactObject(request, ["challenge_id", "challenge_nonce"])) throw new Error(`${command} request fields are invalid`);
    const args = { challengeId: request.challenge_id, challengeNonce: request.challenge_nonce };
    return command === "inspect" ? inspectPersistentLearningCaptureTransaction(repositoryReal, args)
      : command === "execute" ? executePersistentLearningCaptureTransaction(repositoryReal, args)
        : rollbackPersistentLearningCaptureTransaction(repositoryReal, args);
  }
  throw new Error(`unsupported learning-capture command: ${command}`);
}

try {
  const result = withOperationalUserReport(run(), { operation: "learning-capture" });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (String(result?.decision ?? "").endsWith("-denied")) process.exitCode = 2;
} catch (error) {
  const result = withOperationalUserReport({ decision: "learning-capture-cli-denied", reason: error.message,
    executable: false }, { operation: "learning-capture" });
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 2;
}
