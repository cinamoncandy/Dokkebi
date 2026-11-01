"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ClosedLearningLoopStatusTracker } = require("../dist/apps/cloud/src/closedLearningLoopStatus.js");

test("the loop status records bootstrap and rollover steps as codes and counts evaluated cycles and deployments", () => {
  const t = new ClosedLearningLoopStatusTracker();
  assert.equal(t.snapshot(), null, "nothing before the first tick");
  t.observeBootstrap({ status: "WAITING_RESEARCH_SNAPSHOT" });
  t.observeRollover({ status: "WAITING_FOR_REALIZED_FILL", periodId: "period-secret-id" }, 1000);
  assert.deepEqual(t.snapshot(), { lastTickAt: 1000, ticks: 1, bootstrap: "WAITING_RESEARCH_SNAPSHOT", rollover: "WAITING_FOR_REALIZED_FILL", cyclesEvaluated: 0, deployments: 0 });
  t.observeRollover({ status: "CLOSED_AND_EVALUATED", cycle: { status: "EXECUTED", record: { decision: { outcome: "REJECTED" } } } }, 2000);
  t.observeRollover({ status: "CLOSED_AND_EVALUATED", cycle: { status: "EXECUTED", record: { decision: { outcome: "QUALIFIED_FOR_LEAGUE" }, paperDeployment: { deploymentId: "d" } } } }, 3000);
  t.observeRollover({ status: "BLOCKED", reason: "MULTIPLE_OPEN_PAPER_PERIODS" }, 4000);
  const s = t.snapshot();
  assert.equal(s.ticks, 4);
  assert.equal(s.cyclesEvaluated, 2);
  assert.equal(s.deployments, 1);
  assert.equal(s.rollover, "BLOCKED");
  assert.equal(s.rolloverReason, "MULTIPLE_OPEN_PAPER_PERIODS");
  assert.equal(s.lastCycleOutcome, "QUALIFIED_FOR_LEAGUE", "the last evaluated outcome is kept across waiting ticks");
  assert.doesNotMatch(JSON.stringify(s), /period-secret-id/, "rollover periodId/reason text never leaks");
  assert.deepEqual(Object.keys(s).filter((key) => key !== "evidence").includes("deploymentId"), false, "identities live only under evidence");
  assert.equal(s.evidence.deploymentId, "d");
});

test("free-text reasons are reduced to their leading code or dropped, and an error tick keeps the counts", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeRollover({ status: "ACCOUNT_REPLACED_PERIOD_REOPENED", reason: "retired:paper-period-123" }, 1);
  assert.equal(t.snapshot().rolloverReason, undefined, "lower-case free text is not a code");
  t.observeRollover({ status: "BLOCKED", reason: "PAPER_ACCOUNT_REPLACED_RETIREMENT_UNAVAILABLE:detail" }, 2);
  assert.equal(t.snapshot().rolloverReason, "PAPER_ACCOUNT_REPLACED_RETIREMENT_UNAVAILABLE");
  t.observeError(3);
  assert.equal(t.snapshot().rollover, "ERROR");
  assert.equal(t.snapshot().ticks, 3);
  assert.equal(t.snapshot().cyclesEvaluated, 0);
});

test("the production composition feeds every loop tick into the status and hands it to the runtime", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "apps", "cloud", "src", "closedLearningProductionRuntime.ts"), "utf8");
  assert.match(src, /loopStatus\.observeBootstrap\(bootstrap\)/);
  assert.match(src, /loopStatus\.observeRollover\(await runClosedLearningRolloverAsync\(\), Date\.now\(\)\)/);
  assert.match(src, /loopStatus\.observeError\(Date\.now\(\), tickErrorClass\(error\)\); persistLastBlocked\(\); throw error;/, "an error tick persists its reason before the scheduler fails closed");
  assert.match(src, /loopStatus\.observeRollover\(await runClosedLearningRolloverAsync\(\), Date\.now\(\)\);\r?\n\s*persistLastBlocked\(\);/, "a blocked tick persists its reason");
  assert.match(src, /loopStatus\.seedLastBlocked\(readClosedLearningBlocked\(config\.cloudStateDbPath\)\)/, "the persisted reason seeds the status after a restart");
  assert.match(src, /loopStatus\.observePeriods\(periods\.listOpenPeriods\(\)\[0\], periods\.listRealizedPeriods\(\)(?:, pendingPeriods\.dispositions\(\))?\)/, "every tick reads the canonical period identities");
  assert.match(src, /closedLearningStatus: \(\) => loopStatus\.snapshot\(\),\r?\n\s*researchIntervalTicks: \(\) => researchExperiments\?\.experimentTicksByInterval\(\) \?\? null,\r?\n\s*microstructureRecorder,\r?\n\s*orderBookCollector,\r?\n\s*futuresCollector,\r?\n\s*\}\);/);
});

