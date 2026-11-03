import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteDatabase } from "../../../packages/storage/src/index";
import type { RealizedPeriodRetentionGuard } from "../../../packages/storage/src/persistedPaperPeriodStore";
import { buildOwnerBaselinePaperPeriodInput } from "./ownerBaselinePaperPeriod";
import {
  PaperRealizedPeriodProducer,
  PaperRealizedPeriodProducerError,
  SqlitePaperRealizedPeriodRepository,
  paperExecutionObservationId,
  type PaperRealizedPeriodCloseInput,
  type PaperRealizedPeriodOpenInput,
} from "./paperRealizedPeriodProducer";

const BASE = 1_800_000_000_000;
const HASH = "a".repeat(64);

function advisory(generatedAt: number, candidateId = "candidate-a") {
  return {
    schemaVersion: 1 as const,
    generatedAt: new Date(generatedAt).toISOString(),
    policy: { maximumCandidateWeight: 1, minimumEvidenceBreadth: 0, maximumCandidateCount: 5, maximumFamilyWeight: 1 },
    entries: [{ id: candidateId, familyId: "family-a", rank: 1, leagueScore: 1, evidenceBreadth: 1, researchWeight: 1, reasons: ["NO_EXECUTION_AUTHORITY"], sourceDatasetIds: ["dataset-a"] }],
    excludedCandidateIds: [],
    reasons: ["NO_EXECUTION_AUTHORITY"],
    provenance: { sourceDatasetIds: ["dataset-a"] },
  };
}

function openPeriod(index = 0, periodId = `period-${index}`, candidateId = "candidate-a"): PaperRealizedPeriodOpenInput {
  const periodStartAt = BASE + index * 1_000;
  return { periodId, periodIndex: index, advisory: advisory(periodStartAt - 100, candidateId), candidateProvenance: [{ candidateId, datasetId: "dataset-a", datasetContentSha256: HASH }], periodStartAt };
}
function closePeriod(plan: PaperRealizedPeriodOpenInput, overrides: Partial<PaperRealizedPeriodCloseInput["envelope"]["record"]> = {}): PaperRealizedPeriodCloseInput {
  return {
    envelope: {
      record: {
        recordId: plan.periodId,
        periodIndex: plan.periodIndex,
        advisory: plan.advisory,
        periodStartAt: plan.periodStartAt,
        periodEndAt: plan.periodStartAt + 900,
        realizedReturns: { [plan.candidateProvenance[0]!.candidateId]: 0.02 },
        benchmarkReturn: 0.01,
        turnoverCostRate: 1,
        costEvidence: { evidenceId: `cost-${plan.periodId}`, source: "PAPER_EXECUTION_RECEIPT", evidenceKind: "CONSERVATIVE_MODEL", evidenceFingerprintSha256: HASH, observedAt: plan.periodStartAt + 1, feeRate: 0.001, spreadRate: 0.0005, slippageRate: 0.0005 },
        status: "COMPLETED",
        ...overrides,
      },
      candidateProvenance: plan.candidateProvenance,
    },
  };
}

// Retention is reference-aware by signature (v2 M1/A7); these fixtures cite no periods, so the
// correct guard for them protects nothing and the retention bound behaves as it always has.
const retentionGuard: RealizedPeriodRetentionGuard = { referencedRecordIds: () => new Set<string>() };

function producer(options?: Omit<ConstructorParameters<typeof PaperRealizedPeriodProducer>[1], "retentionGuard">) {
  const db = new SqliteDatabase(":memory:");
  const repository = new SqlitePaperRealizedPeriodRepository(db);
  return { db, repository, producer: new PaperRealizedPeriodProducer(repository, { retentionGuard, ...options }) };
}

function codeOf(action: () => unknown): string {
  try { action(); } catch (error) { if (error instanceof PaperRealizedPeriodProducerError) return error.code; throw error; }
  throw new Error("expected PaperRealizedPeriodProducerError");
}

