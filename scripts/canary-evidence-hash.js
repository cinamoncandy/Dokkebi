"use strict";
// Read-only helper for the canary evidence step. Input: a directory with one subdirectory per attestation attempt, each holding
// receipt.json and attestation.json as downloaded from the main-push CI run. Output: sha256 of every file plus the stop-condition
// findings (more than three attempts, differing source identity, a non-mismatch observation, a CODE_ACTIONABLE key in a receipt).
// It never writes inside the input directory and never contacts the network. It does not verify signatures.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_ATTEMPTS = 3;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function analyze(dir) {
  const attempts = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const files = [];
  const findings = [];
  const identities = new Set();
  for (const name of attempts) {
    for (const file of ["receipt.json", "attestation.json"]) {
      const p = path.join(dir, name, file);
      if (!fs.existsSync(p)) { findings.push(`MISSING ${name}/${file}`); continue; }
      const buf = fs.readFileSync(p);
      files.push({ attempt: name, file, sha256: sha256(buf), bytes: buf.length });
      if (file !== "receipt.json") continue;
      let receipt;
      try { receipt = JSON.parse(buf.toString("utf8")); } catch { findings.push(`MALFORMED ${name}/${file}`); continue; }
      const source = receipt && receipt.source;
      if (!source || typeof source.repository !== "string" && typeof source.repo !== "string") findings.push(`NO_SOURCE_IDENTITY ${name}`);
      else identities.add(JSON.stringify({ repo: source.repository ?? source.repo, sha: source.sha, workflowRef: source.workflowRef ?? null }));
      if (!receipt.observation || receipt.observation.status !== "OBSERVED_MISMATCH") findings.push(`NOT_MISMATCH ${name}`);
      if (receipt && Object.prototype.hasOwnProperty.call(receipt, "CODE_ACTIONABLE")) findings.push(`CODE_ACTIONABLE_KEY ${name}`);
    }
  }
  const stop = [];
  if (attempts.length > MAX_ATTEMPTS) stop.push("MORE_THAN_THREE_ATTEMPTS");
  if (identities.size > 1) stop.push("DIFFERENT_SOURCE_IDENTITY");
  if (attempts.length === 0) findings.push("NO_ATTEMPTS");
  return { attempts: attempts.length, files, sourceIdentities: [...identities].map((s) => JSON.parse(s)), findings, stop, verdict: stop.length === 0 && findings.length === 0 ? "OK" : "REVIEW" };
}

module.exports = { analyze, MAX_ATTEMPTS };

if (require.main === module) {
  const result = analyze(path.resolve(process.argv[2] ?? "."));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.verdict === "OK" ? 0 : 1);
}
