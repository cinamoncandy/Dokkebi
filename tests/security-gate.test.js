const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanText, baseSelector } = require("../scripts/security-gate.js");
const { dependencyIntegrity, licenseAudit, parseLockfile, verifyArtifacts } = require("../scripts/security-gate.js");

test("secret scanner reports credential material without returning its value", () => {
  const findings = scanText(`const key = "${["ghp_", "12345678901234567890"].join("")}";`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "TOKEN_PREFIX");
  assert.equal(Object.hasOwn(findings[0], "value"), false);
});

test("secret scanner ignores explicit non-secret placeholders", () => {
  assert.deepEqual(scanText('password: "not-configured"'), []);
});

test("lockfile contains integrity metadata for every resolved package", () => {
  const result = dependencyIntegrity();
  assert.equal(result.findings.length, 0);
  assert.ok(result.packageCount > 0);
});

test("lockfile pins the patched versions for audited high advisories", () => {
  const packages = parseLockfile().packages;
  assert.ok(packages.some((item) => item.name === "fast-uri" && item.version === "3.1.8"));
  assert.equal(packages.some((item) => item.name === "fast-uri" && item.version === "3.1.4"), false);
  assert.equal(packages.some((item) => item.name === "fast-uri" && item.version === "3.1.6"), false);
  for (const [name, fixed, vulnerable] of [["brace-expansion", "1.1.21", "1.1.18"], ["brace-expansion", "2.1.7", "2.1.4"], ["brace-expansion", "5.0.12", "5.0.9"]]) {
    assert.ok(packages.some((item) => item.name === name && item.version === fixed), `${name} ${fixed} is pinned`);
    assert.equal(packages.some((item) => item.name === name && item.version === vulnerable), false, `${name} ${vulnerable} is gone`);
  }
  assert.equal(packages.some((item) => item.name === "brace-expansion" && item.version === "1.1.17"), false);
  for (const [name, fixed, vulnerable] of [["undici", "7.30.1", "7.29.1"], ["undici", "6.29.1", "6.28.1"], ["body-parser", "1.20.9", "1.20.6"], ["joi", "17.13.9", "17.13.7"]]) {
    assert.ok(packages.some((item) => item.name === name && item.version === fixed), `${name} ${fixed} is pinned`);
    assert.equal(packages.some((item) => item.name === name && item.version === vulnerable), false, `${name} ${vulnerable} is gone`);
  }
});

test("peer suffix normalization removes every trailing peer group", () => {
  assert.equal(baseSelector("foo@1.0.0(react@18)(react-dom@18)"), "foo@1.0.0");
  assert.equal(baseSelector("@scope/foo@1.0.0(peer@1)(@scope/other@2)"), "@scope/foo@1.0.0");
  assert.equal(baseSelector("plain@1.0.0"), "plain@1.0.0");
});

test("optional detection finds optional: true even when other snapshot keys sit between it and the header", () => {
  const postject = parseLockfile().packages.find((item) => item.name === "postject");
  assert.ok(postject, "postject must still be present in the lockfile for this regression test to mean anything");
  assert.equal(postject.optional, true);
});

test("optional package detection matches an independent full snapshot-block scan", () => {
  const lock = parseLockfile();
  const actual = new Set(lock.packages.filter((item) => item.optional).map((item) => `${item.name}@${item.version}`));
  const lines = fs.readFileSync(path.join(__dirname, "..", "pnpm-lock.yaml"), "utf8").split(/\r?\n/);
  const expected = new Set();
  let inSnapshots = false;
  let selector = null;
  for (const line of lines) {
    if (!inSnapshots) {
      if (line === "snapshots:") inSnapshots = true;
      continue;
    }
    if (line && !line.startsWith("  ")) break;
    const match = line.match(/^ {2}(?! )(?:'([^']+)'|([^:]+)):\s*$/);
    if (match) {
      selector = baseSelector(match[1] ?? match[2]);
      continue;
    }
    if (selector !== null && /^ {4}optional: true\s*$/.test(line)) expected.add(selector);
  }
  assert.ok(expected.size > 0, "the lockfile must contain optional snapshots for this test to mean anything");
  const missed = [...expected].filter((item) => !actual.has(item));
  assert.deepEqual(missed, [], `optional packages missed by parseLockfile: ${missed.join(", ")}`);
});

test("each package integrity value comes only from its own block", () => {
  const lock = parseLockfile();
  const lines = fs.readFileSync(path.join(__dirname, "..", "pnpm-lock.yaml"), "utf8").split(/\r?\n/);
  const start = lines.indexOf("packages:");
  assert.ok(start >= 0);
  let selector = null;
  let body = [];
  const own = new Map();
  const flush = () => {
    if (selector !== null) own.set(selector, body.join("\n"));
    selector = null;
    body = [];
  };
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith("  ")) {
      flush();
      break;
    }
    const match = line.match(/^ {2}(?! )(?:'([^']+)'|([^:]+)):\s*$/);
    if (match) {
      flush();
      selector = baseSelector(match[1] ?? match[2]);
      continue;
    }
    if (selector !== null) body.push(line);
  }
  flush();

  for (const item of lock.packages) {
    const block = own.get(`${item.name}@${item.version}`);
    if (block === undefined) continue;
    const expected = block.match(/integrity:\s*([^\s}]+)/)?.[1] ?? null;
    assert.equal(item.integrity, expected, `${item.name}@${item.version} integrity must come from its own block`);
  }
});

test("license audit ignores platform-selected optional packages without skipping ordinary dependencies", () => {
  const lock = parseLockfile();
  const platformPackages = lock.packages.filter((item) => item.platformSpecific);
  assert.ok(platformPackages.length > 0);
  assert.ok(platformPackages.some((item) => /^(?:@esbuild\/|@rollup\/rollup-|fsevents$)/.test(item.name)));
  const licenses = licenseAudit(lock);
  assert.equal(licenses.missing.some((item) => item.startsWith("@esbuild/")), false);
  assert.equal(licenses.missing.some((item) => item.startsWith("@rollup/rollup-")), false);
  assert.equal(licenses.missing.some((item) => item.startsWith("fsevents@")), false);
});

test("artifact verification checks recorded hashes and signing state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-security-"));
  try {
    const artifact = path.join(directory, "NUSA.exe");
    fs.writeFileSync(artifact, "paper-only-test-artifact");
    const crypto = require("node:crypto");
    const hash = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
    fs.writeFileSync(path.join(directory, "build-manifest.json"), JSON.stringify({ capabilityDescriptor: { productionMutationAllowed: false, liveTradingEnabled: false, credentialsConfigured: false }, signing: { status: "CONFIGURED_BY_BUILD_ENV" } }));
    fs.writeFileSync(path.join(directory, "nusa-checksums.txt"), `${hash}  NUSA.exe\n`);
    const result = verifyArtifacts(directory);
    assert.equal(result.checksumStatus, "PASS");
    assert.equal(result.signingStatus, "PASS");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
