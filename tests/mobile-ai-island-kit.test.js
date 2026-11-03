"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../apps/mobile/src/stageTraceModel");

test("the stage trace marks stages before the broken one as passed and the rest as waiting", () => {
  assert.deepEqual(m.buildStageTrace("ORDER").map((s) => s.state), ["PASSED", "PASSED", "BROKEN", "AHEAD"]);
  assert.deepEqual(m.buildStageTrace("MARKET").map((s) => s.state), ["BROKEN", "AHEAD", "AHEAD", "AHEAD"]);
  assert.deepEqual(m.buildStageTrace("FILL").map((s) => s.label), ["시세", "판단", "주문", "체결"]);
});

test("without a real first broken stage there is no trace, so nothing is claimed as passed", () => {
  assert.equal(m.buildStageTrace(null), null);
  assert.equal(m.buildStageTrace(undefined), null);
  assert.equal(m.buildStageTrace("SOMETHING"), null);
  assert.equal(m.stageTraceIndex(null), null);
  assert.equal(m.stageTraceIndex("ORDER"), "03 / 04");
});

const ok = { stale: false, blocked: false, hasHeartbeat: true, halted: false, dim: false, hasDecisionCount: true };

test("the status chip is lit only when the island itself is live", () => {
  assert.deepEqual(m.nowStatusChip(ok), { text: "PAPER · 모의 운영", live: true });
  assert.equal(m.nowStatusChip({ ...ok, hasHeartbeat: false }).live, false);
  assert.equal(m.nowStatusChip({ ...ok, blocked: true }).live, false);
  assert.deepEqual(m.nowStatusChip({ ...ok, stale: true, blocked: true }), { text: "PAPER · 지난 값", live: false });
  assert.deepEqual(m.nowStatusChip({ ...ok, halted: true }), { text: "PAPER · 멈춤", live: false });
  assert.deepEqual(m.nowStatusChip({ ...ok, dim: true }), { text: "PAPER · 확인 중", live: false });
  assert.equal(m.nowStatusChip({ ...ok, hasDecisionCount: false }).live, false);
});

test("the status chip says PAPER in every combination and is lit in exactly one", () => {
  let lit = 0;
  for (let bits = 0; bits < 64; bits += 1) {
    const [stale, blocked, hasHeartbeat, halted, dim, hasDecisionCount] = [0, 1, 2, 3, 4, 5].map((i) => Boolean(bits & (1 << i)));
    const chip = m.nowStatusChip({ stale, blocked, hasHeartbeat, halted, dim, hasDecisionCount });
    assert.match(chip.text, /^PAPER/);
    if (chip.live) lit += 1;
  }
  assert.equal(lit, 1);
});

test("each tab screen has a chip that is grey unless it carries a real live signal", () => {
  assert.deepEqual(m.liveScreenChip(), { text: "LIVE · 잠김", live: false }, "LIVE never reads as open");
  assert.deepEqual(m.futuresScreenChip(true, false), { text: "FUTURES · 모의 운영", live: true });
  assert.equal(m.futuresScreenChip(false, false).live, false);
  assert.deepEqual(m.futuresScreenChip(true, false, true), { text: "FUTURES · 쉬는 중", live: false }, "a snapshot that has stopped entering is not running");
  assert.deepEqual(m.futuresScreenChip(true, true), { text: "FUTURES · 예시", live: false }, "sample data is never lit");
  for (const name of ["PAPER", "LEARN", "MORE"]) assert.equal(m.plainScreenChip(name).live, false);
});

test("every tab screen sits in the shared shell and its scroll view lets the backdrop show", () => {
  const fs = require("node:fs"), path = require("node:path");
  const read = (f) => fs.readFileSync(path.resolve(__dirname, "../apps/mobile/src", f), "utf8").replace(/\r\n/g, "\n");
  for (const [file, chip] of [["liveReadinessMonitorView.tsx", "liveScreenChip\\(\\)"], ["futuresView.tsx", "futuresScreenChip\\("], ["learningView.tsx", "plainScreenChip\\(\"LEARN\"\\)"], ["moreMenuView.tsx", "plainScreenChip\\(\"MORE\"\\)"], ["paperShadowMonitorView.tsx", "plainScreenChip\\(\"PAPER\"\\)"]]) {
    assert.match(read(file), new RegExp(`<AiShell chip=\\{${chip}`), file);
  }
  for (const file of ["liveReadinessMonitorView.tsx", "futuresView.tsx", "learningView.tsx", "moreMenuView.tsx", "paperLearningMonitorView.tsx"]) {
    assert.match(read(file), /backgroundColor: "transparent"/, `${file} lets the backdrop show`);
  }
  assert.match(read("components.tsx"), /if \(inShell\) return/, "NusaCard is glass only inside the shell");
  assert.match(read("aiKit.tsx"), /<ForceDarkTheme>/, "the shell is always dark, so text never lands dark-on-navy");
  assert.match(read("futuresScreenModel.ts"), /resting: stopped/);
});

test("tab changes and rolling digits use the one island motion rule", () => {
  const fs = require("node:fs"), path = require("node:path");
  const read = (f) => fs.readFileSync(path.resolve(__dirname, "../apps/mobile/src", f), "utf8").replace(/\r\n/g, "\n");
  const tab = read("tabTransition.tsx");
  assert.match(tab, /aiIslandMotion\.transitionMs/);
  assert.match(tab, /Easing\.bezier\(\.\.\.aiIslandMotion\.curve\)/);
  const kit = read("instrumentKit.tsx");
  assert.match(kit, /key=\{`d\$\{chars\.length - 1 - i\}`\}/, "a digit keeps its place, so a change rolls from the old digit instead of restarting at 0");
  assert.doesNotMatch(kit, /y\.setValue\(0\);\n\s*const anim/, "no reset to zero before rolling");
});

test("the shell draws only the status chip: the NUSA name and mark are already in the app header", () => {
  const fs = require("node:fs"), path = require("node:path");
  const kit = fs.readFileSync(path.resolve(__dirname, "../apps/mobile/src/aiKit.tsx"), "utf8").replace(/\r\n/g, "\n");
  const shell = kit.slice(kit.indexOf("export function AiShell"), kit.indexOf("const styles = StyleSheet.create"));
  assert.doesNotMatch(shell, /IslandMark|>NUSA</, "no second NUSA row under the app header");
  assert.match(shell, /<AiStatusChip /);
});

test("the 더보기 detail screens, the order and portfolio screens, the notifications and the connection card sit in the shell", () => {
  const fs = require("node:fs"), path = require("node:path");
  const read = (f) => fs.readFileSync(path.resolve(__dirname, "../apps/mobile", f), "utf8").replace(/\r\n/g, "\n");
  for (const [file, chip] of [["src/screenFrame.tsx", 'plainScreenChip\\("MORE"\\)'], ["src/notificationView.tsx", 'plainScreenChip\\("MORE"\\)'], ["src/portfolioView.tsx", 'plainScreenChip\\("MORE"\\)'], ["src/orderHistoryView.tsx", 'plainScreenChip\\("MORE"\\)'], ["App.tsx", 'plainScreenChip\\("PAPER"\\)']]) {
    assert.match(read(file), new RegExp(`<AiShell chip=\\{${chip}\\}>`), file);
  }
  for (const file of ["src/screenFrame.tsx", "src/notificationView.tsx", "src/portfolioView.tsx"]) assert.match(read(file), /backgroundColor: "transparent"/, `${file} lets the backdrop show`);
  assert.doesNotMatch(read("src/settingsView.tsx"), /<AiShell/, "Settings keeps the user's theme because it holds the theme switch");
});
