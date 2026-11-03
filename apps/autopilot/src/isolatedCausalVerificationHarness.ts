import { classifyIsolatedCausalVerification } from "./causalRegressionAdmission";
import {
  completePersistentExecution,
  ExecutionCoordinator,
  markPersistentExecutionDispatched,
  acquirePersistentExecution,
  type ExecutionCoordinatorNamespace,
} from "./executionCoordinator";
import { executeCodingRunner, type CodingRunnerEnv, type CodingRunnerRequest, type CodingRuntime, type WorkersAiBinding } from "./codingRunner";
import { verifyIsolatedCausalVerificationAttestation, type VerifiedIsolatedCausalVerification } from "./sigstoreCausalAttestation";

const REPOSITORY = "cinamoncandy/NUSA";
const WORKFLOW_PATH = ".github/workflows/causal-verification.yml";
const WORKFLOW_NAME = "NUSA Isolated Causal Verification";
const ZERO_AUTHORITY = Object.freeze({ mutationAllowed: false as const, liveAuthority: "NONE" as const,
  productionMutationAllowed: false as const, aiAuthority: "ZERO_AUTHORITY" as const });

interface HarnessStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

class MemoryHarnessStorage implements HarnessStorage {
  private readonly records = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.records.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.records.set(key, value); }
}

function createHarnessCoordinator(): ExecutionCoordinatorNamespace {
  const storage = new MemoryHarnessStorage();
  const coordinator = new ExecutionCoordinator({ storage });
  const id = Object.freeze({});
  return {
    idFromName: () => id,
    get: () => ({ fetch: (input, init) => coordinator.fetch(new Request(input, init)) }),
  };
}

