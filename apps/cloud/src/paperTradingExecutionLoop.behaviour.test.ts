import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteDatabase } from "../../../packages/storage/src/index";
import type { PersonalPaperOrderCommand } from "../../../packages/contracts/src/personalPaperOrderCommand";
import type { CioDecision, PaperCandidateExecutionBinding } from "./cioDecisionEngine";
import { CloudPaperCanonicalRiskGateway } from "./cloudPaperCanonicalRiskGateway";
import { CloudPaperExecutionBoundary } from "./cloudPaperExecutionBoundary";
import { buildPaperExecutionIntent, paperExecutionIntentCommandId, validatePaperExecutionIntent } from "./paperExecutionIntent";
import {
  PaperTradingExecutionLoop,
  SqliteCloudPaperAccountRepository,
  type PaperAccountRepository,
  type PaperAccountState,
  type PaperExecutionTick,
} from "./paperTradingExecutionLoop";
import type { PortfolioPlan } from "./portfolioOrchestrator";

/**
 * Behavioural replacements for the source-text assertions in paperTradingExecutionLoop.requalification.test.ts and
 * cloudPaperExecutionBoundary.requalification.test.ts. Only exported surface is imported; no pinned source is touched.
 */

const T0 = 1_800_000_000_000;

const marketOrder = (idempotencyKey: string, quantity = 1, side: "BUY" | "SELL" = "BUY"): PersonalPaperOrderCommand => ({
  schemaVersion: 1,
  authority: "PAPER_ONLY",
  productionMutationAllowed: false,
  idempotencyKey,
  market: "KRW-BTC",
  side,
  orderType: "MARKET",
  quantity,
});

const context = (now: number, marketPrice = 100_000) => ({
  now,
  marketPrice,
  observedAt: now,
  mode: "PAPER" as const,
  killSwitchActive: false,
  tradingAllowed: true,
  overallHealth: "HEALTHY" as const,
});

function withRealBoundary<T>(run: (boundary: CloudPaperExecutionBoundary, loop: PaperTradingExecutionLoop) => T, capital = 10_000_000): T {
  const db = new SqliteDatabase(":memory:");
  try {
    const loop = new PaperTradingExecutionLoop({ initialCapital: capital });
    const boundary = new CloudPaperExecutionBoundary({
      loop,
      riskGate: new CloudPaperCanonicalRiskGateway({ database: db, initialCapital: capital, sourceCommitSha: "execution-behaviour" }),
      readP0State: () => ({ openP0: false }),
    });
    return run(boundary, loop);
  } finally {
    db.close();
  }
}

describe("EXECUTION receives only approved orders (behaviour, real risk gateway)", () => {
  it("an order the risk gateway rejects never reaches the execution loop", () => {
    withRealBoundary((boundary, loop) => {
      const before = JSON.stringify(loop.snapshot());
      // 30 BTC at 100,000 is 3,000,000 KRW: above the 2,000,000 per-order ceiling. Account cash is irrelevant to the ceiling.
      const rejected = boundary.submitManualOrder("owner", marketOrder("over-limit-order-0001", 30), context(T0));
      assert.notEqual(rejected.status, "FILLED");
      assert.equal(rejected.fills.length, 0);
      assert.equal(JSON.stringify(loop.snapshot()), before, "account state is byte-identical after a rejected order");
      assert.equal(loop.snapshot().orders.length, 0);
      assert.equal(loop.snapshot().processedIdempotencyKeys.length, 0, "a rejected order does not consume its idempotency key");
    }, 1_000_000_000);
  });

  it("an approved order is executed exactly once and a replay of the same key is a duplicate that changes nothing", () => {
    withRealBoundary((boundary, loop) => {
      const first = boundary.submitManualOrder("owner", marketOrder("approved-order-0001", 1), context(T0));
      assert.equal(first.status, "FILLED", `${first.reason ?? ""} ${first.risk?.reasonCodes.join(",") ?? ""}`);
      assert.equal(first.fills.length, 1);
      const afterFirst = JSON.stringify(loop.snapshot());

      const replay = boundary.submitManualOrder("owner", marketOrder("approved-order-0001", 1), context(T0 + 1_000));
      assert.equal(replay.status, "DUPLICATE");
      assert.equal(replay.fills[0]?.id, first.fills[0]?.id);
      assert.equal(JSON.stringify(loop.snapshot()), afterFirst);
      assert.equal(loop.snapshot().fills.length, 1);
    });
  });

  it("reusing an idempotency key for a different order is a conflict and moves no money", () => {
    withRealBoundary((boundary, loop) => {
      const first = boundary.submitManualOrder("owner", marketOrder("approved-order-0002", 1), context(T0));
      assert.equal(first.status, "FILLED");
      const afterFirst = JSON.stringify(loop.snapshot());
      const conflict = boundary.submitManualOrder("owner", marketOrder("approved-order-0002", 2), context(T0 + 5_000));
      assert.equal(conflict.status, "REJECTED");
      assert.equal(conflict.reason, "PAPER_IDEMPOTENCY_CONFLICT");
      assert.equal(JSON.stringify(loop.snapshot()), afterFirst);
    });
  });

  it("a kill switch or an open P0 alert blocks the order before any state change", () => {
    withRealBoundary((boundary, loop) => {
      const before = JSON.stringify(loop.snapshot());
      const killed = boundary.submitManualOrder("owner", marketOrder("kill-switch-order-0001"), { ...context(T0), killSwitchActive: true });
      assert.notEqual(killed.status, "FILLED");
      assert.equal(JSON.stringify(loop.snapshot()), before);
    });
    const loop = new PaperTradingExecutionLoop({ initialCapital: 10_000_000 });
    const db = new SqliteDatabase(":memory:");
    try {
      const boundary = new CloudPaperExecutionBoundary({
        loop,
        riskGate: new CloudPaperCanonicalRiskGateway({ database: db, initialCapital: 10_000_000, sourceCommitSha: "p0" }),
        readP0State: () => ({ openP0: true }),
      });
      const before = JSON.stringify(loop.snapshot());
      const blocked = boundary.submitManualOrder("owner", marketOrder("open-p0-order-0001"), context(T0));
      assert.equal(blocked.status, "BLOCKED");
      assert.equal(blocked.reason, "OPEN_P0_ALERT");
      assert.equal(JSON.stringify(loop.snapshot()), before);
    } finally {
      db.close();
    }
  });
});

