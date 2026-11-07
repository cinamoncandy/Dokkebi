"use strict";
// Behaviour tests (no source regexes) for WO-OPS-20261030-LEASE-LOSS-EXIT-AUDIT: once the PAPER writer
// lease is lost, no path may keep writing, and the supervised process must exit so systemd / the paper
// supervisor restarts it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { mkdtempSync, rmSync, readFileSync } = require("node:fs");
const storage = require("../dist/packages/storage/src/index.js");
const { PaperTradingExecutionLoop, SqliteCloudPaperAccountRepository } = require("../dist/apps/cloud/src/paperTradingExecutionLoop.js");
const runtime = require("../dist/apps/cloud/src/runtime.js");
const { startClosedLearningProductionRuntime, CLOSED_LEARNING_ROLLOVER_POLL_INTERVAL_MS } = require("../dist/apps/cloud/src/closedLearningProductionRuntime.js");

const command = (idempotencyKey) => ({
  schemaVersion: 1, authority: "PAPER_ONLY", productionMutationAllowed: false,
  idempotencyKey, market: "KRW-BTC", side: "BUY", orderType: "MARKET", quantity: 1,
});
const context = (now) => ({
  now, marketPrice: 100, observedAt: now, mode: "PAPER", killSwitchActive: false, tradingAllowed: true, overallHealth: "HEALTHY",
});
const LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;

function fixture(t) {
  const db = new storage.SqliteDatabase(":memory:");
  let now = 1_000;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const repository = new SqliteCloudPaperAccountRepository(db, { ownerId: "owner-a", now: () => now, leaseDurationMs: LEASE_MS, heartbeatIntervalMs: HEARTBEAT_MS });
  t.after(() => { repository.close(); db.close(); });
  const ledgerCount = () => Number(db.connection.prepare("SELECT COUNT(*) AS c FROM cloud_paper_fill_ledger").get().c);
  const leaseRow = () => db.connection.prepare("SELECT owner_id, lease_until_ms FROM cloud_paper_writer_leases").get();
  return { db, repository, ledgerCount, leaseRow, setNow: (v) => { now = v; }, heartbeat: () => t.mock.timers.tick(HEARTBEAT_MS) };
}

// Each way the lease can be lost: another owner takes it, the row disappears, the lease expires, the clock regresses.
const LOSSES = [
  { name: "owner replaced", apply: (f) => f.db.connection.prepare("UPDATE cloud_paper_writer_leases SET owner_id = 'owner-b'").run(), expectOwner: "owner-b" },
  { name: "row deleted", apply: (f) => f.db.connection.prepare("DELETE FROM cloud_paper_writer_leases").run(), expectOwner: undefined },
  { name: "lease expired", apply: (f) => f.setNow(1_000 + LEASE_MS + 1) },
  { name: "clock regression", apply: (f) => f.setNow(500) },
];

for (const loss of LOSSES) {
  test(`heartbeat latches a lost lease (${loss.name}); every repository path then fails closed and writes nothing`, (t) => {
    const f = fixture(t);
    const trading = new PaperTradingExecutionLoop({ initialCapital: 1_000, feeRate: 0, repository: f.repository });
    assert.equal(trading.submitManualOrder(command("before-loss-0001"), context(1_000)).status, "FILLED");
    const ledgerBefore = f.ledgerCount();
    assert.equal(ledgerBefore, 1);

    loss.apply(f);
    f.heartbeat(); // the 10 s interval timer, not a caller, discovers the loss
    const rowAfterLoss = f.leaseRow();
    if ("expectOwner" in loss) assert.equal(rowAfterLoss?.owner_id, loss.expectOwner, "a lost lease is never taken back or rewritten");

    const stateBefore = JSON.stringify(trading.snapshot());
    // The latch means even a restored-looking clock/row cannot revive this repository instance.
    f.setNow(1_100);
    for (const [label, call] of [
      ["verifyWriterLease", () => f.repository.verifyWriterLease()],
      ["loadLatest", () => f.repository.loadLatest()],
      ["loadFills", () => f.repository.loadFills()],
      ["loadHistory", () => f.repository.loadHistory()],
      ["clear", () => f.repository.clear()],
      ["save", () => f.repository.save(trading.snapshot())],
    ]) assert.throws(call, /PAPER_WRITER_LEASE_LOST/, `${label} must fail closed after the lease is lost`);

    assert.equal(f.ledgerCount(), ledgerBefore, "no fill-ledger row is written or deleted after the loss");
    assert.deepEqual(f.leaseRow(), rowAfterLoss, "the lease row is untouched by the failed calls");

    // Paper execution loop: the order is refused (FAILED), nothing changes in memory or on disk.
    const result = trading.submitManualOrder(command("after-loss-order-0002"), context(1_100));
    assert.equal(result.status, "FAILED");
    assert.equal(result.reason, "paper account persistence failed");
    assert.equal(JSON.stringify(trading.snapshot()), stateBefore, "in-memory account is not advanced by a refused order");
    assert.match(trading.persistenceFailureDetail() ?? "", /PAPER_WRITER_LEASE_LOST/);
    assert.equal(f.ledgerCount(), ledgerBefore);
    const limit = trading.openLimitOrder({ ...command("after-loss-limit-0003"), orderType: "LIMIT", limitPrice: 90 }, context(1_100));
    assert.equal(limit.status, "FAILED", "the limit-order write path is refused too");
    assert.equal(JSON.stringify(trading.snapshot()), stateBefore);
    assert.equal(f.ledgerCount(), ledgerBefore);
  });
}