describe("PaperRealizedPeriodProducer", () => {
  it("retires a canonical baseline continuation after restart, but preserves a candidate-ID-only spoof", () => {
    const state = producer();
    try {
      const original = buildOwnerBaselinePaperPeriodInput({ market: "KRW-XRP", periodIndex: 5, periodStartAt: BASE, sourceCommitSha: "a".repeat(40) });
      const continuation = { ...original, periodId: `closed-learning-rollover:5:${BASE}` };
      state.producer.openPeriod(continuation);
      const restarted = new PaperRealizedPeriodProducer(state.repository, { retentionGuard });
      restarted.retireOpenPeriodForReplacement(continuation.periodId, "SUPERSEDED_BY_QUALIFIED_CHALLENGER:challenger-a");
      assert.equal(restarted.listOpenPeriods().length, 0);
      assert.equal(state.repository.getPending(continuation.periodId), undefined);
      const spoof = openPeriod(6, "forged-baseline", "owner-baseline-sma-5-20");
      restarted.openPeriod(spoof);
      assert.equal(codeOf(() => restarted.retireOpenPeriodForReplacement(spoof.periodId, "SUPERSEDED_BY_QUALIFIED_CHALLENGER:challenger-a")), "PERIOD_REPLACEMENT_FORBIDDEN");
      assert.equal(restarted.listOpenPeriods()[0]?.periodId, spoof.periodId);
      assert.notEqual(state.repository.getPending(spoof.periodId), undefined);
    } finally { state.db.close(); }
  });

  it("reserves slots so several FILLED observations still fit after sampled non-fill observations saturate, and the total cap holds", () => {
    const state = producer();
    try {
      const plan = state.producer.openPeriod(openPeriod());
      let id = 0;
      const next = (status: "WAIT" | "FILLED") => state.producer.observeExecution({ observationId: `obs-${id++}`, observedAt: plan.periodStartAt + 1 + id, status });
      const size = () => state.producer.listOpenPeriods()[0]!.observationIds.length;
      for (let i = 0; i < 400_000 && size() < 1_008; i += 1) next("WAIT");
      assert.equal(size(), 1_008); // non-fill sampling stops 16 short of the cap
      for (let i = 0; i < 100_000; i += 1) next("WAIT");
      assert.equal(size(), 1_008);
      for (let i = 0; i < 16; i += 1) assert.equal(next("FILLED"), "RECORDED");
      assert.equal(size(), 1_024);
      assert.equal(codeOf(() => next("FILLED")), "OBSERVATION_LIMIT"); // total cap unchanged
    } finally { state.db.close(); }
  });

  it("appends exactly one canonical #885 envelope and replays it after restart", () => {
    const state = producer();
    try {
      const plan = state.producer.openPeriod(openPeriod());
      state.producer.observeExecution({ observationId: "paper-tick-a", observedAt: plan.periodStartAt + 1, status: "WAIT" });
      const expected = closePeriod(plan);
      assert.deepEqual(state.producer.closePeriod(expected), expected.envelope);
      const restarted = new PaperRealizedPeriodProducer(new SqlitePaperRealizedPeriodRepository(state.db), { retentionGuard });
      assert.deepEqual(restarted.listRealizedPeriods(), [expected.envelope]);
      assert.equal(Number((state.db.connection.prepare("SELECT COUNT(*) AS count FROM research_paper_forward_periods").get() as { count: number }).count), 1);
      assert.equal(Number((state.db.connection.prepare("SELECT COUNT(*) AS count FROM paper_realized_periods").get() as { count: number }).count), 0);
    } finally { state.db.close(); }
  });

  it("deduplicates identical observations/close and rejects identity or outcome conflicts", () => {
    const state = producer();
    try {
      const plan = state.producer.openPeriod(openPeriod());
      state.producer.observeExecution({ observationId: "paper-tick-a", observedAt: plan.periodStartAt + 1, status: "FILLED" });
      assert.equal(codeOf(() => state.producer.observeExecution({ observationId: "paper-tick-a", observedAt: plan.periodStartAt + 2, status: "FILLED" })), "OBSERVATION_ID_CONFLICT");
      const close = closePeriod(plan);
      assert.deepEqual(state.producer.closePeriod(close), close.envelope);
      assert.deepEqual(state.producer.closePeriod(close), close.envelope);
      assert.equal(codeOf(() => state.producer.closePeriod({ envelope: { ...close.envelope, record: { ...close.envelope.record, benchmarkReturn: 0.9 } } })), "PERIOD_ID_CONFLICT");
    } finally { state.db.close(); }
  });

  it("survives restart between open and close with observations retained", () => {
    const state = producer();
    try {
      const plan = state.producer.openPeriod(openPeriod());
      state.producer.observeExecution({ observationId: "paper-tick-a", observedAt: plan.periodStartAt + 1, status: "BLOCKED" });
      const recovered = new PaperRealizedPeriodProducer(new SqlitePaperRealizedPeriodRepository(state.db), { retentionGuard });
      assert.equal(recovered.listOpenPeriods()[0]!.observationIds[0], "paper-tick-a");
      recovered.closePeriod({ envelope: closePeriod(plan, { status: "HALTED" }).envelope });
      assert.equal(recovered.listRealizedPeriods()[0]!.record.status, "HALTED");
    } finally { state.db.close(); }
  });

  it("recovers only the schema-v1 successor after a schema-v2 terminal disposition and keeps replay idempotent", () => {
    const state = producer();
    const successorState = producer();
    try {
      state.producer.openPeriod(openPeriod(0));
      successorState.producer.openPeriod(openPeriod(1));
      const original = state.repository.getPending("period-0")!;
      const successor = successorState.repository.getPending("period-1")!;
      const request = { original, successor, reason: { stage: "PERIOD_CLOSE" as const, code: "INCOMPLETE_EXECUTION_COST_EVIDENCE" as const, boundaryAt: successor.periodStartAt, sourceRuntimeSha: null, blockedEvidenceFingerprintSha256: HASH } };
      const receipt = state.repository.markPendingIneligible(request);
      const restarted = new PaperRealizedPeriodProducer(new SqlitePaperRealizedPeriodRepository(state.db), { retentionGuard });
      assert.deepEqual(restarted.listOpenPeriods().map((item) => item.periodId), ["period-1"]);
      assert.equal(restarted.nextPeriodIndex(), 2);
      assert.deepEqual(state.repository.markPendingIneligible(request), receipt, "replay returns the immutable receipt");
      assert.equal(state.repository.listPending().length, 1, "replay never duplicates the successor");
      assert.equal(state.repository.listPendingDispositions().length, 1, "terminal original remains exactly once");
    } finally { state.db.close(); successorState.db.close(); }
  });

  it("rejects missing cost provenance, candidate/provenance retirement, and chronology overlap", () => {
    const state = producer();
    try {
      const first = state.producer.openPeriod(openPeriod(0));
      state.producer.observeExecution({ observationId: "first", observedAt: first.periodStartAt + 1, status: "WAIT" });
      assert.equal(codeOf(() => state.producer.closePeriod(closePeriod(first, { costEvidence: undefined as never }))), "MISSING_COST_PROVENANCE");
      assert.equal(codeOf(() => state.producer.closePeriod({ envelope: { ...closePeriod(first).envelope, record: { ...closePeriod(first).envelope.record, advisory: advisory(first.periodStartAt - 99, "retired-candidate") }, candidateProvenance: [{ candidateId: "retired-candidate", datasetId: "dataset-a", datasetContentSha256: HASH }] } })), "PROVENANCE_CONFLICT");
      state.producer.closePeriod(closePeriod(first));
      const second = state.producer.openPeriod({ ...openPeriod(1), advisory: advisory(BASE + 400), periodStartAt: BASE + 500 });
      state.producer.observeExecution({ observationId: "second", observedAt: second.periodStartAt + 1, status: "WAIT" });
      assert.equal(codeOf(() => state.producer.closePeriod(closePeriod(second))), "PERIOD_CHRONOLOGY_CONFLICT");
    } finally { state.db.close(); }
  });

  it("keeps rejected and halted periods in deterministic bounded canonical history", () => {
    const state = producer({ maximumPeriods: 2 });
    try {
      for (const index of [0, 1, 2]) {
        const plan = state.producer.openPeriod(openPeriod(index));
        state.producer.observeExecution({ observationId: `observation-${index}`, observedAt: plan.periodStartAt + 1, status: "REJECTED" });
        state.producer.closePeriod(closePeriod(plan, { status: index === 1 ? "HALTED" : "REJECTED" }));
      }
      assert.deepEqual(state.producer.listRealizedPeriods().map((item) => item.record.periodIndex), [1, 2]);
    } finally { state.db.close(); }
  });

  it("rejects malformed/secret input before persistence and emits exact lifecycle events", () => {
    const events: string[] = [];
    const state = producer({ now: () => BASE + 7_000, onLifecycleEvent: (event) => events.push(event.type === "PERIOD_REJECTED" ? `${event.type}:${event.reasonCode}` : event.type) });
    try {
      const forbiddenField = ["to", "ken"].join("");
      assert.equal(codeOf(() => state.producer.openPeriod({ ...openPeriod(), [forbiddenField]: "not-persisted" } as never)), "FORBIDDEN_FIELD");
      assert.equal(state.repository.listPending().length, 0);
      const plan = state.producer.openPeriod(openPeriod());
      state.producer.observeExecution({ observationId: "safe", observedAt: plan.periodStartAt + 1, status: "WAIT" });
      state.producer.closePeriod(closePeriod(plan));
      assert.deepEqual(events, ["PERIOD_REJECTED:FORBIDDEN_FIELD", "PERIOD_OPEN", "PERIOD_REALIZED_PERSISTED"]);
      state.db.connection.prepare("UPDATE research_paper_forward_periods SET payload_json = ? WHERE record_id = ?").run("{", plan.periodId);
      assert.equal(codeOf(() => state.producer.listRealizedPeriods()), "MALFORMED_PERSISTED_PERIOD");
    } finally { state.db.close(); }
  });

  it("has deterministic observation identities and no execution side effect", () => {
    assert.equal(paperExecutionObservationId("KRW-BTC", 10, "WAIT"), paperExecutionObservationId("KRW-BTC", 10, "WAIT"));
    const state = producer();
    try { assert.equal(state.producer.observeExecution({ observationId: "without-period", observedAt: BASE, status: "WAIT" }), "NO_ACTIVE_PERIOD"); }
    finally { state.db.close(); }
  });
});

