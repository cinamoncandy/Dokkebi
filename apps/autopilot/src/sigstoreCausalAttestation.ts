import { bundleFromJSON } from "@sigstore/bundle";
import { crypto as sigstoreCrypto } from "@sigstore/core";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier, type SignedEntity } from "@sigstore/verify";
import { SIGSTORE_TRUSTED_ROOT_JSON_TEXT } from "./sigstoreTrustedRoot";

const REPOSITORY = "cinamoncandy/NUSA";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW_REF = `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`;
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const PREDICATE_TYPE = "https://github.com/cinamoncandy/NUSA/attestations/causal-regression/v1";
const CONTRACT_ID = "REPAIRABLE_WORKFLOW_POLICY_V1";
const TRUSTED_ROOT_SHA256 = "6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66";
const SHA256 = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;

export interface CausalSourceRunIdentity {
  readonly repository: string;
  readonly sha: string;
  readonly runId: string;
  readonly runAttempt: string;
}

export interface VerifiedCausalObservationManifest {
  readonly schemaVersion: 1;
  readonly contractId: typeof CONTRACT_ID;
  readonly source: Readonly<{
    repository: string;
    workflowPath: typeof WORKFLOW_PATH;
    workflowRef: typeof WORKFLOW_REF;
    workflowSha: string;
    ref: "refs/heads/main";
    event: "push";
    job: "causal-regression-contract";
    sha: string;
    runId: string;
    runAttempt: string;
  }>;
  readonly fingerprints: Readonly<Record<"workflow" | "producer" | "contract" | "lockfile" | "implementation", string>>;
  readonly observation: Readonly<{
    contract: typeof CONTRACT_ID;
    status: "OBSERVED_MISMATCH";
    caseId: "main-ci-failure" | "main-ci-timeout";
    expected: true;
    observed: false;
  }>;
}

/** Cryptographic verification is deliberately distinct from source-run authorization and causal admission. */
export interface CryptographicallyVerifiedCausalManifest {
  readonly manifest: VerifiedCausalObservationManifest;
  readonly signerIdentity: Readonly<{ subjectAlternativeName: string; issuer: string }>;
  readonly statementDigest: string;
}

