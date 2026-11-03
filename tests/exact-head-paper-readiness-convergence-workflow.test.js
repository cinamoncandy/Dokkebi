const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const yaml = require("js-yaml");
const {
  ACTUAL_PAPER_WORKFLOW_NAME,
  ACTUAL_PAPER_WORKFLOW_PATH,
  GITHUB_ACTIONS_BOT,
  READINESS_WORKFLOW_PATH,
  readGitHubWorkflowRunIdentity,
  validateArtifactArchiveDigest,
  validateSourceArtifact,
  validateSourceRun,
} = require("../scripts/lib/exact-head-paper-readiness-source.js");

const TARGET_SHA = "3046600b093f8f07a26ba11df3fc48043ae00830";
const SOURCE_RUN_ID = "41592256311";
const SOURCE_RUN_ATTEMPT = "1";
const REPOSITORY = "cinamoncandy/NUSA";
const REPOSITORY_ID = 1296492411;

function sourceRun(overrides = {}) {
  return {
    id: Number(SOURCE_RUN_ID),
    name: ACTUAL_PAPER_WORKFLOW_NAME,
    path: ACTUAL_PAPER_WORKFLOW_PATH,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: TARGET_SHA,
    status: "completed",
    conclusion: "success",
    run_attempt: Number(SOURCE_RUN_ATTEMPT),
    actor: { login: GITHUB_ACTIONS_BOT },
    triggering_actor: { login: GITHUB_ACTIONS_BOT },
    repository: { full_name: REPOSITORY, id: REPOSITORY_ID },
    ...overrides,
  };
}

function sourceArtifact(overrides = {}) {
  return {
    id: 13210682112,
    name: `wo-0059-actual-paper-runtime-evidence-${TARGET_SHA}-attempt-${SOURCE_RUN_ATTEMPT}`,
    digest: `sha256:${"a".repeat(64)}`,
    expired: false,
    workflow_run: {
      id: Number(SOURCE_RUN_ID),
      head_sha: TARGET_SHA,
      repository_id: REPOSITORY_ID,
      head_repository_id: REPOSITORY_ID,
    },
    ...overrides,
  };
}

function runExpectation(overrides = {}) {
  return {
    sourceRunId: SOURCE_RUN_ID,
    sourceRunAttempt: SOURCE_RUN_ATTEMPT,
    targetSha: TARGET_SHA,
    currentMainSha: TARGET_SHA,
    repository: REPOSITORY,
    requireTokenDispatch: true,
    ...overrides,
  };
}

function artifactExpectation(overrides = {}) {
  return {
    sourceRunId: SOURCE_RUN_ID,
    repositoryId: REPOSITORY_ID,
    targetSha: TARGET_SHA,
    artifactName: `wo-0059-actual-paper-runtime-evidence-${TARGET_SHA}-attempt-${SOURCE_RUN_ATTEMPT}`,
    ...overrides,
  };
}

test("canonical main Actual PAPER run can be verified as the exact token-dispatched source", () => {
  assert.deepEqual(validateSourceRun(sourceRun(), runExpectation()), {
    runId: Number(SOURCE_RUN_ID),
    runAttempt: Number(SOURCE_RUN_ATTEMPT),
    headSha: TARGET_SHA,
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
  });
});

test("source run rejects wrong run, attempt, workflow, repository, branch, SHA, event, actor, or completion", () => {
  const cases = [
    ["RUN_ID_MISMATCH", { id: 41592256312 }],
    ["RUN_ATTEMPT_MISMATCH", { run_attempt: 2 }],
    ["WORKFLOW_NAME_MISMATCH", { name: "Unrelated workflow" }],
    ["WORKFLOW_PATH_MISMATCH", { path: ".github/workflows/unrelated.yml" }],
    ["REPOSITORY_MISMATCH", { repository: { full_name: "other/repo", id: REPOSITORY_ID } }],
    ["BRANCH_MISMATCH", { head_branch: "feature/branch" }],
    ["HEAD_SHA_MISMATCH", { head_sha: "1111111111111111111111111111111111111111" }],
    ["TOKEN_DISPATCH_EVENT_MISMATCH", { event: "push" }],
    ["TOKEN_DISPATCH_ACTOR_MISMATCH", { actor: { login: "human" } }],
    ["TOKEN_DISPATCH_TRIGGERING_ACTOR_MISMATCH", { triggering_actor: { login: "human" } }],
    ["RUN_NOT_COMPLETED", { status: "in_progress" }],
    ["RUN_NOT_SUCCESSFUL", { conclusion: "failure" }],
  ];

  for (const [reason, overrides] of cases) {
    assert.throws(() => validateSourceRun(sourceRun(overrides), runExpectation()), new RegExp(reason));
  }
  assert.throws(
    () => validateSourceRun(sourceRun(), runExpectation({ currentMainSha: "2222222222222222222222222222222222222222" })),
    /TARGET_NOT_CURRENT_MAIN/,
  );
  assert.throws(
    () => validateSourceRun(sourceRun(), runExpectation({ requireTokenDispatch: false, sourceRunAttempt: "" })),
    /EXPECTED_RUN_ATTEMPT_INVALID/,
  );
});

