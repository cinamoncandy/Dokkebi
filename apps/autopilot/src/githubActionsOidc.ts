const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const DEFAULT_AUDIENCE = "nusa-autopilot";
const CLOCK_SKEW_SECONDS = 60;
const CODING_RUNNER_WORKFLOW = ".github/workflows/autopilot-execution-consumer.yml";
const EVENT_BRIDGE_WORKFLOW = ".github/workflows/autopilot-github-event-bridge.yml";
const RELEASE_CONTROL_WORKFLOW = ".github/workflows/autopilot-deterministic-audit-release.yml";
const EVENT_BRIDGE_EVENTS = new Set(["push", "pull_request_target", "workflow_run"]);

interface JsonResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<JsonResponse>;

interface JwtHeader {
  readonly alg?: unknown;
  readonly kid?: unknown;
  readonly typ?: unknown;
}

interface JwtClaims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
  readonly iat?: unknown;
  readonly repository?: unknown;
  readonly repository_id?: unknown;
  readonly ref?: unknown;
  readonly event_name?: unknown;
  readonly workflow_ref?: unknown;
  readonly sha?: unknown;
  readonly run_id?: unknown;
  readonly run_attempt?: unknown;
}

/** Identity extracted only after signature and the coding workflow policy pass. */
export interface VerifiedCodingPublisherIdentity {
  readonly repository: string;
  readonly workflowRef: string;
  readonly ref: string;
  readonly sha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly event: string;
}

export interface SourceExecutionIdentity {
  readonly repository: string;
  readonly workflowPath: string;
  readonly sha: string;
  readonly runId: string;
  readonly runAttempt: string;
}

interface JsonWebKeySet {
  readonly keys?: unknown;
}

interface OidcPolicy {
  readonly errorPrefix: "CODING_RUNNER_OIDC" | "EVENT_BRIDGE_OIDC" | "RELEASE_CONTROL_OIDC";
  readonly workflowPath: string;
  readonly requireMainRef: boolean;
  readonly allowedEvents: ReadonlySet<string>;
}

const CODING_RUNNER_POLICY: OidcPolicy = Object.freeze({
  errorPrefix: "CODING_RUNNER_OIDC",
  workflowPath: CODING_RUNNER_WORKFLOW,
  requireMainRef: true,
  allowedEvents: new Set(["repository_dispatch"]),
});

const EVENT_BRIDGE_POLICY: OidcPolicy = Object.freeze({
  errorPrefix: "EVENT_BRIDGE_OIDC",
  workflowPath: EVENT_BRIDGE_WORKFLOW,
  requireMainRef: false,
  allowedEvents: EVENT_BRIDGE_EVENTS,
});

const RELEASE_CONTROL_POLICY: OidcPolicy = Object.freeze({
  errorPrefix: "RELEASE_CONTROL_OIDC",
  workflowPath: RELEASE_CONTROL_WORKFLOW,
  requireMainRef: true,
  allowedEvents: new Set(["repository_dispatch"]),
});

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function decodeJson<T>(value: string, error: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
  } catch {
    throw new Error(error);
  }
}

