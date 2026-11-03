const fs = require("node:fs");
const path = require("node:path");
const { runIsolatedCausalVerificationHarness } = require("../dist/apps/autopilot/src/isolatedCausalVerificationHarness.js");

const fail = (message) => { console.error(message); process.exit(1); };
const eventPath = process.env.GITHUB_EVENT_PATH;
const bundlePath = process.env.NUSA_ATTESTATION_BUNDLE;
const token = process.env.NUSA_GITHUB_TOKEN;
const receiptPath = process.env.NUSA_VERIFICATION_RECEIPT;
const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
if (!eventPath || !bundlePath || !token || !receiptPath || !stepSummaryPath) fail("ISOLATED_VERIFICATION_INPUT_MISSING");

let event;
try { event = JSON.parse(fs.readFileSync(eventPath, "utf8")); }
catch { fail("ISOLATED_WORKFLOW_RUN_EVENT_INVALID"); }
const run = event.workflow_run;
if (!run || event.repository?.full_name !== "cinamoncandy/NUSA"
  || run.head_repository?.full_name !== "cinamoncandy/NUSA" || run.head_branch !== "main"
  || run.event !== "workflow_dispatch" || run.status !== "completed" || run.conclusion !== "success"
  || !Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0
  || !/^[0-9a-f]{40}$/.test(run.head_sha || "")) fail("ISOLATED_WORKFLOW_RUN_EVENT_NOT_ELIGIBLE");

const bundle = JSON.parse(fs.readFileSync(path.resolve(bundlePath), "utf8"));
runIsolatedCausalVerificationHarness({
  bundle,
  expected: { sha: run.head_sha, runId: String(run.id), runAttempt: String(run.run_attempt) },
  githubToken: token,
}).then((receipt) => {
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  fs.writeFileSync(receiptPath, output, { flag: "wx", mode: 0o600 });
  fs.appendFileSync(stepSummaryPath, [
    "## Isolated causal verification",
    "",
    `- Domain: \`${receipt.domain}\``,
    `- Classification: \`${receipt.classification}\``,
    `- CodingRunner: \`${receipt.codingRunnerStatus}\` (local deterministic adapters)`,
    `- Durable replay guard: \`${receipt.durableReplayGuard}\` (check run ${receipt.sourceCheckRunId})`,
    `- In-process dedupe: \`${receipt.dedupe}\``,
    `- Source: \`${receipt.sourceSha}\` / run \`${receipt.sourceRunId}\` attempt \`${receipt.sourceRunAttempt}\``,
    "- Authority: PAPER_ONLY; liveAuthority=NONE; productionMutationAllowed=false; aiAuthority=ZERO_AUTHORITY",
    "",
    "This isolated proof is not a production causal-admission receipt and does not authorize repository, deployment, order, or transfer mutations.",
    "",
  ].join("\n"));
  console.log(output.trim());
}).catch((error) => fail(error instanceof Error ? error.message : "ISOLATED_VERIFICATION_FAILED"));