test("evidence correlates the open period, the latest realized period and the latest Research cycle", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeRollover({ status: "WAITING_FOR_KST_DAY_ROLLOVER" }, 1);
  const hex = (c) => c.repeat(64);
  const open = { periodId: "owner-baseline:KRW-XRP:1791331979980", market: "KRW-XRP", periodStartAt: 1791331979980, candidateProvenance: [{ candidateId: "owner-baseline-sma-5-20" }], observations: [{ status: "FILLED" }, { status: "WAIT" }] };
  const realized = [
    { record: { recordId: "old", periodIndex: 0, periodEndAt: 10, costEvidence: { evidenceFingerprintSha256: hex("b") } } },
    { record: { recordId: "owner-baseline:KRW-BTC:1", periodIndex: 1, periodEndAt: 20, canonicalOutcomeReceiptFingerprint: hex("a"), costEvidence: { evidenceFingerprintSha256: hex("c") } } },
  ];
  t.observePeriods(open, realized);
  assert.deepEqual(t.snapshot().evidence, {
    openPeriodId: open.periodId, openMarket: "KRW-XRP", openCandidateId: "owner-baseline-sma-5-20", openPeriodStartAt: 1791331979980, openObservations: 2, openFilledObservations: 1,
    realizedPeriods: 2, baselineObservations: 0, realizedPeriodId: "owner-baseline:KRW-BTC:1", realizedPeriodEndAt: 20, realizedOutcomeFingerprint: hex("a"), realizedCostEvidenceFingerprint: hex("c"),
  });
  t.observeRollover({ status: "CLOSED_AND_EVALUATED", cycle: { status: "EXECUTED", record: { cycleId: "closed-learning:c1", evidenceId: "closed-learning-paper:x", evidenceFingerprintSha256: hex("d"), decision: { decisionId: "decision-1", outcome: "INSUFFICIENT", decisionReference: "research:decision-1" } } } }, 2);
  const evidence = t.snapshot().evidence;
  assert.equal(evidence.cycleId, "closed-learning:c1");
  assert.equal(evidence.cycleEvidenceFingerprint, hex("d"));
  assert.equal(evidence.decisionReference, "research:decision-1");
  assert.equal(evidence.openPeriodId, open.periodId, "period identities survive the next rollover tick");
  assert.equal(evidence.decisionCandidateId, undefined);
});

// ---- durable cycle evidence: a restart must not erase the last lap -------------------------------------------------
const { SqliteDatabase } = require("../dist/packages/storage/src/index.js");
const { SqliteEvolutionLearningLedger } = require("../dist/packages/storage/src/evolutionLearningLedger.js");
const { ClosedLearningEvolutionLedgerRepository } = require("../dist/apps/cloud/src/closedLearningEvolutionLedgerRepository.js");

const HEX = (seed) => seed.repeat(64).slice(0, 64);
const cycleRecord = (seed, outcome, recordedAt, extra = {}) => ({
  cycleId: `closed-learning:${HEX(seed)}`, evidenceId: `evidence-${seed}`, evidenceFingerprintSha256: HEX(seed),
  decision: { decisionId: `decision-${seed}`, outcome, decisionReference: `research:decision-${seed}`, reasons: ["NOT_BETTER_THAN_COST"], ...(outcome === "QUALIFIED_FOR_LEAGUE" ? { candidateId: "candidate-b", candidateVersion: "v2" } : {}) },
  recordedAt, ...extra,
});

