const test = require("node:test");
const assert = require("node:assert/strict");
const { backfillMarket, parseUpbitMinuteCandles, createUpbitMinuteCandleFetcher, BackfillRateLimitedError, BACKFILL_PAGE_SIZE, UPBIT_MINUTE_CANDLES_URL, UPBIT_CANDLE_SOURCE_FINGERPRINT } = require("../dist/apps/cloud/src/researchCandleBackfill.js");
const { readResearchExperimentSettings } = require("../dist/apps/cloud/src/researchExperimentComposition.js");
const { SqliteDatabase, SqliteResearchCandleStore } = require("../dist/packages/storage/src/index.js");

const M = 60_000;
const MARKET = "KRW-XRP";
const NOW = Date.UTC(2026, 9, 3, 6, 0, 30); // 30 s into a minute: the current minute is NOT closed
const ANCHOR = Math.floor(NOW / M) * M;
const stamp = (startMs) => new Date(startMs).toISOString().slice(0, 19);
const candle = (startMs, price = 1000) => ({ market: MARKET, candle_date_time_utc: stamp(startMs), opening_price: price, high_price: price + 1, low_price: price - 1, trade_price: price + 0.5, candle_acc_trade_volume: 2 });

// An exchange with one candle per minute from `firstStartMs` to the in-progress minute, served newest first like Upbit.
function exchange(firstStartMs) {
  const calls = [];
  const fetchPage = async (market, toIso) => {
    calls.push(toIso);
    const upperExclusive = toIso === undefined ? ANCHOR + M : Date.parse(`${toIso}Z`);
    const out = [];
    for (let start = upperExclusive - M; start >= firstStartMs && out.length < BACKFILL_PAGE_SIZE; start -= M) out.push(candle(start, 1000 + ((start / M) % 7)));
    return out;
  };
  return { fetchPage, calls };
}
const newStore = () => new SqliteResearchCandleStore(new SqliteDatabase(":memory:"));
const run = (store, over = {}) => backfillMarket({ market: MARKET, targetSpanMs: 3 * 3_600_000, nowMs: NOW, store, sleep: async () => undefined, ...over });

test("an empty store is filled back to the target span with closed minutes only", async () => {
  const store = newStore();
  const ex = exchange(ANCHOR - 24 * 3_600_000);
  const result = await run(store, { fetchPage: ex.fetchPage });
  assert.equal(result.status, "COMPLETE");
  assert.ok(store.latestCloseTime(MARKET, M) <= ANCHOR, "the in-progress minute is never stored");
  assert.equal(store.latestCloseTime(MARKET, M), ANCHOR);
  assert.ok(store.earliestCloseTime(MARKET, M) <= ANCHOR - 3 * 3_600_000 + M);
  assert.ok(store.count(MARKET, M) >= 180);
  assert.equal(store.hasMaterialCoverage(MARKET, M, ANCHOR - 3 * 3_600_000 + M, ANCHOR, "UPBIT_PUBLIC_CANDLES", UPBIT_CANDLE_SOURCE_FINGERPRINT), true, "every target candle has a durable source-page receipt");
  assert.equal(ex.calls[0], undefined, "the first request asks for the newest page");
  assert.ok(ex.calls.slice(1).every((c) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(c)));
});

test("it only writes candles older than anything already stored and never conflicts with live data", async () => {
  const store = newStore();
  // Live collector already stored the last 30 minutes with DIFFERENT prices than the exchange's.
  const live = []; for (let i = 29; i >= 0; i -= 1) live.push({ closeTimeMs: ANCHOR - i * M, open: 5, high: 6, low: 4, close: 5.5 });
  store.append(MARKET, M, live);
  const liveEarliest = store.earliestCloseTime(MARKET, M);
  const result = await run(store, { fetchPage: exchange(ANCHOR - 24 * 3_600_000).fetchPage });
  assert.equal(result.status, "INCOMPLETE", "unmatched live candles cannot be represented as source-verified evidence");
  const kept = store.read(MARKET, M, liveEarliest, ANCHOR);
  assert.equal(kept.length, 30);
  assert.ok(kept.every((c) => c.open === 5 && c.close === 5.5), "live candles are untouched");
  assert.ok(store.earliestCloseTime(MARKET, M) <= ANCHOR - 3 * 3_600_000 + M);
});