export interface IsolatedCausalVerificationRunInput {
  readonly bundle: unknown;
  readonly expected: { readonly sha: string; readonly runId: string; readonly runAttempt: string };
  readonly githubToken?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface IsolatedCausalVerificationRunResult {
  readonly domain: "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1";
  readonly decision: "CODE_ACTIONABLE";
  readonly classification: "REPOSITORY_CODE_REGRESSION";
  readonly sourceSha: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly durableReplayGuard: "GITHUB_CHECK_RUN_CLAIMED";
  readonly sourceCheckRunId: number;
  readonly codingRunnerStatus: "EXECUTION_ACCEPTED";
  readonly proposalAdapterCalls: 1;
  readonly sandboxExecutions: 1;
  readonly dedupe: "REPLAY_REJECTED_WITHIN_SINGLE_HARNESS";
  readonly mutationAllowed: false;
  readonly liveAuthority: "NONE";
  readonly productionMutationAllowed: false;
  readonly aiAuthority: "ZERO_AUTHORITY";
}

/**
 * Verifies an isolated Sigstore proof, then drives the existing CodingRunner and execution
 * coordinator with local deterministic adapters. The returned CODE_ACTIONABLE decision is
 * domain-separated from production admission; no external provider, publisher, repository-content
 * write, or production coordinator is used. The consumer separately claims a durable GitHub check
 * run before invoking this process-local execution harness.
 */
export async function runIsolatedCausalVerificationHarness(
  input: IsolatedCausalVerificationRunInput,
): Promise<IsolatedCausalVerificationRunResult> {
  const verified = await verifyIsolatedCausalVerificationAttestation(input.bundle, input.expected);
  return executeVerifiedIsolatedCausalVerification(verified, input);
}

/** Internal post-verification stage, exported for deterministic unit coverage only. */
export async function executeVerifiedIsolatedCausalVerification(
  verified: VerifiedIsolatedCausalVerification,
  input: Pick<IsolatedCausalVerificationRunInput, "githubToken" | "fetchImpl"> = {},
): Promise<IsolatedCausalVerificationRunResult> {
  const sourceRun = await verifyCompletedIsolatedSourceRun(verified, input.githubToken, input.fetchImpl ?? fetch);
  const decision = classifyIsolatedCausalVerification(verified);
  if (decision.sourceSha !== sourceRun.headSha || decision.sourceRunId !== String(sourceRun.id)
    || decision.sourceRunAttempt !== String(sourceRun.run_attempt)) throw new Error("ISOLATED_VERIFICATION_SOURCE_RUN_MISMATCH");

  const sourceCheckRunId = await claimDurableIsolatedReplayGuard(verified, input.githubToken, input.fetchImpl ?? fetch);

  try {
  const executionId = `isolated:${decision.sourceRunId}:${decision.sourceRunAttempt}:${decision.statementDigest}`;
  const dedupeKey = `isolated:${decision.sourceSha}:${decision.statementDigest}`;
  const coordinator = createHarnessCoordinator();
  const now = Date.now();
  const lease = await acquirePersistentExecution(coordinator, {
    dedupeKey, executionId, now, leaseExpiresAt: now + 5 * 60_000,
    taskId: "isolated-causal-verification", provider: "local-deterministic-adapter", headSha: decision.sourceSha,
    maxAcquisitions: 1,
  });
  if (!lease.acquired) throw new Error("ISOLATED_EXECUTION_LEASE_REJECTED");

  const request: CodingRunnerRequest = Object.freeze({
    kind: "REPOSITORY_AUTOPILOT",
    repository: REPOSITORY,
    headSha: decision.sourceSha,
    workflowRunId: Number(decision.sourceRunId),
    workflowRunAttempt: Number(decision.sourceRunAttempt),
    reason: `isolated-verification:${decision.statementDigest}`,
    executionId,
    dedupeKey,
    proposalContext: Object.freeze({
      path: "apps/autopilot/src/isolatedPositiveVerificationFixture.ts",
      startLine: 1,
      content: "const isolatedBefore = true;\nexport const isolatedVerificationValue = \"before\";\nconst isolatedAfter = true;\n",
    }),
    ...ZERO_AUTHORITY,
  });

  let proposalAdapterCalls = 0;
  let sandboxExecutions = 0;
  const ai: WorkersAiBinding = {
    async run() {
      proposalAdapterCalls += 1;
      return { response: JSON.stringify({ edit: {
        path: "apps/autopilot/src/isolatedPositiveVerificationFixture.ts",
        expectedText: "export const isolatedVerificationValue = \"before\";",
        replacementText: "export const isolatedVerificationValue = \"after\";",
      } }) };
    },
  };
  const runtime: CodingRuntime = {
    name: "isolated-noop-sandbox",
    async execute(received, proposal) {
      sandboxExecutions += 1;
      if (received.dedupeKey !== dedupeKey
        || typeof proposal?.patch !== "string"
        || !proposal.patch.includes("apps/autopilot/src/isolatedPositiveVerificationFixture.ts")) {
        throw new Error("ISOLATED_SANDBOX_INPUT_MISMATCH");
      }
      return {
        backend: "isolated-noop-sandbox",
        checkpointId: decision.statementDigest,
        workspaceVerified: true,
        proposalValidated: true,
        changedFiles: ["apps/autopilot/src/isolatedPositiveVerificationFixture.ts"],
      };
    },
  };
  const fetchImpl = ((resource: string | URL | Request, init?: RequestInit) =>
    (input.fetchImpl ?? fetch)(resource, init)) as typeof fetch;
  const env: CodingRunnerEnv = {
    NUSA_GITHUB_REPOSITORY: REPOSITORY,
    NUSA_GITHUB_TOKEN: input.githubToken,
    NUSA_AUTOPILOT_ZERO_CREDIT_MODE: "false",
    AI: ai,
  };

  await markPersistentExecutionDispatched(coordinator, { dedupeKey, executionId, now: Date.now() });
  const result = await executeCodingRunner(request, env, fetchImpl as never, runtime, undefined, {
    now: () => Date.now(),
    maxProposalAttempts: 1,
  });
  if (result.status !== "EXECUTION_ACCEPTED" || proposalAdapterCalls !== 1 || sandboxExecutions !== 1) {
    throw new Error(`ISOLATED_CODING_RUNNER_POSITIVE_E2E_FAILED:${result.status}:${result.reason ?? "none"}:${proposalAdapterCalls}:${sandboxExecutions}`);
  }
  await completePersistentExecution(coordinator, { dedupeKey, executionId, now: Date.now() });
  const replay = await acquirePersistentExecution(coordinator, {
    dedupeKey, executionId, now: Date.now(), leaseExpiresAt: Date.now() + 5 * 60_000,
    taskId: "isolated-causal-verification", provider: "local-deterministic-adapter", headSha: decision.sourceSha,
    maxAcquisitions: 1,
  });
  if (replay.acquired || replay.reason !== "ALREADY_COMPLETED" || proposalAdapterCalls !== 1 || sandboxExecutions !== 1) {
    throw new Error("ISOLATED_CODING_RUNNER_REPLAY_NOT_REJECTED");
  }

  await completeDurableIsolatedReplayGuard(sourceCheckRunId, "success", input.githubToken, input.fetchImpl ?? fetch);

  return Object.freeze({
    domain: decision.domain,
    decision: decision.decision,
    classification: decision.classification,
    sourceSha: decision.sourceSha,
    sourceRunId: decision.sourceRunId,
    sourceRunAttempt: decision.sourceRunAttempt,
    durableReplayGuard: "GITHUB_CHECK_RUN_CLAIMED",
    sourceCheckRunId,
    codingRunnerStatus: "EXECUTION_ACCEPTED",
    proposalAdapterCalls: 1,
    sandboxExecutions: 1,
    dedupe: "REPLAY_REJECTED_WITHIN_SINGLE_HARNESS",
    ...ZERO_AUTHORITY,
  });
  } catch (error) {
    await completeDurableIsolatedReplayGuard(sourceCheckRunId, "failure", input.githubToken, input.fetchImpl ?? fetch);
    throw error;
  }
}

const replayCheckName = (runId: string, runAttempt: string): string =>
  `NUSA Isolated Causal Replay Guard ${runId}.${runAttempt}`;

async function claimDurableIsolatedReplayGuard(
  verified: VerifiedIsolatedCausalVerification,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<number> {
  const authorization = token?.trim();
  if (!authorization) throw new Error("ISOLATED_REPLAY_GUARD_TOKEN_MISSING");
  const name = replayCheckName(verified.source.runId, verified.source.runAttempt);
  const headers = githubHeaders(authorization);
  const lookup = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/commits/${verified.source.sha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`, { headers });
  if (!lookup.ok) throw new Error("ISOLATED_REPLAY_GUARD_LOOKUP_FAILED");
  const lookupBody = await lookup.json() as { check_runs?: Array<{ name?: unknown }> };
  if (!Array.isArray(lookupBody.check_runs)) throw new Error("ISOLATED_REPLAY_GUARD_LOOKUP_INVALID");
  if (lookupBody.check_runs.some((check) => check.name === name)) throw new Error("ISOLATED_SOURCE_RUN_ALREADY_CLAIMED");

  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/check-runs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      head_sha: verified.source.sha,
      external_id: `nusa-isolated-causal:${verified.source.runId}:${verified.source.runAttempt}`,
      status: "in_progress",
      started_at: new Date().toISOString(),
      output: {
        title: "Isolated causal source event claimed",
        summary: "A durable, exact-source-run replay guard was claimed before the isolated CodingRunner exercise.",
      },
    }),
  });
  if (!response.ok) throw new Error("ISOLATED_REPLAY_GUARD_CLAIM_FAILED");
  const body = await response.json() as { id?: unknown };
  if (!Number.isSafeInteger(body.id) || Number(body.id) <= 0) throw new Error("ISOLATED_REPLAY_GUARD_CLAIM_INVALID");
  return Number(body.id);
}

async function completeDurableIsolatedReplayGuard(
  checkRunId: number,
  conclusion: "success" | "failure",
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<void> {
  const authorization = token?.trim();
  if (!authorization) throw new Error("ISOLATED_REPLAY_GUARD_TOKEN_MISSING");
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/check-runs/${checkRunId}`, {
    method: "PATCH",
    headers: { ...githubHeaders(authorization), "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: conclusion === "success" ? "Isolated causal replay guard completed" : "Isolated causal replay guard failed closed",
        summary: conclusion === "success"
          ? "The exact signed source run was processed once; subsequent attempts for this run and attempt will be rejected."
          : "The durable claim is retained; replay is blocked even though the bounded isolated execution did not complete successfully.",
      },
    }),
  });
  if (!response.ok) throw new Error("ISOLATED_REPLAY_GUARD_COMPLETION_FAILED");
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
  };
}

async function verifyCompletedIsolatedSourceRun(
  verified: VerifiedIsolatedCausalVerification,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ readonly id: number; readonly run_attempt: number; readonly headSha: string }> {
  const authorization = token?.trim();
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/actions/runs/${verified.source.runId}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
    },
  });
  if (!response.ok) throw new Error("ISOLATED_SOURCE_RUN_LOOKUP_FAILED");
  const run = await response.json() as Record<string, unknown>;
  const repository = run.repository as Record<string, unknown> | undefined;
  const workflow = run.path;
  if (run.id !== Number(verified.source.runId) || run.run_attempt !== Number(verified.source.runAttempt)
    || run.head_sha !== verified.source.sha || run.head_branch !== "main" || run.event !== "workflow_dispatch"
    || run.status !== "completed" || run.conclusion !== "success" || repository?.full_name !== REPOSITORY
    || workflow !== WORKFLOW_PATH || run.name !== WORKFLOW_NAME) throw new Error("ISOLATED_SOURCE_RUN_IDENTITY_INVALID");
  return Object.freeze({ id: Number(run.id), run_attempt: Number(run.run_attempt), headSha: String(run.head_sha) });
}
