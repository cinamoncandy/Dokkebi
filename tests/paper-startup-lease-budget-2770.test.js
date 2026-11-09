const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync, StatementSync } = require("node:sqlite");
const storage = require("../dist/packages/storage/src/index.js");
const { SqliteDatabase } = storage;
const { SqliteAiCalibrationDurableStore } = require("../dist/packages/storage/src/aiCalibrationDurability.js");
const { SqliteAiOutcomeAttributionMemory } = require("../dist/packages/storage/src/aiOutcomeAttributionMemory.js");
const { CloudPaperCanonicalRiskGateway, CLOUD_PAPER_RISK_LIMITS } = require("../dist/apps/cloud/src/cloudPaperCanonicalRiskGateway.js");
const { SqliteCloudPaperAccountRepository } = require("../dist/apps/cloud/src/paperTradingExecutionLoop.js");

// #2770 startup lease budget. Two defects shared one mechanism: work that re-reads the whole
// database while the renewable PAPER writer lease is held, starving its heartbeat, and work that
// repeated a full integrity scan on every risk evaluation. These pin the ordering and prove the
// hot path no longer performs a full-file scan -- while the canonical scan at open is retained.

const root = path.resolve(__dirname, "..");
const runtimeSource = fs.readFileSync(path.join(root, "apps", "cloud", "src", "closedLearningProductionRuntime.ts"), "utf8");
const cloudRuntimeSource = fs.readFileSync(path.join(root, "apps", "cloud", "src", "runtime.ts"), "utf8");
const storageSource = fs.readFileSync(path.join(root, "packages", "storage", "src", "index.ts"), "utf8");
const integrityBootstrapSource = fs.readFileSync(path.join(root, "packages", "storage", "src", "sqliteIntegrityBootstrap.ts"), "utf8");
const aiCalibrationSource = fs.readFileSync(path.join(root, "packages", "storage", "src", "aiCalibrationDurability.ts"), "utf8");
const aiAttributionSource = fs.readFileSync(path.join(root, "packages", "storage", "src", "aiOutcomeAttributionMemory.ts"), "utf8");
const riskGatewaySource = fs.readFileSync(path.join(root, "apps", "cloud", "src", "cloudPaperCanonicalRiskGateway.ts"), "utf8");
const readinessSource = fs.readFileSync(path.join(root, "scripts", "oracle-readiness-check.js"), "utf8");

const NOW = Date.parse("2026-10-01T12:00:00Z");

const REQUIRED_RISK_TABLES = ["risk_paper_approvals", "risk_daily_loss_state", "risk_idempotency_records", "risk_order_state"];

/** Observe SQLite's authorizer PRAGMA events without changing the protected statement methods. */
function countQuickChecks(database, body) {
  const quickChecks = [];
  database.connection.setAuthorizer((action, first, second) => {
    if (action === 19 && String(first).toLowerCase() === "quick_check") quickChecks.push(String(second ?? ""));
    return 0;
  });
  try {
    body();
  } finally {
    database.connection.setAuthorizer(null);
  }
  return quickChecks;
}

function baseState() {
  return {
    version: 1,
    initialCapital: 100_000,
    cash: 99_997,
    equity: 99_997,
    realizedPnL: -3,
    unrealizedPnL: 0,
    positions: [],
    orders: [],
    fills: [],
    processedIdempotencyKeys: [],
    updatedAt: NOW,
  };
}

function request(state) {
  return {
    path: "STRATEGY",
    commandId: "next",
    signalId: "next",
    clientOrderId: "next",
    strategyId: "bound-candidate",
    market: "KRW-BTC",
    side: "BUY",
    quantity: 1,
    price: 100,
    now: NOW,
    observedAt: NOW,
    maximumMarketAgeMs: 30_000,
    killSwitchActive: false,
    openP0: false,
    overallHealth: "HEALTHY",
    state,
  };
}

function gatewayFor(database) {
  return new CloudPaperCanonicalRiskGateway({
    database,
    initialCapital: 100_000,
    sourceCommitSha: "a".repeat(40),
    limits: { ...CLOUD_PAPER_RISK_LIMITS, maxOrdersPerMinute: 1_000, maxOrdersPerSecond: 1_000 },
  });
}

// ---- startup ordering ------------------------------------------------------------------------

// Cloud AI durability before the lease is asserted by tests/paper-writer-lease-liveness.test.js
// (merged #2779), which also pins the runtime composition argument. What that test does not cover
// is the third link in the same chain: the closed-learning scheduler must not start ticking until
// the runtime it schedules against is up behind the lease.
test("the runtime acquires its PAPER lease before first account access when activated", () => {
  const lease = cloudRuntimeSource.indexOf("effectivePaperRepository?.startWriterLease?.();");
  const paperLoop = cloudRuntimeSource.indexOf("effectivePaperLoop = paperExecutionLoop ??", lease);
  const firstAccountRead = cloudRuntimeSource.indexOf("dashboardHydrator.hydrate(effectiveProvider)", paperLoop);
  const listener = cloudRuntimeSource.indexOf("startCloudDashboardServer({", firstAccountRead);
  const scheduler = runtimeSource.indexOf("rolloverTimer = setInterval(scheduleTick,");
  assert.ok(lease > 0 && paperLoop > lease && firstAccountRead > paperLoop && listener > firstAccountRead, "lease acquisition must follow bulk runtime composition but precede PAPER account reads and the listener");
  assert.match(runtimeSource, /deferWriterLease: true/, "the composition root must not own a lease through runtime initialization");
  assert.ok(scheduler > runtimeSource.indexOf("const baseHandle = startCloudRuntimeFromOptions({"), "the closed-learning scheduler must start after the runtime it is scheduled against");
});

