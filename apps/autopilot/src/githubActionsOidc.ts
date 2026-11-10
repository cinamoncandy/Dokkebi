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
  readonly workflow_sha?: unknown;
  readonly sha?: unknown;
  readonly sub?: unknown;
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

export interface VerifiedCodingSourceRun {
  readonly source: SourceExecutionIdentity;
  readonly conclusion: "failure" | "timed_out";
  readonly status: "completed";
  readonly branch: "main";
  readonly event: "push";
}

export interface VerifiedCausalProducerEvidence {
  readonly source: SourceExecutionIdentity;
  readonly sourceConclusion: "failure" | "timed_out";
  readonly producerJobId: number;
  readonly attestationJobId: number;
  readonly artifact: Readonly<{ id: number; name: string; digest: string; sizeInBytes: number }>;
  readonly fingerprints: Readonly<Record<"workflow" | "producer" | "contract" | "lockfile" | "implementation", string>>;
}

interface JsonWebKeySet {
  readonly keys?: unknown;
}

interface OidcPolicy {
  readonly errorPrefix: "CODING_RUNNER_OIDC" | "EVENT_BRIDGE_OIDC" | "RELEASE_CONTROL_OIDC" | "ISOLATED_CONSUMER_OIDC";
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

const ISOLATED_CONSUMER_WORKFLOW = ".github/workflows/causal-verification-consumer.yml";
const ISOLATED_CONSUMER_AUDIENCE = "nusa-isolated-causal-verification-v1";
const ISOLATED_CONSUMER_POLICY: OidcPolicy = Object.freeze({
  errorPrefix: "ISOLATED_CONSUMER_OIDC",
  workflowPath: ISOLATED_CONSUMER_WORKFLOW,
  requireMainRef: true,
  allowedEvents: new Set(["workflow_run"]),
});

export interface VerifiedIsolatedConsumerIdentity {
  readonly repository: string;
  readonly repositoryId: string;
  readonly workflowRef: string;
  readonly ref: "refs/heads/main";
  readonly event: "workflow_run";
  readonly sha: string;
  readonly runId: string;
  readonly runAttempt: string;
}

export interface VerifiedIsolatedSourceRun {
  readonly repository: "cinamoncandy/NUSA";
  readonly workflowPath: ".github/workflows/causal-verification.yml";
  readonly sha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly status: "completed";
  readonly conclusion: "success";
  readonly event: "workflow_dispatch";
  readonly branch: "main";
  readonly jobId: number;
}

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

/**
 * `sub` follows the repository's OIDC subject template, which can differ from the GitHub default (FORGE L1 attempt 4,
 * consumer run 42826406914, was refused at the exact default-template match although the template is not readable here).
 * Security decision: identity rests on the individually signed, pinned claims already checked (iss, aud, time,
 * repository, repository_id, ref, event_name, workflow_ref, workflow_sha, then the run read-back). `sub` must in addition
 * be bound to this repository by name or by its pinned id, carry no control characters, have a main ref segment if
 * it has one, and never be a pull_request or environment subject. An arbitrary subject is refused.
 */
/**
 * The fixed reason a subject is refused, or undefined when it is allowed. GitHub repository names are case-insensitive
 * and a subject can carry a different letter case than the `repository` claim (FORGE L1 attempt 5, consumer run
 * 42837115055, was refused with a `repo:…:ref:…` subject), so the repository segment is compared case-insensitively;
 * the case-exact `repository` claim and the pinned repository_id remain the binding identity.
 */
export function isolatedConsumerSubjectRefusal(sub: unknown): "FORMAT" | "REPOSITORY" | "REF" | "KIND" | undefined {
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 512 || /[\u0000-\u001f\u007f]/.test(sub)) return "FORMAT";
  const parts = sub.split(":");
  const boundByName = parts[0] === "repo" && (parts[1] ?? "").toLowerCase() === "cinamoncandy/nusa";
  const boundById = /(?:^|:)repository_id:1296492411(?::|$)/.test(sub);
  if (!boundByName && !boundById) return "REPOSITORY";
  // Every occurrence counts, not only the first: a duplicated, dangling or non-main ref is refused.
  const refValues = parts.flatMap((part, index) => (part === "ref" ? [parts[index + 1]] : []));
  if (refValues.length > 1 || refValues.some((value) => value !== "refs/heads/main")) return "REF";
  return /(?:^|:)(?:pull_request|environment)(?::|$)/.test(sub) ? "KIND" : undefined;
}

