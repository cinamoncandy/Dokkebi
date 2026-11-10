import assert from "node:assert/strict";
import test from "node:test";
import { executeVerifiedIsolatedCausalVerification } from "./isolatedCausalVerificationHarness";
import type { VerifiedIsolatedSourceRun } from "./githubActionsOidc";
import type { VerifiedIsolatedCausalVerification } from "./sigstoreCausalAttestation";

const sha = "a".repeat(40);
const runId = "41590000001";
const runAttempt = "1";
const workflowRef = "cinamoncandy/NUSA/.github/workflows/causal-verification.yml@refs/heads/main";

const verified: VerifiedIsolatedCausalVerification = Object.freeze({
  domain: "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1",
  source: Object.freeze({
    repository: "cinamoncandy/NUSA",
    workflowPath: ".github/workflows/causal-verification.yml",
    workflowRef,
    workflowSha: sha,
    ref: "refs/heads/main",
    event: "workflow_dispatch",
    job: "verify-causal-positive",
    sha,
    runId,
    runAttempt,
  }),
  caseId: "isolated-policy-regression",
  fixtureDigest: "b".repeat(64),
  statementDigest: "c".repeat(64),
  signerIdentity: Object.freeze({ subjectAlternativeName: `https://github.com/${workflowRef}`, issuer: "https://token.actions.githubusercontent.com" }),
});

const source: VerifiedIsolatedSourceRun = Object.freeze({
  repository: "cinamoncandy/NUSA",
  workflowPath: ".github/workflows/causal-verification.yml",
  sha,
  runId,
  runAttempt,
  status: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
  branch: "main",
  jobId: 445566,
});

function githubFetch(): typeof fetch {
  return async (resource) => {
    const url = String(resource);
    if (url === `https://api.github.com/repos/cinamoncandy/NUSA/commits/${sha}`) return Response.json({ sha });
    if (url === `https://api.github.com/repos/cinamoncandy/NUSA/actions/runs/${runId}`) {
      return Response.json({
        id: Number(runId), head_sha: sha, head_branch: "main", status: "completed", conclusion: "success",
        repository: { full_name: "cinamoncandy/NUSA" }, run_attempt: Number(runAttempt),
      });
    }
    throw new Error(`unexpected GitHub lookup: ${url}`);
  };
}

function durableClaim() {
  const consumed = new Set<string>();
  let calls = 0;
  return {
    get calls() { return calls; },
    async claim(evidence: VerifiedIsolatedCausalVerification) {
      calls += 1;
      const key = `${evidence.source.repository}:${evidence.source.runId}:${evidence.source.runAttempt}`;
      const sourceIdentityDigest = "d".repeat(64);
      if (consumed.has(key)) return { claimed: false, sourceIdentityDigest };
      consumed.add(key);
      return { claimed: true, sourceIdentityDigest };
    },
  };
}

test("verified source claims durable replay guard before one bounded CodingRunner execution", async () => {
  const claims = durableClaim();
  const input = {
    githubToken: "synthetic-token",
    fetchImpl: githubFetch(),
    verifiedSourceRun: source,
    claimAttempt: claims.claim,
  };
  const result = await executeVerifiedIsolatedCausalVerification(verified, input);
  assert.deepEqual(result, {
    domain: "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1",
    decision: "CODE_ACTIONABLE",
    classification: "REPOSITORY_CODE_REGRESSION",
    sourceSha: sha,
    sourceRunId: runId,
    sourceRunAttempt: runAttempt,
    durableReplayGuard: "SQLITE_DURABLE_OBJECT_CLAIMED",
    sourceIdentityDigest: "d".repeat(64),
    codingRunnerStatus: "EXECUTION_ACCEPTED",
    proposalAdapterCalls: 1,
    sandboxExecutions: 1,
    dedupe: "REPLAY_REJECTED_WITHIN_SINGLE_HARNESS",
    mutationAllowed: false,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
  await assert.rejects(
    executeVerifiedIsolatedCausalVerification(verified, input),
    { message: "ISOLATED_SOURCE_RUN_ALREADY_CLAIMED" },
  );
  assert.equal(claims.calls, 3, "first claim, explicit replay check, and retried consumer all share the durable identity");
});

test("source identity mismatch is rejected before the durable claim", async () => {
  const claims = durableClaim();
  await assert.rejects(
    executeVerifiedIsolatedCausalVerification(verified, {
      githubToken: "synthetic-token",
      fetchImpl: githubFetch(),
      verifiedSourceRun: Object.freeze({ ...source, event: "push" }) as unknown as VerifiedIsolatedSourceRun,
      claimAttempt: claims.claim,
    }),
    { message: "ISOLATED_VERIFICATION_SOURCE_RUN_MISMATCH" },
  );
  assert.equal(claims.calls, 0);
});

test("claim uncertainty fails before any CodingRunner request", async () => {
  let runnerRequests = 0;
  const fetchImpl: typeof fetch = async (resource) => {
    const url = String(resource);
    if (url.endsWith(`/commits/${sha}`) || url.includes("/actions/runs/")) runnerRequests += 1;
    return githubFetch()(resource);
  };
  await assert.rejects(
    executeVerifiedIsolatedCausalVerification(verified, {
      githubToken: "synthetic-token",
      fetchImpl,
      verifiedSourceRun: source,
      claimAttempt: async () => { throw new Error("ISOLATED_CAUSAL_CLAIM_STORAGE_UNAVAILABLE"); },
    }),
    { message: "ISOLATED_CAUSAL_CLAIM_STORAGE_UNAVAILABLE" },
  );
  assert.equal(runnerRequests, 0);
});
