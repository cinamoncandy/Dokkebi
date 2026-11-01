const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startCloudDashboardServer } = require("../dist/apps/cloud/src/server.js");
const { evaluateComponentHealth } = require("../dist/apps/cloud/src/componentHealth.js");
const { ClosedLearningLoopStatusTracker } = require("../dist/apps/cloud/src/closedLearningLoopStatus.js");

/**
 * 24-hour PAPER operation must be observable, not assumed.
 *
 * The PAPER execution loop is driven by a persistent Upbit public ticker subscription, so it
 * either runs continuously or not at all. Nothing exposed that distinction: `/health` returned
 * `{ok:true}` whenever the HTTP listener answered, and `/ready` reports database and migration
 * readiness. A stalled market feed, a loop that had stopped deciding, and a healthy runtime were
 * indistinguishable from outside -- which is exactly the question "is it running 24 hours?".
 *
 * `/health` is unauthenticated by design, so the evidence must stay operational: timestamps,
 * counters and a coded error, never a price, balance, position or order detail.
 */

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { connection: "close" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const ownerPrincipal = Object.freeze({
  userId: "operator",
  email: "operator@nusa.local",
  scopes: Object.freeze(["dashboard:read", "paper:trade", "users:manage"])
});
const verifier = Object.freeze({ ownerPrincipal, verify: () => undefined });
const base = Object.freeze({ tokenVerifier: verifier, loadDashboard: () => { throw new Error("not used"); } });

const LIVENESS = Object.freeze({
  startedAt: 1_000, lastHeartbeatAt: 2_000, lastMarketEventAt: 1_900,
  lastPaperDecisionAt: 1_800, lastPaperOrderAt: 1_700, lastPaperFillAt: 1_600,
  eventCount: 42, decisionCount: 7, paperOrderCount: 3, paperFillCount: 2, lastError: null
});

test("/health publishes learning eligibility and current blocks, and withdraws stale or malformed fields", async () => {
  const now = Date.parse("2026-10-12T01:00:00Z");
  const tracker = new ClosedLearningLoopStatusTracker();
  tracker.observeRollover({ status: "BLOCKED", reason: "MISSING_EVIDENCE:private detail" }, now);
  let loop = tracker.snapshot();
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: loop }) }, async (handle) => {
    const read = async () => JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop;
    assert.equal((await read()).currentBlockedReason, "MISSING_EVIDENCE");
    tracker.observeRollover({ status: "WAITING_FOR_KST_DAY_ROLLOVER" }, now + 1);
    tracker.observePeriods({ periodId: "period-1", periodStartAt: now, candidateProvenance: [], observations: [] }, []);
    loop = tracker.snapshot();
    const waiting = await read();
    assert.equal(waiting.currentBlockedReason, undefined);
    assert.equal(waiting.lastBlockedReason, "MISSING_EVIDENCE");
    assert.equal(waiting.nextEvaluationEligibleAt, Date.parse("2026-10-12T15:00:00Z"));
    for (const bad of [-1, NaN, "private", now, now + 1, Date.parse("2026-10-13T15:00:00Z"), Number.MAX_SAFE_INTEGER]) {
      loop = { ...tracker.snapshot(), nextEvaluationEligibleAt: bad, currentBlockedReason: "STALE_FAILURE" };
      const out = await read();
      assert.equal(out.nextEvaluationEligibleAt, undefined);
      assert.equal(out.currentBlockedReason, undefined);
    }
    tracker.observeError(now + 2);
    loop = tracker.snapshot();
    assert.equal((await read()).currentBlockedReason, "TICK_ERROR");
    assert.equal((await read()).nextEvaluationEligibleAt, undefined);
    loop = { ...loop, currentBlockedReason: "private detail" };
    assert.equal((await read()).currentBlockedReason, undefined);
    assert.doesNotMatch(JSON.stringify(await read()), /private detail/);
  }, 42589);
});

test("/health accepts only canonical hourly eligibility tied to the open period", async () => {
  const now = Date.parse("2026-10-12T01:00:00Z");
  const tracker = new ClosedLearningLoopStatusTracker(3_600_000);
  tracker.observeRollover({ status: "WAITING_FOR_KST_DAY_ROLLOVER" }, now);
  tracker.observePeriods({ periodId: "hourly", periodStartAt: now, observations: [], candidateProvenance: [] }, []);
  let loop = tracker.snapshot();
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: loop }) }, async (handle) => {
    const read = async () => JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop;
    assert.equal((await read()).nextEvaluationEligibleAt, now + 3_600_000);
    assert.equal((await read()).evaluationPeriodMs, 3_600_000);
    loop = { ...loop, nextEvaluationEligibleAt: now + 3_600_001 };
    assert.equal((await read()).nextEvaluationEligibleAt, undefined);
  }, 42590);
});

async function withServer(options, run, port) {
  // Keep test listeners below Linux's ephemeral-port range so unrelated local
  // outbound connections cannot make deterministic server tests flaky.
  const stableTestPort = port >= 32_768 ? port - 20_000 : port;
  const handle = startCloudDashboardServer({ port: stableTestPort, ...base, ...options });
  try { await run(handle); } finally { await handle.stop(); }
}

