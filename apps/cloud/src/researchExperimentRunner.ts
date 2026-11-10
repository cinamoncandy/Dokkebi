import type { ResearchComparisonEvidence, ResearchInputSnapshot } from "../../../packages/contracts/src/researchRuntime";
import type { GeneratedStrategy } from "../../../packages/core/src/optimizer/aiStrategyEngine";
import type { ResearchCandleSource } from "./backtestResearchEvaluator";
import { buildResearchProvenance, canonicalSha256, hashResearchInputCore, ResearchProvenanceError } from "./researchProvenanceBuilder";
import { buildRollingFolds, buildWalkForwardWindows, decideRollingHoldout, requiredHistoryMs, ROLLING_FOLDS, type FoldOutcome, type RollingHoldoutDecision, type WalkForwardWindowConfig } from "./researchWalkForwardWindows";
import type { HoldoutKey } from "../../../packages/storage/src/researchHoldoutLedger";
import { createResearchPrecommit, type ResearchPrecommit } from "../../../packages/contracts/src/researchPrecommit";
import { calculateResearchCandleSha256, calculateResearchDatasetId, calculateResearchDatasetIdV2, type HistoricalDatasetManifest } from "../../../packages/contracts/src/researchDatasetSemantics";

/**
 * Runs one experiment for one challenger variant: VALIDATION window first; the HOLDOUT window is evaluated only when
 * validation favours the challenger AND the holdout was never used for that configuration (durable claim). Every
 * problem becomes a SKIPPED or ERROR outcome with a stable reason; nothing is retried, repaired or forced.
 * Ports are injected; this class owns no timer, storage or runtime.
 */
export interface ExperimentRunnerPorts {
  /** ResearchAutomationRuntime.runExperiment (or any equivalent) */
  readonly runExperiment: (input: ResearchInputSnapshot) => ResearchComparisonEvidence;
  readonly candles: ResearchCandleSource;
  readonly holdout: { claim(key: HoldoutKey, evaluationId: string, usedAtMs: number): "CLAIMED" | "ALREADY_USED"; overlapsUsedHoldout(hash: string, market: string, intervalMs: number, startMs: number, endMs: number): boolean };
  readonly now: () => number;
  readonly precommitStore?: { create(precommit: ResearchPrecommit): ResearchPrecommit };
  readonly datasetManifest?: { read(datasetId: string): HistoricalDatasetManifest };
}

export interface ExperimentSpec {
  readonly sessionId: string;
  readonly market: string;
  readonly intervalMs: number;
  readonly endCloseMs: number;
  readonly windows: WalkForwardWindowConfig;
  readonly champion: { readonly strategy: GeneratedStrategy; readonly config: unknown };
  readonly challenger: { readonly strategy: GeneratedStrategy; readonly config: unknown };
  readonly featurePipeline: { readonly version: string; readonly config: Readonly<Record<string, unknown>> };
  readonly evaluator: { readonly version: string; readonly modelVersion: string };
  readonly models: { readonly fill: string; readonly fee: string; readonly slippage: string };
  readonly sourceCommitSha: string;
  readonly experimentFamilyId: string;
  readonly attempt: number;
  readonly hypothesisLineage: string;
  readonly split: { readonly identity: string };
  readonly walkForwardConfig: unknown;
  readonly candidateCohort?: readonly Readonly<{ readonly id: string; readonly strategyId: string; readonly strategyVersion: string; readonly parameters: Readonly<Record<string, unknown>> }>[];
  readonly searchUniverse?: Readonly<Record<string, unknown>>;
  readonly datasetId?: string;
}

export type ExperimentOutcome =
  | { readonly status: "SKIPPED"; readonly reason: string }
  | { readonly status: "ERROR"; readonly reason: string }
  | { readonly status: "COMPLETED"; readonly validation: ResearchComparisonEvidence; readonly holdout: ResearchComparisonEvidence | null; readonly holdoutNote?: "VALIDATION_NOT_FAVOURABLE" | "HOLDOUT_ALREADY_USED" | "HOLDOUT_OVERLAPS_USED" };

