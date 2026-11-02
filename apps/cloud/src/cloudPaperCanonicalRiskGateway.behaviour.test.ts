import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteDatabase } from "../../../packages/storage/src/index";
import {
  CLOUD_PAPER_RISK_LIMITS,
  CloudPaperCanonicalRiskGateway,
  type CloudPaperRiskRequest,
} from "./cloudPaperCanonicalRiskGateway";
import type { IndependentRiskLimits } from "./independentRiskGateway";
import type { PaperAccountState, PaperFillRecord, PaperOrderRecord } from "./paperTradingExecutionLoop";

/**
 * Behavioural replacements for the source-text assertions in
 * cloudPaperCanonicalRiskGateway.requalification.test.ts. Each test drives the exported gateway with
 * real account state and asserts the decision, so a refactor that keeps the behaviour keeps the test green.
 * This file only imports exported surface; it pins no source hash.
 */

// 2026-10-17 16:00 KST (07:00 UTC).
const NOW = Date.parse("2026-10-17T07:00:00Z");
// 01:00 KST on 2026-10-17: "today" in the canonical Asia/Seoul trading day, but still "yesterday" in a UTC day.
const TODAY_KST_BUT_YESTERDAY_UTC = Date.parse("2026-10-16T16:00:00Z");
// 23:59 KST on 2026-10-16: yesterday in the trading day.
const YESTERDAY_KST = Date.parse("2026-10-16T14:59:00Z");

let sequence = 0;

function fill(side: "BUY" | "SELL", quantity: number, price: number, filledAt: number, orderId = `order-${sequence += 1}`, market = "KRW-BTC"): PaperFillRecord {
  return Object.freeze({ id: `fill-${orderId}-${sequence += 1}`, orderId, market, side, quantity, price, fee: 0, filledAt });
}

function orderFor(fills: readonly PaperFillRecord[], orderId: string, status: PaperOrderRecord["status"] = "FILLED"): PaperOrderRecord {
  const own = fills.filter((item) => item.orderId === orderId);
  const quantity = own.reduce((sum, item) => sum + item.quantity, 0);
  const first = own[0]!;
  return Object.freeze({ id: orderId, idempotencyKey: `key-${orderId}`, market: first.market, side: first.side, quantity, price: first.price, fee: 0, status, createdAt: first.filledAt, filledAt: first.filledAt });
}

interface StateInput {
  readonly cash?: number;
  readonly fills?: readonly PaperFillRecord[];
  readonly cancelledOrderIds?: readonly string[];
  readonly positions?: PaperAccountState["positions"];
  readonly keys?: readonly string[];
}

function state(input: StateInput = {}): PaperAccountState {
  const fills = input.fills ?? [];
  const positions = input.positions ?? [];
  const cash = input.cash ?? 100_000_000;
  const orderIds = [...new Set(fills.map((item) => item.orderId))];
  return Object.freeze({
    version: 1,
    initialCapital: 100_000_000,
    cash,
    equity: cash + positions.reduce((sum, item) => sum + item.quantity * item.markPrice, 0),
    realizedPnL: 0,
    unrealizedPnL: 0,
    positions,
    orders: Object.freeze(orderIds.map((id) => orderFor(fills, id, input.cancelledOrderIds?.includes(id) ? "CANCELLED" : "FILLED"))),
    fills,
    processedIdempotencyKeys: Object.freeze([...(input.keys ?? [])]),
    updatedAt: NOW,
  });
}

function request(overrides: Partial<CloudPaperRiskRequest> & { readonly state: PaperAccountState }): CloudPaperRiskRequest {
  return Object.freeze({
    path: "STRATEGY",
    commandId: "cmd-1",
    signalId: "sig-1",
    clientOrderId: "client-1",
    strategyId: "strategy-1",
    market: "KRW-BTC",
    side: "BUY",
    quantity: 1,
    price: 100_000,
    now: NOW,
    observedAt: NOW - 1_000,
    maximumMarketAgeMs: 30_000,
    killSwitchActive: false,
    openP0: false,
    overallHealth: "HEALTHY",
    ...overrides,
  });
}

function withGateway<T>(run: (gate: CloudPaperCanonicalRiskGateway, db: SqliteDatabase) => T, limits?: IndependentRiskLimits, initialCapital = 100_000_000): T {
  const db = new SqliteDatabase(":memory:");
  try {
    return run(new CloudPaperCanonicalRiskGateway({ database: db, initialCapital, sourceCommitSha: "behaviour-test", ...(limits === undefined ? {} : { limits }) }), db);
  } finally {
    db.close();
  }
}

