const { existsSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { join, normalize } = require("node:path");
const { resolveWorkOrderPath } = require("./lib/aipos-work-order-paths.js");
const { block, scalar } = require("./validate-aipos-drift.js");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeGitText(content) {
  return content.replace(/\r\n/g, "\n");
}

function gitBlobSha1(content) {
  const bytes = Buffer.from(normalizeGitText(content), "utf8");
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash("sha1").update(Buffer.concat([header, bytes])).digest("hex");
}

function validateEvidenceRecord(root, evidencePath, expectedWorkOrderId) {
  const failures = [];
  const absoluteEvidencePath = join(root, normalize(evidencePath));
  if (!existsSync(absoluteEvidencePath)) return [`EVIDENCE_MISSING:${evidencePath}`];

  let evidence;
  try {
    evidence = JSON.parse(readFileSync(absoluteEvidencePath, "utf8"));
  } catch {
    return [`EVIDENCE_MALFORMED_JSON:${evidencePath}`];
  }

  if (evidence.version !== 1) failures.push("EVIDENCE_VERSION_INVALID");
  if (!evidence.id || typeof evidence.id !== "string") failures.push("EVIDENCE_ID_MISSING");
  if (evidence.result !== "PASS") failures.push(`EVIDENCE_RESULT_NOT_PASS:${evidence.result || "missing"}`);
  if (!evidence.observed_at || Number.isNaN(Date.parse(evidence.observed_at))) failures.push("EVIDENCE_TIMESTAMP_INVALID");

  if (!evidence.subject || evidence.subject.type !== "work_order") failures.push("EVIDENCE_SUBJECT_TYPE_INVALID");
  if (evidence.subject?.id !== expectedWorkOrderId) {
    failures.push(`EVIDENCE_SUBJECT_MISMATCH:${evidence.subject?.id || "missing"}:${expectedWorkOrderId}`);
  }

  const subjectPath = evidence.subject?.path;
  if (!subjectPath || typeof subjectPath !== "string") {
    failures.push("EVIDENCE_SUBJECT_PATH_MISSING");
  } else {
    // A closed work order may have moved to .aipos/work-orders/archive/; its recorded path still resolves.
    const absoluteSubjectPath = join(root, normalize(resolveWorkOrderPath(root, subjectPath)));
    if (!existsSync(absoluteSubjectPath)) {
      failures.push(`EVIDENCE_SUBJECT_PATH_MISSING:${subjectPath}`);
    } else {
      const subjectSource = readFileSync(absoluteSubjectPath, "utf8");
      const algorithm = evidence.subject?.hash?.algorithm;
      const value = evidence.subject?.hash?.value;
      if (algorithm !== "git-blob-sha1" || !/^[0-9a-f]{40}$/.test(value || "")) {
        failures.push("EVIDENCE_SUBJECT_HASH_INVALID");
      } else if (gitBlobSha1(subjectSource) !== value) {
        failures.push("EVIDENCE_SUBJECT_HASH_MISMATCH");
      }
      const subjectWorkOrderId = scalar(subjectSource, "id");
      const subjectWorkOrderStatus = scalar(subjectSource, "status");
      if (subjectWorkOrderId !== expectedWorkOrderId) failures.push("EVIDENCE_SUBJECT_WORK_ORDER_ID_DRIFT");
      if (subjectWorkOrderStatus !== "COMPLETED" && subjectWorkOrderStatus !== "VERIFIED") {
        failures.push(`EVIDENCE_SUBJECT_STATUS_NOT_VERIFIED:${subjectWorkOrderStatus || "missing"}`);
      }
      const mergeCommit = scalar(subjectSource, "merge_commit");
      if (mergeCommit && evidence.producer?.code_revision !== mergeCommit) {
        failures.push(`EVIDENCE_CODE_REVISION_MISMATCH:${evidence.producer?.code_revision || "missing"}:${mergeCommit}`);
      }
    }
  }

  if (!evidence.producer || typeof evidence.producer.kind !== "string" || typeof evidence.producer.id !== "string") {
    failures.push("EVIDENCE_PRODUCER_INVALID");
  }
  if (!/^[0-9a-f]{40}$/.test(evidence.producer?.code_revision || "")) failures.push("EVIDENCE_CODE_REVISION_INVALID");

  const snapshot = evidence.configuration?.snapshot;
  const configAlgorithm = evidence.configuration?.hash?.algorithm;
  const configHash = evidence.configuration?.hash?.value;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    failures.push("EVIDENCE_CONFIGURATION_SNAPSHOT_MISSING");
  } else if (configAlgorithm !== "sha256" || !/^[0-9a-f]{64}$/.test(configHash || "")) {
    failures.push("EVIDENCE_CONFIGURATION_HASH_INVALID");
  } else if (sha256(canonical(snapshot)) !== configHash) {
    failures.push("EVIDENCE_CONFIGURATION_HASH_MISMATCH");
  }

  if (!Array.isArray(evidence.provenance) || evidence.provenance.length === 0 || evidence.provenance.some((item) => typeof item !== "string" || !item.trim())) {
    failures.push("EVIDENCE_PROVENANCE_INVALID");
  }
  if (!Array.isArray(evidence.assertions) || evidence.assertions.length === 0) {
    failures.push("EVIDENCE_ASSERTIONS_MISSING");
  } else if (evidence.assertions.some((assertion) => assertion?.status !== "PASS" || typeof assertion?.name !== "string" || !assertion.name.trim())) {
    failures.push("EVIDENCE_ASSERTION_NOT_PASS");
  }

  return failures;
}

function validateRepository(root = process.cwd()) {
  const failures = [];
  const statePath = join(root, ".aipos", "state.yaml");
  if (!existsSync(statePath)) return { ok: false, failures: ["STATE_MISSING"] };

  const state = readFileSync(statePath, "utf8");
  const claimed = block(state, "claimed_state");
  const verified = block(state, "verified_state");
  const claimedWorkOrder = scalar(claimed, "work_order");
  const claimedStatus = scalar(claimed, "status");
  const verifiedWorkOrder = scalar(verified, "work_order");
  const verifiedStatus = scalar(verified, "status");
  const evidencePath = scalar(verified, "evidence");

  if (!claimedWorkOrder || !claimedStatus) failures.push("CLAIMED_STATE_INCOMPLETE");
  if (!verifiedWorkOrder || !verifiedStatus) failures.push("VERIFIED_STATE_INCOMPLETE");

  const isVerifiedClaim = verifiedStatus === "VERIFIED" || verifiedStatus === "COMPLETED";
  if (isVerifiedClaim && !evidencePath) failures.push("VERIFIED_STATE_EVIDENCE_MISSING");
  if (isVerifiedClaim && evidencePath) failures.push(...validateEvidenceRecord(root, evidencePath, verifiedWorkOrder));

  if ((claimedStatus === "VERIFIED" || claimedStatus === "COMPLETED") && claimedWorkOrder !== verifiedWorkOrder) {
    failures.push(`CLAIM_OUTRUNS_VERIFIED_STATE:${claimedWorkOrder}:${verifiedWorkOrder || "none"}`);
  }

  return { ok: failures.length === 0, failures };
}

if (require.main === module) {
  const result = validateRepository();
  if (!result.ok) {
    console.error("AIPOS verified-state/evidence integrity validation FAILED");
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("AIPOS verified-state/evidence integrity validation PASS");
}

module.exports = { canonical, gitBlobSha1, normalizeGitText, sha256, validateEvidenceRecord, validateRepository };