const skip = (reason: string): ExperimentOutcome => Object.freeze({ status: "SKIPPED", reason });

export function runResearchExperiment(ports: ExperimentRunnerPorts, spec: ExperimentSpec): ExperimentOutcome {
  try {
    const now = ports.now();
    const intervalMs = spec.intervalMs;
    if (ports.datasetManifest != null) {
      if (!spec.datasetId) return skip("DATASET_MANIFEST_ID_MISSING");
      let manifest: ReturnType<NonNullable<ExperimentRunnerPorts["datasetManifest"]>["read"]>;
      try { manifest = ports.datasetManifest.read(spec.datasetId); } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "READ_FAILED";
        return skip(`DATASET_MANIFEST_${code}`);
      }
      if (manifest.datasetId !== spec.datasetId || manifest.market !== spec.market || manifest.interval !== `${intervalMs / 60_000}m`) return skip("DATASET_MANIFEST_BINDING_MISMATCH");
      if (spec.endCloseMs < manifest.startOpenTime || spec.endCloseMs > manifest.endCloseTime) return skip("DATASET_MANIFEST_RANGE_MISMATCH");
      const persisted = ports.candles.read(spec.market, intervalMs, manifest.startOpenTime + intervalMs, manifest.endCloseTime);
      if (persisted.length !== manifest.candleCount || persisted.some((candle) => candle.volume == null)) return skip("DATASET_MANIFEST_VOLUME_MISSING");
      const canonical = persisted.map((candle) => ({ market: spec.market, interval: manifest.interval as "1m" | "3m" | "5m" | "10m" | "15m" | "30m" | "60m" | "240m" | "1d", openTime: candle.closeTimeMs - intervalMs, closeTime: candle.closeTimeMs, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume! }));
      const contentSha256 = calculateResearchCandleSha256(canonical);
      const datasetId = manifest.schemaVersion === 1
        ? calculateResearchDatasetId(manifest.source, canonical, contentSha256)
        : manifest.provenance == null ? undefined : calculateResearchDatasetIdV2(manifest.source, canonical, contentSha256, manifest.provenance);
      if (contentSha256 !== manifest.contentSha256 || datasetId !== manifest.datasetId) return skip("DATASET_MANIFEST_CONTENT_MISMATCH");
    }
    const total = spec.windows.trainMs + spec.windows.validationMs + spec.windows.holdoutMs;
    const rows = ports.candles.read(spec.market, intervalMs, spec.endCloseMs - total + intervalMs, spec.endCloseMs);
    const built = buildWalkForwardWindows({ candles: rows.map((r) => ({ timestamp: r.closeTimeMs, open: r.open, high: r.high, low: r.low, close: r.close, volume: 0 })), endCloseMs: spec.endCloseMs, config: spec.windows });
    if (built.status === "REFUSED") return skip(`WINDOWS_${built.reason}${built.window ? `_${built.window.toUpperCase()}` : ""}`);

    const challengerConfigHash = canonicalSha256(spec.challenger.config);
    const idBase = `${spec.sessionId}:${challengerConfigHash.slice(0, 12)}:${spec.endCloseMs}`;
    const windows = {
      train: { windowId: `${idBase}:train`, candles: built.train },
      validation: { windowId: `${idBase}:validation`, candles: built.validation },
      holdout: { windowId: `${idBase}:holdout`, candles: built.holdout },
    };

    const run = (role: "VALIDATION" | "HOLDOUT"): ResearchComparisonEvidence => {
      const roleWindow = role === "VALIDATION" ? windows.validation : windows.holdout;
      const points = roleWindow.candles.map((c) => ({ market: spec.market, price: c.close, observedAt: c.timestamp }));
      const lastClose = roleWindow.candles[roleWindow.candles.length - 1]!.timestamp;
      const firstClose = roleWindow.candles[0]!.timestamp;
      const evaluationId = `${idBase}:${role.toLowerCase()}`;
      const core = {
        researchRunId: spec.sessionId,
        evaluationId,
        strategyId: spec.challenger.strategy.strategyId,
        strategyVersion: spec.challenger.strategy.version,
        marketDataTimestamp: lastClose,
        evaluationTimestamp: lastClose,
        modelVersion: spec.evaluator.modelVersion,
        fillModelVersion: spec.models.fill,
        feeModelVersion: spec.models.fee,
        slippageModelVersion: spec.models.slippage,
        strategyState: "RESEARCHING",
        // Every point of the window must count as fresh relative to the evaluation time (historical replay).
        staleWindowMs: lastClose - firstClose + 2 * intervalMs,
        marketData: points,
        startingCash: 1,
        startingPositionQuantity: 0,
      } as unknown as ResearchInputSnapshot;
      const precommit = ports.precommitStore == null ? undefined : createResearchPrecommit({
        schemaVersion: 1,
        experimentIdentity: evaluationId,
        candidateIdentity: `${spec.challenger.strategy.strategyId}@${spec.challenger.strategy.version}`,
        strategyIdentity: `${spec.challenger.strategy.strategyId}@${spec.challenger.strategy.version}`,
        datasetBinding: { market: spec.market, intervalMs, startCloseMs: firstClose, endCloseMs: lastClose, contentSha256: canonicalSha256(points) },
        sourceSha: spec.sourceCommitSha,
        parameterPlan: spec.challenger.config as Readonly<Record<string, unknown>>,
        ...(spec.candidateCohort == null ? {} : { candidateCohort: spec.candidateCohort }),
        ...(spec.searchUniverse == null ? {} : { searchUniverse: spec.searchUniverse }),
        costPlan: { fillModel: spec.models.fill, feeModel: spec.models.fee, slippageModel: spec.models.slippage },
        regimePlan: { status: "NOT_APPLICABLE" },
        evaluationPlan: { role, splitIdentity: spec.split.identity, walkForwardConfig: spec.walkForwardConfig },
        validationPolicyIdentity: spec.split.identity,
        createdAt: new Date(now).toISOString(),
      });
      const durablePrecommit = precommit == null ? undefined : ports.precommitStore!.create(precommit);
      const provenance = buildResearchProvenance({
        role,
        researchRunId: spec.sessionId,
        sessionId: spec.sessionId,
        experimentId: evaluationId,
        evaluationId,
        market: spec.market,
        intervalMs,
        windows,
        featurePipeline: spec.featurePipeline,
        strategy: { id: spec.challenger.strategy.strategyId, version: spec.challenger.strategy.version, artifact: spec.challenger.strategy.dsl, config: spec.challenger.config },
        evaluator: spec.evaluator,
        models: spec.models,
        sourceCommitSha: spec.sourceCommitSha,
        split: { identity: spec.split.identity, definition: { ...spec.windows } },
        walkForwardConfig: spec.walkForwardConfig,
        experimentFamilyId: spec.experimentFamilyId,
        attempt: spec.attempt,
        hypothesisLineage: spec.hypothesisLineage,
        finalHoldoutUntouched: true,
        canonicalInputHash: hashResearchInputCore(core),
      });
      return ports.runExperiment({ ...core, ...(durablePrecommit == null ? {} : { precommitFingerprint: durablePrecommit.fingerprint }), provenance } as ResearchInputSnapshot);
    };

    const validation = run("VALIDATION");
    if (validation.result !== "CHALLENGER_BETTER") return Object.freeze({ status: "COMPLETED", validation, holdout: null, holdoutNote: "VALIDATION_NOT_FAVOURABLE" });

    const key: HoldoutKey = { strategyConfigHash: challengerConfigHash, market: spec.market, intervalMs, holdoutStartMs: built.bounds.holdout.startCloseMs, holdoutEndMs: built.bounds.holdout.endCloseMs };
    if (ports.holdout.overlapsUsedHoldout(challengerConfigHash, spec.market, intervalMs, key.holdoutStartMs, key.holdoutEndMs)) return Object.freeze({ status: "COMPLETED", validation, holdout: null, holdoutNote: "HOLDOUT_OVERLAPS_USED" });
    if (ports.holdout.claim(key, `${idBase}:holdout`, now) === "ALREADY_USED") return Object.freeze({ status: "COMPLETED", validation, holdout: null, holdoutNote: "HOLDOUT_ALREADY_USED" });
    return Object.freeze({ status: "COMPLETED", validation, holdout: run("HOLDOUT") });
  } catch (error) {
    const reason = error instanceof ResearchProvenanceError ? `PROVENANCE_${error.code}` : typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "EXPERIMENT_FAILED";
    return Object.freeze({ status: "ERROR", reason });
  }
}

