const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.cwd();
const load = p => require(path.join(root, 'dist', p));
const { createHistoricalDatasetManifest } = load('apps/desktop/src/cloud/researchDataset.js');
const { SqliteDatabase, SqliteResearchDatasetManifestStore } = load('packages/storage/src/index.js');
const { runResearchExperiment } = load('apps/cloud/src/researchExperimentRunner.js');
const { buildSmaResearchStrategy } = load('apps/cloud/src/backtestResearchEvaluator.js');
const M = Number(process.argv[2] ?? 60000), END = 5000 * M;
const rows = Array.from({ length: 400 }, (_, i) => ({ closeTimeMs: (4601 + i) * M, open: 10, high: 11, low: 9, close: 10, volume: 1 }))
  .filter(r => r.closeTimeMs < 4950 * M || r.closeTimeMs > 4955 * M);
const canonical = rows.map(r => ({ market: 'KRW-BTC', interval: `${M / 60000}m`, openTime: r.closeTimeMs - M, closeTime: r.closeTimeMs, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
const provenance = Object.fromEntries(['transformationGraphSha256', 'transformationConfigSha256', 'schemaContractSha256', 'qualitySuiteSha256', 'qualityResultsSha256', 'derivedFeatureLineageSha256', 'replayRuntimeSha256'].map(k => [k, 'a'.repeat(64)]));
provenance.rawSourceIdentitySha256s = ['b'.repeat(64)];
// This is an ordinary, schema-valid imported ALLOW dataset. No exchange absence proof exists.
const manifest = createHistoricalDatasetManifest(canonical, { source: 'LOCAL_IMPORT', allowMissing: true, provenance, createdAt: new Date(END).toISOString() });
const db = new SqliteDatabase(':memory:');
const store = new SqliteResearchDatasetManifestStore(db);
store.persistVerified(manifest, canonical);
assert.deepEqual(store.read(manifest.datasetId), JSON.parse(JSON.stringify(manifest)));
const strategy = buildSmaResearchStrategy({ strategyId: 'probe-sma', version: '1.0.0', market: 'KRW-BTC', fastPeriod: 3, slowPeriod: 8, takeProfitPercent: 4, stopLossPercent: 2, positionPercent: 50, maxPositionNotional: 500000 });
const spec = {
  sessionId: 'local-absence-boundary-probe', market: 'KRW-BTC', intervalMs: M, endCloseMs: END,
  windows: { intervalMs: M, trainMs: 200 * M, validationMs: 80 * M, holdoutMs: 80 * M, maxMissingRatio: 0 },
  champion: { strategy, config: { fast: 3, slow: 8 } }, challenger: { strategy, config: { fast: 3, slow: 8 } },
  featurePipeline: { version: 'closed-candle-agg-v1', config: { intervalMs: M } },
  evaluator: { version: 'backtest-eval-v1', modelVersion: 'dsl-backtest-v1' }, models: { fill: 'fill-close-v1', fee: 'fee-0.0005-v1', slippage: 'slip-5bps-v1' },
  sourceCommitSha: 'a'.repeat(40), experimentFamilyId: 'family-sma-btc', attempt: 1, hypothesisLineage: 'h0',
  split: { identity: 'wf-200-80-80' }, walkForwardConfig: { grid: { fast: [3], slow: [8] } }, datasetId: manifest.datasetId,
};
function probe(withManifest) {
  let evaluationCalls = 0;
  const outcome = runResearchExperiment({
    now: () => END,
    candles: { read: (_market, _interval, from, to) => rows.filter(r => r.closeTimeMs >= from && r.closeTimeMs <= to) },
    holdout: { claim: () => { throw Error('must not claim'); }, overlapsUsedHoldout: () => false },
    runExperiment: () => { evaluationCalls++; throw Error('LOCAL_PROBE_STOP_NO_REAL_EVALUATION'); },
    ...(withManifest ? { datasetManifest: { read: id => store.read(id) } } : {}),
  }, spec);
  return { evaluationCalls, outcome };
}
const baseline = probe(false), importedAllow = probe(true);
assert.equal(baseline.evaluationCalls, 0);
assert.equal(baseline.outcome.reason, 'WINDOWS_TOO_MANY_GAPS_HOLDOUT');
assert.equal(importedAllow.evaluationCalls, 0, 'ordinary ALLOW manifest must not be treated as exchange-confirmed absence');
console.log(JSON.stringify({ synthetic: true, baseCommit: 'ad0085fd994f68dd827ed52a022a50ad84057a13', intervalMs: M, missingCloses: 6, exchangeAbsenceProofs: 0, maxMissingRatio: 0, baseline, importedAllow, confirmedBoundaryBypass: false }, null, 2));
db.close();
