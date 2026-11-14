"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SHA40 = /^[a-f0-9]{40}$/;
const DEFAULT_COST_MODEL_VERSION = "nusa-paper-cost-v1";
const RESEARCH_MAX_OLD_SPACE_ARG = "--max-old-space-size=256";

function buildResearchEnv(source = process.env) {
  const env = { ...source };
  const sourceCommitSha = String(env.NUSA_SOURCE_COMMIT_SHA || "").trim().toLowerCase();
  const sourceCommit = String(env.NUSA_SOURCE_COMMIT || "").trim().toLowerCase();
  if (sourceCommitSha && sourceCommit && sourceCommitSha !== sourceCommit) {
    throw new Error("NUSA_SOURCE_COMMIT and NUSA_SOURCE_COMMIT_SHA disagree");
  }
  const resolvedSourceCommit = sourceCommitSha || sourceCommit;
  if (!SHA40.test(resolvedSourceCommit)) throw new Error("cloud Research snapshot requires exact NUSA_SOURCE_COMMIT(_SHA)");
  env.NUSA_SOURCE_COMMIT_SHA = resolvedSourceCommit;
  if (!String(env.NUSA_RESEARCH_COST_MODEL_VERSION || "").trim()) {
    env.NUSA_RESEARCH_COST_MODEL_VERSION = DEFAULT_COST_MODEL_VERSION;
  }
  const stateDb = String(env.NUSA_CLOUD_STATE_DB_PATH || "").trim();
  const snapshotPath = String(env.NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH || "").trim();
  if (!snapshotPath) {
    if (!path.isAbsolute(stateDb) || stateDb === ":memory:") throw new Error("cloud Research snapshot requires a durable Cloud state path");
    env.NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH = path.join(path.dirname(stateDb), "research-replay-snapshots.json");
  } else if (!path.isAbsolute(snapshotPath) || snapshotPath === ":memory:") {
    throw new Error("cloud Research snapshot path must be absolute and durable");
  }
  const learningLedgerPath = String(env.NUSA_RESEARCH_LEARNING_LEDGER_PATH || "").trim();
  if (!learningLedgerPath) {
    env.NUSA_RESEARCH_LEARNING_LEDGER_PATH = path.join(path.dirname(env.NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH), "research-investment-learning.jsonl");
  } else if (!path.isAbsolute(learningLedgerPath) || learningLedgerPath === ":memory:") {
    throw new Error("cloud Research investment learning ledger path must be absolute and durable");
  }
  return env;
}

function run(options = {}) {
  const env = buildResearchEnv(options.env ?? process.env);
  const cwd = options.cwd ?? process.cwd();
  const executable = options.executable ?? process.execPath;
  const spawn = options.spawnSync ?? spawnSync;
  // One bounded child on the existing Research cadence. It cannot emit deployment authority.
  const forward = spawn(executable, [RESEARCH_MAX_OLD_SPACE_ARG, "scripts/run-regime-forward-study.js"], { cwd, env, stdio: "inherit", shell: false, timeout: 120000 });
  const forwardFailure = forward.error?.code === "ETIMEDOUT" || forward.signal ? "TIMEOUT_OR_SIGNAL" : forward.error ? "SPAWN_ERROR" : forward.status !== 0 ? "NONZERO_EXIT" : null;
  if (forwardFailure) console.error(`[cloud-research-snapshot] FORWARD_STUDY_FAILED_CLOSED:${forwardFailure}`);
  // Pre-registered ORDERBOOK study (read-only; WAITING_DATA until its span is collected). Its failure never blocks Research.
  const orderbook = spawn(executable, [RESEARCH_MAX_OLD_SPACE_ARG, "scripts/run-orderbook-study.js"], { cwd, env, stdio: "inherit", shell: false, timeout: 600000 });
  const orderbookFailure = orderbook.error?.code === "ETIMEDOUT" || orderbook.signal ? "TIMEOUT_OR_SIGNAL" : orderbook.error ? "SPAWN_ERROR" : orderbook.status !== 0 ? "NONZERO_EXIT" : null;
  if (orderbookFailure) console.error(`[cloud-research-snapshot] ORDERBOOK_STUDY_FAILED_CLOSED:${orderbookFailure}`);
  // Read-only runtime evidence of the stored research data (never blocks Research).
  const integrity = spawn(executable, [RESEARCH_MAX_OLD_SPACE_ARG, "scripts/run-data-integrity-probe.js"], { cwd, env, stdio: "inherit", shell: false, timeout: 120000 });
  if (integrity.error || integrity.signal || integrity.status !== 0) console.error("[cloud-research-snapshot] DATA_INTEGRITY_PROBE_FAILED_CLOSED");
  // Pre-registered RAIM market-making study (read-only; WAITING_DATA until its window is collected). Its failure never blocks Research.
  const raim = spawn(executable, [RESEARCH_MAX_OLD_SPACE_ARG, "scripts/run-raim-study.js"], { cwd, env, stdio: "inherit", shell: false, timeout: 600000 });
  if (raim.error || raim.signal || raim.status !== 0) console.error("[cloud-research-snapshot] RAIM_STUDY_FAILED_CLOSED");
  // Pre-registered TRADEFLOW studies (docs/RESEARCH_PREREG_2026-11-13_TRADEFLOW_60M.md and ..._2026-11-14_..._V2.md; read-only; WAITING_DATA until each span ends). Each run's
  // failure cannot fail Research; a hung run can still delay it by up to its 600 s timeout. Each journal line names its study through `studyVersion`.
  for (const [studyId, version] of [["ML_TRADEFLOW_60M_20261113", 1], ["ML_TRADEFLOW_60M_20261114", 2]]) {
    const tradeflow = spawn(executable, [RESEARCH_MAX_OLD_SPACE_ARG, "scripts/run-tradeflow-study.js"], { cwd, env: { ...env, NUSA_TRADEFLOW_STUDY_ID: studyId }, stdio: "inherit", shell: false, timeout: 600000 });
    if (tradeflow.error || tradeflow.signal || tradeflow.status !== 0) console.error(`[cloud-research-snapshot] TRADEFLOW_STUDY_FAILED_CLOSED:V${version}`);
  }
  const args = [RESEARCH_MAX_OLD_SPACE_ARG, "-r", "./scripts/research-replay-snapshot-capture.js", "scripts/research-real-market-run.js"];
  const result = spawn(executable, args, { cwd, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`cloud Research snapshot terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`cloud Research snapshot failed with exit ${String(result.status)}`);
  return Object.freeze({ status: "COMPLETED", forwardExecution: forwardFailure ? "FAILED" : "COMPLETED_NOT_QUALIFICATION", forwardFailure, sourceCommitSha: env.NUSA_SOURCE_COMMIT_SHA, snapshotPath: env.NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH, learningLedgerPath: env.NUSA_RESEARCH_LEARNING_LEDGER_PATH, costModelVersion: env.NUSA_RESEARCH_COST_MODEL_VERSION });
}

if (require.main === module) {
  try { run(); }
  catch (error) {
    console.error("[cloud-research-snapshot]", error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  }
}

module.exports = { buildResearchEnv, DEFAULT_COST_MODEL_VERSION, run };