describe("RISK limits (behaviour)", () => {
  it("exposes the owner-approved limits as an immutable policy that cannot be loosened at runtime", () => {
    assert.equal(Object.isFrozen(CLOUD_PAPER_RISK_LIMITS), true);
    assert.throws(() => { (CLOUD_PAPER_RISK_LIMITS as { maxOrderNotional: number }).maxOrderNotional = 1e12; }, TypeError);
    assert.equal(CLOUD_PAPER_RISK_LIMITS.maxOrderNotional, 2_000_000);
    assert.equal(CLOUD_PAPER_RISK_LIMITS.consecutiveLossLimitEnabled, false);

    // Mutating the object passed in after construction must not change what the gateway enforces.
    const custom: { -readonly [K in keyof IndependentRiskLimits]: IndependentRiskLimits[K] } = { ...CLOUD_PAPER_RISK_LIMITS };
    withGateway((gate) => {
      custom.maxOrderNotional = 1e12;
      const result = gate.evaluate(request({ state: state(), quantity: 30, price: 100_000 }));
      assert.equal(result.status, "REJECT");
      assert.ok(result.reasonCodes.includes("MAX_ORDER_NOTIONAL"), result.reasonCodes.join(","));
    }, custom as IndependentRiskLimits);
  });

  it("does not raise the order ceiling with capital: a huge account is still held to the fixed notional limit", () => {
    for (const cash of [100_000_000, 1_000_000_000_000]) {
      withGateway((gate) => {
        const over = gate.evaluate(request({ state: state({ cash }), quantity: 30, price: 100_000 }));
        assert.equal(over.status, "REJECT", `cash ${cash}`);
        assert.ok(over.reasonCodes.includes("MAX_ORDER_NOTIONAL"), over.reasonCodes.join(","));
        const within = gate.evaluate(request({ state: state({ cash }), commandId: "cmd-ok", signalId: "sig-ok", clientOrderId: "client-ok", quantity: 10, price: 100_000 }));
        assert.equal(within.status, "ALLOW", within.reasonCodes.join(","));
      }, undefined, cash);
    }
  });

  it("never lets an order spend more cash than the account holds, however small the account", () => {
    withGateway((gate) => {
      const result = gate.evaluate(request({ state: state({ cash: 50_000 }), quantity: 1, price: 100_000 }));
      assert.notEqual(result.status, "ALLOW");
      assert.ok(result.reasonCodes.includes("INSUFFICIENT_CASH"), result.reasonCodes.join(","));
    });
  });

  it("rejects limits that are non-finite, negative or out of range instead of running with them", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      const build = (limits: IndependentRiskLimits) => new CloudPaperCanonicalRiskGateway({ database: db, initialCapital: 1, sourceCommitSha: "x", limits });
      assert.throws(() => build({ ...CLOUD_PAPER_RISK_LIMITS, maxOrderNotional: Number.NaN }), /invalid/);
      assert.throws(() => build({ ...CLOUD_PAPER_RISK_LIMITS, maxDailyLoss: -1 }), /invalid/);
      assert.throws(() => build({ ...CLOUD_PAPER_RISK_LIMITS, maxOrdersPerSecond: 0 }), /positive/);
      assert.throws(() => build({ ...CLOUD_PAPER_RISK_LIMITS, maxPriceDeviationRatio: 1.5 }), /ratio/);
      assert.throws(() => new CloudPaperCanonicalRiskGateway({ database: db, initialCapital: 0, sourceCommitSha: "x" }), /capital/);
      assert.throws(() => new CloudPaperCanonicalRiskGateway({ database: db, initialCapital: 1, sourceCommitSha: "  " }), /source commit/);
    } finally {
      db.close();
    }
  });
});