test("the durable ledger summary counts recorded cycles and reports the most recent one", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    const repo = new ClosedLearningEvolutionLedgerRepository(new SqliteEvolutionLearningLedger(db));
    assert.deepEqual(repo.summary(), { cyclesRecorded: 0 });
    repo.append(cycleRecord("a", "REJECTED", 1_000));
    repo.append(cycleRecord("b", "INSUFFICIENT", 5_000));
    const summary = repo.summary();
    assert.equal(summary.cyclesRecorded, 2);
    assert.equal(summary.latest.cycleId, `closed-learning:${HEX("b")}`);
    assert.equal(summary.latest.decision.outcome, "INSUFFICIENT");
    // A restart (a fresh repository over the same database) reads the same truth.
    assert.deepEqual(new ClosedLearningEvolutionLedgerRepository(new SqliteEvolutionLearningLedger(db)).summary().latest.cycleId, summary.latest.cycleId);
  } finally { db.close(); }
});

test("after a restart the status shows the last durable cycle identities but keeps the per-process counters at zero", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeBootstrap({ status: "EXISTING_PAPER_STATE" });
  t.observeRollover({ status: "WAITING_FOR_CANONICAL_BOUNDARY" }, 1000);
  t.observeDurableCycles({ cyclesRecorded: 3, latest: cycleRecord("c", "REJECTED", 9_000) });
  const s = t.snapshot();
  assert.equal(s.cyclesEvaluated, 0, "the in-process counter is not backfilled");
  assert.equal(s.lastCycleOutcome, "REJECTED", "the durable outcome fills in when this process has seen none");
  assert.equal(s.evidence.cycleId, `closed-learning:${HEX("c")}`);
  assert.equal(s.evidence.cycleEvidenceFingerprint, HEX("c"));
  assert.equal(s.evidence.decisionId, "decision-c");
  assert.equal(s.evidence.cyclesRecorded, 3);
  assert.equal(s.evidence.lastCycleRecordedAt, 9_000);
  assert.doesNotMatch(JSON.stringify(s), /NOT_BETTER_THAN_COST/, "reasons never leave the module");
});

test("a cycle evaluated in this process wins over the durable copy", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeDurableCycles({ cyclesRecorded: 1, latest: cycleRecord("c", "REJECTED", 9_000) });
  t.observeRollover({ status: "CLOSED_AND_EVALUATED", cycle: { status: "EXECUTED", record: cycleRecord("d", "QUALIFIED_FOR_LEAGUE", 12_000, { paperDeployment: { deploymentId: "dep-d" } }) } }, 2000);
  t.observeDurableCycles({ cyclesRecorded: 2, latest: cycleRecord("d", "QUALIFIED_FOR_LEAGUE", 12_000) });
  const s = t.snapshot();
  assert.equal(s.cyclesEvaluated, 1);
  assert.equal(s.lastCycleOutcome, "QUALIFIED_FOR_LEAGUE");
  assert.equal(s.evidence.cycleId, `closed-learning:${HEX("d")}`);
  assert.equal(s.evidence.deploymentId, "dep-d");
  assert.equal(s.evidence.cyclesRecorded, 2);
});

// ---- review hardening ---------------------------------------------------------------------------------------------
test("the durable summary replays the ledger once and counts only valid cycles", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    const ledger = new SqliteEvolutionLearningLedger(db);
    const repo = new ClosedLearningEvolutionLedgerRepository(ledger);
    repo.append(cycleRecord("a", "REJECTED", 1_000));
    repo.append(cycleRecord("b", "INSUFFICIENT", 5_000));
    // A namespace-shaped but invalid entry in the shared ledger: neither counted nor allowed to hide the others.
    ledger.append({ opportunityId: "closed-learning:not-a-cycle:decision", problem: "x", hypothesis: "{}", evidenceReferences: ["closed-learning-evidence:e", "closed-learning-fingerprint:" + HEX("f")], changeReference: "x", validationStatus: "REJECTED", outcome: "UNDERPERFORMED", failureReason: "x", rollbackReference: null, reusable: true, recordedAt: new Date(9_000).toISOString() });
    let replays = 0;
    const counting = new ClosedLearningEvolutionLedgerRepository({ append: (r) => ledger.append(r), list: () => { replays += 1; return ledger.list(); } });
    const summary = counting.summary();
    assert.equal(replays, 1, "one replay no matter how many cycles");
    assert.equal(summary.cyclesRecorded, 2, "the invalid entry is not a recorded cycle");
    assert.equal(summary.latest.cycleId, `closed-learning:${HEX("b")}`);
  } finally { db.close(); }
});