describe("retiring an open period when the canonical PAPER account is replaced", () => {
  function accountWith(initialCapital: number, updatedAt: number) {
    return Object.freeze({ version: 1 as const, initialCapital, cash: initialCapital, equity: initialCapital, realizedPnL: 0, unrealizedPnL: 0, positions: Object.freeze([]), orders: Object.freeze([]), fills: Object.freeze([]), processedIdempotencyKeys: Object.freeze([]), updatedAt });
  }

  it("retires only a period whose account boundary differs, keeps realized history, and lets a new period open", () => {
    let current = accountWith(10_000_000, BASE);
    const events: string[] = [];
    const state = producer({ readCanonicalPaperAccount: () => current, onLifecycleEvent: (event) => events.push(`${event.type}:${"reasonCode" in event ? event.reasonCode : ""}`) });
    state.producer.openPeriodFromCanonicalAccount(openPeriod(0));
    assert.equal(codeOf(() => state.producer.retireOpenPeriodForAccountChange("period-0")), "ACCOUNT_NOT_CHANGED");
    assert.equal(state.producer.hasOpenPeriod(), true);

    current = accountWith(5_000, BASE + 5_000);
    const retired = state.producer.retireOpenPeriodForAccountChange("period-0");
    assert.equal(retired.accountBoundary?.initialCapital, 10_000_000);
    assert.equal(state.producer.hasOpenPeriod(), false);
    assert.equal(state.repository.getPending("period-0"), undefined);
    assert.ok(events.includes("PERIOD_REJECTED:ACCOUNT_REPLACED"));

    const reopened = state.producer.openPeriodFromCanonicalAccount({ ...openPeriod(0, "period-new"), periodStartAt: BASE + 5_000 });
    assert.equal(reopened.accountBoundary?.initialCapital, 5_000);
    assert.equal(codeOf(() => state.producer.retireOpenPeriodForAccountChange("missing")), "PERIOD_NOT_OPEN");
  });
});