describe("RISK accounting is derived from fills (behaviour)", () => {
  it("counts an executed order toward the per-second rate even when the order was later cancelled", () => {
    const executed = fill("BUY", 1, 100_000, NOW - 500, "partly-filled");
    withGateway((gate) => {
      const cancelled = gate.evaluate(request({ state: state({ fills: [executed], cancelledOrderIds: ["partly-filled"], cash: 99_900_000 }) }));
      assert.equal(cancelled.status, "REJECT");
      assert.ok(cancelled.reasonCodes.includes("ORDER_RATE_LIMIT_PER_SECOND"), cancelled.reasonCodes.join(","));
    });
    withGateway((gate) => {
      const aged = gate.evaluate(request({ state: state({ fills: [fill("BUY", 1, 100_000, NOW - 1_500, "old")], cash: 99_900_000 }) }));
      assert.equal(aged.status, "ALLOW", aged.reasonCodes.join(","));
    });
  });

  it("counts one order once however many partial fills it produced", () => {
    const fills = [fill("BUY", 0.5, 100_000, NOW - 5_000, "split"), fill("BUY", 0.5, 100_000, NOW - 4_000, "split")];
    // Two fills of one order are one order for the same-side streak: a limit of 2 is not yet reached.
    withGateway((gate) => {
      const result = gate.evaluate(request({ state: state({ fills, cash: 99_900_000 }) }));
      assert.equal(result.status, "ALLOW", result.reasonCodes.join(","));
    }, { ...CLOUD_PAPER_RISK_LIMITS, maxSameSideStreak: 2 });
  });

  it("stops a same-side streak at the configured length", () => {
    const fills = Array.from({ length: 3 }, (_, index) => fill("BUY", 0.1, 100_000, NOW - 10_000 - index * 2_000));
    const db = new SqliteDatabase(":memory:");
    try {
      const gate = new CloudPaperCanonicalRiskGateway({ database: db, initialCapital: 100_000_000, sourceCommitSha: "streak", limits: { ...CLOUD_PAPER_RISK_LIMITS, maxSameSideStreak: 3 } });
      const result = gate.evaluate(request({ state: state({ fills, cash: 99_970_000 }) }));
      assert.equal(result.status, "REJECT");
      assert.ok(result.reasonCodes.includes("SAME_SIDE_BURST_LIMIT"), result.reasonCodes.join(","));
    } finally {
      db.close();
    }
  });

  it("applies the daily buy cap to today's (Asia/Seoul) fills and ignores yesterday's", () => {
    withGateway((gate) => {
      const today = gate.evaluate(request({ state: state({ fills: [fill("BUY", 19, 100_000, TODAY_KST_BUT_YESTERDAY_UTC, "today")], cash: 98_100_000 }), quantity: 2 }));
      assert.equal(today.status, "REJECT");
      assert.ok(today.reasonCodes.includes("MAX_DAILY_BUY_NOTIONAL"), today.reasonCodes.join(","));
    });
    withGateway((gate) => {
      const yesterday = gate.evaluate(request({ state: state({ fills: [fill("BUY", 19, 100_000, YESTERDAY_KST, "yesterday")], cash: 98_100_000 }), quantity: 2 }));
      assert.equal(yesterday.status, "ALLOW", yesterday.reasonCodes.join(","));
    });
  });
});

