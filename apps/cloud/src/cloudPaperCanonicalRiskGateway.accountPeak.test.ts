import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteDatabase, SqliteRiskSafetyPersistence } from "../../../packages/storage/src/index";
import { CLOUD_PAPER_RISK_LIMITS, CloudPaperCanonicalRiskGateway, type CloudPaperRiskRequest } from "./cloudPaperCanonicalRiskGateway";
import type { PaperAccountState } from "./paperTradingExecutionLoop";

const NOW = Date.parse("2026-10-30T03:00:00Z");
const CAPITAL = 1_000_000;

function cashState(cash: number): PaperAccountState {
  return Object.freeze({
    version: 1, initialCapital: CAPITAL, cash, equity: cash, realizedPnL: 0, unrealizedPnL: 0,
    positions: Object.freeze([]), orders: Object.freeze([]), fills: Object.freeze([]),
    processedIdempotencyKeys: Object.freeze([]), updatedAt: NOW
  });
}

function request(cash: number, id: string, now = NOW): CloudPaperRiskRequest {
  return Object.freeze({
    path: "STRATEGY", commandId: `cmd-${id}`, signalId: `sig-${id}`, clientOrderId: `ord-${id}`, strategyId: "strategy-1",
    market: "KRW-BTC", side: "BUY", quantity: 1, price: 100, now, observedAt: now - 1_000, maximumMarketAgeMs: 30_000,
    killSwitchActive: false, openP0: false, overallHealth: "HEALTHY", state: cashState(cash)
  });
}

const gateway = (db: SqliteDatabase, extra: Partial<ConstructorParameters<typeof CloudPaperCanonicalRiskGateway>[0]> = {}) =>
  new CloudPaperCanonicalRiskGateway({ database: db, initialCapital: CAPITAL, sourceCommitSha: "test", ...extra });

const rows = (db: SqliteDatabase, sql: string, ...params: string[]) => db.connection.prepare(sql).all(...params) as Array<Record<string, unknown>>;

