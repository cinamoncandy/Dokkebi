const assert = require('node:assert/strict');
const test = require('node:test');
const { executeIndependentValidator } = require('../dist/apps/autopilot/src/auditRunner.js');
const request = { kind: 'VALIDATOR_REQUEST', repository: 'cinamoncandy/NUSA', prNumber: 2760, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), workflowRunId: 123, executionId: 'validator:local-repro', dedupeKey: 'validator:local-repro', mutationAllowed: false, liveAuthority: 'NONE', productionMutationAllowed: false, aiAuthority: 'ZERO_AUTHORITY' };
const response = (payload, text, status = 200) => ({ status, ok: status === 200, async json() { return payload; }, async text() { return text ?? JSON.stringify(payload); } });
const modified = (path, added) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old();\n+${added}\n`;
const deleted = (path, line) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-${line}\n`;
function fixture(scenario, options = {}) {
  const sourcePath = ['json', 'deleted', 'mixed', 'base-manifest', 'dual-manifest'].includes(scenario) ? 'a.ts' : 'a.js';
  const deletedGraph = ['deleted', 'mixed', 'base-manifest', 'dual-manifest'].includes(scenario);
  const files = scenario === 'json' ? [sourcePath, 'policy.json'] : scenario === 'dual-manifest' ? [sourcePath, 'survivor.ts'] : scenario === 'mixed' ? [sourcePath, 'helper.ts', 'survivor.ts'] : scenario === 'deleted' ? [sourcePath, 'helper.ts'] : [sourcePath];
  const sources = { 'package.json': '{}', 'security-gate.js': 'exports.scanText = () => "COMMONJS_DEPENDENCY_BODY";', 'policy.json': '{"limit":2,"unchangedRequiredGuard":"JSON_FULL_BODY"}', 'helper.ts': 'export const helper = "DELETED_BASE_DEPENDENCY_BODY";' };
  sources[sourcePath] = scenario === 'commonjs' ? 'const {scanText} = require("./security-gate.js");\nscanText("input");' : scenario === 'json' ? 'import policy from "./policy.json";\ncheck(policy.limit);' : scenario === 'builtin' ? `const fs = require(${JSON.stringify(options.nodeSpecifier || 'fs')});\nfs.readFileSync("input");` : scenario === 'base-manifest' ? 'import React from "react";\nReact.createElement("span");' : 'import {helper} from "./helper";\nhelper();';
  if (scenario === 'mixed') sources['survivor.ts'] = 'import {helper} from "./helper";\nhelper();';
  if (scenario === 'dual-manifest') { sources[sourcePath] = 'import React from "react";\nReact.createElement("span");'; sources['survivor.ts'] = 'import {foo} from "foo";\nfoo();'; }
  const diff = deletedGraph ? deleted(sourcePath, sources[sourcePath]) + (scenario === 'base-manifest' ? '' : scenario === 'dual-manifest' ? modified('survivor.ts', 'foo();') : scenario === 'mixed' ? modified('helper.ts', 'export const helper = "HEAD_HELPER_BODY";') + modified('survivor.ts', 'helper();') : deleted('helper.ts', sources['helper.ts'])) : modified(sourcePath, scenario === 'commonjs' ? 'scanText("input");' : scenario === 'json' ? 'check(policy.limit);' : 'fs.readFileSync("input");') + (scenario === 'json' ? modified('policy.json', '"limit":2') : '');
  const headPaths = deletedGraph ? scenario === 'dual-manifest' ? ['package.json', 'survivor.ts'] : scenario === 'mixed' ? ['package.json', 'helper.ts', 'survivor.ts'] : ['package.json'] : Object.keys(sources);
  return async (input) => {
    const url = new URL(String(input)), path = url.pathname;
    if (path.endsWith('/git/commits/' + request.headSha)) return response({ tree: { sha: 'd'.repeat(40) } });
    if (path.endsWith('/git/commits/' + request.baseSha)) return response({ tree: { sha: 'e'.repeat(40) } });
    if (path.includes('/git/trees/')) return response({ truncated: Boolean(options.truncatedBaseTree && path.endsWith('e'.repeat(40))), tree: (path.endsWith('e'.repeat(40)) ? Object.keys(sources) : headPaths).map(path => ({ path, type: 'blob' })) });
    if (path.endsWith('/pulls/2760/files')) return response(files.map(filename => ({ filename, status: deletedGraph && !headPaths.includes(filename) ? 'removed' : 'modified' })));
    if (path.endsWith('/pulls/2760')) return response({ state: 'open', changed_files: files.length, head: { sha: request.headSha, repo: { full_name: request.repository } }, base: { sha: request.baseSha, repo: { full_name: request.repository } } });
    if (path.endsWith('/actions/runs/123')) return response({ id: 123, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: request.headSha, repository: { full_name: request.repository }, pull_requests: [{ number: 2760 }] });
    if (path.includes('/compare/')) return response({}, diff);
    if (path.includes('/contents/docs/GRILL_ME_PROTOCOL.md')) return response({}, '# NUSA /grill-me protocol\n' + 'adversarial exact-head fail-closed independent validation. '.repeat(8));
    if (path.includes('/contents/')) {
      const file = decodeURIComponent(path.split('/contents/')[1]);
      const ref = url.searchParams.get('ref');
      if (options.missingContents === file || deletedGraph && !headPaths.includes(file) && ref === request.headSha) return response({}, undefined, 404);
      if (scenario === 'mixed' && file === 'helper.ts' && ref === request.headSha) return response({}, 'export const helper = "HEAD_HELPER_BODY";');
      if (['base-manifest', 'dual-manifest'].includes(scenario) && file === 'package.json' && ref === request.baseSha) return response({}, '{"dependencies":{"react":"19.0.0"}}');
      if (scenario === 'dual-manifest' && file === 'package.json' && ref === request.headSha) return response({}, '{"dependencies":{"foo":"1.0.0"}}');
      return Object.hasOwn(sources, file) ? response({}, sources[file]) : response({}, undefined, 404);
    }
    throw new Error('Unexpected URL ' + url);
  };
}

