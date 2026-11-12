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
