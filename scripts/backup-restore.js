#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { DatabaseSync } = require("node:sqlite");
const { validateDisasterRecoveryRestore } = require("./validate-disaster-recovery-restore.js");
const { scanText } = require("./security-gate.js");

const SCHEMA_VERSION = 2;
const CATEGORIES = new Set(["CONFIG", "EVIDENCE", "LOG", "DATABASE_SNAPSHOT"]);
const FORBIDDEN_NAME = /(^|[._-])(env|secret|token|password|credential|private[-_]?key|api[-_]?key)([._-]|$)|\.(pem|p12|pfx|key)$/i;
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SENSITIVE_ASSIGNMENT = /(?:^|[\s,{])["']?(?:access[_-]?key|api[_-]?key|client[_-]?secret|password|passwd|secret[_-]?key|token|credential|private[_-]?key)["']?\s*[:=]\s*(?:bearer\s+)?(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s,}\]]{8,})/i;
const AUTHORIZATION_VALUE = String.raw`(?<credential>"[^"\r\n]*"|'[^'\r\n]*'|[^,;)}\]\r\n]*)`;
const AUTHORIZATION_OBJECT = String.raw`[A-Za-z_$][\w$]*(?:(?:\s*\.\s*[A-Za-z_$][\w$]*)|(?:\s*\[\s*["'][^"']+["']\s*\]))*`;
const AUTHORIZATION_TARGET = String.raw`(?:${AUTHORIZATION_OBJECT}\s*(?:\.\s*authorization|\[\s*["']authorization["']\s*\])|["']?authorization["']?)`;
const AUTHORIZATION_ASSIGNMENT = new RegExp(
  String.raw`(?:^|[\s,{;])${AUTHORIZATION_TARGET}\s*(?::|=)\s*${AUTHORIZATION_VALUE}`,
  "i",
);
const AUTHORIZATION_PAIR = new RegExp(
  String.raw`(?:^|[\[,])\s*["']authorization["']\s*,\s*${AUTHORIZATION_VALUE}`,
  "i",
);
const AUTHORIZATION_SETTER = new RegExp(
  String.raw`\.\s*(?:set|append|setHeader|appendHeader|setRequestHeader)\s*\(\s*["']authorization["']\s*,\s*${AUTHORIZATION_VALUE}`,
  "i",
);
const IO_CHUNK_BYTES = 1024 * 1024;
const SECRET_SCAN_OVERLAP_CHARS = 128 * 1024;

function authorizationCredential(match) {
  if (!match) return undefined;
  let value = String(match.groups?.credential ?? "").trim();
  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  if (quoted && value.length >= 2) {
    value = value.slice(1, -1).trim();
    return value || undefined;
  }
  if (!value || /^(?:null|undefined)$/i.test(value)) return undefined;
  return value;
}

function expressionHasAuthorizationCredential(expression, normalized) {
  const flags = expression.flags.includes("g") ? expression.flags : `${expression.flags}g`;
  const matcher = new RegExp(expression.source, flags);
  for (const match of normalized.matchAll(matcher)) {
    if (authorizationCredential(match) !== undefined) return true;
  }
  return false;
}

function hasAuthorizationCredential(text) {
  const normalized = String(text ?? "").replace(/\\(["'])/g, "$1");
  return [AUTHORIZATION_ASSIGNMENT, AUTHORIZATION_PAIR, AUTHORIZATION_SETTER]
    .some((expression) => expressionHasAuthorizationCredential(expression, normalized));
}

function secretFindings(text, file) {
  const normalized = text.replace(/(["'])(authorization|access[_-]?key|api[_-]?key|client[_-]?secret|password|passwd|secret[_-]?key|token|credential|private[_-]?key)\1\s*:/gi, "$2:");
  const findings = scanText(normalized, file);
  if (SENSITIVE_ASSIGNMENT.test(text)) findings.push({ file, line: 0, rule: "SENSITIVE_ASSIGNMENT" });
  if (hasAuthorizationCredential(text)) findings.push({ file, line: 0, rule: "AUTHORIZATION_CREDENTIAL" });
  return findings;
}

class BoundedSecretScanner {
  constructor(file) {
    this.file = file;
    this.decoder = new StringDecoder("utf8");
    this.carry = "";
    this.findings = [];
  }

  update(bytes) {
    this.scan(this.decoder.write(bytes));
  }

  finish() {
    this.scan(this.decoder.end());
    return this.findings;
  }

  scan(decoded) {
    if (!decoded) return;
    const window = this.carry + decoded;
    this.findings.push(...secretFindings(window, this.file));
    this.carry = window.slice(-SECRET_SCAN_OVERLAP_CHARS);
  }
}

function parseArgs(argv) {
  const args = { include: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--include") args.include.push(argv[++i]);
    else if (value.startsWith("--")) args[value.slice(2)] = argv[++i] ?? true;
    else if (!args.command) args.command = value;
    else throw new Error(`unexpected argument: ${value}`);
  }
  return args;
}

function openStableRegularFile(file, root) {
  assertNoSymlink(file, root);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile()) throw new Error(`recovery source must remain a regular file: ${file}`);
  const expectedRealpath = fs.realpathSync(file);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const currentRealpath = fs.realpathSync(file);
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || currentRealpath !== expectedRealpath) {
      throw new Error(`recovery source identity changed before read: ${file}`);
    }
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`recovery source is too large to represent safely: ${file}`);
    return { descriptor, opened, expectedRealpath, file };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function assertStableRegularFile(identity) {
  const after = fs.fstatSync(identity.descriptor, { bigint: true });
  const currentRealpath = fs.realpathSync(identity.file);
  if (!after.isFile()
    || after.dev !== identity.opened.dev
    || after.ino !== identity.opened.ino
    || after.size !== identity.opened.size
    || after.mtimeNs !== identity.opened.mtimeNs
    || after.ctimeNs !== identity.opened.ctimeNs
    || currentRealpath !== identity.expectedRealpath) {
    throw new Error(`recovery source changed while being read: ${identity.file}`);
  }
}

function forEachFileChunk(descriptor, sizeBytes, visit) {
  const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
  let position = 0;
  while (position < sizeBytes) {
    const requested = Math.min(buffer.length, sizeBytes - position);
    const read = fs.readSync(descriptor, buffer, 0, requested, position);
    if (read <= 0) throw new Error("recovery source ended before its verified size");
    visit(buffer.subarray(0, read));
    position += read;
  }
}

function scanAndHashDescriptor(descriptor, sizeBytes, file) {
  const hash = crypto.createHash("sha256");
  const scanner = new BoundedSecretScanner(file);
  forEachFileChunk(descriptor, sizeBytes, (chunk) => {
    hash.update(chunk);
    scanner.update(chunk);
  });
  return { sha256: hash.digest("hex"), findings: scanner.finish() };
}

function hashDescriptor(descriptor, sizeBytes) {
  const hash = crypto.createHash("sha256");
  forEachFileChunk(descriptor, sizeBytes, (chunk) => hash.update(chunk));
  return hash.digest("hex");
}

function sha256File(file) {
  const identity = openStableRegularFile(file, path.dirname(file));
  try {
    const digest = hashDescriptor(identity.descriptor, Number(identity.opened.size));
    assertStableRegularFile(identity);
    return digest;
  } finally {
    fs.closeSync(identity.descriptor);
  }
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function ensureCurrentRecoveryContract() {
  const result = validateDisasterRecoveryRestore();
  if (!result.ok) throw new Error(`current disaster-recovery contract is invalid: ${result.failures.join(",")}`);
}

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }).trim();
  } catch {
    return "UNKNOWN";
  }
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const resolved = path.resolve(value);
  if (!path.isAbsolute(resolved)) throw new Error(`${label} must resolve to an absolute path`);
  return resolved;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertNoSymlink(file, root) {
  let current = file;
  while (isInside(root, current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`symlink is prohibited in recovery source: ${current}`);
    if (current === root) return;
    current = path.dirname(current);
  }
}

function copyStableRegularFile(file, root, output, relative) {
  const identity = openStableRegularFile(file, root);
  let outputDescriptor;
  try {
    const sizeBytes = Number(identity.opened.size);
    const scanned = scanAndHashDescriptor(identity.descriptor, sizeBytes, relative);
    assertStableRegularFile(identity);
    if (scanned.findings.length > 0) return { included: false, sizeBytes, sha256: scanned.sha256 };

    outputDescriptor = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const copiedHash = crypto.createHash("sha256");
    forEachFileChunk(identity.descriptor, sizeBytes, (chunk) => {
      copiedHash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const count = fs.writeSync(outputDescriptor, chunk, written, chunk.length - written);
        if (count <= 0) throw new Error("recovery destination stopped accepting bytes");
        written += count;
      }
    });
    assertStableRegularFile(identity);
    const copySha256 = copiedHash.digest("hex");
    if (copySha256 !== scanned.sha256) throw new Error(`recovery source changed between secret scan and copy: ${file}`);
    return { included: true, sizeBytes, sha256: copySha256 };
  } catch (error) {
    if (outputDescriptor != null) {
      fs.closeSync(outputDescriptor);
      outputDescriptor = undefined;
      fs.rmSync(output, { force: true });
    }
    throw error;
  } finally {
    if (outputDescriptor != null) fs.closeSync(outputDescriptor);
    fs.closeSync(identity.descriptor);
  }
}

function verifySqliteIntegrity(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    for (const checkName of ["quick_check", "integrity_check"]) {
      const statement = database.prepare(`PRAGMA ${checkName}`);
      let rowCount = 0;
      for (const row of statement.iterate()) {
        rowCount += 1;
        const values = Object.values(row);
        if (values.length !== 1 || values[0] !== "ok") throw new Error(`SQLite ${checkName} failed for copied recovery database`);
      }
      if (rowCount === 0) throw new Error(`SQLite ${checkName} returned no result for copied recovery database`);
    }
  } finally {
    database.close();
  }
  return Object.freeze({ quickCheck: "PASS", integrityCheck: "PASS" });
}

function parseIncludes(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("at least one --include CATEGORY:/absolute/path is required");
  return raw.map((entry) => {
    const separator = entry.indexOf(":");
    if (separator < 1) throw new Error(`invalid include: ${entry}`);
    const category = entry.slice(0, separator).toUpperCase();
    if (!CATEGORIES.has(category)) throw new Error(`unsupported recovery category: ${category}`);
    const source = normalizedAbsolute(entry.slice(separator + 1), "include path");
    if (!fs.existsSync(source)) throw new Error(`recovery source does not exist: ${source}`);
    assertNoSymlink(source, source);
    return Object.freeze({ category, source });
  });
}

function walkFiles(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error(`symlink is prohibited in recovery source: ${root}`);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) throw new Error(`unsupported recovery source type: ${root}`);
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink is prohibited in recovery source: ${full}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  return files;
}

function safeRelative(root, file) {
  const relative = fs.lstatSync(root).isFile() ? path.basename(root) : path.relative(root, file);
  const normalized = relative.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) throw new Error(`unsafe recovery path: ${normalized}`);
  return normalized;
}