export function isolatedConsumerSubjectShape(sub: unknown): string {
  if (typeof sub !== "string") return "NOT_STRING";
  const keys = sub.split(":").filter((part, index) => index % 2 === 0 && /^[a-z][a-z_]{0,39}$/.test(part));
  return keys.length === 0 ? "NO_KEYS" : keys.slice(0, 3).join(":");
}

/** Authenticates only the protected-main isolated consumer, not its source event or runner result. */
export async function verifyGithubIsolatedConsumerIdentity(
  token: string,
  allowedRepository: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifiedIsolatedConsumerIdentity> {
  if (allowedRepository !== "cinamoncandy/NUSA") fail(ISOLATED_CONSUMER_POLICY, "REPOSITORY_POLICY_INVALID");
  const claims = await verifyWithPolicy(
    token, allowedRepository, ISOLATED_CONSUMER_POLICY, fetchImpl, nowSeconds, ISOLATED_CONSUMER_AUDIENCE,
  );
  const repositoryId = String(claims.repository_id ?? "");
  const sha = claims.sha;
  const workflowSha = claims.workflow_sha;
  const runId = String(claims.run_id ?? "");
  const runAttempt = String(claims.run_attempt ?? "");
  if (repositoryId !== "1296492411") fail(ISOLATED_CONSUMER_POLICY, "REPOSITORY_ID_INVALID");
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)
    || typeof workflowSha !== "string" || !/^[a-f0-9]{40}$/i.test(workflowSha)
    || workflowSha.toLowerCase() !== sha.toLowerCase()) fail(ISOLATED_CONSUMER_POLICY, "WORKFLOW_SHA_INVALID");
  const subjectRefusal = isolatedConsumerSubjectRefusal(claims.sub);
  if (subjectRefusal !== undefined) fail(ISOLATED_CONSUMER_POLICY, `SUBJECT_INVALID:${subjectRefusal}:${isolatedConsumerSubjectShape(claims.sub)}`);
  if (!/^[1-9][0-9]{0,19}$/.test(runId)) fail(ISOLATED_CONSUMER_POLICY, "RUN_ID_INVALID");
  if (!/^[1-9][0-9]{0,9}$/.test(runAttempt)) fail(ISOLATED_CONSUMER_POLICY, "RUN_ATTEMPT_INVALID");
  return Object.freeze({
    repository: allowedRepository,
    repositoryId,
    workflowRef: claims.workflow_ref as string,
    ref: "refs/heads/main",
    event: "workflow_run",
    sha: sha.toLowerCase(),
    runId,
    runAttempt,
  });
}

/** Cross-checks the consumer JWT's run identity against GitHub Actions before source verification. */
export async function verifyGithubIsolatedConsumerRun(
  identity: VerifiedIsolatedConsumerIdentity,
  token: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<void> {
  if (!token.trim() || identity.repository !== "cinamoncandy/NUSA" || identity.repositoryId !== "1296492411"
    || identity.workflowRef !== `${identity.repository}/${ISOLATED_CONSUMER_WORKFLOW}@refs/heads/main`
    || !/^[a-f0-9]{40}$/.test(identity.sha)
    || !/^[1-9][0-9]{0,19}$/.test(identity.runId)
    || !/^[1-9][0-9]{0,9}$/.test(identity.runAttempt)) {
    throw new Error("ISOLATED_CONSUMER_RUN_IDENTITY_INVALID");
  }
  let response: JsonResponse;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${identity.repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "nusa-autopilot-worker", "x-github-api-version": "2022-11-28" },
    });
  } catch {
    throw new Error("ISOLATED_CONSUMER_RUN_UNAVAILABLE");
  }
  if (!response.ok) throw new Error("ISOLATED_CONSUMER_RUN_UNAVAILABLE");
  let run: Record<string, unknown> | null;
  try { run = object(await response.json()); } catch { throw new Error("ISOLATED_CONSUMER_RUN_UNAVAILABLE"); }
  const repository = object(run?.repository);
  if (!run || String(run.id) !== identity.runId || String(run.run_attempt) !== identity.runAttempt
    || repository?.full_name !== identity.repository || String(repository?.id) !== identity.repositoryId
    || run.path !== ISOLATED_CONSUMER_WORKFLOW || run.head_sha !== identity.sha
    || run.head_branch !== "main" || run.event !== "workflow_run" || run.status !== "in_progress") {
    throw new Error("ISOLATED_CONSUMER_RUN_MISMATCH");
  }
}