test("a deferred lease survives a 39.9-second composition delay and carries the 120-second production lease (WO-PAPER-20261108-LEASE-TTL-120)", () => {
  const database = new SqliteDatabase(":memory:");
  let now = NOW;
  const repository = new SqliteCloudPaperAccountRepository(database, {
    accountId: "paper-startup",
    ownerId: "startup-writer",
    now: () => now,
    deferWriterLease: true,
  });
  try {
    assert.equal(database.connection.prepare("SELECT owner_id FROM cloud_paper_writer_leases WHERE account_id = ?").get("paper-startup"), undefined);
    assert.throws(() => repository.loadLatest(), /PAPER_WRITER_LEASE_NOT_STARTED/);
    now += 39_898;
    repository.startWriterLease();
    const lease = database.connection.prepare("SELECT owner_id, lease_until_ms, heartbeat_at_ms FROM cloud_paper_writer_leases WHERE account_id = ?").get("paper-startup");
    assert.deepEqual({ ...lease }, { owner_id: "startup-writer", lease_until_ms: now + 120_000, heartbeat_at_ms: now });
    repository.startWriterLease();
    assert.deepEqual({ ...database.connection.prepare("SELECT owner_id, lease_until_ms, heartbeat_at_ms FROM cloud_paper_writer_leases WHERE account_id = ?").get("paper-startup") }, { ...lease }, "repeat start must not renew or replace the established owner");
  } finally {
    repository.close();
    database.close();
  }
});

test("the delayed PAPER startup and recovery remain before scheduler admission", () => {
  const listener = runtimeSource.indexOf("const baseHandle = startCloudRuntimeFromOptions({");
  const start = runtimeSource.indexOf("baseHandle.startPaperRuntime();", listener);
  const recover = runtimeSource.indexOf("baseHandle.recoverResearch();", start);
  const experiments = runtimeSource.indexOf("researchExperiments?.start();", recover);
  const handoff = runtimeSource.indexOf("paperRepository?.verifyWriterLease();", experiments);
  const scheduler = runtimeSource.indexOf("rolloverTimer = setInterval(scheduleTick,", handoff);
  assert.ok(listener > 0 && start > listener, "PAPER ownership starts after the last large synchronous composition step");
  assert.ok(recover > start && experiments > recover, "stateful recovery and interval admission remain behind exclusive PAPER ownership");
  assert.ok(handoff > experiments, "the exact-owner lease is checked after bounded synchronous recovery startup");
  assert.ok(scheduler > handoff, "lease handoff must complete before closed-learning scheduling begins");
});

// ---- risk hot path ---------------------------------------------------------------------------

test("a PAPER risk evaluation prepares no full-file integrity scan", () => {
  const database = new SqliteDatabase(":memory:");
  try {
    // The gateway is constructed outside the counter: only the per-evaluation path is under test.
    const gateway = gatewayFor(database);
    gateway.evaluate(request(baseState()));
    const quickChecks = countQuickChecks(database, () => {
      gateway.evaluate(request(baseState()));
    });
    assert.deepEqual(quickChecks, [], "PRAGMA quick_check must not run on the per-evaluation hot path");
  } finally {
    database.close();
  }
});

test("the risk hot path still fails closed when a required Risk table is missing", () => {
  const database = new SqliteDatabase(":memory:");
  try {
    assert.deepEqual(REQUIRED_RISK_TABLES.filter((table) => database.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) == null), [], "fixture must start with every required Risk table");
    database.connection.exec("DROP TABLE risk_order_state");
    const result = gatewayFor(database).evaluate(request(baseState()));
    assert.notEqual(result.status, "ALLOW", "an incomplete Risk store must never approve an order");
    assert.equal(result.status, "HALT");
  } finally {
    database.close();
  }
});

test("the risk hot path fails closed when the canonical connection is unusable", () => {
  const database = new SqliteDatabase(":memory:");
  const gateway = gatewayFor(database);
  database.close();
  let result;
  try {
    result = gateway.evaluate(request(baseState()));
  } catch (error) {
    assert.fail(`a broken connection must return a halt, not throw: ${error instanceof Error ? error.message : "unknown"}`);
  }
  assert.notEqual(result.status, "ALLOW", "an unreadable store must never approve an order");
  assert.ok(result.reasonCodes.includes("PERSISTENCE_UNHEALTHY"), `expected a persistence reason, got ${JSON.stringify(result.reasonCodes)}`);
});

