const { randomBytes } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  PAPER_WRITER_LEASE_CONFLICT_EXIT_CODE,
  PaperRuntimeProcessSupervisor,
} = require("./paper-runtime-supervisor.js");

/**
 * Starts the Cloud PAPER runtime with a configuration that actually works out of the box.
 *
 * `readCloudRuntimeConfig` is deliberately fail-closed: every operational input is required,
 * and Upbit public market data is off unless NUSA_CLOUD_UPBIT_PUBLIC_DATA is exactly "true".
 * That is the right default for a library and the wrong default for the one command a person
 * runs to use the product -- unconfigured, the runtime exits on the first missing variable,
 * and if it did start it would carry no market data, which leaves the kill switch closed and
 * PAPER trading permanently blocked. This launcher supplies the operational defaults so the
 * product runs, without changing the library's fail-closed behaviour for anything else.
 *
 * Authority is unchanged and non-negotiable here: PAPER only, liveAuthority=NONE,
 * productionMutationAllowed=false. Only Upbit's PUBLIC quotation feed is enabled -- it needs
 * no credentials and grants no execution authority. Any private exchange credential present in
 * the environment is stripped from the child process rather than forwarded.
 */

const CONFIG_DIR = path.join(os.homedir(), ".nusa", "cloud");
const TOKEN_FILE = path.join(CONFIG_DIR, "dashboard-token");
const DEFAULT_PORT = "41731";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PAPER_CAPITAL_KRW = "10000";
const SUPERVISOR_CHILD_ENV = "NUSA_PAPER_RUNTIME_SUPERVISOR_CHILD";
const PRODUCTION_RUNTIME_ENTRYPOINT = "dist/apps/cloud/src/closedLearningProductionRuntime.js";
const SQLITE_INTEGRITY_BOOTSTRAP = "dist/packages/storage/src/sqliteIntegrityBootstrap.js";

/** Environment variables that would hand the runtime real-money authority. Never forwarded. */
const PRIVATE_CREDENTIAL_PATTERN = /(ACCESS|SECRET|PRIVATE|API[_-]?KEY|TOKEN)/i;
const EXCHANGE_PATTERN = /UPBIT|BINANCE|BYBIT|OKX/i;

function stripPrivateExchangeCredentials(source) {
  const env = { ...source };
  const stripped = [];
  for (const key of Object.keys(env)) {
    if (EXCHANGE_PATTERN.test(key) && PRIVATE_CREDENTIAL_PATTERN.test(key)) {
      stripped.push(key);
      delete env[key];
    }
  }
  return { env, stripped: Object.freeze(stripped.sort()) };
}

/**
 * A stable local token, so the phone does not have to be reconfigured on every restart.
 * Written owner-only and kept outside the repository.
 */
function resolveDashboardToken(tokenFile = TOKEN_FILE) {
  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, "utf8").trim();
    if (Buffer.byteLength(existing, "utf8") >= 32) return existing;
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

const isBlank = (value) => value === undefined || value.trim() === "";

const OWNER_PAPER_ACCOUNT_FILE = path.join(__dirname, "..", "deploy", "oracle", "paper-account.json");

/**
 * Owner-decided PAPER account (initial capital), versioned with the release. It is applied over
 * the host environment so the owner's decision reaches the host through a normal release; a
 * malformed file fails closed. Absent file: nothing is applied.
 */
function readOwnerPaperAccount(file = OWNER_PAPER_ACCOUNT_FILE) {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const capital = parsed?.initialCapitalKrw;
  if (parsed?.schemaVersion !== 1 || typeof capital !== "number" || !Number.isFinite(capital) || capital <= 0) {
    throw new Error(`owner PAPER account file is invalid: ${file}`);
  }
  const retired = parsed.retiredAccountIds ?? [];
  if (!Array.isArray(retired) || retired.some((id) => typeof id !== "string" || !/^paper-[a-z0-9_-]{1,64}$/.test(id))) {
    throw new Error(`owner PAPER account file has invalid retiredAccountIds: ${file}`);
  }
  return Object.freeze({ initialCapitalKrw: capital, retiredAccountIds: Object.freeze([...retired]) });
}

const OWNER_PAPER_MARKETS_FILE = path.join(__dirname, "..", "deploy", "oracle", "paper-markets.json");
const MARKET_PATTERN = /^KRW-[A-Z0-9-]+$/;

/**
 * Owner-decided markets for the PAPER feed and the research collection, versioned with the release and applied
 * over the host environment (same mechanism as the PAPER account), so the decision reaches the host through a
 * normal reviewed release. 1-5 distinct KRW markets; a malformed file fails closed. Absent file: nothing applied.
 */
