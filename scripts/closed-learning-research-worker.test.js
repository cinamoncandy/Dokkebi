"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { executeRequest, projectPaperDeployment, snapshotPathFromEnv, validateRequest } = require("./closed-learning-research-worker.js");

const HASH = "a".repeat(64);
const REPLAY = "b".repeat(64);
const SPEC = "c".repeat(64);
const DATASET_HASH = "d".repeat(64);
const SNAPSHOT = Object.freeze({ originalRunFingerprintSha256: HASH, candidates: Object.freeze([]) });
const qualification = Object.freeze({ schemaVersion: 1, candidates: Object.freeze([{ candidateId: "c1", outcome: "INSUFFICIENT", reasons: Object.freeze(["MORE_PAPER_EVIDENCE_REQUIRED"]), summary: "insufficient" }]), coverage: Object.freeze({ candidateCount: 1, qualifiedCount: 0, insufficientCount: 1, rejectedCount: 0 }), liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" });

function deps(overrides = {}) {
  class Store {
    constructor(filename) { this.filename = filename; }
    read(fingerprint) { return fingerprint === HASH ? (overrides.snapshot ?? SNAPSHOT) : undefined; }
  }
  return {
    FileResearchRunReplaySnapshotStore: Store,
    replayResearchRunWithPaperEvidence: () => Object.freeze({ run: Object.freeze({ provenance: Object.freeze({ runFingerprintSha256: REPLAY }) }), qualification }),
    ...overrides,
  };
}

const request = Object.freeze({ schemaVersion: 1, operation: "REPLAY_PAPER_EVIDENCE", originalRunFingerprintSha256: HASH, paperEvidenceByCandidate: Object.freeze({ c1: Object.freeze({ admission: Object.freeze({}), paperPerformance: Object.freeze({}) }) }) });
const env = Object.freeze({ NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH: path.resolve("/tmp/nusa-research-snapshots.json") });

function deployableFixture(candidateId = "qualified", market = "KRW-BTC") {
  const allocation = Object.freeze({
    schemaVersion: 1,
    generatedAt: new Date(1_000).toISOString(),
    policy: Object.freeze({ maximumCandidateWeight: 1, minimumEvidenceBreadth: 1, maximumCandidateCount: 1, maximumFamilyWeight: 1 }),
    entries: Object.freeze([{ id: candidateId, familyId: "sma", rank: 1, leagueScore: 2, evidenceBreadth: 5, researchWeight: 1, reasons: Object.freeze(["canonical"]), sourceDatasetIds: Object.freeze(["dataset-a"]) }]),
    excludedCandidateIds: Object.freeze([]),
    reasons: Object.freeze(["canonical allocation"]),
    provenance: Object.freeze({ sourceDatasetIds: Object.freeze(["dataset-a"]) }),
  });
  const replayQualification = Object.freeze({ ...qualification, candidates: Object.freeze([{ candidateId, outcome: "QUALIFIED_FOR_LEAGUE", reasons: Object.freeze([]), summary: "qualified" }]), coverage: Object.freeze({ candidateCount: 1, qualifiedCount: 1, insufficientCount: 0, rejectedCount: 0 }) });
  const snapshot = Object.freeze({
    originalRunFingerprintSha256: HASH,
    sourceCommitSha: "e".repeat(40),
    candidates: Object.freeze([{ id: candidateId, candidateSpecification: Object.freeze({ familyId: "sma-crossover", lineageId: "sma-v1", codeSha: "e".repeat(40), costModelVersion: "cost-v1", parameters: Object.freeze({ shortPeriod: 2, longPeriod: 3 }), candidateId }), experiment: Object.freeze({ manifest: Object.freeze({ market, datasetId: "dataset-a", contentSha256: DATASET_HASH }) }) }]),
  });
  const replay = Object.freeze({
    qualification: replayQualification,
    run: Object.freeze({
      allocation,
      provenance: Object.freeze({
        runFingerprintSha256: REPLAY,
        candidateBindings: Object.freeze([{ candidateId, specificationHash: SPEC, datasetId: "dataset-a", datasetContentSha256: DATASET_HASH }]),
      }),
    }),
  });
  return { allocation, replayQualification, snapshot, replay };
}

test("executes PAPER replay against the exact immutable Research snapshot with zero authority", () => {
  const result = executeRequest(request, env, deps());
  assert.equal(result.originalRunFingerprintSha256, HASH);
  assert.equal(result.qualification.candidates[0].outcome, "INSUFFICIENT");
  assert.equal(result.deployment.status, "NOT_DEPLOYABLE");
  assert.deepEqual(result.deployment.reasons, ["NO_ALLOCATION_ADVISORY"]);
  assert.equal(result.liveAuthority, "NONE");
  assert.equal(result.productionMutationAllowed, false);
  assert.equal(result.aiAuthority, "ZERO_AUTHORITY");
});

test("preserves REJECTED and QUALIFIED outcomes without survivor filtering", () => {
  const mixed = Object.freeze({ ...qualification, candidates: Object.freeze([
    { candidateId: "rejected", outcome: "REJECTED", reasons: Object.freeze(["FAIL"]), summary: "rejected" },
    { candidateId: "insufficient", outcome: "INSUFFICIENT", reasons: Object.freeze(["MORE"]), summary: "insufficient" },
    { candidateId: "qualified", outcome: "QUALIFIED_FOR_LEAGUE", reasons: Object.freeze([]), summary: "qualified" },
  ]), coverage: Object.freeze({ candidateCount: 3, qualifiedCount: 1, insufficientCount: 1, rejectedCount: 1 }) });
  const result = executeRequest(request, env, deps({ replayResearchRunWithPaperEvidence: () => ({ run: { provenance: { runFingerprintSha256: REPLAY } }, qualification: mixed }) }));
  assert.deepEqual(result.qualification.candidates.map((item) => item.outcome), ["REJECTED", "INSUFFICIENT", "QUALIFIED_FOR_LEAGUE"]);
  assert.equal(result.deployment.status, "NOT_DEPLOYABLE");
});

test("projects a deployment artifact only from one canonical League allocation entry", () => {
  const fixture = deployableFixture();
  const result = executeRequest(request, env, deps({ snapshot: fixture.snapshot, replayResearchRunWithPaperEvidence: () => fixture.replay }));
  assert.equal(result.deployment.status, "DEPLOYABLE");
  assert.deepEqual(result.deployment.artifact.advisory, fixture.allocation);
  assert.equal(result.deployment.artifact.candidateId, "qualified");
  assert.equal(result.deployment.artifact.candidateVersion, SPEC);
  assert.equal(result.deployment.artifact.market, "KRW-BTC");
  assert.deepEqual(result.deployment.artifact.candidateProvenance, [{ candidateId: "qualified", datasetId: "dataset-a", datasetContentSha256: DATASET_HASH }]);
  assert.equal(result.deployment.artifact.researchDecisionReference, `closed-learning-replay:${REPLAY}:qualified`);
  assert.deepEqual(result.deployment.artifact.researchLineage, {
    schemaVersion: 1,
    candidateId: "qualified",
    candidateVersion: SPEC,
    originalRunFingerprintSha256: HASH,
    replayRunFingerprintSha256: REPLAY,
    researchDecisionReference: `closed-learning-replay:${REPLAY}:qualified`,
    authority: "PAPER_RESEARCH_ONLY",
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
});

test("does not invent a winner when the canonical allocation contains multiple candidates", () => {
  const fixture = deployableFixture();
  const second = Object.freeze({ ...fixture.allocation.entries[0], id: "other", rank: 2, researchWeight: 0.5 });
  const multi = Object.freeze({ ...fixture.replay, run: Object.freeze({ ...fixture.replay.run, allocation: Object.freeze({ ...fixture.allocation, entries: Object.freeze([{ ...fixture.allocation.entries[0], researchWeight: 0.5 }, second]) }) }) });
  const projected = projectPaperDeployment(fixture.snapshot, multi, HASH);
  assert.equal(projected.status, "NOT_DEPLOYABLE");
  assert.deepEqual(projected.reasons, ["ALLOCATION_NOT_SINGLE_CANDIDATE"]);
  assert.equal(Object.hasOwn(projected, "artifact"), false);
});

test("requires the allocated candidate itself to remain qualified after PAPER replay", () => {
  const fixture = deployableFixture();
  const insufficient = Object.freeze({ ...fixture.replay, qualification: Object.freeze({ ...fixture.replayQualification, candidates: Object.freeze([{ candidateId: "qualified", outcome: "INSUFFICIENT", reasons: Object.freeze(["MORE"]), summary: "insufficient" }]), coverage: Object.freeze({ candidateCount: 1, qualifiedCount: 0, insufficientCount: 1, rejectedCount: 0 }) }) });
  const projected = projectPaperDeployment(fixture.snapshot, insufficient, HASH);
  assert.equal(projected.status, "NOT_DEPLOYABLE");
  assert.deepEqual(projected.reasons, ["ALLOCATED_CANDIDATE_NOT_QUALIFIED"]);
});

test("PAPER deployment cannot activate when the canonical PBO gate is insufficient", () => {
  const fixture = deployableFixture();
  const pboInsufficient = Object.freeze({
    ...fixture.replay,
    qualification: Object.freeze({
      ...fixture.replayQualification,
      candidates: Object.freeze([{
        candidateId: "qualified",
        outcome: "INSUFFICIENT",
        reasons: Object.freeze(["PBO_SURVIVAL_EVIDENCE_REQUIRED"]),
        summary: "insufficient",
      }]),
      coverage: Object.freeze({ candidateCount: 1, qualifiedCount: 0, insufficientCount: 1, rejectedCount: 0 }),
    }),
  });
  const projected = projectPaperDeployment(fixture.snapshot, pboInsufficient, HASH);
  assert.equal(projected.status, "NOT_DEPLOYABLE");
  assert.deepEqual(projected.reasons, ["ALLOCATED_CANDIDATE_NOT_QUALIFIED"]);
  assert.equal(Object.hasOwn(projected, "artifact"), false);
});

test("keeps non-KRW research valid but non-deployable to the current PAPER runtime", () => {
  const fixture = deployableFixture("qualified", "USDT-BTC");
  const projected = projectPaperDeployment(fixture.snapshot, fixture.replay, HASH);
  assert.equal(projected.status, "NOT_DEPLOYABLE");
  assert.deepEqual(projected.reasons, ["PAPER_MARKET_UNSUPPORTED"]);
});

test("fails closed on immutable candidate provenance drift", () => {
  const fixture = deployableFixture();
  const drifted = Object.freeze({ ...fixture.snapshot, candidates: Object.freeze([{ id: "qualified", candidateSpecification: Object.freeze({ familyId: "sma-crossover", lineageId: "sma-v1", codeSha: "e".repeat(40), costModelVersion: "cost-v1", parameters: Object.freeze({ shortPeriod: 2, longPeriod: 3 }), candidateId: "qualified" }), experiment: Object.freeze({ manifest: Object.freeze({ market: "KRW-BTC", datasetId: "dataset-a", contentSha256: "e".repeat(64) }) }) }]) });
  assert.throws(() => projectPaperDeployment(drifted, fixture.replay, HASH), /dataset provenance drifted/);
});

test("fails closed on missing snapshot, unsafe authority, forbidden credential-like fields, and non-durable path", () => {
  assert.throws(() => executeRequest(request, env, deps({ FileResearchRunReplaySnapshotStore: class { read() { return undefined; } } })), /snapshot is unavailable/);
  assert.throws(() => executeRequest(request, env, deps({ replayResearchRunWithPaperEvidence: () => ({ run: { provenance: { runFingerprintSha256: HASH } }, qualification: { ...qualification, liveAuthority: "LIVE" } }) })), /authority invariant/);
  assert.throws(() => validateRequest({ ...request, apiKey: "nope" }), /forbidden field/);
  assert.throws(() => snapshotPathFromEnv({ NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH: ":memory:" }), /absolute durable path/);
});

test("a refused League allocation names the refusal code next to NO_ALLOCATION_ADVISORY, and only a fixed code", () => {
  const withReason = (allocationUnavailableReason) => executeRequest(request, env, deps({ replayResearchRunWithPaperEvidence: () => ({ run: { provenance: { runFingerprintSha256: REPLAY }, allocation: null, allocationUnavailableReason }, qualification }) })).deployment;
  assert.deepEqual(withReason("INSUFFICIENT_DIVERSIFICATION_CAPACITY").reasons, ["ALLOCATION_INSUFFICIENT_DIVERSIFICATION_CAPACITY", "NO_ALLOCATION_ADVISORY"]);
  assert.deepEqual(withReason("NO_ALLOCATABLE_CANDIDATES").reasons, ["ALLOCATION_NO_ALLOCATABLE_CANDIDATES", "NO_ALLOCATION_ADVISORY"]);
  for (const bad of [undefined, null, "", "lowercase", "has spaces", "AB", `A${"B".repeat(60)}`, 7, "/some/path"]) {
    assert.deepEqual(withReason(bad).reasons, ["NO_ALLOCATION_ADVISORY"], `an unusable refusal code (${String(bad).slice(0, 12)}) adds nothing`);
  }
  assert.equal(withReason("NO_ALLOCATABLE_CANDIDATES").status, "NOT_DEPLOYABLE");
});
