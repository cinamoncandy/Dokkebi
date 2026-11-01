"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createBackup, readAndVerify, runDrill } = require("../scripts/backup-restore.js");
const { SYMLINK_UNAVAILABLE, canCreateSymlink } = require("./support/symlinkCapability.js");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-recovery-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "backups");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify({ mode: "PAPER", productionMutationAllowed: false }));
  fs.writeFileSync(path.join(source, "dashboard-token.txt"), "must-never-be-backed-up");
  const hiddenApiKey = ["actual", "secret-value", "123456"].join("-");
  fs.writeFileSync(path.join(source, "plain-settings.json"), JSON.stringify({ api_key: hiddenApiKey }));
  return { root, source, destination };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

test("backup creates a missing destination, excludes secret-shaped paths, and records fail-closed safety metadata", () => {
  const { root, source, destination } = fixture();
  try {
    const result = createBackup({ include: [`CONFIG:${source}`], destination, "snapshot-id": "snapshot-a" });
    assert.equal(fs.existsSync(destination), true);
    assert.equal(result.manifest.mode, "BACKUP_COPY_ONLY");
    assert.equal(result.manifest.productionMutationAllowed, false);
    assert.equal(result.manifest.evidenceMutationAllowed, false);
    assert.equal(result.manifest.destructiveRestoreAllowed, false);
    assert.equal(result.manifest.secretMaterialIncluded, false);
    assert.equal(result.manifest.secretExcludedCount, 2);
    assert.equal(result.manifest.entries.length, 1);
    assert.match(result.manifest.entries[0].path, /settings\.json$/);
    assert.doesNotMatch(JSON.stringify(result.manifest), /must-never-be-backed-up/);
    assert.equal(readAndVerify(result.snapshot).manifestSha256.length, 64);
  } finally {
    cleanup(root);
  }
});