/** Result of the un-wired K-of-N composition. */
export interface RollingExperimentOutcome {
  readonly decision: RollingHoldoutDecision;
  readonly folds: readonly Readonly<{ index: number; endCloseMs: number; outcome: FoldOutcome; note: string }>[];
  readonly refusal?: string;
}

const refuseRolling = (reason: string): RollingExperimentOutcome => Object.freeze({ decision: decideRollingHoldout([]), folds: Object.freeze([]), refusal: reason });

/**
 * Runs the existing single-fold experiment once per fold. Only the orchestrator's SHADOW mode calls it (default OFF); it is not
 * used by the scheduler, ledger, backfill, or /health.
 *
 * `newestOutcome`: the outcome the caller already obtained for `spec` itself, which IS the newest fold (same end, same holdout window).
 * The newest fold's holdout claim is already used by that run, so running it again could only report HOLDOUT_ALREADY_USED; the given
 * outcome is classified instead and the older folds are the only ones run here.
 */
export function runRollingResearchExperiment(ports: ExperimentRunnerPorts, spec: ExperimentSpec, folds: number = ROLLING_FOLDS, newestOutcome?: ExperimentOutcome): RollingExperimentOutcome {
  // K stays 2, so only N=3 keeps "2 of 3" as strict as designed; any other N would be an easier bar and is refused.
  if (folds !== ROLLING_FOLDS) return refuseRolling("ROLLING_UNSUPPORTED_FOLD_COUNT");
  try {
    const need = requiredHistoryMs(spec.windows, folds);
    const rows = ports.candles.read(spec.market, spec.intervalMs, spec.endCloseMs - need + spec.intervalMs, spec.endCloseMs);
    const built = buildRollingFolds({ candles: rows.map((r) => ({ timestamp: r.closeTimeMs, open: r.open, high: r.high, low: r.low, close: r.close, volume: 0 })), endCloseMs: spec.endCloseMs, config: spec.windows, folds });
    if (built.status === "REFUSED") return refuseRolling(`ROLLING_${built.reason}${built.foldIndex === undefined ? "" : `_FOLD_${built.foldIndex}`}`);

    const results = built.folds.map((fold) => {
      const endCloseMs = fold.bounds.holdout.endCloseMs;
      const outcome = newestOutcome !== undefined && fold.index === folds - 1 ? newestOutcome : runResearchExperiment(ports, { ...spec, endCloseMs });
      let classified: FoldOutcome, note: string;
      if (outcome.status !== "COMPLETED") { classified = "INSUFFICIENT"; note = `${outcome.status}_${outcome.reason}`; }
      else if (outcome.holdout != null) { classified = outcome.holdout.result === "CHALLENGER_BETTER" ? "CHALLENGER_BETTER" : "NOT_BETTER"; note = "HOLDOUT_EVALUATED"; }
      else if (outcome.holdoutNote === "VALIDATION_NOT_FAVOURABLE") { classified = "NOT_BETTER"; note = "VALIDATION_NOT_FAVOURABLE"; }
      else { classified = "INSUFFICIENT"; note = outcome.holdoutNote ?? "HOLDOUT_NOT_EVALUATED"; }
      return Object.freeze({ index: fold.index, endCloseMs, outcome: classified, note });
    });
    return Object.freeze({ decision: decideRollingHoldout(results.map((r) => r.outcome), undefined, folds), folds: Object.freeze(results) });
  } catch {
    return refuseRolling("ROLLING_RUN_FAILED");
  }
}