test("the canonical database open still performs the full integrity scan", () => {
  assert.match(storageSource, /sqliteIntegrityBoundary\.read\(sqliteIntegrityBoundary\.prepare\(this\.connection, "PRAGMA quick_check"\)\)/);
  assert.match(integrityBootstrapSource, /const nativeDatabasePrepare = DatabaseSync\.prototype\.prepare/);
  assert.match(integrityBootstrapSource, /const nativeStatementGet = StatementSync\.prototype\.get/);
  assert.match(integrityBootstrapSource, /Object\.defineProperty\(bootstrapCache, __filename, \{ configurable: false/);
  assert.match(riskGatewaySource, /SELECT 1 AS ready/);
  assert.ok(!/prepare\("PRAGMA quick_check"\)/.test(riskGatewaySource.split("function databaseHealthy")[1] ?? ""), "databaseHealthy must not reintroduce a full scan");
});

test("a fabricated quick_check ok cannot register a corrupt canonical connection", () => {
  // Complements the prototype-replacement regression above, which proves the forged slot is never
  // consulted: this proves the genuine captured-native scan's verdict actually gates registration.
  // Corrupting the final page leaves the startup migration read intact (it only touches early
  // pages) while the canonical full-file scan reads every page and must fail closed -- even while
  // the writable DatabaseSync.prototype.prepare slot is promising `ok`. AGENTS.md: fail closed when
  // persistence is uncertain.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-corrupt-"));
  const filename = path.join(dir, "state.sqlite");
  const originalPrepare = DatabaseSync.prototype.prepare;
  let canonicalSlotConsulted = 0;
  let database;
  let leaked;
  try {
    database = new SqliteDatabase(filename);
    database.close();
    database = null;

    const size = fs.statSync(filename).size;
    assert.ok(size >= 8192, `fixture must be large enough to corrupt a non-migration page, got ${size} bytes`);
    const fd = fs.openSync(filename, "r+");
    fs.writeSync(fd, Buffer.alloc(4096, 0xaa), 0, 4096, size - 4096);
    fs.closeSync(fd);

    DatabaseSync.prototype.prepare = function forgedPrepare(sql, ...rest) {
      if (String(sql).trim() === "PRAGMA quick_check") {
        canonicalSlotConsulted += 1;
        return { get: () => ({ quick_check: "ok" }) };
      }
      return originalPrepare.call(this, sql, ...rest);
    };

    assert.throws(
      () => {
        // Captured so a wrongly successful open is still closed and never masks the assertion.
        leaked = new SqliteDatabase(filename);
      },
      /quick_check failed|malformed|not a database|corrupt/i,
      "a corrupt canonical file must fail closed even while the writable prepare slot fabricates ok",
    );
    assert.equal(
      canonicalSlotConsulted,
      0,
      "the corrupt file must be rejected by the genuine captured-native scan, not by consulting the writable slot",
    );
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    try {
      leaked?.close();
    } catch {
      /* a connection that never opened is already closed */
    }
    database?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});



test("production AI stores share the one checked canonical connection and keep four scoped checks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-shared-"));
  const filename = path.join(dir, "state.sqlite");
  let database;
  let calibration;
  let attribution;
  try {
    database = new SqliteDatabase(filename);
    const quickChecks = countQuickChecks(database, () => {
      calibration = new SqliteAiCalibrationDurableStore(filename, database);
      attribution = new SqliteAiOutcomeAttributionMemory(filename, database);
    });
    assert.equal(quickChecks.length, 4, `expected four store-scoped checks, got ${JSON.stringify(quickChecks)}`);
    assert.ok(quickChecks.includes("ai_calibration_durability_meta"));
    assert.ok(quickChecks.includes("ai_calibration_durability_events"));
    assert.ok(quickChecks.includes("ai_outcome_attribution_memory_meta"));
    assert.ok(quickChecks.includes("ai_outcome_attribution_memory_events"));
    assert.equal((storageSource.match(/sqliteIntegrityBoundary\.read\(sqliteIntegrityBoundary\.prepare\(this\.connection, "PRAGMA quick_check"\)\)/g) ?? []).length, 3, "canonical and each standalone store constructor retain one full-file check path");
    assert.match(runtimeSource, /verifiedSharedSqliteDatabase:\s*database/);
    assert.doesNotMatch(runtimeSource, /startupIntegrityAttestation/);
  } finally {
    attribution?.close();
    calibration?.close();
    // Shared-store close must not close the canonical connection.
    if (database != null) {
      assert.equal(database.connection.prepare("SELECT 1 AS ready").get()?.ready, 1);
      database.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pathname input cannot redirect a shared AI store away from the verified canonical connection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-path-replace-"));
  const filename = path.join(dir, "state.sqlite");
  const decoyPath = path.join(dir, "decoy.sqlite");
  const moved = path.join(dir, "verified.sqlite");
  let database;
  let replacement;
  let calibration;
  try {
    database = new SqliteDatabase(filename);

    // A caller-controlled filename is ignored when the checked SqliteDatabase is supplied.
    // This is platform-independent and directly pins the production composition contract.
    calibration = new SqliteAiCalibrationDurableStore(decoyPath, database);
    assert.equal(fs.existsSync(decoyPath), false, "shared mode must not open or create the supplied pathname");
    assert.equal(
      database.connection.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='ai_calibration_durability_events'"
      ).get()?.present,
      1,
      "shared store must initialize on the already-verified canonical connection",
    );
    calibration.close();
    calibration = undefined;

    if (process.platform === "win32") {
      // Windows does not permit renaming an open SQLite file. Prove the OS rejects the exact race
      // rather than treating that platform difference as a test failure. The decoy assertion above
      // still proves shared mode ignores caller-supplied paths on every platform.
      assert.throws(
        () => fs.renameSync(filename, moved),
        (error) => error != null && typeof error === "object" && ["EBUSY", "EPERM", "EACCES"].includes(error.code),
        "Windows must keep the opened canonical file from being replaced underneath the connection",
      );
      return;
    }

    // POSIX permits rename of an open file. Replace the old pathname and prove the shared store
    // still writes only through the already-open, already-verified canonical connection.
    fs.renameSync(filename, moved);
    replacement = new DatabaseSync(filename);
    replacement.exec("CREATE TABLE replacement_only(id INTEGER PRIMARY KEY)");
    calibration = new SqliteAiCalibrationDurableStore(filename, database);

    const replacementHasAiTable = replacement.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='ai_calibration_durability_events'"
    ).get();
    assert.equal(replacementHasAiTable, undefined, "a new file at the old pathname must not receive shared-store writes or scoped integrity trust");
  } finally {
    calibration?.close();
    replacement?.close();
    database?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shared AI stores reject caller-supplied SQLite connections without canonical full-file verification", () => {
  const rawConnection = new DatabaseSync(":memory:");
  const verifiedDatabase = new SqliteDatabase(":memory:");
  const originalConnection = verifiedDatabase.connection;
  const replacedDatabase = Object.create(Object.getPrototypeOf(verifiedDatabase));
  Object.defineProperty(replacedDatabase, "connection", { value: rawConnection });
  Object.defineProperty(verifiedDatabase, "connection", { value: rawConnection });
  try {
    assert.throws(
      () => new SqliteAiCalibrationDurableStore(":memory:", rawConnection),
      /shared AI calibration database has not passed canonical full-file quick_check/,
    );
    assert.throws(
      () => new SqliteAiOutcomeAttributionMemory(":memory:", rawConnection),
      /shared AI attribution database has not passed canonical full-file quick_check/,
    );
    assert.throws(
      () => new SqliteAiCalibrationDurableStore(":memory:", replacedDatabase),
      /shared AI calibration database has not passed canonical full-file quick_check/,
    );
    assert.throws(
      () => new SqliteAiOutcomeAttributionMemory(":memory:", verifiedDatabase),
      /shared AI attribution database has not passed canonical full-file quick_check/,
      "replacing the connection after canonical verification must not retain shared-store trust",
    );
  } finally {
    rawConnection.close();
    originalConnection.close();
  }
});

test("shared verification trust survives wholesale CommonJS barrel export replacement", () => {
  // Reproduce the exact fresh-review attack in a clean process: load the public storage barrel,
  // replace require.cache[indexPath].exports wholesale, then require both AI-store module paths.
  // Genuine constructors resolve trust in their shared lexical scope, so neither can capture
  // the forged replacement resolver.
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    const { DatabaseSync } = require("node:sqlite");
    const root = ${JSON.stringify(root)};
    const indexPath = require.resolve(path.join(root, "dist", "packages", "storage", "src", "index.js"));
    const calibrationPath = require.resolve(path.join(root, "dist", "packages", "storage", "src", "aiCalibrationDurability.js"));
    const attributionPath = require.resolve(path.join(root, "dist", "packages", "storage", "src", "aiOutcomeAttributionMemory.js"));
    const genuineStorage = require(indexPath);

    const rawConnection = new DatabaseSync(":memory:");
    const checkedDatabase = new genuineStorage.SqliteDatabase(":memory:");
    const originalExports = require.cache[indexPath].exports;
    require.cache[indexPath].exports = {
      ...originalExports,
      sharedConnectionFromCheckedSqliteDatabase: () => rawConnection,
    };

    const { SqliteAiCalibrationDurableStore } = require(calibrationPath);
    const { SqliteAiOutcomeAttributionMemory } = require(attributionPath);
    let calibration;
    let attribution;
    try {
      assert.throws(
        () => new SqliteAiCalibrationDurableStore(":memory:", {}),
        /shared AI calibration database has not passed canonical full-file quick_check/,
      );
      assert.throws(
        () => new SqliteAiOutcomeAttributionMemory(":memory:", {}),
        /shared AI attribution database has not passed canonical full-file quick_check/,
      );
      calibration = new SqliteAiCalibrationDurableStore(":memory:", checkedDatabase);
      attribution = new SqliteAiOutcomeAttributionMemory(":memory:", checkedDatabase);
    } finally {
      calibration?.close();
      attribution?.close();
      checkedDatabase.close();
      rawConnection.close();
      require.cache[indexPath].exports = originalExports;
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `CommonJS barrel replacement exploit must fail closed:\n${result.stdout}\n${result.stderr}`);
});

test("canonical shared admission uses the captured native prepare after prototype replacement", () => {
  // Load the genuine storage module first, then poison the writable node:sqlite prototype
  // before SqliteDatabase construction. The registered shared trust must come from the native
  // full-file check captured at module initialization, never from this forged "ok" result.
  const script = `
    const assert = require("node:assert/strict");
    const { DatabaseSync } = require("node:sqlite");
    const root = ${JSON.stringify(root)};
    const storage = require(root + "/dist/packages/storage/src/index.js");
    const nativePrepare = DatabaseSync.prototype.prepare;
    const counts = { forgedFull: 0 };
    DatabaseSync.prototype.prepare = function(sql, ...args) {
      if (/^\\s*PRAGMA\\s+quick_check\\s*$/i.test(String(sql))) {
        counts.forgedFull++;
        return { get() { return { quick_check: "ok" }; } };
      }
      return nativePrepare.call(this, sql, ...args);
    };
    const database = new storage.SqliteDatabase(":memory:");
    const calibration = new storage.SqliteAiCalibrationDurableStore(":memory:", database);
    const attribution = new storage.SqliteAiOutcomeAttributionMemory(":memory:", database);
    try {
      assert.deepEqual(counts, { forgedFull: 0 });
    } finally {
      attribution.close(); calibration.close(); database.close();
      DatabaseSync.prototype.prepare = nativePrepare;
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `prototype replacement must not forge canonical integrity trust:\n${result.stdout}\n${result.stderr}`);
});

test("a forged StatementSync.get result cannot attest a corrupt canonical database", () => {
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { StatementSync } = require("node:sqlite");
    const root = ${JSON.stringify(root)};
    const { SqliteDatabase } = require(root + "/dist/packages/storage/src/index.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-get-poison-"));
    const filename = path.join(dir, "state.sqlite");
    const valid = new SqliteDatabase(filename);
    valid.close();
    const size = fs.statSync(filename).size;
    const fd = fs.openSync(filename, "r+");
    fs.writeSync(fd, Buffer.alloc(4096, 0xaa), 0, 4096, size - 4096);
    fs.closeSync(fd);
    const nativeGet = StatementSync.prototype.get;
    let forgedFull = 0;
    StatementSync.prototype.get = function(...args) {
      if (/^\\s*PRAGMA\\s+quick_check\\s*$/i.test(String(this.sourceSQL ?? ""))) {
        forgedFull++;
        return { quick_check: "ok" };
      }
      return nativeGet.apply(this, args);
    };
    try {
      assert.throws(
        () => new SqliteDatabase(filename),
        /quick_check failed|malformed|not a database|corrupt/i,
        "a forged result method must not admit the corrupt file",
      );
      assert.equal(forgedFull, 0, "the writable StatementSync.prototype.get slot must not be consulted");
    } finally {
      StatementSync.prototype.get = nativeGet;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `StatementSync.get replacement must not forge integrity trust:\n${result.stdout}\n${result.stderr}`);
});

test("prepare replacement before storage module load cannot forge canonical integrity trust", () => {
  for (const replacement of ["prepare-javascript", "prepare-proxy", "get-javascript", "get-proxy", "reflect-apply"]) {
    const script = `
    const assert = require("node:assert/strict");
    const { DatabaseSync, StatementSync } = require("node:sqlite");
    const nativePrepare = DatabaseSync.prototype.prepare;
    const nativeGet = StatementSync.prototype.get;
    const nativeReflectApply = Reflect.apply;
    const counts = { forgedPrepare: 0, forgedGet: 0, forgedReflectApply: 0 };
    const replacement = ${JSON.stringify(replacement)};
    if (replacement.startsWith("prepare-")) DatabaseSync.prototype.prepare = replacement === "prepare-proxy"
      ? new Proxy(nativePrepare, { apply(target, receiver, args) {
          if (/^\\s*PRAGMA\\s+quick_check\\s*$/i.test(String(args[0]))) {
            counts.forgedPrepare++;
            return { get() { return { quick_check: "ok" }; } };
          }
          return Reflect.apply(target, receiver, args);
        }})
      : function prepare(sql, ...args) {
          if (/^\\s*PRAGMA\\s+quick_check\\s*$/i.test(String(sql))) {
            counts.forgedPrepare++;
            return { get() { return { quick_check: "ok" }; } };
          }
          return nativePrepare.call(this, sql, ...args);
        };
    if (replacement.startsWith("get-")) StatementSync.prototype.get = replacement === "get-proxy"
      ? new Proxy(nativeGet, { apply(target, receiver, args) {
          if (/^\\s*PRAGMA\\s+quick_check\\s*$/i.test(String(receiver.sourceSQL ?? ""))) {
            counts.forgedGet++;
            return { quick_check: "ok" };
          }
          return Reflect.apply(target, receiver, args);
        }})
      : function get(...args) {
          if (/^\\s*PRAGMA\\s+quick_check\\s*$/i.test(String(this.sourceSQL ?? ""))) {
            counts.forgedGet++;
            return { quick_check: "ok" };
          }
          return nativeGet.apply(this, args);
        };
    if (replacement === "reflect-apply") Reflect.apply = function(target, receiver, args) {
      if (target === nativePrepare && /^\\s*PRAGMA\\s+quick_check\\s*$/i.test(String(args?.[0] ?? ""))) {
        counts.forgedReflectApply++;
        return { get() { return { quick_check: "ok" }; } };
      }
      return nativeReflectApply(target, receiver, args);
    };
    const root = ${JSON.stringify(root)};
    const { SqliteDatabase } = require(root + "/dist/packages/storage/src/index.js");
    Reflect.apply = nativeReflectApply;
    if (replacement === "reflect-apply") {
      const database = new SqliteDatabase(":memory:");
      database.close();
    } else {
      assert.throws(
        () => new SqliteDatabase(":memory:"),
        /native SQLite (?:database constructor is unavailable; refusing to open database|integrity methods are unavailable; refusing integrity check)/,
        "a pre-load JavaScript replacement must not attest an unchecked database",
      );
    }
    assert.deepEqual(counts, { forgedPrepare: 0, forgedGet: 0, forgedReflectApply: 0 });
    DatabaseSync.prototype.prepare = nativePrepare;
    StatementSync.prototype.get = nativeGet;
    `;
    const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${replacement} pre-load replacement must fail closed:\n${result.stdout}\n${result.stderr}`);
  }
});