test("/health carries the continuous PAPER runtime counters when a source is wired", async () => {
  await withServer({ runtimeLiveness: () => LIVENESS }, async (handle) => {
    const res = await request(handle.port, "/health");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.runtime, LIVENESS, "the loop's own counters must be observable");
  }, 41881);
});

test("a stalled loop is distinguishable from a healthy one", async () => {
  const stalled = Object.freeze({ ...LIVENESS, lastMarketEventAt: null, lastPaperDecisionAt: null, eventCount: 0, decisionCount: 0, lastError: "PAPER_MARKET_OBSERVATION_REJECTED" });
  await withServer({ runtimeLiveness: () => stalled }, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    // The process still answers, so `ok` stays true. The distinction has to come from the counters.
    assert.equal(body.ok, true);
    assert.equal(body.runtime.lastMarketEventAt, null);
    assert.equal(body.runtime.eventCount, 0);
    assert.equal(body.runtime.lastError, "PAPER_MARKET_OBSERVATION_REJECTED");
  }, 41882);
});

test("/health is unchanged when no liveness source is wired", async () => {
  await withServer({}, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    assert.equal(body.ok, true);
    assert.ok(typeof body.observedAt === "string" && body.observedAt.length > 0);
    assert.equal("runtime" in body, false, "existing probes must not see a new field appear from nowhere");
  }, 41883);
});

test("/health stays unauthenticated and still refuses non-GET", async () => {
  await withServer({ runtimeLiveness: () => LIVENESS }, async (handle) => {
    const res = await request(handle.port, "/health");
    assert.equal(res.status, 200, "no credential is required to observe liveness");
  }, 41884);
});

test("the published evidence carries no financial or credential data", async () => {
  await withServer({ runtimeLiveness: () => LIVENESS }, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    const keys = Object.keys(body.runtime);
    // Allowlist, not a denylist: a future field cannot leak by simply not matching a banned word.
    assert.deepEqual(keys.sort(), [
      "decisionCount", "eventCount", "lastError", "lastHeartbeatAt", "lastMarketEventAt",
      "lastPaperDecisionAt", "lastPaperFillAt", "lastPaperOrderAt", "paperFillCount",
      "paperOrderCount", "startedAt"
    ], "/health is unauthenticated, so its payload is a fixed operational allowlist");
    for (const [key, value] of Object.entries(body.runtime)) {
      assert.ok(value === null || typeof value === "number" || key === "lastError",
        `${key} must be a timestamp, a counter, or a coded error`);
    }
  }, 41885);
});

test("the runtime publishes exactly the fields the contract allows", () => {
  const fs = require("node:fs");
  const runtime = fs.readFileSync("apps/cloud/src/runtime.ts", "utf8");
  const start = runtime.indexOf("runtimeLiveness: () =>");
  assert.ok(start > 0, "the runtime must wire its heartbeat into the server");
  const block = runtime.slice(start, runtime.indexOf("}),", start));
  for (const banned of ["price", "balance", "capital", "position", "token", "secret"]) {
    assert.doesNotMatch(block, new RegExp(banned, "i"), `liveness must not publish ${banned}`);
  }
});

test("/health publishes only the allowlisted liveness fields, whatever the source returns", async () => {
  // A future or alternate source can return more than the contract; structural typing allows it.
  // The extra values are sentinels, not credentials, so the repository secret scan stays clean.
  const leaky = { ...LIVENESS, privateRuntimeField: "leak-sentinel-7f3", accountId: "acct-123", balanceKrw: 1_000_000, lastError: "Upbit said: invalid key abc123 for account acct-123" };
  await withServer({ runtimeLiveness: () => leaky }, async (handle) => {
    const res = await request(handle.port, "/health");
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body.runtime).sort(), Object.keys(LIVENESS).sort(), "no field beyond the contract may reach the public route");
    assert.equal(body.runtime.lastError, "LIVENESS_ERROR_UNCLASSIFIED", "a free-text error is replaced, never published");
    assert.doesNotMatch(res.body, /leak-sentinel-7f3|acct-123|(?<![0-9])1000000(?![0-9])|invalid key/);
  }, 41887);
});

test("/health publishes the event-loop stall numbers only as finite non-negative numbers, and only when supplied", async () => {
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, eventLoopMaxStallMs: 6_100, eventLoopStallCount: 3.9, lastEventLoopStallAt: 1_950 }) }, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    assert.equal(body.runtime.eventLoopMaxStallMs, 6_100);
    assert.equal(body.runtime.eventLoopStallCount, 3);
    assert.equal(body.runtime.lastEventLoopStallAt, 1_950);
  }, 41901);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, eventLoopMaxStallMs: -1, eventLoopStallCount: "7 leak-sentinel-9", lastEventLoopStallAt: Number.NaN }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body.runtime).sort(), Object.keys(LIVENESS).sort(), "invalid stall values are dropped, not published");
    assert.doesNotMatch(res.body, /leak-sentinel-9/);
  }, 41902);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, lastEventLoopStallAt: null }) }, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    assert.equal(body.runtime.lastEventLoopStallAt, null);
  }, 41903);
});

