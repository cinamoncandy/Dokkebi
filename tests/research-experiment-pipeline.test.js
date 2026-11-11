const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { SqliteDatabase, SqliteResearchEvaluationLedger, SqliteCandidatePromotionRepository, SqliteResearchMemoryRepository, SqliteResearchSessionRepository, SqliteResearchCandleStore, SqliteResearchHoldoutLedger } = require("../dist/packages/storage/src/index.js");
const { ResearchRuntimeCoordinator } = require("../dist/apps/cloud/src/researchRuntimeCoordinator.js");
const { ResearchRecoveryCoordinator } = require("../dist/apps/cloud/src/researchRecoveryCoordinator.js");
const { CandidatePromotionRuntime } = require("../dist/apps/cloud/src/candidatePromotionRuntime.js");
const { ResearchAutomationRuntime } = require("../dist/apps/cloud/src/researchAutomationRuntime.js");
const { BacktestResearchEvaluator, buildSmaResearchStrategy } = require("../dist/apps/cloud/src/backtestResearchEvaluator.js");
const { runResearchExperiment } = require("../dist/apps/cloud/src/researchExperimentRunner.js");
const { validateResearchProvenance } = require("../dist/packages/contracts/src/researchHardening.js");

const M = 60_000;
const END = 5000 * M;
const BACKTEST = { initialCash: 1_000_000, feeRate: 0.0005, slippageBps: 5 };
const SHA = "a".repeat(40);

function wave(count, startMinute) {
  // Deterministic oscillating series so SMA crossovers trade in every window.
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + 12 * Math.sin(i / 6) + (i % 7) * 0.3;
    return { closeTimeMs: (startMinute + i) * M, open: close, high: close + 1, low: close - 1, close: Number(close.toFixed(4)) };
  });
}
const strat = (id, fast, slow) => buildSmaResearchStrategy({ strategyId: id, version: "1.0.0", market: "KRW-BTC", fastPeriod: fast, slowPeriod: slow, takeProfitPercent: 4, stopLossPercent: 2, positionPercent: 50, maxPositionNotional: 500_000 });

function setup(candleCount = 400) {
  const db = new SqliteDatabase(join(mkdtempSync(join(tmpdir(), "nusa-pipeline-")), "p.db"));
  const store = new SqliteResearchCandleStore(db);
  store.append("KRW-BTC", M, wave(candleCount, 5000 - candleCount + 1));
  const holdout = new SqliteResearchHoldoutLedger(db);
  const ledger = new SqliteResearchEvaluationLedger(db);
  const candidates = new SqliteCandidatePromotionRepository(db);
  const memory = new SqliteResearchMemoryRepository(db);
  const sessions = new SqliteResearchSessionRepository(db);
  const promotion = new CandidatePromotionRuntime({ repository: candidates, evaluationLedger: ledger, ownerActorRefs: ["owner"], now: () => END });
  const champion = strat("champion-sma", 3, 8);
  const challenger = strat("challenger-sma", 5, 12);
  const mk = (strategy, authority) => new BacktestResearchEvaluator({ strategyId: strategy.strategyId, strategyVersion: strategy.version, authority, evaluatorVersion: "backtest-eval-v1", strategy, candles: store, intervalMs: M, backtest: BACKTEST });
  const coordinator = new ResearchRuntimeCoordinator({ champion: mk(champion, "PAPER_ONLY"), challenger: mk(challenger, "ZERO_AUTHORITY"), ledger });
  const recovery = new ResearchRecoveryCoordinator({ repository: candidates, evaluationLedger: ledger, now: () => END });
  const automation = new ResearchAutomationRuntime({ coordinator, sessions, memory, registerCandidate: (identity) => promotion.registerCandidate(identity), listCandidates: () => candidates.listCandidates(), recovery, now: () => END, maxEvidenceAgeMs: 100 * M * 1000 });
  automation.recover();
  return { db, store, holdout, ledger, sessions, automation, champion, challenger };
}

const startInput = (sessionId, champion, challenger) => ({ sessionId, datasetId: "upbit-1m-closed:KRW-BTC:60000", interval: "1m", championStrategyId: champion.strategyId, championStrategyVersion: champion.version, challengerStrategyId: challenger.strategyId, challengerStrategyVersion: challenger.version, deterministicConfig: { v: 1 }, maxExperiments: 10 });
const spec = (s, over = {}) => ({
  sessionId: "research-2026-10-02", market: "KRW-BTC", intervalMs: M, endCloseMs: END,
  windows: { intervalMs: M, trainMs: 200 * M, validationMs: 80 * M, holdoutMs: 80 * M, maxMissingRatio: 0 },
  champion: { strategy: s.champion, config: { fast: 3, slow: 8 } }, challenger: { strategy: s.challenger, config: { fast: 5, slow: 12 } },
  featurePipeline: { version: "closed-candle-agg-v1", config: { intervalMs: M } },
  evaluator: { version: "backtest-eval-v1", modelVersion: "dsl-backtest-v1" },
  models: { fill: "fill-close-v1", fee: "fee-0.0005-v1", slippage: "slip-5bps-v1" },
  sourceCommitSha: SHA, experimentFamilyId: "family-sma-btc", attempt: 1, hypothesisLineage: "h0", split: { identity: "wf-200-80-80" }, walkForwardConfig: { grid: { fast: [5], slow: [12] } },
  ...over,
});
const ports = (s) => ({ runExperiment: (input) => s.automation.runExperiment(input), candles: s.store, holdout: s.holdout, now: () => END });

