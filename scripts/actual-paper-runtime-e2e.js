const { createHash, randomBytes } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { dirname, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { PaperRuntimeProcessSupervisor } = require("./paper-runtime-supervisor.js");
const { PRODUCTION_RUNTIME_ENTRYPOINT } = require("./start-cloud-runtime.js");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);

function boundedPush(lines, chunk) {
  lines.push(String(chunk));
  while (lines.join("").length > 32_000) lines.shift();
}

async function availablePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

function scrubPrivateExchangeEnv(source) {
  const env = { ...source };
  const removed = [];
  for (const key of Object.keys(env)) {
    if (/UPBIT/i.test(key) && /(ACCESS|SECRET|PRIVATE|API[_-]?KEY|TOKEN)/i.test(key)) {
      removed.push(key);
      delete env[key];
    }
  }
  return { env, removed: Object.freeze(removed.sort()) };
}

function gitRevision(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", shell: false });
  return result.status === 0 ? result.stdout.trim() : "UNKNOWN";
}

function assertBuilt(root) {
  const runtimePath = resolve(root, PRODUCTION_RUNTIME_ENTRYPOINT);
  if (!existsSync(runtimePath)) throw new Error("compiled production Cloud runtime is missing; run `pnpm run build` before the E2E harness");
}

function readPersistedPaperLearningIds(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const rows = database.prepare("SELECT event_id FROM paper_learning_observability_events WHERE schema_version = ? ORDER BY occurred_at DESC, event_id ASC").all(1);
    return Object.freeze(rows.map((row) => String(row.event_id)));
  } finally {
    database.close();
  }
}

function startRuntime(root, env) {
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, [PRODUCTION_RUNTIME_ENTRYPOINT], {
    cwd: root,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => boundedPush(stdout, chunk));
  child.stderr.on("data", (chunk) => boundedPush(stderr, chunk));
  return { child, stdout, stderr };
}

async function stopRuntime(runtime) {
  if (runtime.child.exitCode != null) return;
  runtime.child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolvePromise) => runtime.child.once("exit", () => resolvePromise(true))),
    sleep(10_000).then(() => false),
  ]);
  if (!exited && runtime.child.exitCode == null) {
    runtime.child.kill("SIGKILL");
    await new Promise((resolvePromise) => runtime.child.once("exit", resolvePromise));
  }
}

async function stopSupervisor(supervisor) {
  const child = supervisor.child;
  supervisor.stop("SIGTERM");
  if (child == null || child.exitCode != null) return;
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    sleep(10_000).then(() => false),
  ]);
  if (!exited && child.exitCode == null) {
    child.kill("SIGKILL");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
}

