import type { AutopilotExecutionRequest } from "./executionPlanner";

export interface GithubExecutorConfig {
  readonly token?: string;
  readonly allowedRepository: string;
  readonly apiBaseUrl?: string;
}

export interface GithubExecutorResult {
  readonly status: "NOOP" | "INTERFACE_READY" | "DISPATCHED" | "REJECTED" | "FAILED";
  readonly reason: string;
  readonly httpStatus: number | null;
  readonly requestedHeadSha: string | null;
  readonly observedHeadSha: string | null;
}

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EXECUTION_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const DEDUPE_KEY = /^[A-Za-z0-9_.:-]{1,256}$/;

function result(
  status: GithubExecutorResult["status"],
  reason: string,
  httpStatus: number | null = null,
  requestedHeadSha: string | null = null,
  observedHeadSha: string | null = null,
): GithubExecutorResult {
  return Object.freeze({ status, reason, httpStatus, requestedHeadSha, observedHeadSha });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "nusa-autopilot-worker",
    "x-github-api-version": "2022-11-28",
  };
}

function githubClientPayload(request: AutopilotExecutionRequest): Record<string, unknown> {
  return {
    kind: request.kind,
    repository: request.repository,
    head_sha: request.headSha,
    ...(request.kind === "AUDIT_REQUEST" ? { pr_number: request.prNumber } : {}),
    workflow_run_id: request.workflowRunId,
    ...(request.kind === "AUDIT_REQUEST" ? {} : { reason: request.reason }),
    execution_id: request.executionId ?? null,
    dedupe_key: request.dedupeKey ?? null,
    ...(request.contractFingerprintSha256 ? { contract_fingerprint_sha256: request.contractFingerprintSha256.toLowerCase() } : {}),
    ...(request.causalDispatchCapability ? { causal_dispatch_capability: request.causalDispatchCapability, causal_source_run_attempt: request.causalSourceRunAttempt } : {}),
    live_authority: "NONE",
    production_mutation_allowed: false,
    ai_authority: "ZERO_AUTHORITY",
  };
}

async function findExistingAuditDispatch(
  base: string,
  repository: string,
  request: AutopilotExecutionRequest,
  token: string,
  fetchImpl: typeof fetch,
): Promise<GithubExecutorResult | boolean> {
  const dedupeKey = request.dedupeKey!;
  const logicalPattern = new RegExp(`^audit:${request.prNumber}:${request.workflowRunId}(?::[0-9]+)?:${request.headSha!.toLowerCase()}$`);
  for (let page = 1; page <= 3; page += 1) {
    const response = await fetchImpl(`${base}/repos/${repository}/actions/workflows/autopilot-deterministic-audit-release.yml/runs?event=repository_dispatch&per_page=100&page=${page}`, { headers: githubHeaders(token) });
    if (response.status === 401 || response.status === 403) return result("FAILED", "github-executor-audit-dedupe-auth-rejected", response.status);
    if (response.status === 404) return result("FAILED", "github-executor-audit-dedupe-evidence-unavailable", 404);
    if (!response.ok) return result("FAILED", `github-executor-audit-dedupe-http-${response.status}`, response.status);
    let payload: unknown;
    try { payload = await response.json(); } catch { return result("FAILED", "github-executor-audit-dedupe-evidence-invalid", response.status); }
    const runs = object(payload)?.workflow_runs;
    if (!Array.isArray(runs)) return result("FAILED", "github-executor-audit-dedupe-evidence-invalid", response.status);
    const duplicate = runs.some((entry) => {
      const run = object(entry);
      const title = typeof run?.display_title === "string" ? run.display_title : "";
      if (title === dedupeKey) return true;
      if (!logicalPattern.test(title)) return false;
      return run?.status !== "completed" || run?.conclusion === "success";
    });
    if (duplicate) return true;
    if (runs.length < 100) return false;
  }
  return false;
}

async function resolveCurrentMainSha(
  base: string,
  repository: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<GithubExecutorResult | string> {
  const response = await fetchImpl(`${base}/repos/${repository}/branches/main`, { headers: githubHeaders(token) });
  if (response.status === 401 || response.status === 403) return result("FAILED", "github-executor-auth-rejected", response.status);
  if (response.status === 404) return result("FAILED", "github-executor-repository-or-token-scope-invalid", 404);
  if (!response.ok) return result("FAILED", `github-executor-main-head-http-${response.status}`, response.status);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return result("FAILED", "github-executor-main-head-invalid", response.status);
  }
  const sha = object(object(payload)?.commit)?.sha;
  if (typeof sha !== "string" || !SHA40.test(sha)) return result("FAILED", "github-executor-main-head-invalid", response.status);
  return sha.toLowerCase();
}

function hasHoldLabel(pr: Record<string, unknown>): boolean {
  const labels = Array.isArray(pr.labels) ? pr.labels : [];
  return labels.some((label) => {
    const name = object(label)?.name;
    return typeof name === "string" && name.trim().toUpperCase() === "HOLD";
  });
}