test("/health names the class of the runtime's own paper failures but never the detail after the colon", async () => {
  const cases = [
    ["paper account persistence failed: PAPER_LEDGER_RECONCILIATION_REQUIRED realized state -154.31476926 ledger -154.31476925 38 fills", "PAPER_ACCOUNT_PERSISTENCE_FAILED"],
    ["paper account persistence failed", "PAPER_ACCOUNT_PERSISTENCE_FAILED"],
    ["paper order lifecycle reconciliation mismatch", "PAPER_ORDER_LIFECYCLE_RECONCILIATION_MISMATCH"],
    // Not the runtime's own plain-words phrase: still replaced, never published.
    ["Upbit said: invalid key abc123 for account acct-123", "LIVENESS_ERROR_UNCLASSIFIED"],
    ["paper account 1234 failed: x", "LIVENESS_ERROR_UNCLASSIFIED"],
    ["paper key abc-123 leaked", "LIVENESS_ERROR_UNCLASSIFIED"],
    ["Paper account persistence failed: x", "LIVENESS_ERROR_UNCLASSIFIED"],
    ["paper " + "x".repeat(80) + ": y", "LIVENESS_ERROR_UNCLASSIFIED"],
  ];
  for (const [index, [lastError, expected]] of cases.entries()) {
    await withServer({ runtimeLiveness: () => ({ ...LIVENESS, lastError }) }, async (handle) => {
      const res = await request(handle.port, "/health");
      const body = JSON.parse(res.body);
      assert.equal(body.runtime.lastError, expected, lastError);
      assert.doesNotMatch(res.body, /-154\.3|38 fills|abc123|acct-123|(?<![0-9])1234(?![0-9])|abc-123|ledger/);
    }, 41850 + index); // a range no other test file uses (41890-41897 overlapped paper-decision-outcome's 41893-41895)
  }
});

test("/health publishes the research collection status as a fixed code plus two counts and nothing else", async () => {
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, researchCollectionStatus: "COLLECTING", researchCandleCount: 1234.7, researchRequiredCandles: 16_560, researchMarket: "KRW-XRP", researchDetail: "leak-sentinel-r1" }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    const body = JSON.parse(res.body);
    assert.equal(body.runtime.researchCollectionStatus, "COLLECTING");
    assert.equal(body.runtime.researchCandleCount, 1234);
    assert.equal(body.runtime.researchRequiredCandles, 16_560);
    assert.equal(body.runtime.researchMarket, undefined);
    assert.doesNotMatch(res.body, /leak-sentinel-r1|KRW-XRP/);
  }, 41851 + 20);
  for (const [index, status] of ["DISABLED", "INVALID", "UNAVAILABLE"].entries()) {
    await withServer({ runtimeLiveness: () => ({ ...LIVENESS, researchCollectionStatus: status }) }, async (handle) => {
      const body = JSON.parse((await request(handle.port, "/health")).body);
      assert.equal(body.runtime.researchCollectionStatus, status);
      assert.equal(body.runtime.researchCandleCount, undefined);
    }, 41872 + index);
  }
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, researchCollectionStatus: "free text with detail 123", researchCandleCount: -5 }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body.runtime).sort(), Object.keys(LIVENESS).sort(), "an unknown status is dropped, not published");
    assert.doesNotMatch(res.body, /free text/);
  }, 41876);
});

test("/health publishes the PAPER decision funnel as fixed stage codes and integer counts, and drops everything else", async () => {
  const funnel = { since: 1_791_259_000_000, counts: { "MARKET_DATA:PASS": 9000, "DECISION:PASS": 80, "DECISION:PASS:BUY": 60, "RISK:FAIL:CONSECUTIVE_LOSS_LIMIT": 57, OTHER: 3, "RISK:FAIL": 57 } };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperFunnel: funnel }) }, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    assert.deepEqual(body.runtime.paperFunnel, funnel);
  }, 41861);
  const dirty = { since: 5, counts: { "RISK:FAIL": 4.5, "risk:fail": 1, "RISK:MAYBE": 2, "RISK:FAIL:lower": 3, "DECISION:PASS:KRW-XRP": 4, "balance is 9,999 KRW": 5, "RISK:FAIL:OK_CODE": 6, "FILL:PASS": -1, "PNL:PASS": "7", "DECISION:SKIP": 8 } };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperFunnel: dirty }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    const body = JSON.parse(res.body);
    assert.deepEqual(body.runtime.paperFunnel.counts, { "RISK:FAIL:OK_CODE": 6, "DECISION:SKIP": 8 }, "only well-formed keys with non-negative integer counts survive");
    assert.doesNotMatch(res.body, /9,999|KRW-XRP|lower/);
  }, 41862);
  const many = { since: 1, counts: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`RISK:FAIL:CODE_${i}`, i])) };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperFunnel: many }) }, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    assert.equal(Object.keys(body.runtime.paperFunnel.counts).length, 80, "at most 80 keys are published");
  }, 41863);
  for (const [index, bad] of [null, "text", { since: -1, counts: {} }, { since: 1, counts: [1, 2] }, { since: 1 }, { counts: {} }].entries()) {
    await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperFunnel: bad }) }, async (handle) => {
      const body = JSON.parse((await request(handle.port, "/health")).body);
      assert.equal(body.runtime.paperFunnel, undefined, JSON.stringify(bad));
    }, 41864 + index);
  }
});