/** Resolves the event source from GitHub, then verifies its producer job for the exact attempt. */
export async function verifyGithubIsolatedSourceRun(
  runId: string,
  runAttempt: string,
  token: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<VerifiedIsolatedSourceRun> {
  const repositoryName = "cinamoncandy/NUSA";
  const workflowPath = ".github/workflows/causal-verification.yml";
  if (!token.trim() || !/^[1-9][0-9]{0,19}$/.test(runId) || !/^[1-9][0-9]{0,9}$/.test(runAttempt)) {
    throw new Error("ISOLATED_SOURCE_RUN_IDENTITY_INVALID");
  }
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "nusa-autopilot-worker",
    "x-github-api-version": "2022-11-28",
  };
  let runResponse: JsonResponse;
  try {
    runResponse = await fetchImpl(`https://api.github.com/repos/${repositoryName}/actions/runs/${runId}/attempts/${runAttempt}`, { headers });
  } catch {
    throw new Error("ISOLATED_SOURCE_RUN_UNAVAILABLE");
  }
  if (!runResponse.ok) throw new Error("ISOLATED_SOURCE_RUN_UNAVAILABLE");
  let run: Record<string, unknown> | null;
  try { run = object(await runResponse.json()); } catch { throw new Error("ISOLATED_SOURCE_RUN_UNAVAILABLE"); }
  const repository = object(run?.repository);
  if (!run || String(run.id) !== runId || String(run.run_attempt) !== runAttempt
    || repository?.full_name !== repositoryName || String(repository.id) !== "1296492411"
    || run.path !== workflowPath || run.name !== "NUSA Isolated Causal Verification"
    || run.head_branch !== "main" || run.event !== "workflow_dispatch"
    || run.status !== "completed" || run.conclusion !== "success"
    || typeof run.head_sha !== "string" || !/^[a-f0-9]{40}$/.test(run.head_sha)) {
    throw new Error("ISOLATED_SOURCE_RUN_MISMATCH");
  }

  let jobsResponse: JsonResponse;
  try {
    jobsResponse = await fetchImpl(`https://api.github.com/repos/${repositoryName}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`, { headers });
  } catch {
    throw new Error("ISOLATED_SOURCE_JOB_UNAVAILABLE");
  }
  if (!jobsResponse.ok) throw new Error("ISOLATED_SOURCE_JOB_UNAVAILABLE");
  let jobsPayload: Record<string, unknown> | null;
  try { jobsPayload = object(await jobsResponse.json()); } catch { throw new Error("ISOLATED_SOURCE_JOB_UNAVAILABLE"); }
  const jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs.map(object).filter((job): job is Record<string, unknown> => Boolean(job)) : [];
  const matches = jobs.filter((job) => job.name === "verify-causal-positive");
  if (matches.length !== 1 || String(matches[0]?.run_id) !== runId
    || String(matches[0]?.run_attempt) !== runAttempt || matches[0]?.head_sha !== run.head_sha
    || matches[0]?.status !== "completed" || matches[0]?.conclusion !== "success"
    || !Number.isSafeInteger(matches[0]?.id) || Number(matches[0]?.id) <= 0) {
    throw new Error("ISOLATED_SOURCE_JOB_MISMATCH");
  }

  return Object.freeze({
    repository: repositoryName,
    workflowPath,
    sha: run.head_sha,
    runId,
    runAttempt,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    branch: "main",
    jobId: Number(matches[0]!.id),
  });
}