async function resolveCurrentPullRequestHead(
  base: string,
  repository: string,
  prNumber: number,
  token: string,
  fetchImpl: typeof fetch,
): Promise<GithubExecutorResult | string> {
  const response = await fetchImpl(`${base}/repos/${repository}/pulls/${prNumber}`, { headers: githubHeaders(token) });
  if (response.status === 401 || response.status === 403) return result("FAILED", "github-executor-auth-rejected", response.status);
  if (response.status === 404) return result("FAILED", "github-executor-pr-or-token-scope-invalid", 404);
  if (!response.ok) return result("FAILED", `github-executor-pr-head-http-${response.status}`, response.status);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return result("FAILED", "github-executor-pr-head-invalid", response.status);
  }
  const pr = object(payload);
  if (!pr) return result("FAILED", "github-executor-pr-head-invalid", response.status);
  const sha = object(pr.head)?.sha;
  if (pr.state !== "open") return result("REJECTED", "github-executor-pr-not-open", response.status);
  if (pr.draft === true) return result("REJECTED", "github-executor-pr-draft-hold-active", response.status);
  if (hasHoldLabel(pr)) return result("REJECTED", "github-executor-pr-hold-label-active", response.status);
  if (typeof sha !== "string" || !SHA40.test(sha)) return result("FAILED", "github-executor-pr-head-invalid", response.status);
  return sha.toLowerCase();
}

export async function executeGithubDispatch(
  request: AutopilotExecutionRequest,
  config: GithubExecutorConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubExecutorResult> {
  if (request.kind === "NOOP") return result("NOOP", "execution-request-noop");
  const token = config.token?.trim();
  if (!token) return result("INTERFACE_READY", "github-executor-token-not-configured");
  if (!REPOSITORY.test(config.allowedRepository)) return result("REJECTED", "github-executor-allowlist-invalid");
  if (request.repository !== config.allowedRepository) return result("REJECTED", "github-executor-repository-not-allowed");
  if (!request.headSha || !SHA40.test(request.headSha)) return result("REJECTED", "github-executor-head-sha-invalid");
  if (!Number.isSafeInteger(request.workflowRunId) || (request.workflowRunId ?? 0) <= 0) {
    return result("REJECTED", "github-executor-workflow-run-id-required");
  }
  if (request.kind === "REPOSITORY_AUTOPILOT" || request.kind === "AUDIT_REQUEST") {
    if (!request.executionId || !EXECUTION_ID.test(request.executionId)) return result("REJECTED", "github-executor-execution-id-required");
    if (!request.dedupeKey || !DEDUPE_KEY.test(request.dedupeKey)) return result("REJECTED", "github-executor-dedupe-key-required");
  }
  if (request.contractFingerprintSha256 != null && !SHA256.test(request.contractFingerprintSha256)) {
    return result("REJECTED", "github-executor-contract-fingerprint-invalid");
  }
  if (request.causalDispatchCapability != null || request.causalSourceRunAttempt != null) {
    if (request.kind !== "REPOSITORY_AUTOPILOT" || typeof request.causalDispatchCapability !== "string"
      || !/^[a-f0-9]{64}$/.test(request.causalDispatchCapability)
      || !Number.isSafeInteger(request.causalSourceRunAttempt) || Number(request.causalSourceRunAttempt) <= 0
      || Number(request.causalSourceRunAttempt) > 9_999_999_999) {
      return result("REJECTED", "github-executor-causal-dispatch-invalid");
    }
  }
  if (request.kind === "AUDIT_REQUEST" && (!Number.isSafeInteger(request.prNumber) || (request.prNumber ?? 0) <= 0)) {
    return result("REJECTED", "github-executor-pr-number-required");
  }

  const base = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const currentHead = request.kind === "AUDIT_REQUEST"
    ? await resolveCurrentPullRequestHead(base, config.allowedRepository, request.prNumber!, token, fetchImpl)
    : await resolveCurrentMainSha(base, config.allowedRepository, token, fetchImpl);
  if (typeof currentHead !== "string") return currentHead;
  const requestedHead = request.headSha.toLowerCase();
  if (currentHead !== requestedHead) {
    return result(
      "REJECTED",
      request.kind === "AUDIT_REQUEST" ? "github-executor-stale-pr-head-suppressed" : "github-executor-stale-head-suppressed",
      null,
      requestedHead,
      currentHead,
    );
  }

  if (request.kind === "AUDIT_REQUEST") {
    const existing = await findExistingAuditDispatch(base, config.allowedRepository, request, token, fetchImpl);
    if (typeof existing !== "boolean") return existing;
    if (existing) return result("REJECTED", "github-executor-duplicate-audit-run-suppressed", null, requestedHead, currentHead);
  }

  const response = await fetchImpl(`${base}/repos/${config.allowedRepository}/dispatches`, {
    method: "POST",
    headers: {
      ...githubHeaders(token),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      event_type: request.kind === "AUDIT_REQUEST" ? "nusa_autopilot_audit" : "nusa_autopilot_execution",
      client_payload: githubClientPayload(request),
    }),
  });

  if (response.status === 204) return result("DISPATCHED", "github-repository-dispatch-accepted", 204, requestedHead, currentHead);
  if (response.status === 401 || response.status === 403) return result("FAILED", "github-executor-auth-rejected", response.status, requestedHead, currentHead);
  if (response.status === 404) return result("FAILED", "github-executor-repository-or-token-scope-invalid", 404, requestedHead, currentHead);
  return result("FAILED", `github-executor-http-${response.status}`, response.status, requestedHead, currentHead);
}