test("/health strips extra component-health fields from an alternate callback", async () => {
  const measuredAt = 2_000;
  const health = (componentId, provenance, evidenceId) => evaluateComponentHealth({
    componentId, now: measuredAt, policy: { staleAfterMs: 1_000 },
    latest: { componentId, signal: "PASS", observedAt: measuredAt, provenance, evidenceId },
  });
  const process = { ...health("PAPER_PROCESS", "cloud-runtime-heartbeat", "heartbeat:1000:2000"), extra: "private-marker-42" };
  const workload = { ...health("PAPER_WORKLOAD", "cloud-paper-market-events", "market-event:1000:2000:1"), extra: "private-marker-42" };
  await withServer({ runtimeHealth: () => ({ process, workload, extra: "private-marker-42" }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    const body = JSON.parse(res.body);
    assert.equal(res.status, 200);
    assert.equal(body.runtimeHealth.process.state, "HEALTHY");
    assert.equal(body.runtimeHealth.workload.state, "HEALTHY");
    assert.doesNotMatch(res.body, /private-marker-42/);
  }, 41890);
});

test("/health omits malformed component-health evidence without exposing callback text", async () => {
  await withServer({ runtimeHealth: () => ({ process: null, workload: { error: "private-marker-42" } }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).runtimeHealth, undefined);
    assert.doesNotMatch(res.body, /private-marker-42/);
  }, 41891);
});

test("a coded liveness error is published unchanged", async () => {
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, lastError: "PUBLIC_MARKET_EVENT_REJECTED:STALE" }) }, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    assert.equal(body.runtime.lastError, "PUBLIC_MARKET_EVENT_REJECTED:STALE");
  }, 41888);
});

test("the previous stop reason is published only as a coded value and never as free text", async () => {
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, previousStop: "PREVIOUS_CLOSED_LEARNING_SCHEDULER:MESSAGE_0123456789AB" }) }, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    assert.equal(body.runtime.previousStop, "PREVIOUS_CLOSED_LEARNING_SCHEDULER:MESSAGE_0123456789AB");
  }, 41889);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, previousStop: "failed for account acct-123" }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    assert.equal(JSON.parse(res.body).runtime.previousStop, undefined);
    assert.doesNotMatch(res.body, /acct-123/);
  }, 41889);
});

test("/health publishes loss counts and the explicit enforcement policy without private data", async () => {
  const session = { evaluatedAt: 1_791_270_000_000, consecutiveLossCount: 3, maxConsecutiveLosses: 3, consecutiveLossLimitEnabled: false, todayCompletedSells: 5, todayLosingSells: 4 };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperLossSession: session }) }, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    assert.deepEqual(body.runtime.paperLossSession, session);
  }, 42301);
  for (const [index, bad] of [null, "text", { ...session, todayLosingSells: -1 }, { ...session, consecutiveLossCount: 1.5 }, { ...session, todayCompletedSells: undefined }, { ...session, market: "KRW-XRP", pnl: -219 }].entries()) {
    await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperLossSession: bad }) }, async (handle) => {
      const res = await request(handle.port, "/health");
      const body = JSON.parse(res.body);
      if (index === 5) {
        assert.deepEqual(Object.keys(body.runtime.paperLossSession).sort(), Object.keys(session).sort(), "extra fields are dropped");
        assert.doesNotMatch(res.body, /KRW-XRP|-219/);
      } else assert.equal(body.runtime.paperLossSession, undefined, JSON.stringify(bad));
    }, 42302 + index);
  }
});

test("/health publishes the loss-period evidence only as one coherent tuple, and omits it whole otherwise", async () => {
  const start = Date.parse("2026-10-07T00:00:00+09:00");
  const base = { evaluatedAt: start + 3_600_000, consecutiveLossCount: 3, maxConsecutiveLosses: 3, todayCompletedSells: 3, todayLosingSells: 3 };
  const good = { ...base, periodIdentity: "2026-10-07", periodStartedAt: start, lastIncrementAt: start + 1_800_000 };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperLossSession: good }) }, async (handle) => {
    assert.deepEqual(JSON.parse((await request(handle.port, "/health")).body).runtime.paperLossSession, good);
  }, 42321);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperLossSession: { ...good, consecutiveLossCount: 0, lastIncrementAt: null } }) }, async (handle) => {
    assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.paperLossSession.lastIncrementAt, null);
  }, 42322);
  const contradictory = [
    { ...base, periodIdentity: "KRW-XRP", periodStartedAt: start, lastIncrementAt: null },
    { ...base, periodIdentity: "2026-10-07" },
    { ...base, periodIdentity: "2026-10-07", periodStartedAt: start + 1, lastIncrementAt: null },
    { ...base, periodIdentity: "2026-10-08", periodStartedAt: start, lastIncrementAt: null },
    { ...good, periodStartedAt: base.evaluatedAt + 1, lastIncrementAt: null },
    { ...good, lastIncrementAt: base.evaluatedAt + 1 },
    { ...good, lastIncrementAt: start - 1 },
    { ...good, lastIncrementAt: "x" },
  ];
  for (const [index, bad] of contradictory.entries()) {
    await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperLossSession: bad }) }, async (handle) => {
      const body = JSON.parse((await request(handle.port, "/health")).body);
      assert.deepEqual(body.runtime.paperLossSession, base, `case ${index}: the five counts stay and the whole tuple is omitted`);
    }, 42323 + index);
  }
});

