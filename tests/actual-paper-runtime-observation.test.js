const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { observeAutomaticRuntime, waitForHealth, waitForStablePaperObservationStart } = require("../scripts/actual-paper-runtime-e2e.js");
const { classify } = require("../scripts/classify-actual-paper-runtime-readiness.js");

const BASE_TIME = Date.parse("2026-11-06T12:00:00.000Z");

function event(cycleId, stage, occurredAt, overrides = {}) {
  return {
    id: `${cycleId}:${stage}`,
    cycleId,
    stage,
    occurredAt,
    market: "KRW-BTC",
    status: "PASS",
    ...(stage === "DECISION" ? { decision: { action: "WAIT" } } : {}),
    ...overrides,
  };
}

function cycleEvents(cycleNumber, occurredAt, { riskReject = false } = {}) {
  const cycleId = `natural-cycle-${cycleNumber}`;
  return [
    event(cycleId, "MARKET_DATA", occurredAt, { reason: "source=UPBIT_PUBLIC_TICKER" }),
    event(cycleId, "DECISION", occurredAt + 1, { reason: "NO_ACTIONABLE_PAPER_DECISION:WAIT:NO_SIGNAL" }),
    ...(riskReject ? [event(cycleId, "RISK", occurredAt + 2, { status: "FAIL", reason: "ACCOUNT_DAILY_LOSS_LIMIT,SECRET_VALUE" })] : []),
  ];
}

function snapshot(events, overrides = {}, observedAt = BASE_TIME) {
  const heartbeat = Object.hasOwn(overrides.operations ?? {}, "heartbeat")
    ? overrides.operations.heartbeat
    : { startedAt: BASE_TIME - 1_000, lastHeartbeatAt: observedAt, lastError: null };
  const operations = {
    runtimeState: "RUNNING",
    schedulerRunning: true,
    transport: "ONLINE",
    ...(overrides.operations ?? {}),
    heartbeat,
  };
  return {
    mode: "PAPER",
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    paperLearning: { mode: "PAPER", readOnly: true, liveAuthority: "NONE", productionMutationAllowed: false, events },
    portfolio: { account: { cash: 10_000_000, equity: 10_000_000, realizedPnl: 0, unrealizedPnl: 0, position: { quantity: 0 } } },
    orders: [],
    ...overrides,
    operations,
  };
}

async function runObservation({
  minimumDurationMs = 2_000,
  maximumDurationMs = 5_000,
  minimumDecisionCycles = 3,
  currentEvents = (readCount, time) => Array.from({ length: Math.min(readCount, 3) }, (_, index) => cycleEvents(index + 1, BASE_TIME + Math.max(0, time - ((Math.min(readCount, 3) - index - 1) * 1_000)))),
  initialSnapshot = snapshot([]),
  snapshotOverrides = () => ({}),
} = {}) {
  let monotonic = 0;
  let wall = BASE_TIME;
  let readCount = 0;
  const result = await observeAutomaticRuntime({
    initialSnapshot,
    minimumDurationMs,
    maximumDurationMs,
    minimumDecisionCycles,
    pollIntervalMs: 1_000,
    now: () => monotonic,
    wallNow: () => wall,
    delay: async (duration) => { monotonic += duration; wall += duration; },
    readSnapshot: async () => {
      readCount += 1;
      const events = currentEvents(readCount, monotonic).flat();
      return { httpStatus: 200, body: snapshot(events, snapshotOverrides(readCount, monotonic), BASE_TIME + monotonic) };
    },
  });
  return { ...result, readCount };
}