test("a still-held lease keeps renewing (control: the loss tests are not vacuous)", (t) => {
  const f = fixture(t);
  f.setNow(1_000 + HEARTBEAT_MS);
  f.heartbeat();
  assert.equal(f.leaseRow().lease_until_ms, 1_000 + HEARTBEAT_MS + LEASE_MS);
  assert.doesNotThrow(() => f.repository.verifyWriterLease());
});

// ---- production runtime: the process must stop and exit, not continue with a lost lease ----

const baseEnv = {
  NUSA_CLOUD_RESEARCH_EXPERIMENTS: "0", NUSA_SOURCE_COMMIT: "b".repeat(40),
  NUSA_CLOUD_DASHBOARD_PORT: "41731", NUSA_CLOUD_DASHBOARD_TOKEN: "synthetic-test-only-not-a-credential".repeat(2),
  NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW: "10000000",
};

for (const loss of [
  { name: "owner replaced", apply: (db) => db.connection.prepare("UPDATE cloud_paper_writer_leases SET owner_id = 'different-owner'").run(), cause: "PAPER_WRITER_LEASE_OWNER_MISMATCH" },
  { name: "row deleted", apply: (db) => db.connection.prepare("DELETE FROM cloud_paper_writer_leases").run(), cause: "PAPER_WRITER_LEASE_ROW_MISSING" },
]) {
  test(`production scheduler requests fatal shutdown and exit code 1 when the lease is lost (${loss.name})`, async (t) => {
    const db = new storage.SqliteDatabase(":memory:");
    const directory = mkdtempSync(join(tmpdir(), "nusa-lease-loss-exit-"));
    const runtimeEnv = { ...baseEnv, NUSA_CLOUD_STATE_DB_PATH: join(directory, "state.sqlite") };
    const priorExitCode = process.exitCode;
    const errors = [];
    let repository;
    let runtimeStopped = 0;
    t.mock.method(storage, "SqliteDatabase", function () { return db; });
    t.mock.method(console, "error", (...args) => { errors.push(args.join(" ")); });
    t.mock.method(runtime, "startCloudRuntimeFromOptions", (options) => {
      repository = options.paperAccountRepository;
      return { stop: async () => { runtimeStopped++; }, listPaperRealizedPeriods: () => [], nextPaperRealizedPeriodIndex: () => 0 };
    });
    let fatalRequests = 0;
    const fatal = new Promise((resolve) => {
      const composition = startClosedLearningProductionRuntime(runtimeEnv, () => { fatalRequests++; resolve(); });
      t.after(async () => { await composition.handle.stop(); });
      // Synchronously after startup, before the deferred first tick (setTimeout 0) runs.
      loss.apply(db);
    });
    try {
      await Promise.race([fatal, new Promise((_, reject) => setTimeout(() => reject(new Error("no fatal shutdown requested after lease loss")), 5_000).unref())]);
      assert.equal(fatalRequests, 1, "the daemon is asked to shut down exactly once");
      assert.equal(process.exitCode, 1, "the process exit code is set to failure so the supervisor restarts it");
      assert.ok(errors.some((line) => line.includes("scheduler failed closed: PAPER_WRITER_LEASE_LOST")), "operator-visible fail-closed line (matches the host journal)");
      const record = JSON.parse(readFileSync(join(directory, "runtime-last-failure.json"), "utf8"));
      assert.equal(record.kind, "CLOSED_LEARNING_SCHEDULER");
      assert.equal(record.code, "PAPER_WRITER_LEASE_LOST");
      assert.equal(record.causeCode, loss.cause);
      assert.equal(db.connection.prepare("SELECT COUNT(*) AS c FROM cloud_paper_writer_leases WHERE owner_id <> 'different-owner'").get().c, 0, "the lost lease is not taken back");
    } finally {
      process.exitCode = priorExitCode;
      repository?.close();
      await Promise.resolve();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("the scheduler poll that detects a lost lease runs at least as often as the lease TTL", () => {
  assert.ok(CLOSED_LEARNING_ROLLOVER_POLL_INTERVAL_MS <= LEASE_MS, "a lost lease is acted on within one TTL");
});
