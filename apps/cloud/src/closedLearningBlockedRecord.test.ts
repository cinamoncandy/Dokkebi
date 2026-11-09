import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClosedLearningLoopStatusTracker } from "./closedLearningLoopStatus";
import { closedLearningBlockedRecordPath, readClosedLearningBlocked, recordClosedLearningBlocked } from "./closedLearningBlockedRecord";

const dbPath = (): string => path.join(mkdtempSync(path.join(tmpdir(), "nusa-blocked-")), "cloud-state.sqlite");

test("a recorded reason survives a read and only bare codes are accepted", () => {
  const db = dbPath();
  assert.equal(readClosedLearningBlocked(db), undefined);
  assert.equal(recordClosedLearningBlocked(db, { reason: "CANDIDATE_BINDING_MIXED", at: 1_700_000_000_000 }), true);
  assert.deepEqual({ ...readClosedLearningBlocked(db) }, { reason: "CANDIDATE_BINDING_MIXED", at: 1_700_000_000_000 });
  recordClosedLearningBlocked(db, { reason: "free text with spaces", at: 5 });
  recordClosedLearningBlocked(db, { reason: "TICK_ERROR", at: -1 });
  assert.equal(readClosedLearningBlocked(db)?.reason, "CANDIDATE_BINDING_MIXED", "invalid records never replace the stored one");
});

test("memory and relative paths are ignored, and corrupt or foreign files read as nothing", () => {
  assert.equal(closedLearningBlockedRecordPath(":memory:"), undefined);
  assert.equal(closedLearningBlockedRecordPath("relative.sqlite"), undefined);
  assert.equal(recordClosedLearningBlocked(":memory:", { reason: "TICK_ERROR", at: 1 }), false, "nothing is written, so the caller keeps retrying");
  assert.equal(recordClosedLearningBlocked("/nonexistent-directory-nusa/cloud-state.sqlite", { reason: "TICK_ERROR", at: 1 }), false, "a failed write reports false");
  const db = dbPath();
  writeFileSync(closedLearningBlockedRecordPath(db)!, "{not json");
  assert.equal(readClosedLearningBlocked(db), undefined);
  writeFileSync(closedLearningBlockedRecordPath(db)!, JSON.stringify({ schemaVersion: 2, reason: "TICK_ERROR", at: 1 }));
  assert.equal(readClosedLearningBlocked(db), undefined);
  writeFileSync(closedLearningBlockedRecordPath(db)!, JSON.stringify({ schemaVersion: 1, reason: "has space", at: 1 }));
  assert.equal(readClosedLearningBlocked(db), undefined);
});

test("a seeded reason fills the gap after a restart, and a reason seen by this process wins", () => {
  const seeded = new ClosedLearningLoopStatusTracker();
  seeded.seedLastBlocked({ reason: "CANDIDATE_BINDING_MIXED", at: 100 });
  seeded.observeRollover({ status: "WAITING_FOR_KST_DAY_ROLLOVER" } as never, 200);
  assert.equal(seeded.snapshot()?.lastBlockedReason, "CANDIDATE_BINDING_MIXED");
  assert.equal(seeded.snapshot()?.lastBlockedAt, 100, "the seed keeps its own, older timestamp");
  seeded.observeRollover({ status: "BLOCKED", reason: "PAPER_ACCOUNT_REPLACED_RETIREMENT_UNAVAILABLE" } as never, 300);
  assert.equal(seeded.snapshot()?.lastBlockedReason, "PAPER_ACCOUNT_REPLACED_RETIREMENT_UNAVAILABLE");
  assert.equal(seeded.lastBlockedRecord()?.at, 300);
  const late = new ClosedLearningLoopStatusTracker();
  late.observeRollover({ status: "BLOCKED", reason: "ALPHA_BLOCK" } as never, 400);
  late.seedLastBlocked({ reason: "OLD_REASON", at: 50 });
  assert.equal(late.snapshot()?.lastBlockedReason, "ALPHA_BLOCK", "a seed never overrides a reason already seen by this process");
  late.seedLastBlocked({ reason: "bad reason", at: 1 });
  assert.equal(new ClosedLearningLoopStatusTracker().lastBlockedRecord(), undefined);
});

// P0 #2589: the bounded class of a TICK_ERROR now survives a restart together with the reason and the time.
test("the error class of a TICK_ERROR is written and read back; an invalid class is dropped and old records still read", () => {
  const db = dbPath();
  assert.equal(recordClosedLearningBlocked(db, { reason: "TICK_ERROR", at: 1_700_000_000_000, errorClass: "ERR_SQLITE_BUSY" }), true);
  assert.deepEqual({ ...readClosedLearningBlocked(db) }, { reason: "TICK_ERROR", at: 1_700_000_000_000, errorClass: "ERR_SQLITE_BUSY" });
  assert.equal(recordClosedLearningBlocked(db, { reason: "TICK_ERROR", at: 1_700_000_000_001, errorClass: "has a message with spaces" }), true);
  assert.deepEqual({ ...readClosedLearningBlocked(db) }, { reason: "TICK_ERROR", at: 1_700_000_000_001 }, "free text is never stored");
  writeFileSync(closedLearningBlockedRecordPath(db)!, JSON.stringify({ schemaVersion: 1, reason: "TICK_ERROR", at: 5 }));
  assert.deepEqual({ ...readClosedLearningBlocked(db) }, { reason: "TICK_ERROR", at: 5 }, "a record written before this field has no class");
  writeFileSync(closedLearningBlockedRecordPath(db)!, JSON.stringify({ schemaVersion: 1, reason: "TICK_ERROR", at: 6, errorClass: "lower case" }));
  assert.deepEqual({ ...readClosedLearningBlocked(db) }, { reason: "TICK_ERROR", at: 6 });
});

test("a seeded TICK_ERROR keeps its class after a restart; other reasons never carry one", () => {
  const tick = new ClosedLearningLoopStatusTracker();
  tick.seedLastBlocked({ reason: "TICK_ERROR", at: 100, errorClass: "ERR_SQLITE_BUSY" });
  assert.deepEqual({ ...tick.lastBlockedRecord() }, { reason: "TICK_ERROR", at: 100, errorClass: "ERR_SQLITE_BUSY" });
  const other = new ClosedLearningLoopStatusTracker();
  other.seedLastBlocked({ reason: "CANDIDATE_BINDING_MIXED", at: 100, errorClass: "ERR_SQLITE_BUSY" });
  assert.deepEqual({ ...other.lastBlockedRecord() }, { reason: "CANDIDATE_BINDING_MIXED", at: 100 }, "a class is only meaningful for TICK_ERROR");
  const bad = new ClosedLearningLoopStatusTracker();
  bad.seedLastBlocked({ reason: "TICK_ERROR", at: 100, errorClass: "not a code" });
  assert.deepEqual({ ...bad.lastBlockedRecord() }, { reason: "TICK_ERROR", at: 100 });
});

test("a tick error observed by this process records its class for persistence and a later seed does not override it", () => {
  const live = new ClosedLearningLoopStatusTracker();
  live.observeError(500, "ERR_DISK_FULL");
  assert.deepEqual({ ...live.lastBlockedRecord() }, { reason: "TICK_ERROR", at: 500, errorClass: "ERR_DISK_FULL" });
  live.seedLastBlocked({ reason: "TICK_ERROR", at: 100, errorClass: "ERR_SQLITE_BUSY" });
  assert.deepEqual({ ...live.lastBlockedRecord() }, { reason: "TICK_ERROR", at: 500, errorClass: "ERR_DISK_FULL" }, "a reason seen by this process wins");
});
