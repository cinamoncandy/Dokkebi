const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (file) => fs.readFileSync(path.resolve('.github/workflows', file), 'utf8').replace(/\r\n/g, '\n');

// On 2026-11-12 the GitHub runs API omitted the newest exact-main CI run from a status=completed list for hours
// (the same call without status returned it). A gate that reads that list then waits or fails although CI passed.
// Each of these lookups still requires conclusion === success in its own filter, so dropping the status filter does not
// relax what counts as a pass; an unfinished run has a null conclusion.
test('release-path CI verdict lookups do not depend on the status=completed list filter', () => {
  const deploy = read('autopilot-cloudflare-deploy.yml');
  assert.match(deploy, /actions\/runs\?head_sha=\$HEAD_SHA&per_page=100"/);
  assert.doesNotMatch(deploy, /head_sha=\$HEAD_SHA&status=completed/);
  const release = read('oracle-paper-release.yml');
  assert.match(release, /workflows\/ci\.yml\/runs\?head_sha=\$SOURCE_SHA&per_page=100"/);
  assert.doesNotMatch(release, /head_sha=\$SOURCE_SHA&status=completed/);
  assert.match(release, /\.conclusion == "success"/);
  const watchdog = read('deployment-convergence-watchdog.yml');
  assert.match(watchdog, /actions\/runs\?head_sha=\$MAIN_SHA&per_page=100"/);
  assert.doesNotMatch(watchdog, /head_sha=\$MAIN_SHA&status=completed/);
  assert.match(watchdog, /\.conclusion == "success"/);
});

test('the deploy wait step still needs a success conclusion of the canonical CI run on the exact head', () => {
  const deploy = read('autopilot-cloudflare-deploy.yml');
  assert.match(deploy, /run\?\.name === 'CI'/);
  assert.match(deploy, /run\?\.path === '\.github\/workflows\/ci\.yml'/);
  assert.match(deploy, /conclusions\.has\('success'\)/);
});

// Behaviour tests: run the real verdict logic of the deploy wait step on mixed run states.
function deployVerdict(runs) {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const deploy = read('autopilot-cloudflare-deploy.yml');
  const match = deploy.match(/verdict="\$\(HEAD_SHA="\$HEAD_SHA" node - <<'NODE'\n([\s\S]*?)\n\s*NODE\n/);
  assert.ok(match, 'verdict snippet is present');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nusa-verdict-'));
  try {
    const file = path.join(dir, 'ci.json');
    fs.writeFileSync(file, JSON.stringify([{ workflow_runs: runs }]));
    const script = match[1].replace('/tmp/nusa-exact-head-ci.json', file.replace(/\\/g, '/'));
    const head = 'a'.repeat(40);
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, HEAD_SHA: head }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HEAD = 'a'.repeat(40);
const ci = (conclusion, over = {}) => ({ name: 'CI', path: '.github/workflows/ci.yml', head_sha: HEAD, conclusion, status: conclusion == null ? 'in_progress' : 'completed', ...over });

test('deploy wait verdict: a success wins over a cancelled duplicate and an unfinished run', () => {
  assert.equal(deployVerdict([ci('success'), ci('cancelled')]), 'success');
  assert.equal(deployVerdict([ci('success'), ci(null)]), 'success');
});

test('deploy wait verdict: failure without a success fails, even next to an unfinished run', () => {
  assert.equal(deployVerdict([ci('failure'), ci(null)]), 'failed');
  assert.equal(deployVerdict([ci('timed_out')]), 'failed');
});

test('deploy wait verdict: cancelled, skipped, unfinished or no runs keep waiting', () => {
  assert.equal(deployVerdict([ci('cancelled')]), 'pending');
  assert.equal(deployVerdict([ci('skipped'), ci(null)]), 'pending');
  assert.equal(deployVerdict([]), 'pending');
});

test('deploy wait verdict: another sha, another workflow name or another path is never evidence', () => {
  assert.equal(deployVerdict([ci('success', { head_sha: 'b'.repeat(40) })]), 'pending');
  assert.equal(deployVerdict([ci('success', { name: 'Other' })]), 'pending');
  assert.equal(deployVerdict([ci('success', { path: '.github/workflows/other.yml' })]), 'pending');
  assert.equal(deployVerdict([ci('success', { head_sha: HEAD.toUpperCase() })]), 'success', 'the sha comparison is case-insensitive');
});