test('deleted importer cannot reuse the head body of a dependency at the same path', async () => {
  let prompt = '';
  const AI = { async run(_model, input) { prompt = input.prompt; return { response: JSON.stringify({ verdict: 'PASS', findings: [], blockers: [], safetyInvariantResult: 'PASS', mergeAllowed: true }) }; } };
  const result = await executeIndependentValidator(request, { AI, NUSA_AUDIT_GITHUB_TOKEN: 'local-fixture-only' }, fixture('mixed'));
  assert.ok(prompt.includes('HEAD_HELPER_BODY'));
  assert.ok(prompt.includes('DELETED_BASE_DEPENDENCY_BODY'));
  assert.ok(result.evidenceRefs.includes(`github:dependency/helper.ts@${request.baseSha}`));
  assert.ok(result.evidenceRefs.includes(`github:changed-source/helper.ts@${request.headSha}`));
});

test('deleted source resolves external package declarations at its base', async () => {
  const AI = { async run() { return { response: JSON.stringify({ verdict: 'PASS', findings: [], blockers: [], safetyInvariantResult: 'PASS', mergeAllowed: true }) }; } };
  const result = await executeIndependentValidator(request, { AI, NUSA_AUDIT_GITHUB_TOKEN: 'local-fixture-only' }, fixture('base-manifest'));
  assert.ok(result.evidenceRefs.includes(`github:dependency-manifest/package.json@${request.baseSha}`));
  assert.ok(!result.evidenceRefs.includes(`github:dependency-manifest/package.json@${request.headSha}`));
});

