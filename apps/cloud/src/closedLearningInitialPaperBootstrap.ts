import type { ResearchRunReplaySnapshotReader } from "../../desktop/src/cloud/researchRunReplaySnapshotStore";
import type { ClosedLearningResearchDecisionHistory } from "./closedLearningResearchDecisionHistory";
import type { ClosedLearningResearchReplayResult, ClosedLearningResearchWorkerClient } from "./closedLearningResearchWorkerClient";
import type { QualifiedPaperChallengerArtifactWriter } from "./qualifiedPaperChallengerArtifactStore";
import { isGovernanceApprovalUnavailable, type PaperChallengerDeploymentAdapter, type ClosedLearningPaperDeploymentReceipt } from "./closedLearningLoopCoordinator";
import type { PersistedPaperPeriodEnvelope } from "../../../packages/contracts/src/persistedPaperPeriod";
import type { PersistedPaperRealizedPeriodPlan } from "./paperRealizedPeriodProducer";
import { isOwnerBaselinePeriodInput } from "./ownerBaselinePaperPeriod";

const STALE_SNAPSHOT_MESSAGE = "research replay snapshot provenance drift";

/**
 * The latest Research snapshot no longer reproduces its original run under the current release
 * (captured by an older Research/League version). It can never be deployed, so it is a wait for the
 * next Research run, not a fault. Throwing would stop the whole PAPER runtime on every restart.
 */
export function isResearchSnapshotStale(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === STALE_SNAPSHOT_MESSAGE || error.message.endsWith(`: ${STALE_SNAPSHOT_MESSAGE}`);
}

export type ClosedLearningInitialPaperBootstrapStatus =
  | "WAITING_RESEARCH_SNAPSHOT"
  | "EXISTING_PAPER_STATE"
  | "RESEARCH_NOT_DEPLOYABLE"
  | "WAITING_GOVERNANCE_APPROVAL"
  | "DEPLOYED";

export interface ClosedLearningInitialPaperBootstrapResult {
  readonly status: ClosedLearningInitialPaperBootstrapStatus;
  readonly originalRunFingerprintSha256?: string;
  readonly reasons?: readonly string[];
  /** Counts only, for a RESEARCH_NOT_DEPLOYABLE result: how many candidates were judged and why they were not qualified. */
  readonly qualificationSummary?: ClosedLearningQualificationSummary;
  readonly deployment?: ClosedLearningPaperDeploymentReceipt;
}