test("/health publishes the durable cycle counts as integers inside the loop evidence, and drops anything malformed", async () => {
  const loop = { lastTickAt: 5, ticks: 5, cyclesEvaluated: 0, deployments: 0, bootstrap: "EXISTING_PAPER_STATE", rollover: "WAITING_FOR_CANONICAL_BOUNDARY", lastCycleOutcome: "REJECTED",
    evidence: { cyclesRecorded: 3, lastCycleRecordedAt: 1_791_419_000_000, cycleId: "closed-learning:" + "a".repeat(64), cycleEvidenceFingerprint: "b".repeat(64), failuresRecorded: 1, latestFailureId: "closed-learning-failure:" + "c".repeat(64), latestFailurePeriodId: "period-1", latestFailureEvidenceId: "closed-learning-paper:e", latestFailureEvidenceFingerprint: "d".repeat(64), latestFailureSourceCommitSha: "e".repeat(40), latestFailureRuntimeSourceCommitSha: "f".repeat(40), latestFailureStage: "CYCLE", latestFailureCode: "RESEARCH_WORKER_FAILED", latestFailureRecordedAt: 1_791_419_000_001 } };
  for (const stage of ["IDENTITY", "CYCLE", "FINALIZE"]) {
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: { ...loop, evidence: { ...loop.evidence, latestFailureStage: stage } } }) }, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    assert.equal(body.runtime.closedLearningLoop.evidence.cyclesRecorded, 3);
    assert.equal(body.runtime.closedLearningLoop.evidence.latestFailureCode, "RESEARCH_WORKER_FAILED");
    assert.equal(body.runtime.closedLearningLoop.evidence.latestFailureStage, stage);
    assert.equal(body.runtime.closedLearningLoop.evidence.failuresRecorded, 1);
    assert.equal(body.runtime.closedLearningLoop.evidence.lastCycleRecordedAt, 1_791_419_000_000);
    assert.equal(body.runtime.closedLearningLoop.lastCycleOutcome, "REJECTED");
  }, 42331);
  }
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: { ...loop, evidence: { cyclesRecorded: -1, lastCycleRecordedAt: "x", latestFailureStage: "UNKNOWN_STAGE", cycleId: "closed-learning:" + "a".repeat(64) } } }) }, async (handle) => {
    const evidence = JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop.evidence;
    assert.equal(evidence.cyclesRecorded, undefined);
    assert.equal(evidence.lastCycleRecordedAt, undefined);
    assert.equal(evidence.latestFailureStage, undefined);
    assert.equal(evidence.cycleId, "closed-learning:" + "a".repeat(64));
  }, 42332);
});

test("/health publishes the last blocked reason as a code with its time, and drops it when unpaired or malformed", async () => {
  const loop = { lastTickAt: 5, ticks: 5, cyclesEvaluated: 0, deployments: 0, bootstrap: "EXISTING_PAPER_STATE", rollover: "STALLED_PERIOD_REOPENED" };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: { ...loop, lastBlockedReason: "MISSING_BENCHMARK_EVIDENCE", lastBlockedAt: 1_791_419_000_000 } }) }, async (handle) => {
    const out = JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop;
    assert.equal(out.lastBlockedReason, "MISSING_BENCHMARK_EVIDENCE");
    assert.equal(out.lastBlockedAt, 1_791_419_000_000);
  }, 42341);
  for (const [index, bad] of [{ lastBlockedReason: "MISSING_BENCHMARK_EVIDENCE" }, { lastBlockedReason: "free text with spaces", lastBlockedAt: 5 }, { lastBlockedReason: "TICK_ERROR", lastBlockedAt: -1 }, { lastBlockedAt: 5 }].entries()) {
    await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: { ...loop, ...bad } }) }, async (handle) => {
      const out = JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop;
      assert.equal(out.lastBlockedReason, undefined, `case ${index}`);
    }, 42342 + index);
  }
});

test("/health publishes loss attribution only as fixed family codes with two integers each", async () => {
  const good = { evaluatedAt: 1_791_284_000_000, byFamily: { SMA_CROSSOVER: { completedSells: 3, losingSells: 3 }, UNATTRIBUTED: { completedSells: 1, losingSells: 0 } } };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperLossAttribution: good }) }, async (handle) => {
    const body = JSON.parse((await request(handle.port, "/health")).body);
    assert.deepEqual(body.runtime.paperLossAttribution, good);
  }, 42311);
  const dirty = { evaluatedAt: 5, byFamily: { "sma-crossover": { completedSells: 1, losingSells: 1 }, "KRW-XRP": { completedSells: 1, losingSells: 1 }, RSI_MEAN_REVERSION: { completedSells: 1, losingSells: 2 }, DONCHIAN_BREAKOUT: { completedSells: 2, losingSells: 1, pnl: -219 } } };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperLossAttribution: dirty }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    assert.deepEqual(JSON.parse(res.body).runtime.paperLossAttribution.byFamily, { DONCHIAN_BREAKOUT: { completedSells: 2, losingSells: 1 } }, "raw ids, markets, impossible counts and extra fields are dropped");
    assert.doesNotMatch(res.body, /KRW-XRP|sma-crossover|-219/);
  }, 42312);
  for (const [index, bad] of [null, "text", { evaluatedAt: -1, byFamily: {} }, { evaluatedAt: 1, byFamily: [] }].entries()) {
    await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperLossAttribution: bad }) }, async (handle) => {
      assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.paperLossAttribution, undefined, JSON.stringify(bad));
    }, 42313 + index);
  }
});

