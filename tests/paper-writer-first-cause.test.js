const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { SqliteDatabase } = require("../dist/packages/storage/src/index.js");
const { SqliteCloudPaperAccountRepository } = require("../dist/apps/cloud/src/paperTradingExecutionLoop.js");
const { recordRuntimeFailure, runtimeFailureRecordPath } = require("../dist/apps/cloud/src/runtimeFailureRecord.js");

// These tests are about first-cause retention, which does not depend on the production lease length, so they pin a short
// explicit lease (and the limits derived from it) and keep their fake-clock arithmetic.
function fixture(t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-writer-cause-"));
  const file = path.join(directory, "state.sqlite");
  const db = new SqliteDatabase(file);
  db.connection.exec("PRAGMA busy_timeout=0");
  let now = 100000;
  const repository = new SqliteCloudPaperAccountRepository(db, { ownerId: "test-owner", now: () => now, leaseDurationMs: 30_000 });
  t.after(() => { repository.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, file, repository, setNow: value => { now = value; } };
}

for (const [name, mutate, code] of [
  ["expired", f => f.setNow(130000), "PAPER_WRITER_LEASE_EXPIRED"],
  ["missing", f => f.db.connection.exec("DELETE FROM cloud_paper_writer_leases"), "PAPER_WRITER_LEASE_ROW_MISSING"],
  ["other owner", f => f.db.connection.exec("UPDATE cloud_paper_writer_leases SET owner_id='other-private-owner'"), "PAPER_WRITER_LEASE_OWNER_MISMATCH"],
  ["invalid clock", f => f.setNow(NaN), "PAPER_WRITER_CLOCK_INVALID"],
  ["clock regression", f => f.setNow(99999), "PAPER_WRITER_CLOCK_REGRESSION"],
  ["clock anomaly", f => f.setNow(160001), "PAPER_WRITER_CLOCK_ANOMALY"],
]) {
  test(`heartbeat retains ${name} first cause and stays fail-closed`, t => {
    const f = fixture(t);
    mutate(f);
    t.mock.timers.tick(10000);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) {
        f.setNow(100000);
        f.db.connection.prepare("INSERT OR REPLACE INTO cloud_paper_writer_leases(account_id,owner_id,lease_until_ms,heartbeat_at_ms) VALUES('paper-default','test-owner',130000,100000)").run();
        t.mock.timers.tick(10000);
      }
      assert.throws(() => f.repository.loadLatest(), error => {
        assert.equal(error.message, "PAPER_WRITER_LEASE_LOST");
        recordRuntimeFailure(f.file, "CLOSED_LEARNING_SCHEDULER", error, 1);
        assert.equal(JSON.parse(fs.readFileSync(runtimeFailureRecordPath(f.file), "utf8")).causeCode, code);
        return true;
      });
    }
    assert.equal(f.db.connection.prepare("SELECT count(*) n FROM cloud_paper_fill_ledger").get().n, 0);
  });
}

test("a real SQLite writer lock is preserved after the lock clears without regaining authority", t => {
  const f = fixture(t);
  const other = new DatabaseSync(f.file);
  try {
    other.exec("BEGIN IMMEDIATE");
    t.mock.timers.tick(10000);
    other.exec("ROLLBACK");
    assert.throws(() => f.repository.loadLatest(), error => {
      assert.equal(error.message, "PAPER_WRITER_LEASE_LOST");
      recordRuntimeFailure(f.file, "CLOSED_LEARNING_SCHEDULER", error);
      assert.equal(JSON.parse(fs.readFileSync(runtimeFailureRecordPath(f.file), "utf8")).causeCode, "SQLITE_BUSY");
      return true;
    });
    t.mock.timers.tick(10000);
    assert.throws(() => f.repository.loadFills(), /PAPER_WRITER_LEASE_LOST/);
  } finally { other.close(); }
});