function readOwnerPaperMarkets(file = OWNER_PAPER_MARKETS_FILE) {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const markets = parsed?.markets;
  if (parsed?.schemaVersion !== 1 || !Array.isArray(markets) || markets.length < 1 || markets.length > 5
    || markets.some((m) => typeof m !== "string" || !MARKET_PATTERN.test(m)) || new Set(markets).size !== markets.length) {
    throw new Error(`owner PAPER markets file is invalid: ${file}`);
  }
  return Object.freeze({ markets: Object.freeze([...markets]) });
}

const OWNER_RESEARCH_FILE = path.join(__dirname, "..", "deploy", "oracle", "research-experiments.json");

/**
 * Owner decision whether the continuous research experiments (public 1-minute candle collection and
 * backtest experiments; research evidence only, no orders) run on this server. Versioned with the
 * release and applied over the host environment, like the PAPER account and markets. The runtime keeps
 * its own fail-closed checks (valid build commit, valid settings). A malformed file fails closed at start.
 * Absent file: nothing applied (the host environment decides, default off).
 */
function readOwnerResearch(file = OWNER_RESEARCH_FILE) {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (parsed?.schemaVersion !== 1 || typeof parsed.experiments !== "boolean") throw new Error(`owner research file is invalid: ${file}`);
  const intervals = parsed.intervalMinutes;
  if (intervals !== undefined && (!Array.isArray(intervals) || intervals.length === 0 || intervals.some((value) => ![1, 15, 60, 240].includes(value)) || new Set(intervals).size !== intervals.length)) {
    throw new Error(`owner research file is invalid: ${file}`);
  }
  // Optional K-of-N rolling holdout mode (display-only SHADOW; docs/DESIGN_ROLLING_HOLDOUT_WIRING.md). Only the exact words are accepted.
  const rolling = parsed.rollingHoldout;
  if (rolling !== undefined && rolling !== "OFF" && rolling !== "SHADOW") throw new Error(`owner research file is invalid: ${file}`);
  return Object.freeze({ experiments: parsed.experiments, ...(intervals === undefined ? {} : { intervalMinutes: Object.freeze([...intervals]) }), ...(rolling === undefined ? {} : { rollingHoldout: rolling }) });
}

/** Fills in operational defaults without overriding anything the caller set explicitly. */
function buildRuntimeEnv(baseEnv, token, ownerPaperAccount = readOwnerPaperAccount(), ownerPaperMarkets = readOwnerPaperMarkets(), ownerResearch = readOwnerResearch()) {
  const { env, stripped } = stripPrivateExchangeCredentials(baseEnv);
  // Do not pass NODE_OPTIONS preloads into the production database-owning child. Its trusted
  // SQLite integrity bootstrap must execute before any application module can mutate core APIs.
  delete env.NODE_OPTIONS;
  const defaults = {
    NUSA_MODE: "PAPER",
    NUSA_LIVE_MUTATION: "PROHIBITED",
    NUSA_CLOUD_DASHBOARD_PORT: DEFAULT_PORT,
    NUSA_CLOUD_DASHBOARD_HOST: DEFAULT_HOST,
    NUSA_CLOUD_DASHBOARD_TOKEN: token,
    // Public quotation feed: no credentials, no execution authority. Without this the runtime
    // has no prices, so every PAPER order is blocked as MARKET_DATA_INVALID.
    NUSA_CLOUD_UPBIT_PUBLIC_DATA: "true",
    // Required for the PAPER execution loop to be constructed at all.
    NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW: DEFAULT_PAPER_CAPITAL_KRW,
  };
  const applied = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (isBlank(env[key])) {
      env[key] = value;
      applied.push(key);
    }
  }
  if (ownerPaperAccount != null) {
    const value = String(ownerPaperAccount.initialCapitalKrw);
    if (env.NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW !== value) {
      env.NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW = value;
      if (!applied.includes("NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW")) applied.push("NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW");
    }
    // Owner-retired PAPER accounts are purged once by the runtime (paperAccountRetirement.ts).
    const retired = (ownerPaperAccount.retiredAccountIds ?? []).join(",");
    if (retired && env.NUSA_PAPER_RETIRED_ACCOUNT_IDS !== retired) {
      env.NUSA_PAPER_RETIRED_ACCOUNT_IDS = retired;
      applied.push("NUSA_PAPER_RETIRED_ACCOUNT_IDS");
    }
  }
  if (ownerPaperMarkets != null) {
    const value = ownerPaperMarkets.markets.join(",");
    for (const key of ["NUSA_CLOUD_UPBIT_MARKETS", "NUSA_RESEARCH_MARKETS"]) {
      if (env[key] !== value) {
        env[key] = value;
        if (!applied.includes(key)) applied.push(key);
      }
    }
  }
  if (ownerResearch != null) {
    const value = ownerResearch.experiments ? "1" : "0";
    if (env.NUSA_CLOUD_RESEARCH_EXPERIMENTS !== value) {
      env.NUSA_CLOUD_RESEARCH_EXPERIMENTS = value;
      applied.push("NUSA_CLOUD_RESEARCH_EXPERIMENTS");
    }
    if (ownerResearch.rollingHoldout != null && env.NUSA_RESEARCH_ROLLING_HOLDOUT !== ownerResearch.rollingHoldout) {
      env.NUSA_RESEARCH_ROLLING_HOLDOUT = ownerResearch.rollingHoldout;
      applied.push("NUSA_RESEARCH_ROLLING_HOLDOUT");
    }
    if (ownerResearch.intervalMinutes != null) {
      const intervals = ownerResearch.intervalMinutes.join(",");
      if (env.NUSA_RESEARCH_INTERVAL_MINUTES !== intervals) {
        env.NUSA_RESEARCH_INTERVAL_MINUTES = intervals;
        applied.push("NUSA_RESEARCH_INTERVAL_MINUTES");
      }
    }
  }
  return { env, applied: Object.freeze(applied), stripped };
}

