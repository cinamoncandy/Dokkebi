import { executeGithubDispatch } from "./githubExecutor";
import { prepareDiscoveredCodingRequest } from "./evolveCodingBridge";
import { deriveWorkflowFailureOpportunities, type WorkflowFailureEvidence } from "./evolveEvidenceOpportunitySource";
import { deriveGithubIssueBacklogSignals } from "./evolveGithubIssueBacklog";
import type { EvolutionDiscoverySignal } from "./evolveOpportunityDiscovery";
import { isRepairableMainWorkflowFailure } from "./repairableWorkflowRun";
import { acquirePersistentExecution, admitActiveWip, createEvolutionLearningMemoryStorage, readPersistentExecution, readProviderCapacityWait, releaseActiveWip, releasePersistentExecution, type ExecutionCoordinatorNamespace } from "./executionCoordinator";
import { DurableEvolutionLearningMemory } from "./evolveDurableLearningMemory";

const CODING_PROVIDER = "workers-ai";

export interface ScheduledEvolutionCodingEnv {
  readonly NUSA_GITHUB_TOKEN?: string;
  readonly NUSA_EXECUTION_COORDINATOR?: ExecutionCoordinatorNamespace;
}

export interface ScheduledEvolutionCodingResult {
  readonly status: "ABSTAINED" | "WAITING_RATE_LIMIT" | "DUPLICATE_SUPPRESSED" | "INTERFACE_READY" | "EXECUTION_ACCEPTED" | "EXECUTION_FAILED";
  readonly reason: string;
  readonly selectedSignalIds: readonly string[];
  readonly liveAuthority: "NONE";
  readonly productionMutationAllowed: false;
  readonly aiAuthority: "ZERO_AUTHORITY";
}

const SHA40 = /^[0-9a-f]{40}$/i;
const MAX_SOURCE_AGE_SECONDS = 24 * 60 * 60;
const DISCOVERY_MAX_AGE_MS = 60 * 60 * 1000;
const DISCOVERY_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const CODING_LEASE_MS = 5 * 60 * 1000;
/**
 * Fresh dispatches of one logical work item on one main SHA. The consumer releases a failed attempt,
 * so without this ceiling the scheduler re-dispatched the same unfixable failure about every five
 * minutes until main moved (2026-10-12). A new main SHA is a new identity and starts again.
 */
export const MAX_SCHEDULED_CODING_ATTEMPTS = 3;
const AUTHORITY = Object.freeze({ liveAuthority: "NONE" as const, productionMutationAllowed: false as const, aiAuthority: "ZERO_AUTHORITY" as const });

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const positiveInteger = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;