test("an immediate public ticker/startup projection cannot end the observation window early", async () => {
  const oldEvents = [1, 2, 3].flatMap((cycle) => cycleEvents(cycle, BASE_TIME - 10_000));
  const result = await runObservation({
    initialSnapshot: snapshot(oldEvents, { markets: [{ market: "KRW-BTC", source: "UPBIT_PUBLIC_TICKER" }] }),
    currentEvents: (readCount) => [
      ...oldEvents,
      ...(readCount >= 2 ? cycleEvents(4, BASE_TIME + 1_000) : []),
      ...(readCount >= 3 ? cycleEvents(5, BASE_TIME + 1_500) : []),
      ...(readCount >= 4 ? cycleEvents(6, BASE_TIME + 2_500) : []),
    ],
  });

  assert.equal(result.status, "PASS");
  assert.ok(result.evidence.elapsed_ms >= result.evidence.minimum_duration_ms);
  assert.equal(result.evidence.decision_cycles_observed, 3);
  assert.equal(result.evidence.stop_reason, "MINIMUM_DURATION_AND_DECISION_CYCLES_REACHED");
  assert.equal(result.evidence.stage_evidence.SIGNAL.status, "NOT_OBSERVED");
  assert.ok(result.readCount >= 4, "pre-window cycles must not count toward the natural observation window");
});

test("bounded observation collects several distinct natural Decision cycles without an order", async () => {
  const result = await runObservation();
  assert.equal(result.status, "PASS", "PASS here means the observation window completed, not that trading completed");
  assert.equal(result.evidence.decision_cycles_observed, 3);
  assert.equal(new Set(result.evidence.decision_cycles.map((cycle) => cycle.cycle_ref_sha256)).size, 3);
  assert.equal(result.evidence.stage_evidence.PAPER_ORDER.status, "NOT_OBSERVED");
  assert.equal(result.evidence.stage_evidence.PAPER_FILL.status, "NOT_OBSERVED");
  assert.match(result.evidence.timeline.find((entry) => entry.stage === "MARKET_DATA").occurred_at, /^2026-11-06T/);
  assert.ok(result.evidence.timeline.find((entry) => entry.stage === "DECISION").reason_codes.includes("NO_ACTIONABLE_PAPER_DECISION"));
  assert.ok(result.evidence.stage_evidence.ACCOUNT.first_observed_at);
  assert.ok(result.evidence.stage_evidence.ACCOUNT.last_observed_at);

  const readiness = classify({
    result: "PASS",
    authority: { mode: "PAPER_ONLY", liveAuthority: "NONE", productionMutationAllowed: false },
    market_data: { channel: "PUBLIC_TICKER" },
    execution: { order_count: 0, fill_count: 0 },
    first_runtime: { orderCount: 0, realizedPnl: 0, unrealizedPnl: 0, position: { quantity: 0 } },
    prohibited_capabilities: { real_money_mutation: false },
  });
  assert.equal(readiness.result, "INCOMPLETE");
  assert.equal(readiness.autonomous_trading_certification.status, "INCOMPLETE_NO_AUTONOMOUS_ORDER_FILL_PNL");
  assert.equal(readiness.production_readiness.completion_claim_allowed, false);
});


test("a continuously overlapping capped read-only window is not lost evidence", async () => {
  const baseline = Array.from({ length: 250 }, (_, i) => event(`baseline-${i}`, "MARKET_DATA", BASE_TIME - 30_000 - i));
  const result = await runObservation({
    initialSnapshot: snapshot(baseline),
    currentEvents: (readCount) => [
      ...baseline,
      ...Array.from({ length: Math.min(readCount, 3) }, (_, i) => cycleEvents(i + 1, BASE_TIME + i * 1_000)).flat(),
    ].sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id)).slice(0, 250),
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.evidence.stop_reason, "MINIMUM_DURATION_AND_DECISION_CYCLES_REACHED");
  assert.equal(result.evidence.event_evidence_truncated, false);
  assert.equal(result.evidence.projection_window.adjacent_windows_anchored, true);
  assert.ok(result.evidence.projection_window.moving_anchored_capped_samples > 0);
  assert.equal(result.evidence.projection_window.proof_scope, "ADJACENT_WINDOW_ANCHORS_ONLY");
  assert.equal(result.evidence.projection_window.late_backdated_event_coverage, "UNKNOWN");
  assert.ok(result.evidence.projection_window.capped_samples >= 3);
  assert.equal(result.evidence.projection_window.newest_anchor_verified_capped_samples, result.evidence.projection_window.capped_samples);
  assert.equal(result.evidence.decision_cycles_observed, 3);
  assert.equal(result.evidence.stage_evidence.PAPER_ORDER.status, "NOT_OBSERVED");

  const readiness = classify({
    result: result.status,
    authority: { mode: "PAPER_ONLY", liveAuthority: "NONE", productionMutationAllowed: false },
    prohibited_capabilities: { real_money_mutation: false },
    market_data: { channel: "PUBLIC_TICKER" },
    execution: { order_count: 0, fill_count: 0 },
  });
  assert.equal(readiness.runtime_safety_smoke.status, "PASS");
  assert.equal(readiness.result, "INCOMPLETE", "continuous observations do not manufacture orders or fills");
  assert.equal(readiness.production_readiness.completion_claim_allowed, false);
});

