import type { CodingRunnerRequest } from "./codingRunner";
import type { SourceExecutionIdentity, VerifiedCodingPublisherIdentity } from "./githubActionsOidc";

export const CAUSAL_REPAIR_TARGET = "apps/autopilot/src/repairableWorkflowRun.ts" as const;
const RECEIPT_PREFIX = "nusa-causal-proposal-v1";
const MAX_PATCH_BYTES = 64_000;
const MAX_RECEIPT_LIFETIME_MS = 30 * 60 * 1000;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface CausalProposalAdmissionIdentity {
  readonly source: SourceExecutionIdentity;
  readonly publisher: VerifiedCodingPublisherIdentity;
  readonly capabilityDigest: string;
}

interface CausalProposalReceiptPayload {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly headSha: string;
  readonly workflowRunId: number;
  readonly workflowRunAttempt: number;
  readonly reason: string;
  readonly executionId: string;
  readonly dedupeKey: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly publisherRunId: string;
  readonly publisherRunAttempt: string;
  readonly publisherWorkflowRef: string;
  readonly capabilityDigest: string;
  readonly targetPath: typeof CAUSAL_REPAIR_TARGET;
  readonly patchSha256: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const encoder = new TextEncoder();

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("CAUSAL_PROPOSAL_RECEIPT_INVALID");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function receiptKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.trim().length < 16) throw new Error("CAUSAL_PROPOSAL_SIGNING_KEY_UNAVAILABLE");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(RECEIPT_PREFIX + "\0" + secret));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validIdentity(request: CodingRunnerRequest, admission: CausalProposalAdmissionIdentity): boolean {
  const source = admission?.source;
  const publisher = admission?.publisher;
  const failureReason = typeof request.workflowRunId === "number" && typeof request.headSha === "string"
    ? "gha:" + request.workflowRunId + ":" + request.headSha.toLowerCase() + ":failure"
    : "";
  const timeoutReason = typeof request.workflowRunId === "number" && typeof request.headSha === "string"
    ? "gha:" + request.workflowRunId + ":" + request.headSha.toLowerCase() + ":timed_out"
    : "";
  return typeof request.repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository)
    && typeof request.headSha === "string" && SHA40.test(request.headSha)
    && Number.isSafeInteger(request.workflowRunId) && request.workflowRunId > 0
    && Number.isSafeInteger(request.workflowRunAttempt) && Number(request.workflowRunAttempt) > 0
    && (request.reason === failureReason || request.reason === timeoutReason)
    && typeof request.executionId === "string" && /^[A-Za-z0-9_.:|-]{1,512}$/.test(request.executionId)
    && typeof request.dedupeKey === "string" && /^[A-Za-z0-9_.:|-]{1,512}$/.test(request.dedupeKey)
    && Boolean(source && publisher);
}

function buildPayload(
  request: CodingRunnerRequest,
  admission: CausalProposalAdmissionIdentity,
  patchSha256: string,
  issuedAt: number,
): CausalProposalReceiptPayload {
  return Object.freeze({
    schemaVersion: 1,
    repository: request.repository,
    headSha: request.headSha.toLowerCase(),
    workflowRunId: request.workflowRunId,
    workflowRunAttempt: Number(request.workflowRunAttempt),
    reason: request.reason,
    executionId: request.executionId,
    dedupeKey: request.dedupeKey,
    sourceRunId: admission.source.runId,
    sourceRunAttempt: admission.source.runAttempt,
    publisherRunId: admission.publisher.runId,
    publisherRunAttempt: admission.publisher.runAttempt,
    publisherWorkflowRef: admission.publisher.workflowRef,
    capabilityDigest: admission.capabilityDigest,
    targetPath: CAUSAL_REPAIR_TARGET,
    patchSha256,
    issuedAt,
    expiresAt: issuedAt + MAX_RECEIPT_LIFETIME_MS,
  });
}

