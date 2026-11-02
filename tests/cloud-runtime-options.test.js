const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("apps/cloud/src/runtime.ts", "utf8").replace(/\r\n/g, "\n");

function positionalNames() {
  const start = source.indexOf("export function startCloudRuntime(\n");
  const end = source.indexOf("): CloudRuntimeHandle {", start);
  return [...source.slice(start, end).matchAll(/^  ([a-zA-Z]+)\??:/gm)].map((match) => match[1]);
}

test("startCloudRuntimeFromOptions forwards every named option to the matching positional slot", () => {
  const names = positionalNames();
  assert.equal(names.length, 21);
  const body = source.slice(source.indexOf("export function startCloudRuntimeFromOptions("), source.indexOf("export function startCloudRuntime(\n"));
  const forwarded = [...body.matchAll(/^    options\.([a-zA-Z]+),$/gm)].map((match) => match[1]);
  assert.deepEqual(forwarded, names);
  const iface = source.slice(source.indexOf("export interface CloudRuntimeOptions {"), source.indexOf("export function startCloudRuntimeFromOptions("));
  assert.deepEqual([...iface.matchAll(/^  readonly ([a-zA-Z]+)\?:/gm)].map((match) => match[1]), names);
});

test("the production runtime composes the cloud runtime through named options only", () => {
  const production = fs.readFileSync("apps/cloud/src/closedLearningProductionRuntime.ts", "utf8");
  assert.match(production, /const baseHandle = startCloudRuntimeFromOptions\(\{/);
  assert.doesNotMatch(production, /startCloudRuntime\(\s*env,/);
});