describe("RISK loss state (behaviour)", () => {
  const enabled: IndependentRiskLimits = { ...CLOUD_PAPER_RISK_LIMITS, consecutiveLossLimitEnabled: true, maxConsecutiveLosses: 2 };

  function lossHistory(sellTimes: readonly number[], sellPrice = 90_000): readonly PaperFillRecord[] {
    return sellTimes.flatMap((time, index) => [
      fill("BUY", 1, 100_000, time - 2_000, `buy-${index}`),
      fill("SELL", 1, sellPrice, time, `sell-${index}`),
    ]);
  }

  it("halts new orders after the configured number of losing sells today, when enforcement is enabled", () => {
    const fills = lossHistory([NOW - 20_000, NOW - 10_000]);
    withGateway((gate) => {
      const result = gate.evaluate(request({ state: state({ fills }) }));
      assert.equal(result.status, "REJECT");
      assert.ok(result.reasonCodes.includes("CONSECUTIVE_LOSS_LIMIT"), result.reasonCodes.join(","));
    }, enabled);
  });

  it("does not veto on the loss streak under the owner-approved default policy (enforcement disabled)", () => {
    const fills = lossHistory([NOW - 20_000, NOW - 10_000]);
    withGateway((gate) => {
      const result = gate.evaluate(request({ state: state({ fills }) }));
      assert.ok(!result.reasonCodes.includes("CONSECUTIVE_LOSS_LIMIT"), result.reasonCodes.join(","));
      assert.equal(gate.lossSession()?.consecutiveLossCount, 2, "the streak is still counted for display");
      assert.equal(gate.lossSession()?.consecutiveLossLimitEnabled, false);
    });
  });

  it("resets the streak at the Asia/Seoul day boundary and not at the UTC one", () => {
    // Two losses at 01:00 KST today (still the previous UTC day) count today; the same two at 23:59 KST yesterday do not.
    withGateway((gate) => {
      const today = gate.evaluate(request({ state: state({ fills: lossHistory([TODAY_KST_BUT_YESTERDAY_UTC, TODAY_KST_BUT_YESTERDAY_UTC + 10_000]) }) }));
      assert.ok(today.reasonCodes.includes("CONSECUTIVE_LOSS_LIMIT"), today.reasonCodes.join(","));
      assert.equal(gate.lossSession()?.periodIdentity, "2026-10-17");
    }, enabled);
    withGateway((gate) => {
      const yesterday = gate.evaluate(request({ state: state({ fills: lossHistory([YESTERDAY_KST - 20_000, YESTERDAY_KST]) }) }));
      assert.ok(!yesterday.reasonCodes.includes("CONSECUTIVE_LOSS_LIMIT"), yesterday.reasonCodes.join(","));
      assert.equal(gate.lossSession()?.consecutiveLossCount, 0);
      assert.equal(gate.lossSession()?.lastIncrementAt, null);
    }, enabled);
  });

  it("treats a winning sell as ending the streak", () => {
    const fills = [...lossHistory([NOW - 30_000, NOW - 20_000]), fill("BUY", 1, 100_000, NOW - 12_000, "buy-w"), fill("SELL", 1, 120_000, NOW - 10_000, "sell-w")];
    withGateway((gate) => {
      const result = gate.evaluate(request({ state: state({ fills }) }));
      assert.ok(!result.reasonCodes.includes("CONSECUTIVE_LOSS_LIMIT"), result.reasonCodes.join(","));
      assert.equal(gate.lossSession()?.consecutiveLossCount, 0);
      assert.equal(gate.lossSession()?.todayCompletedSells, 3);
      assert.equal(gate.lossSession()?.todayLosingSells, 2);
    }, enabled);
  });

  it("scores a sell order as one completed sell however many fills it took", () => {
    const fills = [
      fill("BUY", 2, 100_000, NOW - 30_000, "buy-split"),
      fill("SELL", 1, 90_000, NOW - 20_000, "sell-split"),
      fill("SELL", 1, 90_000, NOW - 19_000, "sell-split"),
    ];
    withGateway((gate) => {
      gate.evaluate(request({ state: state({ fills }) }));
      assert.equal(gate.lossSession()?.todayCompletedSells, 1);
      assert.equal(gate.lossSession()?.todayLosingSells, 1);
      assert.equal(gate.lossSession()?.consecutiveLossCount, 1);
    }, enabled);
  });

  it("fails closed on a sell with no matching buy rather than guessing its P&L", () => {
    const fills = [fill("SELL", 1, 100_000, NOW - 10_000, "orphan-sell")];
    withGateway((gate) => {
      const result = gate.evaluate(request({ state: state({ fills }) }));
      assert.notEqual(result.status, "ALLOW", result.reasonCodes.join(","));
    }, enabled);
  });

  it("records the loss session only as display: changing it cannot change a decision", () => {
    withGateway((gate) => {
      assert.equal(gate.lossSession(), null);
      const clean = state();
      const first = gate.evaluate(request({ state: clean }));
      const snapshot = gate.lossSession();
      assert.ok(snapshot);
      assert.throws(() => { (snapshot as { consecutiveLossCount: number }).consecutiveLossCount = 99; }, TypeError);
      const second = gate.evaluate(request({ state: clean, commandId: "cmd-2", signalId: "sig-2", clientOrderId: "client-2" }));
      assert.equal(first.status, second.status);
      assert.deepEqual(first.reasonCodes, second.reasonCodes);
    });
  });
});

