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
const { ResearchExperimentOrchestrator } = require("../dist/apps/cloud/src/researchExperimentOrchestrator.js");

const M = 60_000;
const DAY = 86_400_000;
const T_END = Date.UTC(2026, 9, 2, 3, 0, 0); // 2026-10-02 12:00 KST, a multiple of one minute
const BACKTEST = { initialCash: 1_000_000, feeRate: 0.0005, slippageBps: 5 };
const WINDOWS = { intervalMs: M, trainMs: 200 * M, validationMs: 80 * M, holdoutMs: 80 * M, maxMissingRatio: 0 };

function candles(count, endCloseMs) {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + 12 * Math.sin(i / 6) + (i % 7) * 0.3;
    return { closeTimeMs: endCloseMs - (count - 1 - i) * M, open: close, high: close + 1, low: close - 1, close: Number(close.toFixed(4)) };
  });
}
const strat = (id, fast, slow) => buildSmaResearchStrategy({ strategyId: id, version: "1.0.0", market: "KRW-BTC", fastPeriod: fast, slowPeriod: slow, takeProfitPercent: 4, stopLossPercent: 2, positionPercent: 50, maxPositionNotional: 500_000 });

function build(filename, state = { now: T_END }, extra = {}) {
  const db = new SqliteDatabase(filename);
  const store = new SqliteResearchCandleStore(db);
  const holdout = new SqliteResearchHoldoutLedger(db);
  const ledger = new SqliteResearchEvaluationLedger(db);
  const candidates = new SqliteCandidatePromotionRepository(db);
  const memory = new SqliteResearchMemoryRepository(db);
  const sessions = new SqliteResearchSessionRepository(db);
  const promotion = new CandidatePromotionRuntime({ repository: candidates, evaluationLedger: ledger, ownerActorRefs: ["owner"], now: () => state.now });
  const recovery = new ResearchRecoveryCoordinator({ repository: candidates, evaluationLedger: ledger, now: () => state.now });
  const champion = strat("champion-sma", 3, 8);
  const mkVariant = (variantId, fast, slow) => {
    const challenger = strat(`challenger-${variantId}`, fast, slow);
    const mk = (strategy, authority) => new BacktestResearchEvaluator({ strategyId: strategy.strategyId, strategyVersion: strategy.version, authority, evaluatorVersion: "backtest-eval-v1", strategy, candles: store, intervalMs: M, backtest: BACKTEST });
    const coordinator = new ResearchRuntimeCoordinator({ champion: mk(champion, "PAPER_ONLY"), challenger: mk(challenger, "ZERO_AUTHORITY"), ledger });
    const runtime = new ResearchAutomationRuntime({ coordinator, sessions, memory, registerCandidate: (identity) => promotion.registerCandidate(identity), listCandidates: () => candidates.listCandidates(), recovery, now: () => state.now, maxEvidenceAgeMs: 30 * DAY });
    return { variantId, champion: { strategy: champion, config: { fast: 3, slow: 8 } }, challenger: { strategy: challenger, config: { fast: fast, slow } }, runtime };
  };
  const variants = [mkVariant("v1", 5, 12), mkVariant("v2", 4, 16)];
  const orchestrator = new ResearchExperimentOrchestrator({
    variants, sessions, markets: ["KRW-BTC"], intervalMs: M, windows: WINDOWS, dailyBudgetPerVariant: 20,
    collect: () => {}, candles: store, holdout, now: () => state.now, sourceCommitSha: "a".repeat(40),
    models: { fill: "fill-close-v1", fee: "fee-0.0005-v1", slippage: "slip-5bps-v1" }, evaluator: { version: "backtest-eval-v1", modelVersion: "dsl-backtest-v1" },
    featurePipeline: { version: "closed-candle-agg-v1", config: { intervalMs: M } }, experimentFamilyPrefix: "sma-family",
    failureEvidence: () => ledger.list().filter((record) => record.provenance?.windowRole === "VALIDATION" && record.provenance.interval === "1m"),
    ...extra,
  });
  return { db, store, sessions, orchestrator, holdout, state, ledger, variants };
}
const fresh = () => join(mkdtempSync(join(tmpdir(), "nusa-orch-")), "o.db");
const seed = (s, count = 400, end = T_END) => s.store.append("KRW-BTC", M, candles(count, end));
const dayKey = (ms) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