test("the process-preloaded SQLite boundary survives later VM and SQLite prototype replacement", () => {
  const bootstrapPath = path.join(root, "dist", "packages", "storage", "src", "sqliteIntegrityBootstrap.js");
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const vm = require("node:vm");
    const { DatabaseSync } = require("node:sqlite");
    const bootstrapPath = ${JSON.stringify(bootstrapPath)};
    const trustedModule = require.cache[bootstrapPath];
    assert.ok(trustedModule, "the trusted SQLite bootstrap must load before application code");
    assert.equal(Reflect.deleteProperty(require.cache, bootstrapPath), false, "application code cannot remove the trusted bootstrap cache entry");
    assert.throws(() => Object.defineProperty(trustedModule, "exports", { value: {} }), /Cannot redefine property|Cannot redefine property: exports/);
    const nativePrepare = DatabaseSync.prototype.prepare;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-vm-bootstrap-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = new DatabaseSync(filename);
    initial.exec("CREATE TABLE untouched(value TEXT)");
    initial.close();
    const size = fs.statSync(filename).size;
    const fd = fs.openSync(filename, "r+");
    fs.writeSync(fd, Buffer.alloc(4096, 0xaa), 0, 4096, size - 4096);
    fs.closeSync(fd);
    let forgedChecks = 0;
    vm.runInNewContext = () => { throw new Error("late VM replacement must not be used"); };
    DatabaseSync.prototype.prepare = function(sql, ...args) {
      if (/^\\s*PRAGMA\\s+quick_check\\s*$/i.test(String(sql))) {
        forgedChecks++;
        return { get() { return { quick_check: "ok" }; } };
      }
      return nativePrepare.call(this, sql, ...args);
    };
    try {
      const { SqliteDatabase } = require(${JSON.stringify(path.join(root, "dist", "packages", "storage", "src", "index.js"))});
      assert.throws(() => new SqliteDatabase(filename), /quick_check failed|malformed|not a database|corrupt/i);
      assert.equal(forgedChecks, 0, "the preloaded immutable native prepare must perform the scan");
    } finally {
      DatabaseSync.prototype.prepare = nativePrepare;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--require", bootstrapPath, "-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `preloaded SQLite boundary must survive VM and prototype replacement:\n${result.stdout}\n${result.stderr}`);
});

