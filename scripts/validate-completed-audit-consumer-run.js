#!/usr/bin/env node
"use strict";

const SHA40 = /^[0-9a-f]{40}$/i;

function validateCompletedAuditConsumerRun(run, expected) {
  if (!run || typeof run !== "object" || Array.isArray(run)) throw new Error("AUDIT_CONSUMER_RUN_INVALID");
  if (!expected || typeof expected !== "object") throw new Error("AUDIT_CONSUMER_EXPECTED_IDENTITY_INVALID");
  if (!Number.isSafeInteger(expected.runId) || expected.runId <= 0 || run.id !== expected.runId) {
    throw new Error("AUDIT_CONSUMER_RUN_ID_MISMATCH");
  }
  if (run.name !== "Autopilot Execution Consumer" || run.path !== ".github/workflows/autopilot-execution-consumer.yml") {
    throw new Error("AUDIT_CONSUMER_WORKFLOW_MISMATCH");
  }
  if (run.event !== "repository_dispatch" || run.repository?.full_name !== expected.repository || run.head_sha !== expected.mainSha) {
    throw new Error("AUDIT_CONSUMER_CONTEXT_MISMATCH");
  }
  if (!SHA40.test(expected.mainSha || "")) throw new Error("AUDIT_CONSUMER_EXPECTED_SHA_INVALID");
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("AUDIT_CONSUMER_NOT_COMPLETED_SUCCESSFULLY");
  }
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error("AUDIT_CONSUMER_ATTEMPT_INVALID");
  return Object.freeze({ runId: run.id, runAttempt: run.run_attempt, headSha: run.head_sha });
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4) throw new Error("usage: validate-completed-audit-consumer-run.js <run-json> <repository> <run-id> <main-sha>");
  const fs = require("node:fs");
  const [runPath, repository, runId, mainSha] = argv;
  const result = validateCompletedAuditConsumerRun(JSON.parse(fs.readFileSync(runPath, "utf8")), {
    repository,
    runId: Number(runId),
    mainSha: String(mainSha).toLowerCase(),
  });
  process.stdout.write(String(result.runAttempt) + "\n");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "AUDIT_CONSUMER_RUN_INVALID"}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validateCompletedAuditConsumerRun };