test("a finished store makes no request", async () => {
  const store = newStore();
  await run(store, { fetchPage: exchange(ANCHOR - 24 * 3_600_000).fetchPage });
  let calls = 0;
  const again = await run(store, { fetchPage: async () => { calls += 1; return []; } });
  assert.equal(again.status, "COMPLETE");
  assert.equal(calls, 0);
});

test("a rate limit stops the attempt and reports it; progress so far is kept", async () => {
  const store = newStore();
  const ex = exchange(ANCHOR - 24 * 3_600_000);
  let n = 0;
  const result = await run(store, { targetSpanMs: 20 * 3_600_000, fetchPage: async (m, to) => { n += 1; if (n === 3) throw new BackfillRateLimitedError(); return ex.fetchPage(m, to); } });
  assert.equal(result.status, "RATE_LIMITED");
  assert.equal(result.pages, 2);
  assert.ok(result.recorded > 0 && store.count(MARKET, M) === result.recorded);
});

test("request and store errors stop the attempt with a code and never throw", async () => {
  const failing = await run(newStore(), { fetchPage: async () => { throw Object.assign(new Error("boom"), { code: "UPSTREAM_500" }); } });
  assert.deepEqual([failing.status, failing.errorCode, failing.recorded], ["ERROR", "UPSTREAM_500", 0]);
  const plain = await run(newStore(), { fetchPage: async () => { throw new Error("socket"); } });
  assert.equal(plain.errorCode, "REQUEST_FAILED");
  const garbage = await run(newStore(), { fetchPage: async () => ({ not: "an array" }) });
  assert.equal(garbage.status, "ERROR");
  assert.equal(garbage.errorCode, "MALFORMED_PAGE");
});

test("an empty upstream page cannot claim completion without full source-receipt coverage", async () => {
  const result = await run(newStore(), { fetchPage: async () => [] });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.errorCode, "SOURCE_RECEIPTS_INCOMPLETE");
});

test("the page budget bounds the work", async () => {
  const store = newStore();
  const result = await run(store, { targetSpanMs: 20 * 86_400_000, maxPages: 2, fetchPage: exchange(ANCHOR - 30 * 86_400_000).fetchPage });
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.pages, 2);
});

test("a non-minute-aligned target span is rejected instead of producing fractional coverage", async () => {
  await assert.rejects(run(newStore(), { targetSpanMs: 3 * M + 1, fetchPage: exchange(ANCHOR - 24 * 3_600_000).fetchPage }), /backfill span is invalid/);
});

test("existing identical candles can acquire receipts, but receipt-incomplete history is not complete", async () => {
  const store = newStore();
  const raw = [];
  for (let start = ANCHOR - 4 * M; start < ANCHOR; start += M) raw.push(candle(start, 1000 + ((start / M) % 7)));
  const rows = raw.map((item) => ({ closeTimeMs: Date.parse(`${item.candle_date_time_utc}Z`) + M, open: item.opening_price, high: item.high_price, low: item.low_price, close: item.trade_price, volume: item.candle_acc_trade_volume }));
  store.append(MARKET, M, rows);
  const result = await run(store, { targetSpanMs: 3 * M, fetchPage: async () => raw });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.recorded, 0, "receipt recovery does not rewrite immutable candles");
  assert.equal(store.hasMaterialCoverage(MARKET, M, ANCHOR - 2 * M, ANCHOR, "UPBIT_PUBLIC_CANDLES", UPBIT_CANDLE_SOURCE_FINGERPRINT), true);
});

test("malformed or inconsistent candles are dropped and counted, never stored", () => {
  const good = candle(ANCHOR - 5 * M);
  const parsed = parseUpbitMinuteCandles([
    good,
    { ...candle(ANCHOR - 6 * M), market: "KRW-BTC" },
    { ...candle(ANCHOR - 7 * M), trade_price: 0 },
    { ...candle(ANCHOR - 8 * M), high_price: 1, opening_price: 1000 },
    { ...candle(ANCHOR - 9 * M), candle_date_time_utc: "2026-10-03 05:51:07" },
    { ...candle(ANCHOR - 10 * M), candle_date_time_utc: stamp(ANCHOR - 10 * M + 7_000) },
    null, "x", {},
  ], MARKET);
  assert.equal(parsed.candles.length, 1);
  assert.equal(parsed.candles[0].closeTimeMs, ANCHOR - 4 * M, "close time is the candle start plus one minute");
  assert.equal(parsed.rejected, 8);
  assert.equal(parseUpbitMinuteCandles("nope", MARKET).rejected, 1);
});

