import { classifyIsolatedCausalVerification } from "./causalRegressionAdmission";
import {
  completePersistentExecution,
  ExecutionCoordinator,
  markPersistentExecutionDispatched,
  acquirePersistentExecution,
  type ExecutionCoordinatorNamespace,
} from "./executionCoordinator";
import { executeCodingRunner, type CodingRunnerEnv, type CodingRunnerRequest, type CodingRuntime, type WorkersAiBinding } from "./codingRunner";
import type { VerifiedIsolatedCausalVerification } from "./sigstoreCausalAttestation";
import { verifyGithubIsolatedSourceRun, type VerifiedIsolatedSourceRun } from "./githubActionsOidc";

const REPOSITORY = "cinamoncandy/NUSA";
const WORKFLOW_PATH = ".github/workflows/causal-verification.yml";
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

interface VerifiedIsolatedCausalExecutionInput {
  readonly githubToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly verifiedSourceRun?: VerifiedIsolatedSourceRun;
  readonly claimAttempt: (verified: VerifiedIsolatedCausalVerification) => Promise<{ readonly claimed: boolean; readonly sourceIdentityDigest: string }>;
}

export interface IsolatedCausalVerificationRunResult {
  readonly domain: "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1";
  readonly decision: "CODE_ACTIONABLE";
  readonly classification: "REPOSITORY_CODE_REGRESSION";
  readonly sourceSha: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly durableReplayGuard: "SQLITE_DURABLE_OBJECT_CLAIMED";
  readonly sourceIdentityDigest: string;
  readonly codingRunnerStatus: "EXECUTION_ACCEPTED";
  readonly proposalAdapterCalls: 1;
  readonly sandboxExecutions: 1;
  readonly dedupe: "REPLAY_REJECTED_WITHIN_SINGLE_HARNESS";
  readonly mutationAllowed: false;
  readonly liveAuthority: "NONE";
  readonly productionMutationAllowed: false;
  readonly aiAuthority: "ZERO_AUTHORITY";
}

/** Internal post-verification stage, exported for deterministic unit coverage only. */
export async function executeVerifiedIsolatedCausalVerification(
  verified: VerifiedIsolatedCausalVerification,
  input: VerifiedIsolatedCausalExecutionInput,
): Promise<IsolatedCausalVerificationRunResult> {
  if (!input.githubToken.trim()) throw new Error("ISOLATED_SOURCE_RUN_TOKEN_REQUIRED");
  const sourceRun = input.verifiedSourceRun ?? await verifyGithubIsolatedSourceRun(
    verified.source.runId, verified.source.runAttempt, input.githubToken, input.fetchImpl as never,
  );
  const decision = classifyIsolatedCausalVerification(verified);
  if (decision.sourceSha !== sourceRun.sha || decision.sourceRunId !== sourceRun.runId
    || decision.sourceRunAttempt !== sourceRun.runAttempt || sourceRun.repository !== REPOSITORY
    || sourceRun.workflowPath !== WORKFLOW_PATH || sourceRun.branch !== "main"
    || sourceRun.event !== "workflow_dispatch" || sourceRun.conclusion !== "success") {
    throw new Error("ISOLATED_VERIFICATION_SOURCE_RUN_MISMATCH");
  }
  const claim = await input.claimAttempt(verified);
  if (!claim.claimed || !/^[a-f0-9]{64}$/.test(claim.sourceIdentityDigest)) {
    throw new Error("ISOLATED_SOURCE_RUN_ALREADY_CLAIMED");
  }
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
  const replayClaim = await input.claimAttempt(verified);
  if (replayClaim.claimed || replayClaim.sourceIdentityDigest !== claim.sourceIdentityDigest
    || proposalAdapterCalls !== 1 || sandboxExecutions !== 1) {
    throw new Error("ISOLATED_DURABLE_OBJECT_REPLAY_NOT_REJECTED");
  }

  return Object.freeze({
    domain: decision.domain,
    decision: decision.decision,
    classification: decision.classification,
    sourceSha: decision.sourceSha,
    sourceRunId: decision.sourceRunId,
    sourceRunAttempt: decision.sourceRunAttempt,
    durableReplayGuard: "SQLITE_DURABLE_OBJECT_CLAIMED",
    sourceIdentityDigest: claim.sourceIdentityDigest,
    codingRunnerStatus: "EXECUTION_ACCEPTED",
    proposalAdapterCalls: 1,
    sandboxExecutions: 1,
    dedupe: "REPLAY_REJECTED_WITHIN_SINGLE_HARNESS",
    ...ZERO_AUTHORITY,
  });
}