test("does nothing until recovery is ready, then starts one session per variant and runs experiments", () => {
  const s = build(fresh()); seed(s);
  try {
    assert.equal(s.orchestrator.tick().status, "RECOVERY_NOT_READY");
    assert.equal(s.sessions.list().length, 0);
    assert.equal(s.orchestrator.recover().status, "READY");
    const report = s.orchestrator.tick();
    assert.equal(report.status, "OK");
    assert.equal(report.started, 2);
    assert.deepEqual(s.sessions.list().map((x) => x.sessionId), [`research-${dayKey(T_END)}-v1`, `research-${dayKey(T_END)}-v2`]);
    assert.equal(report.experiments.length, 2);
    for (const e of report.experiments) assert.equal(e.outcome.status, "COMPLETED", JSON.stringify(e));
    const projection = s.orchestrator.statusProjection();
    assert.ok(projection != null && projection.experimentCount >= 1);
    assert.equal(projection.liveAuthority, "NONE");
    assert.equal(projection.challenger.authority, "ZERO_AUTHORITY");
  } finally { s.db.close(); }
});

test("a second tick on the same data does not repeat the experiment", () => {
  const s = build(fresh()); seed(s);
  try {
    s.orchestrator.recover();
    s.orchestrator.tick();
    const before = s.sessions.list().map((x) => x.experimentCount);
    const again = s.orchestrator.tick();
    assert.equal(again.started, 0);
    for (const e of again.experiments) assert.equal(e.outcome.status, "NOT_DUE");
    assert.deepEqual(s.sessions.list().map((x) => x.experimentCount), before);
  } finally { s.db.close(); }
});

test("after a restart the paused session resumes and keeps working without duplicating", () => {
  const file = fresh();
  const first = build(file); seed(first);
  first.orchestrator.recover(); first.orchestrator.tick();
  const counts = first.sessions.list().map((x) => x.experimentCount);
  first.db.close();
  const second = build(file);
  try {
    assert.equal(second.orchestrator.recover().status, "READY");
    assert.ok(second.sessions.list().every((x) => x.state === "PAUSED"));
    const report = second.orchestrator.tick();
    assert.equal(report.resumed, 2);
    assert.equal(report.started, 0);
    assert.ok(second.sessions.list().every((x) => x.state === "RUNNING"));
    assert.deepEqual(second.sessions.list().map((x) => x.experimentCount), counts);
  } finally { second.db.close(); }
});

test("a new trading day stops the previous RUNNING sessions and starts new ones", () => {
  const s = build(fresh()); seed(s, 400, T_END);
  try {
    s.orchestrator.recover(); s.orchestrator.tick();
    s.state.now = T_END + DAY;
    seed(s, 400, T_END + DAY);
    const report = s.orchestrator.tick();
    assert.equal(report.stopped, 2);
    assert.equal(report.started, 2);
    const states = Object.fromEntries(s.sessions.list().map((x) => [x.sessionId, x.state]));
    assert.equal(states[`research-${dayKey(T_END)}-v1`], "COMPLETED");
    assert.equal(states[`research-${dayKey(T_END + DAY)}-v1`], "RUNNING");
  } finally { s.db.close(); }
});

test("without enough candles the sessions start but experiments are skipped with a stable reason", () => {
  const s = build(fresh()); seed(s, 50);
  try {
    s.orchestrator.recover();
    const report = s.orchestrator.tick();
    assert.equal(report.started, 2);
    for (const e of report.experiments) { assert.equal(e.outcome.status, "SKIPPED"); assert.match(e.outcome.reason, /^WINDOWS_/); }
  } finally { s.db.close(); }
});

test("market data ticks are ignored by design and an empty status projection is null", () => {
  const s = build(fresh());
  try {
    assert.equal(s.orchestrator.onMarketData({ market: "KRW-BTC", price: 1, observedAt: 1, now: 1 }), undefined);
    assert.equal(s.orchestrator.statusProjection(), null);
  } finally { s.db.close(); }
});

test("invalid orchestrator configuration is rejected", () => {
  const s = build(fresh());
  try {
    const base = { variants: [], sessions: s.sessions, markets: ["KRW-BTC"], intervalMs: M, windows: WINDOWS, dailyBudgetPerVariant: 1, collect: () => {}, candles: s.store, holdout: s.holdout, now: () => T_END, sourceCommitSha: "a".repeat(40), models: {}, evaluator: {}, featurePipeline: {}, experimentFamilyPrefix: "x" };
    assert.throws(() => new ResearchExperimentOrchestrator(base));
  } finally { s.db.close(); }
});

