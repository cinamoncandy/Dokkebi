import assert from "node:assert/strict";
import test from "node:test";
import { prepareDiscoveredCodingRequest } from "./evolveCodingBridge";
import type { EvolutionDiscoverySignal } from "./evolveOpportunityDiscovery";

const now = new Date("2026-08-29T07:20:00.000Z");
const signal = (id: string, overrides: Partial<EvolutionDiscoverySignal> = {}): EvolutionDiscoverySignal => ({
  id,
  source: "ci",
  reference: `ci:${id}`,
  problem: `Improve ${id}`,
  observedAt: "2026-08-29T07:19:00.000Z",
  evidenceQuality: 0.9,
  impact: 0.8,
  confidence: 0.9,
  risk: 0.2,
  reversibility: 0.9,
  ...overrides,
});

const baseInput = () => ({
  signals: [signal("candidate")],
  now,
  repository: "cinamoncandy/NUSA",
  headSha: "d3171864d989cf9897bd5f514f8cb45489b15056",
  workflowRunId: 33239968298,
  executionId: "evolve:discovery:candidate",
  dedupeKey: "evolve:discovery:candidate:d3171864",
  circuit: { state: "CLOSED" as const, consecutiveFailures: 0 },
  schedulePolicy: { mode: "AUTONOMOUS" as const, minIntervalSeconds: 60, maxConcurrent: 1 },
  activeExecutions: 0,
  elapsedSecondsSinceLastRun: 120,
});

test("connects fresh bounded discovery evidence to the existing CodingRunner request contract", () => {
  const result = prepareDiscoveredCodingRequest(baseInput());
  assert.equal(result.status, "READY");
  assert.equal(result.request?.kind, "REPOSITORY_AUTOPILOT");
  assert.equal(result.request?.headSha, "d3171864d989cf9897bd5f514f8cb45489b15056");
  assert.equal(result.request?.workflowRunId, 33239968298);
  assert.equal(result.request?.mutationAllowed, false);
  assert.deepEqual(result.authority, {
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
});

test("abstains when no discovery evidence exists", () => {
  const result = prepareDiscoveredCodingRequest({ ...baseInput(), signals: [] });
  assert.equal(result.status, "ABSTAINED");
  assert.equal(result.request, null);
  assert.equal(result.reason, "no-eligible-opportunity");
});

test("binds the selected workflow opportunity to the exact cited run and SHA", () => {
  const base = baseInput();
  const matching = signal("workflow-matching", { source: "github-actions", reference: `workflow:${base.workflowRunId}@${base.headSha}` });
  assert.equal(prepareDiscoveredCodingRequest({ ...base, signals: [matching] }).status, "READY");
  for (const reference of [`workflow:${base.workflowRunId + 1}@${base.headSha}`, `workflow:${base.workflowRunId}@${"a".repeat(40)}`, "workflow:invalid"]) {
    const result = prepareDiscoveredCodingRequest({ ...base, signals: [{ ...matching, reference }] });
    assert.equal(result.status, "ABSTAINED");
    assert.equal(result.reason, "selected-workflow-source-mismatch");
    assert.equal(result.request, null);
  }
});

test("checks the ranked workflow opportunity rather than assuming the first signal was selected", () => {
  const base = baseInput();
  const matching = signal("workflow-first", { source: "github-actions", reference: `workflow:${base.workflowRunId}@${base.headSha}`, impact: 0.1 });
  const preferredMismatch = signal("workflow-preferred", { source: "github-actions", reference: `workflow:${base.workflowRunId + 1}@${base.headSha}`, impact: 1 });
  const result = prepareDiscoveredCodingRequest({ ...base, signals: [matching, preferredMismatch] });
  assert.equal(result.status, "ABSTAINED");
  assert.equal(result.reason, "selected-workflow-source-mismatch");
});

test("rejects stale discovery evidence and does not prepare coding work", () => {
  const result = prepareDiscoveredCodingRequest({
    ...baseInput(),
    signals: [signal("stale", { observedAt: "2026-08-29T05:00:00.000Z" })],
  });
  assert.equal(result.status, "ABSTAINED");
  assert.deepEqual(result.rejectedSignalIds, ["stale"]);
  assert.equal(result.request, null);
});

test("fails closed when the circuit is open", () => {
  const result = prepareDiscoveredCodingRequest({
    ...baseInput(),
    circuit: { state: "OPEN" as const, consecutiveFailures: 2, openedAt: "2026-08-29T07:00:00.000Z" },
  });
  assert.equal(result.status, "ABSTAINED");
  assert.equal(result.reason, "circuit-open");
  assert.equal(result.request, null);
});

test("fails closed when the scheduler denies another execution", () => {
  const result = prepareDiscoveredCodingRequest({ ...baseInput(), elapsedSecondsSinceLastRun: 10 });
  assert.equal(result.status, "ABSTAINED");
  assert.equal(result.reason, "minimum-interval-not-reached");
  assert.equal(result.request, null);
});