test("a full projection without a previous-window overlap remains INCOMPLETE", async () => {
  const baseline = Array.from({ length: 250 }, (_, i) => event(`prior-${i}`, "MARKET_DATA", BASE_TIME - 90_000 - i));
  const unrelated = Array.from({ length: 250 }, (_, i) => event(`new-${i}`, "MARKET_DATA", BASE_TIME + i));
  const result = await runObservation({
    initialSnapshot: snapshot(baseline),
    currentEvents: (readCount) => [
      ...unrelated,
      ...Array.from({ length: Math.min(readCount, 3) }, (_, i) => cycleEvents(i + 1, BASE_TIME + 1_000 + i * 1_000)).flat(),
    ].sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id)).slice(0, 250),
  });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.evidence.stop_reason, "EVENT_EVIDENCE_TRUNCATED");
  assert.equal(result.evidence.event_evidence_truncated, true);
  assert.equal(result.evidence.projection_window.adjacent_windows_anchored, false);
});

test("capped projection continuity does not excuse missing natural Decision cycles", async () => {
  const baseline = Array.from({ length: 250 }, (_, i) => event(`history-${i}`, "MARKET_DATA", BASE_TIME - 10_000 - i));
  const result = await runObservation({
    minimumDurationMs: 2_000,
    maximumDurationMs: 2_500,
    initialSnapshot: snapshot(baseline),
    currentEvents: () => baseline,
  });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.evidence.stop_reason, "MAX_OBSERVATION_BUDGET_EXHAUSTED");
  assert.equal(result.evidence.decision_cycles_observed, 0);
  assert.equal(result.evidence.event_evidence_truncated, false);
  assert.equal(result.evidence.projection_window.moving_anchored_capped_samples, 0);
  assert.equal(result.evidence.projection_window.adjacent_windows_anchored, false);
  assert.equal(result.evidence.projection_window.late_backdated_event_coverage, "UNKNOWN");
});


test("overlap with older IDs but loss of the previous newest anchor remains INCOMPLETE", async () => {
  const baseline = Array.from({ length: 250 }, (_, i) => event(`baseline-gap-${i}`, "MARKET_DATA", BASE_TIME - 30_000 - i));
  const result = await runObservation({
    initialSnapshot: snapshot(baseline),
    currentEvents: (readCount) => [
      ...baseline.slice(1, 244),
      ...Array.from({ length: Math.min(readCount, 3) }, (_, i) => cycleEvents(i + 1, BASE_TIME + 1_000 + i * 1_000)).flat(),
      ...Array.from({ length: 8 }, (_, i) => event(`recent-gap-${i}`, "MARKET_DATA", BASE_TIME + 4_000 + i)),
    ].sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id)).slice(0, 250),
  });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.evidence.stop_reason, "EVENT_EVIDENCE_TRUNCATED");
  assert.equal(result.evidence.event_evidence_truncated, true);
  assert.ok(result.evidence.projection_window.capped_samples > 0);
});

test("duplicate event IDs in a saturated projection cannot prove continuity", async () => {
  const baseline = Array.from({ length: 250 }, (_, i) => event(`baseline-duplicate-${i}`, "MARKET_DATA", BASE_TIME - 30_000 - i));
  const result = await runObservation({
    initialSnapshot: snapshot(baseline),
    currentEvents: () => [...baseline.slice(0, 249), baseline[248]],
  });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.evidence.stop_reason, "EVENT_EVIDENCE_TRUNCATED");
  assert.equal(result.evidence.projection_window.adjacent_windows_anchored, false);
});

