const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const intervalMs of [60000, 900000]) {
  test(`unproven ${intervalMs / 60000}m ALLOW gaps must not reach evaluation`, () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'research-unconfirmed-gap-probe.cjs'), String(intervalMs)], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const observation = JSON.parse(result.stdout);
    assert.equal(observation.importedAllow.evaluationCalls, 0, 'ordinary ALLOW is not an exchange absence proof');
  });
}
