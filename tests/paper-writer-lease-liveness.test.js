const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const productionRoot = "apps/cloud/src/closedLearningProductionRuntime.ts";
const riskGateway = "apps/cloud/src/cloudPaperCanonicalRiskGateway.ts";
const canonicalStorage = "packages/storage/src/index.ts";

test("PAPER startup completes synchronous composition before acquiring its writer lease", () => {
  const source = fs.readFileSync(productionRoot, "utf8");
  const ai = source.indexOf("const cloudAiRuntime = createCloudAiRuntime(env");
  const lease = source.indexOf("new SqliteCloudPaperAccountRepository(database");
  const runtime = source.indexOf("const baseHandle = startCloudRuntimeFromOptions({");
  const startLease = source.indexOf("baseHandle.startPaperRuntime();", runtime);
  const recover = source.indexOf("baseHandle.recoverResearch();", startLease);
  const experiments = source.indexOf("researchExperiments?.start();", recover);
  const scheduler = source.indexOf("initialTimer = setTimeout(scheduleTick, 0);", recover);

  assert.ok(ai >= 0, "prebuilt Cloud AI runtime must be explicit");
  assert.match(source.slice(ai, ai + 350), /verifiedSharedSqliteDatabase:\s*database/, "the prebuilt Cloud AI runtime must reuse only the SqliteDatabase whose constructor completed the canonical full-file integrity scan");
  assert.ok(lease > ai, "Cloud AI durability must open/verify before the PAPER repository acquires its renewable lease");
  assert.ok(runtime > lease, "the deferred repository is passed into runtime composition without owning the lease");
  assert.match(source.slice(lease, runtime), /deferWriterLease: true/);
  assert.ok(startLease > runtime, "the lease starts only after closed-learning runtime composition");
  assert.ok(recover > startLease && experiments > recover && scheduler > experiments, "stateful recovery and scheduled work start only after the lease is owned");
  assert.match(source.slice(runtime, runtime + 400), /deferPaperRuntimeStart: true/);
  assert.match(source.slice(runtime, runtime + 1000), /researchAutomation: researchExperiments\?\.orchestrator,\s*aiRuntime: cloudAiRuntime,/);
  assert.doesNotMatch(source.slice(runtime, runtime + 1000), /createCloudAiRuntime\(env\)/);
});

test("full SQLite integrity remains fail-closed at canonical database open, not the PAPER risk hot path", () => {
  const storage = fs.readFileSync(canonicalStorage, "utf8");
  const risk = fs.readFileSync(riskGateway, "utf8");

  assert.match(storage, /sqliteIntegrityBoundary\.read\(sqliteIntegrityBoundary\.prepare\(this\.connection, "PRAGMA quick_check"\)\)/, "canonical SqliteDatabase startup must retain the full-file quick_check through the preloaded native boundary");
  assert.doesNotMatch(risk, /PRAGMA quick_check/, "a PAPER risk evaluation must never rescan the full database");
  assert.match(risk, /SELECT 1 AS ready/, "the hot path must still prove the canonical connection is responsive");
  for (const table of ["risk_paper_approvals", "risk_daily_loss_state", "risk_idempotency_records", "risk_order_state"]) {
    assert.ok(risk.includes(table), `Risk health must still require ${table}`);
  }
});

test("PAPER writer lease is renewed between each heavy synchronous startup phase", () => {
  const repo = fs.readFileSync("apps/cloud/src/paperTradingExecutionLoop.ts", "utf8");
  const start = repo.indexOf("public startWriterLease(): void {");
  const body = repo.slice(start, repo.indexOf("public save(state: PaperAccountState)", start));
  const order = ["this.acquireLease();", "this.verifyWriterLease();", "this.recoverRecognizedLegacyAccounting();", "this.verifyWriterLease();", "this.backfillFillLedgerFromHistory();", "this.verifyWriterLease();", "setInterval(() => this.heartbeatLease()"];
  let at = -1;
  for (const marker of order) {
    const next = body.indexOf(marker, at + 1);
    assert.ok(next > at, `${marker} must follow the previous startup step`);
    at = next;
  }
  const source = fs.readFileSync(productionRoot, "utf8");
  const runtime = source.indexOf("baseHandle.startPaperRuntime();");
  const tail = source.slice(runtime, source.indexOf("initialTimer = setTimeout(scheduleTick, 0);", runtime));
  const steps = ["baseHandle.startPaperRuntime();", "paperRepository?.verifyWriterLease();", "baseHandle.recoverResearch();", "paperRepository?.verifyWriterLease();", "researchExperiments?.start();", "paperRepository?.verifyWriterLease();", "researchExperiments?.finishPreparedRecovery();", "paperRepository?.verifyWriterLease();"];
  let cursor = -1;
  for (const marker of steps) {
    const next = tail.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `${marker} must follow the previous runtime step`);
    cursor = next;
  }
});

