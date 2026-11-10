const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildRuntimeEnv, resolveDashboardToken, start, stripPrivateExchangeCredentials } = require("../scripts/start-cloud-runtime.js");

const TOKEN = "t".repeat(64);

test("an unconfigured launch supplies every input the runtime requires, including live public market data", () => {
  const { env, applied } = buildRuntimeEnv({}, TOKEN);
  // readCloudRuntimeConfig throws on each of these, so a missing one is not a degraded
  // start -- it is a process that exits before it listens.
  assert.equal(env.NUSA_CLOUD_DASHBOARD_PORT, "41731");
  assert.equal(env.NUSA_CLOUD_DASHBOARD_HOST, "127.0.0.1");
  assert.equal(env.NUSA_CLOUD_DASHBOARD_TOKEN, TOKEN);
  // Without public market data the runtime holds killSwitchActive and every PAPER order is
  // rejected as MARKET_DATA_INVALID, which is indistinguishable from a broken product.
  assert.equal(env.NUSA_CLOUD_UPBIT_PUBLIC_DATA, "true");
  // Without initial capital the PAPER execution loop is never constructed at all (the committed owner decision applies).
  assert.equal(env.NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW, "100000");
  assert.ok(applied.includes("NUSA_CLOUD_UPBIT_PUBLIC_DATA"));
  assert.ok(applied.includes("NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW"));
});

test("the launcher pins PAPER authority and cannot be talked into LIVE by the surrounding environment", () => {
  const { env } = buildRuntimeEnv({}, TOKEN);
  assert.equal(env.NUSA_MODE, "PAPER");
  assert.equal(env.NUSA_LIVE_MUTATION, "PROHIBITED");
});

test("explicit configuration always wins over launcher defaults", () => {
  const caller = Object.freeze({
    NUSA_CLOUD_DASHBOARD_PORT: "9999",
    NUSA_CLOUD_DASHBOARD_HOST: "0.0.0.0",
    NUSA_CLOUD_UPBIT_PUBLIC_DATA: "false",
    NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW: "500000",
    NUSA_CLOUD_DASHBOARD_TOKEN: "caller-supplied-token-caller-supplied-token",
  });
  const { env, applied } = buildRuntimeEnv(caller, TOKEN, null);
  assert.equal(env.NUSA_CLOUD_DASHBOARD_PORT, "9999");
  assert.equal(env.NUSA_CLOUD_DASHBOARD_HOST, "0.0.0.0");
  // An operator who deliberately turned market data off keeps it off.
  assert.equal(env.NUSA_CLOUD_UPBIT_PUBLIC_DATA, "false");
  assert.equal(env.NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW, "500000");
  assert.equal(env.NUSA_CLOUD_DASHBOARD_TOKEN, "caller-supplied-token-caller-supplied-token");
  for (const key of Object.keys(caller)) assert.ok(!applied.includes(key), `${key} must not be overridden`);
});

test("a blank or whitespace-only value is treated as absent rather than as configuration", () => {
  const { env } = buildRuntimeEnv({ NUSA_CLOUD_DASHBOARD_PORT: "   ", NUSA_CLOUD_UPBIT_PUBLIC_DATA: "" }, TOKEN);
  assert.equal(env.NUSA_CLOUD_DASHBOARD_PORT, "41731");
  assert.equal(env.NUSA_CLOUD_UPBIT_PUBLIC_DATA, "true");
});

test("a configured dashboard token does not require the fallback token file and starts with the trusted SQLite preload", () => {
  const listeners = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, new Set(process.listeners(signal))]));
  const child = {
    exitCode: null,
    stderr: { on() {} },
    on() {},
    kill() {}
  };
  let spawnOptions;
  try {
    start({
      cwd: path.resolve(__dirname, ".."),
      env: { NUSA_CLOUD_DASHBOARD_TOKEN: TOKEN },
      resolveToken: () => { throw new Error("fallback token file must not be touched"); },
      spawn: (_command, args, options) => { spawnOptions = options; assert.deepEqual(args, ["--require", path.resolve(__dirname, "..", "dist/packages/storage/src/sqliteIntegrityBootstrap.js"), require("../scripts/start-cloud-runtime.js").PRODUCTION_RUNTIME_ENTRYPOINT]); return child; },
      write: () => {}
    });
    assert.equal(spawnOptions.env.NUSA_CLOUD_DASHBOARD_TOKEN, TOKEN);
  } finally {
    for (const [signal, before] of listeners) {
      for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
    }
  }
});

