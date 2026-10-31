import type { AutopilotDispatchPlan } from "./dispatchPlanner";

export type ExecutionRequestKind = "NOOP" | "REPOSITORY_AUTOPILOT" | "CI_RECOVERY" | "AUDIT_REQUEST";

export interface AutopilotExecutionRequest {
  readonly kind: ExecutionRequestKind;
  readonly repository: string | null;
  readonly headSha: string | null;
  readonly prNumber?: number | null;
  readonly workflowRunId: number | null;
  readonly workflowRunAttempt?: number | null;
  readonly reason: string;
  readonly executionId?: string | null;
  readonly dedupeKey?: string | null;
  readonly contractFingerprintSha256?: string | null;
  /** One-time internal transport capability; never itself represents causal evidence. */
  readonly causalDispatchCapability?: string | null;
  readonly causalSourceRunAttempt?: number | null;
  readonly mutationAllowed: false;
}

const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);
const SHA40 = /^[0-9a-f]{40}$/i;

function failureConclusion(reason: string): "failure" | "cancelled" | "timed_out" {
  if (reason.endsWith(":cancelled")) return "cancelled";
  if (reason.endsWith(":timed_out")) return "timed_out";
  return "failure";
}

export function planAutopilotExecution(dispatch: AutopilotDispatchPlan): AutopilotExecutionRequest {
  if (dispatch.kind === "PR_CI_SUCCEEDED") {
    const workflowRunId = dispatch.workflowRunId;
    const headSha = dispatch.headSha;
    const prNumber = dispatch.prNumber;
    // A re-run reuses workflowRunId, so attempt is part of the execution's identity. Without it a
    // retry of a CI run whose Audit reached no verdict (release job failed, cancelled, or was
    // serialized behind an unrelated blocker) collides with the first attempt's dedupe key and is
    // suppressed as a duplicate -- the head is then starved of an Audit for good.
    const workflowRunAttempt = dispatch.workflowRunAttempt ?? 1;
    if (!workflowRunId || !headSha || !SHA40.test(headSha) || !prNumber || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
      return freeze({
        kind: "NOOP",
        repository: dispatch.repository,
        headSha,
        prNumber,
        workflowRunId,
        workflowRunAttempt,
        reason: "pr-ci-success-missing-bounded-identity",
        mutationAllowed: false,
      });
    }
    const normalizedHead = headSha.toLowerCase();
    // Keep attempt 1 byte-identical to the already-deployed identity so a replay that crosses
    // the deployment boundary cannot evade an existing persistent dedupe record. Only re-runs
    // (attempt > 1) extend the identity.
    const attemptSuffix = workflowRunAttempt > 1 ? `:${workflowRunAttempt}` : "";
    return freeze({
      kind: "AUDIT_REQUEST",
      repository: dispatch.repository,
      headSha: normalizedHead,
      prNumber,
      workflowRunId,
      workflowRunAttempt,
      reason: `audit:pr:${prNumber}:ci:${workflowRunId}:${normalizedHead}`,
      executionId: `audit:${prNumber}:${workflowRunId}${attemptSuffix}`,
      dedupeKey: `audit:${prNumber}:${workflowRunId}${attemptSuffix}:${normalizedHead}`,
      mutationAllowed: false,
    });
  }

  if (dispatch.kind === "CI_FAILED") {
    const workflowRunId = dispatch.workflowRunId;
    const headSha = dispatch.headSha;
    const workflowRunAttempt = dispatch.workflowRunAttempt ?? 1;
    if (!workflowRunId || !headSha || !SHA40.test(headSha)) {
      return freeze({
        kind: "NOOP",
        repository: dispatch.repository,
        headSha,
        prNumber: dispatch.prNumber,
        workflowRunId,
        workflowRunAttempt,
        reason: "ci-failure-missing-bounded-identity",
        mutationAllowed: false,
      });
    }

    const conclusion = failureConclusion(dispatch.reason);
    return freeze({
      kind: "REPOSITORY_AUTOPILOT",
      repository: dispatch.repository,
      headSha,
      prNumber: dispatch.prNumber,
      workflowRunId,
      workflowRunAttempt,
      reason: `gha:${workflowRunId}:${headSha.toLowerCase()}:${conclusion}`,
      executionId: `ci-failure:${workflowRunId}`,
      dedupeKey: `ci-failure:${workflowRunId}:${headSha.toLowerCase()}`,
      mutationAllowed: false,
    });
  }

  if (dispatch.kind === "MAIN_PUSH" || dispatch.kind === "CI_SUCCEEDED" || dispatch.kind === "PR_CHANGED") {
    return freeze({
      kind: "REPOSITORY_AUTOPILOT",
      repository: dispatch.repository,
      headSha: dispatch.headSha,
      prNumber: dispatch.prNumber,
      workflowRunId: dispatch.workflowRunId,
      workflowRunAttempt: dispatch.workflowRunAttempt,
      reason: `continue-from:${dispatch.kind.toLowerCase()}`,
      mutationAllowed: false,
    });
  }

  return freeze({
    kind: "NOOP",
    repository: dispatch.repository,
    headSha: dispatch.headSha,
    prNumber: dispatch.prNumber,
    workflowRunId: dispatch.workflowRunId,
    workflowRunAttempt: dispatch.workflowRunAttempt,
    reason: dispatch.reason,
    mutationAllowed: false,
  });
}