describe("EXECUTION strategy intent is content-addressed (behaviour)", () => {
  const SHA = "c".repeat(64);
  const binding: PaperCandidateExecutionBinding = Object.freeze({
    schemaVersion: 1,
    status: "BOUND_UNVERIFIED",
    authority: "PAPER_RESEARCH_ONLY",
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    candidateId: "candidate-alpha",
    datasetId: "dataset-1",
    datasetContentSha256: "a".repeat(64),
    advisoryGeneratedAt: 1_000,
    periodStartAt: 2_000,
    advisoryFingerprintSha256: "b".repeat(64),
    bindingFingerprintSha256: SHA,
  });
  const decision: CioDecision = Object.freeze({
    symbol: "KRW-BTC",
    action: "BUY",
    confidence: 0.9,
    risk: "LOW",
    allocation: 0.1,
    leverage: 1,
    score: 0.8,
    reasons: Object.freeze(["test"]),
    decidedAt: T0 - 1_000,
    paperCandidateBinding: binding,
  });
  const portfolio = (capital: number): PortfolioPlan => Object.freeze({
    allocations: Object.freeze([Object.freeze({ symbol: "KRW-BTC", instrument: "SPOT" as const, action: "BUY" as const, capital, share: 0.1, leverage: 1, confidence: 0.9, risk: "LOW" as const })]),
    deployedCapital: capital,
    cashCapital: 1_000_000 - capital,
    reservedCapital: 0,
    grossShare: 0.1,
    futuresShare: 0,
    decidedAt: T0 - 1_000,
  });

  const intentFor = (loop: PaperTradingExecutionLoop, capital: number, investmentPercent = 100) =>
    buildPaperExecutionIntent({ now: T0, market: "KRW-BTC", referencePrice: 100_000, portfolio: portfolio(capital), decision, state: loop.snapshot(), investmentPercent });

  it("the same plan yields the same intent and command id; a different plan yields a different one", () => {
    const loop = new PaperTradingExecutionLoop({ initialCapital: 1_000_000 });
    const a = intentFor(loop, 100_000);
    const b = intentFor(loop, 100_000);
    const c = intentFor(loop, 200_000);
    assert.equal(a.intentFingerprintSha256, b.intentFingerprintSha256);
    assert.equal(paperExecutionIntentCommandId(a), paperExecutionIntentCommandId(b));
    assert.notEqual(a.intentFingerprintSha256, c.intentFingerprintSha256);
    assert.notEqual(paperExecutionIntentCommandId(a), paperExecutionIntentCommandId(c));
    assert.equal(a.authority, "PAPER_ONLY");
    assert.equal(a.liveAuthority, "NONE");
    assert.equal(a.productionMutationAllowed, false);
    assert.equal(a.aiAuthority, "ZERO_AUTHORITY");
  });

  it("an intent whose content was altered after sealing is refused", () => {
    const loop = new PaperTradingExecutionLoop({ initialCapital: 1_000_000 });
    const intent = intentFor(loop, 100_000);
    assert.throws(() => validatePaperExecutionIntent({ ...intent, quantity: intent.quantity * 10 }), /FINGERPRINT_MISMATCH/);
    assert.throws(() => validatePaperExecutionIntent({ ...intent, authority: "LIVE" } as never));
  });

  it("scales only downward: investmentPercent shrinks the order and cannot enlarge it past the plan", () => {
    const loop = new PaperTradingExecutionLoop({ initialCapital: 1_000_000 });
    const full = intentFor(loop, 100_000, 100);
    const half = intentFor(loop, 100_000, 50);
    assert.ok(half.quantity < full.quantity);
    assert.ok(half.allocationCapital <= full.allocationCapital);
    assert.throws(() => intentFor(loop, 100_000, 150), /INVESTMENT_PERCENT_INVALID/);
    assert.throws(() => intentFor(loop, 100_000, -1), /INVESTMENT_PERCENT_INVALID/);
    // A plan whose allocation share exceeds what the decision allowed is refused rather than trimmed silently.
    const oversized = Object.freeze({ ...portfolio(100_000), allocations: Object.freeze([Object.freeze({ ...portfolio(100_000).allocations[0]!, share: 0.5 })]) });
    assert.throws(() => buildPaperExecutionIntent({ now: T0, market: "KRW-BTC", referencePrice: 100_000, portfolio: oversized, decision, state: loop.snapshot(), investmentPercent: 100 }), /ALLOCATION_EXCEEDS_DECISION/);
  });

  it("a sealed intent is executed once; replaying the same tick never opens a second order or spends cash twice", () => {
    const loop = new PaperTradingExecutionLoop({ initialCapital: 1_000_000 });
    const intent = intentFor(loop, 100_000);
    const tick: PaperExecutionTick = {
      now: T0,
      market: "KRW-BTC",
      price: 100_000,
      quantity: intent.quantity,
      executionIntent: intent,
      portfolio: portfolio(100_000),
      observedAt: T0 - 500,
      mode: "PAPER",
      killSwitchActive: false,
      tradingAllowed: true,
      overallHealth: "HEALTHY",
      decisions: [decision],
      investmentPercent: 100,
    };
    const first = loop.processTick(tick);
    assert.ok(first.status === "FILLED" || first.status === "WAIT", `${first.status} ${first.reason ?? ""}`);
    const commandId = paperExecutionIntentCommandId(intent);
    assert.ok(loop.snapshot().processedIdempotencyKeys.includes(commandId), "the content-addressed command id is what the account records");
    const afterFirst = loop.snapshot();
    const spent = afterFirst.fills.reduce((sum, fill) => sum + fill.quantity * fill.price + fill.fee, 0);
    assert.ok(spent <= intent.allocationCapital * 1.001 + 1e-6, "never spends more than the intent's allocation");

    const replay = loop.processTick({ ...tick, now: T0 + 1 });
    assert.notEqual(replay.status, "FAILED");
    const after = loop.snapshot();
    assert.equal(after.orders.length + (after.workingOrders?.length ?? 0), afterFirst.orders.length + (afterFirst.workingOrders?.length ?? 0), "no second order");
    assert.ok(after.fills.length >= afterFirst.fills.length);
    assert.equal(after.processedIdempotencyKeys.filter((key) => key === commandId).length, 1);
    assert.ok(after.cash >= 1_000_000 - intent.allocationCapital * 1.001 - 1e-6, "cash is not spent twice for one intent");
  });

  it("an intent that does not match the tick it arrives with is refused without touching the account", () => {
    const loop = new PaperTradingExecutionLoop({ initialCapital: 1_000_000 });
    const intent = intentFor(loop, 100_000);
    const before = JSON.stringify(loop.snapshot());
    const result = loop.processTick({
      now: T0, market: "KRW-BTC", price: 101_000, quantity: intent.quantity, executionIntent: intent,
      observedAt: T0 - 500, mode: "PAPER", killSwitchActive: false, tradingAllowed: true, overallHealth: "HEALTHY",
      decisions: [decision], investmentPercent: 100,
    });
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason, "PAPER execution intent does not match tick");
    assert.equal(JSON.stringify(loop.snapshot()), before);
  });
});