async function waitForHealth(baseUrl, runtime, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode != null) {
      const failureCode = runtimeExitFailureCode(runtime) ?? "RUNTIME_PROCESS_EXITED";
      throw new Error(`cloud runtime exited early (${runtime.child.exitCode}): ${failureCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("cloud runtime health timeout");
}

async function loadOperations(baseUrl, token, timeoutMs = 5_000) {
  try {
    const boundedTimeoutMs = Number.isSafeInteger(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 5_000)) : 5_000;
    const response = await fetch(`${baseUrl}/api/paper-operations`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(boundedTimeoutMs) });
    let body;
    try { body = await response.json(); } catch { body = { error: "NON_JSON_RESPONSE" }; }
    return { httpStatus: response.status, body };
  } catch (error) {
    return {
      httpStatus: 503,
      body: {
        error: "RUNTIME_TRANSIENTLY_UNAVAILABLE",
        failureCode: error?.name === "TimeoutError" || error?.name === "AbortError" ? "RUNTIME_OPERATIONS_TIMEOUT" : "RUNTIME_OPERATIONS_UNAVAILABLE",
      },
    };
  }
}

async function waitForRecoveredRuntime(baseUrl, token, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await loadOperations(baseUrl, token);
    if (last.httpStatus === 200 && last.body?.portfolio?.account != null) return last.body;
    if (last.httpStatus !== 200 && last.httpStatus !== 503) throw new Error(`unexpected PAPER recovery response: ${JSON.stringify(last).slice(0, 2000)}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for persisted PAPER recovery; last=${JSON.stringify(last).slice(0, 2000)}`);
}

async function waitForAutomaticRuntime(baseUrl, token, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await loadOperations(baseUrl, token);
    const snapshot = last.body;
    const heartbeat = snapshot?.operations?.heartbeat;
    const active = last.httpStatus === 200 && snapshot?.operations?.schedulerRunning === true &&
      ["RUNNING", "DEGRADED"].includes(snapshot?.operations?.runtimeState) && heartbeat?.lastHeartbeatAt >= heartbeat?.startedAt;
    if (active && snapshot.markets?.some((item) => item.source === "UPBIT_PUBLIC_TICKER")) return snapshot;
    if (last.httpStatus !== 200 && last.httpStatus !== 503) throw new Error(`unexpected PAPER operations response: ${JSON.stringify(last).slice(0, 2000)}`);
    await sleep(750);
  }
  throw new Error(`timed out waiting for automatic PAPER runtime; last=${JSON.stringify(last).slice(0, 2000)}`);
}

const PAPER_OBSERVATION = Object.freeze({
  minimumDurationMs: 60_000,
  maximumDurationMs: 180_000,
  minimumDecisionCycles: 3,
  pollIntervalMs: 1_000,
  maximumSamples: 200,
  maximumEvents: 5_000,
});
const OBSERVATION_STAGES = Object.freeze(["MARKET_DATA", "SIGNAL", "DECISION", "PERMISSION", "RISK", "ORDER_INTENT", "PAPER_ORDER", "PAPER_FILL", "ACCOUNT", "PNL"]);
const LEARNING_EVENT_STAGES = new Set(["MARKET_DATA", "SIGNAL", "CANDIDATE", "DECISION", "PERMISSION", "RISK", "ORDER_INTENT", "FILL", "PNL", "LEARNING", "HALT", "ERROR", "IDEMPOTENCY", "PERIOD_OPEN", "PERIOD_REALIZED_PERSISTED", "PERIOD_REJECTED"]);
const LOCAL_OPERATIONS_FAILURE_CODES = new Set(["RUNTIME_OPERATIONS_TIMEOUT", "RUNTIME_OPERATIONS_UNAVAILABLE"]);
const PAPER_ORDER_STATUSES = new Set(["OPEN", "PENDING", "FILLED", "CANCELLED", "REJECTED"]);
const SAFE_REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,100}$/;
const SENSITIVE_REASON_CODE_PATTERN = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|EMAIL|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|ACCOUNT[_-]?(?:ID|NUMBER)|WALLET[_-]?ADDRESS|IP[_-]?ADDRESS)/;
// Only locally-owned codes are emitted. Runtime-controlled uppercase strings are not a trust
// boundary: credentials such as UPBIT_ACCESSKEY_ABC123 also satisfy the old token grammar.
const SAFE_WRITER_FAILURE_CODES = new Set([
  "PAPER_WRITER_ALREADY_ACTIVE",
  "PAPER_WRITER_LEASE_CONFLICT",
  "PAPER_WRITER_CLOCK_INVALID",
  "PAPER_WRITER_CLOCK_REGRESSION",
  "PAPER_WRITER_CLOCK_ANOMALY",
  "PAPER_WRITER_LEASE_CORRUPTED",
  "PAPER_WRITER_LEASE_EXPIRED",
  "PAPER_WRITER_LEASE_LOST",
  "PAPER_WRITER_LEASE_OWNER_MISMATCH",
  "PAPER_WRITER_LEASE_RENEWAL_REJECTED",
  "PAPER_WRITER_LEASE_ROW_MISSING",
]);
const SAFE_RUNTIME_FAILURE_CODES = new Set([
  ...SAFE_WRITER_FAILURE_CODES,
  "AUTOMATIC_RUNTIME_STARTUP_FAILED",
  "AUTOMATIC_RUNTIME_STARTUP_TIMEOUT",
  "PAPER_AUTHORITY_INVARIANT_VIOLATION",
  "PAPER_FILL_DUPLICATE_ID_IN_SNAPSHOT",
  "PAPER_FILL_IDENTITY_INVALID",
  "PAPER_FILL_ID_CONFLICT",
  "PAPER_FILL_TIME_INVALID",
  "PAPER_LEARNING_EVENT_IDENTITY_INVALID",
  "PAPER_LEARNING_EVENT_ID_CONFLICT",
  "PAPER_LEARNING_EVENT_INVALID",
  "PAPER_LEARNING_EVENT_TIME_INVALID",
  "PAPER_LEARNING_EVENT_TIME_IN_FUTURE",
  "PAPER_LEARNING_PROJECTION_INVALID",
  "PAPER_MARKET_TRANSPORT_NOT_ONLINE",
  "PAPER_ORDERBOOK_OBSERVATION_REJECTED",
  "PAPER_ORDERBOOK_UNRECONCILED",
  "PAPER_ORDER_DUPLICATE_ID_IN_SNAPSHOT",
  "PAPER_ORDER_IDENTITY_INVALID",
  "PAPER_ORDER_ID_CONFLICT",
  "PAPER_ORDER_MARKET_INVALID",
  "PAPER_ORDER_STATUS_INVALID",
  "PAPER_ORDER_TIME_INVALID",
  "PAPER_PERIOD_EVIDENCE_REJECTED",
  "PAPER_RUNTIME_HEARTBEAT_INVALID",
  "PAPER_RUNTIME_NOT_RUNNING",
  "PUBLIC_ORDERBOOK_SNAPSHOT_UNAVAILABLE",
  "RUNTIME_ERROR_PRESENT",
  "RUNTIME_HEALTH_TIMEOUT",
  "RUNTIME_OPERATIONS_SNAPSHOT_MISSING",
  "RUNTIME_OPERATIONS_TIMEOUT",
  "RUNTIME_OPERATIONS_UNAVAILABLE",
  "RUNTIME_PROCESS_EXITED",
  "RUNTIME_TRANSIENTLY_UNAVAILABLE",
]);
const SAFE_OBSERVATION_REASON_CODES = new Set([
  ...SAFE_WRITER_FAILURE_CODES,
  "ACCOUNT_DAILY_LOSS_LIMIT",
  "APPROVAL_EXPIRED",
  "APPROVAL_MISSING",
  "APPROVAL_SCOPE_MISMATCH",
  "CONSECUTIVE_LOSS_LIMIT",
  "CONFIG_FINGERPRINT_MISMATCH",
  "DAILY_LOSS_LIMIT",
  "DEPLOYMENT_INTEGRITY_FAILED",
  "DUPLICATE_CLIENT_ORDER_ID",
  "DUPLICATE_COMMAND",
  "DUPLICATE_SIGNAL",
  "INSUFFICIENT_CASH",
  "INSUFFICIENT_POSITION",
  "INSUFFICIENT_SMA_OBSERVATIONS",
  "INVALID_REQUEST",
  "KILL_SWITCH_ACTIVE",
  "LIVE_CAPABILITY_DETECTED",
  "MARKET_DATA_GAP",
  "MARKET_DATA_INVALID",
  "MARKET_DATA_OUT_OF_ORDER",
  "MARKET_DATA_RECONNECTING",
  "MARKET_DATA_STALE",
  "MARKET_DATA_WARMING_UP",
  "MAX_DAILY_BUY_NOTIONAL",
  "MAX_DAILY_SELL_NOTIONAL",
  "MAX_ORDER_NOTIONAL",
  "MAX_PORTFOLIO_EXPOSURE",
  "MAX_POSITION_NOTIONAL",
  "MAX_SYMBOL_EXPOSURE",
  "NO_ACTIONABLE_PAPER_DECISION",
  "NO_ACTIONABLE_SIGNAL",
  "NO_CANONICAL_TRADE_PERMISSION_EVIDENCE",
  "NOT_EVALUATED_NO_ACTIONABLE_DECISION",
  "OPEN_ORDER_LIMIT",
  "OPEN_P0_ALERT",
  "ORDER_RATE_LIMIT_PER_MINUTE",
  "ORDER_RATE_LIMIT_PER_SECOND",
  "PAPER_LIMIT_FILLED",
  "PAPER_LIMIT_OPEN",
  "PAPER_LIMIT_PARTIALLY_FILLED",
  "PAPER_STRATEGY_BUDGET_EXHAUSTED",
  "PAPER_STRATEGY_BUDGET_UNEXECUTABLE",
  "PAPER_STRATEGY_FILLED",
  "PAPER_STRATEGY_PARTIALLY_FILLED",
  "PERSISTENCE_UNHEALTHY",
  "PRICE_DEVIATION_LIMIT",
  "PRIVATE_API_CAPABILITY_DETECTED",
  "RECONCILIATION_FAILED",
  "RISK_POLICY_FINGERPRINT_MISMATCH",
  "RUNTIME_FINGERPRINT_MISMATCH",
  "SAME_SIDE_BURST_LIMIT",
  "SESSION_DRAWDOWN_LIMIT",
  "STRATEGY_FINGERPRINT_MISMATCH",
]);

function observationTimestamp(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function isoTimestamp(value) {
  const timestamp = observationTimestamp(value);
  return timestamp == null ? "UNKNOWN" : new Date(timestamp).toISOString();
}

function safeReasonCodes(value) {
  const candidates = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,:;]/) : [];
  return [...new Set(candidates
    .filter((candidate) => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter((candidate) => SAFE_REASON_CODE_PATTERN.test(candidate) && SAFE_OBSERVATION_REASON_CODES.has(candidate) && !SENSITIVE_REASON_CODE_PATTERN.test(candidate)))].slice(0, 16);
}

function safeRuntimeFailureCode(value) {
  if (typeof value !== "string" || value.length === 0) return "RUNTIME_ERROR_PRESENT";
  const writerCode = value.match(/\bPAPER_WRITER_[A-Z_]+\b/);
  if (writerCode && SAFE_WRITER_FAILURE_CODES.has(writerCode[0])) return writerCode[0];
  const code = value.split(/[\s:;,]/, 1)[0];
  return SAFE_RUNTIME_FAILURE_CODES.has(code) && SAFE_REASON_CODE_PATTERN.test(code) && !SENSITIVE_REASON_CODE_PATTERN.test(code) ? code : "RUNTIME_ERROR_PRESENT";
}

function observationSnapshotFailure(response) {
  if (response?.httpStatus !== 200) {
    const failureCode = response?.body?.failureCode;
    if (typeof failureCode === "string" && LOCAL_OPERATIONS_FAILURE_CODES.has(failureCode)) return failureCode;
    if (response?.body?.error === "RUNTIME_TRANSIENTLY_UNAVAILABLE") return "RUNTIME_TRANSIENTLY_UNAVAILABLE";
    return "RUNTIME_OPERATIONS_UNAVAILABLE";
  }
  const snapshot = response.body;
  if (snapshot == null || typeof snapshot !== "object") return "RUNTIME_OPERATIONS_SNAPSHOT_MISSING";
  if (snapshot.mode !== "PAPER" || snapshot.liveAuthority !== "NONE" || snapshot.productionMutationAllowed !== false) return "PAPER_AUTHORITY_INVARIANT_VIOLATION";
  const learning = snapshot.paperLearning;
  if (learning == null || learning.mode !== "PAPER" || learning.readOnly !== true || learning.liveAuthority !== "NONE" || learning.productionMutationAllowed !== false || !Array.isArray(learning.events)) return "PAPER_LEARNING_PROJECTION_INVALID";
  const operations = snapshot.operations;
  if (operations?.runtimeState !== "RUNNING" || operations?.schedulerRunning !== true) return "PAPER_RUNTIME_NOT_RUNNING";
  if (operations.transport !== "ONLINE") return "PAPER_MARKET_TRANSPORT_NOT_ONLINE";
  const heartbeat = operations.heartbeat;
  if (heartbeat == null || !Number.isSafeInteger(heartbeat.startedAt) || !Number.isSafeInteger(heartbeat.lastHeartbeatAt) || heartbeat.lastHeartbeatAt < heartbeat.startedAt) return "PAPER_RUNTIME_HEARTBEAT_INVALID";
  const lastError = heartbeat.lastError;
  if (typeof lastError === "string" && lastError.trim() !== "") return safeRuntimeFailureCode(lastError);
  return null;
}

function accountProjectionChanged(before, after) {
  const left = before?.portfolio?.account;
  const right = after?.portfolio?.account;
  if (left == null || right == null) return false;
  const numericPairs = [
    [left.cash, right.cash],
    [left.equity, right.equity],
    [left.realizedPnl, right.realizedPnl],
    [left.unrealizedPnl, right.unrealizedPnl],
    [left.position?.quantity, right.position?.quantity],
  ];
  return numericPairs.some(([a, b]) => typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b) && a !== b);
}

function runtimeExitFailureCode(runtime) {
  if (runtime?.child?.exitCode == null) return null;
  const stderr = Array.isArray(runtime.stderr) ? runtime.stderr.join("") : "";
  return safeRuntimeFailureCode(stderr || "RUNTIME_PROCESS_EXITED");
}

async function observeAutomaticRuntime({
  readSnapshot,
  initialSnapshot,
  checkRuntimeFailure = () => null,
  minimumDurationMs = PAPER_OBSERVATION.minimumDurationMs,
  maximumDurationMs = PAPER_OBSERVATION.maximumDurationMs,
  minimumDecisionCycles = PAPER_OBSERVATION.minimumDecisionCycles,
  pollIntervalMs = PAPER_OBSERVATION.pollIntervalMs,
  now = () => performance.now(),
  wallNow = () => Date.now(),
  delay = sleep,
}) {
  if (typeof readSnapshot !== "function") throw new Error("PAPER observation requires a read-only snapshot reader");
  if (!Number.isSafeInteger(minimumDurationMs) || minimumDurationMs < 1_000 || !Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < minimumDurationMs || maximumDurationMs > PAPER_OBSERVATION.maximumDurationMs) throw new Error("PAPER observation duration is invalid or unbounded");
  if (!Number.isSafeInteger(minimumDecisionCycles) || minimumDecisionCycles < 1 || minimumDecisionCycles > 256) throw new Error("PAPER observation Decision-cycle count is invalid");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 10_000) throw new Error("PAPER observation poll interval is invalid");

  const startedMonotonic = now();
  const startedAtMs = wallNow();
  const startedAt = new Date(startedAtMs).toISOString();
  const samples = [];
  const eventsById = new Map();
  const cyclesById = new Map();
  const ordersById = new Map();
  const fillsById = new Map();
  const stageCounts = Object.fromEntries(OBSERVATION_STAGES.map((stage) => [stage, 0]));
  const accountObservationTimes = [];
  let eventEvidenceTruncated = false;
  let finalSnapshot = initialSnapshot ?? null;
  let failureCode = null;
  let stopReason = "MAX_OBSERVATION_BUDGET_EXHAUSTED";

  const appendSample = (sample) => {
    if (samples.length < PAPER_OBSERVATION.maximumSamples) samples.push(sample);
  };

  const collectSnapshot = (snapshot, observedAtMs) => {
    const learningEvents = snapshot.paperLearning.events;
    if (learningEvents.length >= 250) eventEvidenceTruncated = true;
    for (const event of learningEvents) {
      if (event == null || typeof event !== "object") return "PAPER_LEARNING_EVENT_INVALID";
      const occurredAt = observationTimestamp(event.occurredAt);
      if (occurredAt == null) return "PAPER_LEARNING_EVENT_TIME_INVALID";
      if (occurredAt < startedAtMs) continue;
      if (occurredAt > observedAtMs + 60_000) return "PAPER_LEARNING_EVENT_TIME_IN_FUTURE";
      if (typeof event.id !== "string" || event.id.length === 0 || event.id.length > 256 || typeof event.cycleId !== "string" || event.cycleId.length === 0 || event.cycleId.length > 256 || typeof event.stage !== "string" || !LEARNING_EVENT_STAGES.has(event.stage) || !["PASS", "SKIP", "FAIL"].includes(event.status)) return "PAPER_LEARNING_EVENT_IDENTITY_INVALID";
      const eventSignature = sha256(canonical({ cycleId: event.cycleId, stage: event.stage, occurredAt, status: event.status, market: event.market, reason: event.reason, riskReason: event.risk?.reason, decisionAction: event.decision?.action, signalAction: event.signal?.action, riskStatus: event.risk?.status, fill: event.fill, account: event.account }));
      const existing = eventsById.get(event.id);
      if (existing != null) {
        if (existing.signature !== eventSignature) return "PAPER_LEARNING_EVENT_ID_CONFLICT";
        continue;
      }
      if (eventsById.size >= PAPER_OBSERVATION.maximumEvents) {
        eventEvidenceTruncated = true;
        continue;
      }
      const stage = event.stage === "FILL" ? "PAPER_FILL" : OBSERVATION_STAGES.includes(event.stage) ? event.stage : "UNKNOWN";
      const market = typeof event.market === "string" && /^[A-Z0-9-]{1,20}$/.test(event.market) ? event.market : "UNKNOWN";
      const reasonCodes = safeReasonCodes(event.reason ?? event.risk?.reason);
      const item = {
        event_ref_sha256: sha256(event.id),
        cycle_ref_sha256: sha256(event.cycleId),
        stage,
        market,
        occurred_at: isoTimestamp(occurredAt),
        observed_at: new Date(observedAtMs).toISOString(),
        status: event.status,
        reason_codes: reasonCodes,
        ...(event.stage === "DECISION" && ["BUY", "SELL", "HOLD", "WAIT", "REDUCE", "INCREASE"].includes(event.decision?.action) ? { decision_action: event.decision.action } : {}),
      };
      eventsById.set(event.id, { signature: eventSignature, item });
      if (stageCounts[stage] != null) stageCounts[stage] += 1;
      let cycle = cyclesById.get(event.cycleId);
      if (cycle == null) {
        cycle = { cycle_ref_sha256: sha256(event.cycleId), stages: {} };
        cyclesById.set(event.cycleId, cycle);
      }
      cycle.stages[stage] = { occurred_at: item.occurred_at, status: item.status, reason_codes: item.reason_codes };
      if (event.stage === "DECISION") cycle.decision = { occurred_at: item.occurred_at, status: item.status, ...(item.decision_action ? { action: item.decision_action } : {}), reason_codes: item.reason_codes };
      if ((event.stage === "ERROR" || event.stage === "HALT") && event.status === "FAIL") return safeRuntimeFailureCode(event.reason ?? event.risk?.reason);
    }

    const account = snapshot.portfolio?.account;
    if (account != null && typeof account === "object") {
      stageCounts.ACCOUNT += 1;
      accountObservationTimes.push(new Date(observedAtMs).toISOString());
    }
    const orderIdsInSnapshot = new Set();
    const fillIdsInSnapshot = new Set();
    for (const order of Array.isArray(snapshot.orders) ? snapshot.orders : []) {
      if (typeof order?.id !== "string" || order.id.length === 0) return "PAPER_ORDER_IDENTITY_INVALID";
      if (!PAPER_ORDER_STATUSES.has(order.status)) return "PAPER_ORDER_STATUS_INVALID";
      if (typeof order.market !== "string" || !/^[A-Z0-9-]{1,20}$/.test(order.market)) return "PAPER_ORDER_MARKET_INVALID";
      if (observationTimestamp(order.filledAt) == null) return "PAPER_ORDER_TIME_INVALID";
      if (orderIdsInSnapshot.has(order.id)) return "PAPER_ORDER_DUPLICATE_ID_IN_SNAPSHOT";
      orderIdsInSnapshot.add(order.id);
      const ref = sha256(order.id);
      const orderSignature = sha256(canonical({ market: order.market, side: order.side, status: order.status, quantity: order.quantity, price: order.price, fee: order.fee, filledAt: order.filledAt }));
      const existingOrder = ordersById.get(ref);
      if (existingOrder != null && existingOrder.signature !== orderSignature) return "PAPER_ORDER_ID_CONFLICT";
      if (existingOrder == null) {
        ordersById.set(ref, { signature: orderSignature, item: {
          event_ref_sha256: ref,
          stage: "PAPER_ORDER",
          market: order.market,
          occurred_at: "UNKNOWN",
          observed_at: new Date(observedAtMs).toISOString(),
          status: order.status,
          reason_codes: [],
        } });
        stageCounts.PAPER_ORDER += 1;
      }
      for (const fill of Array.isArray(order.fills) ? order.fills : []) {
        if (typeof fill?.id !== "string" || fill.id.length === 0) return "PAPER_FILL_IDENTITY_INVALID";
        if (observationTimestamp(fill.filledAt) == null) return "PAPER_FILL_TIME_INVALID";
        if (fillIdsInSnapshot.has(fill.id)) return "PAPER_FILL_DUPLICATE_ID_IN_SNAPSHOT";
        fillIdsInSnapshot.add(fill.id);
        const fillRef = sha256(fill.id);
        const fillSignature = sha256(canonical({ orderId: order.id, market: order.market, quantity: fill.quantity, price: fill.price, filledAt: fill.filledAt }));
        const existingFill = fillsById.get(fillRef);
        if (existingFill != null && existingFill.signature !== fillSignature) return "PAPER_FILL_ID_CONFLICT";
        if (existingFill == null) {
          fillsById.set(fillRef, { signature: fillSignature, item: {
            event_ref_sha256: fillRef,
            stage: "PAPER_FILL",
            market: order.market,
            occurred_at: isoTimestamp(fill.filledAt),
            observed_at: new Date(observedAtMs).toISOString(),
            status: "PASS",
            reason_codes: [],
          } });
          stageCounts.PAPER_FILL += 1;
        }
      }
    }
    return null;
  };

  while (true) {
    const elapsedBeforeRead = Math.max(0, now() - startedMonotonic);
    if (elapsedBeforeRead >= maximumDurationMs) {
      stopReason = "MAX_OBSERVATION_BUDGET_EXHAUSTED";
      break;
    }
    const processFailure = checkRuntimeFailure();
    if (processFailure) {
      failureCode = safeRuntimeFailureCode(processFailure);
      stopReason = "RUNTIME_FAILURE";
      break;
    }
    const timeoutMs = Math.max(1, Math.min(5_000, maximumDurationMs - elapsedBeforeRead));
    const response = await readSnapshot(timeoutMs);
    const observedAtMs = wallNow();
    const elapsedMs = Math.max(0, now() - startedMonotonic);
    appendSample({ observed_at: new Date(observedAtMs).toISOString(), elapsed_ms: Math.round(elapsedMs), http_status: Number.isSafeInteger(response?.httpStatus) ? response.httpStatus : null });
    if (elapsedMs > maximumDurationMs) {
      if (response?.httpStatus !== 200) failureCode = observationSnapshotFailure(response);
      stopReason = "MAX_OBSERVATION_BUDGET_EXHAUSTED";
      break;
    }
    if (response?.httpStatus === 200 && response.body != null && typeof response.body === "object") finalSnapshot = response.body;
    if (response?.httpStatus !== 200) {
      failureCode = observationSnapshotFailure(response);
      stopReason = "RUNTIME_READ_FAILURE";
      break;
    }
    const snapshotFailure = observationSnapshotFailure(response);
    const collectionFailure = Array.isArray(response.body?.paperLearning?.events) ? collectSnapshot(response.body, observedAtMs) : null;
    failureCode = snapshotFailure ?? collectionFailure;
    if (failureCode != null) {
      stopReason = "RUNTIME_OR_EVIDENCE_FAILURE";
      break;
    }
    const exited = checkRuntimeFailure();
    if (exited) {
      failureCode = safeRuntimeFailureCode(exited);
      stopReason = "RUNTIME_FAILURE";
      break;
    }
    const decisionCycleCount = [...cyclesById.values()].filter((cycle) => cycle.decision != null).length;
    if (elapsedMs >= minimumDurationMs && decisionCycleCount >= minimumDecisionCycles) {
      stopReason = "MINIMUM_DURATION_AND_DECISION_CYCLES_REACHED";
      break;
    }
    if (elapsedMs >= maximumDurationMs) {
      stopReason = "MAX_OBSERVATION_BUDGET_EXHAUSTED";
      break;
    }
    await delay(Math.max(1, Math.min(pollIntervalMs, maximumDurationMs - elapsedMs)));
  }

  const endedAtMs = wallNow();
  const elapsedMs = Math.round(Math.max(0, now() - startedMonotonic));
  const decisionCycles = [...cyclesById.values()]
    .filter((cycle) => cycle.decision != null)
    .sort((left, right) => left.decision.occurred_at.localeCompare(right.decision.occurred_at) || left.cycle_ref_sha256.localeCompare(right.cycle_ref_sha256));
  const decisionCycleCount = decisionCycles.length;
  const failedRiskEvents = [...eventsById.values()].map((entry) => entry.item).filter((event) => event.stage === "RISK" && event.status === "FAIL");
  const timeline = [
    ...[...eventsById.values()].map((entry) => entry.item),
    ...[...ordersById.values()].map((entry) => entry.item),
    ...[...fillsById.values()].map((entry) => entry.item),
  ].sort((left, right) => {
    if (left.occurred_at === "UNKNOWN" && right.occurred_at !== "UNKNOWN") return 1;
    if (right.occurred_at === "UNKNOWN" && left.occurred_at !== "UNKNOWN") return -1;
    return left.occurred_at.localeCompare(right.occurred_at) || left.stage.localeCompare(right.stage) || left.event_ref_sha256.localeCompare(right.event_ref_sha256);
  });
  const stageEvidence = Object.fromEntries(OBSERVATION_STAGES.map((stage) => [stage, {
    status: stageCounts[stage] > 0 ? "OBSERVED" : "NOT_OBSERVED",
    event_count: stage === "ACCOUNT" ? 0 : stageCounts[stage],
    ...(stage === "ACCOUNT" ? { observation_count: stageCounts[stage] } : {}),
    reason_codes: [...new Set(timeline.filter((event) => event.stage === stage).flatMap((event) => event.reason_codes))].slice(0, 32),
  }]));
  stageEvidence.ACCOUNT = {
    ...stageEvidence.ACCOUNT,
    ...(accountObservationTimes.length === 0 ? {} : { first_observed_at: accountObservationTimes[0], last_observed_at: accountObservationTimes.at(-1) }),
    account_change_observed: accountProjectionChanged(initialSnapshot, finalSnapshot),
  };
  const observationStatus = failureCode != null ? "FAIL" : stopReason === "MINIMUM_DURATION_AND_DECISION_CYCLES_REACHED" && !eventEvidenceTruncated ? "PASS" : "INCOMPLETE";
  const evidence = {
    status: observationStatus,
    started_at: startedAt,
    ended_at: new Date(endedAtMs).toISOString(),
    elapsed_ms: elapsedMs,
    minimum_duration_ms: minimumDurationMs,
    maximum_budget_ms: maximumDurationMs,
    minimum_decision_cycles: minimumDecisionCycles,
    decision_cycles_observed: decisionCycleCount,
    samples: samples.length,
    poll_interval_ms: pollIntervalMs,
    stop_reason: eventEvidenceTruncated && failureCode == null ? "EVENT_EVIDENCE_TRUNCATED" : stopReason,
    ...(failureCode == null ? {} : { failure_code: failureCode }),
    event_evidence_truncated: eventEvidenceTruncated,
    stage_evidence: stageEvidence,
    decision_cycles: decisionCycles,
    timeline,
    risk_rejections: failedRiskEvents.map((event) => ({ occurred_at: event.occurred_at, cycle_ref_sha256: event.cycle_ref_sha256, reason_codes: event.reason_codes })),
  };
  return { status: observationStatus, evidence, finalSnapshot, failureCode };
}

function startupFailureCode(error, runtime) {
  const processFailure = runtimeExitFailureCode(runtime);
  if (processFailure != null) return processFailure;
  const message = error instanceof Error ? error.message : "";
  if (message === "cloud runtime health timeout") return "RUNTIME_HEALTH_TIMEOUT";
  if (message.startsWith("timed out waiting for automatic PAPER runtime")) return "AUTOMATIC_RUNTIME_STARTUP_TIMEOUT";
  if (message.startsWith("cloud runtime exited early")) return "RUNTIME_PROCESS_EXITED";
  return "AUTOMATIC_RUNTIME_STARTUP_FAILED";
}

function writeEvidence(outputPath, payload) {
  const evidence = { ...payload, artifact_hash: { algorithm: "sha256", value: sha256(canonical(payload)) } };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}

function failedStartupEvidence({ root, market, scrubbedPrivateKeys, startedAt, failureCode }) {
  const completedAt = new Date().toISOString();
  return {
    schema_version: 1,
    evidence_type: "nusa.actual-paper-runtime-e2e",
    result: "FAIL",
    source_commit: gitRevision(root),
    started_at: startedAt,
    completed_at: completedAt,
    authority: { mode: "PAPER_ONLY", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" },
    market_data: { provider: "UPBIT", channel: "PUBLIC_TICKER", market, private_credentials_used: false, scrubbed_private_env_key_count: scrubbedPrivateKeys.length },
    execution: { status: "NOT_OBSERVED", order_count: 0, fill_count: 0 },
    runtime_observation: { status: "FAIL", started_at: startedAt, ended_at: completedAt, elapsed_ms: null, stop_reason: "STARTUP_FAILURE", failure_code: safeRuntimeFailureCode(failureCode), stage_evidence: Object.fromEntries(OBSERVATION_STAGES.map((stage) => [stage, { status: "UNKNOWN", event_count: 0, reason_codes: [] }])), decision_cycles: [], timeline: [] },
    prohibited_capabilities: { upbit_private_credentials: false, live_order_endpoint: false, withdrawal_transfer: false, real_money_mutation: false },
  };
}

async function waitForHeartbeatAdvance(baseUrl, token, baselineEventCount, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await loadOperations(baseUrl, token);
    const heartbeat = last.body?.operations?.heartbeat;
    if (last.httpStatus === 200 && heartbeat?.eventCount > baselineEventCount && heartbeat?.lastMarketEventAt != null) return last.body;
    if (last.httpStatus !== 200 && last.httpStatus !== 503) throw new Error(`unexpected PAPER liveness response: ${JSON.stringify(last).slice(0, 2000)}`);
    await sleep(500);
  }
  throw new Error(`timed out waiting for a second supervised PAPER market cycle; last=${JSON.stringify(last).slice(0, 2000)}`);
}

function summarizeSnapshot(snapshot) {
  const account = snapshot?.portfolio?.account;
  return {
    generatedAt: snapshot?.generatedAt,
    mode: snapshot?.mode,
    health: snapshot?.health,
    readyForPaperOperations: snapshot?.readyForPaperOperations,
    transport: snapshot?.operations?.transport,
    runtimeState: snapshot?.operations?.runtimeState,
    schedulerRunning: snapshot?.operations?.schedulerRunning,
    schedulerMode: snapshot?.operations?.schedulerMode,
    heartbeat: snapshot?.operations?.heartbeat,
    supervisor: snapshot?.operations?.supervisor,
    markets: Array.isArray(snapshot?.markets) ? snapshot.markets.map((market) => ({ market: market.market, source: market.source, price: market.price, observedAt: market.observedAt })) : [],
    orderCount: Array.isArray(snapshot?.orders) ? snapshot.orders.length : 0,
    cash: account?.cash,
    equity: account?.equity,
    realizedPnl: account?.realizedPnl,
    unrealizedPnl: account?.unrealizedPnl,
    position: account?.position ? {
      market: account.position.market,
      quantity: account.position.quantity,
      averagePrice: account.position.averagePrice,
      realizedPnl: account.position.realizedPnl,
      unrealizedPnl: account.position.unrealizedPnl,
    } : null,
    liveAuthority: snapshot?.liveAuthority,
    productionMutationAllowed: snapshot?.productionMutationAllowed,
  };
}

function paperChaosStateFromSnapshot(snapshot, observedAt) {
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("PAPER chaos observation time is invalid");
  if (snapshot?.operations?.runtimeState !== "RUNNING" || snapshot?.operations?.transport !== "ONLINE") {
    throw new Error("PAPER chaos receipt requires a running online PAPER runtime");
  }
  const orders = Array.isArray(snapshot?.orders) ? snapshot.orders : [];
  const orderIds = orders.map((order) => String(order?.id || "")).sort();
  const fillIds = orders.flatMap((order) => Array.isArray(order?.fills) ? order.fills.map((fill) => String(fill?.id || "")) : []).sort();
  if (orderIds.some((id) => id.length === 0) || fillIds.some((id) => id.length === 0) || new Set(orderIds).size !== orderIds.length || new Set(fillIds).size !== fillIds.length) {
    throw new Error("PAPER chaos receipt cannot use missing or duplicate order/fill identity");
  }
  return Object.freeze({
    runtimeStatus: "RUNNING",
    persistenceStatus: "AVAILABLE",
    upstreamStatus: "HEALTHY",
    chronologyStatus: "UNKNOWN",
    reconciliationStatus: "UNKNOWN",
    orderIds,
    fillIds,
    observedAt,
  });
}

function snapshotObservedAt(snapshot) {
  const value = snapshot?.generatedAt;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  throw new Error("PAPER chaos receipt requires a valid runtime observation timestamp");
}

function buildBoundPaperChaosRestartEvidence(root, beforeSnapshot, afterSnapshot) {
  const { buildPaperChaosRecoveryReceipt } = require(resolve(root, "dist/apps/cloud/src/paperChaosRecovery.js"));
  const before = paperChaosStateFromSnapshot(beforeSnapshot, snapshotObservedAt(beforeSnapshot));
  const after = paperChaosStateFromSnapshot(afterSnapshot, snapshotObservedAt(afterSnapshot));
  if (after.observedAt < before.observedAt) throw new Error("PAPER chaos receipt chronology regressed");
  const receipt = buildPaperChaosRecoveryReceipt({
    schemaVersion: 1,
    drillId: "actual-paper-runtime-supervisor-restart",
    scenario: "PROCESS_RESTART",
    triggerObserved: true,
    before,
    after,
  });
  if (receipt.status !== "PASS") throw new Error("PAPER chaos restart receipt failed closed");
  return Object.freeze({ verificationStatus: "BOUND_UNVERIFIED", receipt });
}

async function run(options = {}) {
  const root = resolve(options.root || process.cwd());
  const outputPath = resolve(root, options.outputPath || "artifacts/operational-evidence/actual-paper-runtime-e2e.json");
  const workingDir = resolve(root, options.workingDir || ".runtime-evidence/wo-0059");
  const databasePath = resolve(workingDir, "state.sqlite");
  const market = String(options.market || process.env.NUSA_E2E_MARKET || "KRW-BTC").trim().toUpperCase();
  if (!/^KRW-[A-Z0-9-]+$/.test(market)) throw new Error("invalid E2E market");

  assertBuilt(root);
  rmSync(workingDir, { recursive: true, force: true });
  mkdirSync(workingDir, { recursive: true });

  const token = randomBytes(32).toString("hex");
  const idempotencyKey = `wo0059:${Date.now()}:${randomBytes(8).toString("hex")}`;
  void idempotencyKey;
  const port = await availablePort();
  const sourceCommit = gitRevision(root);
  const researchReplaySnapshotPath = resolve(workingDir, "research-replay-snapshots.json");
  const qualifiedArtifactPath = resolve(workingDir, "qualified-paper-challengers.json");
  const { env: cleanBaseEnv, removed: scrubbedPrivateKeys } = scrubPrivateExchangeEnv(process.env);
  const env = {
    ...cleanBaseEnv,
    NUSA_MODE: "PAPER",
    NUSA_LIVE_MUTATION: "PROHIBITED",
    NUSA_CLOUD_DASHBOARD_PORT: String(port),
    NUSA_CLOUD_DASHBOARD_HOST: "127.0.0.1",
    NUSA_CLOUD_DASHBOARD_TOKEN: token,
    NUSA_CLOUD_UPBIT_PUBLIC_DATA: "true",
    NUSA_CLOUD_UPBIT_MARKETS: market,
    NUSA_CLOUD_STATE_DB_PATH: databasePath,
    NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW: "10000000",
    NUSA_CLOUD_PAPER_INVESTMENT_PERCENT: "10",
    NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH: researchReplaySnapshotPath,
    NUSA_QUALIFIED_PAPER_CHALLENGER_ARTIFACT_PATH: qualifiedArtifactPath,
    NUSA_SOURCE_COMMIT: sourceCommit,
    NUSA_SOURCE_COMMIT_SHA: sourceCommit,
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  let firstRuntime;
  let secondRuntime;
  let supervisor;
  const startedAt = new Date().toISOString();
  try {
    firstRuntime = startRuntime(root, env);
    let startupSnapshot;
    try {
      await waitForHealth(baseUrl, firstRuntime);
      startupSnapshot = await waitForAutomaticRuntime(baseUrl, token);
    } catch (error) {
      return writeEvidence(outputPath, failedStartupEvidence({ root, market, scrubbedPrivateKeys, startedAt, failureCode: startupFailureCode(error, firstRuntime) }));
    }
    const observation = await observeAutomaticRuntime({
      initialSnapshot: startupSnapshot,
      readSnapshot: (timeoutMs) => loadOperations(baseUrl, token, timeoutMs),
      checkRuntimeFailure: () => runtimeExitFailureCode(firstRuntime),
    });
    if (observation.status === "FAIL") {
      return writeEvidence(outputPath, {
        schema_version: 1,
        evidence_type: "nusa.actual-paper-runtime-e2e",
        result: "FAIL",
        source_commit: sourceCommit,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        authority: { mode: "PAPER_ONLY", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" },
        runtime_composition: { entrypoint: PRODUCTION_RUNTIME_ENTRYPOINT, closed_learning_production_root: true, isolated_research_snapshot_path: researchReplaySnapshotPath, isolated_qualified_challenger_path: qualifiedArtifactPath },
        market_data: { provider: "UPBIT", channel: "PUBLIC_TICKER", market, private_credentials_used: false, scrubbed_private_env_key_count: scrubbedPrivateKeys.length },
        execution: { status: "NOT_OBSERVED", order_count: 0, fill_count: 0 },
        runtime_observation: observation.evidence,
        prohibited_capabilities: { upbit_private_credentials: false, live_order_endpoint: false, withdrawal_transfer: false, real_money_mutation: false },
      });
    }
    const firstSnapshot = observation.finalSnapshot;
    if (firstSnapshot.liveAuthority !== "NONE" || firstSnapshot.productionMutationAllowed !== false) throw new Error("automatic PAPER snapshot violated authority invariant");
    const firstSummary = summarizeSnapshot(firstSnapshot);
    if (!firstSummary.markets.some((item) => item.market === market && item.source === "UPBIT_PUBLIC_TICKER")) throw new Error("live Upbit PUBLIC ticker evidence missing from PAPER snapshot");
    if (firstSummary.heartbeat?.eventCount < 1 || firstSummary.heartbeat?.decisionCount < 1) throw new Error("automatic PAPER decision heartbeat evidence missing");
    const observedOrders = Array.isArray(firstSnapshot.orders) ? firstSnapshot.orders : [];
    const observedFills = observedOrders.flatMap((order) => Array.isArray(order.fills) ? order.fills : []);
    const firstOrder = observedOrders[0];
    const firstFill = firstOrder?.fills?.[0];

    if (firstSnapshot.paperLearning == null) throw new Error("paperLearning projection missing from automatic PAPER snapshot");
    if (firstSnapshot.paperLearning.liveAuthority !== "NONE" || firstSnapshot.paperLearning.productionMutationAllowed !== false || firstSnapshot.paperLearning.readOnly !== true) throw new Error("paperLearning projection violated a read-only/authority invariant");
    const firstLearningStages = new Set((firstSnapshot.paperLearning.events || []).map((event) => event.stage));
    if (!firstLearningStages.has("MARKET_DATA") || !firstLearningStages.has("DECISION")) throw new Error(`paperLearning did not expose the required MARKET_DATA -> DECISION chain (stages seen: ${[...firstLearningStages].join(",") || "none"})`);
    const firstLearningIds = (firstSnapshot.paperLearning.events || []).map((event) => event.id);
    if (new Set(firstLearningIds).size !== firstLearningIds.length) throw new Error("paperLearning exposed duplicate event ids before any restart");

    await stopRuntime(firstRuntime);
    firstRuntime = undefined;
    if (!existsSync(databasePath) || statSync(databasePath).size <= 0) throw new Error("SQLite PAPER state database was not persisted");
    const persistedLearningIds = readPersistedPaperLearningIds(databasePath);
    if (persistedLearningIds.length < 1) throw new Error("paperLearning did not persist any event before restart");
    if (new Set(persistedLearningIds).size !== persistedLearningIds.length) throw new Error("paperLearning persistence contained duplicate event ids before restart");
    const dbHashAfterRuntime = sha256(readFileSync(databasePath));

    secondRuntime = startRuntime(root, { ...env, NUSA_CLOUD_UPBIT_PUBLIC_DATA: "false" });
    await waitForHealth(baseUrl, secondRuntime);
    const recoverySnapshot = await waitForRecoveredRuntime(baseUrl, token);
    if (recoverySnapshot.liveAuthority !== "NONE" || recoverySnapshot.productionMutationAllowed !== false) throw new Error("restart PAPER recovery snapshot violated authority invariant");
    const recoverySummary = summarizeSnapshot(recoverySnapshot);
    if (firstSummary.position?.quantity !== recoverySummary.position?.quantity) throw new Error("PAPER position did not recover identically after restart");
    if (recoverySnapshot.paperLearning == null) throw new Error("paperLearning projection missing after restart recovery");
    const recoveredLearningIds = (recoverySnapshot.paperLearning.events || []).map((event) => event.id);
    if (recoveredLearningIds.length < 1) throw new Error("paperLearning did not durably replay any event after restart");
    if (new Set(recoveredLearningIds).size !== recoveredLearningIds.length) throw new Error("paperLearning replay produced duplicate event ids after restart");
    if (recoveredLearningIds.length !== persistedLearningIds.length || recoveredLearningIds.some((id, index) => id !== persistedLearningIds[index])) throw new Error("paperLearning replay after restart did not reproduce the exact persisted event window");

    await stopRuntime(secondRuntime);
    secondRuntime = undefined;

    secondRuntime = startRuntime(root, env);
    await waitForHealth(baseUrl, secondRuntime);
    const secondSnapshot = await waitForAutomaticRuntime(baseUrl, token);
    if (secondSnapshot.liveAuthority !== "NONE" || secondSnapshot.productionMutationAllowed !== false) throw new Error("restart PAPER snapshot violated authority invariant");
    const secondSummary = summarizeSnapshot(secondSnapshot);
    const repeatedOrders = firstOrder == null ? [] : secondSnapshot.orders.filter((order) => order.id === firstOrder.id);
    const repeatedFills = repeatedOrders.flatMap((order) => order.fills || []);
    if (firstOrder != null && (repeatedOrders.length !== 1 || repeatedFills.length !== 1)) throw new Error("restart created a duplicate PAPER order/fill");
    await stopRuntime(secondRuntime);
    secondRuntime = undefined;

    supervisor = new PaperRuntimeProcessSupervisor({
      command: process.execPath,
      args: [PRODUCTION_RUNTIME_ENTRYPOINT],
      cwd: root,
      env,
      stableWindowMs: 60_000,
      write: () => {},
    });
    supervisor.start();
    const supervisedStart = await waitForAutomaticRuntime(baseUrl, token);
    const initialSupervisorProjection = supervisedStart.operations?.supervisor;
    if (initialSupervisorProjection?.managed !== true || initialSupervisorProjection.restartCount !== 0 || initialSupervisorProjection.liveAuthority !== "NONE" || initialSupervisorProjection.productionMutationAllowed !== false || initialSupervisorProjection.aiAuthority !== "ZERO_AUTHORITY") throw new Error("PAPER supervisor projection missing or violated authority invariant");
    const baselineEventCount = supervisedStart.operations.heartbeat?.eventCount ?? 0;
    const secondCycleSnapshot = await waitForHeartbeatAdvance(baseUrl, token, baselineEventCount);
    if ((secondCycleSnapshot.operations.heartbeat?.eventCount ?? 0) <= baselineEventCount) throw new Error("PAPER supervisor did not prove multi-cycle liveness");

    const crashedChild = supervisor.child;
    if (crashedChild == null) throw new Error("PAPER supervisor child unavailable for recovery evidence");
    crashedChild.kill("SIGKILL");
    const recoveryDeadline = Date.now() + 30_000;
    while (Date.now() < recoveryDeadline && supervisor.snapshot().restartCount < 1) await sleep(50);
    if (supervisor.snapshot().restartCount < 1) throw new Error("PAPER supervisor did not schedule recovery after child failure");
    const supervisedRecovery = await waitForAutomaticRuntime(baseUrl, token);
    const recoveryProjection = supervisedRecovery.operations?.supervisor;
    if (recoveryProjection?.managed !== true || recoveryProjection.restartCount < 1 || recoveryProjection.lastExit == null) throw new Error("PAPER operations projection did not expose supervisor recovery evidence");
    if (supervisedRecovery.operations.transport !== "ONLINE" || supervisedRecovery.operations.schedulerRunning !== true) throw new Error("PAPER supervisor recovery did not reconnect public market runtime");
    const orderIds = (supervisedRecovery.orders || []).map((order) => order.id);
    const fillIds = (supervisedRecovery.orders || []).flatMap((order) => (order.fills || []).map((fill) => fill.id));
    if (new Set(orderIds).size !== orderIds.length || new Set(fillIds).size !== fillIds.length) throw new Error("PAPER supervisor recovery created duplicate order/fill identity");
    if (firstOrder != null && orderIds.filter((id) => id === firstOrder.id).length !== 1) throw new Error("PAPER supervisor recovery duplicated the durable pre-recovery order");
    const supervisorEvidence = {
      first_cycle: summarizeSnapshot(supervisedStart),
      second_cycle: summarizeSnapshot(secondCycleSnapshot),
      recovered: summarizeSnapshot(supervisedRecovery),
      restart_count: recoveryProjection.restartCount,
      reconnect_transport: supervisedRecovery.operations.transport,
      duplicate_order_ids: false,
      duplicate_fill_ids: false,
    };
    const chaosRecoveryEvidence = buildBoundPaperChaosRestartEvidence(root, secondCycleSnapshot, supervisedRecovery);
    await stopSupervisor(supervisor);
    supervisor = undefined;

    const payload = {
      schema_version: 1,
      evidence_type: "nusa.actual-paper-runtime-e2e",
      result: observation.status === "PASS" ? "PASS" : "INCOMPLETE",
      source_commit: gitRevision(root),
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      authority: { mode: "PAPER_ONLY", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" },
      runtime_composition: { entrypoint: PRODUCTION_RUNTIME_ENTRYPOINT, closed_learning_production_root: true, isolated_research_snapshot_path: researchReplaySnapshotPath, isolated_qualified_challenger_path: qualifiedArtifactPath },
      market_data: { provider: "UPBIT", channel: "PUBLIC_TICKER", market, private_credentials_used: false, scrubbed_private_env_key_count: scrubbedPrivateKeys.length },
      execution: {
        status: observedFills.length > 0 ? "AUTOMATICALLY_FILLED" : observedOrders.length > 0 ? "ORDER_WITHOUT_FILL" : observation.evidence.risk_rejections.length > 0 ? "RISK_REJECTED" : "NO_ACTIONABLE_SIGNAL",
        order_count: observedOrders.length,
        fill_count: observedFills.length,
        ...(firstOrder == null ? {} : { order_id: firstOrder.id, side: firstOrder.side, quantity: firstOrder.quantity, price: firstOrder.price, fee: firstOrder.fee }),
        ...(firstFill == null ? {} : { fill_id: firstFill.id }),
        ...(observation.evidence.risk_rejections.length === 0 ? {} : { risk_rejections: observation.evidence.risk_rejections }),
      },
      runtime_observation: observation.evidence,
      first_runtime: firstSummary,
      persistence: { sqlite_path: databasePath, sqlite_size_bytes: statSync(databasePath).size, sqlite_sha256_after_runtime: dbHashAfterRuntime },
      paper_learning: { stages_observed: [...firstLearningStages].sort(), event_count_before_restart: firstLearningIds.length, event_count_persisted_at_shutdown: persistedLearningIds.length, event_count_after_restart_recovery: recoveredLearningIds.length, duplicate_ids_after_restart: false, persisted_window_matches_recovery: true },
      restart_recovery: recoverySummary,
      automatic_restart: secondSummary,
      supervisor: supervisorEvidence,
      chaos_recovery: chaosRecoveryEvidence,
      idempotency_retry: { status: firstOrder == null ? "NOT_APPLICABLE_NO_AUTOMATIC_ORDER" : "AUTOMATIC_RESTART_RECONCILED", original_order_id: firstOrder?.id ?? null, matching_order_count: repeatedOrders.length, matching_fill_count: repeatedFills.length, double_fill: false },
      prohibited_capabilities: { upbit_private_credentials: false, live_order_endpoint: false, withdrawal_transfer: false, real_money_mutation: false },
    };
    return writeEvidence(outputPath, payload);
  } finally {
    if (firstRuntime) await stopRuntime(firstRuntime);
    if (secondRuntime) await stopRuntime(secondRuntime);
    if (supervisor) await stopSupervisor(supervisor);
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") options.outputPath = args[++index];
    else if (arg === "--market") options.market = args[++index];
    else if (arg === "--quantity") options.quantity = args[++index];
    else if (arg === "--working-dir") options.workingDir = args[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (require.main === module) {
  Promise.resolve().then(() => run(parseArgs(process.argv.slice(2)))).then((evidence) => {
    process.stdout.write(`${JSON.stringify({ result: evidence.result, evidence_type: evidence.evidence_type, artifact_hash: evidence.artifact_hash.value })}\n`);
    if (evidence.result === "FAIL") process.exitCode = 1;
  }).catch((error) => {
    const failureCode = safeRuntimeFailureCode(error instanceof Error ? error.message : "");
    process.stderr.write(`actual PAPER runtime E2E failed: ${failureCode}\n`);
    process.exitCode = 1;
  });
}

module.exports = { availablePort, buildBoundPaperChaosRestartEvidence, canonical, observeAutomaticRuntime, paperChaosStateFromSnapshot, readPersistedPaperLearningIds, run, scrubPrivateExchangeEnv, sha256, snapshotObservedAt, summarizeSnapshot, waitForHealth };