function audienceIncludes(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some((item) => item === expected);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function fail(policy: OidcPolicy, suffix: string): never {
  throw new Error(`${policy.errorPrefix}_${suffix}`);
}

function assertClaims(
  claims: JwtClaims,
  allowedRepository: string,
  nowSeconds: number,
  audience: string,
  policy: OidcPolicy,
): void {
  if (claims.iss !== GITHUB_OIDC_ISSUER) fail(policy, "ISSUER_INVALID");
  if (!audienceIncludes(claims.aud, audience)) fail(policy, "AUDIENCE_INVALID");

  const exp = finiteNumber(claims.exp);
  const nbf = finiteNumber(claims.nbf);
  const iat = finiteNumber(claims.iat);
  if (exp === null || exp < nowSeconds - CLOCK_SKEW_SECONDS) fail(policy, "EXPIRED");
  if (nbf !== null && nbf > nowSeconds + CLOCK_SKEW_SECONDS) fail(policy, "NOT_YET_VALID");
  if (iat === null || iat > nowSeconds + CLOCK_SKEW_SECONDS || iat < nowSeconds - 600) fail(policy, "ISSUED_AT_INVALID");

  if (claims.repository !== allowedRepository) fail(policy, "REPOSITORY_INVALID");
  if (policy.requireMainRef && claims.ref !== "refs/heads/main") fail(policy, "REF_INVALID");
  if (typeof claims.event_name !== "string" || !policy.allowedEvents.has(claims.event_name)) fail(policy, "EVENT_INVALID");
  const trustedWorkflowRef = `${allowedRepository}/${policy.workflowPath}@refs/heads/main`;
  if (claims.workflow_ref !== trustedWorkflowRef) fail(policy, "WORKFLOW_INVALID");
}

async function verifyWithPolicy(
  token: string,
  allowedRepository: string,
  policy: OidcPolicy,
  fetchImpl: FetchImpl,
  nowSeconds: number,
  audience: string,
): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) fail(policy, "TOKEN_INVALID");
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeJson<JwtHeader>(encodedHeader!, `${policy.errorPrefix}_HEADER_INVALID`);
  const claims = decodeJson<JwtClaims>(encodedClaims!, `${policy.errorPrefix}_CLAIMS_INVALID`);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) fail(policy, "HEADER_INVALID");

  const jwksResponse = await fetchImpl(GITHUB_OIDC_JWKS, { headers: { accept: "application/json" } });
  if (!jwksResponse.ok) throw new Error(`${policy.errorPrefix}_JWKS_HTTP_${jwksResponse.status}`);
  const payload = object(await jwksResponse.json()) as JsonWebKeySet | null;
  const keys = Array.isArray(payload?.keys) ? payload.keys : [];
  const jwk = keys.map(object).find((key) => key?.kid === header.kid && key?.kty === "RSA");
  if (!jwk) fail(policy, "KEY_NOT_FOUND");

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    fail(policy, "KEY_INVALID");
  }

  const signed = toArrayBuffer(new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`));
  const signature = toArrayBuffer(decodeBase64Url(encodedSignature!));
  const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  if (!verified) fail(policy, "SIGNATURE_INVALID");
  assertClaims(claims, allowedRepository, nowSeconds, audience, policy);
  return claims;
}

export async function verifyGithubActionsOidcToken(
  token: string,
  allowedRepository: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  nowSeconds = Math.floor(Date.now() / 1000),
  audience = DEFAULT_AUDIENCE,
): Promise<void> {
  await verifyWithPolicy(token, allowedRepository, CODING_RUNNER_POLICY, fetchImpl, nowSeconds, audience);
}

/** This identity authenticates the publisher, not the cause or source of a failure. */
export async function verifyGithubCodingPublisherIdentity(
  token: string,
  allowedRepository: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  nowSeconds = Math.floor(Date.now() / 1000),
  audience = DEFAULT_AUDIENCE,
): Promise<VerifiedCodingPublisherIdentity> {
  const claims = await verifyWithPolicy(token, allowedRepository, CODING_RUNNER_POLICY, fetchImpl, nowSeconds, audience);
  if (typeof claims.sha !== "string" || !/^[a-f0-9]{40}$/i.test(claims.sha)) fail(CODING_RUNNER_POLICY, "SHA_INVALID");
  if (typeof claims.run_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(claims.run_id)) fail(CODING_RUNNER_POLICY, "RUN_ID_INVALID");
  if (typeof claims.run_attempt !== "string" || !/^[1-9][0-9]{0,9}$/.test(claims.run_attempt)) fail(CODING_RUNNER_POLICY, "RUN_ATTEMPT_INVALID");
  return Object.freeze({ repository: allowedRepository, workflowRef: claims.workflow_ref as string, ref: claims.ref as string,
    sha: claims.sha.toLowerCase(), runId: claims.run_id, runAttempt: claims.run_attempt, event: claims.event_name as string });
}

/** Cross-check the publisher's signed claims against its GitHub run, not a client body.
 * This alone does not authorize publication for any source run. */
export async function verifyGithubCodingPublisherRun(
  identity: VerifiedCodingPublisherIdentity,
  token: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<void> {
  if (!token.trim() || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository)
    || !/^[1-9][0-9]{0,19}$/.test(identity.runId)) throw new Error("CODING_PUBLISHER_RUN_IDENTITY_INVALID");
  let response: JsonResponse;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${identity.repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "nusa-autopilot-worker", "x-github-api-version": "2022-11-28" },
    });
  } catch {
    throw new Error("CODING_PUBLISHER_RUN_UNAVAILABLE");
  }
  if (!response.ok) throw new Error("CODING_PUBLISHER_RUN_UNAVAILABLE");
  let run: Record<string, unknown> | null;
  try { run = object(await response.json()); } catch { throw new Error("CODING_PUBLISHER_RUN_UNAVAILABLE"); }
  const repository = object(run?.repository);
  if (!run || String(run.id) !== identity.runId || String(run.run_attempt) !== identity.runAttempt
    || repository?.full_name !== identity.repository || run.path !== CODING_RUNNER_WORKFLOW
    || run.head_sha !== identity.sha || run.head_branch !== "main" || run.event !== identity.event) {
    throw new Error("CODING_PUBLISHER_RUN_MISMATCH");
  }
}

/** Source run identity is distinct from publisher identity and carries no causal authority. */
export async function verifyGithubCodingSourceRun(
  source: SourceExecutionIdentity,
  allowedRepository: string,
  token: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<void> {
  if (!token.trim() || source.repository !== allowedRepository
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)
    || source.workflowPath !== ".github/workflows/ci.yml"
    || source.workflowPath !== ".github/workflows/ci.yml"
    || !/^[a-f0-9]{40}$/.test(source.sha)
    || !/^[1-9][0-9]{0,19}$/.test(source.runId)
    || !/^[1-9][0-9]{0,9}$/.test(source.runAttempt)) throw new Error("CODING_SOURCE_IDENTITY_INVALID");
  let response: JsonResponse;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${source.repository}/actions/runs/${source.runId}/attempts/${source.runAttempt}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "nusa-autopilot-worker", "x-github-api-version": "2022-11-28" },
    });
  } catch { throw new Error("CODING_SOURCE_RUN_UNAVAILABLE"); }
  if (!response.ok) throw new Error("CODING_SOURCE_RUN_UNAVAILABLE");
  let run: Record<string, unknown> | null;
  try { run = object(await response.json()); } catch { throw new Error("CODING_SOURCE_RUN_UNAVAILABLE"); }
  if (!run || String(run.id) !== source.runId || String(run.run_attempt) !== source.runAttempt
    || object(run.repository)?.full_name !== source.repository || run.path !== source.workflowPath
    || run.head_sha !== source.sha || run.head_branch !== "main" || run.event !== "push"
    || run.status !== "completed" || (run.conclusion !== "failure" && run.conclusion !== "timed_out")) {
    throw new Error("CODING_SOURCE_RUN_MISMATCH");
  }
}

/** Cross-checks the protected producer jobs and same-run signed artifact through GitHub's API. */
export async function verifyGithubCausalProducerEvidence(
  source: SourceExecutionIdentity,
  allowedRepository: string,
  token: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<void> {
  if (!token.trim() || source.repository !== allowedRepository
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)
    || !/^[a-f0-9]{40}$/.test(source.sha)
    || !/^[1-9][0-9]{0,19}$/.test(source.runId)
    || !/^[1-9][0-9]{0,9}$/.test(source.runAttempt)) throw new Error("CODING_CAUSAL_PRODUCER_IDENTITY_INVALID");

  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "nusa-autopilot-worker",
    "x-github-api-version": "2022-11-28",
  };
  let jobsResponse: JsonResponse;
  try {
    jobsResponse = await fetchImpl(`https://api.github.com/repos/${source.repository}/actions/runs/${source.runId}/attempts/${source.runAttempt}/jobs?per_page=100`, { headers });
  } catch { throw new Error("CODING_CAUSAL_PRODUCER_JOBS_UNAVAILABLE"); }
  if (!jobsResponse.ok) throw new Error("CODING_CAUSAL_PRODUCER_JOBS_UNAVAILABLE");
  let jobsPayload: Record<string, unknown> | null;
  try { jobsPayload = object(await jobsResponse.json()); } catch { throw new Error("CODING_CAUSAL_PRODUCER_JOBS_UNAVAILABLE"); }
  const jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs.map(object) : [];
  if (!jobsPayload || jobsPayload.total_count !== jobs.length || jobs.length > 100) throw new Error("CODING_CAUSAL_PRODUCER_JOBS_MISMATCH");
  const matchesJob = (name: string, conclusion: string) => jobs.filter((job) => job?.name === name
    && String(job.run_id) === source.runId && String(job.run_attempt) === source.runAttempt
    && job.head_sha === source.sha && job.status === "completed" && job.conclusion === conclusion);
  if (matchesJob("causal-regression-contract", "failure").length !== 1
    || matchesJob("attest-causal-regression", "success").length !== 1) throw new Error("CODING_CAUSAL_PRODUCER_JOBS_MISMATCH");

  let artifactsResponse: JsonResponse;
  try {
    artifactsResponse = await fetchImpl(`https://api.github.com/repos/${source.repository}/actions/runs/${source.runId}/artifacts?per_page=100`, { headers });
  } catch { throw new Error("CODING_CAUSAL_PRODUCER_ARTIFACT_UNAVAILABLE"); }
  if (!artifactsResponse.ok) throw new Error("CODING_CAUSAL_PRODUCER_ARTIFACT_UNAVAILABLE");
  let artifactsPayload: Record<string, unknown> | null;
  try { artifactsPayload = object(await artifactsResponse.json()); } catch { throw new Error("CODING_CAUSAL_PRODUCER_ARTIFACT_UNAVAILABLE"); }
  const artifacts = Array.isArray(artifactsPayload?.artifacts) ? artifactsPayload.artifacts.map(object) : [];
  if (!artifactsPayload || artifactsPayload.total_count !== artifacts.length || artifacts.length > 100) throw new Error("CODING_CAUSAL_PRODUCER_ARTIFACT_MISMATCH");
  const expectedName = `nusa-causal-attestation-${source.runAttempt}`;
  const matchingArtifacts = artifacts.filter((artifact) => artifact?.name === expectedName
    && artifact.expired === false
    && String(object(artifact.workflow_run)?.id) === source.runId
    && object(artifact.workflow_run)?.head_sha === source.sha
    && typeof artifact.id === "number" && Number.isSafeInteger(artifact.id) && artifact.id > 0
    && typeof artifact.size_in_bytes === "number" && Number.isSafeInteger(artifact.size_in_bytes)
    && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 2 * 1024 * 1024
    && typeof artifact.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(artifact.digest));
  if (matchingArtifacts.length !== 1) throw new Error("CODING_CAUSAL_PRODUCER_ARTIFACT_MISMATCH");
}

export async function verifyGithubEventBridgeOidcToken(
  token: string,
  allowedRepository: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  nowSeconds = Math.floor(Date.now() / 1000),
  audience = DEFAULT_AUDIENCE,
): Promise<void> {
  await verifyWithPolicy(token, allowedRepository, EVENT_BRIDGE_POLICY, fetchImpl, nowSeconds, audience);
}

export async function verifyGithubReleaseControlOidcToken(
  token: string,
  allowedRepository: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  nowSeconds = Math.floor(Date.now() / 1000),
  audience = DEFAULT_AUDIENCE,
): Promise<void> {
  await verifyWithPolicy(token, allowedRepository, RELEASE_CONTROL_POLICY, fetchImpl, nowSeconds, audience);
}
