const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const text = fs.readFileSync(".github/workflows/oracle-host-diagnose.yml", "utf8").replace(/\r\n/g, "\n");

test("the host diagnosis is dispatch-only, read-only and secret-free", () => {
  assert.match(text, /^on:\n  workflow_dispatch:\n    inputs:\n      health_only:\n/m);
  assert.match(text, /type: boolean/);
  assert.doesNotMatch(text, /pull_request|push:|schedule:|workflow_run|repository_dispatch/);
  assert.match(text, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(text, /: write/);
  assert.doesNotMatch(text, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(text, /uses:/, "no third-party or repository action runs on the host");
  assert.match(text, /runs-on: \[self-hosted, Linux, nusa-paper-host\]/);
});

test("no command can change the host or read credential files", () => {
  const commands = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  for (const forbidden of [/\bsudo\b/, /systemctl\s+(restart|stop|start|enable|disable|reload|kill|mask)/, /\brm\b/, /\bmv\b/, /\bcp\b/, /\bchmod\b/, /\bchown\b/, /\btee\b/, /\bwget\b/, /\bapt\b/, /\bkill\b/, /(^|\s)>\s*\/(?!dev\/null)/, /\.env\b/, /cloud-runtime/, /(?<!-o )\bcat\b/]) {
    assert.doesNotMatch(commands, forbidden, `forbidden: ${forbidden}`);
  }
});

test("the only network request is a bounded GET of the runtime's own /health on 127.0.0.1", () => {
  const commands = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  const curls = commands.split("\n").filter((line) => /\bcurl\b/.test(line));
  assert.equal(curls.length, 1, "exactly one request");
  assert.match(curls[0], /curl -fsS -m 6 -o "\$HEALTH_PROBE_PATH" /, "fail on HTTP errors, silent, 6 s timeout, run-scoped file");
  assert.match(curls[0], /http:\/\/127\.0\.0\.1:41731\/health 2>&1; then$/, "local /health only");
  assert.doesNotMatch(curls[0], /\s-(X|d|H|T|u|F|K|b|c)\s|--(data|header|upload|user|form|request|config|cookie)|Authorization|Bearer/, "a plain GET with no body, header, cookie or credential");
  assert.match(commands, /head -c 9000 "\$HEALTH_PROBE_PATH"/, "output bounded");
  assert.doesNotMatch(commands, /https?:\/\/(?!127\.0\.0\.1)/, "no other address");
});

test("failed health fetch discards stale and partial output before annotations", () => {
  const { spawnSync } = require("node:child_process");
  const os = require("node:os");
  const path = require("node:path");
  assert.match(text, /HEALTH_PROBE_BASENAME: nusa-health-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\.json/);
  const jobEnv = text.split('    env:\n')[1].split('    steps:')[0];
  assert.doesNotMatch(jobEnv, /\$\{\{\s*runner\./, "runner context is unavailable in job-level env on GitHub");
  assert.equal((text.match(/HEALTH_PROBE_PATH="\$RUNNER_TEMP\/\$HEALTH_PROBE_BASENAME"/g) || []).length, 2, "both steps resolve runner temp at execution time");
  const script = text.split('      - name: Runtime liveness (local /health only)')[1]
    .split('      - name: Publish the same read-only findings')[0].split('        run: |\n')[1]
    .split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-health-freshness-"));
  const filename = path.join(directory, "probe.json");
  try {
    for (const partial of [false, true]) {
      fs.writeFileSync(filename, '{"observedAt":"STALE"}');
      const result = spawnSync("bash", ["-c", `ss() { :; }; curl() { ${partial ? 'printf PARTIAL > "$HEALTH_PROBE_PATH";' : ''} return 7; };\n${script}`], {
        encoding: "utf8", timeout: 10000, env: { ...process.env, RUNNER_TEMP: directory.replace(/\\/g, "/"), HEALTH_PROBE_BASENAME: "probe.json" },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /HEALTH_PROBE_UNAVAILABLE/);
      assert.doesNotMatch(result.stdout, /STALE|PARTIAL/);
      assert.equal(fs.readFileSync(filename, "utf8"), "", "annotations cannot read a stale or failed response");
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("log output is bounded and redacted, and a separate concurrency group avoids the release guard", () => {
  assert.match(text, /tail -80/);
  assert.match(text, /redact\(\)/);
  assert.match(text, /\[hex\]/);
  assert.match(text, /group: oracle-host-diagnose/);
  assert.doesNotMatch(text, /group: oracle-paper-release/);
});

test("the diagnosis does not walk the release directory, so it cannot load the host it measures", () => {
  const commands = text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(commands, /du\b[^\n]*\/opt\/nusa\/releases/, "no size walk of the 11 GB release directory");
  assert.match(commands, /ls -1 \/opt\/nusa\/releases[^\n]*wc -l/, "the release directories are only counted");
});

test("the disk-consumer listing is time-boxed, lowest I/O priority, bounded, skips the release tree and reports truncation", () => {
  const commands = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.match(commands, /ionice -c3 nice -n19 timeout 40 du -xh --max-depth=1 --exclude=releases \/var \/opt \/home 2>\/dev\/null \| sort -rh \| head -15/);
  assert.match(commands, /journalctl --disk-usage/);
  assert.match(commands, /du_exit=\$\{PIPESTATUS\[0\]\}/, "a timeout or missing tool is visible, not a silent empty listing");
  for (const line of commands.split("\n").filter((l) => /\bdu\b/.test(l) && /\/opt/.test(l))) assert.match(line, /--exclude=releases/, "any du over /opt skips the release tree");
});

test("the disk-consumer walk runs after the health probe and the annotations, so it cannot starve them", () => {
  const names = [...text.matchAll(/^      - name: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(names.slice(-2), ["Disk consumers (read-only, after the health probe)", "Disk consumers by directory (read-only, one at a time)"], "both walks run last");
  assert.ok(names.indexOf("Runtime liveness (local /health only)") < names.length - 1);
  const first = text.split("      - name: Service state and redacted recent errors")[0];
  assert.doesNotMatch(first, /\bdu -xh\b/, "no long du in the first step");
});

test("health_only skips the heavy steps and keeps the health probe and the annotations", () => {
  const steps = text.split(/^      - name: /m).slice(1);
  const byName = (n) => steps.find((s) => s.startsWith(n));
  for (const heavy of ["Disk, memory and state files", "Service state and redacted recent errors", "Disk consumers (read-only, after the health probe)", "Disk consumers by directory (read-only, one at a time)"]) {
    assert.match(byName(heavy), /\n        if: \$\{\{ inputs\.health_only != true && inputs\.health_only != 'true' \}\}\n/, heavy);
  }
  for (const light of ["Runtime liveness (local /health only)", "Publish the same read-only findings as job annotations"]) {
    assert.doesNotMatch(byName(light), /health_only/, light);
  }
});

test("the disk-consumer result is published as an annotation, because the job log is not readable through the REST API", () => {
  const last = text.split("      - name: Disk consumers (read-only, after the health probe)")[1];
  assert.match(last, /emit "diag-disk-consumers" "\$out"/);
  assert.match(last, /\| redact\)"/, "redacted like the other annotations");
});

test("the per-directory disk step is read-only, bounded per directory and published as an annotation", () => {
  const step = text.split("      - name: Disk consumers by directory (read-only, one at a time)")[1];
  assert.match(step, /timeout 25 du -xsh "\$dir"/, "one directory at a time with its own hard limit");
  assert.match(step, /ionice -c3 nice -n19/);
  assert.match(step, /TIMEOUT_OR_UNREADABLE/, "an unmeasured directory is named, never guessed");
  assert.match(step, /emit "diag-disk-by-dir" "\$out"/);
});

test("the learning readout reads the saved /health file, keeps only booleans, numbers and fixed upper-case codes, and says so when it cannot", () => {
  const { spawnSync } = require("node:child_process");
  const os = require("node:os");
  const path = require("node:path");
  const match = text.match(/readout="\$\(node -e '([\s\S]*?)' "\$HEALTH_PROBE_PATH"\)"/);
  assert.ok(match, "the readout step exists");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-learning-readout-"));
  const run = (content) => {
    const file = path.join(directory, "h.json");
    fs.writeFileSync(file, content);
    const result = spawnSync(process.execPath, ["-e", match[1], file], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    const out = JSON.parse(run(JSON.stringify({
      learningLoopVerdict: { verdict: "PARTIAL", candidateFunnel: { stage: "NO_DISCOVERY", experiments: 9 } },
      runtime: { paperFunnel: { since: 5, counts: { "DECISION:PASS:BUY": 7, "ORDER_INTENT:FAIL": 5, "ORDER_INTENT:FAIL:ALLOCATION_ZERO": 4, "free text": 9, "RISK:FAIL:x": 1 } }, lastPaperFillAt: 1700, paperFillCount: 2, lastPaperDecisionOutcome: "HOLD", sourceCommitSha: "a".repeat(40), lastError: "free text here", paperLedger: { fillCount: 4, ledgerFingerprintSha256: "b".repeat(64) }, dataIntegrity: { status: "WARN", candleStaleSeries: 1, candleMaxLatestAgeMs: 3_500_000 }, researchRollingHoldout: { "1m": { mode: "SHADOW", candidatesChecked: 2, refused: { ROLLING_INSUFFICIENT_HISTORY_FOLD_0: 2 }, folds: { notBetter: 1 } } }, orderBookCoverage: { market: "KRW-BTC", ratio: 0.6, meetsStudyBar: false }, closedLearningLoop: { cycleId: "closed-learning:abc", note: "secret text", cyclesEvaluated: 0 } },
    })));
    assert.equal(out.learningLoopVerdict.candidateFunnel.stage, "NO_DISCOVERY");
    assert.deepEqual(out.orderBookCoverage, { ratio: 0.6, meetsStudyBar: false }, "the market name is dropped");
    assert.deepEqual(out.runtimeScalars, { lastPaperFillAt: 1700, paperFillCount: 2, lastPaperDecisionOutcome: "HOLD" }, "top-level runtime numbers and fixed codes only: the commit hash and free text are dropped");
    assert.deepEqual(out.paperLedger, { fillCount: 4 }, "a lower-case hash is dropped");
    assert.deepEqual(out.paperFunnel, { "DECISION:PASS:BUY": 7, "ORDER_INTENT:FAIL": 5, "ORDER_INTENT:FAIL:ALLOCATION_ZERO": 4 }, "only coded keys survive (the 48-character reason limit is /health's own rule)");
    assert.equal(JSON.parse(run(JSON.stringify({ runtime: { lastPaperDecisionOutcome: "BLOCKED:PAPER_EXECUTION_INTENT_MINIMUM_ORDER_EXCEEDS_CASH" } }))).lastPaperDecisionOutcome, "BLOCKED:PAPER_EXECUTION_INTENT_MINIMUM_ORDER_EXCEEDS_CASH", "a coded decision outcome is read");
    assert.equal(run(JSON.stringify({ runtime: { lastPaperDecisionOutcome: "balance is 9,999 KRW" } })), "LEARNING_READOUT_EMPTY", "free text is dropped");
    assert.deepEqual(out.dataIntegrity, { status: "WARN", candleStaleSeries: 1, candleMaxLatestAgeMs: 3_500_000 });
    assert.deepEqual(out.researchRollingHoldout, { "1m": { mode: "SHADOW", candidatesChecked: 2, refused: { ROLLING_INSUFFICIENT_HISTORY_FOLD_0: 2 }, folds: { notBetter: 1 } } }, "the SHADOW rolling summary is read");
    assert.deepEqual(out.closedLearningLoop, { cyclesEvaluated: 0 }, "identifiers and free text are dropped");
    assert.equal(run("{bad"), "LEARNING_READOUT_UNAVAILABLE");
    assert.equal(run("{}"), "LEARNING_READOUT_EMPTY");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// WO-OPS-20261109-DIAGNOSE-STUDY-RESULTS: the RAIM study line is read from the Research journal (the runner account cannot read /var/lib/nusa).
test("the RAIM study projection keeps a fixed status and numbers only and fails closed", () => {
  const start = text.indexOf("raim=\"$(journalctl");
  assert.ok(start > 0, "the RAIM projection exists");
  const block = text.slice(start, text.indexOf("summary=\"${summary}\"$'\\n'\"raim_study", start));
  assert.match(block, /nusa-research\.service/);
  assert.doesNotMatch(block, /\/var\/lib\/nusa/, "no state-directory read");
  const code = block.slice(block.indexOf("node -e '") + "node -e '".length, block.lastIndexOf("')\""));
  const project = (input) => {
    const run = require("node:child_process").spawnSync(process.execPath, ["-e", code], { input, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  const fp = "a".repeat(64);
  const line = "RAIM_STUDY " + JSON.stringify({ status: "HOLDOUT_FAIL", markets: 20, eligible: 7, recorded: true, independent: false, datasetFingerprint: fp, note: "free text", privateField: "private-value" });
  assert.deepEqual(JSON.parse(project(line)), { status: "HOLDOUT_FAIL", markets: 20, eligible: 7, recorded: true, independent: false, datasetFingerprint: fp });
  assert.doesNotMatch(project(line), /free text|private-value/);
  assert.equal(project("RAIM_STUDY {"), "RAIM_STUDY_UNAVAILABLE");
  assert.equal(project("RAIM_STUDY " + JSON.stringify({ status: "FORGED_PASS" })), "RAIM_STUDY_UNAVAILABLE");
  assert.equal(project("[cloud-research-snapshot] RAIM_STUDY_FAILED_CLOSED"), "RAIM_STUDY_FAILED_CLOSED");
  assert.equal(project(""), "RAIM_STUDY_UNAVAILABLE");
});

// WO-RESEARCH-20261113-TRADEFLOW-HOOK: the TRADEFLOW study line is read from the Research journal like the order-book study line.
test("the TRADEFLOW study projection keeps a fixed status, numbers, booleans and a fingerprint only and fails closed", () => {
  const start = text.indexOf("tradeflow=\"$(journalctl");
  assert.ok(start > 0, "the TRADEFLOW projection exists");
  const block = text.slice(start, text.indexOf("summary=\"${summary}\"$'\\n'\"tradeflow_study", start));
  assert.match(block, /nusa-research\.service/);
  assert.doesNotMatch(block, /\/var\/lib\/nusa/, "no state-directory read");
  const code = block.slice(block.indexOf("node -e '") + "node -e '".length, block.lastIndexOf("')\""));
  const project = (input) => {
    const run = require("node:child_process").spawnSync(process.execPath, ["-e", code], { input, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  const fp = "b".repeat(64);
  const line = "TRADEFLOW_STUDY " + JSON.stringify({ status: "HOLDOUT_FAIL", markets: 30, eligible: 9, holdoutTrades: 80, discoveryPass: true, datasetFingerprint: fp, note: "free text", privateField: "private-value", market: "KRW-BTC" });
  assert.deepEqual(JSON.parse(project(line)), { status: "HOLDOUT_FAIL", markets: 30, eligible: 9, holdoutTrades: 80, discoveryPass: true, datasetFingerprint: fp });
  assert.doesNotMatch(project(line), /free text|private-value|KRW-BTC/);
  assert.deepEqual(JSON.parse(project("TRADEFLOW_STUDY " + JSON.stringify({ status: "DATA_INTEGRITY_FAIL", reasonCode: "DATA_FUTURE" }))), { status: "DATA_INTEGRITY_FAIL", reasonCode: "DATA_FUTURE" });
  assert.deepEqual(JSON.parse(project("TRADEFLOW_STUDY " + JSON.stringify({ status: "DATA_INTEGRITY_FAIL", reasonCode: "open failed: /secret" }))), { status: "DATA_INTEGRITY_FAIL" }, "a free-text reason is dropped");
  assert.equal(project("TRADEFLOW_STUDY {"), "TRADEFLOW_STUDY_UNAVAILABLE");
  assert.equal(project("TRADEFLOW_STUDY " + JSON.stringify({ status: "FORGED_PASS" })), "TRADEFLOW_STUDY_UNAVAILABLE");
  assert.equal(project("[cloud-research-snapshot] TRADEFLOW_STUDY_FAILED_CLOSED"), "TRADEFLOW_STUDY_FAILED_CLOSED");
  assert.equal(project(""), "TRADEFLOW_STUDY_UNAVAILABLE");
});

// WO-RESEARCH-20261114-TRADEFLOW-V2-STUDY-ID: the second study prints studyVersion 2; the diagnosis shows the latest line of each study under its own key.
test("the diagnosis reads the first and the second TRADEFLOW study lines separately and keeps the study version", () => {
  const v1Start = text.indexOf("tradeflow=\"$(journalctl");
  const v2Start = text.indexOf("tradeflow2=\"$(journalctl");
  assert.ok(v1Start > 0 && v2Start > v1Start, "both projections exist, the first one first");
  const v1Pipe = text.slice(v1Start, text.indexOf("| cut -c1-2000", v1Start));
  const v2Pipe = text.slice(v2Start, text.indexOf("| cut -c1-2000", v2Start));
  assert.match(v1Pipe, /grep -v -e '"studyVersion":2' -e 'FAILED_CLOSED:V2'/, "the first study line is every line that is not version 2");
  assert.match(v2Pipe, /grep -e '"studyVersion":2' -e 'FAILED_CLOSED:V2'/, "the second study line is a version-2 line or its failure");
  assert.match(text, /summary="\$\{summary\}"\$'\\n'"tradeflow_study_v2=\$\{tradeflow2\}"/);
  const block = text.slice(v2Start, text.indexOf("summary=\"${summary}\"$'\\n'\"tradeflow_study_v2", v2Start));
  const code = block.slice(block.indexOf("node -e '") + "node -e '".length, block.lastIndexOf("')\""));
  const run = require("node:child_process").spawnSync(process.execPath, ["-e", code], { input: "TRADEFLOW_STUDY " + JSON.stringify({ status: "WAITING_DATA", daysCollected: 3, studyVersion: 2, note: "free text" }), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { status: "WAITING_DATA", daysCollected: 3, studyVersion: 2 });
});

test("a failure of one TRADEFLOW study never hides the line of the other study", () => {
  const pick = (startMarker, input) => {
    const start = text.indexOf(startMarker);
    const stage = text.slice(text.indexOf("grep 'TRADEFLOW_STUDY'", start), text.indexOf("| cut -c1-2000", start)).trim();
    const run = require("node:child_process").spawnSync("bash", ["-c", stage], { input, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  const old1 = 'TRADEFLOW_STUDY {"status":"WAITING_DATA","daysCollected":3}';
  const new1 = 'TRADEFLOW_STUDY {"status":"WAITING_DATA","daysCollected":4,"studyVersion":1}';
  const new2 = 'TRADEFLOW_STUDY {"status":"WAITING_DATA","daysCollected":1,"studyVersion":2}';
  const fail1 = "[cloud-research-snapshot] TRADEFLOW_STUDY_FAILED_CLOSED:V1";
  const fail2 = "[cloud-research-snapshot] TRADEFLOW_STUDY_FAILED_CLOSED:V2";
  const first = (input) => pick("tradeflow=\"$(journalctl", input);
  const second = (input) => pick("tradeflow2=\"$(journalctl", input);
  assert.equal(first([old1, new2, fail2].join("\n")), old1, "a version-2 failure is not the first study's line");
  assert.equal(second([old1, new2, fail2].join("\n")), fail2, "the second study shows its own failure");
  assert.equal(first([old1, new1, new2, fail1].join("\n")), fail1, "the first study shows its own failure");
  assert.equal(second([old1, new1, new2, fail1].join("\n")), new2, "a version-1 failure is not the second study's line");
  assert.equal(second([old1].join("\n")), "", "no second-study line yet");
});

// WO-OPS-20261109-DIAGNOSE-RESEARCH-JOURNAL: the Research journal probe prints counts and one timestamp only, never log text.
test("the Research journal availability probe prints only counts and a timestamp", () => {
  const start = text.indexOf('echo "== Research journal availability');
  assert.ok(start > 0, "the probe exists");
  const block = text.slice(start, text.indexOf('echo "== Forward Research log projection', start));
  for (const marker of ["ORDERBOOK_STUDY", "RAIM_STUDY", "TRADEFLOW_STUDY", "DATA_INTEGRITY", "REGIME_FORWARD_STUDY"]) assert.match(block, new RegExp(marker));
  const printed = block.split("\n").filter((line) => /^\s*(echo|for)\b/.test(line)).join("\n");
  assert.doesNotMatch(printed, /echo\s+"?\$rj\b|printf\s+'%s\\n'\s+"\$rj"\s*$/m, "the journal text itself is never printed");
  assert.match(block, /grep -c/);
  assert.doesNotMatch(block, /\bsudo\b|>\s*\/|\btee\b/);
});
