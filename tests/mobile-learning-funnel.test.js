const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (p) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const runtime = read("apps/cloud/src/runtime.ts");
const view = read("apps/mobile/src/learningView.tsx");
const funnel = read("apps/mobile/src/learningFunnel.tsx");
const app = read("apps/mobile/App.tsx");

test("the heartbeat carries the Research funnel as integers from the closed-learning status only", () => {
  assert.match(runtime, /const learningFunnelHeartbeat = \(\): \{ learningFunnel\?: PersonalPaperLearningFunnel \} =>/);
  assert.match(runtime, /holdoutPasses > discoveryPasses\) return \{\};/);
  assert.match(runtime, /Number\.isSafeInteger\(v\) && \(v as number\) >= 0/);
  assert.match(runtime, /\.\.\.research, \.\.\.learningFunnelHeartbeat\(\), \.\.\.learningLoopHeartbeat\(\), \.\.\.orderBookStudyHeartbeat\(\) \}\)/);
});

test("the Learning screen shows the funnel only from a live snapshot, and its motion respects reduce-motion", () => {
  assert.equal((app.match(/learningFunnel=\{snapshot\?\.operations\.heartbeat\?\.learningFunnel \?\? null\}/g) || []).length, 2, "both entries to the Learning screen");
  assert.match(view, /const funnel = buildLearningFunnel\(learningFunnel\);/);
  assert.match(view, /<PaperShadowMonitorView \{\.\.\.monitorProps\} embedded \/>/, "the detail monitors receive only the shared props and `embedded` (the shell is already drawn)");
  assert.match(funnel, /const reducedMotion = useReducedMotion\(\);/);
  assert.match(funnel, /if \(reducedMotion === null \|\| inner <= 0\) return undefined;/, "nothing moves before the OS answers");
  assert.match(funnel, /if \(reducedMotion\) \{ wipe\.setValue\(1\); return undefined; \}/);
  assert.match(funnel, /useNativeDriver: true/);
  assert.match(funnel, /buildWaffle\(tested, discovery, holdout\)/, "the grid is the server counts, one cell per strategy");
});
