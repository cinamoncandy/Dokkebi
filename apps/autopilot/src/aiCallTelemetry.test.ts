import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiCallUsage, estimateWorkersAiNeurons, logAiCall } from "./aiCallTelemetry";

describe("AI call telemetry", () => {
  it("reads Workers AI token usage and tolerates responses without it", () => {
    assert.deepEqual(aiCallUsage({ response: "x", usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } }), { promptTokens: 1200, completionTokens: 80 });
    assert.deepEqual(aiCallUsage({ response: "x" }), { promptTokens: null, completionTokens: null });
    assert.deepEqual(aiCallUsage("raw string"), { promptTokens: null, completionTokens: null });
    assert.deepEqual(aiCallUsage({ usage: { prompt_tokens: -1, completion_tokens: "80" } }), { promptTokens: null, completionTokens: null });
  });

  it("logs one numeric line per call and never the prompt or response body", () => {
    const lines: string[] = [];
    logAiCall({ caller: "C2_AUDIT", model: "@cf/model", attempt: 2, promptChars: 5000, response: { response: "SECRET-BODY", usage: { prompt_tokens: 1500, completion_tokens: 40 } } }, (line) => lines.push(line));
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0]!, /SECRET-BODY/);
    const event = JSON.parse(lines[0]!);
    assert.deepEqual(event, { event: "NUSA_AI_CALL", caller: "C2_AUDIT", model: "@cf/model", attempt: 2, promptChars: 5000, promptTokens: 1500, completionTokens: 40, estimatedNeurons: null, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY" });
  });

  it("records bounded diff-segment counts without logging repository text", () => {
    const lines: string[] = [];
    logAiCall({
      caller: "C2_AUDIT", model: "@cf/model", attempt: 1, promptChars: 9000,
      response: { response: "MODEL-OUTPUT" },
      reviewSegment: { index: 2, count: 3, changedFiles: 17, diffChars: 123_456 },
    }, (line) => lines.push(line));
    const event = JSON.parse(lines[0]!);
    assert.equal(event.reviewSegment, 2);
    assert.equal(event.reviewSegmentCount, 3);
    assert.equal(event.reviewSegmentFileCount, 17);
    assert.equal(event.reviewSegmentDiffChars, 123_456);
    assert.doesNotMatch(lines[0]!, /MODEL-OUTPUT|repository|filename|path/);
  });

  it("estimates neurons only for models with a known rate and complete usage", () => {
    assert.equal(estimateWorkersAiNeurons("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { promptTokens: 1_000_000, completionTokens: 100_000 }), 26_668 + 20_480.5);
    assert.equal(estimateWorkersAiNeurons("@cf/meta/llama-3.1-8b-instruct-fast", { promptTokens: 2_000, completionTokens: 500 }), 25.67);
    assert.equal(estimateWorkersAiNeurons("@cf/unknown/model", { promptTokens: 10, completionTokens: 10 }), null);
    assert.equal(estimateWorkersAiNeurons("@cf/meta/llama-3.1-8b-instruct-fast", { promptTokens: null, completionTokens: 10 }), null);
  });

  it("never throws into the call it observes", () => {
    assert.doesNotThrow(() => logAiCall({ caller: "C1_CODING", model: "m", attempt: 1, promptChars: 1, response: {} }, () => { throw new Error("log sink down"); }));
  });
});
