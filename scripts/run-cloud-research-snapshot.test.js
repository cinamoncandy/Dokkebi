"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { buildResearchEnv, DEFAULT_COST_MODEL_VERSION, run } = require("./run-cloud-research-snapshot.js");

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

test("maps exact deployed source SHA and durable snapshot path into canonical Research env", () => {
  const env = buildResearchEnv({
    NUSA_SOURCE_COMMIT: SHA,
    NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite"),
  });
  assert.equal(env.NUSA_SOURCE_COMMIT_SHA, SHA);
  assert.equal(env.NUSA_RESEARCH_COST_MODEL_VERSION, DEFAULT_COST_MODEL_VERSION);
  assert.equal(env.NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH, path.resolve("/var/lib/nusa/research-replay-snapshots.json"));
  assert.equal(env.NUSA_RESEARCH_LEARNING_LEDGER_PATH, path.resolve("/var/lib/nusa/research-investment-learning.jsonl"));
});
test("forward timeout/nonzero failures remain explicit while independent canonical Research proceeds", () => {
  for (const failure of [{ error: { code: "ETIMEDOUT" } }, { status: 1 }, { error: { code: "ENOENT" } }]) {
    let calls = 0;
    const result = run({ env: { NUSA_SOURCE_COMMIT: SHA, NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite") },
      spawnSync: () => ++calls === 1 ? failure : { status: 0 } });
    assert.equal(calls, 7); assert.equal(result.forwardExecution, "FAILED"); assert.ok(result.forwardFailure);
  }
});

test("an order-book study failure is logged and never blocks canonical Research", () => {
  let calls = 0;
  const result = run({ env: { NUSA_SOURCE_COMMIT: SHA, NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite") },
    spawnSync: () => ++calls === 2 ? { status: 1 } : { status: 0 } });
  assert.equal(calls, 7); assert.equal(result.status, "COMPLETED");
});

test("a trade-flow study failure is logged and never blocks canonical Research", () => {
  let calls = 0;
  const result = run({ env: { NUSA_SOURCE_COMMIT: SHA, NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite") },
    spawnSync: (executable, args) => (args.includes("scripts/run-tradeflow-study.js") ? (calls += 1, { status: 1 }) : { status: 0 }) });
  assert.equal(calls, 2, "both pre-registered studies are attempted even if each fails"); assert.equal(result.status, "COMPLETED");
});

test("each trade-flow study failure is logged with its own version", () => {
  const messages = [];
  const original = console.error;
  console.error = (...args) => { messages.push(args.join(" ")); };
  try {
    run({ env: { NUSA_SOURCE_COMMIT: SHA, NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite") },
      spawnSync: (executable, args, options) => (args.includes("scripts/run-tradeflow-study.js") && options.env.NUSA_TRADEFLOW_STUDY_ID === "ML_TRADEFLOW_60M_20261114" ? { status: 1 } : { status: 0 }) });
  } finally { console.error = original; }
  assert.deepEqual(messages.filter((m) => m.includes("TRADEFLOW_STUDY_FAILED_CLOSED")), ["[cloud-research-snapshot] TRADEFLOW_STUDY_FAILED_CLOSED:V2"]);
});

test("accepts matching deployed source commit identities", () => {
  const env = buildResearchEnv({
    NUSA_SOURCE_COMMIT: SHA.toUpperCase(),
    NUSA_SOURCE_COMMIT_SHA: ` ${SHA} `,
    NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite"),
  });
  assert.equal(env.NUSA_SOURCE_COMMIT_SHA, SHA);
});

test("preserves an explicit cost-model identity and absolute snapshot path", () => {
  const env = buildResearchEnv({
    NUSA_SOURCE_COMMIT_SHA: SHA,
    NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite"),
    NUSA_RESEARCH_COST_MODEL_VERSION: "declared-cost-v9",
    NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH: path.resolve("/srv/nusa/research.json"),
    NUSA_RESEARCH_LEARNING_LEDGER_PATH: path.resolve("/srv/nusa/learning.jsonl"),
  });
  assert.equal(env.NUSA_RESEARCH_COST_MODEL_VERSION, "declared-cost-v9");
  assert.equal(env.NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH, path.resolve("/srv/nusa/research.json"));
  assert.equal(env.NUSA_RESEARCH_LEARNING_LEDGER_PATH, path.resolve("/srv/nusa/learning.jsonl"));
});

test("fails closed when deployed source commit identities disagree", () => {
  assert.throws(() => buildResearchEnv({
    NUSA_SOURCE_COMMIT: SHA,
    NUSA_SOURCE_COMMIT_SHA: OTHER_SHA,
    NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite"),
  }), /NUSA_SOURCE_COMMIT and NUSA_SOURCE_COMMIT_SHA disagree/);
});

test("fails closed on missing source identity or non-durable state", () => {
  assert.throws(() => buildResearchEnv({ NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite") }), /exact NUSA_SOURCE_COMMIT/);
  assert.throws(() => buildResearchEnv({ NUSA_SOURCE_COMMIT: SHA, NUSA_CLOUD_STATE_DB_PATH: ":memory:" }), /durable Cloud state/);
  assert.throws(() => buildResearchEnv({ NUSA_SOURCE_COMMIT: SHA, NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite"), NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH: "relative.json" }), /absolute and durable/);
  assert.throws(() => buildResearchEnv({ NUSA_SOURCE_COMMIT: SHA, NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite"), NUSA_RESEARCH_LEARNING_LEDGER_PATH: "relative.jsonl" }), /learning ledger path must be absolute and durable/);
});

test("runs bounded forward study then canonical preload + real public-market Research script", () => {
  let observed;
  const calls = [];
  const result = run({
    env: { NUSA_SOURCE_COMMIT: SHA, NUSA_CLOUD_STATE_DB_PATH: path.resolve("/var/lib/nusa/state.sqlite") },
    cwd: path.resolve("/opt/nusa/current"),
    executable: path.resolve("/usr/bin/node"),
    spawnSync: (executable, args, options) => {
      observed = { executable, args, options };
      calls.push(observed);
      return { status: 0, signal: null };
    },
  });
  assert.equal(result.status, "COMPLETED");
  assert.equal(calls.length, 7);
  assert.deepEqual(calls[0].args, ["--max-old-space-size=256", "scripts/run-regime-forward-study.js"]);
  assert.equal(calls[0].options.timeout, 120000);
  assert.deepEqual(calls[1].args, ["--max-old-space-size=256", "scripts/run-orderbook-study.js"]);
  assert.equal(calls[1].options.timeout, 600000);
  assert.deepEqual(calls[2].args, ["--max-old-space-size=256", "scripts/run-data-integrity-probe.js"]);
  assert.equal(calls[2].options.timeout, 120000);
  assert.deepEqual(calls[3].args, ["--max-old-space-size=256", "scripts/run-raim-study.js"]);
  assert.equal(calls[3].options.timeout, 600000);
  assert.deepEqual(calls[4].args, ["--max-old-space-size=256", "scripts/run-tradeflow-study.js"]);
  assert.equal(calls[4].options.timeout, 600000);
  assert.equal(calls[4].options.env.NUSA_TRADEFLOW_STUDY_ID, "ML_TRADEFLOW_60M_20261113");
  assert.deepEqual(calls[5].args, ["--max-old-space-size=256", "scripts/run-tradeflow-study.js"]);
  assert.equal(calls[5].options.timeout, 600000);
  assert.equal(calls[5].options.env.NUSA_TRADEFLOW_STUDY_ID, "ML_TRADEFLOW_60M_20261114");
  assert.equal(result.learningLedgerPath, path.resolve("/var/lib/nusa/research-investment-learning.jsonl"));
  assert.equal(observed.executable, path.resolve("/usr/bin/node"));
  assert.deepEqual(observed.args, ["--max-old-space-size=256", "-r", "./scripts/research-replay-snapshot-capture.js", "scripts/research-real-market-run.js"]);
  assert.ok(calls.every(call => call.args[0] === "--max-old-space-size=256"), "each spawned Research Node process must carry the bounded heap directly");
  assert.equal(observed.options.shell, false);
});
