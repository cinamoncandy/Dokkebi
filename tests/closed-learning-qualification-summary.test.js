const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { summarizeQualification } = require(path.resolve('dist/apps/cloud/src/closedLearningInitialPaperBootstrap.js'));

const candidate = (candidateId, outcome, reasons) => ({ candidateId, outcome, reasons, summary: 'x' });
const qualification = (candidates, coverage) => ({ schemaVersion: 1, candidates, coverage: { candidateCount: candidates.length, qualifiedCount: 0, insufficientCount: 0, rejectedCount: 0, ...coverage } });

test('counts each non-qualified candidate once per reason code, highest count first', () => {
  const summary = summarizeQualification(qualification([
    candidate('a', 'REJECTED', ['PBO_TOO_HIGH', 'COST_STRESS_FAILED', 'PBO_TOO_HIGH']),
    candidate('b', 'REJECTED', ['PBO_TOO_HIGH']),
    candidate('c', 'INSUFFICIENT', ['INSUFFICIENT_OOS_BENCHMARK_EVIDENCE', 'COST_STRESS_FAILED']),
    candidate('d', 'QUALIFIED_FOR_LEAGUE', ['SHOULD_NOT_COUNT']),
  ], { qualifiedCount: 1, insufficientCount: 1, rejectedCount: 2 }));
  assert.deepEqual({ ...summary.reasonCounts }, { PBO_TOO_HIGH: 2, COST_STRESS_FAILED: 2, INSUFFICIENT_OOS_BENCHMARK_EVIDENCE: 1 });
  assert.deepEqual(Object.keys(summary.reasonCounts), ['COST_STRESS_FAILED', 'PBO_TOO_HIGH', 'INSUFFICIENT_OOS_BENCHMARK_EVIDENCE'], 'ties are ordered by code');
  assert.equal(summary.candidateCount, 4);
  assert.equal(summary.qualifiedCount, 1);
  assert.equal(summary.insufficientCount, 1);
  assert.equal(summary.rejectedCount, 2);
});

test('only fixed upper-case codes are counted, and at most eight codes are kept', () => {
  const many = Array.from({ length: 12 }, (_, i) => `REASON_${String(i).padStart(2, '0')}`);
  const summary = summarizeQualification(qualification([
    candidate('a', 'REJECTED', [...many, 'free text with spaces', 'lowercase_code', 'AB', 'some/relative/path.txt', 7, null]),
  ]));
  assert.equal(Object.keys(summary.reasonCounts).length, 8);
  assert.ok(Object.keys(summary.reasonCounts).every((code) => /^[A-Z][A-Z0-9_]{2,63}$/.test(code)));
});

test('an all-qualified or empty set has no reason counts', () => {
  assert.deepEqual({ ...summarizeQualification(qualification([candidate('a', 'QUALIFIED_FOR_LEAGUE', [])], { qualifiedCount: 1 })).reasonCounts }, {});
  assert.deepEqual({ ...summarizeQualification(qualification([])).reasonCounts }, {});
});