describe("retiring an open period bound to a market the runtime no longer streams", () => {
  it("retires only a market-bound period whose market is not streamed and records why", () => {
    const events: string[] = [];
    const state = producer({ onLifecycleEvent: (event) => events.push(`${event.type}:${"reasonCode" in event ? event.reasonCode : ""}`) });
    state.producer.openPeriod({ ...openPeriod(0), market: "KRW-BTC" });
    assert.equal(codeOf(() => state.producer.retireOpenPeriodForUnstreamedMarket("period-0", ["KRW-BTC", "KRW-XRP"])), "MARKET_STILL_STREAMED");
    assert.equal(codeOf(() => state.producer.retireOpenPeriodForUnstreamedMarket("period-0", [])), "STREAMED_MARKETS_UNAVAILABLE");
    assert.equal(state.producer.hasOpenPeriod(), true);
    const retired = state.producer.retireOpenPeriodForUnstreamedMarket("period-0", ["krw-xrp"]);
    assert.equal(retired.market, "KRW-BTC");
    assert.equal(state.producer.hasOpenPeriod(), false);
    assert.equal(state.repository.getPending("period-0"), undefined);
    assert.equal(state.producer.listRealizedPeriods().length, 0, "nothing is closed or scored");
    assert.ok(events.includes("PERIOD_REJECTED:MARKET_NOT_STREAMED"));
    assert.equal(codeOf(() => state.producer.retireOpenPeriodForUnstreamedMarket("period-0", ["KRW-XRP"])), "PERIOD_NOT_OPEN");
  });

  it("never retires a period that carries no market", () => {
    const state = producer();
    state.producer.openPeriod(openPeriod(0));
    assert.equal(codeOf(() => state.producer.retireOpenPeriodForUnstreamedMarket("period-0", ["KRW-XRP"])), "MARKET_STILL_STREAMED");
    assert.equal(state.producer.hasOpenPeriod(), true);
  });
});