test("non-token workflow_run sources remain limited to the exact main Actual PAPER workflow", () => {
  const pushRun = sourceRun({ event: "push", actor: { login: "nusa-release-authority[bot]" }, triggering_actor: { login: "nusa-release-authority[bot]" } });
  assert.equal(validateSourceRun(pushRun, runExpectation({ requireTokenDispatch: false })).runId, Number(SOURCE_RUN_ID));
  assert.throws(
    () => validateSourceRun(sourceRun({ event: "pull_request" }), runExpectation({ requireTokenDispatch: false })),
    /EVENT_MISMATCH/,
  );
});

test("artifact metadata must bind one unexpired digest to the exact source run, repository, and SHA", () => {
  const verified = validateSourceArtifact(sourceArtifact(), artifactExpectation());
  assert.equal(verified.artifactId, 13210682112);
  assert.match(verified.digest, /^sha256:[a-f0-9]{64}$/);

  const cases = [
    ["ARTIFACT_EXPIRED_OR_UNKNOWN", { expired: true }],
    ["ARTIFACT_NAME_MISMATCH", { name: "other-artifact" }],
    ["ARTIFACT_NAME_MISMATCH", { name: `wo-0059-actual-paper-runtime-evidence-${TARGET_SHA}-attempt-2` }],
    ["ARTIFACT_DIGEST_INVALID", { digest: "sha256:not-a-digest" }],
    ["ARTIFACT_RUN_ID_MISMATCH", { workflow_run: { id: 1, head_sha: TARGET_SHA, repository_id: REPOSITORY_ID, head_repository_id: REPOSITORY_ID } }],
    ["ARTIFACT_HEAD_SHA_MISMATCH", { workflow_run: { id: Number(SOURCE_RUN_ID), head_sha: "1111111111111111111111111111111111111111", repository_id: REPOSITORY_ID, head_repository_id: REPOSITORY_ID } }],
    ["ARTIFACT_REPOSITORY_ID_MISMATCH", { workflow_run: { id: Number(SOURCE_RUN_ID), head_sha: TARGET_SHA, repository_id: 1, head_repository_id: 1 } }],
    ["ARTIFACT_HEAD_REPOSITORY_ID_MISMATCH", { workflow_run: { id: Number(SOURCE_RUN_ID), head_sha: TARGET_SHA, repository_id: REPOSITORY_ID, head_repository_id: 1 } }],
  ];
  for (const [reason, overrides] of cases) {
    assert.throws(() => validateSourceArtifact(sourceArtifact(overrides), artifactExpectation()), new RegExp(reason));
  }
});

test("producer workflow identity includes a valid run ID and attempt when running in GitHub Actions", () => {
  assert.deepEqual(readGitHubWorkflowRunIdentity({ GITHUB_RUN_ID: SOURCE_RUN_ID, GITHUB_RUN_ATTEMPT: SOURCE_RUN_ATTEMPT }), {
    id: Number(SOURCE_RUN_ID),
    attempt: Number(SOURCE_RUN_ATTEMPT),
  });
  assert.equal(readGitHubWorkflowRunIdentity({}), null);
  assert.throws(() => readGitHubWorkflowRunIdentity({ GITHUB_RUN_ID: SOURCE_RUN_ID }), /PRODUCER_RUN_ATTEMPT_INVALID/);
  assert.throws(() => readGitHubWorkflowRunIdentity({ GITHUB_RUN_ID: "0", GITHUB_RUN_ATTEMPT: "1" }), /PRODUCER_RUN_ID_INVALID/);
});