test("a ledger failure propagates from summary(), and clearing withdraws every durable value that was published", () => {
  const broken = new ClosedLearningEvolutionLedgerRepository({ append: () => { throw new Error("x"); }, list: () => { throw new Error("ledger corrupted"); } });
  assert.throws(() => broken.summary(), /ledger corrupted/);
  const t = new ClosedLearningLoopStatusTracker();
  t.observeRollover({ status: "WAITING_FOR_CANONICAL_BOUNDARY" }, 1000);
  t.observeDurableCycles({ cyclesRecorded: 2, latest: cycleRecord("c", "REJECTED", 9_000) });
  assert.equal(t.snapshot().lastCycleOutcome, "REJECTED");
  t.clearDurableCycles();
  const s = t.snapshot();
  assert.equal(s.lastCycleOutcome, undefined, "the durable outcome is withdrawn, not left as if current");
  assert.equal(s.evidence, undefined, "no durable identity or count remains");
});

test("clearing the durable copy never removes what a cycle evaluated in this process observed", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeDurableCycles({ cyclesRecorded: 1, latest: cycleRecord("c", "REJECTED", 9_000) });
  t.observeRollover({ status: "CLOSED_AND_EVALUATED", cycle: { status: "EXECUTED", record: cycleRecord("d", "INSUFFICIENT", 12_000) } }, 2000);
  t.clearDurableCycles();
  const s = t.snapshot();
  assert.equal(s.lastCycleOutcome, "INSUFFICIENT");
  assert.equal(s.evidence.cycleId, `closed-learning:${HEX("d")}`);
  assert.equal(s.evidence.cyclesRecorded, undefined);
});

test("the durable evidence is visible even when the tick fails before a rollover result", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeDurableCycles({ cyclesRecorded: 4, latest: cycleRecord("c", "REJECTED", 9_000) });
  assert.equal(t.snapshot(), null, "nothing is published before the first tick result");
  t.observeError(1000);
  const s = t.snapshot();
  assert.equal(s.rollover, "ERROR");
  assert.equal(s.evidence.cyclesRecorded, 4);
  assert.equal(s.lastCycleOutcome, "REJECTED");
});

test("cycle failure receipts survive restart, deduplicate replay, and remain beside a later successful cycle", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    const ledger = new SqliteEvolutionLearningLedger(db);
    const repo = new ClosedLearningEvolutionLedgerRepository(ledger, () => 7_000);
    const input = { closedPeriodId: "period-7", evidenceId: "closed-learning-paper:e7", evidenceFingerprintSha256: HEX("e"), sourceCommitSha: "a".repeat(40), runtimeSourceCommitSha: "b".repeat(40), stage: "CYCLE", code: "RESEARCH_WORKER_FAILED" };
    const first = repo.appendFailure(input);
    assert.equal(repo.appendFailure(input).failureId, first.failureId);
    assert.equal(repo.failureSummary().failuresRecorded, 1, "same deterministic failure is appended once");
    repo.append(cycleRecord("7", "REJECTED", 8_000));
    const restarted = new ClosedLearningEvolutionLedgerRepository(ledger).failureSummary();
    assert.equal(restarted.failuresRecorded, 1, "success does not rewrite failure history");
    const t = new ClosedLearningLoopStatusTracker();
    t.observeDurableFailures(restarted);
    t.observeDurableCycles(repo.summary());
    t.observeRollover({ status: "WAITING_FOR_CANONICAL_BOUNDARY" }, 9_000);
    assert.equal(t.snapshot().evidence.latestFailurePeriodId, "period-7");
    assert.equal(t.snapshot().evidence.latestFailureCode, "RESEARCH_WORKER_FAILED");
    assert.equal(t.snapshot().evidence.cyclesRecorded, 1, "latest success is exposed separately");
    assert.doesNotMatch(JSON.stringify(t.snapshot()), /price|balance|exception/i);
  } finally { db.close(); }
});