/** Source run identity is distinct from publisher identity and carries no causal authority. */
export async function verifyGithubCodingSourceRun(
  source: SourceExecutionIdentity,
  allowedRepository: string,
  token: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<VerifiedCodingSourceRun> {
  if (!token.trim() || source.repository !== allowedRepository
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)
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
  return Object.freeze({
    source: Object.freeze({ ...source }),
    conclusion: run.conclusion,
    status: "completed",
    branch: "main",
    event: "push",
  });
}

const CAUSAL_FINGERPRINT_PATHS = Object.freeze({
  workflow: ".github/workflows/ci.yml",
  producer: "scripts/causal-regression-observe.js",
  contract: "apps/autopilot/src/causalRegressionContract.ts",
  lockfile: "pnpm-lock.yaml",
  implementation: "apps/autopilot/src/repairableWorkflowRun.ts",
});

async function readGithubFileSha256(
  repository: string,
  sha: string,
  path: string,
  token: string,
  fetchImpl: FetchImpl,
): Promise<string> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  let response: JsonResponse;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repository}/contents/${encodedPath}?ref=${sha}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "nusa-autopilot-worker", "x-github-api-version": "2022-11-28" },
    });
  } catch { throw new Error("CODING_CAUSAL_PRODUCER_SOURCE_UNAVAILABLE"); }
  if (!response.ok) throw new Error("CODING_CAUSAL_PRODUCER_SOURCE_UNAVAILABLE");
  let file: Record<string, unknown> | null;
  try { file = object(await response.json()); } catch { throw new Error("CODING_CAUSAL_PRODUCER_SOURCE_INVALID"); }
  if (!file || file.type !== "file" || file.path !== path || file.encoding !== "base64"
    || !Number.isSafeInteger(file.size) || Number(file.size) < 1 || Number(file.size) > 1_000_000
    || typeof file.content !== "string" || file.content.length > 1_400_000
    || !/^[A-Za-z0-9+/=\s]+$/.test(file.content)) throw new Error("CODING_CAUSAL_PRODUCER_SOURCE_INVALID");
  let bytes: Uint8Array;
  try {
    const binary = atob(file.content.replace(/\s/g, ""));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { throw new Error("CODING_CAUSAL_PRODUCER_SOURCE_INVALID"); }
  if (bytes.byteLength !== Number(file.size)) throw new Error("CODING_CAUSAL_PRODUCER_SOURCE_INVALID");
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Cross-checks the protected source, producer jobs, artifact, and exact source-file fingerprints through GitHub's API. */
export async function verifyGithubCausalProducerEvidence(
  source: SourceExecutionIdentity,
  allowedRepository: string,
  token: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<VerifiedCausalProducerEvidence> {
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
  const producerJobs = matchesJob("causal-regression-contract", "failure");
  const attestationJobs = matchesJob("attest-causal-regression", "success");
  if (producerJobs.length !== 1 || attestationJobs.length !== 1
    || !Number.isSafeInteger(producerJobs[0]?.id) || Number(producerJobs[0]?.id) <= 0
    || !Number.isSafeInteger(attestationJobs[0]?.id) || Number(attestationJobs[0]?.id) <= 0) {
    throw new Error("CODING_CAUSAL_PRODUCER_JOBS_MISMATCH");
  }

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

  const [sourceRun, fingerprintValues] = await Promise.all([
    verifyGithubCodingSourceRun(source, allowedRepository, token, fetchImpl),
    Promise.all(Object.values(CAUSAL_FINGERPRINT_PATHS).map((path) => readGithubFileSha256(source.repository, source.sha, path, token, fetchImpl))),
  ]);
  const fingerprints = Object.freeze({
    workflow: fingerprintValues[0]!,
    producer: fingerprintValues[1]!,
    contract: fingerprintValues[2]!,
    lockfile: fingerprintValues[3]!,
    implementation: fingerprintValues[4]!,
  });
  return Object.freeze({
    source: Object.freeze({ ...source }),
    sourceConclusion: sourceRun.conclusion,
    producerJobId: Number(producerJobs[0]!.id),
    attestationJobId: Number(attestationJobs[0]!.id),
    artifact: Object.freeze({
      id: Number(matchingArtifacts[0]!.id),
      name: expectedName,
      digest: String(matchingArtifacts[0]!.digest),
      sizeInBytes: Number(matchingArtifacts[0]!.size_in_bytes),
    }),
    fingerprints,
  });
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
