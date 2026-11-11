const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(
  path.resolve('.github/workflows/autopilot-cloudflare-credential-preflight.yml'),
  'utf8',
).replace(/\r\n/g, '\n');

test('Cloudflare credential preflight never executes untrusted PR head code', () => {
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /Resolve current protected main/);
  assert.match(workflow, /Checkout trusted current main only/);
  assert.match(workflow, /ref: \$\{\{ steps\.main\.outputs\.sha \}\}/);
  assert.match(workflow, /PR head is never checked out/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.doesNotMatch(workflow, /github\.head_ref/);
});

test('preflight has one canonical post-runtime ingress and no stale workflow_run listener', () => {
  assert.doesNotMatch(workflow, /^\s*workflow_run:/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.doesNotMatch(workflow, /cron:/);
});

test('preflight treats token self-verify as informational, not fail-closed', () => {
  assert.match(workflow, /user\/tokens\/verify/);
  assert.match(workflow, /informational only/);
  assert.match(workflow, /payload\.result\?\.status === 'active'/);
  assert.match(workflow, /catch \{/);
  assert.match(workflow, /non-JSON response/);
  const tokenVerifyStep = workflow.slice(workflow.indexOf('user/tokens/verify') - 400, workflow.indexOf('user/tokens/verify') + 80);
  assert.doesNotMatch(tokenVerifyStep, /--fail-with-body/);
});

test('preflight verifies the free-tier Worker has no paid Container or Sandbox binding', () => {
  assert.match(workflow, /accounts\/\$CLOUDFLARE_ACCOUNT_ID/);
  assert.match(workflow, /observed !== expected/);
  assert.match(workflow, /wrangler@4\.127\.1 whoami/);
  assert.match(workflow, /Verify free-tier Worker configuration has no paid Container binding/);
  assert.match(workflow, /Array\.isArray\(config\.containers\)/);
  assert.match(workflow, /binding\?\.name === 'Sandbox'/);
  assert.match(workflow, /Workers Free-compatible configuration verified/);
  assert.doesNotMatch(workflow, /wrangler@4\.127\.1 containers list/);
  assert.doesNotMatch(workflow, /--containers-rollout/);
  assert.doesNotMatch(workflow, /wrangler@4\.127\.1 deploy/);
});

test('preflight waits boundedly for executed exact-main deploy evidence and live Worker revision', () => {
  assert.match(workflow, /gh api --paginate --slurp "repos\/\$GITHUB_REPOSITORY\/actions\/runs\?head_sha=\$CURRENT_MAIN&per_page=100"/);
  assert.match(workflow, /nusa-main-runs-pages\.json/);
  assert.match(workflow, /Array\.isArray\(pages\) \? pages\.flatMap/);
  assert.match(workflow, /Autopilot Cloudflare Deploy/);
  assert.match(workflow, /autopilot-cloudflare-deploy\.yml/);
  assert.match(workflow, /actions\/runs\/\$run_id\/jobs\?per_page=100/);
  assert.match(workflow, /Deploy exact CI-verified Worker revision/);
  assert.match(workflow, /Deploy exact CI-verified revision to Cloudflare Workers Free-compatible runtime/);
  assert.match(workflow, /Verify deployed Worker reports the exact-head revision and fail-closed authority/);
  assert.match(workflow, /deployStep\?\.conclusion === 'success' && verifyStep\?\.conclusion === 'success'/);
  assert.match(workflow, /if \(deployJob\?\.conclusion !== 'success'\) process\.exit\(1\);/);
  assert.match(workflow, /for attempt in \$\(seq 1 18\); do/);
  assert.match(workflow, /waiting for executed exact-main deploy evidence/);
  assert.match(workflow, /waiting for Worker deployment revision/);
  assert.match(workflow, /if \[\[ "\$attempt" -lt 18 \]\]; then sleep 10; fi/);
  assert.match(workflow, /deploymentRevision mismatch/);
  assert.match(workflow, /PENDING exact-main CI\/deploy convergence is still active/);
  assert.match(workflow, /active\.has\(String\(run\?\.status/);
  assert.match(workflow, /run\?\.name === 'CI' \|\| run\?\.name === 'Autopilot Cloudflare Deploy'/);
  assert.match(workflow, /status=pending/);
  assert.match(workflow, /status=ready/);
  assert.match(workflow, /health\.liveAuthority !== 'NONE'/);
  assert.match(workflow, /health\.productionMutationAllowed !== false/);
  assert.match(workflow, /health\.aiAuthority !== 'ZERO_AUTHORITY'/);
});

test('failed preflight freezes existing Release through canonical P0 serialization', () => {
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /if: \$\{\{ needs\.preflight\.result != 'success' \}\}/);
  assert.match(workflow, /P0: Cloudflare deployment credential\/runtime baseline unhealthy/);
  assert.match(workflow, /Refs #903/);
  assert.match(workflow, /nusa-cloudflare-credential-preflight-p0/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /contents: write/);
});

test('pull_request_target can never clear the canonical P0 freeze', () => {
  assert.match(workflow, /if: \$\{\{ needs\.preflight\.result == 'success' && github\.event_name != 'pull_request_target' && needs\.preflight\.outputs\.deployment_status == 'ready' \}\}/);
  assert.match(workflow, /state='closed'/);
});

test('preflight preserves fail-closed authority invariants', () => {
  assert.match(workflow, /BLOCKED_HUMAN/);
  assert.match(workflow, /liveAuthority=NONE/);
  assert.match(workflow, /productionMutationAllowed=false/);
  assert.match(workflow, /AI authority=ZERO_AUTHORITY/);
});


test('active exact-main convergence abstains without weakening terminal failure handling', () => {
  assert.match(workflow, /id: deploy/);
  assert.match(workflow, /if: steps\.deploy\.outputs\.status == 'ready'/);
  assert.match(workflow, /No successful exact-main Cloudflare deploy and no bounded active CI\/deploy convergence/);
  assert.match(workflow, /if: \$\{\{ needs\.preflight\.result != 'success' \}\}/);
  assert.match(workflow, /deploymentStatus=\$\{\{ steps\.deploy\.outputs\.status \|\| 'unknown' \}\}/);
});

// #1871: a PR-triggered job must never combine Cloudflare secrets with repository write authority.
test('the secret-bearing job and issue-mutating job never share authority', () => {
  const body = workflow.replace(/\r\n/g, "\n").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const jobs = body.split(/\n  (?=[A-Za-z0-9_-]+:\n)/);
  const preflight = jobs.find((job) => job.startsWith('preflight:'));
  const blocker = jobs.find((job) => job.startsWith('blocker:'));
  assert.ok(preflight); assert.ok(blocker);
  assert.match(preflight, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(preflight, /issues: write/);
  assert.doesNotMatch(preflight, /\/issues\b/);
  assert.match(blocker, /issues: write/);
  assert.doesNotMatch(blocker, /\$\{\{\s*secrets\./);
  assert.match(workflow, /^permissions: \{\}$/m);
});

test('blocker consumes only trusted preflight outputs and preserves pending convergence', () => {
  assert.match(workflow, /needs: preflight/);
  assert.match(workflow, /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(workflow, /CURRENT_MAIN: \$\{\{ needs\.preflight\.outputs\.current_main \}\}/);
  assert.match(workflow, /deployment_status: \$\{\{ steps\.deploy\.outputs\.status \}\}/);
  assert.match(workflow, /needs\.preflight\.outputs\.deployment_status == 'ready'/);
});


test('secret-bearing preflight validates runtime GitHub credential read-only before Worker sync', () => {
  assert.match(workflow, /NUSA_GITHUB_TOKEN: \$\{\{ secrets\.NUSA_AUTOPILOT_GITHUB_TOKEN \}\}/);
  assert.match(workflow, /Validate runtime GitHub credential before Cloudflare sync/);
  assert.match(workflow, /Authorization: Bearer \$NUSA_GITHUB_TOKEN/);
  assert.match(workflow, /https:\/\/api\.github\.com\/repos\/\$GITHUB_REPOSITORY/);
  assert.match(workflow, /Runtime GitHub credential rejected by GitHub API/);
  assert.match(workflow, /BLOCKED_HUMAN/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('Validate runtime GitHub credential before Cloudflare sync'), workflow.indexOf('Check Cloudflare API token self-verification')), /echo.*NUSA_GITHUB_TOKEN/);
});

test('a runtime-unchanged exact main is accepted only with proof against the live Worker revision', () => {
  // Deploy evidence: scope step succeeded and both mutation steps were skipped, nothing else.
  assert.match(workflow, /scopeStep\?\.conclusion === 'success'\s*&& credentialsSynced\s*&& deployStep\?\.conclusion === 'skipped'\s*&& verifyStep\?\.conclusion === 'skipped'/);
  for (const name of ['Verify Cloudflare deployment credentials and account access', 'Sync persistent Autopilot runtime bearer secret', 'Sync Worker GitHub API credential']) {
    assert.ok(workflow.includes(`'${name}'`), `${name} must be required on the runtime-unchanged path`);
  }
  // The canonical blocker describes both accepted modes.
  assert.match(workflow, /with the rollout skipped for no Worker runtime-input delta, after verifying and re-synchronizing the runtime credentials/);
  assert.match(workflow, /echo "mode=\$DEPLOY_MODE" >> "\$GITHUB_OUTPUT"/);
  // Exact equality remains required after a real deploy.
  assert.match(workflow, /if: steps\.deploy\.outputs\.status == 'ready' && steps\.deploy\.outputs\.mode == 'deployed'/);
  // Otherwise: live revision must be a well-formed ancestor with no Worker runtime-input delta, and fail-closed.
  const start = workflow.indexOf('Require live Worker revision is runtime-equivalent to exact current main');
  assert.ok(start > 0);
  const step = workflow.slice(start, workflow.indexOf('Record fail-closed preflight evidence', start));
  assert.match(step, /if: steps\.deploy\.outputs\.status == 'ready' && steps\.deploy\.outputs\.mode == 'runtime_unchanged'/);
  assert.match(step, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(step, /git merge-base --is-ancestor "\$HEALTH_REVISION" "\$CURRENT_MAIN"/);
  assert.match(step, /git diff --no-renames --name-only -z "\$HEALTH_REVISION" "\$CURRENT_MAIN" \| node scripts\/autopilot-worker-deploy-scope\.js/);
  assert.match(step, /\[ "\$scope" != 'worker_runtime_changed=false' \]/);
  assert.match(step, /health\.liveAuthority !== 'NONE'/);
  assert.match(step, /health\.productionMutationAllowed !== false/);
  assert.match(step, /health\.aiAuthority !== 'ZERO_AUTHORITY'/);
  // The expected posture is derived from the deploy workflow's single source, never a literal (regression: #2632 follow-up).
  assert.match(step, /NUSA_ZERO_CREDIT_MODE:/);
  assert.match(step, /posture\[1\] === 'true' \? 'ENFORCED' : 'DISABLED'/);
  assert.match(step, /health\.zeroCreditMode !== expectedZeroCredit/);
  assert.doesNotMatch(step, /health\.zeroCreditMode !== '(ENFORCED|DISABLED)'/);
  assert.match(workflow, /fetch-depth: 0/);
});

test('without a status filter only a completed, successful Deploy run of the exact main sha becomes a candidate', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const match = workflow.match(/DEPLOY_CANDIDATES < <\(CURRENT_MAIN="\$CURRENT_MAIN" node - <<'NODE'\n([\s\S]*?)\n\s*NODE\n/);
  assert.ok(match, 'candidate filter snippet is present');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nusa-preflight-'));
  try {
    const main = '7f8de2167dcef9d67149d021837ce013ae472a8f';
    const deploy = (id, over) => ({ id, name: 'Autopilot Cloudflare Deploy', path: '.github/workflows/autopilot-cloudflare-deploy.yml', head_sha: main, conclusion: 'success', status: 'completed', ...over });
    const pages = [{ workflow_runs: [
      deploy(10),
      deploy(11, { conclusion: null, status: 'in_progress' }),
      deploy(12, { conclusion: 'failure' }),
      deploy(13, { conclusion: 'cancelled' }),
      deploy(14, { conclusion: 'skipped' }),
      deploy(15, { head_sha: 'a'.repeat(40) }),
      deploy(16, { name: 'Deployment Convergence Receipt' }),
      deploy(17, { path: '.github/workflows/other.yml' }),
    ] }, { workflow_runs: [deploy(20, { head_sha: main.toUpperCase() })] }];
    const file = path.join(dir, 'runs.json');
    fs.writeFileSync(file, JSON.stringify(pages));
    const script = match[1].replace('/tmp/nusa-main-runs-pages.json', file.replace(/\\/g, '/'));
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, CURRENT_MAIN: main }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), ['20', '10']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