function validPayload(value: unknown): value is CausalProposalReceiptPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = ["schemaVersion", "repository", "headSha", "workflowRunId", "workflowRunAttempt", "reason", "executionId", "dedupeKey", "sourceRunId", "sourceRunAttempt", "publisherRunId", "publisherRunAttempt", "publisherWorkflowRef", "capabilityDigest", "targetPath", "patchSha256", "issuedAt", "expiresAt"];
  if (Object.keys(payload).sort().join("\0") !== [...keys].sort().join("\0")) return false;
  return payload.schemaVersion === 1
    && typeof payload.repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(payload.repository)
    && typeof payload.headSha === "string" && SHA40.test(payload.headSha)
    && Number.isSafeInteger(payload.workflowRunId) && Number(payload.workflowRunId) > 0
    && Number.isSafeInteger(payload.workflowRunAttempt) && Number(payload.workflowRunAttempt) > 0 && Number(payload.workflowRunAttempt) <= 9_999_999_999
    && typeof payload.reason === "string" && /^gha:[1-9][0-9]{0,19}:[0-9a-f]{40}:(?:failure|timed_out)$/.test(payload.reason)
    && typeof payload.executionId === "string" && /^[A-Za-z0-9_.:|-]{1,512}$/.test(payload.executionId)
    && typeof payload.dedupeKey === "string" && /^[A-Za-z0-9_.:|-]{1,512}$/.test(payload.dedupeKey)
    && typeof payload.sourceRunId === "string" && /^[1-9][0-9]{0,19}$/.test(payload.sourceRunId)
    && typeof payload.sourceRunAttempt === "string" && /^[1-9][0-9]{0,9}$/.test(payload.sourceRunAttempt)
    && typeof payload.publisherRunId === "string" && /^[1-9][0-9]{0,19}$/.test(payload.publisherRunId)
    && typeof payload.publisherRunAttempt === "string" && /^[1-9][0-9]{0,9}$/.test(payload.publisherRunAttempt)
    && typeof payload.publisherWorkflowRef === "string" && payload.publisherWorkflowRef === payload.repository + "/.github/workflows/autopilot-execution-consumer.yml@refs/heads/main"
    && typeof payload.capabilityDigest === "string" && SHA256.test(payload.capabilityDigest)
    && payload.targetPath === CAUSAL_REPAIR_TARGET
    && typeof payload.patchSha256 === "string" && SHA256.test(payload.patchSha256)
    && Number.isSafeInteger(payload.issuedAt) && Number(payload.issuedAt) >= 0
    && Number.isSafeInteger(payload.expiresAt) && Number(payload.expiresAt) > Number(payload.issuedAt)
    && Number(payload.expiresAt) - Number(payload.issuedAt) === MAX_RECEIPT_LIFETIME_MS;
}

export async function createCausalProposalReceipt(
  request: CodingRunnerRequest,
  admission: CausalProposalAdmissionIdentity,
  patch: string,
  signingSecret: string,
  now = Date.now(),
): Promise<string> {
  if (!validIdentity(request, admission) || !Number.isSafeInteger(now) || now < 0
    || admission.source.repository !== request.repository
    || admission.source.sha !== request.headSha.toLowerCase()
    || admission.source.runId !== String(request.workflowRunId)
    || admission.source.runAttempt !== String(request.workflowRunAttempt)
    || admission.source.workflowPath !== ".github/workflows/ci.yml"
    || admission.publisher.repository !== request.repository || admission.publisher.sha !== request.headSha.toLowerCase()
    || admission.publisher.ref !== "refs/heads/main" || admission.publisher.event !== "repository_dispatch"
    || typeof admission.publisher.runId !== "string" || !/^[1-9][0-9]{0,19}$/.test(admission.publisher.runId)
    || typeof admission.publisher.runAttempt !== "string" || !/^[1-9][0-9]{0,9}$/.test(admission.publisher.runAttempt)
    || admission.publisher.workflowRef !== request.repository + "/.github/workflows/autopilot-execution-consumer.yml@refs/heads/main"
    || !SHA256.test(admission.capabilityDigest)
    || typeof patch !== "string" || !patch.trim() || encoder.encode(patch).byteLength > MAX_PATCH_BYTES) {
    throw new Error("CAUSAL_PROPOSAL_RECEIPT_INPUT_INVALID");
  }
  const payload = buildPayload(request, admission, await sha256(patch), now);
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await receiptKey(signingSecret), encoder.encode(encodedPayload));
  return RECEIPT_PREFIX + "." + encodedPayload + "." + base64UrlEncode(new Uint8Array(signature));
}

export async function verifyCausalProposalReceipt(
  receipt: unknown,
  request: CodingRunnerRequest,
  admission: CausalProposalAdmissionIdentity,
  patch: unknown,
  signingSecret: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    if (!validIdentity(request, admission) || typeof receipt !== "string" || receipt.length > 4096
      || typeof patch !== "string" || encoder.encode(patch).byteLength > MAX_PATCH_BYTES
      || !Number.isSafeInteger(now) || now < 0) return false;
    const parts = receipt.split(".");
    if (parts.length !== 3 || parts[0] !== RECEIPT_PREFIX) return false;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(parts[1]!));
    const parsed: unknown = JSON.parse(raw);
    if (!validPayload(parsed) || JSON.stringify(parsed) !== raw) return false;
    const payload = parsed;
    if (payload.repository !== request.repository || payload.headSha !== request.headSha.toLowerCase()
      || payload.workflowRunId !== request.workflowRunId || payload.workflowRunAttempt !== request.workflowRunAttempt
      || payload.reason !== request.reason || payload.executionId !== request.executionId || payload.dedupeKey !== request.dedupeKey
      || payload.sourceRunId !== admission.source.runId || payload.sourceRunAttempt !== admission.source.runAttempt
      || payload.publisherRunId !== admission.publisher.runId || payload.publisherRunAttempt !== admission.publisher.runAttempt
      || payload.publisherWorkflowRef !== admission.publisher.workflowRef || payload.capabilityDigest !== admission.capabilityDigest
      || payload.patchSha256 !== await sha256(patch) || payload.issuedAt > now + 30_000
      || now >= payload.expiresAt) return false;
    const signature = base64UrlDecode(parts[2]!);
    return await crypto.subtle.verify("HMAC", await receiptKey(signingSecret), signature.buffer as ArrayBuffer, encoder.encode(parts[1]!));
  } catch {
    return false;
  }
}