test("experiment tick counts accumulate as fixed codes and integers for /health", () => {
  const s = build(fresh()); seed(s);
  try {
    assert.equal(s.orchestrator.experimentTicks(), null, "nothing before the first tick");
    s.orchestrator.tick();
    assert.equal(s.orchestrator.experimentTicks().lastStatus, "RECOVERY_NOT_READY");
    s.orchestrator.recover();
    const report = s.orchestrator.tick();
    s.orchestrator.tick();
    const summary = s.orchestrator.experimentTicks();
    assert.equal(summary.ticks, 3);
    assert.equal(summary.lastStatus, "OK");
    assert.equal(summary.sessionsStarted, 2);
    assert.equal(summary.counts.COMPLETED, report.experiments.length);
    assert.equal(summary.counts.NOT_DUE, 2, "the second OK tick found nothing due");
    const validation = Object.keys(summary.counts).filter((k) => k.startsWith("VALIDATION_"));
    assert.ok(validation.length >= 1, "each completed experiment records its validation result");
    const notBetter = validation.filter((k) => k !== "VALIDATION_CHALLENGER_BETTER").reduce((n, k) => n + summary.counts[k], 0);
    const failed = Object.keys(summary.counts).filter((k) => k.startsWith("FAIL_")).reduce((n, k) => n + summary.counts[k], 0);
    assert.equal(failed, notBetter, "every validation that did not beat the champion is counted under exactly one bounded failure reason");
    for (const [key, value] of Object.entries(summary.counts)) { assert.match(key, /^[A-Z][A-Z0-9_]{1,47}$/); assert.ok(Number.isSafeInteger(value)); }
  } finally { try { s.db.close(); } catch { /* already closed by the restart check */ } }
});

test("skipped experiments are counted under their stable reason code", () => {
  const s = build(fresh()); seed(s, 50);
  try {
    s.orchestrator.recover();
    s.orchestrator.tick();
    const counts = s.orchestrator.experimentTicks().counts;
    assert.equal(counts.SKIPPED, 2);
    assert.ok(Object.keys(counts).some((k) => /^SKIPPED_WINDOWS_/.test(k)), JSON.stringify(counts));
  } finally { s.db.close(); }
});

test("failure reasons are recomputed from the ledger records, so a brand-new orchestrator reports history it never counted", () => {
  const s = build(fresh()); seed(s);
  try {
    const failed = (result, extra = {}) => ({ result, reason: "MULTI_METRIC_COMPARISON", champion: { metrics: { netReturn: 0.01, maximumDrawdown: 0.1, executionQuality: 0.9 } }, challenger: { metrics: { netReturn: 0.02, maximumDrawdown: 0.1, executionQuality: 0.9 } }, ...extra });
    const history = [failed("CHAMPION_BETTER"), failed("INCONCLUSIVE", { challenger: { metrics: { netReturn: 0.05, maximumDrawdown: 0.5, executionQuality: 0.9 } } }), failed("CHALLENGER_BETTER")];
    const fresh2 = new (s.orchestrator.constructor)({ ...s.orchestrator.options, failureEvidence: () => history });
    fresh2.recover();
    fresh2.tick();
    const counts = fresh2.experimentTicks().counts;
    assert.equal(counts.FAIL_NO_EDGE, 1);
    assert.equal(counts.FAIL_EXCESSIVE_DRAWDOWN, 1);
    assert.equal(Object.keys(counts).filter((k) => k.startsWith("FAIL_")).length, 2, "the winner is not a failure");
    fresh2.tick();
    assert.equal(fresh2.experimentTicks().counts.FAIL_NO_EDGE, 1, "recomputed each tick, never double counted");
  } finally { s.db.close(); }
});

test("ordinary outcome count keys are capped at 30 so the derived FAIL_ and REPEAT_ keys always fit within /health's 40", () => {
  const { addOutcomeCount, MAX_ORDINARY_COUNT_KEYS } = require("../dist/apps/cloud/src/researchExperimentOrchestrator.js");
  assert.equal(MAX_ORDINARY_COUNT_KEYS, 30);
  const counts = { FAIL_NO_EDGE: 4, REPEAT_NO_EDGE: 1 };
  for (let index = 0; index < 60; index += 1) addOutcomeCount(counts, `OUTCOME_${index}`);
  const ordinary = Object.keys(counts).filter((key) => !key.startsWith("FAIL_") && !key.startsWith("REPEAT_"));
  assert.equal(ordinary.length, 30, "stale derived keys do not consume ordinary slots, and ordinary keys stop at the cap");
  addOutcomeCount(counts, "OUTCOME_0");
  assert.equal(counts.OUTCOME_0, 2, "an existing key still counts after the cap");
  addOutcomeCount(counts, "FAIL_INJECTED");
  addOutcomeCount(counts, "bad key");
  assert.equal(counts.FAIL_INJECTED, undefined, "derived keys are never written by the ordinary path");
  assert.equal(counts["bad key"], undefined);
});