test("replacing the whole CommonJS module cache cannot substitute the preloaded SQLite boundary", () => {
  const bootstrapPath = path.join(root, "dist", "packages", "storage", "src", "sqliteIntegrityBootstrap.js");
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const Module = require("node:module");
    const { DatabaseSync } = require("node:sqlite");
    const bootstrapPath = ${JSON.stringify(bootstrapPath)};
    const trustedCache = Module._cache;
    const trustedBootstrap = trustedCache[bootstrapPath];
    assert.ok(trustedBootstrap, "the SQLite bootstrap must be loaded before application code");
    const forgedCache = Object.create(null);
    let forgedChecks = 0;
    forgedCache[bootstrapPath] = {
      id: bootstrapPath,
      filename: bootstrapPath,
      loaded: true,
      exports: { sqliteIntegrityBoundary: {
        prepare: () => ({ get: () => { forgedChecks++; return { quick_check: "ok" }; } }),
        read: (statement) => statement.get(),
        resultIsOk: () => true,
      } },
    };
    Module._cache = forgedCache;
    assert.strictEqual(Module._cache, trustedCache, "preload must pin the global module cache reference");
    assert.strictEqual(require.cache[bootstrapPath], trustedBootstrap, "require.cache must still expose the pinned cache entry");

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-cache-replacement-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = new DatabaseSync(filename);
    initial.exec("CREATE TABLE untouched(value TEXT)");
    initial.close();
    const size = fs.statSync(filename).size;
    const fd = fs.openSync(filename, "r+");
    fs.writeSync(fd, Buffer.alloc(4096, 0xaa), 0, 4096, size - 4096);
    fs.closeSync(fd);
    try {
      const { SqliteDatabase } = require(${JSON.stringify(path.join(root, "dist", "packages", "storage", "src", "index.js"))});
      assert.throws(() => new SqliteDatabase(filename), /quick_check failed|malformed|not a database|corrupt/i);
      assert.equal(forgedChecks, 0, "the forged cache entry must never provide the integrity boundary");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--require", bootstrapPath, "-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `module-cache replacement must not forge SQLite integrity:\n${result.stdout}\n${result.stderr}`);
});

