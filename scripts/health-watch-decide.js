"use strict";
// Pure decision for the off-host health watch. Read-only: it only classifies one probe result.
// expectedState STOPPED: an answering host is the alarm (an unexpected start). RUNNING: a silent host is the alarm.
const EXPECTED = new Set(["STOPPED", "RUNNING"]);
const MAX_OBSERVATION_AGE_MS = 10 * 60 * 1000;

function classifyProbe(probe, nowMs) {
  if (probe === null || typeof probe !== "object") return { answering: false, reason: "NO_PROBE" };
  if (probe.httpStatus !== 200) return { answering: false, reason: `HTTP_${Number.isInteger(probe.httpStatus) ? probe.httpStatus : "NONE"}` };
  let body;
  try { body = JSON.parse(String(probe.body ?? "")); } catch { return { answering: false, reason: "BODY_NOT_JSON" }; }
  if (body === null || typeof body !== "object" || body.ok !== true) return { answering: false, reason: "OK_NOT_TRUE" };
  const observedAt = Date.parse(String(body.observedAt ?? ""));
  if (!Number.isFinite(observedAt)) return { answering: false, reason: "OBSERVED_AT_MISSING" };
  if (observedAt > nowMs + 60_000 || nowMs - observedAt > MAX_OBSERVATION_AGE_MS) return { answering: false, reason: "OBSERVED_AT_STALE" };
  return { answering: true, reason: "ANSWERING" };
}

function decide(expectedState, probe, nowMs) {
  if (!EXPECTED.has(expectedState)) return { alert: "CONFIG_INVALID", reason: "expectedState must be STOPPED or RUNNING" };
  const result = classifyProbe(probe, nowMs);
  if (expectedState === "RUNNING") return result.answering ? { alert: "NONE", reason: result.reason } : { alert: "DOWN", reason: result.reason };
  return result.answering ? { alert: "UNEXPECTED_UP", reason: result.reason } : { alert: "NONE", reason: result.reason };
}

module.exports = { decide, classifyProbe, MAX_OBSERVATION_AGE_MS };

if (require.main === module) {
  const fs = require("node:fs");
  const [configPath, httpStatus, bodyPath] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const body = bodyPath && fs.existsSync(bodyPath) ? fs.readFileSync(bodyPath, "utf8").slice(0, 100_000) : "";
  const result = decide(config.expectedState, { httpStatus: Number(httpStatus), body }, Date.now());
  process.stdout.write(`${result.alert} ${result.reason}\n`);
}
