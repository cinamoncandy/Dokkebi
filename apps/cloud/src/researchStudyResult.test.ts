import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORDERBOOK_STUDY_RESULT_FILE, parseOrderBookStudyResult, readOrderBookStudyDisplay, readOrderBookStudyResult } from "./researchStudyResult";
import { buildMetaLearningStatus } from "./researchMetaLearningRuntime";
import { RESEARCH_LEDGER_SNAPSHOT } from "./researchLedgerSnapshot";

const result = { schemaVersion: 1, studyId: "ML_ORDERBOOK_60M_20261029", status: "HOLDOUT_FAIL", eligible: 180, discoveryPass: true, datasetFingerprint: "a".repeat(64), holdoutTrades: 288 };

describe("autonomous study result handoff", () => {
  it("turns a finished study into one ledger entry and fails closed on anything else", () => {
    assert.deepEqual({ ...parseOrderBookStudyResult(result) }, { id: "ML_ORDERBOOK_60M_20261029", source: "BACKTEST", dataType: "ORDERBOOK", timeframe: "60m", universe: 180, methodClass: "ML", configs: 3, discoveryPass: 1, holdoutPass: 0 });
    assert.equal(parseOrderBookStudyResult({ ...result, status: "HOLDOUT_PASS" })?.holdoutPass, 1);
    for (const bad of [null, [], { ...result, status: "WAITING_DATA" }, { ...result, studyId: "OTHER" }, { ...result, datasetFingerprint: "x" }, { ...result, eligible: 2 }, { ...result, schemaVersion: 2 }, { ...result, discoveryPass: "yes" }]) {
      assert.equal(parseOrderBookStudyResult(bad), undefined, JSON.stringify(bad));
    }
  });

  it("attributes a result to the study named in the file: the second run is never recorded as the first", () => {
    const second = { ...result, studyId: "ML_ORDERBOOK_60M_20261111", status: "HOLDOUT_PASS" };
    assert.equal(parseOrderBookStudyResult(second)?.id, "ML_ORDERBOOK_60M_20261111");
    assert.equal(parseOrderBookStudyResult(result)?.id, "ML_ORDERBOOK_60M_20261029");
    const dir = mkdtempSync(join(tmpdir(), "nusa-study2-"));
    writeFileSync(join(dir, ORDERBOOK_STUDY_RESULT_FILE), JSON.stringify(second));
    assert.equal(readOrderBookStudyResult(join(dir, "cloud-state.db"))?.id, "ML_ORDERBOOK_60M_20261111");
    assert.equal(readOrderBookStudyDisplay(join(dir, "cloud-state.db"))?.studyId, "ML_ORDERBOOK_60M_20261111");
    assert.equal(parseOrderBookStudyResult({ ...second, studyId: "ML_ORDERBOOK_60M_20261201" }), undefined, "an unregistered id is ignored");
  });

  it("is read from beside the state database, and a missing or corrupt file is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "nusa-study-"));
    const db = join(dir, "cloud-state.db");
    assert.equal(readOrderBookStudyResult(db), undefined);
    writeFileSync(join(dir, ORDERBOOK_STUDY_RESULT_FILE), "{not json");
    assert.equal(readOrderBookStudyResult(db), undefined);
    writeFileSync(join(dir, ORDERBOOK_STUDY_RESULT_FILE), JSON.stringify(result));
    assert.equal(readOrderBookStudyResult(db)?.id, "ML_ORDERBOOK_60M_20261029");
  });

  it("a failed study changes the meta-learner's next recommendation without anyone editing the ledger", () => {
    const before = buildMetaLearningStatus({ ledger: RESEARCH_LEDGER_SNAPSHOT, researchMarkets: 1 });
    const after = buildMetaLearningStatus({ ledger: [...RESEARCH_LEDGER_SNAPSHOT, parseOrderBookStudyResult(result)!], researchMarkets: 1 });
    assert.equal(before.recommended, "ORDERBOOK+INTRADAY+ALL_KRW+ML");
    assert.notEqual(after.recommended, "ORDERBOOK+INTRADAY+ALL_KRW+ML", "the tried combination is no longer recommended");
    assert.equal(after.configurations, before.configurations + 3);
  });

  it("projects the result read-only for the app and is null for anything absent or malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "nusa-study-display-"));
    const db = join(dir, "cloud-state.db");
    assert.equal(readOrderBookStudyDisplay(db), null);
    writeFileSync(join(dir, ORDERBOOK_STUDY_RESULT_FILE), "{not json");
    assert.equal(readOrderBookStudyDisplay(db), null);
    writeFileSync(join(dir, ORDERBOOK_STUDY_RESULT_FILE), JSON.stringify({ ...result, eligible: 2 }));
    assert.equal(readOrderBookStudyDisplay(db), null);
    writeFileSync(join(dir, ORDERBOOK_STUDY_RESULT_FILE), JSON.stringify(result));
    const shown = readOrderBookStudyDisplay(db);
    assert.deepEqual({ ...shown, resultFileMtimeMs: typeof shown?.resultFileMtimeMs }, { schemaVersion: 1, studyId: "ML_ORDERBOOK_60M_20261029", status: "HOLDOUT_FAIL", eligible: 180, discoveryPass: true, resultFileMtimeMs: "number" });
    assert.equal("datasetFingerprint" in (shown ?? {}), false);
    writeFileSync(join(dir, ORDERBOOK_STUDY_RESULT_FILE), JSON.stringify({ ...result, status: "HOLDOUT_PASS" }));
    assert.equal(readOrderBookStudyDisplay(db)?.status, "HOLDOUT_PASS");
  });
});