describe("RISK gateway account key and persisted drawdown peak", () => {
  it("keeps every risk limit unchanged", () => {
    assert.equal(CLOUD_PAPER_RISK_LIMITS.maxSessionDrawdownRatio, 0.2);
    assert.equal(CLOUD_PAPER_RISK_LIMITS.maxDailyLoss, 1_000_000);
    assert.equal(CLOUD_PAPER_RISK_LIMITS.consecutiveLossLimitEnabled, false);
  });

  it("keys risk rows by the real PAPER account id and keeps the legacy id for the original account", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      assert.equal(gateway(db).evaluate(request(CAPITAL, "a")).status, "ALLOW");
      assert.equal(rows(db, "SELECT 1 FROM risk_idempotency_records WHERE account_id='paper-krw-1000000'").length > 0, true);
      assert.equal(rows(db, "SELECT 1 FROM risk_daily_loss_state WHERE account_id='paper-krw-1000000'").length, 1);
      assert.equal(rows(db, "SELECT 1 FROM risk_idempotency_records WHERE account_id='paper-default'").length, 0);
      assert.equal(rows(db, "SELECT 1 FROM risk_daily_loss_state WHERE account_id='paper-default'").length, 0);

      const legacy = new SqliteDatabase(":memory:");
      try {
        assert.equal(gateway(legacy, { initialCapital: 10_000_000 }).evaluate({ ...request(10_000_000, "l"), state: { ...cashState(10_000_000), initialCapital: 10_000_000 } }).status, "ALLOW");
        assert.equal(rows(legacy, "SELECT 1 FROM risk_idempotency_records WHERE account_id='paper-default'").length > 0, true);
        assert.equal(rows(legacy, "SELECT 1 FROM risk_daily_loss_state WHERE account_id='paper-default'").length, 1);
      } finally { legacy.close(); }
    } finally { db.close(); }
  });

  it("still counts rows written under paper-default: a command claimed there is a duplicate, once", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      const old = new SqliteRiskSafetyPersistence(db);
      old.claimIdempotency({ accountId: "paper-default", commandId: "cmd-dup", signalId: "sig-dup", clientOrderId: "ord-dup", payloadFingerprint: "f".repeat(64), createdAtMs: NOW - 1 });
      const before = rows(db, "SELECT * FROM risk_idempotency_records WHERE account_id='paper-default'");
      const decision = gateway(db).evaluate(request(CAPITAL, "dup"));
      assert.notEqual(decision.status, "ALLOW");
      assert.ok(decision.reasonCodes.includes("DUPLICATE_COMMAND"), decision.reasonCodes.join(","));
      assert.deepEqual(rows(db, "SELECT * FROM risk_idempotency_records WHERE account_id='paper-default'"), before, "old rows are neither rewritten nor duplicated");
      assert.equal(rows(db, "SELECT 1 FROM risk_idempotency_records WHERE account_id='paper-krw-1000000'").length, 0, "a refused command claims nothing new");
      assert.equal(gateway(db).evaluate(request(CAPITAL, "fresh")).status, "ALLOW");
    } finally { db.close(); }
  });

  it("an open order recorded under paper-default still counts against the open-order limit", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      new SqliteRiskSafetyPersistence(db).saveOrder({ accountId: "paper-default", orderId: "old-open", status: "OPEN", updatedAtMs: NOW - 1 });
      const decision = gateway(db).evaluate(request(CAPITAL, "open"));
      assert.notEqual(decision.status, "ALLOW");
      assert.ok(decision.reasonCodes.includes("OPEN_ORDER_LIMIT"), decision.reasonCodes.join(","));
    } finally { db.close(); }
  });

  it("a restart does not reset the drawdown peak", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      assert.equal(gateway(db).evaluate(request(1_300_000, "up")).status, "ALLOW");
      // 1,000,000 is a 23% drawdown from the 1,300,000 peak, over the 20% limit; a restarted process must remember it.
      const restarted = gateway(db).evaluate(request(1_000_000, "down"));
      assert.notEqual(restarted.status, "ALLOW", "a forgotten peak would allow this");
      const control = new SqliteDatabase(":memory:");
      try { assert.equal(gateway(control).evaluate(request(1_000_000, "down")).status, "ALLOW", "same limits: no drawdown without the earlier peak"); } finally { control.close(); }
      assert.equal(rows(db, "SELECT day_start_equity FROM risk_daily_loss_state WHERE account_id='session-peak:paper-krw-1000000'")[0]?.day_start_equity, 1_300_000);
    } finally { db.close(); }
  });

  it("the peak is only ever raised in the store", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      const gate = gateway(db);
      gate.evaluate(request(1_300_000, "p1"));
      gate.evaluate(request(1_250_000, "p2"));
      assert.equal(rows(db, "SELECT day_start_equity FROM risk_daily_loss_state WHERE account_id='session-peak:paper-krw-1000000'")[0]?.day_start_equity, 1_300_000);
    } finally { db.close(); }
  });

  for (const [label, sql, params] of [
    ["wrong marker", "INSERT INTO risk_daily_loss_state(account_id,trading_day,day_start_equity,updated_at_ms) VALUES(?,?,?,?)", ["session-peak:paper-krw-1000000", "2026-10-30", 5_000_000, NOW]],
    ["non-numeric peak", "INSERT INTO risk_daily_loss_state(account_id,trading_day,day_start_equity,updated_at_ms) VALUES(?,?,?,?)", ["session-peak:paper-krw-1000000", "SESSION_PEAK_V1", "garbage", NOW]],
    ["peak below the initial capital", "INSERT INTO risk_daily_loss_state(account_id,trading_day,day_start_equity,updated_at_ms) VALUES(?,?,?,?)", ["session-peak:paper-krw-1000000", "SESSION_PEAK_V1", 1, NOW]]
  ] as const) {
    it(`a corrupt persisted peak fails closed (${label})`, () => {
      const db = new SqliteDatabase(":memory:");
      try {
        db.connection.prepare(sql).run(...params);
        const gate = gateway(db);
        for (const id of ["c1", "c2"]) {
          const decision = gate.evaluate(request(CAPITAL, id));
          assert.equal(decision.status, "HALT");
          assert.ok(decision.reasonCodes.includes("PERSISTENCE_UNHEALTHY"));
        }
        assert.equal(rows(db, "SELECT 1 FROM risk_idempotency_records WHERE account_id='paper-krw-1000000'").length, 0, "no order is approved while the peak is unknown");
      } finally { db.close(); }
    });
  }

  it("an unreadable peak halts, and a later successful read restores it without ever loosening", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      assert.equal(gateway(db).evaluate(request(1_300_000, "seed")).status, "ALLOW");
      const originalPrepare = db.connection.prepare.bind(db.connection);
      let failReads = true;
      Object.defineProperty(db.connection, "prepare", {
        configurable: true,
        value: (sql: string) => {
          if (failReads && /SELECT \* FROM risk_daily_loss_state/.test(sql)) throw new Error("simulated read failure");
          return originalPrepare(sql);
        }
      });
      const gate = gateway(db);
      assert.equal(gate.evaluate(request(CAPITAL, "r1")).status, "HALT");
      failReads = false;
      const recovered = gate.evaluate(request(CAPITAL, "r2"));
      assert.notEqual(recovered.status, "ALLOW", "the restored 1,300,000 peak still applies");
    } finally { db.close(); }
  });

  it("a failed peak write halts instead of approving with an unsaved new high", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      const gate = gateway(db);
      const originalPrepare = db.connection.prepare.bind(db.connection);
      Object.defineProperty(db.connection, "prepare", {
        configurable: true,
        value: (sql: string) => {
          if (/INSERT INTO risk_daily_loss_state/.test(sql)) throw new Error("simulated write failure");
          return originalPrepare(sql);
        }
      });
      const decision = gate.evaluate(request(1_300_000, "w1"));
      assert.equal(decision.status, "HALT");
      assert.ok(decision.reasonCodes.includes("PERSISTENCE_UNHEALTHY"));
    } finally { db.close(); }
  });

  it("counts a loss already taken today under the legacy account id on the first evaluation of the new account", () => {
    const seeded = (): SqliteDatabase => {
      const db = new SqliteDatabase(":memory:");
      new SqliteRiskSafetyPersistence(db).saveDailyLoss({ accountId: "paper-default", tradingDay: "2026-10-30", dayStartEquity: 3_000_000, updatedAtMs: NOW - 3_600_000 });
      return db;
    };
    const control = new SqliteDatabase(":memory:");
    const withLegacy = seeded();
    try {
      assert.equal(gateway(control).evaluate(request(CAPITAL, "c")).status, "ALLOW", "without a legacy row the first evaluation sets today's baseline");
      assert.notEqual(gateway(withLegacy).evaluate(request(CAPITAL, "d")).status, "ALLOW", "a 2,000,000 loss against the legacy day start exceeds the daily limit");
    } finally { control.close(); withLegacy.close(); }
  });

  it("ignores a legacy day row from an earlier day and never borrows the session peak key", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      new SqliteRiskSafetyPersistence(db).saveDailyLoss({ accountId: "paper-default", tradingDay: "2026-10-29", dayStartEquity: 3_000_000, updatedAtMs: NOW - 86_400_000 });
      assert.equal(gateway(db).evaluate(request(CAPITAL, "e")).status, "ALLOW", "yesterday's legacy row does not count today");
    } finally { db.close(); }
  });
});