test("identity-stage receipts replay through the existing ledger and status without creating cycles", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    const ledger = new SqliteEvolutionLearningLedger(db);
    const repo = new ClosedLearningEvolutionLedgerRepository(ledger, () => 7_000);
    const input = { closedPeriodId: "period-7", evidenceId: "closed-paper-period:period-7", evidenceFingerprintSha256: HEX("e"), sourceCommitSha: "b".repeat(40), runtimeSourceCommitSha: "b".repeat(40), stage: "IDENTITY", code: "RISK_FINGERPRINT_INVALID" };
    const receipt = repo.appendFailure(input);
    const restarted = new ClosedLearningEvolutionLedgerRepository(ledger);
    assert.equal(restarted.appendFailure(input).failureId, receipt.failureId);
    assert.equal(restarted.failureSummary().failuresRecorded, 1);
    assert.equal(restarted.summary().cyclesRecorded, 0);
    const tracker = new ClosedLearningLoopStatusTracker();
    tracker.observeDurableFailures(restarted.failureSummary());
    tracker.observeRollover({ status: "WAITING_FOR_CANONICAL_BOUNDARY" }, 9_000);
    assert.equal(tracker.snapshot().evidence.latestFailureStage, "IDENTITY");
    assert.equal(tracker.snapshot().evidence.latestFailureCode, input.code);
    const records = ledger.list();
    const changed = { ...records[0], hypothesis: records[0].hypothesis.replace("RISK_FINGERPRINT_INVALID", "OTHER_FAILURE") };
    const tampered = new ClosedLearningEvolutionLedgerRepository({ list: () => [changed], append: () => { throw new Error("no writes"); } });
    assert.throws(() => tampered.failureSummary(), /tampered/);
  } finally { db.close(); }
});

test("identity-stage failure survives closing and reopening its SQLite database", () => {
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "nusa-identity-receipt-"));
  const filename = path.join(directory, "learning.sqlite");
  const input = { closedPeriodId: "period-7", evidenceId: "closed-paper-period:period-7", evidenceFingerprintSha256: HEX("e"), sourceCommitSha: "b".repeat(40), runtimeSourceCommitSha: "b".repeat(40), stage: "IDENTITY", code: "RISK_FINGERPRINT_INVALID" };
  let db;
  try {
    db = new SqliteDatabase(filename);
    const first = new ClosedLearningEvolutionLedgerRepository(new SqliteEvolutionLearningLedger(db), () => 7_000).appendFailure(input);
    db.close();
    db = new SqliteDatabase(filename);
    const restarted = new ClosedLearningEvolutionLedgerRepository(new SqliteEvolutionLearningLedger(db), () => 8_000);
    assert.deepEqual(restarted.appendFailure(input), first);
    restarted.append(cycleRecord("7", "REJECTED", 9_000));
    assert.equal(restarted.summary().cyclesRecorded, 1);
    assert.deepEqual(restarted.failureSummary().receipts, [first]);
  } finally {
    db?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failure receipt survives process exit without SQLite close and repeated process replay", () => {
  const { spawnSync } = require("node:child_process");
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "nusa-failure-process-"));
  const filename = path.join(directory, "learning.sqlite");
  const input = { closedPeriodId: "period-crash", evidenceId: "closed-paper-period:period-crash", evidenceFingerprintSha256: HEX("e"), sourceCommitSha: "b".repeat(40), runtimeSourceCommitSha: "b".repeat(40), stage: "IDENTITY", code: "RISK_FINGERPRINT_INVALID" };
  const program = `
    const { SqliteDatabase } = require('./dist/packages/storage/src/index.js');
    const { SqliteEvolutionLearningLedger } = require('./dist/packages/storage/src/evolutionLearningLedger.js');
    const { ClosedLearningEvolutionLedgerRepository } = require('./dist/apps/cloud/src/closedLearningEvolutionLedgerRepository.js');
    const db = new SqliteDatabase(process.argv[1]);
    const repo = new ClosedLearningEvolutionLedgerRepository(new SqliteEvolutionLearningLedger(db), () => 7000);
    repo.appendFailure(JSON.parse(process.argv[2]));
    process.exit(23); // Deliberately bypass db.close(); never touches the runtime database.
  `;
  let db;
  try {
    let first;
    for (let attempt = 0; attempt < 3; attempt++) {
      const child = spawnSync(process.execPath, ["-e", program, filename, JSON.stringify(input)], {
        cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 10000,
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.signal, null);
      assert.equal(child.status, 23, child.stderr);
      db = new SqliteDatabase(filename);
      const repo = new ClosedLearningEvolutionLedgerRepository(new SqliteEvolutionLearningLedger(db));
      const summary = repo.failureSummary();
      assert.equal(summary.failuresRecorded, 1, "process replay must not duplicate failure history");
      first ??= summary.receipts[0];
      assert.deepEqual(summary.receipts, [first]);
      assert.equal(repo.summary().cyclesRecorded, 0, "failure replay must not fabricate cycles");
      db.close();
      db = undefined;
    }
  } finally {
    db?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed durable cycle failure evidence fails closed", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    const ledger = new SqliteEvolutionLearningLedger(db);
    ledger.append({ opportunityId: "closed-learning-failure:" + HEX("f"), problem: "x", evidenceReferences: ["closed-learning-evidence:e"], hypothesis: "{}", changeReference: "a".repeat(40), validationStatus: "CYCLE_FAILURE", outcome: "FAILED", failureReason: "FAILED", rollbackReference: null, reusable: true, recordedAt: new Date(1_000).toISOString() });
    assert.throws(() => new ClosedLearningEvolutionLedgerRepository(ledger).failureSummary(), /malformed|invalid/);
  } finally { db.close(); }
});

