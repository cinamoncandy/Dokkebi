const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const { SqliteDatabase, SqliteResearchGapFillProgressStore, SqliteResearchManifestRetryStore } = require("../dist/packages/storage/src/index.js");
const M = 60_000;

test("gap-fill progress is durable per market and clear removes only the selected market", () => {
  const filename = join(mkdtempSync(join(tmpdir(), "nusa-gap-progress-")), "research.db");
  let db = new SqliteDatabase(filename);
  let store = new SqliteResearchGapFillProgressStore(db);
  const cursor = Date.UTC(2026, 10, 5, 12, 0, 0);
  store.save("KRW-BTC", { historyCursorStartMs: cursor, nextPass: "HISTORY", updatedAtMs: cursor + M });
  store.save("KRW-XRP", { historyCursorStartMs: cursor - M, nextPass: "HEAD", updatedAtMs: cursor + 2 * M });
  db.close();

  db = new SqliteDatabase(filename);
  store = new SqliteResearchGapFillProgressStore(db);
  try {
    assert.deepEqual(store.load("KRW-BTC"), { historyCursorStartMs: cursor, nextPass: "HISTORY", updatedAtMs: cursor + M });
    assert.deepEqual(store.load("KRW-XRP"), { historyCursorStartMs: cursor - M, nextPass: "HEAD", updatedAtMs: cursor + 2 * M });
    store.clear("KRW-BTC");
    assert.equal(store.load("KRW-BTC"), undefined);
    assert.equal(store.load("KRW-XRP").historyCursorStartMs, cursor - M);
  } finally { db.close(); }
});

test("pass-only state survives restart without inventing a history cursor and migrates legacy pass state", () => {
  const filename = join(mkdtempSync(join(tmpdir(), "nusa-gap-pass-state-")), "research.db");
  let db = new SqliteDatabase(filename);
  let store = new SqliteResearchGapFillProgressStore(db);
  const at = Date.UTC(2026, 10, 5, 12, 0, 0);
  store.saveNextPass("KRW-XRP", "HISTORY", at);
  assert.equal(store.load("KRW-XRP"), undefined, "pass state is not represented by a fabricated page cursor");
  assert.deepEqual(store.loadNextPass("KRW-XRP"), { nextPass: "HISTORY", updatedAtMs: at });
  db.close();

  db = new SqliteDatabase(filename);
  store = new SqliteResearchGapFillProgressStore(db);
  try {
    assert.equal(store.load("KRW-XRP"), undefined);
    assert.deepEqual(store.loadNextPass("KRW-XRP"), { nextPass: "HISTORY", updatedAtMs: at });
    const cursor = at - M;
    store.save("KRW-BTC", { historyCursorStartMs: cursor, nextPass: "HEAD", updatedAtMs: at });
    db.connection.exec("DROP TABLE research_gap_fill_pass_state"); // simulate the pre-migration schema
    const migrated = new SqliteResearchGapFillProgressStore(db);
    assert.deepEqual(migrated.load("KRW-BTC"), { historyCursorStartMs: cursor, nextPass: "HEAD", updatedAtMs: at });
    assert.deepEqual(migrated.loadNextPass("KRW-BTC"), { nextPass: "HEAD", updatedAtMs: at });
    migrated.saveNextPass("KRW-BTC", "HISTORY", at + M);
    assert.deepEqual(migrated.load("KRW-BTC"), { historyCursorStartMs: cursor, nextPass: "HISTORY", updatedAtMs: at + M }, "pass-only updates keep the legacy cursor row consistent");
  } finally { db.close(); }
});

test("pass-state SQLite failures roll back cursor writes and fail closed", () => {
  const db = new SqliteDatabase(":memory:");
  const store = new SqliteResearchGapFillProgressStore(db);
  const at = Date.UTC(2026, 10, 5, 12, 0, 0);
  try {
    db.connection.exec(`CREATE TRIGGER reject_gap_pass_state BEFORE INSERT ON research_gap_fill_pass_state
      BEGIN SELECT RAISE(ABORT, 'injected pass-state failure'); END`);
    assert.throws(() => store.save("KRW-BTC", { historyCursorStartMs: at - M, nextPass: "HISTORY", updatedAtMs: at }), /injected pass-state failure/);
    assert.equal(store.load("KRW-BTC"), undefined, "cursor and pass writes are atomic");
    assert.equal(store.loadNextPass("KRW-BTC"), undefined);
  } finally { db.close(); }
});

test("corrupt durable cursor fails closed instead of resetting history progress", () => {
  const db = new SqliteDatabase(":memory:");
  const store = new SqliteResearchGapFillProgressStore(db);
  const cursor = Date.UTC(2026, 10, 5, 12, 0, 0);
  try {
    store.save("KRW-BTC", { historyCursorStartMs: cursor, nextPass: "HISTORY", updatedAtMs: cursor });
    db.connection.prepare("UPDATE research_gap_fill_progress SET history_cursor_start_ms = 1 WHERE market = ?").run("KRW-BTC");
    assert.throws(() => store.load("KRW-BTC"), (error) => error.code === "PROGRESS_CORRUPT");
    assert.throws(() => store.save("BTC-KRW", { historyCursorStartMs: cursor, nextPass: "HEAD", updatedAtMs: cursor }), /market is invalid/);
  } finally { db.close(); }
});

test("manifest retry timestamps survive restart and reject malformed keys or timestamps", () => {
  const filename = join(mkdtempSync(join(tmpdir(), "nusa-manifest-retry-")), "research.db");
  const at = Date.UTC(2026, 10, 5, 12, 0, 0);
  let db = new SqliteDatabase(filename);
  let store = new SqliteResearchManifestRetryStore(db);
  store.recordAttempt("KRW-BTC", "60m", at, at - M);
  db.close();

  db = new SqliteDatabase(filename);
  store = new SqliteResearchManifestRetryStore(db);
  try {
    assert.deepEqual(store.lastAttempt("KRW-BTC", "60m"), { atMs: at, inputWatermarkMs: at - M });
    assert.throws(() => store.recordAttempt("KRW-BTC", "1m", 0, at), /metadata is invalid/);
    assert.throws(() => store.lastAttempt("KRW-BTC", "5m"), /interval is invalid/);
  } finally { db.close(); }
});
