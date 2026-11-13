"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { ResearchFuturesCollector, researchFuturesCollectorEnabled } = require("../dist/apps/cloud/src/researchFuturesCollector.js");
const { SqliteDatabase } = require("../dist/packages/storage/src/index.js");
const { SqliteFuturesPublicStore } = require("../dist/packages/storage/src/futuresPublicStore.js");

const NOW = 1_800_000_000_000;
const calls = [];
function fetchStub({ premiumTime = NOW - 1000, symbolOverride } = {}) {
  return async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    const symbol = u.searchParams.get("symbol");
    const body = u.pathname === "/fapi/v1/premiumIndex" ? { symbol: symbolOverride ?? symbol, markPrice: "83000.5", indexPrice: "83001.0", lastFundingRate: "-0.0001", nextFundingTime: NOW + 3_600_000, time: premiumTime }
      : u.pathname === "/fapi/v1/fundingRate" ? [{ symbol, fundingTime: NOW - 8 * 3_600_000, fundingRate: "0.0001" }, { symbol, fundingTime: NOW + 999_999_999, fundingRate: "0.0001" }]
      : [[NOW - 8 * 3_600_000, "1", "2", "0.5", "1.5", "10", NOW - 4 * 3_600_000 - 1], [NOW - 3_600_000, "1", "2", "0.5", "1.5", "10", NOW + 10_000]];
    return { ok: true, json: async () => body };
  };
}
const rows = (db, sql) => db.connection.prepare(sql).all();

test("stores marks, funding and only CLOSED klines; future rows are rejected, public endpoints only", async () => {
  calls.length = 0;
  const db = new SqliteDatabase(":memory:");
  const c = new ResearchFuturesCollector(new SqliteFuturesPublicStore(db), { fetchImpl: fetchStub(), now: () => NOW });
  await c.collectOnce();
  const s = c.status();
  assert.equal(s.marksStored, 2); assert.equal(s.fundingStored, 2); assert.equal(s.klinesStored, 2); assert.equal(s.failures, 0);
  assert.equal(s.rejected, 2, "one future funding row per symbol");
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM research_futures_klines")[0].n, 2, "the forming candle is never stored");
  assert.equal(rows(db, "SELECT captured_at_ms FROM research_futures_marks")[0].captured_at_ms, NOW, "stamped with the observation time");
  assert.ok(calls.every((u) => u.startsWith("https://fapi.binance.com/fapi/v1/")), "only public market-data paths");
  await c.collectOnce();
  assert.equal(c.status().marksStored, 2, "same observation time is idempotent");
  db.close();
});

test("a wrong symbol or future exchange time is rejected and nothing is stored", async () => {
  for (const opts of [{ symbolOverride: "XRPUSDT" }, { premiumTime: NOW + 60_000 }]) {
    const db = new SqliteDatabase(":memory:");
    const c = new ResearchFuturesCollector(new SqliteFuturesPublicStore(db), { fetchImpl: fetchStub(opts), now: () => NOW });
    await c.collectOnce();
    assert.equal(c.status().marksStored, 0); assert.ok(c.status().rejected >= 2);
    db.close();
  }
});

test("HTTP failures are counted, never thrown; the kill switch disables it", async () => {
  const db = new SqliteDatabase(":memory:");
  const c = new ResearchFuturesCollector(new SqliteFuturesPublicStore(db), { fetchImpl: async () => ({ ok: false, status: 451, json: async () => ({}) }), now: () => NOW });
  await c.collectOnce();
  assert.ok(c.status().failures > 0); assert.equal(c.status().marksStored, 0);
  db.close();
  for (const off of ["DISABLED", "disabled", " 0 ", "off", "false"]) assert.equal(researchFuturesCollectorEnabled({ NUSA_RESEARCH_FUTURES_COLLECTOR: off }), false, off);
  assert.equal(researchFuturesCollectorEnabled({}), true);
});