test("the production writer lease is 120 s with the heartbeat, takeover age and clock limits pinned explicitly", () => {
  const { PAPER_WRITER_LEASE_DURATION_MS, PAPER_WRITER_HEARTBEAT_INTERVAL_MS, PAPER_WRITER_MAX_CLOCK_ADVANCE_MS, PAPER_WRITER_MAX_TAKEOVER_AGE_MS } = require("../dist/apps/cloud/src/paperTradingExecutionLoop.js");
  assert.equal(PAPER_WRITER_LEASE_DURATION_MS, 120_000);
  assert.equal(PAPER_WRITER_HEARTBEAT_INTERVAL_MS, 10_000, "renewal cadence is unchanged from the 30 s lease");
  assert.equal(PAPER_WRITER_MAX_TAKEOVER_AGE_MS - PAPER_WRITER_LEASE_DURATION_MS, 90_000, "an expired lease stays takeable for the same 90 s after expiry as with the 30 s lease (120 s - 30 s)");
  assert.ok(PAPER_WRITER_MAX_CLOCK_ADVANCE_MS >= PAPER_WRITER_LEASE_DURATION_MS && PAPER_WRITER_MAX_CLOCK_ADVANCE_MS <= 120_000, "the clock-advance limit is the smallest value the validation allows");
  assert.ok(PAPER_WRITER_HEARTBEAT_INTERVAL_MS * 3 <= PAPER_WRITER_LEASE_DURATION_MS);
  const source = fs.readFileSync(productionRoot, "utf8");
  assert.match(source, /createLeaseStartupWindow\(PAPER_WRITER_LEASE_DURATION_MS,/, "the startup-window alarm follows the production lease");
});

test("a crashed writer's expired 120 s lease is taken over by the next start, and a lease older than the takeover age still fails closed", () => {
  const { SqliteDatabase } = require("../dist/packages/storage/src/index.js");
  const { SqliteCloudPaperAccountRepository } = require("../dist/apps/cloud/src/paperTradingExecutionLoop.js");
  const database = new SqliteDatabase(":memory:");
  let now = 1_000_000;
  const options = (ownerId) => ({ accountId: "paper-takeover", ownerId, now: () => now, deferWriterLease: true });
  const crashed = new SqliteCloudPaperAccountRepository(database, options("crashed-writer"));
  crashed.startWriterLease();
  // The crashed writer never releases or renews (SIGKILL). While its 120 s lease is valid a second writer is refused.
  now += 119_000;
  const early = new SqliteCloudPaperAccountRepository(database, options("early-writer"));
  assert.throws(() => early.startWriterLease(), /PAPER_WRITER_ALREADY_ACTIVE/);
  // Just after expiry the next start takes over (the supervisor's 31 s retry lands here).
  now += 6_000;
  const next = new SqliteCloudPaperAccountRepository(database, options("next-writer"));
  next.startWriterLease();
  assert.equal(database.connection.prepare("SELECT owner_id FROM cloud_paper_writer_leases WHERE account_id = ?").get("paper-takeover").owner_id, "next-writer");
  next.close();
  // A lease whose last heartbeat is older than the takeover age is not taken over automatically.
  const stale = new SqliteCloudPaperAccountRepository(database, options("stale-writer"));
  stale.startWriterLease();
  now += 211_000;
  const tooLate = new SqliteCloudPaperAccountRepository(database, options("too-late-writer"));
  assert.throws(() => tooLate.startWriterLease(), /PAPER_WRITER_CLOCK_ANOMALY/);
  for (const repository of [crashed, early, stale, tooLate]) repository.close();
  database.close();
});