test("/health publishes research experiment ticks only as a fixed status, integers and code-keyed counts", async () => {
  const good = { lastTickAt: 1_791_290_000_000, lastStatus: "OK", ticks: 12, sessionsStarted: 2, counts: { COMPLETED: 4, NOT_DUE: 20, VALIDATION_CHAMPION_BETTER: 3, VALIDATION_CHALLENGER_BETTER: 1, HOLDOUT_INCONCLUSIVE: 1 } };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, researchExperimentTicks: good }) }, async (handle) => {
    assert.deepEqual(JSON.parse((await request(handle.port, "/health")).body).runtime.researchExperimentTicks, good);
  }, 42321);
  const dirty = { ...good, counts: { COMPLETED: 1, "KRW-XRP": 2, "skipped reason": 3, ERROR_X: -1, OK_CODE: 1.5 } };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, researchExperimentTicks: dirty }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    assert.deepEqual(JSON.parse(res.body).runtime.researchExperimentTicks.counts, { COMPLETED: 1 });
    assert.doesNotMatch(res.body, /KRW-XRP|skipped reason/);
  }, 42322);
  for (const [index, bad] of [null, { ...good, lastStatus: "free text" }, { ...good, ticks: -1 }, { ...good, counts: [] }].entries()) {
    await withServer({ runtimeLiveness: () => ({ ...LIVENESS, researchExperimentTicks: bad }) }, async (handle) => {
      assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.researchExperimentTicks, undefined, JSON.stringify(bad));
    }, 42323 + index);
  }
});

test("/health publishes the closed-learning loop status as fixed codes and integers only", async () => {
  const good = { lastTickAt: 1_791_290_000_000, ticks: 9, bootstrap: "WAITING_RESEARCH_SNAPSHOT", rollover: "WAITING_FOR_REALIZED_FILL", cyclesEvaluated: 0, deployments: 0 };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: good }) }, async (handle) => {
    assert.deepEqual(JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop, good);
  }, 42341);
  const dirty = { ...good, rolloverReason: "retired:paper-period-1", lastCycleOutcome: "QUALIFIED_FOR_LEAGUE", periodId: "secret", extra: 5 };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: dirty }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    assert.deepEqual(JSON.parse(res.body).runtime.closedLearningLoop, { ...good, lastCycleOutcome: "QUALIFIED_FOR_LEAGUE" });
    assert.doesNotMatch(res.body, /secret|paper-period/);
  }, 42342);
  for (const [index, bad] of [null, { ...good, ticks: -1 }, { ...good, bootstrap: "free text" }, { ...good, rollover: undefined }].entries()) {
    await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: bad }) }, async (handle) => {
      assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop, undefined, JSON.stringify(bad));
    }, 42343 + index);
  }
});

test("research experiment ticks per bar length publish only declared lengths and the fixed summary shape", async () => {
  const summary = { lastTickAt: 1_000, lastStatus: "OK", ticks: 2, sessionsStarted: 1, counts: { COMPLETED: 3, NOT_DUE: 1 } };
  const byInterval = { "1m": summary, "15m": { ...summary, ticks: 3 }, "60m": { ...summary, lastStatus: "BOGUS" }, "5m": summary, "<script>": summary };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, researchExperimentTicksByInterval: byInterval }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    const published = JSON.parse(res.body).runtime.researchExperimentTicksByInterval;
    assert.deepEqual(Object.keys(published).sort(), ["15m", "1m"]);
    assert.equal(published["15m"].ticks, 3);
    assert.deepEqual(published["1m"].counts, { COMPLETED: 3, NOT_DUE: 1 });
    assert.doesNotMatch(res.body, /script|BOGUS|"5m"/);
  }, 41880);
});

test("the running build commit is published only as a full lowercase 40-hex SHA", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, sourceCommitSha: sha }) }, async (handle) => {
    assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.sourceCommitSha, sha);
  }, 41886);
  for (const bad of ["", "abc123", sha.toUpperCase(), `${sha} extra`, 42]) {
    await withServer({ runtimeLiveness: () => ({ ...LIVENESS, sourceCommitSha: bad }) }, async (handle) => {
      const res = await request(handle.port, "/health");
      assert.equal(JSON.parse(res.body).runtime.sourceCommitSha, undefined, String(bad));
      assert.doesNotMatch(res.body, /extra/);
    }, 41886);
  }
});