test("downloaded artifact archive must match the GitHub-provided SHA-256 digest", () => {
  const archive = Buffer.from("exact artifact archive bytes");
  const digest = `sha256:${require("node:crypto").createHash("sha256").update(archive).digest("hex")}`;
  assert.equal(validateArtifactArchiveDigest(archive, digest), digest);
  assert.throws(() => validateArtifactArchiveDigest(archive, `sha256:${"0".repeat(64)}`), /ARTIFACT_ARCHIVE_DIGEST_MISMATCH/);
  assert.throws(() => validateArtifactArchiveDigest(archive, "not-a-digest"), /ARTIFACT_DIGEST_INVALID/);
});

test("actual workflow issues only a main token-run callback using a job-scoped actions token", () => {
  const workflow = yaml.load(fs.readFileSync(".github/workflows/wo-0059-actual-paper-runtime.yml", "utf8"));
  const callback = workflow.jobs["dispatch-readiness-convergence"];
  assert.ok(callback);
  assert.deepEqual(callback.needs, "actual-paper-runtime");
  assert.deepEqual(callback.permissions, { actions: "write", contents: "read" });
  assert.match(callback.if, /always\(\)/);
  assert.match(callback.if, /github\.event_name\s*==\s*'workflow_dispatch'/);
  assert.match(callback.if, /github\.ref\s*==\s*'refs\/heads\/main'/);
  assert.match(callback.if, /github\.actor\s*==\s*'github-actions\[bot\]'/);
  assert.match(callback.if, /github\.triggering_actor\s*==\s*'github-actions\[bot\]'/);
  const script = callback.steps.map((step) => step.run ?? "").join("\n");
  assert.match(script, /actions\/workflows\/exact-head-paper-readiness-convergence\.yml\/dispatches/);
  assert.match(script, /source_run_id/);
  assert.match(script, /source_run_attempt/);
  assert.match(script, /GITHUB_RUN_ID/);
  assert.match(script, /GITHUB_RUN_ATTEMPT/);
  assert.match(script, /GITHUB_SHA/);
  const actualPaper = workflow.jobs["actual-paper-runtime"];
  const legacyArtifact = actualPaper.steps.find((step) => step.name === "Upload legacy-name Actual PAPER runtime evidence");
  const attemptArtifact = actualPaper.steps.find((step) => step.name === "Upload attempt-scoped Actual PAPER runtime evidence");
  assert.match(legacyArtifact.with.name, /wo-0059-actual-paper-runtime-evidence-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(attemptArtifact.with.name, /github\.run_attempt/);
});

test("convergence accepts exact run inputs, waits boundedly, and suppresses callback redispatch", () => {
  const workflow = yaml.load(fs.readFileSync(READINESS_WORKFLOW_PATH, "utf8"));
  const dispatchInputs = workflow.on.workflow_dispatch.inputs;
  assert.ok(dispatchInputs.source_run_id);
  assert.ok(dispatchInputs.source_run_attempt);
  const steps = workflow.jobs.converge.steps;
  const resolveSource = steps.find((step) => step.id === "source").run;
  assert.match(resolveSource, /INPUT_SOURCE_RUN_ID/);
  assert.match(resolveSource, /INPUT_SOURCE_RUN_ATTEMPT/);
  assert.match(resolveSource, /seq 1 24/);
  assert.match(resolveSource, /sleep 5/);
  assert.match(resolveSource, /scripts\/validate-exact-head-paper-readiness-source\.js run/);
  assert.match(resolveSource, /scripts\/validate-exact-head-paper-readiness-source\.js artifact/);
  assert.match(resolveSource, /EVENT_ACTOR/);
  assert.match(resolveSource, /EVENT_TRIGGERING_ACTOR/);
  assert.match(resolveSource, /certified_count/);
  assert.match(resolveSource, /source_run_attempt/);
  assert.match(resolveSource, /evidence-\$target_sha-attempt-\$source_run_attempt/);

  const certify = steps.find((step) => step.id === "certify").run;
  assert.match(certify, /INPUT_SOURCE_RUN_ID/);
  assert.match(certify, /artifact-archive/);
  assert.match(certify, /-z "\$INPUT_SOURCE_RUN_ID"/);
  assert.equal((certify.match(/-z "\$INPUT_SOURCE_RUN_ID"/g) ?? []).length, 1);
  assert.match(resolveSource, /-z "\$INPUT_SOURCE_RUN_ID"/);
});