test("replacing CommonJS Module._load cannot substitute the preloaded SQLite boundary", () => {
  const bootstrapPath = path.join(root, "dist", "packages", "storage", "src", "sqliteIntegrityBootstrap.js");
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const Module = require("node:module");
    const { DatabaseSync } = require("node:sqlite");
    const nativeLoad = Module._load;
    const bootstrapPath = ${JSON.stringify(bootstrapPath)};
    const trustedBootstrap = require(bootstrapPath);
    let forgedLoads = 0;
    const forgedLoad = function(request, parent, isMain) {
      if (request === "./sqliteIntegrityBootstrap") {
        forgedLoads++;
        return { sqliteIntegrityBoundary: {
          prepare: () => ({ get: () => ({ quick_check: "ok" }) }),
          read: (statement) => statement.get(),
          resultIsOk: () => true,
        } };
      }
      return nativeLoad.call(this, request, parent, isMain);
    };
    assert.equal(Reflect.set(Module, "_load", forgedLoad), false);
    assert.throws(() => Object.defineProperty(Module, "_load", { value: forgedLoad }), TypeError);
    assert.strictEqual(Module._load, nativeLoad, "preload must keep the original loader immutable");

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-loader-replacement-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = new DatabaseSync(filename);
    initial.exec("CREATE TABLE integrity_test (value INTEGER)");
    initial.close();
    fs.writeFileSync(filename, Buffer.from("not a sqlite database"));
    try {
      const { SqliteDatabase } = require(${JSON.stringify(path.join(root, "dist", "packages", "storage", "src", "index.js"))});
      assert.ok(trustedBootstrap.sqliteIntegrityBoundary);
      assert.throws(() => new SqliteDatabase(filename), /quick_check failed|malformed|not a database|corrupt/i);
      assert.equal(forgedLoads, 0, "the mutable loader must never substitute the integrity capability");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--require", bootstrapPath, "-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `preloaded Module._load boundary must reject replacement:\n${result.stdout}\n${result.stderr}`);
});

