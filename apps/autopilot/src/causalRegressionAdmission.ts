import type { CryptographicallyVerifiedCausalManifest, VerifiedIsolatedCausalVerification } from "./sigstoreCausalAttestation";
import type { SourceExecutionIdentity, VerifiedCausalProducerEvidence } from "./githubActionsOidc";

export type CausalRegressionCase = "main-ci-failure" | "main-ci-timeout";

/** Persisted only after Worker-side Sigstore and GitHub API verification. */
export interface CausalAdmissionReceipt {
  readonly schemaVersion: 1;
  readonly decision: "CODE_ACTIONABLE";
  readonly classification: "REPOSITORY_CODE_REGRESSION";
  readonly contractId: "REPAIRABLE_WORKFLOW_POLICY_V1";
  readonly caseId: CausalRegressionCase;
  readonly sourceConclusion: "failure" | "timed_out";
  readonly source: SourceExecutionIdentity;
  readonly sourceRunAttempt: string;
  readonly statementDigest: string;
  readonly producerJobId: number;
  readonly attestationJobId: number;
  readonly producerArtifactId: number;
  readonly producerArtifactDigest: string;
  readonly producerArtifactName: string;
  readonly implementationFingerprint: string;
  readonly verifiedAt: number;
  readonly expiresAt: number;
  readonly replayKeySha256: string;
}

const REPOSITORY = "cinamoncandy/NUSA";
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main`;
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const CONTRACT_ID = "REPAIRABLE_WORKFLOW_POLICY_V1";
const SHA256 = /^[a-f0-9]{64}$/;

export interface IsolatedCausalVerificationDecision {
  readonly domain: "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1";
  readonly decision: "CODE_ACTIONABLE";
  readonly classification: "REPOSITORY_CODE_REGRESSION";
  readonly caseId: "isolated-policy-regression";
  readonly fixtureDigest: string;
  readonly statementDigest: string;
  readonly sourceSha: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
}

function classifyObservedMismatch(observation: {
  readonly status: unknown;
  readonly expected: unknown;
  readonly observed: unknown;
}): { readonly decision: "CODE_ACTIONABLE"; readonly classification: "REPOSITORY_CODE_REGRESSION" } {
  if (observation.status !== "OBSERVED_MISMATCH" || observation.expected !== true || observation.observed !== false) {
    throw new Error("CAUSAL_ADMISSION_EVIDENCE_INSUFFICIENT");
  }
  return Object.freeze({ decision: "CODE_ACTIONABLE", classification: "REPOSITORY_CODE_REGRESSION" });
}

/**
 * Classifies only the explicitly domain-separated manual verification proof. This result is for
 * the bounded harness and is not a production CausalAdmissionReceipt accepted by the Worker.
 */
export function classifyIsolatedCausalVerification(
  verified: VerifiedIsolatedCausalVerification,
): IsolatedCausalVerificationDecision {
  if (!verified || verified.domain !== "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1"
    || verified.caseId !== "isolated-policy-regression"
    || !SHA256.test(verified.fixtureDigest) || !SHA256.test(verified.statementDigest)
    || verified.source.repository !== "cinamoncandy/NUSA"
    || verified.source.workflowPath !== ".github/workflows/causal-verification.yml"
    || verified.source.workflowRef !== "cinamoncandy/NUSA/.github/workflows/causal-verification.yml@refs/heads/main"
    || verified.source.event !== "workflow_dispatch" || verified.source.ref !== "refs/heads/main"
    || verified.source.job !== "verify-causal-positive" || verified.source.sha !== verified.source.workflowSha
    || !/^[1-9][0-9]{0,19}$/.test(verified.source.runId)
    || !/^[1-9][0-9]{0,9}$/.test(verified.source.runAttempt)
    || verified.signerIdentity.subjectAlternativeName !== `https://github.com/${verified.source.workflowRef}`
    || verified.signerIdentity.issuer !== "https://token.actions.githubusercontent.com") {
    throw new Error("ISOLATED_CAUSAL_VERIFICATION_INVALID");
  }
  const classification = classifyObservedMismatch({ status: "OBSERVED_MISMATCH", expected: true, observed: false });
  return Object.freeze({
    domain: "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1",
    ...classification,
    caseId: verified.caseId,
    fixtureDigest: verified.fixtureDigest,
    statementDigest: verified.statementDigest,
    sourceSha: verified.source.sha,
    sourceRunId: verified.source.runId,
    sourceRunAttempt: verified.source.runAttempt,
  });
}