test("reverse timestamp order in a saturated projection cannot prove continuity", async () => {
  const baseline = Array.from({ length: 250 }, (_, i) => event(`baseline-reverse-${i}`, "MARKET_DATA", BASE_TIME - 30_000 - i));
  const result = await runObservation({
    initialSnapshot: snapshot(baseline),
    currentEvents: () => baseline.slice().reverse(),
  });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.evidence.stop_reason, "EVENT_EVIDENCE_TRUNCATED");
  assert.equal(result.evidence.event_evidence_truncated, true);
  assert.equal(result.evidence.projection_window.adjacent_windows_anchored, false);
});

test("visible HALT failures cannot be hidden by a saturated projection", async () => {
  const baseline = Array.from({ length: 250 }, (_, i) => event(`baseline-halt-${i}`, "MARKET_DATA", BASE_TIME - 30_000 - i));
  const result = await runObservation({
    initialSnapshot: snapshot(baseline),
    currentEvents: () => [
      event("visible-halt", "HALT", BASE_TIME + 1, { status: "FAIL", reason: "PAPER_WRITER_LEASE_LOST" }),
      ...baseline.slice(0, 249),
    ],
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.evidence.failure_code, "PAPER_WRITER_LEASE_LOST");
});

test("PAPER order and fill evidence uses observed projection timestamps and hashed identities", async () => {
  const fillTime = new Date(BASE_TIME + 1_000).toISOString();
  const result = await runObservation({
    currentEvents: (readCount, time) => [
      ...Array.from({ length: Math.min(readCount, 3) }, (_, index) => cycleEvents(index + 1, BASE_TIME + Math.max(0, time - ((Math.min(readCount, 3) - index - 1) * 1_000)))),
      ...(readCount >= 2 ? [
        event("natural-cycle-1", "FILL", BASE_TIME + 1_500, { fill: { id: "private-paper-fill-id", filledAt: fillTime } }),
        event("natural-cycle-1", "PNL", BASE_TIME + 1_500, { account: { cash: 9_999_999, equity: 10_000_000, realizedPnl: 0, unrealizedPnl: 0 }, reason: "cash:9999999;equity:10000000" }),
      ] : []),
    ],
    snapshotOverrides: () => ({ orders: [{ id: "private-paper-order-id", market: "KRW-BTC", side: "BUY", status: "FILLED", quantity: 0.01, price: 1_000, fee: 0, filledAt: fillTime, fills: [{ id: "private-paper-fill-id", filledAt: fillTime }] }] }),
  });
  assert.equal(result.evidence.stage_evidence.PAPER_ORDER.status, "OBSERVED");
  assert.equal(result.evidence.stage_evidence.PAPER_FILL.status, "OBSERVED");
  assert.equal(result.evidence.timeline.find((entry) => entry.stage === "PAPER_ORDER").occurred_at, "UNKNOWN");
  assert.equal(result.evidence.timeline.find((entry) => entry.stage === "PAPER_FILL").occurred_at, fillTime);
  assert.equal(result.evidence.stage_evidence.PNL.status, "OBSERVED");
  const serialized = JSON.stringify(result.evidence);
  assert.doesNotMatch(serialized, /private-paper-(?:order|fill)-id/);
});

test("conflicting order identity across read-only snapshots fails closed", async () => {
  const result = await runObservation({
    snapshotOverrides: (readCount) => ({ orders: [{ id: "same-paper-order", market: "KRW-BTC", side: "BUY", status: "FILLED", quantity: 0.01, price: readCount === 1 ? 1_000 : 1_001, fee: 0, filledAt: new Date(BASE_TIME + 1_000).toISOString(), fills: [] }] }),
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.evidence.failure_code, "PAPER_ORDER_ID_CONFLICT");
});

test("the finite maximum budget returns INCOMPLETE when natural Decision cycles are insufficient", async () => {
  const result = await runObservation({
    minimumDurationMs: 2_000,
    maximumDurationMs: 2_500,
    minimumDecisionCycles: 3,
    currentEvents: (readCount) => readCount === 1 ? cycleEvents(1, BASE_TIME) : [],
  });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.evidence.stop_reason, "MAX_OBSERVATION_BUDGET_EXHAUSTED");
  assert.equal(result.evidence.elapsed_ms, 2_500);
  assert.ok(result.evidence.elapsed_ms <= result.evidence.maximum_budget_ms);
  assert.equal(result.evidence.decision_cycles_observed, 1);
});

test("a snapshot returned after the maximum budget cannot complete the observation as PASS", async () => {
  let monotonic = 0;
  let wall = BASE_TIME;
  const result = await observeAutomaticRuntime({
    initialSnapshot: snapshot([]),
    minimumDurationMs: 1_000,
    maximumDurationMs: 1_000,
    minimumDecisionCycles: 1,
    pollIntervalMs: 100,
    now: () => monotonic,
    wallNow: () => wall,
    delay: async (duration) => { monotonic += duration; wall += duration; },
    readSnapshot: async () => {
      monotonic += 1_200;
      wall += 1_200;
      return { httpStatus: 200, body: snapshot(cycleEvents(1, BASE_TIME + 100), {}, wall) };
    },
  });

  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.evidence.stop_reason, "MAX_OBSERVATION_BUDGET_EXHAUSTED");
  assert.ok(result.evidence.elapsed_ms > result.evidence.maximum_budget_ms);
  assert.equal(result.evidence.decision_cycles_observed, 0, "late events must not satisfy the bounded window");
});

