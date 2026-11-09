"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { mkdtempSync, rmSync } = require("node:fs");
const storage = require("../dist/packages/storage/src/index.js");
const { ResearchRecoveryCoordinator } = require("../dist/apps/cloud/src/researchRecoveryCoordinator.js");
const { composeResearchExperiments } = require("../dist/apps/cloud/src/researchExperimentComposition.js");
const { SqliteCloudPaperAccountRepository, paperAccountIdForCapital } = require("../dist/apps/cloud/src/paperTradingExecutionLoop.js");
const runtime = require("../dist/apps/cloud/src/runtime.js");
const { startClosedLearningProductionRuntime } = require("../dist/apps/cloud/src/closedLearningProductionRuntime.js");
const env = {
  NUSA_CLOUD_RESEARCH_EXPERIMENTS: "1", NUSA_SOURCE_COMMIT: "b".repeat(40),
  NUSA_RESEARCH_INTERVAL_MINUTES: "1,15,60", NUSA_RESEARCH_BACKFILL: "DISABLED",
  NUSA_CLOUD_DASHBOARD_PORT: "41731", NUSA_CLOUD_DASHBOARD_TOKEN: "synthetic-test-only-not-a-credential".repeat(2),
  NUSA_CLOUD_STATE_DB_PATH: join(tmpdir(), "nusa-synthetic-startup-no-write", "state.sqlite"),
  NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW: "10000000",
};

test("preparation never pauses running sessions; writer-held recovery still does", () => {
  const db = new storage.SqliteDatabase(":memory:");
  const composition = composeResearchExperiments({ env, database: db });
  const sessions = new storage.SqliteResearchSessionRepository(db);
  try {
    composition.orchestrator.recover();
    composition.tickOnce();
    const before = sessions.list();
    assert.ok(before.some((session) => session.state === "RUNNING"));
    composition.prepareRecovery();
    assert.deepEqual(sessions.list(), before);
    composition.orchestrator.recover();
    assert.ok(sessions.list().every((session) => session.state === "PAUSED"));
  } finally { composition.stop(); db.close(); }
});