function fail(): never {
  throw new Error("CAUSAL_ATTESTATION_INVALID");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function hasForbiddenField(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some((entry) => hasForbiddenField(entry, depth + 1));
  const record = asObject(value);
  if (!record) return false;
  return Object.entries(record).some(([key, entry]) => /(token|secret|capability|credential)/i.test(key)
    || hasForbiddenField(entry, depth + 1));
}

function validateManifest(value: unknown, expected: CausalSourceRunIdentity): VerifiedCausalObservationManifest {
  const manifest = asObject(value);
  const source = asObject(manifest?.source);
  const fingerprints = asObject(manifest?.fingerprints);
  const observation = asObject(manifest?.observation);
  if (!manifest || manifest.schemaVersion !== 1 || manifest.contractId !== CONTRACT_ID
    || !source || !fingerprints || !observation || hasForbiddenField(manifest)) fail();

  if (source.repository !== REPOSITORY || expected.repository !== REPOSITORY
    || source.workflowPath !== WORKFLOW_PATH || source.workflowRef !== WORKFLOW_REF
    || source.workflowSha !== expected.sha || source.ref !== "refs/heads/main" || source.event !== "push"
    || source.job !== "causal-regression-contract" || source.sha !== expected.sha
    || source.runId !== expected.runId || source.runAttempt !== expected.runAttempt
    || !SHA40.test(expected.sha) || !/^[1-9][0-9]{0,19}$/.test(expected.runId)
    || !/^[1-9][0-9]{0,9}$/.test(expected.runAttempt)) fail();

  for (const key of ["workflow", "producer", "contract", "lockfile", "implementation"] as const) {
    if (typeof fingerprints[key] !== "string" || !SHA256.test(fingerprints[key] as string)) fail();
  }

  if (observation.contract !== CONTRACT_ID || observation.status !== "OBSERVED_MISMATCH"
    || (observation.caseId !== "main-ci-failure" && observation.caseId !== "main-ci-timeout")
    || observation.expected !== true || observation.observed !== false) fail();

  return Object.freeze({
    schemaVersion: 1,
    contractId: CONTRACT_ID,
    source: Object.freeze({
      repository: REPOSITORY,
      workflowPath: WORKFLOW_PATH,
      workflowRef: WORKFLOW_REF,
      workflowSha: expected.sha,
      ref: "refs/heads/main",
      event: "push",
      job: "causal-regression-contract",
      sha: expected.sha,
      runId: expected.runId,
      runAttempt: expected.runAttempt,
    }),
    fingerprints: Object.freeze({
      workflow: fingerprints.workflow as string,
      producer: fingerprints.producer as string,
      contract: fingerprints.contract as string,
      lockfile: fingerprints.lockfile as string,
      implementation: fingerprints.implementation as string,
    }),
    observation: Object.freeze({
      contract: CONTRACT_ID,
      status: "OBSERVED_MISMATCH",
      caseId: observation.caseId,
      expected: true,
      observed: false,
    }),
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function installEntityScopedWorkerDigestAdapter(entity: SignedEntity): () => void {
  const signature = entity.signature as SignedEntity["signature"] & {
    preAuthEncoding: Uint8Array;
    signature: Uint8Array;
  };
  const original = entity.signature.verifySignature;
  entity.signature.verifySignature = function verifySignatureWithWorkerDigest(key) {
    if (key?.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") {
      return sigstoreCrypto.verify(Buffer.from(signature.preAuthEncoding), key, Buffer.from(signature.signature), "sha256");
    }
    if (key?.asymmetricKeyType === "ed25519") {
      // Ed25519 uses a one-shot signature and therefore has no digest parameter.
      return sigstoreCrypto.verify(Buffer.from(signature.preAuthEncoding), key, Buffer.from(signature.signature));
    }
    return false;
  };
  return () => { entity.signature.verifySignature = original; };
}

function trustedRootText(): string {
  return SIGSTORE_TRUSTED_ROOT_JSON_TEXT;
}

/**
 * Verifies the GitHub Actions Sigstore bundle and its narrow signed predicate.
 * This is not a causal receipt, a GitHub run cross-check, a replay claim, or CODE_ACTIONABLE.
 */
export async function verifyCausalProducerAttestation(
  bundleInput: unknown,
  expectedSource: CausalSourceRunIdentity,
): Promise<CryptographicallyVerifiedCausalManifest> {
  try {
    const rootText = trustedRootText();
    if (await sha256Hex(new TextEncoder().encode(rootText)) !== TRUSTED_ROOT_SHA256) fail();
    const root = TrustedRoot.fromJSON(JSON.parse(rootText));
    const bundleRecord = asObject(bundleInput);
    if (!bundleRecord) fail();
    const bundle = bundleFromJSON(bundleRecord as never);
    const entity = toSignedEntity(bundle);
    const restoreDigestAdapter = installEntityScopedWorkerDigestAdapter(entity);
    let signer;
    try {
      try {
        signer = new Verifier(toTrustMaterial(root), { ctlogThreshold: 1, tlogThreshold: 1, timestampThreshold: 1 }).verify(entity, {
          subjectAlternativeName: new RegExp(`^${WORKFLOW_REF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
          extensions: { issuer: OIDC_ISSUER },
        });
      } catch (error) {
        if (asObject(error)?.code === "UNTRUSTED_SIGNER_ERROR") throw new Error("CAUSAL_ATTESTATION_SIGNER_REJECTED");
        throw error;
      }
    } finally {
      restoreDigestAdapter();
    }
    const identity = signer.identity;
    if (!isIdentity(identity?.subjectAlternativeName) || identity.subjectAlternativeName !== WORKFLOW_REF
      || identity.extensions?.issuer !== OIDC_ISSUER) fail();

    const dsse = (entity.signature as typeof entity.signature & { env?: { payload?: Uint8Array } }).env;
    if (!(dsse?.payload instanceof Uint8Array) || dsse.payload.byteLength > 64_000) fail();
    const statement = asObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(dsse.payload)));
    const subjects = statement?.subject;
    const predicate = asObject(statement?.predicate);
    if (statement?._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== PREDICATE_TYPE
      || !Array.isArray(subjects) || subjects.length !== 1 || !predicate) fail();
    const subject = asObject(subjects[0]);
    const digest = asObject(subject?.digest);
    if (!subject || !digest || typeof digest.sha256 !== "string" || !SHA256.test(digest.sha256)) fail();

    const manifest = validateManifest(predicate, expectedSource);
    const exactReceiptBytes = new TextEncoder().encode(`${JSON.stringify(predicate)}\n`);
    const statementDigest = await sha256Hex(exactReceiptBytes);
    if (statementDigest !== digest.sha256) fail();
    return Object.freeze({
      manifest,
      signerIdentity: Object.freeze({ subjectAlternativeName: identity.subjectAlternativeName, issuer: identity.extensions.issuer }),
      statementDigest,
    });
  } catch (error) {
    if (error instanceof Error && (error.message === "CAUSAL_ATTESTATION_SIGNER_REJECTED" || error.message === "CAUSAL_ATTESTATION_INVALID")) throw error;
    throw new Error("CAUSAL_ATTESTATION_INVALID");
  }
}
