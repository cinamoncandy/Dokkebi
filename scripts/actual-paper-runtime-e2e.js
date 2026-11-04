const { createHash, randomBytes } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { dirname, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { readGitHubWorkflowRunIdentity } = require("./lib/exact-head-paper-readiness-source.js");
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
    if (runtime.child.exitCode != null) throw new Error(`cloud runtime exited early (${runtime.child.exitCode}): ${runtime.stderr.join("").slice(-4000)}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("cloud runtime health timeout");
}

async function loadOperations(baseUrl, token) {
  try {
    const response = await fetch(`${baseUrl}/api/paper-operations`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    let body;
    try { body = await response.json(); } catch { body = { error: "NON_JSON_RESPONSE" }; }
    return { httpStatus: response.status, body };
  } catch (error) {
    return {
      httpStatus: 503,
      body: {
        error: "RUNTIME_TRANSIENTLY_UNAVAILABLE",
        detail: error instanceof Error ? error.message : "fetch failed",
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
  const workflowRunIdentity = readGitHubWorkflowRunIdentity();
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
    await waitForHealth(baseUrl, firstRuntime);
    const firstSnapshot = await waitForAutomaticRuntime(baseUrl, token);
    if (firstSnapshot.liveAuthority !== "NONE" || firstSnapshot.productionMutationAllowed !== false) throw new Error("automatic PAPER snapshot violated authority invariant");
    const firstSummary = summarizeSnapshot(firstSnapshot);
    if (!firstSummary.markets.some((item) => item.market === market && item.source === "UPBIT_PUBLIC_TICKER")) throw new Error("live Upbit PUBLIC ticker evidence missing from PAPER snapshot");
    if (firstSummary.heartbeat?.eventCount < 1 || firstSummary.heartbeat?.decisionCount < 1) throw new Error("automatic PAPER decision heartbeat evidence missing");
    const firstOrder = firstSnapshot.orders?.[0];
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
      result: "PASS",
      source_commit: gitRevision(root),
      workflow_run: workflowRunIdentity,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      authority: { mode: "PAPER_ONLY", liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" },
      runtime_composition: { entrypoint: PRODUCTION_RUNTIME_ENTRYPOINT, closed_learning_production_root: true, isolated_research_snapshot_path: researchReplaySnapshotPath, isolated_qualified_challenger_path: qualifiedArtifactPath },
      market_data: { provider: "UPBIT", channel: "PUBLIC_TICKER", market, private_credentials_used: false, scrubbed_private_env_key_count: scrubbedPrivateKeys.length },
      execution: firstOrder == null ? { status: "NO_ACTIONABLE_SIGNAL", order_count: 0, fill_count: 0 } : { status: "AUTOMATICALLY_FILLED", order_id: firstOrder.id, fill_id: firstFill?.id, side: firstOrder.side, quantity: firstOrder.quantity, price: firstOrder.price, fee: firstOrder.fee },
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
    const evidence = { ...payload, artifact_hash: { algorithm: "sha256", value: sha256(canonical(payload)) } };
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    return evidence;
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
  run(parseArgs(process.argv.slice(2))).then((evidence) => {
    process.stdout.write(`${JSON.stringify({ result: evidence.result, evidence_type: evidence.evidence_type, artifact_hash: evidence.artifact_hash.value })}\n`);
  }).catch((error) => {
    process.stderr.write(`actual PAPER runtime E2E failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}

module.exports = { availablePort, buildBoundPaperChaosRestartEvidence, canonical, paperChaosStateFromSnapshot, readGitHubWorkflowRunIdentity, readPersistedPaperLearningIds, run, scrubPrivateExchangeEnv, sha256, snapshotObservedAt, summarizeSnapshot };