test("cycle failure receipts reject unbounded or non-canonical identities", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    const repo = new ClosedLearningEvolutionLedgerRepository(new SqliteEvolutionLearningLedger(db));
    const input = { closedPeriodId: "period-7", evidenceId: "closed-learning-paper:e7", evidenceFingerprintSha256: HEX("e"), sourceCommitSha: "a".repeat(40), runtimeSourceCommitSha: "b".repeat(40), stage: "CYCLE", code: "RESEARCH_WORKER_FAILED" };
    assert.throws(() => repo.appendFailure({ ...input, closedPeriodId: "p".repeat(513) }), /input is invalid/);
    assert.throws(() => repo.appendFailure({ ...input, evidenceId: " closed-learning-paper:e7" }), /input is invalid/);
    assert.equal(repo.failureSummary().failuresRecorded, 0, "rejected identities never reach the durable ledger");
  } finally { db.close(); }
});

// ---- the reason a tick was blocked must outlive the next tick ------------------------------------------------------
test("a BLOCKED reason is kept after later ticks succeed, so a transient failure is still readable", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeRollover({ status: "WAITING_FOR_KST_DAY_ROLLOVER" }, 1000);
  assert.equal(t.snapshot().lastBlockedReason, undefined, "nothing blocked yet");
  t.observeRollover({ status: "BLOCKED", reason: "MISSING_BENCHMARK_EVIDENCE:detail text never leaves" }, 2000);
  t.observeRollover({ status: "STALLED_PERIOD_REOPENED", reason: "continued:closed-learning-rollover:2:1" }, 2030);
  const s = t.snapshot();
  assert.equal(s.rollover, "STALLED_PERIOD_REOPENED", "the live step moved on");
  assert.equal(s.lastBlockedReason, "MISSING_BENCHMARK_EVIDENCE", "the earlier block is still reported, as a code only");
  assert.equal(s.lastBlockedAt, 2000);
  assert.doesNotMatch(JSON.stringify(s), /detail text/);
});

test("a later block replaces the earlier one, an uncoded block is labelled, and an error tick is recorded", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeRollover({ status: "BLOCKED", reason: "free text without a code" }, 1000);
  assert.equal(t.snapshot().lastBlockedReason, "BLOCKED_WITHOUT_CODE");
  t.observeRollover({ status: "BLOCKED", reason: "CANDIDATE_BINDING_MIXED" }, 2000);
  assert.equal(t.snapshot().lastBlockedReason, "CANDIDATE_BINDING_MIXED");
  t.observeError(3000);
  assert.equal(t.snapshot().lastBlockedReason, "TICK_ERROR");
  assert.equal(t.snapshot().lastBlockedAt, 3000);
});

test("an error on the very first tick is recorded too", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeError(500);
  assert.equal(t.snapshot().lastBlockedReason, "TICK_ERROR");
});

