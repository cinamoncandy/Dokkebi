import type { SourceExecutionIdentity, VerifiedCodingPublisherIdentity } from "./githubActionsOidc";
import { isValidCausalAdmissionReceipt, type CausalAdmissionReceipt } from "./causalRegressionAdmission";

/** Internal coordinator value. Creation requires an independently verified source run. */
export interface CausalDispatchBinding {
  readonly source: SourceExecutionIdentity;
  readonly capabilityDigest: string;
  readonly expiresAt: number;
  readonly publisher: VerifiedCodingPublisherIdentity | null;
  /** Null for provenance-only bindings; populated only by verified causal producer evidence. */
  readonly causalAdmission?: CausalAdmissionReceipt | null;
  /** Atomic one-time handoff marker; retries cannot reuse an admitted receipt after consumption. */
  readonly causalAdmissionConsumedAt?: number | null;
}

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN = /^[1-9][0-9]{0,19}$/;
const ATTEMPT = /^[1-9][0-9]{0,9}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SOURCE_WORKFLOW = ".github/workflows/ci.yml";
const PUBLISHER_WORKFLOW = ".github/workflows/autopilot-execution-consumer.yml";

/** The raw capability is delivered only through the intended dispatch, never stored in the coordinator. */
export function newCausalDispatchCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashCausalDispatchCapability(capability: string): Promise<string> {
  if (typeof capability !== "string" || !SHA256.test(capability)) throw new Error("CAUSAL_DISPATCH_CAPABILITY_INVALID");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validSource(source: SourceExecutionIdentity): boolean {
  return typeof source.repository === "string" && REPOSITORY.test(source.repository) && source.workflowPath === SOURCE_WORKFLOW
    && typeof source.sha === "string" && SHA40.test(source.sha)
    && typeof source.runId === "string" && RUN.test(source.runId)
    && typeof source.runAttempt === "string" && ATTEMPT.test(source.runAttempt);
}

function sameSource(left: SourceExecutionIdentity, right: SourceExecutionIdentity): boolean {
  return left.repository === right.repository && left.workflowPath === right.workflowPath
    && left.sha === right.sha && left.runId === right.runId && left.runAttempt === right.runAttempt;
}

function sameDigest(left: string, right: string): boolean {
  if (typeof left !== "string" || typeof right !== "string" || !SHA256.test(left) || !SHA256.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

/** Construct only after source-run verification and generation of a random capability. */
export function createCausalDispatchBinding(
  source: SourceExecutionIdentity,
  capabilityDigest: string,
  now: number,
  expiresAt: number,
  causalAdmission?: CausalAdmissionReceipt | null,
): CausalDispatchBinding | null {
  if (!source || !validSource(source) || typeof capabilityDigest !== "string" || !SHA256.test(capabilityDigest)
    || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt)
    || expiresAt <= now || expiresAt - now > 30 * 60 * 1000
    || (causalAdmission !== undefined && causalAdmission !== null
      && (!isValidCausalAdmissionReceipt(causalAdmission, source, now) || causalAdmission.expiresAt > expiresAt))) return null;
  return Object.freeze({ source: Object.freeze({ ...source }), capabilityDigest, expiresAt, publisher: null,
    causalAdmission: causalAdmission ?? null, causalAdmissionConsumedAt: null });
}

function sameCausalAdmission(left: CausalAdmissionReceipt | null | undefined, right: CausalAdmissionReceipt | null | undefined): boolean {
  if (left == null || right == null) return left == null && right == null;
  return left.schemaVersion === 1 && right.schemaVersion === 1
    && left.decision === "CODE_ACTIONABLE" && right.decision === "CODE_ACTIONABLE"
    && left.classification === "REPOSITORY_CODE_REGRESSION" && right.classification === "REPOSITORY_CODE_REGRESSION"
    && left.contractId === right.contractId && left.caseId === right.caseId
    && left.sourceConclusion === right.sourceConclusion && sameSource(left.source, right.source)
    && left.sourceRunAttempt === right.sourceRunAttempt && left.statementDigest === right.statementDigest
    && left.producerJobId === right.producerJobId && left.attestationJobId === right.attestationJobId
    && left.producerArtifactId === right.producerArtifactId
    && left.producerArtifactDigest === right.producerArtifactDigest
    && left.producerArtifactName === right.producerArtifactName
    && left.implementationFingerprint === right.implementationFingerprint
    && left.verifiedAt === right.verifiedAt && left.expiresAt === right.expiresAt
    && left.replayKeySha256 === right.replayKeySha256;
}

/**
 * This is a state transition, not an authentication boundary. The caller must
 * verify OIDC and the GitHub source/publisher runs and must execute read/claim/
 * write atomically in the existing coordinator. The digest is derived from an
 * unguessable per-dispatch capability held by the coordinator, never client
 * identity assertions. No result here establishes causal failure evidence.
 */
export function claimCausalDispatchBinding(
  binding: CausalDispatchBinding,
  publisher: VerifiedCodingPublisherIdentity,
  requestedSource: SourceExecutionIdentity,
  capabilityDigest: string,
  now: number,
  causalAdmission?: CausalAdmissionReceipt | null,
): CausalDispatchBinding | null {
  if (!binding || !binding.source || !publisher || !requestedSource
    || !validSource(binding.source) || !validSource(requestedSource)
    || !Number.isSafeInteger(binding.expiresAt) || !Number.isSafeInteger(now)
    || now < 0 || now >= binding.expiresAt || binding.publisher !== null
    || !sameDigest(binding.capabilityDigest, capabilityDigest)
    || !sameSource(binding.source, requestedSource)
    || !sameCausalAdmission(binding.causalAdmission, causalAdmission)
    || (binding.causalAdmissionConsumedAt !== undefined && binding.causalAdmissionConsumedAt !== null)) return null;

  if (publisher.repository !== binding.source.repository || publisher.sha !== binding.source.sha
    || publisher.ref !== "refs/heads/main" || publisher.event !== "repository_dispatch"
    || publisher.workflowRef !== `${publisher.repository}/${PUBLISHER_WORKFLOW}@refs/heads/main`
    || typeof publisher.runId !== "string" || !RUN.test(publisher.runId)
    || typeof publisher.runAttempt !== "string" || !ATTEMPT.test(publisher.runAttempt)) return null;

  return Object.freeze({
    source: Object.freeze({ ...binding.source }),
    capabilityDigest: binding.capabilityDigest,
    expiresAt: binding.expiresAt,
    publisher: Object.freeze({ ...publisher }),
    causalAdmission: binding.causalAdmission ?? null,
    causalAdmissionConsumedAt: null,
  });
}

/** Rechecks the already claimed execution; this does not consume or create a causal receipt. */
export function verifyClaimedCausalDispatchBinding(
  binding: CausalDispatchBinding,
  publisher: VerifiedCodingPublisherIdentity,
  requestedSource: SourceExecutionIdentity,
  capabilityDigest: string,
  now: number,
): boolean {
  const claimed = binding?.publisher;
  if (!binding || !claimed || !publisher || !validSource(binding.source) || !validSource(requestedSource)
    || !Number.isSafeInteger(binding.expiresAt) || !Number.isSafeInteger(now) || now < 0 || now >= binding.expiresAt
    || claimed.repository !== publisher.repository
    || claimed.workflowRef !== publisher.workflowRef || claimed.ref !== publisher.ref
    || claimed.sha !== publisher.sha || claimed.runId !== publisher.runId
    || claimed.runAttempt !== publisher.runAttempt || claimed.event !== publisher.event
    || !sameDigest(binding.capabilityDigest, capabilityDigest) || !sameSource(binding.source, requestedSource)
    || (binding.causalAdmissionConsumedAt !== undefined && binding.causalAdmissionConsumedAt !== null
      && (!Number.isSafeInteger(binding.causalAdmissionConsumedAt) || binding.causalAdmissionConsumedAt < 0))) return false;
  if (binding.causalAdmissionConsumedAt != null
    || (binding.causalAdmission != null && !isValidCausalAdmissionReceipt(binding.causalAdmission, binding.source, now))) return false;
  return publisher.repository === binding.source.repository && publisher.sha === binding.source.sha
    && publisher.ref === "refs/heads/main" && publisher.event === "repository_dispatch"
    && publisher.workflowRef === `${publisher.repository}/${PUBLISHER_WORKFLOW}@refs/heads/main`
    && typeof publisher.runId === "string" && RUN.test(publisher.runId)
    && typeof publisher.runAttempt === "string" && ATTEMPT.test(publisher.runAttempt);
}

/** Called inside the execution coordinator transaction that changes LEASED to HANDED_OFF. */
export function consumeClaimedCausalDispatchAdmissionBinding(
  binding: CausalDispatchBinding,
  publisher: VerifiedCodingPublisherIdentity,
  requestedSource: SourceExecutionIdentity,
  capabilityDigest: string,
  now: number,
): CausalDispatchBinding | null {
  if (!binding?.causalAdmission || binding.causalAdmissionConsumedAt != null
    || !verifyClaimedCausalDispatchBinding(binding, publisher, requestedSource, capabilityDigest, now)
    || !isValidCausalAdmissionReceipt(binding.causalAdmission, binding.source, now)
    || now >= binding.expiresAt) return null;
  return Object.freeze({ ...binding, causalAdmissionConsumedAt: now });
}