function banner(env, stripped) {
  const endpoint = `http://${env.NUSA_CLOUD_DASHBOARD_HOST}:${env.NUSA_CLOUD_DASHBOARD_PORT}`;
  const lines = [
    "",
    "  NUSA Cloud PAPER runtime",
    `  endpoint   ${endpoint}`,
    "  token      [redacted]",
    `  token file ${TOKEN_FILE}`,
    "",
    "  PAPER only - liveAuthority=NONE, productionMutationAllowed=false",
    "  Upbit PUBLIC quotation feed only - no exchange credentials are used",
  ];
  if (stripped.length > 0) lines.push(`  stripped from child env: ${stripped.join(", ")}`);
  lines.push(
    "",
    "  Android emulator: adb reverse tcp:" + env.NUSA_CLOUD_DASHBOARD_PORT + " tcp:" + env.NUSA_CLOUD_DASHBOARD_PORT,
    "  Then in the app: Settings -> PAPER server -> paste the endpoint above and token from the token file.",
    "",
  );
  return lines.join("\n");
}

/**
 * The writer lease refuses a takeover it cannot prove is safe, which is correct, but on its own it
 * leaves the operator with a stack trace and no stated way forward. Name the recovery instead.
 */
function leaseRecoveryGuidance(stderrTail) {
  const stillActive = /PAPER_WRITER_ALREADY_ACTIVE/.test(stderrTail);
  return [
    "",
    "  The PAPER writer lease blocked startup.",
    stillActive
      ? "  Another NUSA runtime currently holds it. Stop that runtime, or wait for its lease to expire."
      : "  A previous runtime did not shut down cleanly and its lease is too old to take over safely.",
    stillActive ? "" : "  Once nothing is running, clear the abandoned lease with:",
    stillActive ? "" : "    node scripts/reset-paper-writer-lease.js",
    "",
  ].filter((line) => line !== "").join("\n") + "\n";
}

function launcherExitCode(code, signal, stderrTail) {
  if (signal) return 1;
  if (code !== 0 && /PAPER_WRITER_ALREADY_ACTIVE/.test(stderrTail)) return PAPER_WRITER_LEASE_CONFLICT_EXIT_CODE;
  return code ?? 0;
}

/**
 * Automatic, guarded abandoned-lease recovery (#2770).
 *
 * `scripts/reset-paper-writer-lease.js` is deliberately explicit rather than automatic, which is
 * right for a human operator but left the supervised production path with no way forward: the
 * runtime exits PAPER_WRITER_CLOCK_ANOMALY, the supervisor restarts it, and every attempt meets
 * the same stale row until the restart budget is spent and PAPER stays down (Oracle host,
 * 2026-10-17: 295 readiness attempts, all ECONNREFUSED on 41731, then FAILED).
 *
 * This runs the *same* canonical recovery, lazily required to keep the existing module cycle
 * (reset-paper-writer-lease -> start-cloud-runtime) one-directional, with every guard intact:
 *   - refuses while any runtime answers /health on the dashboard endpoint,
 *   - refuses a lease that has not expired yet,
 *   - deletes only the lease row, never account state,
 *   - and only on an exit that already failed with CLOCK_ANOMALY (ALREADY_ACTIVE is skipped, so a
 *     genuinely live writer is never disturbed).
 * acquireLease keeps every predicate it had: it still throws for anything this declines to clear.
 */