test("end to end: real stores, real coordinator, real automation runtime accept a provenance-carrying experiment", () => {
  const s = setup();
  try {
    s.automation.startSession(startInput("research-2026-10-02", s.champion, s.challenger));
    const outcome = runResearchExperiment(ports(s), spec(s));
    assert.equal(outcome.status, "COMPLETED", JSON.stringify(outcome));
    const v = outcome.validation;
    assert.notEqual(v.reason, "EVALUATOR_EXCEPTION");
    assert.ok(["CHALLENGER_BETTER", "CHAMPION_BETTER", "INCONCLUSIVE"].includes(v.result));
    assert.equal(v.reason, "MULTI_METRIC_COMPARISON", `reason was ${v.reason}`);
    assert.deepEqual(validateResearchProvenance(v.provenance), []);
    assert.equal(v.provenance.windowRole, "VALIDATION");
    assert.equal(v.provenance.finalHoldoutUntouched, true);
    assert.equal(s.automation.status("research-2026-10-02").experimentCount >= 1, true);
    if (v.result === "CHALLENGER_BETTER") {
      assert.ok(outcome.holdout != null || outcome.holdoutNote != null);
      if (outcome.holdout) assert.equal(outcome.holdout.provenance.windowRole, "HOLDOUT");
    } else {
      assert.equal(outcome.holdout, null);
      assert.equal(outcome.holdoutNote, "VALIDATION_NOT_FAVOURABLE");
    }
  } finally { s.db.close(); }
});

test("the holdout is spent at most once per challenger configuration", () => {
  const s = setup();
  try {
    s.automation.startSession(startInput("research-2026-10-02", s.champion, s.challenger));
    // Force the validation path to favour the challenger by making the runner's port report it, then check the claim.
    const favourable = { ...ports(s), runExperiment: (input) => { const real = s.automation.runExperiment(input); return input.provenance.windowRole === "VALIDATION" ? { ...real, result: "CHALLENGER_BETTER" } : real; } };
    const first = runResearchExperiment(favourable, spec(s));
    assert.equal(first.status, "COMPLETED");
    assert.ok(first.holdout != null, "first favourable run evaluates the holdout");
    assert.equal(first.holdout.provenance.windowRole, "HOLDOUT");
    const second = runResearchExperiment(favourable, spec(s));
    assert.equal(second.status, "COMPLETED");
    assert.equal(second.holdout, null);
    assert.ok(["HOLDOUT_ALREADY_USED", "HOLDOUT_OVERLAPS_USED"].includes(second.holdoutNote));
    assert.equal(s.holdout.count(), 1);
  } finally { s.db.close(); }
});

test("skips with a stable reason when history is too short, and reports provenance problems as errors", () => {
  const short = setup(100);
  try {
    short.automation.startSession(startInput("research-2026-10-02", short.champion, short.challenger));
    const out = runResearchExperiment(ports(short), spec(short));
    assert.equal(out.status, "SKIPPED");
    assert.match(out.reason, /^WINDOWS_INSUFFICIENT_HISTORY|^WINDOWS_NO_CANDLES|^WINDOWS_TOO_MANY_GAPS/);
  } finally { short.db.close(); }
  const s = setup();
  try {
    s.automation.startSession(startInput("research-2026-10-02", s.champion, s.challenger));
    const bad = runResearchExperiment(ports(s), spec(s, { sourceCommitSha: "nope" }));
    assert.deepEqual({ ...bad }, { status: "ERROR", reason: "PROVENANCE_INVALID_SOURCE_COMMIT" });
    assert.equal(s.holdout.count(), 0);
  } finally { s.db.close(); }
});