test("the public fetcher is a bounded GET with no redirects and maps 429 to a rate limit", async () => {
  const seen = [];
  const ok = createUpbitMinuteCandleFetcher(async (url, init) => { seen.push([url, init]); return { status: 200, ok: true, json: async () => [] }; });
  await ok(MARKET, "2026-10-03T05:00:00");
  const url = new URL(seen[0][0]);
  assert.equal(`${url.origin}${url.pathname}`, UPBIT_MINUTE_CANDLES_URL);
  assert.deepEqual([url.searchParams.get("market"), url.searchParams.get("count"), url.searchParams.get("to")], [MARKET, "200", "2026-10-03T05:00:00Z"]);
  assert.equal(seen[0][1].method, "GET");
  assert.equal(seen[0][1].redirect, "error");
  assert.ok(seen[0][1].signal, "has a timeout signal");
  await assert.rejects(createUpbitMinuteCandleFetcher(async () => ({ status: 429, ok: false }))(MARKET, undefined), BackfillRateLimitedError);
  await assert.rejects(createUpbitMinuteCandleFetcher(async () => ({ status: 503, ok: false }))(MARKET, undefined), /status 503/);
  await assert.rejects(ok("../../etc", undefined), /market is invalid/);
});

test("the setting is on by default, and anything but ENABLED turns it off", () => {
  const base = { NUSA_CLOUD_RESEARCH_EXPERIMENTS: "1", NUSA_SOURCE_COMMIT_SHA: "a".repeat(40), NUSA_RESEARCH_MARKETS: "KRW-XRP" };
  assert.equal(readResearchExperimentSettings(base).settings.backfill, true);
  assert.equal(readResearchExperimentSettings({ ...base, NUSA_RESEARCH_BACKFILL: "ENABLED" }).settings.backfill, true);
  assert.equal(readResearchExperimentSettings({ ...base, NUSA_RESEARCH_BACKFILL: "DISABLED" }).settings.backfill, false);
  assert.equal(readResearchExperimentSettings({ ...base, NUSA_RESEARCH_BACKFILL: "enabled" }).settings.backfill, false, "a typo fails closed");
  assert.equal(readResearchExperimentSettings({ NUSA_RESEARCH_MARKETS: "KRW-XRP" }).status, "DISABLED", "research off means no backfill");
});

const { fillRecentGaps } = require("../dist/apps/cloud/src/researchCandleBackfill.js");
const stored = (closeMs, price = 10) => ({ closeTimeMs: closeMs, open: price, high: price + 1, low: price - 1, close: price });

test("gap fill writes only the minutes missing inside the stored history and never touches stored candles", async () => {
  const store = newStore();
  const first = ANCHOR - 600 * M;
  const live = [];
  for (let close = first; close <= ANCHOR; close += M) if (!(close > ANCHOR - 400 * M && close <= ANCHOR - 380 * M) && close !== ANCHOR - 10 * M) live.push(stored(close, 5));
  store.append(MARKET, M, live);
  const before = store.read(MARKET, M, first, ANCHOR).find((c) => c.closeTimeMs === ANCHOR - 100 * M);
  const ex = exchange(ANCHOR - 24 * 3_600_000);
  const result = await fillRecentGaps({ market: MARKET, windowMs: 600 * M, nowMs: NOW, store, fetchPage: ex.fetchPage, sleep: async () => undefined });
  assert.equal(result.missing, 21);
  assert.equal(result.recorded, 21);
  assert.equal(result.status, "FILLED");
  assert.equal(store.count(MARKET, M), 601, "every minute in the window now exists");
  assert.deepEqual(store.read(MARKET, M, first, ANCHOR).find((c) => c.closeTimeMs === ANCHOR - 100 * M), before, "stored candles are unchanged");
  assert.equal(store.read(MARKET, M, ANCHOR - 390 * M, ANCHOR - 390 * M)[0].close, 1000.5 + ((ANCHOR - 391 * M) / M % 7), "filled from the exchange candle that started one minute earlier");
});