function releaseContract(releaseRoot) {
  if (!releaseRoot) return Object.freeze({ status: "NOT_REQUESTED" });
  const root = normalizedAbsolute(releaseRoot, "release-root");
  const buildManifest = path.join(root, "build-manifest.json");
  if (!fs.existsSync(buildManifest)) throw new Error("release build-manifest.json is required when --release-root is provided");
  const files = fs.readdirSync(root).sort();
  const checksum = files.find((name) => name.endsWith("-checksums.txt"));
  const sbom = files.find((name) => name.endsWith("-SBOM.json"));
  if (!checksum || !sbom) throw new Error("release checksums and SBOM are required when --release-root is provided");
  const manifest = JSON.parse(fs.readFileSync(buildManifest, "utf8"));
  if (manifest?.capabilityDescriptor?.productionMutationAllowed !== false) throw new Error("release manifest must preserve productionMutationAllowed=false");
  return Object.freeze({
    status: "VERIFIED_INPUTS_PRESENT",
    commit: manifest.commit ?? "UNKNOWN",
    productionMutationAllowed: false,
    buildManifestSha256: sha256File(buildManifest),
    checksumsSha256: sha256File(path.join(root, checksum)),
    sbomSha256: sha256File(path.join(root, sbom))
  });
}

function snapshotId(requested) {
  const value = requested || process.env.NUSA_RECOVERY_SNAPSHOT_ID || `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
  if (!SNAPSHOT_ID.test(value)) throw new Error("snapshot id contains unsupported characters");
  return value;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}

function createBackup(args) {
  ensureCurrentRecoveryContract();
  const includes = parseIncludes(args.include);
  const destinationRoot = normalizedAbsolute(args.destination, "destination");
  for (const { source } of includes) {
    if (isInside(source, destinationRoot)) throw new Error("backup destination must not be inside a recovery source");
  }
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const id = snapshotId(args["snapshot-id"]);
  const snapshot = path.join(destinationRoot, id);
  if (fs.existsSync(snapshot)) throw new Error(`backup snapshot already exists: ${snapshot}`);
  fs.mkdirSync(snapshot, { recursive: false, mode: 0o700 });

  const entries = [];
  let secretExcludedCount = 0;
  try {
    for (const { category, source } of includes) {
      for (const file of walkFiles(source)) {
        const relative = safeRelative(source, file);
        if (relative.split("/").some((segment) => FORBIDDEN_NAME.test(segment))) {
          secretExcludedCount += 1;
          continue;
        }
        const outputRelative = `${category}/${crypto.createHash("sha256").update(source).digest("hex").slice(0, 12)}/${relative}`;
        const output = path.join(snapshot, ...outputRelative.split("/"));
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
        const copied = copyStableRegularFile(file, source, output, relative);
        if (!copied.included) {
          secretExcludedCount += 1;
          continue;
        }
        entries.push(Object.freeze({
          category,
          path: outputRelative,
          sizeBytes: copied.sizeBytes,
          sha256: copied.sha256
        }));
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    if (entries.length === 0) throw new Error("backup contains no non-secret files");
    const manifest = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      snapshotId: id,
      createdAt: new Date().toISOString(),
      sourceCommit: gitHead(),
      mode: "BACKUP_COPY_ONLY",
      destructiveRestoreAllowed: false,
      productionMutationAllowed: false,
      evidenceMutationAllowed: false,
      secretMaterialIncluded: false,
      secretExcludedCount,
      releaseContract: releaseContract(args["release-root"]),
      entries
    });
    atomicJson(path.join(snapshot, "manifest.json"), manifest);
    return Object.freeze({ snapshot, manifest });
  } catch (error) {
    fs.rmSync(snapshot, { recursive: true, force: true });
    throw error;
  }
}

function readAndVerify(snapshotPath) {
  ensureCurrentRecoveryContract();
  const snapshot = normalizedAbsolute(snapshotPath, "snapshot");
  const manifestPath = path.join(snapshot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error(`unsupported recovery manifest schema: ${manifest.schemaVersion}`);
  if (manifest.destructiveRestoreAllowed !== false || manifest.productionMutationAllowed !== false || manifest.evidenceMutationAllowed !== false || manifest.secretMaterialIncluded !== false) {
    throw new Error("recovery manifest safety invariants are invalid");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) throw new Error("recovery manifest entries are required");
  const seen = new Set();
  for (const entry of manifest.entries) {
    if (!CATEGORIES.has(entry.category)) throw new Error(`invalid recovery category: ${entry.category}`);
    if (typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.includes("../")) throw new Error(`unsafe manifest path: ${entry.path}`);
    if (entry.path.split("/").some((segment) => FORBIDDEN_NAME.test(segment))) throw new Error(`secret-shaped path in manifest: ${entry.path}`);
    if (seen.has(entry.path)) throw new Error(`duplicate manifest path: ${entry.path}`);
    seen.add(entry.path);
    const file = path.join(snapshot, ...entry.path.split("/"));
    if (!isInside(snapshot, file) || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`missing recovery artifact: ${entry.path}`);
    const identity = openStableRegularFile(file, snapshot);
    try {
      const sizeBytes = Number(identity.opened.size);
      if (sizeBytes !== entry.sizeBytes) throw new Error(`size mismatch: ${entry.path}`);
      const inspected = scanAndHashDescriptor(identity.descriptor, sizeBytes, entry.path);
      assertStableRegularFile(identity);
      if (inspected.sha256 !== entry.sha256) throw new Error(`checksum mismatch: ${entry.path}`);
      if (inspected.findings.length > 0) throw new Error(`secret material detected in recovery artifact: ${entry.path}`);
    } finally {
      fs.closeSync(identity.descriptor);
    }
  }
  return Object.freeze({ snapshot, manifest, manifestPath, manifestSha256: sha256File(manifestPath) });
}

function writeDrillLog(args, verified, result, targetRemoved) {
  const logFile = normalizedAbsolute(
    args["drill-log"] || path.join(path.dirname(verified.snapshot), `${verified.manifest.snapshotId}.drill-log.json`),
    "drill-log"
  );
  if (isInside(verified.snapshot, logFile)) throw new Error("drill log must be outside the immutable recovery snapshot");
  if (fs.existsSync(logFile)) throw new Error("drill log must not already exist");
  const payload = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    eventType: "RECOVERY_DRILL_EVIDENCE",
    createdAt: new Date().toISOString(),
    sourceCommit: gitHead(),
    snapshotId: verified.manifest.snapshotId,
    snapshotManifestSha256: verified.manifestSha256,
    status: result.status,
    mode: result.mode,
    artifactCount: result.artifactCount,
    databaseIntegrityChecks: result.databaseIntegrityChecks,
    targetRemoved,
    automaticRestartAllowed: false,
    destructiveRestoreAllowed: false,
    productionMutationAllowed: false,
    evidenceMutationAllowed: false
  });
  const evidenceHashSha256 = sha256Json(payload);
  const evidence = Object.freeze({ ...payload, evidenceHashSha256 });
  atomicJson(logFile, evidence);
  return Object.freeze({ logFile, evidence });
}

function runDrill(args) {
  const verified = readAndVerify(args.snapshot);
  const target = normalizedAbsolute(args["drill-target"] || path.join(os.tmpdir(), `nusa-recovery-drill-${process.pid}`), "drill-target");
  if (fs.existsSync(target)) throw new Error("drill target must not already exist");
  fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  try {
    const databaseIntegrityChecks = [];
    for (const entry of verified.manifest.entries) {
      const source = path.join(verified.snapshot, ...entry.path.split("/"));
      const output = path.join(target, ...entry.path.split("/"));
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, output, fs.constants.COPYFILE_EXCL);
      if (sha256File(output) !== entry.sha256) throw new Error(`drill checksum mismatch: ${entry.path}`);
      if (entry.category === "DATABASE_SNAPSHOT") {
        databaseIntegrityChecks.push(Object.freeze({ path: entry.path, ...verifySqliteIntegrity(output) }));
      }
    }
    const keepTarget = args.keep === "true";
    const result = Object.freeze({
      status: "PASS",
      mode: "VERIFY_ONLY_RESTORE_DRILL",
      snapshotId: verified.manifest.snapshotId,
      artifactCount: verified.manifest.entries.length,
      databaseIntegrityChecks,
      target,
      automaticRestartAllowed: false,
      destructiveRestoreAllowed: false,
      productionMutationAllowed: false,
      evidenceMutationAllowed: false
    });
    if (!keepTarget) fs.rmSync(target, { recursive: true, force: true });
    const drillLog = writeDrillLog(args, verified, result, !keepTarget);
    return Object.freeze({ ...result, drillLog: drillLog.logFile, evidenceHashSha256: drillLog.evidence.evidenceHashSha256, targetRemoved: !keepTarget });
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "backup") {
    const result = createBackup(args);
    console.log(JSON.stringify({ status: "PASS", mode: "BACKUP_COPY_ONLY", snapshot: result.snapshot, artifactCount: result.manifest.entries.length, secretExcludedCount: result.manifest.secretExcludedCount, productionMutationAllowed: false }, null, 2));
    return;
  }
  if (args.command === "verify") {
    const result = readAndVerify(args.snapshot);
    console.log(JSON.stringify({ status: "PASS", mode: "VERIFY_ONLY", snapshotId: result.manifest.snapshotId, artifactCount: result.manifest.entries.length, manifestSha256: result.manifestSha256, productionMutationAllowed: false }, null, 2));
    return;
  }
  if (args.command === "drill") {
    console.log(JSON.stringify(runDrill(args), null, 2));
    return;
  }
  if (args.command === "restore") throw new Error("destructive restore is intentionally unsupported; use the verify-only drill command");
  throw new Error("usage: backup-restore.js <backup|verify|drill> [options]");
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`[backup-restore] ${error instanceof Error ? error.message : "recovery operation failed"}`);
    process.exitCode = 1;
  }
}

module.exports = { createBackup, readAndVerify, runDrill, parseIncludes, writeDrillLog };
