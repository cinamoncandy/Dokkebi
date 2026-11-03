import assert from "node:assert/strict";
import test from "node:test";
import { executeVerifiedIsolatedCausalVerification } from "./isolatedCausalVerificationHarness";
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
  signerIdentity: Object.freeze({ subjectAlternativeName: workflowRef, issuer: "https://token.actions.githubusercontent.com" }),
});

function sourceRun(overrides: Record<string, unknown> = {}) {
  return {
    id: Number(runId),
    run_attempt: Number(runAttempt),
    path: ".github/workflows/causal-verification.yml",
    name: "NUSA Isolated Causal Verification",
    event: "workflow_dispatch",
    head_sha: sha,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    repository: { full_name: "cinamoncandy/NUSA" },
    ...overrides,
  };
}

test("isolated proof claims a durable source-run replay guard before one bounded CodingRunner execution", async () => {
  let claimed = false;
  let creates = 0;
  let completions = 0;
  const fetchImpl: typeof fetch = async (resource, init) => {
    const url = String(resource);
    if (url.includes(`/actions/runs/${runId}`)) return Response.json(sourceRun());
    if (url.includes("/check-runs?") && (!init?.method || init.method === "GET")) {
      return Response.json({ check_runs: claimed ? [{ name: `NUSA Isolated Causal Replay Guard ${runId}.${runAttempt}` }] : [] });
    }
    if (url.endsWith("/check-runs") && init?.method === "POST") {
      creates += 1;
      claimed = true;
      return Response.json({ id: 876 });
    }
    if (url.endsWith("/check-runs/876") && init?.method === "PATCH") {
      completions += 1;
      return Response.json({ id: 876 });
    }
    if (url === `https://api.github.com/repos/cinamoncandy/NUSA/commits/${sha}`) return Response.json({ sha });
    throw new Error(`unexpected GitHub lookup: ${url}`);
  };

  const input = { githubToken: "synthetic-token", fetchImpl };
  const result = await executeVerifiedIsolatedCausalVerification(verified, input);
  assert.deepEqual(result, {
    domain: "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1",
    decision: "CODE_ACTIONABLE",
    classification: "REPOSITORY_CODE_REGRESSION",
    sourceSha: sha,
    sourceRunId: runId,
    sourceRunAttempt: runAttempt,
    durableReplayGuard: "GITHUB_CHECK_RUN_CLAIMED",
    sourceCheckRunId: 876,
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
  assert.equal(creates, 1, "the exact source run has one durable claim across separate harness invocations");
  assert.equal(completions, 1, "only the first invocation reaches execution and completes the claim");
});

test("isolated positive harness rejects a source run whose canonical workflow identity differs", async () => {
  const fetchImpl: typeof fetch = async (resource) => {
    const url = String(resource);
    if (url.includes("/commits/")) return Response.json({ sha });
    if (url.includes(`/actions/runs/${runId}`)) return Response.json(sourceRun({ event: "push" }));
    throw new Error(`unexpected GitHub lookup: ${url}`);
  };
  await assert.rejects(
    executeVerifiedIsolatedCausalVerification(verified, { fetchImpl }),
    { message: "ISOLATED_SOURCE_RUN_IDENTITY_INVALID" },
  );
});

test("isolated positive harness rejects source SHA or workflow identity substitution", async () => {
  const fetchImpl: typeof fetch = async (resource) => {
    const url = String(resource);
    if (url.includes("/commits/")) return Response.json({ sha });
    if (url.includes(`/actions/runs/${runId}`)) return Response.json(sourceRun({ head_sha: "d".repeat(40) }));
    throw new Error(`unexpected GitHub lookup: ${url}`);
  };
  await assert.rejects(
    executeVerifiedIsolatedCausalVerification(verified, { fetchImpl }),
    { message: "ISOLATED_SOURCE_RUN_IDENTITY_INVALID" },
  );
});
