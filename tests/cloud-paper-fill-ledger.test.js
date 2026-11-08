const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SqliteDatabase } = require("../dist/packages/storage/src/index.js");
const {
  PaperTradingExecutionLoop,
  SqliteCloudPaperAccountRepository,
} = require("../dist/apps/cloud/src/paperTradingExecutionLoop.js");

function tick(now = 1_000) {
  return {
    now,
    market: "KRW-BTC",
    price: 100,
    observedAt: now,
    mode: "PAPER",
    killSwitchActive: false,
    tradingAllowed: true,
    overallHealth: "HEALTHY",
    investmentPercent: 100,
    decisions: [{
      symbol: "KRW-BTC",
      action: "BUY",
      allocation: 0.1,
      decidedAt: now - 1,
    }],
  };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-paper-fill-ledger-"));
  const databasePath = path.join(directory, "state.sqlite");
  const db = new SqliteDatabase(databasePath);
  const repository = new SqliteCloudPaperAccountRepository(db);
  const loop = new PaperTradingExecutionLoop({
    initialCapital: 1_000,
    repository,
    readP0State: () => ({ openP0: false }),
  });
  return { directory, databasePath, db, repository, loop };
}

function closeFixture(fixture) {
  try { fixture.repository.close(); } catch {}
  try { fixture.db.close(); } catch {}
  fs.rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

test("durable PAPER fill ledger appends a fill exactly once across replay and restart", () => {
  const f = fixture();
  try {
    const result = f.loop.processTick(tick());
    assert.equal(result.status, "FILLED");
    const fills = f.repository.loadFills();
    assert.equal(fills.length, 1);
    assert.deepEqual(fills[0], result.fills[0]);

    f.repository.save(f.loop.snapshot());
    assert.equal(f.repository.loadFills().length, 1);

    const expected = structuredClone(f.loop.snapshot());
    f.repository.close();
    f.db.close();

    const reopenedDb = new SqliteDatabase(f.databasePath);
    const reopenedRepository = new SqliteCloudPaperAccountRepository(reopenedDb);
    try {
      const restored = new PaperTradingExecutionLoop({
        initialCapital: 1_000,
        repository: reopenedRepository,
        readP0State: () => ({ openP0: false }),
      });
      assert.deepEqual(restored.snapshot(), expected);
      assert.deepEqual(reopenedRepository.loadFills(), fills);
    } finally {
      reopenedRepository.close();
      reopenedDb.close();
    }
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("restart with an existing canonical fill ledger does not rescan all account history before the lease heartbeat can start", () => {
  const f = fixture();
  try {
    const result = f.loop.processTick(tick());
    assert.equal(result.status, "FILLED");
    f.repository.close();
    f.db.close();

    const reopenedDb = new SqliteDatabase(f.databasePath);
    // The startup lease is renewed between its heavy phases (WO-PAPER-20261108-LEASE-RENEW-PHASES), so the clock is read
    // once per renewal. The property under test is unchanged: with a canonical ledger, startup must not re-read every
    // historical account snapshot, which is asserted on the SQL itself instead of on the number of clock reads.
    let nowCalls = 0;
    const now = () => { nowCalls += 1; return 1_000 + nowCalls; };
    const statements = [];
    const originalPrepare = reopenedDb.connection.prepare.bind(reopenedDb.connection);
    reopenedDb.connection.prepare = (sql) => { statements.push(String(sql)); return originalPrepare(sql); };
    const reopenedRepository = new SqliteCloudPaperAccountRepository(reopenedDb, {
      ownerId: "restart-writer",
      now,
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
    });
    reopenedDb.connection.prepare = originalPrepare;
    try {
      assert.ok(nowCalls >= 1 && nowCalls <= 4, "the clock is read for the acquisition and at most once per renewal");
      assert.ok(statements.length > 0, "the statement spy observed the startup queries");
      assert.equal(statements.filter((sql) => /FROM\s+cloud_paper_account_history/i.test(sql)).length, 0, "a canonical fill ledger means no historical account snapshot is re-read at startup");
      assert.equal(reopenedRepository.loadFills().length, 1);
    } finally {
      reopenedRepository.close();
      reopenedDb.close();
    }
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("restart fails closed when durable PAPER fill ledger bytes are tampered", () => {
  const f = fixture();
  try {
    const result = f.loop.processTick(tick());
    assert.equal(result.status, "FILLED");
    f.repository.close();
    f.db.connection.prepare(
      "UPDATE cloud_paper_fill_ledger SET fill_json = ? WHERE account_id = ? AND sequence = 1"
    ).run(JSON.stringify({ ...result.fills[0], price: 101 }), "paper-default");
    f.db.close();

    const reopenedDb = new SqliteDatabase(f.databasePath);
    try {
      assert.throws(
        () => new SqliteCloudPaperAccountRepository(reopenedDb),
        /PAPER_FILL_LEDGER_CONFLICT|PAPER_FILL_LEDGER_CHECKSUM_MISMATCH/
      );
    } finally {
      reopenedDb.close();
    }
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("PAPER repository clear removes account history and canonical fill truth together", () => {
  const f = fixture();
  try {
    assert.equal(f.loop.processTick(tick()).status, "FILLED");
    assert.equal(f.repository.loadFills().length, 1);
    f.repository.clear();
    assert.equal(f.repository.loadLatest(), undefined);
    assert.deepEqual(f.repository.loadFills(), []);
    const historyCount = f.db.connection.prepare(
      "SELECT COUNT(*) AS count FROM cloud_paper_account_history WHERE account_id = ?"
    ).get("paper-default");
    assert.equal(Number(historyCount.count), 0);
  } finally {
    closeFixture(f);
  }
});
