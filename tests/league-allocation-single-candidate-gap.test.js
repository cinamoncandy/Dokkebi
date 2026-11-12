const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { adviseLeagueCapitalAllocation } = require(path.resolve('dist/apps/desktop/src/cloud/leagueCapitalAllocation.js'));

// Characterization of a gap found on 2026-11-12 (docs/PROPOSAL_SINGLE_CANDIDATE_DEPLOYMENT_GAP_20261112.md):
// the closed-learning worker deploys to PAPER only when the League allocation has exactly ONE entry
// (scripts/closed-learning-research-worker.js), but the real Research run builds its League with the DEFAULT allocation policy.
// This test records what the default policy produces; it does not endorse it. If the policy or the worker rule is changed on purpose,
// update this test together with the proposal.
const entry = (i, family) => ({ id: `c${i}`, familyId: family, eligible: true, outcome: 'QUALIFIED_FOR_LEAGUE', rank: i + 1, leagueScore: 1 - i * 0.1, evidenceBreadth: 1, sourceDatasetIds: ['d'] });
const standing = (n, families) => ({ schemaVersion: 1, generatedAt: '2026-11-12T00:00:00.000Z', entries: Array.from({ length: n }, (_, i) => entry(i, families === 1 ? 'f' : `f${i % families}`)) });
const outcome = (n, families, policy) => {
  try { return adviseLeagueCapitalAllocation(standing(n, families), policy).entries.length; } catch (error) { return error.code; }
};

test('default policy: qualified candidates never produce a single allocation entry', () => {
  assert.equal(outcome(0, 1), 'NO_ALLOCATABLE_CANDIDATES');
  assert.equal(outcome(1, 1), 'INSUFFICIENT_DIVERSIFICATION_CAPACITY');
  assert.equal(outcome(2, 2), 'INSUFFICIENT_DIVERSIFICATION_CAPACITY');
  assert.equal(outcome(3, 3), 3);
  assert.equal(outcome(5, 5), 5);
  assert.equal(outcome(8, 8), 5, 'the default policy caps the book at five candidates');
});

test('a policy with one candidate at full weight does produce exactly one entry (the owner baseline uses it)', () => {
  const single = { maximumCandidateWeight: 1, maximumCandidateCount: 1, maximumFamilyWeight: 1 };
  assert.equal(outcome(1, 1, single), 1);
  assert.equal(outcome(4, 4, single), 1);
  assert.equal(outcome(0, 1, single), 'NO_ALLOCATABLE_CANDIDATES', 'no qualified candidate still means no allocation under any policy');
});