describe("RISK idempotency is bound to the exact intent (behaviour)", () => {
  const fingerprint = (character: string) => character.repeat(64);

  it("allows an intent once and refuses the same command id replayed with a different payload fingerprint", () => {
    withGateway((gate) => {
      const first = gate.evaluate(request({ state: state(), payloadFingerprintSha256: fingerprint("a") }));
      assert.equal(first.status, "ALLOW", first.reasonCodes.join(","));
      const conflicting = gate.evaluate(request({ state: state(), payloadFingerprintSha256: fingerprint("b") }));
      assert.notEqual(conflicting.status, "ALLOW", "same command id, different intent must never be approved");
    });
  });

  it("treats an identical replay as the same intent, not as a new approval of different content", () => {
    withGateway((gate) => {
      const first = gate.evaluate(request({ state: state(), payloadFingerprintSha256: fingerprint("a") }));
      const replay = gate.evaluate(request({ state: state(), payloadFingerprintSha256: fingerprint("a") }));
      assert.equal(first.status, "ALLOW", first.reasonCodes.join(","));
      assert.ok(["ALLOW", "REJECT", "HALT"].includes(replay.status));
      assert.deepEqual(replay.reasonCodes.filter((code) => code === "IDEMPOTENCY_FINGERPRINT_INVALID"), []);
    });
  });

  it("derives the fingerprint from the request content when none is supplied: changed quantity under the same command id is refused", () => {
    withGateway((gate) => {
      const first = gate.evaluate(request({ state: state(), quantity: 1 }));
      assert.equal(first.status, "ALLOW", first.reasonCodes.join(","));
      const changed = gate.evaluate(request({ state: state(), quantity: 2 }));
      assert.notEqual(changed.status, "ALLOW");
    });
  });

  it("halts on a malformed supplied fingerprint and never substitutes a placeholder", () => {
    withGateway((gate) => {
      for (const bad of ["PENDING", "", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
        const result = gate.evaluate(request({ state: state(), payloadFingerprintSha256: bad }));
        assert.equal(result.status, "HALT", `fingerprint ${JSON.stringify(bad)}`);
        assert.deepEqual([...result.reasonCodes], ["IDEMPOTENCY_FINGERPRINT_INVALID"]);
      }
    });
  });

  it("refuses an id the account has already processed", () => {
    withGateway((gate) => {
      const result = gate.evaluate(request({ state: state({ keys: ["cmd-1"] }) }));
      assert.equal(result.status, "REJECT");
      assert.ok(result.reasonCodes.some((code) => code.startsWith("DUPLICATE_")), result.reasonCodes.join(","));
    });
  });
});

describe("RISK fail-closed inputs (behaviour)", () => {
  it("halts when account accounting does not reconcile", () => {
    withGateway((gate) => {
      const broken = { ...state(), equity: 1 };
      const result = gate.evaluate(request({ state: broken }));
      assert.equal(result.status, "HALT");
      assert.deepEqual([...result.reasonCodes], ["RECONCILIATION_FAILED"]);
    });
  });

  it("never approves with the kill switch on, an open P0, stale or future market data, or a degraded system", () => {
    const cases: Array<readonly [string, Partial<CloudPaperRiskRequest>]> = [
      ["kill switch", { killSwitchActive: true }],
      ["stale market", { observedAt: NOW - 30_000 }],
      ["future market", { observedAt: NOW + 1 }],
      ["open P0", { openP0: true }],
      ["degraded health", { overallHealth: "DEGRADED" }],
      ["unknown health", { overallHealth: "UNKNOWN" }],
    ];
    for (const [name, overrides] of cases) {
      withGateway((gate) => {
        const result = gate.evaluate(request({ state: state(), ...overrides }));
        assert.notEqual(result.status, "ALLOW", name);
      });
    }
  });

  it("requires a named approver on the manual path and never approves it anonymously", () => {
    withGateway((gate) => {
      const anonymous = gate.evaluate(request({ state: state(), path: "MANUAL" }));
      assert.equal(anonymous.status, "HALT");
      assert.ok(anonymous.reasonCodes.includes("APPROVAL_MISSING"), anonymous.reasonCodes.join(","));
      const approved = gate.evaluate(request({ state: state(), path: "MANUAL", approvedBy: "owner", commandId: "cmd-m", signalId: "sig-m", clientOrderId: "client-m" }));
      assert.equal(approved.status, "ALLOW", approved.reasonCodes.join(","));
    });
  });

  it("reuses a manual approval at most once: it is revoked as soon as it has been evaluated", () => {
    withGateway((gate, db) => {
      const approved = gate.evaluate(request({ state: state(), path: "MANUAL", approvedBy: "owner" }));
      assert.equal(approved.status, "ALLOW", approved.reasonCodes.join(","));
      const rows = db.connection.prepare("SELECT * FROM risk_paper_approvals").all() as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, "REVOKED");
    });
  });
});