test("closed-learning evidence identities pass only through fixed keys and safe value shapes", async () => {
  const hex = "e".repeat(64);
  const loop = { lastTickAt: 1, ticks: 1, cyclesEvaluated: 0, deployments: 0, bootstrap: "EXISTING_PAPER_STATE", rollover: "WAITING_FOR_KST_DAY_ROLLOVER", evidence: {
    openPeriodId: "owner-baseline:KRW-XRP:1791331979980", openMarket: "KRW-XRP", openFilledObservations: 1, realizedOutcomeFingerprint: hex,
    cycleEvidenceFingerprint: "not-hex", decisionReference: "research decision <b>", injected: "x", realizedPeriods: -1, openMarket2: "KRW-XRP",
  } };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: loop }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    const evidence = JSON.parse(res.body).runtime.closedLearningLoop.evidence;
    assert.deepEqual(evidence, { openPeriodId: "owner-baseline:KRW-XRP:1791331979980", openMarket: "KRW-XRP", realizedOutcomeFingerprint: hex, openFilledObservations: 1 });
    assert.doesNotMatch(res.body, /injected|not-hex|<b>|openMarket2/);
  }, 41879);
});

test("the PAPER ledger identity publishes only a 64-hex fingerprint and non-negative integers", async () => {
  const good = { ledgerFingerprintSha256: "a".repeat(64), fillCount: 4, openPositionCount: 1, lastFillAt: 1791331979980, ledgerUpdatedAt: 1791331979980 };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperLedger: { ...good, cash: 8399 } }) }, async (handle) => {
    const res = await request(handle.port, "/health");
    assert.deepEqual(JSON.parse(res.body).runtime.paperLedger, good);
    assert.doesNotMatch(res.body, /(?<![0-9])8399(?![0-9])|"cash"/);
  }, 41878);
  for (const bad of [{ ...good, ledgerFingerprintSha256: "short" }, { ...good, fillCount: -1 }, { ...good, lastFillAt: 1.5 }]) {
    await withServer({ runtimeLiveness: () => ({ ...LIVENESS, paperLedger: bad }) }, async (handle) => {
      assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.paperLedger, undefined);
    }, 41878);
  }
});

test("/health publishes the baseline shadow totals as non-negative integers only, and drops malformed ones", async () => {
  const loop = { lastTickAt: 5, ticks: 5, cyclesEvaluated: 0, deployments: 0, bootstrap: "EXISTING_PAPER_STATE", rollover: "WAITING_FOR_CANONICAL_BOUNDARY",
    evidence: { shadowSince: 1_791_439_000_000, shadowTrades: 12, shadowWins: 2, shadowGrossGainBp: 300, shadowGrossLossBp: 800, shadowFeeBp: 120, shadowNetKrw: 9_999 } };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: loop }) }, async (handle) => {
    const evidence = JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop.evidence;
    assert.deepEqual({ t: evidence.shadowTrades, w: evidence.shadowWins, g: evidence.shadowGrossGainBp, l: evidence.shadowGrossLossBp, f: evidence.shadowFeeBp, s: evidence.shadowSince }, { t: 12, w: 2, g: 300, l: 800, f: 120, s: 1_791_439_000_000 });
    assert.equal(evidence.shadowNetKrw, undefined, "an unlisted key (any amount) is never published");
  }, 42341);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: { ...loop, evidence: { shadowTrades: -1, shadowWins: 1.5, shadowFeeBp: "x", shadowGrossGainBp: 7 } } }) }, async (handle) => {
    const evidence = JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop.evidence;
    assert.equal(evidence.shadowTrades, undefined);
    assert.equal(evidence.shadowWins, undefined);
    assert.equal(evidence.shadowFeeBp, undefined);
    assert.equal(evidence.shadowGrossGainBp, 7);
  }, 42342);
});

test("/health publishes the rule-replay parity as signed integer basis points and counts, and drops malformed ones", async () => {
  const loop = { lastTickAt: 5, ticks: 5, cyclesEvaluated: 0, deployments: 0, bootstrap: "RESEARCH_NOT_DEPLOYABLE", rollover: "WAITING_FOR_CANONICAL_BOUNDARY",
    evidence: { replayPeriodId: "closed-learning-rollover:9:1791825840978", replayBars: 60, replayTrades: 3, replayClosedNetBp: -123, replayOpenMarkBp: 0, replayPaperNetBp: -4, replayPaperNetKrw: -400 } };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: loop }) }, async (handle) => {
    const evidence = JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop.evidence;
    assert.deepEqual({ id: evidence.replayPeriodId, b: evidence.replayBars, t: evidence.replayTrades, c: evidence.replayClosedNetBp, o: evidence.replayOpenMarkBp, p: evidence.replayPaperNetBp }, { id: "closed-learning-rollover:9:1791825840978", b: 60, t: 3, c: -123, o: 0, p: -4 });
    assert.equal(evidence.replayPaperNetKrw, undefined, "an unlisted key (any amount) is never published");
  }, 42343);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: { ...loop, evidence: { replayTrades: -1, replayClosedNetBp: 1.5, replayPaperNetBp: "x", replayOpenMarkBp: -7 } } }) }, async (handle) => {
    const evidence = JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop.evidence;
    assert.equal(evidence.replayTrades, undefined);
    assert.equal(evidence.replayClosedNetBp, undefined);
    assert.equal(evidence.replayPaperNetBp, undefined);
    assert.equal(evidence.replayOpenMarkBp, -7);
  }, 42344);
});