test("backup content scanning excludes secrets hidden behind benign filenames and verify rejects a self-consistent secret artifact", () => {
  const { root, source, destination } = fixture();
  try {
    const backup = createBackup({ include: [`CONFIG:${source}`], destination, "snapshot-id": "snapshot-secret-scan" });
    assert.equal(backup.manifest.entries.length, 1);
    assert.equal(backup.manifest.secretExcludedCount, 2);
    assert.match(backup.manifest.entries[0].path, /settings\.json$/);

    const manifestPath = path.join(backup.snapshot, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const entry = manifest.entries[0];
    const artifact = path.join(backup.snapshot, ...entry.path.split("/"));
    const hiddenToken = ["tampered", "secret-value", "123456"].join("-");
    const secretPayload = JSON.stringify({ token: hiddenToken });
    fs.writeFileSync(artifact, secretPayload);
    entry.sizeBytes = Buffer.byteLength(secretPayload);
    entry.sha256 = crypto.createHash("sha256").update(secretPayload).digest("hex");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    assert.throws(() => readAndVerify(backup.snapshot), /secret material detected/);
  } finally {
    cleanup(root);
  }
});

test("secret scanning detects credentials that cross the fixed I/O chunk boundary", () => {
  const { root, source, destination } = fixture();
  try {
    fs.writeFileSync(path.join(source, "safe.log"), "ordinary recovery log");
    const token = Buffer.from(["ghp_", "abcdefghijklmnop1234567890"].join(""));
    const boundary = 1024 * 1024;
    const bytes = Buffer.alloc(boundary + token.length + 16);
    token.copy(bytes, boundary - 7);
    fs.writeFileSync(path.join(source, "opaque.bin"), bytes);

    const backup = createBackup({ include: [`EVIDENCE:${source}`], destination, "snapshot-id": "snapshot-boundary-secret" });
    assert.equal(backup.manifest.entries.some((entry) => path.basename(entry.path) === "opaque.bin"), false);
    assert.equal(backup.manifest.entries.some((entry) => path.basename(entry.path) === "safe.log"), true);
  } finally {
    cleanup(root);
  }
});

test("large credential-heavy artifacts are rejected without retaining every secret finding", () => {
  const { root, destination } = fixture();
  const credentialSource = path.join(root, "credential-only");
  fs.mkdirSync(credentialSource);
  const credentialFile = path.join(credentialSource, "credential-heavy.log");
  const secretValue = ["fixture", "secret", "value", "1234567890"].join("-");
  const secretKey = ["api", "key"].join("_");
  const line = Buffer.from(`${secretKey} = "${secretValue}"\n`);
  const chunk = Buffer.alloc(1024 * 1024);
  for (let offset = 0; offset < chunk.length; offset += line.length) line.copy(chunk, offset, 0, Math.min(line.length, chunk.length - offset));
  const descriptor = fs.openSync(credentialFile, "wx", 0o600);
  try {
    for (let index = 0; index < 32; index += 1) fs.writeSync(descriptor, chunk);
  } finally {
    fs.closeSync(descriptor);
  }

  try {
    const sourceScript = [
      'const { createBackup } = require(process.argv[1]);',
      'try { createBackup({ include: [`EVIDENCE:${process.argv[2]}`], destination: process.argv[3], "snapshot-id": "secret-heavy" }); process.exitCode = 2; }',
      'catch (error) { if (error.message !== "backup contains no non-secret files") throw error; process.stdout.write("secret-rejected"); }'
    ].join("\n");
    const child = spawnSync(process.execPath, ["--max-old-space-size=64", "-e", sourceScript, path.resolve(__dirname, "../scripts/backup-restore.js"), credentialSource, destination], { encoding: "utf8", timeout: 30000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "secret-rejected");
  } finally {
    cleanup(root);
  }
});

test("large binary DATABASE_SNAPSHOT above Node's maximum string length backs up and verifies with bounded chunks", () => {
  const { root, source, destination } = fixture();
  const largeFile = path.join(source, "state.sqlite");
  let descriptor;
  try {
    descriptor = fs.openSync(largeFile, "wx", 0o600);
    const sizeBytes = 0x20000000;
    fs.writeSync(descriptor, Buffer.from("SQLite format 3\0"), 0, 16, 0);
    fs.ftruncateSync(descriptor, sizeBytes);
    fs.closeSync(descriptor);
    descriptor = undefined;

    const sourceSha256 = hashFile(largeFile);
    const backup = createBackup({ include: [`DATABASE_SNAPSHOT:${largeFile}`], destination, "snapshot-id": "snapshot-large-binary" });
    const entry = backup.manifest.entries[0];
    assert.equal(entry.sizeBytes, sizeBytes);
    assert.equal(entry.sha256, sourceSha256);

    const verified = readAndVerify(backup.snapshot);
    const copied = path.join(backup.snapshot, ...entry.path.split("/"));
    assert.equal(verified.manifest.entries[0].sha256, sourceSha256);
    assert.equal(hashFile(copied), sourceSha256);
    assert.equal(fs.statSync(largeFile).size, sizeBytes);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    cleanup(root);
  }
});

test("verify fails closed when a backed-up artifact is tampered", () => {
  const { root, source, destination } = fixture();
  try {
    const result = createBackup({ include: [`EVIDENCE:${source}`], destination, "snapshot-id": "snapshot-b" });
    const entry = result.manifest.entries[0];
    fs.appendFileSync(path.join(result.snapshot, ...entry.path.split("/")), "tamper");
    assert.throws(() => readAndVerify(result.snapshot), /size mismatch|checksum mismatch/);
  } finally {
    cleanup(root);
  }
});

test("verify-only restore drill removes the target and writes a manifest-bound Evidence log", () => {
  const { root, source, destination } = fixture();
  try {
    const backup = createBackup({ include: [`CONFIG:${source}`], destination, "snapshot-id": "snapshot-c" });
    const drillTarget = path.join(root, "drill-target");
    const drillLog = path.join(root, "evidence", "recovery-drill.json");
    const result = runDrill({ snapshot: backup.snapshot, "drill-target": drillTarget, "drill-log": drillLog });
    assert.equal(result.status, "PASS");
    assert.equal(result.mode, "VERIFY_ONLY_RESTORE_DRILL");
    assert.equal(result.targetRemoved, true);
    assert.equal(fs.existsSync(drillTarget), false);
    assert.equal(fs.existsSync(drillLog), true);

    const evidence = JSON.parse(fs.readFileSync(drillLog, "utf8"));
    assert.equal(evidence.eventType, "RECOVERY_DRILL_EVIDENCE");
    assert.equal(evidence.snapshotId, "snapshot-c");
    assert.equal(evidence.snapshotManifestSha256, readAndVerify(backup.snapshot).manifestSha256);
    assert.equal(evidence.productionMutationAllowed, false);
    assert.equal(evidence.evidenceMutationAllowed, false);
    assert.equal(evidence.destructiveRestoreAllowed, false);
    assert.equal(evidence.automaticRestartAllowed, false);
    const { evidenceHashSha256, ...payload } = evidence;
    assert.equal(evidenceHashSha256, crypto.createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex"));
  } finally {
    cleanup(root);
  }
});

test("verify-only drill checks read-only SQLite integrity on the copied snapshot and leaves source rows unchanged", () => {
  const { root, source, destination } = fixture();
  const databasePath = path.join(source, "paper.sqlite");
  let database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE recovery_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO recovery_probe(value) VALUES ('unchanged');");
  database.close();
  database = undefined;
  try {
    const sourceDigest = hashFile(databasePath);
    const backup = createBackup({ include: [`DATABASE_SNAPSHOT:${databasePath}`], destination, "snapshot-id": "snapshot-sqlite-integrity" });
    const drillTarget = path.join(root, "integrity-drill-target");
    const drillLog = path.join(root, "integrity-drill-log.json");
    const result = runDrill({ snapshot: backup.snapshot, "drill-target": drillTarget, "drill-log": drillLog, keep: "true" });

    assert.deepEqual(result.databaseIntegrityChecks, [{
      path: backup.manifest.entries[0].path,
      quickCheck: "PASS",
      integrityCheck: "PASS"
    }]);
    const log = JSON.parse(fs.readFileSync(drillLog, "utf8"));
    assert.deepEqual(log.databaseIntegrityChecks, result.databaseIntegrityChecks);
    assert.equal(hashFile(databasePath), sourceDigest);

    const restored = new DatabaseSync(path.join(drillTarget, ...backup.manifest.entries[0].path.split("/")), { readOnly: true });
    try {
      assert.equal(restored.prepare("SELECT value FROM recovery_probe WHERE id = 1").get().value, "unchanged");
    } finally {
      restored.close();
    }
  } finally {
    if (database) database.close();
    cleanup(root);
  }
});

test("verify-only drill checks SQLite databases and skips their verified SHA-256 sidecars", () => {
  const { root, destination } = fixture();
  const source = path.join(root, "database-snapshots");
  const databasePath = path.join(source, "daily-cloud-state-2026-11-01T00-00-00-000Z.db");
  const target = path.join(root, "sidecar-drill-target");
  const drillLog = path.join(root, "sidecar-drill-log.json");
  fs.mkdirSync(source);
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE recovery_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO recovery_probe(value) VALUES ('unchanged');");
  database.close();
  const digest = hashFile(databasePath);
  fs.writeFileSync(`${databasePath}.sha256`, `${digest}  ${path.basename(databasePath)}\n`);

  try {
    const backup = createBackup({ include: [`DATABASE_SNAPSHOT:${source}`], destination, "snapshot-id": "snapshot-with-sidecar" });
    assert.equal(backup.manifest.entries.length, 2);
    const databaseEntry = backup.manifest.entries.find((entry) => !entry.path.endsWith(".sha256"));
    const sidecarEntry = backup.manifest.entries.find((entry) => entry.path.endsWith(".sha256"));
    assert.ok(databaseEntry);
    assert.ok(sidecarEntry);

    const result = runDrill({ snapshot: backup.snapshot, "drill-target": target, "drill-log": drillLog, keep: "true" });
    assert.deepEqual(result.databaseIntegrityChecks, [{
      path: databaseEntry.path,
      quickCheck: "PASS",
      integrityCheck: "PASS"
    }]);
    assert.equal(fs.readFileSync(path.join(target, ...sidecarEntry.path.split("/")), "utf8"), `${databaseEntry.sha256}  ${path.basename(databaseEntry.path)}\n`);
    assert.equal(fs.readFileSync(path.join(target, ...databaseEntry.path.split("/"))).subarray(0, 16).toString("utf8"), "SQLite format 3\0");
  } finally {
    cleanup(root);
  }
});

test("verify-only drill does not treat an unpaired SHA-256 sidecar as non-database evidence", () => {
  const { root, destination } = fixture();
  const databaseDirectory = path.join(root, "unpaired-snapshot");
  const target = path.join(root, "unpaired-drill-target");
  const drillLog = path.join(root, "unpaired-drill-log.json");
  fs.mkdirSync(databaseDirectory);
  fs.writeFileSync(path.join(databaseDirectory, "orphan.db.sha256"), `${"a".repeat(64)}  missing.db\n`);

  try {
    const backup = createBackup({ include: [`DATABASE_SNAPSHOT:${databaseDirectory}`], destination, "snapshot-id": "snapshot-orphan-sidecar" });
    assert.throws(
      () => runDrill({ snapshot: backup.snapshot, "drill-target": target, "drill-log": drillLog }),
      /not a database|database disk image is malformed/i,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(drillLog), false);
  } finally {
    cleanup(root);
  }
});

test("verify-only drill fails closed on a malformed DATABASE_SNAPSHOT and removes only its temporary target", () => {
  const { root, source, destination } = fixture();
  const databasePath = path.join(source, "malformed.sqlite");
  const target = path.join(root, "malformed-drill-target");
  const drillLog = path.join(root, "malformed-drill-log.json");
  fs.writeFileSync(databasePath, Buffer.from("not a SQLite database"));
  try {
    const sourceDigest = hashFile(databasePath);
    const backup = createBackup({ include: [`DATABASE_SNAPSHOT:${databasePath}`], destination, "snapshot-id": "snapshot-malformed-sqlite" });
    assert.throws(
      () => runDrill({ snapshot: backup.snapshot, "drill-target": target, "drill-log": drillLog }),
      /not a database|database disk image is malformed/i,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(drillLog), false);
    assert.equal(hashFile(databasePath), sourceDigest);
  } finally {
    cleanup(root);
  }
});

test("a drill refuses to overwrite an existing Evidence log", () => {
  const { root, source, destination } = fixture();
  try {
    const backup = createBackup({ include: [`CONFIG:${source}`], destination, "snapshot-id": "snapshot-d" });
    const drillLog = path.join(root, "drill.json");
    fs.writeFileSync(drillLog, "existing");
    assert.throws(() => runDrill({ snapshot: backup.snapshot, "drill-log": drillLog, "drill-target": path.join(root, "target") }), /drill log must not already exist/);
  } finally {
    cleanup(root);
  }
});

test("backup refuses symlink sources and release metadata missing checksums or SBOM", (t) => {
  const { root, source, destination } = fixture();
  try {
    // Skipping only the symlink half keeps the rest of this contract enforced everywhere.
    if (canCreateSymlink()) {
      const linked = path.join(root, "linked");
      fs.symlinkSync(source, linked, "dir");
      assert.throws(() => createBackup({ include: [`CONFIG:${linked}`], destination, "snapshot-id": "snapshot-e" }), /symlink is prohibited/);
    } else {
      t.diagnostic(SYMLINK_UNAVAILABLE);
    }

    const release = path.join(root, "release");
    fs.mkdirSync(release);
    fs.writeFileSync(path.join(release, "build-manifest.json"), JSON.stringify({ capabilityDescriptor: { productionMutationAllowed: false } }));
    assert.throws(() => createBackup({ include: [`CONFIG:${source}`], destination, "snapshot-id": "snapshot-f", "release-root": release }), /checksums and SBOM are required/);
    assert.equal(fs.existsSync(path.join(destination, "snapshot-f")), false, "failed backup must be cleaned up");
  } finally {
    cleanup(root);
  }
});

test("destructive restore command is intentionally unavailable", () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "..", "scripts", "backup-restore.js"), "restore"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /destructive restore is intentionally unsupported/);
});
