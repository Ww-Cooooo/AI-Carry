const encryptedPrivateKeyPattern = new RegExp(["-----BEGIN ENCRYPTED ", "PRIVATE KEY-----"].join(""), "giu");

const patterns = Object.freeze([
  ["private-key-block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/giu],
  ["encrypted-private-key", encryptedPrivateKeyPattern],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,})\b/gu],
  ["openai-style-token", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/gu],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
  ["aws-secret-access-key", /\baws[_-]?secret[_-]?access[_-]?key\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/=]{24,}/giu],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu],
  ["authorization-header", /(?:^|[\r\n,{])\s*["']?(?:proxy-)?authorization["']?\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+\/-]{12,}/gimu],
  ["basic-authorization-header", /(?:^|[\r\n,{])\s*["']?(?:proxy-)?authorization["']?\s*[:=]\s*["']?basic\s+[A-Za-z0-9+/]{4,}={0,2}/gimu],
  ["cookie-header", /(?:^|[\r\n,{])\s*["']?(?:cookie|set-cookie)["']?\s*[:=]\s*["']?[^\r\n"']{8,}/gimu],
  ["slack-token", /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{20,}\b/gu],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}\b/gu],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{20,}\b/gu],
  ["npm-token", /\bnpm_[A-Za-z0-9]{20,}\b/gu],
  ["stripe-live-token", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/gu],
  ["stripe-test-token", /\b(?:sk|rk)_test_[A-Za-z0-9]{16,}\b/gu],
  ["credential-url", /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?|https?):\/\/[^\s/:@]*:[^\s/]{4,}@[A-Za-z0-9.-]+(?::\d+)?(?:[/?#\s]|$)/giu],
  ["client-secret", /\bclient[_-]?secret\b["']?\s*[:=]\s*["']?[^\s"'`;]{8,}/giu],
  ["secret-assignment", /\b(?:password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|session[_-]?(?:id|token)|secret|private[_-]?key|recovery[_-]?code)\b["']?\s*[:=]\s*["']?[A-Za-z0-9+/.=_-]{8,}/giu],
]);

export const SECRET_JSON_SCAN_LIMITS = Object.freeze({ bytes: 1024 * 1024, depth: 64, tokens: 32768 });

function decodedJsonForInspection(text) {
  const source = text.trim();
  if (!((source.startsWith("{") && source.endsWith("}")) || (source.startsWith("[") && source.endsWith("]"))
    || (source.startsWith('"') && source.endsWith('"')))) return null;
  if (Buffer.byteLength(source, "utf8") > SECRET_JSON_SCAN_LIMITS.bytes) return { limited: true };
  let depth = 0; let quoted = false; let escaped = false; let start = -1; let tokens = 0;
  const strings = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') { quoted = false; strings.push([start, index + 1]); }
    } else if (character === '"') { quoted = true; start = index; tokens += 1; }
    else if (character === "{" || character === "[") { depth += 1; tokens += 1; }
    else if (character === "}" || character === "]") depth -= 1;
    else if (character === "," || character === ":") tokens += 1;
    if (depth > SECRET_JSON_SCAN_LIMITS.depth || tokens > SECRET_JSON_SCAN_LIMITS.tokens) return { limited: true };
  }
  try {
    // Validate the complete bounded document, but preserve every original key
    // occurrence below: parsing to an object alone would hide duplicate keys.
    JSON.parse(source);
    let cursor = 0;
    const parts = [];
    for (const [from, to] of strings) {
      parts.push(source.slice(cursor, from), JSON.stringify(JSON.parse(source.slice(from, to))));
      cursor = to;
    }
    parts.push(source.slice(cursor));
    return { text: parts.join("") };
  } catch { return null; } // Ordinary prose is still covered by the raw scan.
}

export function locateHighConfidenceSecretCandidates(text) {
  if (typeof text !== "string") return Object.freeze({ blocked: true, count: 1, findings: Object.freeze([{ category: "non-text-input", line: 0 }]) });
  const findings = [];
  const scan = (source, decoded = false) => {
    for (const [category, pattern] of patterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const line = decoded ? 0 : source.slice(0, match.index).split("\n").length;
        findings.push(Object.freeze({ category, line, ...(decoded ? { location: "decoded-json" } : {}) }));
        if (findings.length >= 16) break;
      }
      if (findings.length >= 16) break;
    }
  };
  scan(text);
  if (findings.length === 0) {
    const decoded = decodedJsonForInspection(text);
    if (decoded?.limited) findings.push(Object.freeze({ category: "json-inspection-limit", line: 0, location: "decoded-json" }));
    else if (decoded?.text && decoded.text !== text) scan(decoded.text, true);
  }
  return Object.freeze({ blocked: findings.length > 0, count: findings.length, findings: Object.freeze(findings) });
}