/** These source inputs change only with an explicitly reviewed producer-contract update. */
export const PINNED_CAUSAL_PRODUCER_FINGERPRINTS = Object.freeze({
  workflow: "88bfc91fd9960513a924765d6922a6fc93a4cc251ac28911144bfbfa49040fbe",
  producer: "4612ddf37895b92f57e6f5c73617a9a2c252c45f21a56e0c150d1d43a5e8828b",
  contract: "94bb8aeb837be297b60065e90bcd9d15e5248a85593175c21d5b2288c6f3d639",
  lockfile: "54d004cf60e513db2dd5ed998af1dec7c0ac288ba1bd8797b82d813942cc0a78",
});

function sameSource(left: SourceExecutionIdentity, right: SourceExecutionIdentity): boolean {
  return left.repository === right.repository && left.workflowPath === right.workflowPath
    && left.sha === right.sha && left.runId === right.runId && left.runAttempt === right.runAttempt;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic classification. It accepts only the fixed protected-main policy predicate,
 * exact-source signed statement, matching GitHub producer jobs/artifact, and pinned producer files.
 * Generic CI failures, publisher identity, and caller-supplied classifications are insufficient.
 */
export async function createCausalAdmissionReceipt(input: {
  readonly source: SourceExecutionIdentity;
  readonly verified: CryptographicallyVerifiedCausalManifest;
  readonly producer: VerifiedCausalProducerEvidence;
  readonly now: number;
  readonly expiresAt: number;
}): Promise<CausalAdmissionReceipt> {
  const { source, verified, producer, now, expiresAt } = input;
  const manifest = verified?.manifest;
  const fingerprints = manifest?.fingerprints;
  const observation = manifest?.observation;
  const sourceManifest = manifest?.source;
  if (!source || source.repository !== REPOSITORY || source.workflowPath !== ".github/workflows/ci.yml"
    || !/^[a-f0-9]{40}$/.test(source.sha) || !/^[1-9][0-9]{0,19}$/.test(source.runId)
    || !/^[1-9][0-9]{0,9}$/.test(source.runAttempt)
    || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt)
    || expiresAt <= now || expiresAt - now > 30 * 60 * 1000
    || !producer || !sameSource(producer.source, source)
    || (producer.sourceConclusion !== "failure" && producer.sourceConclusion !== "timed_out")
    || !Number.isSafeInteger(producer.producerJobId) || producer.producerJobId <= 0
    || !Number.isSafeInteger(producer.attestationJobId) || producer.attestationJobId <= 0
    || !Number.isSafeInteger(producer.artifact.id) || producer.artifact.id <= 0
    || producer.artifact.name !== `nusa-causal-attestation-${source.runAttempt}`
    || !/^sha256:[a-f0-9]{64}$/.test(producer.artifact.digest)
    || !Number.isSafeInteger(producer.artifact.sizeInBytes) || producer.artifact.sizeInBytes <= 0 || producer.artifact.sizeInBytes > 2 * 1024 * 1024
    || !manifest || manifest.schemaVersion !== 1 || manifest.contractId !== CONTRACT_ID
    || !sourceManifest || sourceManifest.repository !== source.repository
    || sourceManifest.workflowPath !== source.workflowPath || sourceManifest.workflowRef !== WORKFLOW_REF
    || sourceManifest.workflowSha !== source.sha || sourceManifest.ref !== "refs/heads/main"
    || sourceManifest.event !== "push" || sourceManifest.job !== "causal-regression-contract"
    || sourceManifest.sha !== source.sha || sourceManifest.runId !== source.runId || sourceManifest.runAttempt !== source.runAttempt
    || !observation || observation.contract !== CONTRACT_ID || observation.status !== "OBSERVED_MISMATCH"
    || (observation.caseId !== "main-ci-failure" && observation.caseId !== "main-ci-timeout")
    || observation.expected !== true || observation.observed !== false
    || (observation.caseId === "main-ci-failure" && producer.sourceConclusion !== "failure")
    || (observation.caseId === "main-ci-timeout" && producer.sourceConclusion !== "timed_out")
    || !fingerprints || !SHA256.test(verified.statementDigest)
    || verified.signerIdentity?.subjectAlternativeName !== `https://github.com/${WORKFLOW_REF}` || verified.signerIdentity?.issuer !== OIDC_ISSUER) {
    throw new Error("CAUSAL_ADMISSION_EVIDENCE_INSUFFICIENT");
  }

  for (const key of ["workflow", "producer", "contract", "lockfile"] as const) {
    if (fingerprints[key] !== producer.fingerprints[key] || fingerprints[key] !== PINNED_CAUSAL_PRODUCER_FINGERPRINTS[key]) {
      throw new Error("CAUSAL_ADMISSION_PRODUCER_CONTRACT_MISMATCH");
    }
  }
  if (!SHA256.test(fingerprints.implementation) || fingerprints.implementation !== producer.fingerprints.implementation) {
    throw new Error("CAUSAL_ADMISSION_IMPLEMENTATION_FINGERPRINT_MISMATCH");
  }

  const classification = classifyObservedMismatch(observation);

  const replayKey = [source.repository, source.sha, source.workflowPath, source.runId, source.runAttempt,
    producer.producerJobId, producer.attestationJobId, CONTRACT_ID, observation.caseId, verified.statementDigest,
    producer.artifact.id, producer.artifact.digest, fingerprints.implementation].join("|");
  return Object.freeze({
    schemaVersion: 1,
    ...classification,
    contractId: CONTRACT_ID,
    caseId: observation.caseId,
    sourceConclusion: producer.sourceConclusion,
    sourceRunAttempt: source.runAttempt,
    source: Object.freeze({ ...source }),
    statementDigest: verified.statementDigest,
    producerJobId: producer.producerJobId,
    attestationJobId: producer.attestationJobId,
    producerArtifactId: producer.artifact.id,
    producerArtifactDigest: producer.artifact.digest,
    producerArtifactName: producer.artifact.name,
    implementationFingerprint: fingerprints.implementation,
    verifiedAt: now,
    expiresAt,
    replayKeySha256: await sha256Hex(replayKey),
  });
}

