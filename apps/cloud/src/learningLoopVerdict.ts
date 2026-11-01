import type { LearningPipelineProjection } from "./learningPipelineStage";

/**
 * Display only: one verdict for the PAPER closed learning loop, computed from the already-public /health runtime object and the
 * learningPipeline projection (fixed codes and integers; no market, amount, identifier or text). The owner's recovery work order
 * defines the labels: LOOP_VERIFIED needs a real chain (market observation -> decision -> PAPER order -> fill -> candles -> dataset ->
 * Research experiment -> learning cycle evaluated AND durably recorded). A counter rising, a synthetic event or a stale value never
 * counts, and a missing field reads UNKNOWN, never PASS. Nothing here is fed back into execution, risk, research or the gates.
 */
export type LearningLoopVerdictLabel = "LOOP_VERIFIED" | "PARTIAL" | "BLOCKED" | "FAILED" | "UNKNOWN";

export interface LearningLoopVerdict {
  readonly schemaVersion: 1;
  readonly verdict: LearningLoopVerdictLabel;
  /** The first stage in the chain that is not PASS, or "NONE". */
  readonly firstBrokenTransition: string;
  /** The fixed code of that stage (for example CANDLES_STALE), or PASS. */
  readonly firstBrokenCode: string;
  /**
   * Why a learning cycle has not run when everything before it passes or is merely waiting: NO_DEPLOYABLE_CANDIDATE means no
   * Research candidate has passed the independent holdout (a cycle runs a candidate against the baseline), which is the designed
   * state and not a broken pipe. NONE when it does not apply.
   */
  readonly cycleWaitingFor: "NONE" | "NO_DEPLOYABLE_CANDIDATE" | "EVALUATION_WINDOW" | "UNKNOWN";
  /**
   * Where Research candidates stop, from the meta-learning counters only (integers, no candidate text): NO_EXPERIMENTS = none run yet,
   * NO_DISCOVERY = experiments ran but nothing passed discovery (data or signal), DISCOVERY_ONLY_REJECTED = something passed
   * discovery but nothing passed the independent holdout (overfit), HOLDOUT_PASSED = at least one candidate passed. Display only.
   */
  readonly candidateFunnel: Readonly<{ stage: "NO_EXPERIMENTS" | "NO_DISCOVERY" | "DISCOVERY_ONLY_REJECTED" | "HOLDOUT_PASSED" | "UNKNOWN"; experiments: number | null; discoveryPasses: number | null; holdoutPasses: number | null }>;
  readonly criteria: Readonly<{
    tradingChain: "PASS" | "NOT_PASS" | "UNKNOWN";
    researchInputs: "PASS" | "NOT_PASS" | "UNKNOWN";
    cycleEvaluated: boolean | null;
    cycleRecorded: boolean | null;
    /** OBSERVED only when this process found cycle records written before it started (cyclesRecordedAtBoot > 0); otherwise one snapshot cannot show it. */
    survivesRestart: "OBSERVED" | "NOT_OBSERVED";
  }>;
}

type Source = Readonly<Record<string, unknown>>;
const int = (value: unknown): number | undefined => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined);
const record = (value: unknown): Source | undefined => (value != null && typeof value === "object" && !Array.isArray(value) ? (value as Source) : undefined);
const CODE = /^[A-Z][A-Z0-9_]{0,47}$/;

const CHAIN: readonly (readonly ["trading" | "research", string])[] = [
  ["trading", "MARKET"], ["trading", "DECISION"], ["trading", "ORDER"], ["trading", "FILL"],
  ["research", "CANDLES"], ["research", "DATASET"], ["research", "EXPERIMENT"],
];

export function learningLoopVerdict(runtime: Source, pipeline: LearningPipelineProjection): LearningLoopVerdict {
  const loop = record(runtime.closedLearningLoop);
  const evaluated = int(loop?.cyclesEvaluated);
  const recorded = int(loop?.cyclesRecorded);
  const recordedAtBoot = int(loop?.cyclesRecordedAtBoot);
  const meta = record(loop?.metaLearning);
  const holdoutPasses = int(meta?.holdoutPasses);

  let firstStage = "NONE", firstCode = "PASS";
  for (const [branchName, stage] of CHAIN) {
    const code = pipeline[branchName].stages[stage];
    if (code !== "PASS") { firstStage = stage; firstCode = typeof code === "string" && CODE.test(code) ? code : "UNKNOWN"; break; }
  }
  if (firstStage === "NONE" && pipeline.learning !== "PASS") { firstStage = "LEARNING"; firstCode = typeof pipeline.learning === "string" && CODE.test(pipeline.learning) ? pipeline.learning : "UNKNOWN"; }

  const tradingState = pipeline.trading.code === "PASS" ? "PASS" : pipeline.trading.code === "UNKNOWN" ? "UNKNOWN" : "NOT_PASS";
  const researchState = pipeline.research.code === "PASS" ? "PASS" : pipeline.research.code === "UNKNOWN" ? "UNKNOWN" : "NOT_PASS";
  const cycleEvaluated = evaluated === undefined ? null : evaluated > 0;
  const cycleRecorded = recorded === undefined ? null : recorded > 0;

  const rollover = typeof loop?.rollover === "string" ? loop.rollover : undefined;
  const errorClass = typeof loop?.lastErrorClass === "string" && CODE.test(loop.lastErrorClass) ? loop.lastErrorClass : undefined;
  const failedNow = rollover === "ERROR" || errorClass !== undefined;

  const cycleWaitingFor: LearningLoopVerdict["cycleWaitingFor"] = cycleEvaluated === true ? "NONE"
    : cycleEvaluated === null ? "UNKNOWN"
    : holdoutPasses === 0 ? "NO_DEPLOYABLE_CANDIDATE"
    : rollover === "WAITING_FOR_EVALUATION_WINDOW" ? "EVALUATION_WINDOW" : "UNKNOWN";

  const experiments = int(meta?.experiments), discoveryPasses = int(meta?.discoveryPasses);
  const funnelStage: LearningLoopVerdict["candidateFunnel"]["stage"] = experiments === undefined || discoveryPasses === undefined || holdoutPasses === undefined ? "UNKNOWN"
    : holdoutPasses > 0 ? "HOLDOUT_PASSED"
    : discoveryPasses > 0 ? "DISCOVERY_ONLY_REJECTED"
    : experiments > 0 ? "NO_DISCOVERY" : "NO_EXPERIMENTS";

  let verdict: LearningLoopVerdictLabel;
  if (failedNow) verdict = "FAILED";
  else if (firstStage === "NONE" && cycleEvaluated === true && cycleRecorded === true) verdict = "LOOP_VERIFIED";
  else if (tradingState === "UNKNOWN" || researchState === "UNKNOWN" || cycleEvaluated === null) verdict = "UNKNOWN";
  else if (tradingState === "PASS") verdict = "PARTIAL";
  else verdict = "BLOCKED";

  return Object.freeze({
    schemaVersion: 1 as const,
    verdict,
    firstBrokenTransition: firstStage,
    firstBrokenCode: firstCode,
    cycleWaitingFor,
    candidateFunnel: Object.freeze({ stage: funnelStage, experiments: experiments ?? null, discoveryPasses: discoveryPasses ?? null, holdoutPasses: holdoutPasses ?? null }),
    criteria: Object.freeze({ tradingChain: tradingState, researchInputs: researchState, cycleEvaluated, cycleRecorded, survivesRestart: recordedAtBoot !== undefined && recordedAtBoot > 0 ? "OBSERVED" as const : "NOT_OBSERVED" as const }),
  });
}
