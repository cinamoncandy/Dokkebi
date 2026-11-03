const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Linter } = require('eslint');
const { terminalFailureResult } = require('../scripts/autopilot-dispatch-retry.js');

const source = fs.readFileSync('scripts/autopilot-dispatch-retry.js', 'utf8');

test('autopilot consumer has no undefined runtime identifiers', () => {
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(source, [{
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
    },
  }]);
  assert.deepEqual(
    messages.filter((message) => message.ruleId === 'no-undef'),
    [],
    'autopilot consumer must fail CI on undefined runtime identifiers',
  );
});

test('autopilot consumer timestamps execution and reports exhausted remediation as failure', () => {
  assert.match(
    source,
    /async function main\(\) \{\s*const startedAt = Date\.now\(\);\s*let request;\s*(?:let [^;]+;\s*)*try \{\s*(?:const dispatch = readDispatchRequest\(\);|request = readDispatchRequest\(\);)/s,
  );
  assert.match(source, /attemptRecord\(\{[\s\S]*?startedAt,[\s\S]*?decision: "FAILED_CLOSED"/);
  const request = {
    executionId: 'github:classification-test', dedupeKey: 'ci:classification-test',
    headSha: 'a'.repeat(40), workflowRunId: 123,
    liveAuthority: 'NONE', productionMutationAllowed: false, aiAuthority: 'ZERO_AUTHORITY',
  };
  for (const [reason, expected] of [
    ['SANDBOX_BUILD_FAILED', 'FAILED_TO_REMEDIATE'],
    ['CODING_REMEDIATION_DECISION_INVALID', 'FAILED_CLOSED'],
    ['AUTHORITY_VIOLATION', 'FAILED_CLOSED'],
  ]) {
    const error = Object.assign(new Error(reason), { httpStatus: 409 });
    const result = terminalFailureResult(request, error, 10, () => 25);
    assert.equal(result.status, expected);
    assert.equal(result.httpStatus, 409);
    assert.equal(result.attempts[0].latency_ms, 15);
    assert.equal(result.attempts[0].http_class, '4xx');
    assert.equal(result.summary.liveAuthority, 'NONE');
    assert.equal(result.summary.productionMutationAllowed, false);
    assert.equal(result.summary.aiAuthority, 'ZERO_AUTHORITY');
  }
});

test('top-level consumer rejection is not silently swallowed', () => {
  assert.match(
    source,
    /main\(\)\.catch\(\(error\) => \{\s*console\.error\(error instanceof Error \? error\.message : "AUTOPILOT_GITHUB_RUNNER_UNHANDLED"\);\s*process\.exitCode = 1;/s,
  );
});