async function recoverAbandonedWriterLease(stderrTail, options = {}) {
  if (!/PAPER_WRITER_CLOCK_ANOMALY/.test(stderrTail)) return { status: "SKIPPED" };
  try {
    const { resetPaperWriterLease } = require("./reset-paper-writer-lease.js");
    const write = options.recoveryWrite ?? ((text) => process.stderr.write(`${text}\n`));
    // Resolve the state DB, endpoint, and account through the same env the child was spawned
    // with, so the row we clear is the row the child could not take over.
    const { env, leaseRecovery } = options;
    return await resetPaperWriterLease({
      write,
      ...(env == null ? {} : { env }),
      ...(leaseRecovery ?? {}),
    });
  } catch (error) {
    process.stderr.write(`writer lease recovery skipped: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return { status: "ERROR" };
  }
}

function start(options = {}) {
  const baseEnv = options.env ?? process.env;
  // A deployment may provide the owner-managed token through its protected environment
  // (for example systemd). Do not touch the fallback token file in that case: beyond being
  // unnecessary, a protected HOME can make the launcher fail before the PAPER server listens.
  const configuredToken = baseEnv.NUSA_CLOUD_DASHBOARD_TOKEN;
  const token = configuredToken != null && configuredToken.trim() !== ""
    ? configuredToken
    : (options.resolveToken ?? resolveDashboardToken)();
  const { env, stripped } = buildRuntimeEnv(baseEnv, token);
  const write = options.write ?? ((text) => process.stdout.write(text));
  write(banner(env, stripped));
  const spawnFn = options.spawn ?? spawn;
  const cwd = options.cwd ?? process.cwd();
  const bootstrapPath = path.resolve(cwd, SQLITE_INTEGRITY_BOOTSTRAP);
  const child = spawnFn(process.execPath, ["--require", bootstrapPath, PRODUCTION_RUNTIME_ENTRYPOINT], {
    cwd,
    env,
    stdio: ["ignore", "inherit", "pipe"],
    shell: false,
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderrTail = `${stderrTail}${chunk}`.slice(-4000);
  });
  child.on("exit", async (code, signal) => {
    if (code !== 0 && /PAPER_WRITER_CLOCK_ANOMALY|PAPER_WRITER_ALREADY_ACTIVE/.test(stderrTail)) {
      write(leaseRecoveryGuidance(stderrTail));
      // #2770: name the recovery *and* run it here. The supervisor restarts this launcher on a
      // bounded backoff, so clearing the row once after the failed attempt lets the next start
      // reacquire instead of spending the whole restart budget on the identical stale row.
      const recovered = await recoverAbandonedWriterLease(stderrTail, { ...options, env });
      if (recovered?.status === "CLEARED") {
        write("  Recovered automatically: the abandoned lease row is cleared; the next start reacquires it.\n");
      }
    }
    process.exitCode = launcherExitCode(code, signal, stderrTail);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { if (child.exitCode == null) child.kill(signal); });
  }
  return child;
}

/**
 * Production entrypoint: keep PAPER runtime alive across unexpected process exits while preserving
 * the existing launcher as the supervised child. The child marker prevents recursive supervisors.
 */
function runManaged(options = {}) {
  const baseEnv = options.env ?? process.env;
  if (baseEnv[SUPERVISOR_CHILD_ENV] === "true") return start(options);

  const supervisor = new PaperRuntimeProcessSupervisor({
    cwd: options.cwd ?? process.cwd(),
    env: { ...baseEnv, [SUPERVISOR_CHILD_ENV]: "true" },
    command: process.execPath,
    args: ["scripts/start-cloud-runtime.js"],
    write: options.write,
    spawn: options.spawnSupervisor,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    now: options.now,
    initialBackoffMs: options.initialBackoffMs,
    maxBackoffMs: options.maxBackoffMs,
    writerLeaseRetryMs: options.writerLeaseRetryMs,
    stableWindowMs: options.stableWindowMs,
    maxRestarts: options.maxRestarts,
    maxRestartWindowMs: options.maxRestartWindowMs,
  });
  supervisor.start();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => supervisor.stop(signal));
  }
  return supervisor;
}

if (require.main === module) runManaged();

module.exports = {
  buildRuntimeEnv,
  OWNER_PAPER_ACCOUNT_FILE,
  readOwnerPaperAccount,
  OWNER_PAPER_MARKETS_FILE,
  readOwnerPaperMarkets,
  OWNER_RESEARCH_FILE,
  readOwnerResearch,
  launcherExitCode,
  PRODUCTION_RUNTIME_ENTRYPOINT,
  SQLITE_INTEGRITY_BOOTSTRAP,
  recoverAbandonedWriterLease,
  resolveDashboardToken,
  runManaged,
  start,
  stripPrivateExchangeCredentials,
  SUPERVISOR_CHILD_ENV,
  TOKEN_FILE,
};
