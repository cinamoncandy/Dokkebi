import assert from "node:assert/strict";
import test from "node:test";
import { claimCausalDispatchBinding, hashCausalDispatchCapability, newCausalDispatchCapability, type CausalDispatchBinding } from "./causalDispatchBinding";
import type { SourceExecutionIdentity, VerifiedCodingPublisherIdentity } from "./githubActionsOidc";

const repository = "cinamoncandy/NUSA";
const source: SourceExecutionIdentity = Object.freeze({ repository, workflowPath: ".github/workflows/ci.yml", sha: "a".repeat(40), runId: "456", runAttempt: "2" });
const publisher: VerifiedCodingPublisherIdentity = Object.freeze({ repository, workflowRef: `${repository}/.github/workflows/autopilot-execution-consumer.yml@refs/heads/main`, ref: "refs/heads/main", sha: source.sha, runId: "789", runAttempt: "1", event: "repository_dispatch" });
const digest = "a".repeat(64);
const pending: CausalDispatchBinding = Object.freeze({ source, capabilityDigest: digest, expiresAt: 200, publisher: null });

test("generates bounded random capability and stores only its digest", async () => {
  const first = newCausalDispatchCapability();
  const second = newCausalDispatchCapability();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.notEqual(await hashCausalDispatchCapability(first), first);
  await assert.rejects(() => hashCausalDispatchCapability("not-a-capability"), /CAUSAL_DISPATCH_CAPABILITY_INVALID/);
});

test("binds one verified publisher to the pre-registered source and denies replay", () => {
  const claimed = claimCausalDispatchBinding(pending, publisher, source, digest, 100);
  assert.ok(claimed);
  assert.deepEqual(claimed.publisher, publisher);
  assert.equal(claimCausalDispatchBinding(claimed, publisher, source, digest, 101), null);
  assert.equal(claimCausalDispatchBinding(claimed, { ...publisher, runId: "790" }, source, digest, 101), null);
});

test("denies source, publisher, capability, and time substitution", () => {
  for (const changed of [
    { repository: "other/NUSA" }, { workflowPath: ".github/workflows/other.yml" },
    { sha: "b".repeat(40) }, { runId: "457" }, { runAttempt: "1" },
  ]) assert.equal(claimCausalDispatchBinding(pending, publisher, { ...source, ...changed }, digest, 100), null);
  for (const changed of [
    { repository: "other/NUSA" }, { workflowRef: `${repository}/.github/workflows/ci.yml@refs/heads/main` },
    { sha: "b".repeat(40) }, { ref: "refs/heads/other" }, { event: "push" },
    { runId: "" }, { runAttempt: "0" },
  ]) assert.equal(claimCausalDispatchBinding(pending, { ...publisher, ...changed }, source, digest, 100), null);
  assert.equal(claimCausalDispatchBinding(pending, publisher, source, "b".repeat(64), 100), null);
  assert.equal(claimCausalDispatchBinding(pending, publisher, source, digest, 200), null);
  assert.equal(claimCausalDispatchBinding(pending, publisher, source, digest, -1), null);
});