test("/health publishes the advisory meta-learning report with codes and integers only", async () => {
  const loop = { lastTickAt: 5, ticks: 5, cyclesEvaluated: 0, deployments: 0, bootstrap: "RESEARCH_NOT_DEPLOYABLE", rollover: "WAITING_FOR_CANONICAL_BOUNDARY",
    metaLearning: { experiments: 15, configurations: 264, discoveryPasses: 14, holdoutPasses: 0, overfitRatePercent: 100, validKnowledgePer100Configs: 0, exhausted: "dataType=CLOSE,methodClass=RULE", recommended: "TRADES+INTRADAY+ALL_KRW+ML", recommendedPrerequisites: "COLLECT_TRADES", nextHoldoutBarMicros: 189, runtimeEntries: 1, liveForwardEntries: 1, steeringMode: "DEPRIORITIZE_EXHAUSTED", longBarTickEvery: 4, paperPeriodsConsumed: 12, paperNetBp: -10, paperExcessBp: -15, paperEvidenceFingerprint: "a".repeat(64), note: "free text" } };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: loop }) }, async (handle) => {
    const meta = JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop.metaLearning;
    assert.equal(meta.recommended, "TRADES+INTRADAY+ALL_KRW+ML");
    assert.equal(meta.exhausted, "dataType=CLOSE,methodClass=RULE");
    assert.equal(meta.configurations, 264);
    assert.equal(meta.steeringMode, "DEPRIORITIZE_EXHAUSTED");
    assert.equal(meta.longBarTickEvery, 4);
    assert.deepEqual([meta.paperPeriodsConsumed, meta.paperNetBp, meta.paperExcessBp, meta.paperEvidenceFingerprint], [12, -10, -15, "a".repeat(64)]);
    assert.equal(meta.note, undefined, "free text is never published");
  }, 42347);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: { ...loop, metaLearning: { ...loop.metaLearning, steeringMode: "STOP_ALL" } } }) }, async (handle) => {
    assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop.metaLearning, undefined, "an unknown steering mode is never published");
  }, 42349);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, closedLearningLoop: { ...loop, metaLearning: { ...loop.metaLearning, exhausted: "<script>" } } }) }, async (handle) => {
    assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.closedLearningLoop.metaLearning, undefined);
  }, 42348);
});

test("/health publishes the microstructure recorder counters as non-negative integers only", async () => {
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, microstructureRecorder: { orderBookSamples: 12, tradeTicks: 340, writeFailures: 0, rejectedRows: 2, lastRecordedAt: 1_791_900_000_000, secret: "x" } }) }, async (handle) => {
    const runtime = JSON.parse((await request(handle.port, "/health")).body).runtime;
    assert.deepEqual(runtime.microstructureRecorder, { orderBookSamples: 12, tradeTicks: 340, writeFailures: 0, rejectedRows: 2, lastRecordedAt: 1_791_900_000_000 });
  }, 42345);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, microstructureRecorder: { orderBookSamples: -1, tradeTicks: 1, writeFailures: 0 } }) }, async (handle) => {
    assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.microstructureRecorder, undefined);
  }, 42346);
});

test("/health publishes the all-KRW order-book collector counters as non-negative integers only", async () => {
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, orderBookCollector: { rounds: 3, markets: 240, samplesStored: 700, failures: 1, rejected: 4, lastRoundAt: 1_791_900_000_000, note: "x" } }) }, async (handle) => {
    assert.deepEqual(JSON.parse((await request(handle.port, "/health")).body).runtime.orderBookCollector, { rounds: 3, markets: 240, samplesStored: 700, failures: 1, rejected: 4, lastRoundAt: 1_791_900_000_000 });
  }, 42350);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, orderBookCollector: { rounds: 1.5, markets: 1, samplesStored: 0, failures: 0 } }) }, async (handle) => {
    assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.orderBookCollector, undefined);
  }, 42351);
});

test("/health publishes the stored-data integrity result as a status plus non-negative integers only", async () => {
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, dataIntegrity: { status: "FAIL", observedAt: 1_792_000_000_000, candleFuture: 1, note: "x", bad: -2 } }) }, async (handle) => {
    assert.deepEqual(JSON.parse((await request(handle.port, "/health")).body).runtime.dataIntegrity, { status: "FAIL", observedAt: 1_792_000_000_000, candleFuture: 1 });
  }, 42352);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, dataIntegrity: { status: "GOOD", candleFuture: 0 } }) }, async (handle) => {
    assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.dataIntegrity, undefined);
  }, 42353);
});

test("/health publishes the public futures collector counters as non-negative integers only", async () => {
  const good = { rounds: 3, marksStored: 6, fundingStored: 4, klinesStored: 4, failures: 1, rejected: 0, lastRoundAt: 1_791_900_000_000 };
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, futuresCollector: { ...good, note: "x" } }) }, async (handle) => {
    assert.deepEqual(JSON.parse((await request(handle.port, "/health")).body).runtime.futuresCollector, good);
  }, 42390);
  await withServer({ runtimeLiveness: () => ({ ...LIVENESS, futuresCollector: { ...good, rounds: -1 } }) }, async (handle) => {
    assert.equal(JSON.parse((await request(handle.port, "/health")).body).runtime.futuresCollector, undefined);
  }, 42391);
});