// --- K-of-N rolling holdout, SHADOW only (docs/DESIGN_ROLLING_HOLDOUT_WIRING.md) ---
const scripted = (s, script) => {
  for (const variant of s.variants) {
    const real = variant.runtime.runExperiment.bind(variant.runtime);
    variant.runtime.runExperiment = (input) => {
      const rolling = String(input.researchRunId).endsWith("_rolling");
      const verdict = script({ rolling, role: input.provenance.windowRole });
      if (verdict == null) return real(input);
      if (verdict instanceof Error) throw verdict;
      return { ...real(input), result: verdict };
    };
  }
};

test("rolling holdout is off by default: no rolling session, no summary", () => {
  const s = build(fresh()); seed(s, 3 * 360 + 60);
  try {
    s.orchestrator.recover(); s.orchestrator.tick();
    assert.equal(s.orchestrator.rollingHoldout(), null);
    assert.ok(s.sessions.list().every((x) => !x.sessionId.endsWith("_rolling")));
    const off = build(fresh(), { now: T_END }, { rollingHoldout: { mode: "OFF" } });
    try { assert.equal(off.orchestrator.rollingHoldout(), null); } finally { off.db.close(); }
  } finally { s.db.close(); }
});

test("SHADOW checks a favourable challenger in its own rolling session and leaves the real counters and sessions alone", () => {
  const plain = build(fresh()); seed(plain, 3 * 360 + 60);
  const s = build(fresh(), { now: T_END }, { rollingHoldout: { mode: "SHADOW" } }); seed(s, 3 * 360 + 60);
  try {
    for (const x of [plain, s]) { scripted(x, () => "CHALLENGER_BETTER"); x.orchestrator.recover(); x.orchestrator.tick(); }
    const summary = s.orchestrator.rollingHoldout();
    assert.equal(summary.mode, "SHADOW");
    assert.equal(summary.candidatesChecked, 2, "one rolling check per favourable variant");
    assert.equal(summary.pass, 2);
    assert.equal(summary.folds.challengerBetter, 6);
    const rollingIds = s.sessions.list().map((x) => x.sessionId).filter((id) => id.endsWith("_rolling")).sort();
    assert.deepEqual(rollingIds, [`research-${dayKey(T_END)}-v1_rolling`, `research-${dayKey(T_END)}-v2_rolling`]);
    const real = (x) => x.sessions.list().filter((y) => !y.sessionId.endsWith("_rolling")).map((y) => [y.sessionId, y.experimentCount, y.state]);
    assert.deepEqual(real(s), real(plain), "the real sessions are exactly what they are without SHADOW");
    assert.deepEqual(s.orchestrator.experimentTicks().counts, plain.orchestrator.experimentTicks().counts, "the published counts do not move");
  } finally { plain.db.close(); s.db.close(); }
});

test("a rolling failure is counted and never reaches the real flow", () => {
  const s = build(fresh(), { now: T_END }, { rollingHoldout: { mode: "SHADOW" } }); seed(s, 3 * 360 + 60);
  try {
    scripted(s, ({ rolling, role }) => (rolling ? new Error("boom") : role === "VALIDATION" ? "CHALLENGER_BETTER" : null));
    s.orchestrator.recover();
    const report = s.orchestrator.tick();
    assert.equal(report.status, "OK");
    for (const e of report.experiments) assert.equal(e.outcome.status, "COMPLETED");
    const summary = s.orchestrator.rollingHoldout();
    assert.ok(summary.errors + summary.insufficientEvidence >= 1);
    assert.equal(summary.pass, 0);
  } finally { s.db.close(); }
});

test("without enough history the rolling check is refused with a fixed code", () => {
  const s = build(fresh(), { now: T_END }, { rollingHoldout: { mode: "SHADOW" } }); seed(s, 400);
  try {
    scripted(s, ({ role, rolling }) => (!rolling && role === "VALIDATION" ? "CHALLENGER_BETTER" : null));
    s.orchestrator.recover(); s.orchestrator.tick();
    const summary = s.orchestrator.rollingHoldout();
    assert.ok(Object.keys(summary.refused).some((code) => /^ROLLING_INSUFFICIENT_HISTORY/.test(code)), JSON.stringify(summary));
    for (const code of Object.keys(summary.refused)) assert.match(code, /^[A-Z][A-Z0-9_]{1,47}$/);
  } finally { s.db.close(); }
});

test("rolling session records are left out of the failure counters", () => {
  const { isRollingRecord } = require("../dist/apps/cloud/src/researchExperimentOrchestrator.js");
  assert.equal(isRollingRecord({ provenance: { sessionId: "research-2026-11-01-sma_5_12_rolling" } }), true);
  assert.equal(isRollingRecord({ provenance: { sessionId: "research-2026-11-01-sma_5_12" } }), false);
  assert.equal(isRollingRecord({}), false);
});
