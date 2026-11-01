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
      runtime: { orderBookCoverage: { market: "KRW-BTC", ratio: 0.6, meetsStudyBar: false }, closedLearningLoop: { cycleId: "closed-learning:abc", note: "secret text", cyclesEvaluated: 0 } },
    })));
    assert.equal(out.learningLoopVerdict.candidateFunnel.stage, "NO_DISCOVERY");
    assert.deepEqual(out.orderBookCoverage, { ratio: 0.6, meetsStudyBar: false }, "the market name is dropped");
    assert.deepEqual(out.closedLearningLoop, { cyclesEvaluated: 0 }, "identifiers and free text are dropped");
    assert.equal(run("{bad"), "LEARNING_READOUT_UNAVAILABLE");
    assert.equal(run("{}"), "LEARNING_READOUT_EMPTY");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