describe("mixed candidate binding detection, retirement receipt and ledger preservation", () => {
  const bindingFor = (candidateId: string, seed: string) => ({
    schemaVersion: 1 as const, status: "BOUND_UNVERIFIED" as const, authority: "PAPER_RESEARCH_ONLY" as const, liveAuthority: "NONE" as const, productionMutationAllowed: false as const,
    candidateId, datasetId: "dataset-a", datasetContentSha256: HASH, advisoryGeneratedAt: BASE, periodStartAt: BASE, advisoryFingerprintSha256: HASH, bindingFingerprintSha256: seed.repeat(64).slice(0, 64),
  });
  const fillWith = (id: string, at: number, candidateId: string, seed: string) => ({
    id, orderId: `order-${id}`, market: "KRW-XRP", side: "BUY" as const, quantity: 1, price: 100, fee: 0, filledAt: at,
    candidateProvenance: { schemaVersion: 1 as const, source: "CIO_DECISION_BINDING" as const, decisionAt: at, binding: bindingFor(candidateId, seed) },
  });
  const accountFor = (fills: readonly ReturnType<typeof fillWith>[], updatedAt: number) => ({
    version: 1 as const, initialCapital: 1_000_000, cash: 1_000_000, equity: 1_000_000, realizedPnL: 0, unrealizedPnL: 0,
    positions: [], orders: [], fills: [...fills].reverse(), processedIdempotencyKeys: [], updatedAt,
  });
  const setup = (fills: readonly ReturnType<typeof fillWith>[], extra: { events?: string[] } = {}) => {
    const updatedAt = BASE + 5_000;
    const state = producer({
      readCanonicalPaperAccount: () => accountFor(fills, updatedAt) as never,
      readCanonicalPaperFills: () => [...fills].reverse() as never,
      onLifecycleEvent: (event) => extra.events?.push(`${event.type}:${"reasonCode" in event ? event.reasonCode : ""}:${"retirementEvidenceFingerprintSha256" in event ? event.retirementEvidenceFingerprintSha256 : ""}`),
    });
    state.producer.openPeriod(openPeriod());
    return { state, updatedAt };
  };

  it("a single-binding window is evaluable: no receipt and no retirement", () => {
    const fills = [fillWith("a1", BASE + 100, "candidate-a", "1"), fillWith("a2", BASE + 200, "candidate-a", "1")];
    const { state } = setup(fills);
    assert.equal(state.producer.inspectOpenPeriodForMixedBinding("period-0"), null);
    assert.equal(codeOf(() => state.producer.retireOpenPeriodForMixedBinding("period-0")), "NOT_MIXED");
    assert.equal(state.producer.hasOpenPeriod(), true);
  });

  it("a window with two bindings yields a deterministic receipt and is retired unscored with the ledger untouched", () => {
    const fills = [fillWith("a1", BASE + 100, "candidate-a", "1"), fillWith("b1", BASE + 200, "candidate-b", "2"), fillWith("old", BASE - 50, "candidate-a", "3")];
    const events: string[] = [];
    const { state } = setup(fills, { events });
    const receipt = state.producer.inspectOpenPeriodForMixedBinding("period-0")!;
    assert.equal(receipt.reason, "CANDIDATE_BINDING_MIXED");
    assert.deepEqual(receipt.fillIds, ["a1", "b1"], "fills outside the window are not part of it");
    assert.equal(receipt.bindings.length, 2);
    assert.equal(receipt.validPerformanceEvidence, false);
    assert.equal(receipt.ledgerFillCount, 3, "the whole ledger is preserved");
    assert.deepEqual(state.producer.inspectOpenPeriodForMixedBinding("period-0"), receipt, "replay yields the same receipt");

    const before = JSON.stringify(fills);
    state.producer.retireOpenPeriodForMixedBinding("period-0");
    assert.equal(JSON.stringify(fills), before, "no fill is changed or removed");
    assert.equal(state.producer.hasOpenPeriod(), false);
    assert.equal(state.producer.listRealizedPeriods().length, 0, "no Performance evidence is produced");
    assert.ok(events.includes(`PERIOD_REJECTED:CANDIDATE_BINDING_MIXED:${receipt.evidenceFingerprintSha256}`));
    assert.equal(codeOf(() => state.producer.retireOpenPeriodForMixedBinding("period-0")), "PERIOD_NOT_OPEN", "no double retirement");
  });

  it("a restart before retirement derives the identical receipt from the same ledger", () => {
    const fills = [fillWith("a1", BASE + 100, "candidate-a", "1"), fillWith("b1", BASE + 200, "candidate-b", "2")];
    const first = setup(fills);
    const expected = first.state.producer.inspectOpenPeriodForMixedBinding("period-0")!;
    const restarted = new PaperRealizedPeriodProducer(new SqlitePaperRealizedPeriodRepository(first.state.db), {
      retentionGuard,
      readCanonicalPaperAccount: () => accountFor(fills, BASE + 5_000) as never,
      readCanonicalPaperFills: () => [...fills].reverse() as never,
    });
    assert.deepEqual(restarted.inspectOpenPeriodForMixedBinding("period-0"), expected);
    restarted.retireOpenPeriodForMixedBinding("period-0");
    const again = new PaperRealizedPeriodProducer(new SqlitePaperRealizedPeriodRepository(first.state.db), { retentionGuard });
    assert.equal(again.hasOpenPeriod(), false, "the retirement survives a restart");
  });

  it("a duplicated or stale fill does not distort the receipt", () => {
    const fills = [fillWith("a1", BASE + 100, "candidate-a", "1"), fillWith("b1", BASE + 200, "candidate-b", "2")];
    const clean = setup(fills).state.producer.inspectOpenPeriodForMixedBinding("period-0")!;
    const withDuplicate = [...fills, fills[0]!, fillWith("stale", BASE - 5_000, "candidate-c", "4")];
    const receipt = setup(withDuplicate).state.producer.inspectOpenPeriodForMixedBinding("period-0")!;
    assert.deepEqual(receipt.fillIds, clean.fillIds);
    assert.deepEqual(receipt.bindings, clean.bindings);
  });
});