async function signalSnapshotDigest(signal: EvolutionDiscoverySignal, mainSha: string, sourceIssue?: unknown): Promise<string> {
  const issue = object(sourceIssue);
  const labels = Array.isArray(issue?.labels)
    ? issue.labels.flatMap((label) => {
      if (typeof label === "string") return [label.toLowerCase()];
      const item = object(label);
      const name = text(item?.name);
      return name ? [name.toLowerCase()] : [];
    }).sort()
    : [];
  const snapshot = JSON.stringify({
    schemaVersion: 1,
    protectedMainSha: mainSha.toLowerCase(),
    id: signal.id,
    source: signal.source,
    reference: signal.reference,
    problem: signal.problem,
    observedAt: signal.observedAt,
    evidenceQuality: signal.evidenceQuality,
    impact: signal.impact,
    confidence: signal.confidence,
    risk: signal.risk,
    reversibility: signal.reversibility,
    canonicalOwner: signal.canonicalOwner ?? null,
    conflictKeys: [...(signal.conflictKeys ?? [])],
    sourceIssue: issue ? {
      number: Number(issue.number),
      title: text(issue.title),
      body: text(issue.body) ?? "",
      state: text(issue.state)?.toLowerCase() ?? null,
      authorAssociation: text(issue.author_association)?.toUpperCase() ?? null,
      updatedAt: text(issue.updated_at),
      labels,
    } : null,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function result(status: ScheduledEvolutionCodingResult["status"], reason: string, selectedSignalIds: readonly string[] = []): ScheduledEvolutionCodingResult {
  return Object.freeze({ status, reason, selectedSignalIds: Object.freeze([...selectedSignalIds]), ...AUTHORITY });
}

function workflowCompletedAt(run: JsonObject): string | null {
  const completedAt = text(run.completed_at);
  if (completedAt && Number.isFinite(Date.parse(completedAt))) return completedAt;
  if (text(run.status) !== "completed") return null;
  const updatedAt = text(run.updated_at);
  return updatedAt && Number.isFinite(Date.parse(updatedAt)) ? updatedAt : null;
}

function evidenceFromRuns(candidates: readonly unknown[]): readonly WorkflowFailureEvidence[] {
  const evidence: WorkflowFailureEvidence[] = [];
  for (const candidate of candidates.slice(0, 50)) {
    const run = object(candidate);
    if (!run) continue;
    const conclusion = text(run.conclusion);
    if (conclusion !== "failure" && conclusion !== "timed_out") continue;
    if (!isRepairableMainWorkflowFailure(run)) continue;
    const workflowName = text(run.name);
    const runId = positiveInteger(run.id);
    const headSha = text(run.head_sha);
    const completedAt = workflowCompletedAt(run);
    if (!workflowName || !runId || !headSha || !SHA40.test(headSha) || !completedAt) continue;
    evidence.push(Object.freeze({ workflowName, runId, headSha: headSha.toLowerCase(), conclusion, completedAt }));
  }
  return Object.freeze(evidence);
}

function signalsFromRuns(candidates: readonly unknown[], now: number): readonly EvolutionDiscoverySignal[] {
  const opportunities = deriveWorkflowFailureOpportunities({
    observations: evidenceFromRuns(candidates),
    observedAt: new Date(now).toISOString(),
    maxAgeSeconds: MAX_SOURCE_AGE_SECONDS,
  });
  return Object.freeze(opportunities.map((opportunity) => Object.freeze({
    id: opportunity.id,
    source: opportunity.source,
    reference: opportunity.evidence[0]?.reference ?? "",
    problem: opportunity.problem,
    observedAt: opportunity.createdAt,
    evidenceQuality: opportunity.evidence[0]?.quality ?? 0,
    impact: opportunity.impact,
    confidence: opportunity.confidence,
    risk: opportunity.risk,
    reversibility: opportunity.reversibility,
  })));
}

function freshDiscoverySignals(signals: readonly EvolutionDiscoverySignal[], now: number): readonly EvolutionDiscoverySignal[] {
  return Object.freeze(signals.filter((signal) => {
    const observedAt = Date.parse(signal.observedAt);
    if (!Number.isFinite(observedAt)) return false;
    const age = now - observedAt;
    return age <= DISCOVERY_MAX_AGE_MS && age >= -DISCOVERY_MAX_FUTURE_SKEW_MS;
  }));
}

function logicalWorkIdentity(signals: readonly EvolutionDiscoverySignal[]): string {
  const selected = signals[0]?.id ?? "no-signal";
  return selected.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 180) || "no-signal";
}

function backlogIssueNumber(signal: EvolutionDiscoverySignal | undefined): number | null {
  if (signal?.source !== "github-issue-backlog") return null;
  const match = signal.id.match(/^github-issue-([1-9][0-9]*)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function revalidateBacklogSignal(
  signal: EvolutionDiscoverySignal | undefined,
  input: { readonly repository: string; readonly openPulls?: readonly unknown[]; readonly now: number },
  token: string,
  fetchImpl: typeof fetch,
  expectedSnapshotDigest?: string,
  mainSha?: string,
): Promise<"ACTIONABLE" | "STALE" | "SNAPSHOT_MISMATCH" | "UNAVAILABLE"> {
  const issueNumber = backlogIssueNumber(signal);
  if (issueNumber === null) return signal?.source === "github-issue-backlog" ? "STALE" : "ACTIONABLE";
  // Issue state and open-PR evidence are independent reads. Fetch them in
  // parallel so a scheduled cycle does not pay two GitHub round trips before
  // it can decide whether the signal is still actionable.
  const issueUrl = `https://api.github.com/repos/${input.repository}/issues/${issueNumber}`;
  const query = new URLSearchParams({ q: `repo:${input.repository} is:pr ${issueNumber}`, per_page: "100", page: "1" });
  const pullsUrl = `https://api.github.com/search/issues?${query.toString()}`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "nusa-autopilot-worker",
    "x-github-api-version": "2022-11-28",
  };
  let responses: readonly [Response, Response];
  try {
    responses = await Promise.all([
      fetchImpl(issueUrl, { headers }),
      fetchImpl(pullsUrl, { headers }),
    ]) as [Response, Response];
  } catch {
    return "UNAVAILABLE";
  }
  const [response, pullsResponse] = responses;
  if (!response.ok) return "UNAVAILABLE";
  let issue: unknown;
  let pullsPayload: unknown;
  try {
    issue = await response.json();
  } catch {
    return "UNAVAILABLE";
  }
  const issueRecord = object(issue);
  if (!issueRecord || text(issueRecord.state)?.toLowerCase() !== "open") return "STALE";
  if (!pullsResponse.ok) return "UNAVAILABLE";
  try {
    pullsPayload = await pullsResponse.json();
  } catch {
    return "UNAVAILABLE";
  }
  const pullsBody = object(pullsPayload);
  const items = pullsBody?.items;
  const totalCount = pullsBody?.total_count;
  if (!Array.isArray(items) || !Number.isSafeInteger(totalCount) || Number(totalCount) < 0 || Number(totalCount) > items.length) return "UNAVAILABLE";

  const issueUpdatedAt = text(issueRecord.updated_at);
  const issueUpdatedAtMs = issueUpdatedAt ? Date.parse(issueUpdatedAt) : Number.NaN;
  if (!Number.isFinite(issueUpdatedAtMs)) return "UNAVAILABLE";
  const completedCurrentIncrement = items.some((value) => {
    const pull = object(value);
    const pullRequest = object(pull?.pull_request);
    const mergedAt = text(pullRequest?.merged_at);
    if (!pull || !mergedAt) return false;
    const mergedAtMs = Date.parse(mergedAt);
    if (!Number.isFinite(mergedAtMs) || mergedAtMs < issueUpdatedAtMs) return false;
    const haystack = `${text(pull.title) ?? ""}\n${text(pull.body) ?? ""}`;
    return haystack.includes(`#${issueNumber}`);
  });
  if (completedCurrentIncrement) return "STALE";

  const openPulls = items.filter((value) => {
    const pull = object(value);
    return text(pull?.state)?.toLowerCase() === "open";
  });
  const current = deriveGithubIssueBacklogSignals([issue], openPulls, new Date(input.now));
  const selected = current.find((candidate) => candidate.id === signal?.id);
  if (!selected) return "STALE";
  if (expectedSnapshotDigest) {
    if (!mainSha) return "UNAVAILABLE";
    const freshDigest = await signalSnapshotDigest(selected, mainSha, issueRecord);
    if (freshDigest !== expectedSnapshotDigest) return "SNAPSHOT_MISMATCH";
  }
  return "ACTIONABLE";
}

/**
 * Existing #903/#905 composition: read-only repository evidence -> existing
 * discovery/selector -> existing CodingRunner dispatch spine. Fresh workflow
 * failures keep priority. When main is healthy, one proven-ready canonical issue
 * may flow into the same selector. No second queue/scheduler/orchestrator exists.
 */
export async function runScheduledEvolutionCoding(
  env: ScheduledEvolutionCodingEnv,
  input: {
    readonly candidates: readonly unknown[];
    readonly backlogIssues?: readonly unknown[];
    readonly openPulls?: readonly unknown[];
    readonly now: number;
    readonly repository: string;
    readonly mainSha: string;
    readonly workflowRunId: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ScheduledEvolutionCodingResult> {
  const token = env.NUSA_GITHUB_TOKEN?.trim();
  if (!token) return result("ABSTAINED", "github-token-not-configured");
  const coordinator = env.NUSA_EXECUTION_COORDINATOR;
  if (!coordinator) return result("ABSTAINED", "persistent-execution-coordinator-required");
  if (!Number.isSafeInteger(input.now) || input.now < 0 || !SHA40.test(input.mainSha) || !Number.isSafeInteger(input.workflowRunId) || input.workflowRunId <= 0) {
    return result("ABSTAINED", "scheduled-coding-input-invalid");
  }

  const failureSignals = freshDiscoverySignals(signalsFromRuns(input.candidates, input.now), input.now);
  const backlogSignals = failureSignals.length === 0
    ? deriveGithubIssueBacklogSignals(input.backlogIssues ?? [], input.openPulls ?? [], new Date(input.now))
    : Object.freeze([] as EvolutionDiscoverySignal[]);
  const signals = failureSignals.length > 0 ? failureSignals : backlogSignals;
  const freshFailureCount = failureSignals.length;
  const workIdentity = logicalWorkIdentity(signals);
  const selectedSignal = signals[0];
  let boundTaskSnapshotDigest: string | null = null;
  if (selectedSignal?.source === "github-issue-backlog") {
    const issueNumber = backlogIssueNumber(selectedSignal);
    const sourceIssue = input.backlogIssues?.find((value) => Number(object(value)?.number) === issueNumber);
    if (!sourceIssue || !selectedSignal.canonicalOwner || !selectedSignal.conflictKeys?.length) {
      return result("ABSTAINED", "github-issue-snapshot-source-unavailable", signals.map((signal) => signal.id));
    }
    try {
      boundTaskSnapshotDigest = await signalSnapshotDigest(selectedSignal, input.mainSha, sourceIssue);
    } catch {
      return result("ABSTAINED", "github-issue-snapshot-digest-unavailable", signals.map((signal) => signal.id));
    }
    const freshness = await revalidateBacklogSignal(selectedSignal, input, token, fetchImpl, boundTaskSnapshotDigest, input.mainSha);
    if (freshness === "UNAVAILABLE") return result("ABSTAINED", "github-issue-actionability-revalidation-unavailable", signals.map((signal) => signal.id));
    if (freshness === "STALE") return result("ABSTAINED", "github-issue-no-longer-actionable", signals.map((signal) => signal.id));
    if (freshness === "SNAPSHOT_MISMATCH") return result("ABSTAINED", "github-issue-snapshot-changed", signals.map((signal) => signal.id));
    if (freshness !== "ACTIONABLE") return result("ABSTAINED", "github-issue-actionability-revalidation-unavailable", signals.map((signal) => signal.id));
  }
  const executionId = `evolve-coding:${input.mainSha.slice(0, 16)}:${workIdentity.slice(0, 100)}`;
  const dedupeKey = `evolve-coding:${input.mainSha}:${workIdentity}`;
  // The execution record below is keyed by the exact main SHA, so it is empty again whenever main
  // moves. The provider wait is not: while the coding provider is inside its retry window, no new
  // execution is started for any main, and the next dispatch after the window is the bounded probe.
  let providerWait;
  try {
    providerWait = await readProviderCapacityWait(coordinator, CODING_PROVIDER);
  } catch {
    return result("ABSTAINED", "provider-capacity-state-unavailable", signals.map((signal) => signal.id));
  }
  if (providerWait && input.now < providerWait.nextRetryAt) return result("WAITING_RATE_LIMIT", "waiting-provider-capacity", signals.map((signal) => signal.id));
  let currentExecution;
  try {
    currentExecution = await readPersistentExecution(coordinator, dedupeKey);
  } catch {
    return result("ABSTAINED", "persistent-execution-state-unavailable", signals.map((signal) => signal.id));
  }
  if (currentExecution?.state === "BLOCKED") return result("EXECUTION_FAILED", "persistent-execution-blocked", signals.map((signal) => signal.id));
  if (currentExecution?.state === "WAITING_RATE_LIMIT") {
    const stop = currentExecution.stop;
    if (!stop || stop.executionId !== executionId || stop.dedupeKey !== dedupeKey) return result("ABSTAINED", "persistent-rate-limit-stop-corrupt", signals.map((signal) => signal.id));
    if (input.now < stop.nextRetryAt) return result("WAITING_RATE_LIMIT", "waiting-rate-limit", signals.map((signal) => signal.id));
  }
  const activeExecutions = currentExecution
    && (currentExecution.state === "LEASED" || currentExecution.state === "HANDED_OFF")
    && currentExecution.leaseExpiresAt > input.now
    ? 1
    : 0;
  const elapsedSecondsSinceLastRun = currentExecution
    ? Math.max(0, Math.floor((input.now - currentExecution.updatedAt) / 1000))
    : Number.MAX_SAFE_INTEGER;
  let learningMemory: DurableEvolutionLearningMemory;
  try {
    learningMemory = await DurableEvolutionLearningMemory.hydrate(createEvolutionLearningMemoryStorage(coordinator));
  } catch {
    return result("ABSTAINED", "learning-memory-state-unavailable", signals.map((signal) => signal.id));
  }

  const bridge = prepareDiscoveredCodingRequest({
    signals,
    now: new Date(input.now),
    repository: input.repository,
    headSha: input.mainSha,
    workflowRunId: input.workflowRunId,
    executionId,
    dedupeKey,
    circuit: freshFailureCount >= 3
      ? { state: "OPEN", consecutiveFailures: freshFailureCount, openedAt: new Date(input.now).toISOString() }
      : { state: "CLOSED", consecutiveFailures: freshFailureCount },
    schedulePolicy: { mode: "AUTONOMOUS", minIntervalSeconds: 60, maxConcurrent: 1 },
    activeExecutions,
    elapsedSecondsSinceLastRun,
    learningRecords: learningMemory.list(),
  });
  if (bridge.status !== "READY" || !bridge.request) return result("ABSTAINED", bridge.reason);

  // A failed workflow identifies a candidate for investigation, not its cause.
  // Until a source-bound, server-verified causal receipt is available, do not
  // acquire a lease or dispatch coding for workflow-failure evidence. Backlog
  // issue admission continues through its existing independent checks.
  if (bridge.request.kind === "REPOSITORY_AUTOPILOT" && failureSignals.length > 0) {
    return result("ABSTAINED", "workflow-failure-causal-evidence-unverified", signals.map((signal) => signal.id));
  }

  if (selectedSignal?.source === "github-issue-backlog") {
    if (!selectedSignal.canonicalOwner || !selectedSignal.conflictKeys?.length) {
      return result("ABSTAINED", "github-issue-work-metadata-required", signals.map((signal) => signal.id));
    }
    if (!boundTaskSnapshotDigest) return result("ABSTAINED", "github-issue-snapshot-digest-unavailable", signals.map((signal) => signal.id));
    let activeWip;
    try {
      activeWip = await admitActiveWip(coordinator, {
        dedupeKey: bridge.request.dedupeKey,
        executionId: bridge.request.executionId,
        taskId: /^github-issue-[1-9][0-9]*$/.test(selectedSignal.id)
          ? `issue-${selectedSignal.id.slice("github-issue-".length)}`
          : selectedSignal.id,
        protectedMainSha: input.mainSha.toLowerCase(),
        taskSnapshotDigest: boundTaskSnapshotDigest,
        leaseOwnerIdentity: `evolve-scheduled:${input.workflowRunId}`,
        canonicalOwner: selectedSignal.canonicalOwner,
        conflictKeys: selectedSignal.conflictKeys,
        claimedAt: input.now,
        maxConcurrent: 1,
      });
    } catch {
      return result("ABSTAINED", "active-wip-admission-unavailable", signals.map((signal) => signal.id));
    }
    if (!activeWip.admitted) {
      return result("DUPLICATE_SUPPRESSED", activeWip.reason ?? "ACTIVE_WIP_REJECTED", signals.map((signal) => signal.id));
    }
  }

  let persistent;
  try {
    persistent = await acquirePersistentExecution(coordinator, {
      dedupeKey: bridge.request.dedupeKey,
      executionId: bridge.request.executionId,
      headSha: input.mainSha.toLowerCase(),
      now: input.now,
      leaseExpiresAt: input.now + CODING_LEASE_MS,
      maxAcquisitions: MAX_SCHEDULED_CODING_ATTEMPTS,
    });
  } catch {
    if (selectedSignal?.source === "github-issue-backlog") {
      let cleanupFailed = false;
      try {
        // The coordinator may have committed before its response was lost. Release both exact
        // identities idempotently so the active-WIP slot cannot outlive failed admission.
        await releasePersistentExecution(coordinator, { dedupeKey: bridge.request.dedupeKey, executionId: bridge.request.executionId, now: input.now });
      } catch {
        cleanupFailed = true;
      }
      try {
        await releaseActiveWip(coordinator, { dedupeKey: bridge.request.dedupeKey, executionId: bridge.request.executionId });
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        return result("ABSTAINED", "persistent-execution-admission-cleanup-unavailable", signals.map((signal) => signal.id));
      }
    }
    return result("ABSTAINED", "persistent-execution-admission-unavailable", signals.map((signal) => signal.id));
  }
  if (!persistent.acquired) {
    if (selectedSignal?.source === "github-issue-backlog") {
      try {
        await releaseActiveWip(coordinator, { dedupeKey: bridge.request.dedupeKey, executionId: bridge.request.executionId });
      } catch {
        return result("ABSTAINED", "active-wip-admission-cleanup-unavailable", signals.map((signal) => signal.id));
      }
    }
    if (persistent.reason === "WAITING_RATE_LIMIT") return result("WAITING_RATE_LIMIT", "waiting-rate-limit", signals.map((signal) => signal.id));
    return result("DUPLICATE_SUPPRESSED", persistent.reason ?? "DUPLICATE_EXECUTION", signals.map((signal) => signal.id));
  }

  if (selectedSignal?.source === "github-issue-backlog") {
    if (!boundTaskSnapshotDigest) return result("ABSTAINED", "github-issue-snapshot-digest-unavailable", signals.map((signal) => signal.id));
    const freshness = await revalidateBacklogSignal(selectedSignal, input, token, fetchImpl, boundTaskSnapshotDigest, input.mainSha);
    if (freshness !== "ACTIONABLE") {
      try {
        await releasePersistentExecution(coordinator, { dedupeKey: bridge.request.dedupeKey, executionId: bridge.request.executionId, now: input.now });
        await releaseActiveWip(coordinator, { dedupeKey: bridge.request.dedupeKey, executionId: bridge.request.executionId });
      } catch {
        return result("ABSTAINED", "github-issue-stale-cleanup-unavailable", signals.map((signal) => signal.id));
      }
      const reason = freshness === "UNAVAILABLE"
        ? "github-issue-pre-dispatch-revalidation-unavailable"
        : freshness === "SNAPSHOT_MISMATCH"
          ? "github-issue-pre-dispatch-snapshot-stale"
          : "github-issue-pre-dispatch-not-actionable";
      return result("ABSTAINED", reason, signals.map((signal) => signal.id));
    }
  }

  const dispatched = await executeGithubDispatch(bridge.request, { token, allowedRepository: input.repository }, fetchImpl);
  if (dispatched.status === "DISPATCHED") {
    return result("EXECUTION_ACCEPTED", "github-coding-dispatch-accepted", signals.map((signal) => signal.id));
  }
  if (dispatched.status === "INTERFACE_READY") return result("INTERFACE_READY", dispatched.reason, signals.map((signal) => signal.id));
  return result("EXECUTION_FAILED", dispatched.reason, signals.map((signal) => signal.id));
}