test("shadow totals appear in the evidence as integers, are withdrawn when malformed or not started, and the runtime wires them", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeRollover({ status: "WAITING_FOR_KST_DAY_ROLLOVER" }, 1);
  t.observeShadow({ since: 5, trades: 3, wins: 1, grossGainBp: 40, grossLossBp: 90, feeBp: 30 });
  assert.deepEqual({ ...t.snapshot().evidence }, { shadowSince: 5, shadowTrades: 3, shadowWins: 1, shadowGrossGainBp: 40, shadowGrossLossBp: 90, shadowFeeBp: 30 });
  t.observeShadow({ since: 5, trades: 1, wins: 2, grossGainBp: 0, grossLossBp: 0, feeBp: 0 });
  assert.equal(t.snapshot().evidence, undefined, "wins above trades is malformed and withdrawn");
  t.observeShadow({ since: 0, trades: 0, wins: 0, grossGainBp: 0, grossLossBp: 0, feeBp: 0 });
  assert.equal(t.snapshot().evidence, undefined, "a shadow that has not started publishes nothing");
  t.observeShadow(undefined);
  assert.equal(t.snapshot().evidence, undefined);
  const src = fs.readFileSync(path.join(__dirname, "..", "apps", "cloud", "src", "closedLearningProductionRuntime.ts"), "utf8");
  assert.match(src, /baselineShadow\?\.observe\(market, bars\)/, "the shadow reads the same completed minute bars the strategy reads");
  assert.match(src, /loopStatus\.observeShadow\(baselineShadow\.summary\(\)\)/);
  assert.match(src, /writeBaselineShadowRecord\(config\.cloudStateDbPath, persistable\)\) baselineShadow\.markUnpersisted\(\)/, "a failed write is retried on a later tick");
});

test("a failed tick publishes only a bounded error class, never the message", () => {
  const { ClosedLearningLoopStatusTracker, tickErrorClass } = require("../dist/apps/cloud/src/closedLearningLoopStatus.js");
  assert.equal(tickErrorClass(Object.assign(new Error("secret path /var/lib/x"), { code: "ERR_SQLITE_ERROR" })), "ERR_SQLITE_ERROR");
  assert.equal(tickErrorClass(new TypeError("boom")), "TYPEERROR");
  assert.equal(tickErrorClass("not an error"), "UNKNOWN_ERROR");
  const t = new ClosedLearningLoopStatusTracker(3_600_000);
  t.observeError(5, tickErrorClass(new RangeError("x")));
  const snap = t.snapshot();
  assert.equal(snap.lastBlockedReason, "TICK_ERROR");
  assert.equal(snap.lastErrorClass, "RANGEERROR");
  assert.ok(!JSON.stringify(snap).includes("secret"));
  t.observeError(6);
  assert.equal(t.snapshot().lastErrorClass, undefined, "an unclassified error clears the previous class");
});

test("tickErrorClass never throws, accepts only conventional codes, and a later non-error block clears the class", () => {
  const { ClosedLearningLoopStatusTracker, tickErrorClass } = require("../dist/apps/cloud/src/closedLearningLoopStatus.js");
  const hostile = new Error("x"); Object.defineProperty(hostile, "code", { get() { throw new Error("boom"); } });
  assert.equal(tickErrorClass(hostile), "UNKNOWN_ERROR");
  const hostileName = new Error("x"); Object.defineProperty(hostileName, "name", { get() { throw 1; } });
  assert.equal(tickErrorClass(hostileName), "UNKNOWN_ERROR");
  for (const bad of [null, undefined, Symbol("s"), { code: "TOKEN_abc" }, 42, "ERR_X"]) assert.equal(tickErrorClass(bad), "UNKNOWN_ERROR");
  assert.equal(tickErrorClass(Object.assign(new Error("m"), { code: "TOKEN_SECRET123" })), "ERROR", "an unconventional code is ignored; the name is used");
  assert.equal(tickErrorClass(Object.assign(new Error("m"), { code: "ENOSPC" })), "ENOSPC");
  assert.equal(tickErrorClass(Object.assign(new Error("m"), { code: 28 })), "ERROR");
  const t = new ClosedLearningLoopStatusTracker(3_600_000);
  t.observeError(1, tickErrorClass(Object.assign(new Error("m"), { code: "ENOSPC" })));
  assert.equal(t.snapshot().lastErrorClass, "ENOSPC");
  t.observeRollover({ status: "BLOCKED", reason: "REASON_X" }, 2);
  assert.equal(t.snapshot().lastBlockedReason, "REASON_X");
  assert.equal(t.snapshot().lastErrorClass, undefined, "the class is not paired with a different block reason");
});