test('base and head package manifests at the same path have distinct cache identities', async () => {
  const AI = { async run() { return { response: JSON.stringify({ verdict: 'PASS', findings: [], blockers: [], safetyInvariantResult: 'PASS', mergeAllowed: true }) }; } };
  const result = await executeIndependentValidator(request, { AI, NUSA_AUDIT_GITHUB_TOKEN: 'local-fixture-only' }, fixture('dual-manifest'));
  assert.ok(result.evidenceRefs.includes(`github:dependency-manifest/package.json@${request.baseSha}`));
  assert.ok(result.evidenceRefs.includes(`github:dependency-manifest/package.json@${request.headSha}`));
});

for (const nodeSpecifier of ['fs/promises', 'node:fs', 'node:fs/promises', 'node:test']) {
  test(`Node platform dependency ${nodeSpecifier} is recognized without a manifest entry`, async () => {
    const AI = { async run() { return { response: JSON.stringify({ verdict: 'PASS', findings: [], blockers: [], safetyInvariantResult: 'PASS', mergeAllowed: true }) }; } };
    const result = await executeIndependentValidator(request, { AI, NUSA_AUDIT_GITHUB_TOKEN: 'local-fixture-only' }, fixture('builtin', { nodeSpecifier }));
    assert.equal(result.status, 'VALIDATOR_COMPLETED');
  });
}

for (const [scenario, options, code] of [
  ['builtin', { nodeSpecifier: 'fs-extra' }, /VALIDATOR_DEPENDENCY_IMPORT_UNCLASSIFIED/],
  ['builtin', { nodeSpecifier: 'node:not-a-builtin' }, /VALIDATOR_DEPENDENCY_IMPORT_UNCLASSIFIED/],
  ['builtin', { nodeSpecifier: 'fs/not-a-builtin' }, /VALIDATOR_DEPENDENCY_IMPORT_UNCLASSIFIED/],
  ['builtin', { nodeSpecifier: 'node:fs/not-a-builtin' }, /VALIDATOR_DEPENDENCY_IMPORT_UNCLASSIFIED/],
  ['builtin', { nodeSpecifier: 'test' }, /VALIDATOR_DEPENDENCY_IMPORT_UNCLASSIFIED/],
  ['commonjs', { missingContents: 'security-gate.js' }, /VALIDATOR_DEPENDENCY_UNRESOLVED/],
  ['json', { missingContents: 'policy.json' }, /VALIDATOR_DEPENDENCY_UNRESOLVED/],
  ['mixed', { missingContents: 'helper.ts' }, /VALIDATOR_CHANGED_SOURCE_MISSING_AT_HEAD/],
  ['deleted', { truncatedBaseTree: true }, /VALIDATOR_TREE_INCOMPLETE/],
  ['base-manifest', { missingContents: 'package.json' }, /VALIDATOR_PACKAGE_MANIFEST_MISSING/],
]) {
  test(`untrusted or unavailable ${scenario} context fails before model invocation: ${JSON.stringify(options)}`, async () => {
    let invoked = false;
    const AI = { async run() { invoked = true; throw new Error('model must not run'); } };
    await assert.rejects(executeIndependentValidator(request, { AI, NUSA_AUDIT_GITHUB_TOKEN: 'local-fixture-only' }, fixture(scenario, options)), code);
    assert.equal(invoked, false);
  });
}
for (const [scenario, requiredBody] of [['commonjs', 'COMMONJS_DEPENDENCY_BODY'], ['json', 'JSON_FULL_BODY'], ['builtin', null], ['deleted', 'DELETED_BASE_DEPENDENCY_BODY']]) {
  test('current canonical source handles ' + scenario, async () => {
    let prompt = '';
    const AI = { async run(_model, input) { prompt = input.prompt; return { response: JSON.stringify({ verdict: 'PASS', findings: [], blockers: [], safetyInvariantResult: 'PASS', mergeAllowed: true }) }; } };
    const result = await executeIndependentValidator(request, { AI, NUSA_AUDIT_GITHUB_TOKEN: 'local-fixture-only' }, fixture(scenario));
    assert.equal(result.status, 'VALIDATOR_COMPLETED');
    if (requiredBody) assert.ok(prompt.includes(requiredBody), 'missing required body: ' + requiredBody);
  });
}