test("a fully blocked slow round is retried next minute, not in an hour; then the hour marker advances", async () => {
  const db = new SqliteDatabase(":memory:");
  let blocked = true;
  const good = fetchStub();
  const fetchImpl = async (url) => (blocked && !String(url).includes("premiumIndex") ? { ok: false, status: 451, json: async () => ({}) } : good(url));
  let now = NOW;
  const c = new ResearchFuturesCollector(new SqliteFuturesPublicStore(db), { fetchImpl, now: () => now });
  await c.collectOnce();
  assert.equal(c.status().fundingStored, 0);
  blocked = false; now += 60_000;
  await c.collectOnce();
  assert.equal(c.status().fundingStored, 2, "retried one minute later");
  const stored = c.status().fundingStored;
  now += 60_000;
  await c.collectOnce();
  assert.equal(c.status().fundingStored, stored, "not repeated within the hour");
  db.close();
});

test("invalid rows and old marks: store rejects them, prune deletes by age, overlap is guarded", async () => {
  const db = new SqliteDatabase(":memory:");
  const store = new SqliteFuturesPublicStore(db);
  const bad = { symbol: "BTCUSDT", capturedAtMs: NOW, markPrice: Number.NaN, indexPrice: 1, lastFundingRate: -0.1, nextFundingTimeMs: NOW };
  assert.deepEqual(store.appendMarks([bad, { ...bad, markPrice: 1, symbol: "btc" }]), { stored: 0, rejected: 2 });
  assert.equal(store.appendMarks([{ ...bad, markPrice: 1 }]).stored, 1, "a negative funding rate is valid");
  assert.equal(store.pruneMarksBefore(NOW + 1), 1);
  let release; let calls = 0;
  const slow = new ResearchFuturesCollector(store, { fetchImpl: async (u) => { calls += 1; if (calls === 1) await new Promise((r) => { release = r; }); return fetchStub()(u); }, now: () => NOW });
  const first = slow.collectOnce(); await slow.collectOnce();
  assert.equal(calls, 1, "a second round does not overlap the first");
  release(); await first;
  assert.ok(calls > 1, "the first round completed");
  db.close();
});

const { futuresFailureClass } = require("../dist/apps/cloud/src/researchFuturesCollector.js");

test("a failed fetch leaves a fixed failure class: the HTTP status (a region block is HTTP_451), a timeout, or a coarse class, never the message", async () => {
  const blocked = async () => ({ ok: false, status: 451, json: async () => ({}) });
  const db = new SqliteDatabase(":memory:");
  const c = new ResearchFuturesCollector(new SqliteFuturesPublicStore(db), { fetchImpl: blocked, now: () => NOW });
  assert.equal(c.status().lastFailureClass, undefined, "nothing before a failure");
  await c.collectOnce();
  const s = c.status();
  assert.equal(s.marksStored, 0);
  assert.ok(s.failures > 0);
  assert.equal(s.lastFailureClass, "HTTP_451");

  const ok = new ResearchFuturesCollector(new SqliteFuturesPublicStore(new SqliteDatabase(":memory:")), { fetchImpl: fetchStub(), now: () => NOW });
  await ok.collectOnce();
  assert.equal(ok.status().lastFailureClass, undefined, "a healthy round never reports a class");
});

test("futuresFailureClass maps errors to fixed codes only", () => {
  assert.equal(futuresFailureClass(new Error("HTTP_451")), "HTTP_451");
  assert.equal(futuresFailureClass(new Error("HTTP_503")), "HTTP_503");
  assert.equal(futuresFailureClass(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })), "TIMEOUT");
  assert.equal(futuresFailureClass(Object.assign(new Error("aborted"), { name: "AbortError" })), "TIMEOUT");
  assert.equal(futuresFailureClass(new Error("FUNDING_INVALID")), "INVALID_RESPONSE");
  assert.equal(futuresFailureClass(new Error("KLINES_INVALID")), "INVALID_RESPONSE");
  for (const odd of [new Error("connect ECONNREFUSED 1.2.3.4:443"), new Error("HTTP_45"), new Error("HTTP_4511"), new Error("HTTP_999"), new Error(""), "string", null, undefined, 7]) {
    assert.equal(futuresFailureClass(odd), "FETCH_FAILED", "free text, hosts and malformed codes never leave this function");
  }
});