test("gap fill does nothing without gaps and leaves exchange-missing minutes missing", async () => {
  const store = newStore();
  const all = [];
  for (let close = ANCHOR - 60 * M; close <= ANCHOR; close += M) all.push(stored(close));
  store.append(MARKET, M, all);
  let calls = 0;
  const none = await fillRecentGaps({ market: MARKET, windowMs: 60 * M, nowMs: NOW, store, fetchPage: async () => { calls += 1; return []; }, sleep: async () => undefined });
  assert.equal(none.status, "NO_GAPS");
  assert.equal(calls, 0);

  const sparse = newStore();
  sparse.append(MARKET, M, [stored(ANCHOR - 30 * M), stored(ANCHOR)]);
  const quiet = await fillRecentGaps({ market: MARKET, windowMs: 30 * M, nowMs: NOW, store: sparse, fetchPage: async () => [], sleep: async () => undefined });
  assert.equal(quiet.status, "PARTIAL");
  assert.equal(quiet.recorded, 0);
  assert.equal(sparse.count(MARKET, M), 2, "nothing is invented when the exchange has no candle either");
});

test("gap fill stops on a rate limit without retrying", async () => {
  const store = newStore();
  store.append(MARKET, M, [stored(ANCHOR - 5 * M), stored(ANCHOR)]);
  let calls = 0;
  const result = await fillRecentGaps({ market: MARKET, windowMs: 10 * M, nowMs: NOW, store, fetchPage: async () => { calls += 1; throw new BackfillRateLimitedError(); }, sleep: async () => undefined });
  assert.equal(result.status, "RATE_LIMITED");
  assert.equal(calls, 1);
});

test("gap fill rejects a repeated upstream page before re-recording it or advancing the cursor", async () => {
  const store = newStore();
  const first = ANCHOR - 501 * M;
  store.append(MARKET, M, [stored(first), stored(ANCHOR - M)]);
  const page = [];
  for (let start = ANCHOR - 200 * M; page.length < 200; start += M) page.push(candle(start));
  let calls = 0;
  const result = await fillRecentGaps({
    market: MARKET,
    windowMs: 600 * M,
    nowMs: NOW,
    store,
    maxPages: 2,
    fetchPage: async () => { calls += 1; return page; },
    sleep: async () => undefined,
  });
  assert.equal(result.status, "ERROR");
  assert.equal(result.errorCode, "CURSOR_NOT_ADVANCING");
  assert.equal(result.pages, 2);
  assert.equal(calls, 2);
  assert.equal(result.nextCursorStartMs, ANCHOR - 200 * M, "the last advancing cursor is preserved for a later retry");
});

test("gap fill also fetches the newest closed minutes after the last stored close (the series head is written only by REST candles)", async () => {
  const store = newStore();
  const stale = ANCHOR - 300 * M;
  const live = [];
  for (let close = stale - 120 * M; close <= stale; close += M) live.push(stored(close, 5));
  store.append(MARKET, M, live);
  const ex = exchange(ANCHOR - 24 * 3_600_000);
  const result = await fillRecentGaps({ market: MARKET, windowMs: 600 * M, nowMs: NOW, store, fetchPage: ex.fetchPage, sleep: async () => undefined });
  assert.equal(result.status, "FILLED");
  assert.equal(result.missing, 300, "the 300 closed minutes after the stale head");
  assert.equal(store.latestCloseTime(MARKET, M), ANCHOR, "head caught up to the newest closed minute");
  assert.equal(store.count(MARKET, M), 121 + 300);
});

test("backfill yields to the event loop after each processed page", async () => {
  const store = newStore();
  const ex = exchange(ANCHOR - 24 * 3_600_000);
  let yields = 0;
  const result = await run(store, { targetSpanMs: 8 * 3_600_000, fetchPage: ex.fetchPage, yieldControl: async () => { yields += 1; } });
  assert.equal(result.status, "COMPLETE");
  assert.equal(yields, result.pages);
  assert.ok(yields >= 2, "the fixture must exercise multiple bounded pages");
});