describe("EXECUTION writer lease (behaviour)", () => {
  const LEASE_MS = 30_000;

  function lease() {
    const db = new SqliteDatabase(":memory:");
    let clock = T0;
    const options = { now: () => clock, leaseDurationMs: LEASE_MS };
    return {
      db,
      advance: (ms: number) => { clock += ms; },
      open: (ownerId: string) => new SqliteCloudPaperAccountRepository(db, { ...options, ownerId }),
    };
  }

  it("a second writer cannot start while the first holds the lease", () => {
    const { db, open } = lease();
    const first = open("owner-a");
    try {
      assert.throws(() => open("owner-b"), /PAPER_WRITER_ALREADY_ACTIVE/);
    } finally {
      first.close();
      db.close();
    }
  });

  it("a writer that lost its lease cannot write: the order is reported failed and neither memory nor the ledger advances", () => {
    const { db, advance, open } = lease();
    const stale = open("owner-a");
    try {
      const staleLoop = new PaperTradingExecutionLoop({ initialCapital: 10_000_000, repository: stale });
      const before = JSON.stringify(staleLoop.snapshot());

      advance(LEASE_MS + 1_000);
      const successor = open("owner-b");
      try {
        const result = staleLoop.submitManualOrder(marketOrder("stale-writer-0001"), context(T0 + LEASE_MS + 1_000));
        assert.equal(result.status, "FAILED");
        assert.equal(result.reason, "paper account persistence failed");
        assert.match(staleLoop.persistenceFailureDetail() ?? "", /PAPER_WRITER_LEASE_LOST/);
        assert.equal(JSON.stringify(staleLoop.snapshot()), before, "in-memory account did not advance");
        assert.equal(successor.loadLatest(), undefined, "nothing reached the durable ledger");
        assert.equal(successor.loadFills().length, 0);
        assert.throws(() => stale.save(staleLoop.snapshot()), /PAPER_WRITER_LEASE_LOST/);
        assert.throws(() => stale.verifyWriterLease(), /PAPER_WRITER_LEASE_LOST/);
      } finally {
        successor.close();
      }
    } finally {
      stale.close();
      db.close();
    }
  });

  it("the current lease holder writes, and a lost lease stays lost even if the old owner's clock looks fine again", () => {
    const { db, advance, open } = lease();
    const holder = open("owner-a");
    try {
      const loop = new PaperTradingExecutionLoop({ initialCapital: 10_000_000, repository: holder });
      const filled = loop.submitManualOrder(marketOrder("holder-order-0001"), context(T0 + 1_000));
      assert.equal(filled.status, "FILLED");
      assert.equal(holder.loadLatest()?.fills.length, 1);

      advance(LEASE_MS + 5_000);
      const successor = open("owner-b");
      try {
        assert.throws(() => holder.verifyWriterLease(), /PAPER_WRITER_LEASE_LOST/);
        successor.close();
        // The old owner never regains the lease on its own: its handle stays unusable.
        assert.throws(() => holder.verifyWriterLease(), /PAPER_WRITER_LEASE_LOST/);
      } finally {
        successor.close();
      }
    } finally {
      holder.close();
      db.close();
    }
  });

  it("a closed writer refuses reads and writes", () => {
    const { db, open } = lease();
    const repository = open("owner-a");
    const state = new PaperTradingExecutionLoop({ initialCapital: 10_000_000 }).snapshot();
    repository.close();
    try {
      assert.throws(() => repository.save(state), /PAPER_WRITER_LEASE_LOST/);
      assert.throws(() => repository.loadLatest(), /PAPER_WRITER_LEASE_LOST/);
    } finally {
      db.close();
    }
  });

  it("a backwards or runaway clock stops the writer instead of extending the lease", () => {
    const { db, advance, open } = lease();
    const repository = open("owner-a");
    try {
      advance(-1);
      assert.throws(() => repository.verifyWriterLease(), /PAPER_WRITER_CLOCK_REGRESSION|PAPER_WRITER_LEASE_LOST/);
      assert.throws(() => repository.verifyWriterLease(), /PAPER_WRITER_LEASE_LOST/, "once lost it stays lost");
    } finally {
      repository.close();
      db.close();
    }
  });
});

describe("EXECUTION persistence failure is fail-closed (behaviour)", () => {
  class FailingRepository implements PaperAccountRepository {
    public saves = 0;
    public failing = false;
    public save(): void { this.saves += 1; if (this.failing) throw new Error("disk full /secret/path"); }
    public loadLatest(): PaperAccountState | undefined { return undefined; }
    public clear(): void { /* not used */ }
  }

  it("does not advance the in-memory account when the save fails and does not leak the error text into the result", () => {
    const repository = new FailingRepository();
    const loop = new PaperTradingExecutionLoop({ initialCapital: 10_000_000, repository });
    repository.failing = true;
    const before = JSON.stringify(loop.snapshot());
    const result = loop.submitManualOrder(marketOrder("persist-fail-order-0001"), context(T0));
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason, "paper account persistence failed");
    assert.equal(JSON.stringify(loop.snapshot()), before);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
    assert.doesNotMatch(loop.persistenceFailureDetail() ?? "", /\//, "diagnostic detail carries no path separators");

    repository.failing = false;
    const retried = loop.submitManualOrder(marketOrder("persist-fail-order-0001"), context(T0 + 1));
    assert.equal(retried.status, "FILLED", "a failed save did not consume the idempotency key");
  });
});
