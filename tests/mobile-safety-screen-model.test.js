"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const SRC = path.join(__dirname, "..", "apps", "mobile", "src");
function load(name) {
  const out = ts.transpileModule(fs.readFileSync(path.join(SRC, `${name}.ts`), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function("module", "exports", "require", out)(mod, mod.exports, (id) => load(id.replace(/^\.\//, "")));
  return mod.exports;
}
const { buildSafetyScreen, buildFuturesSafetyRows } = load("safetyScreenModel");

test("LIVE reads locked and AI advisory with no server data at all", () => {
  const m = buildSafetyScreen(null, []);
  assert.deepEqual(m.rows.map((r) => [r.label, r.value]), [["실거래", "잠김 · 영구"], ["AI", "권한 없음"]]);
});

test("even all gates passing never says LIVE is on; blocked gates are amber", () => {
  const gates = { passed: 2, total: 3, headline: "", detail: "", gates: [
    { id: "a", title: "A", detail: "", state: "PASS" },
    { id: "b", title: "B", detail: "", state: "BLOCKED" },
    { id: "c", title: "C", detail: "", state: "CHECKING" },
    { id: "d", title: "D", detail: "", state: "STALE" },
    { id: "e", title: "E", detail: "", state: "FAIL" },
  ] };
  const m = buildSafetyScreen(gates, ["X_BLOCKER"]);
  assert.equal(m.rows[0].value, "잠김 · 영구");
  assert.equal(m.rows.find((r) => r.label === "B").tone, "ATTENTION");
  assert.equal(m.rows.find((r) => r.label === "C").value, "확인 중");
  assert.equal(m.rows.find((r) => r.label === "D").value, "오래됨");
  assert.equal(m.rows.find((r) => r.label === "D").tone, "ATTENTION");
  assert.equal(m.rows.find((r) => r.label === "E").value, "실패");
  assert.ok(m.rows.every((r) => !/켜짐|활성|ENABLED/.test(r.value)));
  assert.ok(m.advanced.includes("blocker: X_BLOCKER"));
});

test("futures rows always read as not trading yet and show the gate's own limits", () => {
  const rows = buildFuturesSafetyRows({ maxLeverage: 2, minLiquidationDistanceRatio: 0.25, maxConsecutiveLosses: 3, maxDailyLossRatio: 0.05, maxPositionMarginRatio: 0.2 });
  assert.deepEqual(rows.map((r) => [r.label, r.value]), [
    ["선물 (바이낸스 모의)", "준비 중"],
    ["선물 레버리지", "최대 2배"],
    ["청산가까지 거리", "25% 이상"],
    ["포지션 증거금", "20%까지"],
    ["선물 손실 한도", "연속 3번 · 하루 5%"],
  ]);
  assert.ok(Object.isFrozen(rows) && rows.every((r) => Object.isFrozen(r)));
});

test("the futures limits come from the futures gate's single source and show on the 선물 tab, not the 실거래 tab", () => {
  const live = fs.readFileSync(path.join(SRC, "safetyView.tsx"), "utf8");
  const fut = fs.readFileSync(path.join(SRC, "futuresView.tsx"), "utf8");
  const adapter = fs.readFileSync(path.join(SRC, "futuresSafetyRows.ts"), "utf8");
  assert.match(adapter, /import \{ PAPER_FUTURES_OWNER_LIMITS \} from "\.\.\/\.\.\/\.\.\/packages\/contracts\/src\/paperFutures";/);
  assert.match(adapter, /buildFuturesSafetyRows\(PAPER_FUTURES_OWNER_LIMITS\)/);
  assert.doesNotMatch(live, /futuresSafetyRows|safety-futures/);
  assert.match(fut, /rows: futuresSafetyRows\(\)/);
});