test("external connection mutation invalidates prepared evidence rather than reusing READY", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nusa-startup-data-version-"));
  const db = new storage.SqliteDatabase(join(directory, "state.sqlite"));
  const other = new storage.SqliteDatabase(join(directory, "state.sqlite"));
  const original = ResearchRecoveryCoordinator.prototype.recover;
  let validations = 0;
  t.mock.method(ResearchRecoveryCoordinator.prototype, "recover", function () {
    validations++;
    return validations === 1 ? original.call(this) : { status: "FAIL_CLOSED", snapshot: null, reasons: ["SYNTHETIC_CHANGED_EVIDENCE"] };
  });
  const composition = composeResearchExperiments({ env, database: db });
  try {
    composition.prepareRecovery();
    other.connection.exec("CREATE TABLE synthetic_external_change (id INTEGER)");
    assert.equal(composition.orchestrator.recover().status, "FAIL_CLOSED");
    assert.equal(validations, 2);
    assert.equal(composition.orchestrator.tick().status, "RECOVERY_NOT_READY");
  } finally { composition.stop(); other.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("prepared read-only validation is shared only during startup; actual per-variant recovery still runs", (t) => {
  const db = new storage.SqliteDatabase(":memory:");
  const original = ResearchRecoveryCoordinator.prototype.recover;
  let validations = 0;
  t.mock.method(ResearchRecoveryCoordinator.prototype, "recover", function () { validations++; return original.call(this); });
  const composition = composeResearchExperiments({ env, database: db });
  try {
    composition.prepareRecovery();
    assert.equal(validations, 1);
    for (const orchestrator of composition.orchestrators) assert.equal(orchestrator.recover().status, "READY");
    assert.equal(validations, 1, "do not replay the same evidence for all thirty variants");
    composition.finishPreparedRecovery();
    assert.equal(composition.orchestrator.recover().status, "READY");
    assert.equal(validations, 11, "ordinary recovery revalidates all ten first-interval variants");
  } finally { composition.stop(); db.close(); }
});

test("failed prepared evidence remains fail-closed through real orchestrator and tick gates", (t) => {
  const db = new storage.SqliteDatabase(":memory:");
  const failure = Object.freeze({ status: "FAIL_CLOSED", snapshot: null, reasons: ["SYNTHETIC_CORRUPTION"] });
  let validations = 0;
  t.mock.method(ResearchRecoveryCoordinator.prototype, "recover", () => { validations++; return failure; });
  const composition = composeResearchExperiments({ env, database: db });
  try {
    composition.prepareRecovery();
    for (const orchestrator of composition.orchestrators) {
      assert.equal(orchestrator.recover(), failure);
      assert.equal(orchestrator.tick().status, "RECOVERY_NOT_READY");
    }
    assert.equal(validations, 1);
    composition.finishPreparedRecovery();
    assert.equal(composition.orchestrator.recover(), failure);
    assert.equal(validations, 2);
  } finally { composition.stop(); db.close(); }
});

for (const duringPreparation of [false, true]) {
  test(`same-connection corrupted champion invalidates READY (during preparation=${duringPreparation})`, (t) => {
    const db = new storage.SqliteDatabase(":memory:");
    const corrupt = () => db.connection.prepare("INSERT INTO research_champion_pointer (id, candidate_id, updated_at) VALUES (1, ?, ?)").run("synthetic-missing-champion", 1000);
    const original = ResearchRecoveryCoordinator.prototype.recover;
    let calls = 0;
    t.mock.method(ResearchRecoveryCoordinator.prototype, "recover", function () {
      const result = original.call(this);
      if (++calls === 1 && duringPreparation) corrupt();
      return result;
    });
    const composition = composeResearchExperiments({ env, database: db });
    try {
      composition.prepareRecovery();
      if (!duringPreparation) corrupt();
      const result = composition.orchestrator.recover();
      assert.equal(result.status, "FAIL_CLOSED");
      assert.ok(result.reasons.includes("CHAMPION_POINTER_LIFECYCLE_MISMATCH"));
      assert.equal(composition.orchestrator.tick().status, "RECOVERY_NOT_READY");
      assert.equal(calls, 2);
    } finally { composition.stop(); db.close(); }
  });
}

test("start disposes prepared evidence before recurring recovery", (t) => {
  const db = new storage.SqliteDatabase(":memory:");
  const original = ResearchRecoveryCoordinator.prototype.recover;
  let calls = 0;
  t.mock.method(ResearchRecoveryCoordinator.prototype, "recover", function () { calls++; return original.call(this); });
  const composition = composeResearchExperiments({ env, database: db });
  try {
    composition.prepareRecovery();
    composition.orchestrator.recover();
    composition.start();
    assert.equal(calls, 1);
    composition.orchestrator.recover();
    assert.equal(calls, 11);
  } finally { composition.stop(); db.close(); }
});

for (const competingOwner of [false, true]) {
  test(`production validates before acquiring writer lease, without starting runtime (competing=${competingOwner})`, (t) => {
    const db = new storage.SqliteDatabase(":memory:");
    const createSession = db.connection.createSession;
    let closedEvidenceTrackers = 0;
    t.mock.method(db.connection, "createSession", function (options) {
      const session = createSession.call(this, options);
      return {
        changeset() { return session.changeset(); },
        close() { closedEvidenceTrackers++; session.close(); },
      };
    });
    const accountId = paperAccountIdForCapital(10000000);
    const now = 1000000;
    t.mock.method(Date, "now", () => now);
    const owner = competingOwner ? new SqliteCloudPaperAccountRepository(db, { accountId, ownerId: "owner-a", now: () => now }) : undefined;
    const sessions = new storage.SqliteResearchSessionRepository(db);
    const setupResearch = composeResearchExperiments({ env, database: db, now: () => now });
    setupResearch.orchestrator.recover();
    setupResearch.tickOnce();
    setupResearch.stop();
    const sessionsBefore = sessions.list();
    const before = db.connection.prepare("SELECT * FROM cloud_paper_writer_leases").all();
    const original = ResearchRecoveryCoordinator.prototype.recover;
    let validations = 0;
    t.mock.method(ResearchRecoveryCoordinator.prototype, "recover", function () {
      validations++;
      if (validations === 1) assert.deepEqual(db.connection.prepare("SELECT * FROM cloud_paper_writer_leases").all(), before, "read-only evidence preparation precedes lease acquisition");
      const aiDurabilityTables = db.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ai_calibration_durability_meta', 'ai_outcome_attribution_memory_meta') ORDER BY name").all().map((row) => row.name);
      assert.deepEqual(aiDurabilityTables, ["ai_calibration_durability_meta", "ai_outcome_attribution_memory_meta"], "Cloud AI schema initialization must finish before research recovery evidence is prepared");
      return original.call(this);
    });
    t.mock.method(storage, "SqliteDatabase", function () { return db; });
    const boundary = new Error("SYNTHETIC_RUNTIME_BOUNDARY");
    let repository;
    t.mock.method(runtime, "startCloudRuntimeFromOptions", (options) => {
      repository = options.paperAccountRepository;
      assert.deepEqual(db.connection.prepare("SELECT * FROM cloud_paper_writer_leases").all(), before, "runtime composition does not modify an existing PAPER lease");
      return {
        startPaperRuntime: () => repository.startWriterLease(),
        recoverResearch: () => {
          repository.verifyWriterLease();
          const recovery = options.researchAutomation.recover();
          assert.equal(recovery.status, "READY", JSON.stringify(recovery));
          assert.equal(validations, 1, "the prepared read-only evidence is reused once runtime composition is complete");
          repository.verifyWriterLease();
          throw boundary;
        },
        stop: async () => {},
        listPaperRealizedPeriods: () => [],
        nextPaperRealizedPeriodIndex: () => 0,
      };
    });
    try {
      if (competingOwner) {
        assert.throws(() => startClosedLearningProductionRuntime(env), /PAPER_WRITER_ALREADY_ACTIVE/);
        assert.deepEqual(db.connection.prepare("SELECT * FROM cloud_paper_writer_leases").all(), before);
        assert.deepEqual(sessions.list(), sessionsBefore, "read-only preparation cannot disturb the current owner's sessions");
        assert.ok(repository, "deferred repository exists, but its lease acquisition fails closed before runtime starts");
      } else {
        assert.throws(() => startClosedLearningProductionRuntime(env), (error) => error === boundary);
        assert.equal(validations, 1);
        assert.ok(db.connection.prepare("SELECT owner_id FROM cloud_paper_writer_leases WHERE account_id = ?").get(accountId));
      }
      assert.equal(closedEvidenceTrackers, 5, "every prepared evidence tracker closes when startup aborts");
    } finally { repository?.close(); owner?.close(); db.close(); }
  });
}

for (const handoff of [
  { name: "valid current owner", advanceAfterStartMs: 0, expected: "renewed" },
  { name: "expired owner", advanceAfterStartMs: 120_000, expected: "fail-closed" },
  { name: "mismatched owner", advanceAfterStartMs: 0, expected: "fail-closed", replaceOwner: true },
]) {
  test(`production renews only a still-valid lease after synchronous runtime composition (${handoff.name})`, async (t) => {
    const db = new storage.SqliteDatabase(":memory:");
    const directory = mkdtempSync(join(tmpdir(), "nusa-startup-lease-handoff-"));
    const runtimeEnv = { ...env, NUSA_CLOUD_RESEARCH_EXPERIMENTS: "0", NUSA_CLOUD_STATE_DB_PATH: join(directory, "state.sqlite") };
    let now = 1_000_000;
    let repository;
    let runtimeStopped = 0;
    const realVerify = SqliteCloudPaperAccountRepository.prototype.verifyWriterLease;
    let handoffCalls = 0;
    t.mock.method(Date, "now", () => now);
    t.mock.method(storage, "SqliteDatabase", function () { return db; });
    t.mock.method(SqliteCloudPaperAccountRepository.prototype, "verifyWriterLease", function () {
      handoffCalls++;
      return realVerify.call(this);
    });
    t.mock.method(runtime, "startCloudRuntimeFromOptions", (options) => {
      repository = options.paperAccountRepository;
      assert.equal(db.connection.prepare("SELECT account_id FROM cloud_paper_writer_leases").get(), undefined, "the writer lease must not start before synchronous runtime composition");
      return {
        startPaperRuntime: () => {
          now += 39_898;
          repository.startWriterLease();
        },
        recoverResearch: () => {
          assert.ok(db.connection.prepare("SELECT account_id FROM cloud_paper_writer_leases").get(), "the lease is held before stateful recovery");
          now += handoff.advanceAfterStartMs;
          if (handoff.replaceOwner) db.connection.prepare("UPDATE cloud_paper_writer_leases SET owner_id = 'different-owner' WHERE account_id = ?").run(paperAccountIdForCapital(10000000));
        },
        stop: async () => { runtimeStopped++; },
        listPaperRealizedPeriods: () => [],
        nextPaperRealizedPeriodIndex: () => 0,
      };
    });

    try {
      if (handoff.expected === "renewed") {
        const composition = startClosedLearningProductionRuntime(runtimeEnv);
        const acquired = db.connection.prepare("SELECT account_id, owner_id, lease_until_ms FROM cloud_paper_writer_leases").get();
        assert.ok(acquired, "the runtime acquires the writer lease after its 39.9-second synchronous composition");
        const renewed = db.connection.prepare("SELECT lease_until_ms FROM cloud_paper_writer_leases").get();
        assert.equal(handoffCalls, 7, "the lease is renewed after each of the three lease-start phases and between the four runtime phases");
        assert.equal(renewed.lease_until_ms, now + 120_000, "the valid lease receives one fresh production TTL");
        await composition.handle.stop();
        assert.equal(runtimeStopped, 1);
      } else {
        assert.throws(() => startClosedLearningProductionRuntime(runtimeEnv), /PAPER_WRITER_LEASE_LOST/);
        assert.equal(handoffCalls, 5, "renewal stops at the first renewal that finds the lease expired or taken over");
        assert.equal(runtimeStopped, 1, "a listener/runtime created before failed handoff is stopped");
        const row = db.connection.prepare("SELECT owner_id, lease_until_ms FROM cloud_paper_writer_leases").get();
        if (handoff.advanceAfterStartMs >= 120_000) assert.equal(row.lease_until_ms, 1_159_898, "the lease's startup hydration renewal is retained, but the expired lease is not renewed again");
        if (handoff.replaceOwner) assert.equal(row.owner_id, "different-owner", "handoff does not take over a different owner");
      }
    } finally {
      repository?.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const table of ["research_evaluation_ledger", "research_promotion_audit", "research_promotion_commands", "research_candidates"]) {
  test(`same-connection corruption of ${table} invalidates prepared evidence`, () => {
    const db = new storage.SqliteDatabase(":memory:");
    const composition = composeResearchExperiments({ env, database: db });
    try {
      composition.prepareRecovery();
      if (table === "research_evaluation_ledger") db.connection.exec("INSERT INTO research_evaluation_ledger VALUES (1, 'synthetic', 'bad', '{', 'bad')");
      else if (table === "research_promotion_audit") db.connection.exec("INSERT INTO research_promotion_audit VALUES (1, 'synthetic', 'bad', '{', 'bad')");
      else if (table === "research_candidates") db.connection.exec("INSERT INTO research_candidates VALUES ('synthetic', '{', 'DRAFT', 1, 'bad')");
      else db.connection.exec("INSERT INTO research_promotion_commands VALUES ('synthetic', 'bad', '{', 1)");
      assert.equal(composition.orchestrator.recover().status, "FAIL_CLOSED");
      assert.equal(composition.orchestrator.tick().status, "RECOVERY_NOT_READY");
    } finally { composition.stop(); db.close(); }
  });
}

for (const table of ["research_candidates", "research_promotion_commands"]) {
test(`NULL primary key in ${table} cannot evade SQLite change tracking`, () => {
  const db = new storage.SqliteDatabase(":memory:");
  const composition = composeResearchExperiments({ env, database: db });
  try {
    composition.prepareRecovery();
    if (table === "research_candidates") db.connection.exec("INSERT INTO research_candidates VALUES (NULL, '{', 'DRAFT', 1, 'bad')");
    else db.connection.exec("INSERT INTO research_promotion_commands VALUES (NULL, 'bad', '{', 1)");
    assert.equal(composition.orchestrator.recover().status, "FAIL_CLOSED");
    assert.equal(composition.orchestrator.tick().status, "RECOVERY_NOT_READY");
  } finally { composition.stop(); db.close(); }
});

}

test("schema changes force fresh evidence validation", (t) => {
  const db = new storage.SqliteDatabase(":memory:");
  const original = ResearchRecoveryCoordinator.prototype.recover;
  let calls = 0;
  t.mock.method(ResearchRecoveryCoordinator.prototype, "recover", function () { calls++; return original.call(this); });
  const composition = composeResearchExperiments({ env, database: db });
  try {
    composition.prepareRecovery();
    db.connection.exec("CREATE TABLE synthetic_unrelated_schema (id INTEGER PRIMARY KEY)");
    assert.equal(composition.orchestrator.recover().status, "READY");
    assert.equal(calls, 2);
  } finally { composition.stop(); db.close(); }
});


test("external evidence commit during tracker inspection cannot reuse READY", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nusa-startup-inspection-race-"));
  const db = new storage.SqliteDatabase(join(directory, "state.sqlite"));
  const other = new storage.SqliteDatabase(join(directory, "state.sqlite"));
  const original = db.connection.createSession;
  let armed = false;
  let remainingVariants = 10; // The configured first-interval grid has ten variants.
  t.mock.method(db.connection, "createSession", function (options) {
    const session = original.call(this, options);
    return {
      changeset() {
        if (armed && options.table === "research_evaluation_ledger" && --remainingVariants === 0) { armed = false; other.connection.exec("INSERT INTO research_champion_pointer VALUES (1, 'synthetic-missing', 1)"); }
        return session.changeset();
      },
      close() { session.close(); },
    };
  });
  const composition = composeResearchExperiments({ env, database: db });
  try {
    composition.prepareRecovery();
    armed = true;
    const result = composition.orchestrator.recover();
    assert.equal(armed, false, "external mutation must occur during the final variant inspection");
    assert.equal(result.status, "FAIL_CLOSED");
    assert.ok(result.reasons.includes("CHAMPION_POINTER_LIFECYCLE_MISMATCH"));
    assert.equal(composition.orchestrator.tick().status, "RECOVERY_NOT_READY");
  } finally { composition.stop(); other.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("fresh validation retries a final-variant external commit instead of returning stale READY", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nusa-startup-fresh-validation-race-"));
  const db = new storage.SqliteDatabase(join(directory, "state.sqlite"));
  const other = new storage.SqliteDatabase(join(directory, "state.sqlite"));
  const createSession = db.connection.createSession;
  const recover = ResearchRecoveryCoordinator.prototype.recover;
  let armedInspection = false;
  let armedFreshValidation = false;
  let remainingVariants = 10;
  let validations = 0;
  t.mock.method(ResearchRecoveryCoordinator.prototype, "recover", function () {
    validations++;
    const result = recover.call(this);
    if (armedFreshValidation) {
      armedFreshValidation = false;
      other.connection.exec("INSERT INTO research_champion_pointer VALUES (1, 'synthetic-missing', 1)");
    }
    return result;
  });
  t.mock.method(db.connection, "createSession", function (options) {
    const session = createSession.call(this, options);
    return {
      changeset() {
        if (armedInspection && options.table === "research_evaluation_ledger" && --remainingVariants === 0) {
          armedInspection = false;
          other.connection.exec("CREATE TABLE synthetic_final_variant_change (id INTEGER PRIMARY KEY)");
          armedFreshValidation = true;
        }
        return session.changeset();
      },
      close() { session.close(); },
    };
  });
  const composition = composeResearchExperiments({ env, database: db });
  try {
    composition.prepareRecovery();
    armedInspection = true;
    const result = composition.orchestrator.recover();
    assert.equal(armedInspection, false, "external mutation must invalidate the final cached variant");
    assert.equal(armedFreshValidation, false, "second mutation must land after fresh recovery reads");
    assert.equal(result.status, "FAIL_CLOSED");
    assert.ok(result.reasons.includes("CHAMPION_POINTER_LIFECYCLE_MISMATCH"));
    assert.equal(validations, 3, "unstable READY is discarded and the changed evidence is re-read");
    assert.equal(composition.orchestrator.tick().status, "RECOVERY_NOT_READY");
  } finally { composition.stop(); other.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("persistently unstable fresh evidence exhausts exactly three attempts and fails closed", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nusa-startup-persistent-race-"));
  const db = new storage.SqliteDatabase(join(directory, "state.sqlite"));
  const other = new storage.SqliteDatabase(join(directory, "state.sqlite"));
  const createSession = db.connection.createSession;
  const recover = ResearchRecoveryCoordinator.prototype.recover;
  let validations = 0;
  let closedEvidenceTrackers = 0;
  let armed = false;
  t.mock.method(db.connection, "createSession", function (options) {
    const session = createSession.call(this, options);
    return {
      changeset() { return session.changeset(); },
      close() { closedEvidenceTrackers++; session.close(); },
    };
  });
  t.mock.method(ResearchRecoveryCoordinator.prototype, "recover", function () {
    validations++;
    const result = recover.call(this);
    if (armed) other.connection.exec(`CREATE TABLE synthetic_unstable_${validations} (id INTEGER PRIMARY KEY)`);
    return result;
  });
  const composition = composeResearchExperiments({ env, database: db });
  try {
    composition.prepareRecovery();
    assert.equal(validations, 1);
    other.connection.exec("CREATE TABLE synthetic_invalidate_cache (id INTEGER PRIMARY KEY)");
    armed = true;
    const result = composition.orchestrator.recover();
    assert.equal(result.status, "FAIL_CLOSED");
    assert.deepEqual(result.reasons, ["RECOVERY_EVIDENCE_UNSTABLE"]);
    assert.equal(validations, 4, "one preparation plus exactly three rejected fresh validations");
    assert.equal(closedEvidenceTrackers, 20, "cached five plus every tracker from three rejected attempts closes");
    assert.equal(composition.orchestrator.tick().status, "RECOVERY_NOT_READY");
  } finally { composition.stop(); other.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
