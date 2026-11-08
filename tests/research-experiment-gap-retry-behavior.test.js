const test = require("node:test");
const assert = require("node:assert/strict");

const { SqliteDatabase } = require("../dist/packages/storage/src/index.js");
const { composeResearchExperiments, RESEARCH_FLAG, RESEARCH_GAP_FILL_INTERVAL_MS } = require("../dist/apps/cloud/src/researchExperimentComposition.js");

const NOW = Date.UTC(2026, 9, 19, 10, 0, 0);

function installFakeTimers() {
  const originals = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    setImmediate: global.setImmediate,
    clearImmediate: global.clearImmediate,
  };
  let id = 0;
  const timeouts = [];
  const intervals = [];
  const immediates = [];
  const handle = (fn, delay) => ({ id: ++id, fn, delay, cleared: false, ran: false, unref() { return this; } });
  global.setTimeout = (fn, delay = 0, ...args) => {
    const item = handle(() => fn(...args), delay);
    timeouts.push(item);
    return item;
  };
  global.clearTimeout = (item) => { if (item != null) item.cleared = true; };
  global.setInterval = (fn, delay = 0, ...args) => {
    const item = handle(() => fn(...args), delay);
    intervals.push(item);
    return item;
  };
  global.clearInterval = (item) => { if (item != null) item.cleared = true; };
  global.setImmediate = (fn, ...args) => {
    const item = handle(() => fn(...args), 0);
    immediates.push(item);
    return item;
  };
  global.clearImmediate = (item) => { if (item != null) item.cleared = true; };
  const run = (item) => {
    if (item == null || item.cleared || item.ran) return false;
    item.ran = true;
    item.fn();
    return true;
  };
  return {
    timeouts,
    intervals,
    immediates,
    run,
    restore() { Object.assign(global, originals); },
  };
}

async function drainCooperativeTick(promise, timers) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let guard = 0; guard < 100 && !settled; guard += 1) {
    const next = timers.immediates.find((item) => !item.cleared && !item.ran);
    if (next != null) timers.run(next);
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(settled, true, "cooperative tick must settle after bounded event-loop turns");
  return promise;
}

function compose(db, lines) {
  const composition = composeResearchExperiments({
    env: { [RESEARCH_FLAG]: "1", NUSA_SOURCE_COMMIT_SHA: "b".repeat(40), NUSA_RESEARCH_BACKFILL: "ENABLED" },
    database: db,
    now: () => NOW,
    log: (line) => lines.push(line),
    fetchImpl: async () => { throw new Error("gap retry test must not need network data"); },
    sleep: async () => undefined,
  });
  assert.ok(composition);
  assert.equal(composition.orchestrator.recover().status, "READY");
  return composition;
}

test("phase-aligned periodic gap repair retries after a cooperative Research tick and executes exactly once", async () => {
  const db = new SqliteDatabase(":memory:");
  const lines = [];
  const composition = compose(db, lines);
  const timers = installFakeTimers();
  try {
    composition.start();
    const gapInterval = timers.intervals.find((item) => item.delay === RESEARCH_GAP_FILL_INTERVAL_MS);
    assert.ok(gapInterval, "the configured periodic gap repair must be scheduled");

    const tick = composition.tickOnceAsync();
    assert.ok(timers.immediates.some((item) => !item.ran), "cooperative tick must be active at an event-loop yield");
    timers.run(gapInterval);

    const retry = timers.timeouts.find((item) => item.delay === 1_000);
    assert.ok(retry, "a collision with the active Research tick must schedule a bounded gap retry");
    assert.equal(lines.filter((line) => line.startsWith("[research-gap-fill]")).length, 0, "gap repair must not interleave with the active tick");

    await drainCooperativeTick(tick, timers);
    assert.equal(timers.run(retry), true, "the deferred retry must run after the tick becomes idle");
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(lines.filter((line) => line.startsWith("[research-gap-fill] KRW-BTC NO_GAPS")).length, 1, "deferred periodic repair executes once after the collision clears");
    assert.equal(timers.run(retry), false, "the one-shot retry cannot execute twice");
  } finally {
    composition.stop();
    timers.restore();
    db.close();
  }
});

test("stop cancels a pending periodic gap retry created by a Research tick collision", async () => {
  const db = new SqliteDatabase(":memory:");
  const lines = [];
  const composition = compose(db, lines);
  const timers = installFakeTimers();
  try {
    composition.start();
    const gapInterval = timers.intervals.find((item) => item.delay === RESEARCH_GAP_FILL_INTERVAL_MS);
    assert.ok(gapInterval);

    const tick = composition.tickOnceAsync();
    timers.run(gapInterval);
    const retry = timers.timeouts.find((item) => item.delay === 1_000);
    assert.ok(retry, "collision must create a retry before stop");

    composition.stop();
    assert.equal(retry.cleared, true, "stop must cancel the pending gap retry");
    assert.equal(timers.run(retry), false, "a cancelled retry must never run");
    await drainCooperativeTick(tick, timers);
    assert.equal(lines.filter((line) => line.startsWith("[research-gap-fill]")).length, 0, "stop prevents deferred gap repair side effects");
  } finally {
    composition.stop();
    timers.restore();
    db.close();
  }
});