test("a capped PAPER PERMISSION event keeps its known stage in the observation evidence", async () => {
  const result = await runObservation({
    minimumDurationMs: 1_000,
    maximumDurationMs: 1_000,
    minimumDecisionCycles: 1,
    currentEvents: () => [
      ...cycleEvents(1, BASE_TIME),
      event("natural-cycle-1", "PERMISSION", BASE_TIME + 2, { status: "SKIP", reason: "NOT_EVALUATED_NO_ACTIONABLE_DECISION" }),
    ],
  });

  assert.equal(result.evidence.stage_evidence.PERMISSION.status, "OBSERVED");
  assert.equal(result.evidence.stage_evidence.PERMISSION.event_count, 1);
  assert.ok(result.evidence.timeline.some((item) => item.stage === "PERMISSION"));
});

test("untrusted HTTP failure codes cannot leak while locally generated codes remain useful", async () => {
  for (const failureCode of ["API_KEY_TEST_SECRET", "UPBIT_ACCESSKEY_ABC123", "UPBIT_ACCESS_KEY_ABC123", "TOKEN_PRIVATE_VALUE"]) {
    const result = await observeAutomaticRuntime({
      initialSnapshot: snapshot([]),
      minimumDurationMs: 1_000,
      maximumDurationMs: 1_000,
      minimumDecisionCycles: 1,
      readSnapshot: async () => ({ httpStatus: 503, body: { failureCode } }),
    });

    assert.equal(result.status, "FAIL");
    assert.equal(result.evidence.failure_code, "RUNTIME_OPERATIONS_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result.evidence), /API_KEY_TEST_SECRET|UPBIT_ACCESSKEY_ABC123|UPBIT_ACCESS_KEY_ABC123|TOKEN_PRIVATE_VALUE/);
  }

  const timeout = await observeAutomaticRuntime({
    initialSnapshot: snapshot([]),
    minimumDurationMs: 1_000,
    maximumDurationMs: 1_000,
    minimumDecisionCycles: 1,
    readSnapshot: async () => ({ httpStatus: 503, body: { failureCode: "RUNTIME_OPERATIONS_TIMEOUT" } }),
  });
  assert.equal(timeout.evidence.failure_code, "RUNTIME_OPERATIONS_TIMEOUT");
});

test("runtime ERROR/HALT, heartbeat, and stderr-like failures emit only locally owned codes", async () => {
  const credentialLike = "UPBIT_ACCESSKEY_ABC123";
  for (const stage of ["ERROR", "HALT"]) {
    const result = await runObservation({
      currentEvents: () => [event(`runtime-failure-${stage}`, stage, BASE_TIME + 1, { status: "FAIL", reason: credentialLike })],
    });
    assert.equal(result.status, "FAIL");
    assert.equal(result.evidence.failure_code, "RUNTIME_ERROR_PRESENT");
    assert.deepEqual(result.evidence.timeline[0].reason_codes, []);
    assert.doesNotMatch(JSON.stringify(result.evidence), /UPBIT_ACCESSKEY_ABC123/);
  }

  const heartbeat = await runObservation({
    currentEvents: () => cycleEvents(1, BASE_TIME + 1),
    snapshotOverrides: () => ({ operations: { heartbeat: { startedAt: BASE_TIME - 1_000, lastHeartbeatAt: BASE_TIME, lastError: credentialLike } } }),
  });
  assert.equal(heartbeat.status, "FAIL");
  assert.equal(heartbeat.evidence.failure_code, "RUNTIME_ERROR_PRESENT");
  assert.doesNotMatch(JSON.stringify(heartbeat.evidence), /UPBIT_ACCESSKEY_ABC123/);

  let snapshotReads = 0;
  const stderrLike = await observeAutomaticRuntime({
    initialSnapshot: snapshot([]),
    checkRuntimeFailure: () => `runtime exited: ${credentialLike}`,
    minimumDurationMs: 1_000,
    maximumDurationMs: 1_000,
    minimumDecisionCycles: 1,
    now: () => 0,
    wallNow: () => BASE_TIME,
    readSnapshot: async () => { snapshotReads += 1; return { httpStatus: 200, body: snapshot([]) }; },
    delay: async () => {},
  });
  assert.equal(snapshotReads, 0);
  assert.equal(stderrLike.status, "FAIL");
  assert.equal(stderrLike.evidence.failure_code, "RUNTIME_ERROR_PRESENT");
  assert.doesNotMatch(JSON.stringify(stderrLike.evidence), /UPBIT_ACCESSKEY_ABC123/);
});

test("known locally owned PAPER writer reason codes survive strict reason-code normalization", async () => {
  const result = await runObservation({
    currentEvents: () => [event("known-writer-failure", "HALT", BASE_TIME + 1, { status: "FAIL", reason: "PAPER_WRITER_LEASE_LOST" })],
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.evidence.failure_code, "PAPER_WRITER_LEASE_LOST");
  assert.deepEqual(result.evidence.timeline[0].reason_codes, ["PAPER_WRITER_LEASE_LOST"]);
});

test("known locally generated runtime failure codes survive strict heartbeat normalization", async () => {
  const localCodes = [
    "PAPER_ORDERBOOK_OBSERVATION_REJECTED",
    "PAPER_ORDERBOOK_UNRECONCILED",
    "PAPER_PERIOD_EVIDENCE_REJECTED",
    "PUBLIC_ORDERBOOK_SNAPSHOT_UNAVAILABLE",
  ];

  for (const lastError of localCodes) {
    const result = await runObservation({
      currentEvents: () => cycleEvents(1, BASE_TIME + 1),
      snapshotOverrides: () => ({ operations: { heartbeat: { startedAt: BASE_TIME - 1_000, lastHeartbeatAt: BASE_TIME, lastError } } }),
    });
    assert.equal(result.status, "FAIL");
    assert.equal(result.evidence.failure_code, lastError);
  }
});

test("startup orderbook synchronization errors are retained and observation starts only after consecutive clean snapshots", async () => {
  let wall = BASE_TIME;
  let reads = 0;
  const startupError = snapshot([], {
    operations: {
      runtimeState: "DEGRADED",
      heartbeat: { startedAt: BASE_TIME - 1_000, lastHeartbeatAt: BASE_TIME, lastError: "PAPER_ORDERBOOK_UNRECONCILED" },
    },
  });
  const stabilized = await waitForStablePaperObservationStart({
    initialSnapshot: startupError,
    startupBudgetMs: 5_000,
    pollIntervalMs: 1_000,
    wallNow: () => wall,
    delay: async (duration) => { wall += duration; },
    readSnapshot: async () => {
      reads += 1;
      return { httpStatus: 200, body: snapshot([], {}, wall) };
    },
  });

  assert.equal(stabilized.status, "PASS");
  assert.equal(reads, 2);
  assert.equal(stabilized.evidence.status, "SYNCHRONIZATION_RECOVERED");
  assert.equal(stabilized.evidence.error_occurrence_count, 1);
  assert.deepEqual(stabilized.evidence.error_codes, ["PAPER_ORDERBOOK_UNRECONCILED"]);
  assert.equal(stabilized.evidence.first_error_at, new Date(BASE_TIME).toISOString());
  assert.equal(stabilized.evidence.consecutive_clean_snapshots, 2);
  assert.equal(stabilized.snapshot.operations.heartbeat.lastError, null);
});

test("persistent startup synchronization error exhausts its bounded budget without opening observation", async () => {
  let wall = BASE_TIME;
  let reads = 0;
  const persistent = snapshot([], {
    operations: { heartbeat: { startedAt: BASE_TIME - 1_000, lastHeartbeatAt: BASE_TIME, lastError: "PUBLIC_ORDERBOOK_SNAPSHOT_UNAVAILABLE" } },
  });
  const result = await waitForStablePaperObservationStart({
    initialSnapshot: persistent,
    startupBudgetMs: 2_000,
    pollIntervalMs: 1_000,
    wallNow: () => wall,
    delay: async (duration) => { wall += duration; },
    readSnapshot: async () => { reads += 1; return { httpStatus: 200, body: persistent }; },
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.failureCode, "AUTOMATIC_RUNTIME_STARTUP_TIMEOUT");
  assert.equal(result.evidence.error_occurrence_count, 3);
  assert.equal(result.evidence.consecutive_clean_snapshots, 0);
  assert.equal(reads, 2);
});

test("lease, unknown, and suffixed runtime startup errors fail immediately", async () => {
  for (const lastError of ["PAPER_WRITER_LEASE_LOST", "UNRECOGNIZED_RUNTIME_ERROR", "PAPER_ORDERBOOK_UNRECONCILED: detail"]) {
    let reads = 0;
    const initialSnapshot = snapshot([], {
      operations: { heartbeat: { startedAt: BASE_TIME - 1_000, lastHeartbeatAt: BASE_TIME, lastError } },
    });
    const result = await waitForStablePaperObservationStart({
      initialSnapshot,
      wallNow: () => BASE_TIME,
      readSnapshot: async () => { reads += 1; return { httpStatus: 200, body: snapshot([]) }; },
      delay: async () => {},
    });
    assert.equal(result.status, "FAIL", lastError);
    assert.equal(reads, 0, lastError);
    assert.equal(result.evidence.consecutive_clean_snapshots, 0, lastError);
  }
});

test("a stale heartbeat cannot make an orderbook diagnostic waitable", async () => {
  const stale = snapshot([], {
    operations: {
      runtimeState: "DEGRADED",
      heartbeat: { startedAt: BASE_TIME - 60_000, lastHeartbeatAt: BASE_TIME - 45_000, lastError: "PAPER_ORDERBOOK_UNRECONCILED" },
    },
  });
  const result = await waitForStablePaperObservationStart({
    initialSnapshot: stale,
    wallNow: () => BASE_TIME,
    readSnapshot: async () => { throw new Error("must fail before polling stale evidence"); },
    delay: async () => {},
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.failureCode, "PAPER_RUNTIME_HEARTBEAT_INVALID");
  assert.equal(result.evidence.error_occurrence_count, 0);
});

test("allowlisted runtime code prefixes with untrusted suffixes fail closed", async () => {
  const secret = "UPBIT_ACCESSKEY_ABC123";
  const lastErrors = [
    `PAPER_ORDERBOOK_UNRECONCILED: ${secret}`,
    `PAPER_PERIOD_EVIDENCE_REJECTED; ${secret}`,
    `PUBLIC_ORDERBOOK_SNAPSHOT_UNAVAILABLE ${secret}`,
    `PAPER_WRITER_LEASE_LOST: ${secret}`,
  ];

  for (const lastError of lastErrors) {
    const result = await runObservation({
      snapshotOverrides: () => ({ operations: { heartbeat: { startedAt: BASE_TIME - 1_000, lastHeartbeatAt: BASE_TIME, lastError } } }),
    });
    assert.equal(result.status, "FAIL");
    assert.equal(result.evidence.failure_code, "RUNTIME_ERROR_PRESENT");
    assert.doesNotMatch(JSON.stringify(result.evidence), /UPBIT_ACCESSKEY_ABC123/);
  }
});

test("anchored local writer error stacks preserve only the exact leading failure code", async () => {
  await assert.rejects(
    waitForHealth("http://127.0.0.1:1", { child: { exitCode: 1 }, stderr: ["Error: PAPER_WRITER_LEASE_LOST\n    at acquireLease (runtime.js:1:1)\n"] }),
    (error) => {
      assert.match(error.message, /cloud runtime exited early \(1\): PAPER_WRITER_LEASE_LOST/);
      return true;
    },
  );
});

test("restart health failures preserve bounded classification without reflecting child stderr", async () => {
  const credentialLike = "UPBIT_ACCESSKEY_ABC123";
  await assert.rejects(
    waitForHealth("http://127.0.0.1:1", { child: { exitCode: 1 }, stderr: [credentialLike] }),
    (error) => {
      assert.match(error.message, /cloud runtime exited early \(1\): RUNTIME_ERROR_PRESENT/);
      assert.doesNotMatch(error.message, /UPBIT_ACCESSKEY_ABC123/);
      return true;
    },
  );
});

test("CLI errors expose only a bounded code even when the rejected argument resembles a credential", () => {
  const credentialLike = "UPBIT_ACCESSKEY_ABC123";
  const result = spawnSync(process.execPath, ["scripts/actual-paper-runtime-e2e.js", `--invalid=${credentialLike}`], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /actual PAPER runtime E2E failed: RUNTIME_ERROR_PRESENT/);
  assert.doesNotMatch(result.stderr, /UPBIT_ACCESSKEY_ABC123/);
});

test("Risk rejection keeps bounded canonical reason codes without raw detail", async () => {
  const result = await runObservation({ currentEvents: (readCount, time) => Array.from({ length: Math.min(readCount, 3) }, (_, index) => cycleEvents(index + 1, BASE_TIME + Math.max(0, time - ((Math.min(readCount, 3) - index - 1) * 1_000)), { riskReject: true })) });
  assert.equal(result.status, "PASS");
  assert.equal(result.evidence.risk_rejections.length, 3);
  assert.ok(result.evidence.risk_rejections.every((item) => item.reason_codes.includes("ACCOUNT_DAILY_LOSS_LIMIT")));
  const serialized = JSON.stringify(result.evidence);
  assert.doesNotMatch(serialized, /SECRET_VALUE/);
  assert.doesNotMatch(serialized, /10_000_000/);
  assert.equal(result.evidence.stage_evidence.RISK.status, "OBSERVED");
});

test("writer lease conflict fails closed while preserving already observed bounded events", async () => {
  const result = await runObservation({
    currentEvents: () => cycleEvents(1, BASE_TIME),
    snapshotOverrides: () => ({ operations: { runtimeState: "RUNNING", schedulerRunning: true, transport: "ONLINE", heartbeat: { startedAt: BASE_TIME - 1_000, lastHeartbeatAt: BASE_TIME, lastError: "PAPER_WRITER_LEASE_LOST" } } }),
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.evidence.stop_reason, "RUNTIME_OR_EVIDENCE_FAILURE");
  assert.equal(result.evidence.failure_code, "PAPER_WRITER_LEASE_LOST");
  assert.ok(result.evidence.timeline.some((entry) => entry.stage === "DECISION"));
  assert.doesNotMatch(JSON.stringify(result.evidence), /access[_-]?token|secret|password/i);
});

test("malformed heartbeat and PAPER authority changes fail closed", async () => {
  for (const snapshotOverrides of [
    () => ({ operations: { heartbeat: null } }),
    () => ({ productionMutationAllowed: true }),
  ]) {
    const result = await runObservation({
      currentEvents: () => cycleEvents(1, BASE_TIME),
      snapshotOverrides,
    });
    assert.equal(result.status, "FAIL");
    assert.match(result.evidence.failure_code, /PAPER_RUNTIME_HEARTBEAT_INVALID|PAPER_AUTHORITY_INVARIANT_VIOLATION/);
  }
});
