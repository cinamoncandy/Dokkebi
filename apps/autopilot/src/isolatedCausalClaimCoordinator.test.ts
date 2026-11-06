import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  claimIsolatedCausalAttempt,
  ExecutionCoordinator,
  type ExecutionCoordinatorNamespace,
} from "./executionCoordinator";
import type { VerifiedIsolatedCausalVerification } from "./sigstoreCausalAttestation";

const sha = "a".repeat(40);
const statementDigest = "b".repeat(64);
const source = Object.freeze({
  repository: "cinamoncandy/NUSA",
  workflowPath: ".github/workflows/causal-verification.yml",
  workflowRef: "cinamoncandy/NUSA/.github/workflows/causal-verification.yml@refs/heads/main",
  workflowSha: sha,
  ref: "refs/heads/main" as const,
  event: "workflow_dispatch" as const,
  job: "verify-causal-positive" as const,
  sha,
  runId: "7654321",
  runAttempt: "2",
});

function verified(runId: string = source.runId): VerifiedIsolatedCausalVerification {
  return Object.freeze({
    domain: "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1",
    source: Object.freeze({ ...source, runId }),
    caseId: "isolated-policy-regression",
    fixtureDigest: "c".repeat(64),
    statementDigest,
    signerIdentity: Object.freeze({
      subjectAlternativeName: "https://github.com/cinamoncandy/NUSA/.github/workflows/causal-verification.yml@refs/heads/main",
      issuer: "https://token.actions.githubusercontent.com",
    }),
  });
}

class SqliteDurableStorage {
  private serial: Promise<void> = Promise.resolve();

  constructor(readonly db = new DatabaseSync(":memory:")) {
    db.exec("CREATE TABLE IF NOT EXISTS durable_objects (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  async get<T>(key: string): Promise<T | undefined> {
    const row = this.db.prepare("SELECT value FROM durable_objects WHERE key = ?").get(key) as { value?: string } | undefined;
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.db.prepare("INSERT INTO durable_objects (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  async transaction<T>(operation: (storage: SqliteDurableStorage) => Promise<T>): Promise<T> {
    let unlock!: () => void;
    const previous = this.serial;
    this.serial = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await operation(this);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      unlock();
    }
  }
}

function persistentSqliteHarness() {
  const directory = mkdtempSync(join(tmpdir(), "nusa-isolated-claim-"));
  const filename = join(directory, "durable-objects.sqlite");
  let currentStorage = new SqliteDurableStorage(new DatabaseSync(filename));
  return {
    get storage() { return currentStorage; },
    restart() {
      currentStorage.db.close();
      currentStorage = new SqliteDurableStorage(new DatabaseSync(filename));
      return currentStorage;
    },
    cleanup() {
      try { currentStorage.db.close(); } catch { /* already closed */ }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function sqliteNamespace(storage: SqliteDurableStorage, afterCommit?: () => never): ExecutionCoordinatorNamespace {
  const coordinators = new Map<string, ExecutionCoordinator>();
  return {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (input, init) => {
        const name = String(id);
        let coordinator = coordinators.get(name);
        if (!coordinator) {
          coordinator = new ExecutionCoordinator({ storage });
          coordinators.set(name, coordinator);
        }
        const response = await coordinator.fetch(new Request(input, init));
        afterCommit?.();
        return response;
      },
    }),
  };
}

test("SQLite-backed coordinator admits one of many concurrent source-identity claims", async () => {
  const storage = new SqliteDurableStorage();
  try {
    const namespace = sqliteNamespace(storage);
    const results = await Promise.all(Array.from({ length: 32 }, () => claimIsolatedCausalAttempt(namespace, verified(), 1_799_000_000_000)));
    assert.equal(results.filter((result) => result.claimed).length, 1);
    assert.equal(new Set(results.map((result) => result.sourceIdentityDigest)).size, 1);
    assert.equal((await claimIsolatedCausalAttempt(namespace, verified(), 1_799_000_000_001)).claimed, false);
    assert.equal((await claimIsolatedCausalAttempt(namespace, verified("7654322"), 1_799_000_000_002)).claimed, true);
  } finally {
    storage.db.close();
  }
});

test("SQLite claim survives coordinator reconstruction and does not expire or release", async () => {
  const sqlite = persistentSqliteHarness();
  const { storage } = sqlite;
  try {
    const firstCoordinator = new ExecutionCoordinator({ storage });
    const firstNamespace: ExecutionCoordinatorNamespace = {
      idFromName: (name) => name,
      get: () => ({ fetch: (input, init) => firstCoordinator.fetch(new Request(input, init)) }),
    };
    assert.equal((await claimIsolatedCausalAttempt(firstNamespace, verified(), 1_799_000_000_000)).claimed, true);

    const reopenedStorage = sqlite.restart();
    const restartedNamespace = sqliteNamespace(reopenedStorage);
    assert.equal((await claimIsolatedCausalAttempt(restartedNamespace, verified(), 1_899_000_000_000)).claimed, false);
    const rows = reopenedStorage.db.prepare("SELECT COUNT(*) AS count FROM durable_objects").get() as { count: number };
    assert.equal(Number(rows.count), 1);
  } finally {
    sqlite.cleanup();
  }
});

test("committed claim with lost response remains consumed and is never executed by caller", async () => {
  const storage = new SqliteDurableStorage();
  try {
    const namespace = sqliteNamespace(storage, () => { throw new Error("response lost after commit"); });
    await assert.rejects(claimIsolatedCausalAttempt(namespace, verified(), 1_799_000_000_000), /ISOLATED_CAUSAL_CLAIM_STORAGE_UNAVAILABLE/);
    const retry = await claimIsolatedCausalAttempt(sqliteNamespace(storage), verified(), 1_799_000_000_001);
    assert.equal(retry.claimed, false);
  } finally {
    storage.db.close();
  }
});

test("claim fails closed when SQLite transaction support is missing", async () => {
  const storage = {
    async get<T>(): Promise<T | undefined> { return undefined; },
    async put(_key: string, _value: unknown): Promise<void> { assert.fail("non-transactional storage must not be written"); },
  };
  const coordinator = new ExecutionCoordinator({ storage });
  const namespace: ExecutionCoordinatorNamespace = {
    idFromName: (name) => name,
    get: () => ({ fetch: (input, init) => coordinator.fetch(new Request(input, init)) }),
  };
  await assert.rejects(claimIsolatedCausalAttempt(namespace, verified()), /ISOLATED_CAUSAL_CLAIM_STORAGE_UNAVAILABLE/);
});