test("runtime database child does not inherit mutable NODE_OPTIONS preloads", () => {
  const { env } = buildRuntimeEnv({ NODE_OPTIONS: "--require ./untrusted-preload.js --max-old-space-size=128" }, TOKEN);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("private exchange credentials are stripped from the runtime environment, not forwarded", () => {
  const hostile = {
    UPBIT_ACCESS_KEY: "should-not-reach-the-runtime",
    UPBIT_SECRET_KEY: "should-not-reach-the-runtime",
    BINANCE_API_KEY: "should-not-reach-the-runtime",
    NUSA_CLOUD_DASHBOARD_TOKEN: TOKEN,
    UPBIT_PUBLIC_BASE_URL: "https://api.upbit.com",
    PATH: "/usr/bin",
  };
  const { env, stripped } = buildRuntimeEnv(hostile, TOKEN);
  for (const key of ["UPBIT_ACCESS_KEY", "UPBIT_SECRET_KEY", "BINANCE_API_KEY"]) {
    assert.equal(env[key], undefined, `${key} must not reach the PAPER runtime`);
    assert.ok(stripped.includes(key));
  }
  // Non-credential configuration and unrelated variables are left alone.
  assert.equal(env.UPBIT_PUBLIC_BASE_URL, "https://api.upbit.com");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(JSON.stringify(env).includes("should-not-reach-the-runtime"), false);
});

test("stripping reports exactly what it removed and leaves the caller's object untouched", () => {
  const source = Object.freeze({ UPBIT_SECRET_KEY: "x", SAFE: "y" });
  const { env, stripped } = stripPrivateExchangeCredentials(source);
  assert.deepEqual([...stripped], ["UPBIT_SECRET_KEY"]);
  assert.equal(env.SAFE, "y");
  assert.equal(source.UPBIT_SECRET_KEY, "x", "input must not be mutated");
});

test("the dashboard token is generated once, owner-only, and stable across restarts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-launcher-token-"));
  const tokenFile = path.join(directory, "nested", "dashboard-token");
  try {
    const first = resolveDashboardToken(tokenFile);
    // The runtime rejects anything under 32 UTF-8 bytes.
    assert.ok(Buffer.byteLength(first, "utf8") >= 32);
    assert.match(first, /^[0-9a-f]{64}$/);
    // A restart must not invalidate the token already configured on the phone.
    assert.equal(resolveDashboardToken(tokenFile), first);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, "token file must not be world-readable");
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a truncated or corrupted token file is replaced rather than passed to the runtime", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nusa-launcher-token-short-"));
  const tokenFile = path.join(directory, "dashboard-token");
  try {
    fs.writeFileSync(tokenFile, "too-short\n", "utf8");
    const resolved = resolveDashboardToken(tokenFile);
    assert.notEqual(resolved, "too-short");
    assert.ok(Buffer.byteLength(resolved, "utf8") >= 32);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("the owner PAPER account file sets initial capital over the host environment and fails closed when malformed", () => {
  const { readOwnerPaperAccount, OWNER_PAPER_ACCOUNT_FILE } = require("../scripts/start-cloud-runtime.js");
  const owner = readOwnerPaperAccount();
  assert.equal(owner.initialCapitalKrw, 100000, "the committed owner decision is KRW 100,000 (2026-10-28)");
  assert.ok(OWNER_PAPER_ACCOUNT_FILE.endsWith(path.join("deploy", "oracle", "paper-account.json")));
  const { env, applied } = buildRuntimeEnv({ NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW: "10000000" }, TOKEN, owner);
  assert.equal(env.NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW, "100000");
  assert.ok(applied.includes("NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-paper-"));
  const bad = path.join(dir, "paper-account.json");
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, initialCapitalKrw: -1 }));
  assert.throws(() => readOwnerPaperAccount(bad), /owner PAPER account file is invalid/);
  assert.equal(readOwnerPaperAccount(path.join(dir, "missing.json")), null);
});