test("a dataset whose only gap is exchange-confirmed absent runs; the same gap without the exchange proof never becomes a dataset", () => {
  const { SqliteResearchDatasetManifestStore } = require("../dist/packages/storage/src/index.js");
  const { materializeResearchDatasetManifest } = require("../dist/apps/cloud/src/researchDatasetManifestMaterializer.js");
  const { UPBIT_CANDLE_SOURCE_FINGERPRINT } = require("../dist/apps/cloud/src/researchCandleBackfill.js");
  const build = (withProof) => {
    const db = new SqliteDatabase(join(mkdtempSync(join(tmpdir(), "nusa-absence-")), "p.db"));
    const store = new SqliteResearchCandleStore(db);
    // 400 minutes ending at END; the exchange had nothing for 6 minutes inside the 80-minute holdout (7.5%)
    const rows = wave(400, 4601).map((c) => ({ ...c, volume: 1 })).filter((c) => { const m = c.closeTimeMs / M; return m < 4950 || m > 4955; });
    const receipt = (part, tag) => store.appendWithMaterial("KRW-BTC", M, part, { source: "UPBIT_PUBLIC_CANDLES", sourceFingerprint: UPBIT_CANDLE_SOURCE_FINGERPRINT, evidenceFingerprintSha256: tag.repeat(64), missingBuckets: 0, incompleteBuckets: 0, rejectedObservations: 0 });
    receipt(rows.filter((c) => c.closeTimeMs < 4950 * M), "1");
    receipt(rows.filter((c) => c.closeTimeMs > 4955 * M), "2");
    if (withProof) store.recordAbsence({ market: "KRW-BTC", intervalMs: M, firstAbsentCloseMs: 4950 * M, lastAbsentCloseMs: 4955 * M, beforeCloseMs: 4949 * M, afterCloseMs: 4956 * M, evidenceFingerprintSha256: "3".repeat(64), observedAt: new Date(END).toISOString() });
    const manifests = new SqliteResearchDatasetManifestStore(db);
    return { db, store, manifests, make: () => materializeResearchDatasetManifest({ store: manifests, candleStore: store, market: "KRW-BTC", intervalMs: M, candles: store.read("KRW-BTC", M, 0, END), source: "upbit-1m-closed:KRW-BTC:60000", createdAt: new Date(END).toISOString(), sourceCommitSha: SHA }) };
  };
  const plain = build(false);
  try { assert.throws(() => plain.make(), /missing intervals/); } finally { plain.db.close(); }

  const proved = build(true);
  try {
    const manifest = proved.make();
    assert.equal(manifest.missingCandleCount, 6);
    const s = setup();
    s.db.close();
    // reuse the real coordinator wiring, but read candles and the manifest from the store that has the gap
    const t = { ...s };
    const ledgerDb = new SqliteDatabase(join(mkdtempSync(join(tmpdir(), "nusa-absence-l-")), "l.db"));
    const holdout = new SqliteResearchHoldoutLedger(ledgerDb);
    const ledger = new SqliteResearchEvaluationLedger(ledgerDb);
    const candidates = new SqliteCandidatePromotionRepository(ledgerDb);
    const memory = new SqliteResearchMemoryRepository(ledgerDb);
    const sessions = new SqliteResearchSessionRepository(ledgerDb);
    const promotion = new CandidatePromotionRuntime({ repository: candidates, evaluationLedger: ledger, ownerActorRefs: ["owner"], now: () => END });
    const ev = (strategy, authority) => new BacktestResearchEvaluator({ strategyId: strategy.strategyId, strategyVersion: strategy.version, authority, evaluatorVersion: "backtest-eval-v1", strategy, candles: proved.store, intervalMs: M, backtest: BACKTEST });
    const coordinator = new ResearchRuntimeCoordinator({ champion: ev(t.champion, "PAPER_ONLY"), challenger: ev(t.challenger, "ZERO_AUTHORITY"), ledger });
    const recovery = new ResearchRecoveryCoordinator({ repository: candidates, evaluationLedger: ledger, now: () => END });
    const automation = new ResearchAutomationRuntime({ coordinator, sessions, memory, registerCandidate: (identity) => promotion.registerCandidate(identity), listCandidates: () => candidates.listCandidates(), recovery, now: () => END, maxEvidenceAgeMs: 100 * M * 1000 });
    automation.recover();
    automation.startSession(startInput("research-absence", t.champion, t.challenger));
    const outcome = runResearchExperiment({ runExperiment: (input) => automation.runExperiment(input), candles: proved.store, holdout, now: () => END, datasetManifest: { read: (id) => proved.manifests.read(id), listAbsence: (...args) => proved.store.listAbsence(...args) } }, spec(t, { sessionId: "research-absence", datasetId: manifest.datasetId }));
    assert.notEqual(outcome.status, "SKIPPED", JSON.stringify(outcome));
    assert.notEqual(outcome.reason, "WINDOWS_TOO_MANY_GAPS_HOLDOUT");
    const guarded = (listAbsence) => runResearchExperiment({ runExperiment: () => { throw new Error("must not evaluate"); }, candles: proved.store, holdout, now: () => END, datasetManifest: { read: (id) => proved.manifests.read(id), listAbsence } }, spec(t, { sessionId: "research-absence", datasetId: manifest.datasetId }));
    assert.equal(guarded(() => []).reason, "DATASET_MANIFEST_ABSENCE_UNVERIFIED");
    assert.equal(guarded(() => { throw new Error("unavailable"); }).reason, "DATASET_MANIFEST_ABSENCE_UNVERIFIED");
    assert.equal(guarded((...args) => proved.store.listAbsence(...args).map((run) => ({ ...run, evidenceFingerprintSha256: "4".repeat(64) }))).reason, "DATASET_MANIFEST_ABSENCE_UNVERIFIED");
    ledgerDb.close();
  } finally { proved.db.close(); }
});