test("null comparator figures appear as counts and signed bp, absent fields stay absent, and a malformed or inconsistent value withdraws them", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeRollover({ status: "WAITING_FOR_KST_DAY_ROLLOVER" }, 1);
  const full = { since: 5, seed: 20261030, baselineTrades: 3, baselineNetBp: -40, holdMarkets: 2, holdNetBp: -15, randomTrades: 3, randomWins: 1, randomNetBp: -55, randomSkipped: 0 };
  t.observeNullComparators(full);
  assert.deepEqual({ ...t.snapshot().evidence }, { nullSince: 5, nullSeed: 20261030, nullBaseTrades: 3, nullBaseNetBp: -40, nullHoldMarkets: 2, nullHoldNetBp: -15, nullRandTrades: 3, nullRandWins: 1, nullRandNetBp: -55, nullRandSkipped: 0 });
  t.observeNullComparators({ since: 5, seed: 20261030, randomTrades: 0, randomWins: 0, randomNetBp: 0, randomSkipped: 2 });
  const sparse = { ...t.snapshot().evidence };
  assert.equal(sparse.nullHoldNetBp, undefined, "no measurable hold span: absent, not zero");
  assert.equal(sparse.nullBaseNetBp, undefined, "baseline not comparable: absent, not zero");
  for (const bad of [{ ...full, randomWins: 4 }, { ...full, since: 0 }, { ...full, baselineNetBp: undefined }, { ...full, holdMarkets: 0 }, { ...full, randomNetBp: 1.5 }, { ...full, baselineTrades: -1 }, undefined]) {
    t.observeNullComparators(full);
    t.observeNullComparators(bad);
    assert.equal(t.snapshot().evidence, undefined, `withdrawn for ${JSON.stringify(bad)}`);
  }
});

test("the runtime publishes the null comparators beside the shadow and persists them on change", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "apps", "cloud", "src", "closedLearningProductionRuntime.ts"), "utf8");
  assert.match(src, /loopStatus\.observeNullComparators\(nullComparators\.summary\(\)\)/);
  assert.match(src, /writeNullComparatorsRecord\(config\.cloudStateDbPath, persistableNulls\)\) nullComparators\.markUnpersisted\(\)/);
});

test("the cycle count the first time this process reads the ledger is kept as the boot count and never moves", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeRollover({ status: "WAITING_FOR_REALIZED_FILL", periodId: "p" }, 1000);
  t.observeDurableCycles({ cyclesRecorded: 3, latest: cycleRecord("c", "REJECTED", 9_000) });
  t.observeDurableCycles({ cyclesRecorded: 4, latest: cycleRecord("d", "REJECTED", 12_000) });
  const s = t.snapshot();
  assert.equal(s.evidence.cyclesRecordedAtBoot, 3, "the first read in this process");
  assert.equal(s.evidence.cyclesRecorded, 4, "the current durable count still advances");
  const fresh = new ClosedLearningLoopStatusTracker();
  fresh.observeRollover({ status: "WAITING_FOR_REALIZED_FILL", periodId: "p" }, 1000);
  assert.equal(fresh.snapshot()?.evidence?.cyclesRecordedAtBoot, undefined, "no read yet, no boot count");
});

test("a ledger failure withdraws the boot count and a later read is never taken for the boot read", () => {
  const t = new ClosedLearningLoopStatusTracker();
  t.observeRollover({ status: "WAITING_FOR_REALIZED_FILL", periodId: "p" }, 1000);
  t.clearDurableCycles();
  t.observeDurableCycles({ cyclesRecorded: 5, latest: cycleRecord("c", "REJECTED", 9_000) });
  assert.equal(t.snapshot().evidence.cyclesRecordedAtBoot, undefined);
  assert.equal(t.snapshot().evidence.cyclesRecorded, 5);
});