test("the owner-retired PAPER accounts reach the runtime from the committed owner decision", () => {
  const { readOwnerPaperAccount, buildRuntimeEnv } = require("../scripts/start-cloud-runtime.js");
  const owner = readOwnerPaperAccount();
  assert.deepEqual([...owner.retiredAccountIds], ["paper-default"], "owner decision 2026-09-29: delete the KRW 10,000,000 ledger");
  const { env } = buildRuntimeEnv({}, "t".repeat(64), owner);
  assert.equal(env.NUSA_PAPER_RETIRED_ACCOUNT_IDS, "paper-default");
});

test("the owner PAPER markets file sets the trading and research markets over the host environment and fails closed when malformed", () => {
  const { readOwnerPaperMarkets, OWNER_PAPER_MARKETS_FILE, buildRuntimeEnv: build } = require("../scripts/start-cloud-runtime.js");
  const owner = readOwnerPaperMarkets();
  assert.deepEqual([...owner.markets], ["KRW-XRP"], "owner decision 2026-10-03: XRP first");
  assert.ok(OWNER_PAPER_MARKETS_FILE.endsWith(path.join("deploy", "oracle", "paper-markets.json")));
  const host = { NUSA_CLOUD_UPBIT_MARKETS: "KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL,KRW-DOGE", NUSA_RESEARCH_MARKETS: "KRW-BTC" };
  const { env, applied } = build(host, TOKEN, null, owner);
  assert.equal(env.NUSA_CLOUD_UPBIT_MARKETS, "KRW-XRP");
  assert.equal(env.NUSA_RESEARCH_MARKETS, "KRW-XRP");
  assert.ok(applied.includes("NUSA_CLOUD_UPBIT_MARKETS") && applied.includes("NUSA_RESEARCH_MARKETS"));
  assert.equal(build({}, TOKEN, null, null).env.NUSA_CLOUD_UPBIT_MARKETS, undefined, "no file, nothing applied");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-markets-"));
  const write = (value) => { const f = path.join(dir, "m.json"); fs.writeFileSync(f, JSON.stringify(value)); return f; };
  for (const bad of [{ schemaVersion: 1, markets: [] }, { schemaVersion: 1, markets: ["BTC-KRW"] }, { schemaVersion: 1, markets: ["KRW-XRP", "KRW-XRP"] },
    { schemaVersion: 1, markets: ["KRW-A", "KRW-B", "KRW-C", "KRW-D", "KRW-E", "KRW-F"] }, { schemaVersion: 2, markets: ["KRW-XRP"] }, { schemaVersion: 1, markets: "KRW-XRP" }]) {
    assert.throws(() => readOwnerPaperMarkets(write(bad)), /owner PAPER markets file is invalid/);
  }
  assert.equal(readOwnerPaperMarkets(path.join(dir, "missing.json")), null);
});