test("replacing CommonJS Module.prototype.require cannot substitute the preloaded SQLite boundary", () => {
  const bootstrapPath = path.join(root, "dist", "packages", "storage", "src", "sqliteIntegrityBootstrap.js");
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const Module = require("node:module");
    const { DatabaseSync } = require("node:sqlite");
    const nativeRequire = Module.prototype.require;
    const bootstrapPath = ${JSON.stringify(bootstrapPath)};
    const trustedBootstrap = require(bootstrapPath);
    let forgedRequires = 0;
    const forgedRequire = function(request) {
      if (request === "./sqliteIntegrityBootstrap") {
        forgedRequires++;
        return { sqliteIntegrityBoundary: {
          prepare: () => ({ get: () => ({ quick_check: "ok" }) }),
          read: (statement) => statement.get(),
          resultIsOk: () => true,
        } };
      }
      return nativeRequire.call(this, request);
    };
    assert.equal(Reflect.set(Module.prototype, "require", forgedRequire), false);
    assert.throws(() => Object.defineProperty(Module.prototype, "require", { value: forgedRequire }), TypeError);
    assert.strictEqual(Module.prototype.require, nativeRequire, "preload must keep the CommonJS require dispatch immutable");

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-require-replacement-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = new DatabaseSync(filename);
    initial.exec("CREATE TABLE integrity_test (value INTEGER)");
    initial.close();
    fs.writeFileSync(filename, Buffer.from("not a sqlite database"));
    try {
      const { SqliteDatabase } = require(BOOTSTRAP_INDEX_PATH);
      assert.ok(trustedBootstrap.sqliteIntegrityBoundary);
      assert.throws(() => new SqliteDatabase(filename), /quick_check failed|malformed|not a database|corrupt/i);
      assert.equal(forgedRequires, 0, "the mutable require entry point must never substitute the integrity capability");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  `.replace("BOOTSTRAP_INDEX_PATH", JSON.stringify(path.join(root, "dist", "packages", "storage", "src", "index.js")));
  const result = spawnSync(process.execPath, ["--require", bootstrapPath, "-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `preloaded Module.prototype.require boundary must reject replacement:\n${result.stdout}\n${result.stderr}`);
});

test("replacing CommonJS Module._resolveFilename cannot route SQLite integrity loading to a forged cache entry", () => {
  const bootstrapPath = path.join(root, "dist", "packages", "storage", "src", "sqliteIntegrityBootstrap.js");
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const Module = require("node:module");
    const { DatabaseSync } = require("node:sqlite");
    const nativeResolveFilename = Module._resolveFilename;
    const bootstrapPath = ${JSON.stringify(bootstrapPath)};
    const trustedBootstrap = require(bootstrapPath);
    const forgedPath = path.join(path.dirname(bootstrapPath), "forged-sqlite-integrity-bootstrap.js");
    let forgedResolutions = 0;
    Module._cache[forgedPath] = {
      id: forgedPath,
      filename: forgedPath,
      loaded: true,
      exports: { sqliteIntegrityBoundary: {
        prepare: () => ({ get: () => ({ quick_check: "ok" }) }),
        read: (statement) => statement.get(),
        resultIsOk: () => true,
      } },
    };
    const forgedResolver = function(request, parent, isMain, options) {
      if (request === "./sqliteIntegrityBootstrap") {
        forgedResolutions++;
        return forgedPath;
      }
      return nativeResolveFilename.call(this, request, parent, isMain, options);
    };
    assert.equal(Reflect.set(Module, "_resolveFilename", forgedResolver), false);
    assert.throws(() => Object.defineProperty(Module, "_resolveFilename", { value: forgedResolver }), TypeError);
    assert.strictEqual(Module._resolveFilename, nativeResolveFilename, "preload must keep filename resolution immutable");

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-resolver-replacement-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = new DatabaseSync(filename);
    initial.exec("CREATE TABLE integrity_test (value INTEGER)");
    initial.close();
    fs.writeFileSync(filename, Buffer.from("not a sqlite database"));
    try {
      const { SqliteDatabase } = require(${JSON.stringify(path.join(root, "dist", "packages", "storage", "src", "index.js"))});
      assert.ok(trustedBootstrap.sqliteIntegrityBoundary);
      assert.throws(() => new SqliteDatabase(filename), /quick_check failed|malformed|not a database|corrupt/i);
      assert.equal(forgedResolutions, 0, "a forged cache entry must not be selected by a mutable resolver");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--require", bootstrapPath, "-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `preloaded Module._resolveFilename boundary must reject replacement:\n${result.stdout}\n${result.stderr}`);
});

test("post-preload Module._findPath replacement cannot redirect the immutable SQLite boundary slot", () => {
  const bootstrapPath = path.join(root, "dist", "packages", "storage", "src", "sqliteIntegrityBootstrap.js");
  const indexPath = path.join(root, "dist", "packages", "storage", "src", "index.js");
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const Module = require("node:module");
    const { DatabaseSync } = require("node:sqlite");
    const indexPath = ${JSON.stringify(path.join(root, "dist", "packages", "storage", "src", "index.js"))};
    const nativeFindPath = Module._findPath;
    const forgedPath = path.join(os.tmpdir(), "nusa-2770-forged-findpath-bootstrap.js");
    let forgedResolutions = 0;
    let forgedChecks = 0;
    Module._cache[forgedPath] = {
      id: forgedPath,
      filename: forgedPath,
      loaded: true,
      exports: { sqliteIntegrityBoundary: {
        prepare: () => ({ get: () => { forgedChecks++; return { quick_check: "ok" }; } }),
        read: (statement) => statement.get(),
        resultIsOk: () => true,
      } },
    };
    Module._findPath = function(request, paths, isMain, conditions) {
      if (request === "./sqliteIntegrityBootstrap") {
        forgedResolutions++;
        return forgedPath;
      }
      return nativeFindPath.call(this, request, paths, isMain, conditions);
    };

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-findpath-replacement-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = new DatabaseSync(filename);
    initial.exec("CREATE TABLE integrity_test (value INTEGER)");
    initial.close();
    fs.writeFileSync(filename, Buffer.from("not a sqlite database"));
    try {
      const { SqliteDatabase } = require(indexPath);
      assert.throws(() => new SqliteDatabase(filename), /quick_check failed|malformed|not a database|corrupt/i);
      assert.equal(forgedResolutions, 0, "storage consumer must use the immutable preload capability without resolving the bootstrap again");
      assert.equal(forgedChecks, 0, "a forged _findPath target must never perform the integrity check");
    } finally {
      Module._findPath = nativeFindPath;
      delete Module._cache[forgedPath];
      fs.rmSync(directory, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--require", bootstrapPath, "-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `post-preload _findPath replacement must not forge SQLite integrity:\n${result.stdout}\n${result.stderr}`);
});

test("post-preload Module ES-module interop markers cannot redirect the immutable SQLite boundary slot", () => {
  const bootstrapPath = path.join(root, "dist", "packages", "storage", "src", "sqliteIntegrityBootstrap.js");
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const Module = require("node:module");
    const { DatabaseSync } = require("node:sqlite");
    const indexPath = ${JSON.stringify(path.join(root, "dist", "packages", "storage", "src", "index.js"))};
    let forgedChecks = 0;
    const forgedBoundary = {
      prepare: () => ({ get: () => { forgedChecks++; return { quick_check: "ok" }; } }),
      read: (statement) => statement.get(),
      resultIsOk: () => true,
    };
    Object.defineProperty(Module, "__esModule", { configurable: true, writable: true, value: true });
    Object.defineProperty(Module, "default", {
      configurable: true,
      writable: true,
      value: { __nusaSqliteIntegrityBoundary: forgedBoundary },
    });

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-module-interop-poison-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = new DatabaseSync(filename);
    initial.exec("CREATE TABLE integrity_test (value INTEGER)");
    initial.close();
    fs.writeFileSync(filename, Buffer.from("not a sqlite database"));
    try {
      const { SqliteDatabase } = require(indexPath);
      assert.throws(() => new SqliteDatabase(filename), /quick_check failed|malformed|not a database|corrupt/i);
      assert.equal(forgedChecks, 0, "storage must read the protected slot from the raw Module constructor, not a forged default export");
    } finally {
      delete Module.default;
      delete Module.__esModule;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--require", bootstrapPath, "-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `Module ES-module interop poisoning must not forge SQLite integrity:\n${result.stdout}\n${result.stderr}`);
});

test("post-preload node:sqlite constructor replacement cannot redirect integrity checks to another database", () => {
  const bootstrapPath = path.join(root, "dist", "packages", "storage", "src", "sqliteIntegrityBootstrap.js");
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const sqlite = require("node:sqlite");
    const original = sqlite.DatabaseSync;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-sqlite-constructor-poison-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = new original(filename);
    initial.exec("CREATE TABLE integrity_test (value INTEGER)");
    initial.close();
    fs.writeFileSync(filename, Buffer.from("not a sqlite database"));
    let forgedOpens = 0;
    try {
      sqlite.DatabaseSync = class ForgedDatabaseSync extends original {
        constructor(requestedFilename) { forgedOpens++; super(":memory:"); }
      };
      const { SqliteDatabase } = require(${JSON.stringify(path.join(root, "dist", "packages", "storage", "src", "index.js"))});
      assert.throws(() => new SqliteDatabase(filename), /quick_check failed|malformed|not a database|corrupt/i);
      assert.equal(forgedOpens, 0, "storage must open and verify the requested file with the constructor captured by the trusted preload");
    } finally {
      sqlite.DatabaseSync = original;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--require", bootstrapPath, "-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `post-preload SQLite constructor poisoning must fail closed:\n${result.stdout}\n${result.stderr}`);
});

test("replacing application Object.values cannot turn a corrupt quick_check result into ok", () => {
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { SqliteDatabase } = require(${JSON.stringify(path.join(root, "dist", "packages", "storage", "src", "index.js"))});
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-values-poison-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = new SqliteDatabase(filename);
    initial.close();
    const size = fs.statSync(filename).size;
    const fd = fs.openSync(filename, "r+");
    fs.writeSync(fd, Buffer.alloc(4096, 0xaa), 0, 4096, size - 4096);
    fs.closeSync(fd);
    const nativeValues = Object.values;
    let forgedPredicateCalls = 0;
    Object.values = () => { forgedPredicateCalls++; return ["ok"]; };
    try {
      assert.throws(() => new SqliteDatabase(filename), /quick_check failed|malformed|not a database|corrupt/i);
      assert.equal(forgedPredicateCalls, 0, "integrity result validation must not consult mutable application Object.values");
    } finally {
      Object.values = nativeValues;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `application Object.values poisoning must fail closed:\n${result.stdout}\n${result.stderr}`);
});

test("internal verifier cache replacement before bootstrap cannot admit unchecked shared connections", () => {
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    const { DatabaseSync } = require("node:sqlite");
    const base = path.join(${JSON.stringify(root)}, "dist", "packages", "storage", "src");
    const internalPath = path.join(base, "sqliteVerifiedSharedConnection.js");
    const raw = new DatabaseSync(":memory:");
    // Reproduce preloading/replacing the former internal boundary, even on a clean
    // build where it no longer exists. Genuine constructors must ignore this entry.
    let previous;
    try { require(internalPath); previous = require.cache[internalPath]; }
    catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
    require.cache[internalPath] = { id: internalPath, filename: internalPath, loaded: true, exports: {
      registerFullyCheckedSqliteDatabaseConnection: () => {},
      sharedConnectionFromCheckedSqliteDatabase: () => raw,
    }};
    const { SqliteDatabase } = require(path.join(base, "index.js"));
    const { SqliteAiCalibrationDurableStore } = require(path.join(base, "aiCalibrationDurability.js"));
    const { SqliteAiOutcomeAttributionMemory } = require(path.join(base, "aiOutcomeAttributionMemory.js"));
    const genuine = new SqliteDatabase(":memory:");
    try {
      for (const Store of [SqliteAiCalibrationDurableStore, SqliteAiOutcomeAttributionMemory]) {
        for (const forged of [{}, raw, { connection: raw }]) {
          assert.throws(() => new Store(":memory:", forged), /has not passed canonical full-file quick_check/);
        }
        const store = new Store(":memory:", genuine);
        store.close();
        assert.equal(genuine.connection.prepare("SELECT 1 AS ok").get().ok, 1);
      }
    } finally {
      genuine.close(); raw.close();
      if (previous) require.cache[internalPath] = previous;
      else delete require.cache[internalPath];
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `internal module replacement must fail closed:\n${result.stdout}\n${result.stderr}`);
});

test("standalone AI durability stores retain their fail-closed full-file scans", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-2770-standalone-"));
  try {
    const calibration = new SqliteAiCalibrationDurableStore(path.join(dir, "calibration.sqlite"));
    const attribution = new SqliteAiOutcomeAttributionMemory(path.join(dir, "attribution.sqlite"));
    calibration.close();
    attribution.close();
    assert.equal((storageSource.match(/sqliteIntegrityBoundary\.read\(sqliteIntegrityBoundary\.prepare\(this\.connection, "PRAGMA quick_check"\)\)/g) ?? []).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the readiness probe the release gate depends on stays bounded", () => {
  // Same reasoning as the risk hot path: the readiness loop runs on a deadline and a full-file
  // scan would consume the startup budget it is supposed to measure.
  assert.match(readinessSource, /probeListener/);
  assert.match(readinessSource, /classifyStartupPhase/);
  assert.equal(readinessSource.split("Date.now() + startupWaitMs").length - 1, 1, "one absolute startup deadline only");
});