export interface ClosedLearningQualificationSummary {
  readonly candidateCount: number;
  readonly qualifiedCount: number;
  readonly insufficientCount: number;
  readonly rejectedCount: number;
  /** Fixed upper-case reason code -> number of candidates carrying it (at most eight codes, highest count first). */
  readonly reasonCounts: Readonly<Record<string, number>>;
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

export function summarizeQualification(qualification: ClosedLearningResearchReplayResult["qualification"]): ClosedLearningQualificationSummary {
  const counts = new Map<string, number>();
  for (const candidate of qualification.candidates) {
    if (candidate.outcome === "QUALIFIED_FOR_LEAGUE") continue;
    for (const reason of new Set(candidate.reasons)) if (typeof reason === "string" && REASON_CODE.test(reason)) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  return Object.freeze({
    candidateCount: qualification.coverage.candidateCount,
    qualifiedCount: qualification.coverage.qualifiedCount,
    insufficientCount: qualification.coverage.insufficientCount,
    rejectedCount: qualification.coverage.rejectedCount,
    reasonCounts: Object.freeze(Object.fromEntries(top)),
  });
}

export interface ClosedLearningInitialPaperBootstrapOptions {
  readonly snapshots: ResearchRunReplaySnapshotReader;
  readonly worker: Pick<ClosedLearningResearchWorkerClient, "replayInitialResearch"> & Partial<Pick<ClosedLearningResearchWorkerClient, "replayInitialResearchAsync">>;
  readonly history: Pick<ClosedLearningResearchDecisionHistory, "persist">;
  readonly artifacts: QualifiedPaperChallengerArtifactWriter;
  readonly deployment: PaperChallengerDeploymentAdapter;
  readonly listOpenPeriods: () => readonly PersistedPaperRealizedPeriodPlan[];
  readonly listRealizedPeriods: () => readonly PersistedPaperPeriodEnvelope[];
  readonly now?: () => number;
}

function bootstrapDecision(result: ClosedLearningResearchReplayResult): Parameters<PaperChallengerDeploymentAdapter["deploy"]>[0]["decision"] {
  if (result.deployment.status !== "DEPLOYABLE") throw new Error("initial PAPER bootstrap deployment artifact is unavailable");
  const artifact = result.deployment.artifact;
  const qualified = result.qualification.candidates.filter((candidate) => candidate.candidateId === artifact.candidateId && candidate.outcome === "QUALIFIED_FOR_LEAGUE");
  if (qualified.length !== 1) throw new Error("initial PAPER bootstrap candidate qualification is ambiguous");
  return Object.freeze({
    decisionId: `initial-research:${result.replayRunFingerprintSha256}:${artifact.candidateId}`,
    outcome: "QUALIFIED_FOR_LEAGUE" as const,
    candidateId: artifact.candidateId,
    candidateVersion: artifact.candidateVersion,
    decisionReference: artifact.researchDecisionReference,
    reasons: Object.freeze([...result.deployment.reasons]),
  });
}

/**
 * Fail-closed first-PAPER bootstrap. It is only eligible before any PAPER period exists. The exact
 * latest immutable Research snapshot is replayed without synthetic PAPER evidence through the
 * same isolated canonical Research/League worker used by closed learning. The complete Research
 * denominator is persisted before an immutable artifact can become visible, then the existing
 * PAPER-only deployment adapter owns binding activation and canonical period open.
 *
 * Replay after a crash is safe: history/artifact writes are immutable/idempotent and deployment is
 * already deterministic for an identical binding/period boundary.
 */
export class ClosedLearningInitialPaperBootstrap {
  private readonly now: () => number;
  private lastSuccessfulAttempt?: Readonly<{
    fingerprint: string;
    result: ClosedLearningInitialPaperBootstrapResult;
  }>;

  public constructor(private readonly options: ClosedLearningInitialPaperBootstrapOptions) {
    this.now = options.now ?? Date.now;
  }

  private hasBlockingPaperState(): boolean {
    const openPeriods = this.options.listOpenPeriods();
    // The owner baseline is deliberately temporary. A newly refreshed, replayable Research
    // challenger must still be evaluated while that fallback period is open; deployment owns the
    // canonical baseline retirement before opening the challenger period. Every other PAPER state
    // remains protected from bootstrap replacement.
    if (openPeriods.length === 1 && isOwnerBaselinePeriodInput(openPeriods[0]!)) return false;
    return openPeriods.length > 0 || this.options.listRealizedPeriods().length > 0;
  }

  private eligibleFingerprint(): { readonly early?: ClosedLearningInitialPaperBootstrapResult; readonly fingerprint?: string } {
    if (this.hasBlockingPaperState()) return Object.freeze({ early: Object.freeze({ status: "EXISTING_PAPER_STATE" }) });
    const snapshot = this.options.snapshots.latest();
    if (snapshot == null) return Object.freeze({ early: Object.freeze({ status: "WAITING_RESEARCH_SNAPSHOT" }) });
    return Object.freeze({ fingerprint: snapshot.originalRunFingerprintSha256 });
  }

  private async eligibleFingerprintAsync(): Promise<{ readonly early?: ClosedLearningInitialPaperBootstrapResult; readonly fingerprint?: string }> {
    if (this.hasBlockingPaperState()) return Object.freeze({ early: Object.freeze({ status: "EXISTING_PAPER_STATE" }) });
    if (this.options.snapshots.latestIdentityAsync != null) {
      const identity = await this.options.snapshots.latestIdentityAsync();
      if (identity == null) return Object.freeze({ early: Object.freeze({ status: "WAITING_RESEARCH_SNAPSHOT" }) });
      return Object.freeze({ fingerprint: identity.originalRunFingerprintSha256 });
    }
    return this.eligibleFingerprint();
  }

  private finalize(originalRunFingerprintSha256: string, result: ClosedLearningResearchReplayResult): ClosedLearningInitialPaperBootstrapResult {
    const observedAt = this.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("initial PAPER bootstrap clock is invalid");

    // Denominator first. Artifact/deployment must never be visible if this durable write fails.
    this.options.history.persist(result, observedAt);
    if (result.deployment.status !== "DEPLOYABLE") {
      return Object.freeze({
        status: "RESEARCH_NOT_DEPLOYABLE",
        originalRunFingerprintSha256,
        reasons: Object.freeze([...result.deployment.reasons]),
        qualificationSummary: summarizeQualification(result.qualification),
      });
    }

    const artifact = this.options.artifacts.save(result.deployment.artifact);
    if (artifact.candidateId !== result.deployment.artifact.candidateId || artifact.candidateVersion !== result.deployment.artifact.candidateVersion) {
      throw new Error("initial PAPER bootstrap persisted artifact identity drifted");
    }
    const decision = bootstrapDecision(result);
    let deployment: ClosedLearningPaperDeploymentReceipt;
    try {
      deployment = this.options.deployment.deploy({
        cycleId: `closed-learning-initial:${result.replayRunFingerprintSha256}`,
        decision,
        authority: "PAPER_RESEARCH_ONLY",
        liveAuthority: "NONE",
        productionMutationAllowed: false,
        aiAuthority: "ZERO_AUTHORITY",
      });
    } catch (error) {
      // A qualified candidate without a Governance approval is a wait, not a fault: failing here
      // would stop the whole PAPER runtime and crash-loop it on every restart.
      if (isGovernanceApprovalUnavailable(error)) {
        return Object.freeze({ status: "WAITING_GOVERNANCE_APPROVAL", originalRunFingerprintSha256, reasons: Object.freeze(["PAPER_CHALLENGER_GOVERNANCE_APPROVAL_UNAVAILABLE"]) });
      }
      throw error;
    }
    return Object.freeze({
      status: "DEPLOYED",
      originalRunFingerprintSha256,
      deployment,
    });
  }

  private cachedResult(fingerprint: string): ClosedLearningInitialPaperBootstrapResult | undefined {
    return this.lastSuccessfulAttempt?.fingerprint === fingerprint
      ? this.lastSuccessfulAttempt.result
      : undefined;
  }

  private remember(fingerprint: string, result: ClosedLearningInitialPaperBootstrapResult): ClosedLearningInitialPaperBootstrapResult {
    this.lastSuccessfulAttempt = Object.freeze({ fingerprint, result });
    return result;
  }

  public runOnce(): ClosedLearningInitialPaperBootstrapResult {
    const eligible = this.eligibleFingerprint();
    if (eligible.early != null) return eligible.early;
    const fingerprint = eligible.fingerprint!;
    const cached = this.cachedResult(fingerprint);
    if (cached != null) return cached;
    let result: ClosedLearningResearchReplayResult;
    try {
      result = this.options.worker.replayInitialResearch(fingerprint);
    } catch (error) {
      if (isResearchSnapshotStale(error)) return this.remember(fingerprint, staleSnapshot(fingerprint));
      throw error;
    }
    return this.remember(fingerprint, this.finalize(fingerprint, result));
  }

  /** Async production path yields while the isolated Research/League child process executes when supported. */
  public async runOnceAsync(): Promise<ClosedLearningInitialPaperBootstrapResult> {
    const eligible = await this.eligibleFingerprintAsync();
    if (eligible.early != null) return eligible.early;
    const fingerprint = eligible.fingerprint!;
    const cached = this.cachedResult(fingerprint);
    if (cached != null) return cached;
    let result: ClosedLearningResearchReplayResult;
    try {
      result = this.options.worker.replayInitialResearchAsync == null
        ? this.options.worker.replayInitialResearch(fingerprint)
        : await this.options.worker.replayInitialResearchAsync(fingerprint);
    } catch (error) {
      if (isResearchSnapshotStale(error)) return this.remember(fingerprint, staleSnapshot(fingerprint));
      throw error;
    }
    return this.remember(fingerprint, this.finalize(fingerprint, result));
  }
}

/** Remembered per fingerprint, so a stale snapshot is replayed once and the next Research run is retried. */
function staleSnapshot(originalRunFingerprintSha256: string): ClosedLearningInitialPaperBootstrapResult {
  return Object.freeze({
    status: "WAITING_RESEARCH_SNAPSHOT",
    originalRunFingerprintSha256,
    reasons: Object.freeze(["RESEARCH_SNAPSHOT_STALE"]),
  });
}
