import assert from "node:assert/strict";
import test from "node:test";
import { createCausalAdmissionReceipt, PINNED_CAUSAL_PRODUCER_FINGERPRINTS } from "./causalRegressionAdmission";
import type { VerifiedCausalProducerEvidence, SourceExecutionIdentity } from "./githubActionsOidc";
import type { CryptographicallyVerifiedCausalManifest } from "./sigstoreCausalAttestation";

const repository = "cinamoncandy/NUSA";
const sha = "a".repeat(40);
const source: SourceExecutionIdentity = {
  repository,
  workflowPath: ".github/workflows/ci.yml",
  sha,
  runId: "456",
  runAttempt: "2",
};
const implementation = "b".repeat(64);
const statementDigest = "c".repeat(64);

function evidence(caseId: "main-ci-failure" | "main-ci-timeout" = "main-ci-failure", conclusion: "failure" | "timed_out" = "failure") {
  const fingerprints = Object.freeze({ ...PINNED_CAUSAL_PRODUCER_FINGERPRINTS, implementation });
  const manifest: CryptographicallyVerifiedCausalManifest["manifest"] = {
    schemaVersion: 1,
    contractId: "REPAIRABLE_WORKFLOW_POLICY_V1",
    source: {
      repository,
      workflowPath: ".github/workflows/ci.yml",
      workflowRef: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
      workflowSha: sha,
      ref: "refs/heads/main",
      event: "push",
      job: "causal-regression-contract",
      sha,
      runId: source.runId,
      runAttempt: source.runAttempt,
    },
    fingerprints,
    observation: {
      contract: "REPAIRABLE_WORKFLOW_POLICY_V1",
      status: "OBSERVED_MISMATCH",
      caseId,
      expected: true,
      observed: false,
    },
  };
  const verified: CryptographicallyVerifiedCausalManifest = {
    manifest,
    signerIdentity: {
      subjectAlternativeName: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
      issuer: "https://token.actions.githubusercontent.com",
    },
    statementDigest,
  };
  const producer: VerifiedCausalProducerEvidence = {
    source,
    sourceConclusion: conclusion,
    producerJobId: 11,
    attestationJobId: 12,
    artifact: {
      id: 13,
      name: `nusa-causal-attestation-${source.runAttempt}`,
      digest: `sha256:${"d".repeat(64)}`,
      sizeInBytes: 1024,
    },
    fingerprints,
  };
  return { verified, producer };
}

test("mints CODE_ACTIONABLE only from the exact signed deterministic mismatch and producer contract", async () => {
  const { verified, producer } = evidence();
  const receipt = await createCausalAdmissionReceipt({ source, verified, producer, now: 1000, expiresAt: 2000 });
  assert.equal(receipt.decision, "CODE_ACTIONABLE");
  assert.equal(receipt.classification, "REPOSITORY_CODE_REGRESSION");
  assert.equal(receipt.source.runId, source.runId);
  assert.equal(receipt.sourceRunAttempt, source.runAttempt);
  assert.match(receipt.replayKeySha256, /^[a-f0-9]{64}$/);
});

test("binds the fixed mismatch case to the actual protected-main run conclusion", async () => {
  const timeoutEvidence = evidence("main-ci-timeout", "timed_out");
  const receipt = await createCausalAdmissionReceipt({ source, ...timeoutEvidence, now: 1000, expiresAt: 2000 });
  assert.equal(receipt.caseId, "main-ci-timeout");
  await assert.rejects(
    () => createCausalAdmissionReceipt({ source, ...evidence("main-ci-timeout", "failure"), now: 1000, expiresAt: 2000 }),
    /CAUSAL_ADMISSION_EVIDENCE_INSUFFICIENT/,
  );
  await assert.rejects(
    () => createCausalAdmissionReceipt({ source, ...evidence("main-ci-failure", "timed_out"), now: 1000, expiresAt: 2000 }),
    /CAUSAL_ADMISSION_EVIDENCE_INSUFFICIENT/,
  );
});

test("rejects generic, altered, stale and unpinned evidence without issuing a receipt", async () => {
  const valid = evidence();
  await assert.rejects(
    () => createCausalAdmissionReceipt({ source, ...valid, now: 1000, expiresAt: 1000 + 30 * 60 * 1000 + 1 }),
    /CAUSAL_ADMISSION_EVIDENCE_INSUFFICIENT/,
  );
  await assert.rejects(
    () => createCausalAdmissionReceipt({ source, verified: { ...valid.verified, signerIdentity: { ...valid.verified.signerIdentity, issuer: "https://untrusted.invalid" } }, producer: valid.producer, now: 1000, expiresAt: 2000 }),
    /CAUSAL_ADMISSION_EVIDENCE_INSUFFICIENT/,
  );
  await assert.rejects(
    () => createCausalAdmissionReceipt({ source, verified: { ...valid.verified, manifest: { ...valid.verified.manifest, observation: { ...valid.verified.manifest.observation, observed: true } } as unknown as CryptographicallyVerifiedCausalManifest["manifest"] }, producer: valid.producer, now: 1000, expiresAt: 2000 }),
    /CAUSAL_ADMISSION_EVIDENCE_INSUFFICIENT/,
  );
  await assert.rejects(
    () => createCausalAdmissionReceipt({ source, verified: valid.verified, producer: { ...valid.producer, fingerprints: { ...valid.producer.fingerprints, workflow: "f".repeat(64) } }, now: 1000, expiresAt: 2000 }),
    /CAUSAL_ADMISSION_PRODUCER_CONTRACT_MISMATCH/,
  );
});