test("the owner research file turns the research experiments on over the host environment and fails closed when malformed", () => {
  const { readOwnerResearch, OWNER_RESEARCH_FILE, buildRuntimeEnv: build } = require("../scripts/start-cloud-runtime.js");
  const owner = readOwnerResearch();
  assert.equal(owner.experiments, true, "owner decision 2026-10-05: collect learning data");
  assert.ok(OWNER_RESEARCH_FILE.endsWith(path.join("deploy", "oracle", "research-experiments.json")));
  const off = build({ NUSA_CLOUD_RESEARCH_EXPERIMENTS: "0" }, TOKEN, null, null, owner);
  assert.equal(off.env.NUSA_CLOUD_RESEARCH_EXPERIMENTS, "1", "the owner decision overrides a host that left it off");
  assert.ok(off.applied.includes("NUSA_CLOUD_RESEARCH_EXPERIMENTS"));
  const already = build({ NUSA_CLOUD_RESEARCH_EXPERIMENTS: "1" }, TOKEN, null, null, owner);
  assert.ok(!already.applied.includes("NUSA_CLOUD_RESEARCH_EXPERIMENTS"), "nothing to apply when the host agrees");
  assert.equal(build({}, TOKEN, null, null, { experiments: false }).env.NUSA_CLOUD_RESEARCH_EXPERIMENTS, "0", "false switches it off");
  assert.equal(build({}, TOKEN, null, null, null).env.NUSA_CLOUD_RESEARCH_EXPERIMENTS, undefined, "no file, nothing applied");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-research-"));
  const write = (value) => { const f = path.join(dir, "r.json"); fs.writeFileSync(f, JSON.stringify(value)); return f; };
  for (const bad of [{ schemaVersion: 1 }, { schemaVersion: 1, experiments: "yes" }, { schemaVersion: 2, experiments: true }, { experiments: true }, []]) {
    assert.throws(() => readOwnerResearch(write(bad)), /owner research file is invalid/);
  }
  assert.equal(readOwnerResearch(path.join(dir, "missing.json")), null);
  assert.deepEqual([...owner.intervalMinutes], [1, 15, 60], "owner decision 2026-10-06: compare longer bars in research");
  assert.equal(off.env.NUSA_RESEARCH_INTERVAL_MINUTES, "1,15,60");
  assert.equal(build({}, TOKEN, null, null, { experiments: true }).env.NUSA_RESEARCH_INTERVAL_MINUTES, undefined, "no list, research default (1m) stays");
  for (const bad of [{ schemaVersion: 1, experiments: true, intervalMinutes: [] }, { schemaVersion: 1, experiments: true, intervalMinutes: [5] }, { schemaVersion: 1, experiments: true, intervalMinutes: [60, 60] }, { schemaVersion: 1, experiments: true, intervalMinutes: "60" }]) {
    assert.throws(() => readOwnerResearch(write(bad)), /owner research file is invalid/);
  }
  // The runtime still needs a valid build commit, so the switch alone cannot enable it on a malformed deploy.
  const { readResearchExperimentSettings } = require("../dist/apps/cloud/src/researchExperimentComposition.js");
  assert.equal(readResearchExperimentSettings(off.env).status, "INVALID");
  assert.equal(readResearchExperimentSettings({ ...off.env, NUSA_SOURCE_COMMIT_SHA: "a".repeat(40) }).status, "ENABLED");
  assert.deepEqual([...readResearchExperimentSettings({ ...off.env, NUSA_SOURCE_COMMIT_SHA: "a".repeat(40), NUSA_RESEARCH_MARKETS: "KRW-XRP" }).settings.markets], ["KRW-XRP"]);
});

test("the optional rollingHoldout owner key accepts only the exact words OFF or SHADOW, is not set in the shipped file, and defaults to OFF in the settings", () => {
  const { readOwnerResearch, buildRuntimeEnv: build } = require("../scripts/start-cloud-runtime.js");
  const { readResearchExperimentSettings } = require("../dist/apps/cloud/src/researchExperimentComposition.js");
  assert.equal(readOwnerResearch().rollingHoldout, undefined, "the shipped owner file does not enable the rolling check");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-rolling-"));
  const write = (value) => { const f = path.join(dir, "r.json"); fs.writeFileSync(f, JSON.stringify(value)); return f; };
  for (const bad of ["shadow", "ENFORCE", true, 1, null]) assert.throws(() => readOwnerResearch(write({ schemaVersion: 1, experiments: true, rollingHoldout: bad })), /owner research file is invalid/);
  const shadow = readOwnerResearch(write({ schemaVersion: 1, experiments: true, rollingHoldout: "SHADOW" }));
  const applied = build({}, TOKEN, null, null, shadow);
  assert.equal(applied.env.NUSA_RESEARCH_ROLLING_HOLDOUT, "SHADOW");
  assert.ok(applied.applied.includes("NUSA_RESEARCH_ROLLING_HOLDOUT"));
  assert.equal(build({}, TOKEN, null, null, { experiments: true }).env.NUSA_RESEARCH_ROLLING_HOLDOUT, undefined, "no key, nothing applied");
  const base = { NUSA_CLOUD_RESEARCH_EXPERIMENTS: "1", NUSA_SOURCE_COMMIT_SHA: "a".repeat(40) };
  assert.equal(readResearchExperimentSettings(base).settings.rollingHoldout, "OFF");
  assert.equal(readResearchExperimentSettings({ ...base, NUSA_RESEARCH_ROLLING_HOLDOUT: "SHADOW" }).settings.rollingHoldout, "SHADOW");
  for (const typo of ["shadow", "ENFORCE", "1", ""]) assert.equal(readResearchExperimentSettings({ ...base, NUSA_RESEARCH_ROLLING_HOLDOUT: typo }).settings.rollingHoldout, "OFF", `a typo (${typo}) never turns it on`);
});