/** Validates the immutable receipt shape and source binding without asserting freshness. */
export function hasValidCausalAdmissionReceiptStructure(value: unknown, source: SourceExecutionIdentity): value is CausalAdmissionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<CausalAdmissionReceipt>;
  const receiptSource = receipt.source as Partial<SourceExecutionIdentity> | undefined;
  return receipt.schemaVersion === 1 && receipt.decision === "CODE_ACTIONABLE"
    && receipt.classification === "REPOSITORY_CODE_REGRESSION"
    && receipt.contractId === CONTRACT_ID
    && (receipt.caseId === "main-ci-failure" || receipt.caseId === "main-ci-timeout")
    && (receipt.sourceConclusion === "failure" || receipt.sourceConclusion === "timed_out")
    && ((receipt.caseId === "main-ci-failure" && receipt.sourceConclusion === "failure")
      || (receipt.caseId === "main-ci-timeout" && receipt.sourceConclusion === "timed_out"))
    && receipt.sourceRunAttempt === source.runAttempt
    && Boolean(receiptSource && receiptSource.repository === source.repository
      && receiptSource.workflowPath === source.workflowPath && receiptSource.sha === source.sha
      && receiptSource.runId === source.runId && receiptSource.runAttempt === source.runAttempt)
    && typeof receipt.statementDigest === "string" && SHA256.test(receipt.statementDigest)
    && Number.isSafeInteger(receipt.producerJobId) && Number(receipt.producerJobId) > 0
    && Number.isSafeInteger(receipt.attestationJobId) && Number(receipt.attestationJobId) > 0
    && Number.isSafeInteger(receipt.producerArtifactId) && Number(receipt.producerArtifactId) > 0
    && receipt.producerArtifactName === `nusa-causal-attestation-${source.runAttempt}`
    && typeof receipt.producerArtifactDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(receipt.producerArtifactDigest)
    && typeof receipt.implementationFingerprint === "string" && SHA256.test(receipt.implementationFingerprint)
    && Number.isSafeInteger(receipt.verifiedAt) && Number(receipt.verifiedAt) >= 0
    && Number.isSafeInteger(receipt.expiresAt)
    && Number(receipt.expiresAt) > Number(receipt.verifiedAt)
    && Number(receipt.expiresAt) - Number(receipt.verifiedAt) <= 30 * 60 * 1000
    && typeof receipt.replayKeySha256 === "string" && SHA256.test(receipt.replayKeySha256);
}

export function isValidCausalAdmissionReceipt(value: unknown, source: SourceExecutionIdentity, now: number): value is CausalAdmissionReceipt {
  return Number.isSafeInteger(now) && now >= 0
    && hasValidCausalAdmissionReceiptStructure(value, source)
    && value.verifiedAt <= now && value.expiresAt > now;
}
