// Explicit maintenance action: rebuild a formal snapshot from current AI Carry
// truth, validate it, then install one byte-identical candidate into the
// public and dist offline locations as a recoverable pair. It never accepts an
// arbitrary caller-supplied snapshot as proof of source truth.

import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshotCandidate } from "./snapshot-source-builder.mjs";
import { parseCurrentSnapshotEnvelope } from "./snapshot-envelope.mjs";
import { validateSnapshotSemantics } from "./snapshot-semantics.mjs";
import { synchronizeSnapshotPair } from "./snapshot-sync-transaction.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? resolve(here, "..", ".."));
const targets = [resolve(root, "dashboard", "public", "snapshot.js"), resolve(root, "dashboard", "dist", "snapshot.js")];
let existingSource = "";
try {
  const currentInfo = await lstat(targets[0]);
  if (currentInfo.isSymbolicLink() || !currentInfo.isFile()) throw new Error("Current public snapshot must be a physical regular file.");
  existingSource = (await readFile(targets[0])).toString("utf8");
} catch (error) {
  // A missing cache is a reason to rebuild, not a missing source of truth.
  // Unsafe paths, permission failures and other I/O errors still stay visible.
  if (error.code !== "ENOENT") throw error;
}
const candidate = buildSnapshotCandidate(root, { existingSource, mode: "operational" });
const sourceBytes = Buffer.from(candidate.source, "utf8");
const validateBytes = (bytes, label) => validateSnapshotSemantics(parseCurrentSnapshotEnvelope(bytes.toString("utf8"), label), label);
const result = await synchronizeSnapshotPair({ sourceBytes, targets, validateBytes });
console.log(JSON.stringify({ ...result, generated_from_current_truth: true, source_digest: candidate.sourceDigest,
  identity_ref: candidate.identityRef, diagnostics: candidate.diagnostics }));
