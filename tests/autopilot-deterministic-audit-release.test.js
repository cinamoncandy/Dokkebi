import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(".github/workflows/autopilot-deterministic-audit-release.yml", "utf8");
const auditWorkflow = workflow.split(/\r?\n  release:\r?\n/, 1)[0];

test("Audit workflow exposes immutable dispatch identity as the GitHub run name", () => {
  assert.match(workflow, /run-name:\s*\$\{\{ github\.event\.client_payload\.dedupe_key/);
});

test("deterministic Audit has no Cloudflare or AI merge dependency", () => {
  assert.match(auditWorkflow, /Autopilot Deterministic Audit Release/);
  assert.match(auditWorkflow, /github\.event\.client_payload\.kind == 'AUDIT_REQUEST'/);
  assert.doesNotMatch(auditWorkflow, /workers\.dev|\/audit\/execute|Workers AI|env\.AI|id-token:\s*write/);
  assert.match(auditWorkflow, /authority=DETERMINISTIC_AUDIT_PASS/);
});

test("deterministic Audit binds exact PR, protected main, canonical CI, and six required workflows", () => {
  assert.match(workflow, /pulls\/\$PR_NUMBER/);
  assert.match(workflow, /branches\/main/);
  assert.match(workflow, /current_base.*current_main/);
  assert.match(workflow, /actions\/runs\/\$WORKFLOW_RUN_ID/);
  assert.match(workflow, /\.path == "\.github\/workflows\/ci\.yml"/);
  for (const name of [
    "CI",
    "Actual PAPER Public-Market Runtime Evidence",
    "Read-only Broker Credential Integration",
    "Restricted LIVE Capability Surface Guard",
    "Restricted LIVE Transport Credential Readiness",
    "Restricted LIVE Activation Rehearsal",
  ]) assert.match(workflow, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Audit waits boundedly for independent exact-head evidence convergence", () => {
  assert.match(workflow, /for poll in \$\(seq 1 30\)/);
  assert.match(workflow, /head_sha=\$REQUESTED_HEAD&event=pull_request&per_page=100/);
  assert.match(workflow, /conclusion.*!= "success"/);
  assert.match(workflow, /required_ready.*true/);
  assert.match(workflow, /bounded Audit deadline/);
});

test("stale Audit requests are NO_ACTION and cannot release", () => {
  assert.match(workflow, /NO_ACTION stale\/non-releasable Audit request/);
  assert.match(workflow, /current_draft/);
  assert.match(workflow, /current_hold/);
  assert.match(workflow, /\.labels \| type\) != "array"/);
  assert.match(workflow, /any\(\.labels\[\]; \(\.name \| ascii_downcase\) == "hold"\)/);
  assert.match(workflow, /current_draft" = "true"/);
  assert.match(workflow, /current_hold" != "false"/);
  assert.match(workflow, /applicable=false/);
  assert.match(workflow, /authority=NONE/);
  assert.match(workflow, /needs\.audit\.outputs\.applicable == 'true'/);
  assert.match(workflow, /needs\.audit\.outputs\.authority == 'DETERMINISTIC_AUDIT_PASS'/);
});

test("Release re-verifies exact expected head and audited base before merge", () => {
  assert.match(workflow, /Re-verify expected head and audited base/);
  assert.match(workflow, /EXPECTED_HEAD/);
  assert.match(workflow, /AUDITED_BASE/);
  assert.match(workflow, /final_draft/);
  assert.match(workflow, /final_hold/);
  assert.match(workflow, /test "\$final_hold" = "false"/);
  assert.match(workflow, /release_hold/);
  assert.match(workflow, /test "\$release_hold" = "false"/);
  assert.ok((workflow.match(/test "\$release_hold" = "false"/g) || []).length >= 3,
    "Release must re-check HOLD before each authority-sensitive transition");
  assert.match(workflow, /-f sha="\$EXPECTED_HEAD"/);
  assert.match(workflow, /\.merged == true/);
});

test("Release reuses an exact-main CI run before dispatching a duplicate", () => {
  assert.match(workflow, /actions:\s*write/);
  assert.match(workflow, /Start canonical post-merge main CI/);
  assert.match(workflow, /actions\/runs\?head_sha=\$MERGED_MAIN&per_page=100/);
  assert.match(workflow, /gh api --paginate --slurp/);
  assert.match(workflow, /\.status == "queued" or \.status == "in_progress" or \.status == "pending"/);
  assert.match(workflow, /\.status == "completed" and \.conclusion == "success"/);
  assert.match(workflow, /suppressing duplicate dispatch/);
  assert.match(workflow, /actions\/workflows\/ci\.yml\/dispatches/);
  assert.match(workflow, /-f ref=main/);
  assert.match(workflow, /merged_main/);
});

test("Release gives an exact-main CI push a bounded visibility grace before fallback dispatch", () => {
  const startCi = workflow.split("- name: Start canonical post-merge main CI", 2)[1].split("\n      - name:", 1)[0];
  assert.match(startCi, /for poll in \$\(seq 1 6\)/);
  assert.match(startCi, /actions\/runs\?head_sha=\$MERGED_MAIN&per_page=100/);
  assert.match(startCi, /\.name == "CI" and \.path == "\.github\/workflows\/ci\.yml" and \.head_sha == \$sha/);
  assert.match(startCi, /sleep 3/);
  assert.match(startCi, /Waiting for exact-main push CI to materialize before fallback dispatch/);
  assert.match(startCi, /Main advanced during exact-main CI visibility grace/);
  assert.match(startCi, /actions\/workflows\/ci\.yml\/dispatches/);
  assert.match(startCi, /Exact-main CI attempt \$failed_ci_run failed; preserving the existing bounded rerun recovery path and suppressing fallback dispatch/);
  assert.ok(startCi.indexOf("for poll in") < startCi.indexOf("actions/workflows/ci.yml/dispatches"),
    "manual fallback must remain after the bounded exact-head propagation grace");
  const recovery = workflow.split("- name: Recover post-merge CI retries and dispatch Cloudflare Deploy", 2)[1].split("\n      - name:", 1)[0];
  assert.match(recovery, /Post-merge CI attempt \$failed_attempt failed; requesting bounded rerun/);
  assert.match(recovery, /rerun-failed-jobs/);
  assert.ok(startCi.indexOf("failed_ci_run=") < startCi.indexOf("actions/workflows/ci.yml/dispatches"),
    "a failed exact-head run must defer to the existing bounded recovery, not launch a second full CI");
});

test("Release recovers bounded post-merge CI and suppresses duplicate Cloudflare Deploy dispatch", () => {
  assert.match(workflow, /Recover post-merge CI retries and dispatch Cloudflare Deploy/);
  assert.match(workflow, /for poll in \$\(seq 1 40\)/);
  assert.match(workflow, /actions\/runs\?head_sha=\$MERGED_MAIN&per_page=100/);
  assert.match(workflow, /\.conclusion == "success"/);
  assert.match(workflow, /rerun-failed-jobs/);
  assert.match(workflow, /failed_attempt" -ge 3/);
  assert.match(workflow, /Post-merge CI SUCCESS recovered/);
  assert.match(workflow, /actions\/workflows\/autopilot-cloudflare-deploy\.yml\/runs\?head_sha=\$MERGED_MAIN&per_page=100/);
  assert.match(workflow, /\.status == "in_progress"/);
  assert.match(workflow, /\.status == "completed" and \.conclusion == "success"/);
  assert.match(workflow, /suppressing duplicate Release dispatch/);
  assert.match(workflow, /no active\/successful exact-main Deploy; dispatching bounded fallback/);
  assert.match(workflow, /actions\/workflows\/autopilot-cloudflare-deploy\.yml\/dispatches/);
  assert.match(workflow, /inputs\[head_sha\]=\$MERGED_MAIN/);
});

test("Release dispatches only active unowned exact-main downstream workflows after post-merge CI succeeds", () => {
  const downstream = workflow.split("- name: Dispatch exact-main runtime evidence and CI-gated downstream workflows directly", 2)[1];
  assert.match(downstream, /CURRENT_MAIN=.*branches\/main/);
  assert.match(downstream, /CURRENT_MAIN.*MERGED_MAIN/);
  assert.match(downstream, /dispatch_exact_main_downstream\(\)/);
  assert.match(downstream, /actions\/workflows\/\$workflow.*--jq '\.state'/);
  assert.match(downstream, /allow_manual_disable/);
  assert.match(downstream, /state.*disabled_manually.*allow_manual_disable/s);
  assert.match(downstream, /Skipping intentionally disabled optional downstream workflow/);
  assert.match(downstream, /state.*active/);
  assert.match(downstream, /Unexpected downstream workflow state/);
  assert.match(downstream, /actions\/workflows\/\$workflow\/runs\?head_sha=\$MERGED_MAIN&per_page=100/);
  assert.match(downstream, /actions\/runs\/\$candidate_run\/jobs\?per_page=100/);
  assert.match(downstream, /\.name == \$name/);
  assert.match(downstream, /\.status == "pending"/);
  assert.match(downstream, /\.status == "completed" and \.conclusion == "success"/);
  assert.match(downstream, /applicable_job/);
  assert.match(downstream, /\.event\] \| @tsv/);
  assert.match(downstream, /while IFS=.*read -r candidate_run candidate_status candidate_event/s);
  assert.doesNotMatch(downstream, /candidate_conclusion/);
  assert.match(downstream, /candidate_event.*workflow_run/s);
  assert.match(downstream, /Active Cloudflare workflow_dispatch run.*cannot prove/);
  assert.match(downstream, /candidate_status.*completed.*branches\/cloudflare-production/s);
  assert.match(downstream, /branches\/cloudflare-production/);
  assert.match(downstream, /git\/commits\/\$MERGED_MAIN.*\.tree\.sha/s);
  assert.match(downstream, /git\/trees\/\$verified_apps_tree.*path == "autopilot"/s);
  assert.match(downstream, /git\/trees\/\$production_apps_tree.*path == "autopilot"/s);
  assert.match(downstream, /verified_autopilot_tree.*production_autopilot_tree/s);
  assert.match(downstream, /no deployment-relevant change remains/);
  assert.match(downstream, /compare\/\$MERGED_MAIN\.\.\.\$production_sha/);
  assert.match(downstream, /production_relation.*ahead.*identical/s);
  assert.match(downstream, /completed without proving exact-main promotion/);
  assert.doesNotMatch(downstream, /\.conclusion == "skipped"/);
  assert.doesNotMatch(downstream, /\.conclusion == "success"\)\]\s*\|/);
  assert.doesNotMatch(downstream, /\.conclusion == "skipped"/);
  assert.doesNotMatch(downstream, /\.conclusion == "success"\)\]\s*\|/);
  assert.match(downstream, /applicable job '\$expected_job' owns convergence/);
  assert.match(downstream, /actions\/workflows\/\$workflow\/dispatches/);
  assert.match(downstream, /dispatch_exact_main_downstream wo-0059-actual-paper-runtime\.yml false actual-paper-runtime/);
  assert.match(downstream, /dispatch_exact_main_downstream autopilot-cloudflare-promote\.yml false "Promote exact CI-verified Worker revision"/);
  assert.match(downstream, /inputs\[head_sha\]=\$MERGED_MAIN/);
  assert.match(downstream, /dispatch_exact_main_downstream android-stable-release-trigger\.yml true dispatch/);
  assert.doesNotMatch(downstream, /android-stable-release\.yml/);
  assert.match(downstream, /dispatch_exact_main_downstream windows-desktop-stable-release\.yml false "Build and publish exact-main Windows installer"/);
  assert.doesNotMatch(downstream, /enable.*workflow|workflows\/.*\/enable/i, "Release must never re-enable an intentionally disabled workflow");
});

test("safety invariants remain fail-closed", () => {
  assert.match(workflow, /live_authority !== 'NONE'/);
  assert.match(workflow, /production_mutation_allowed !== false/);
  assert.match(workflow, /ai_authority !== 'ZERO_AUTHORITY'/);
  assert.match(workflow, /liveAuthority=NONE/);
  assert.match(workflow, /productionMutationAllowed=false/);
  assert.match(workflow, /aiAuthority=ZERO_AUTHORITY/);
});


test("already-merged convergence is non-applicable for an open PR, accepts existing dedicated authorization, and preserves missing-provenance failure", () => {
  const convergence = fs.readFileSync(".github/workflows/autopilot-already-merged-audit-convergence.yml", "utf8");
  assert.match(convergence, /pulls\/\$PR_NUMBER/);
  assert.match(convergence, /if \[ "\$pr_state" = "open" \]/);
  assert.match(convergence, /NO_ACTION Audit convergence is not applicable to an open PR/);
  assert.match(convergence, /CONVERGED existing exact-head dedicated Release authorization/);
  assert.match(convergence, /commits\/\$EXPECTED_HEAD\/statuses\?per_page=100/);
  assert.match(convergence, /\.creator\.login == "nusa-release-authority\[bot\]"/);
  assert.match(convergence, /startswith\("canonical Audit PASS; pr=" \+ \$pr \+ "; base="\)/);
  assert.match(convergence, /RELEASE_PROVENANCE_MISSING: already-merged PRs cannot be post-facto upgraded/);
  const noActionIndex = convergence.indexOf("NO_ACTION Audit convergence is not applicable to an open PR");
  const convergedIndex = convergence.indexOf("CONVERGED existing exact-head dedicated Release authorization");
  const provenanceFailureIndex = convergence.indexOf("RELEASE_PROVENANCE_MISSING: already-merged PRs cannot be post-facto upgraded");
  assert.ok(noActionIndex >= 0 && convergedIndex > noActionIndex && provenanceFailureIndex > convergedIndex);
  assert.match(convergence.slice(provenanceFailureIndex), /exit 1/);
});


test("Release serialization is classified as NO_ACTION before deterministic Audit work", () => {
  assert.match(auditWorkflow, /issues:\s*read/);
  assert.match(auditWorkflow, /open-issues-pages\.json/);
  assert.match(auditWorkflow, /\^P0\(\?:\\s\|:\)/);
  assert.match(auditWorkflow, /Refs\\s\+\#903/);
  assert.match(auditWorkflow, /release-serialization-block\.json/);
  assert.match(auditWorkflow, /NO_ACTION Release serialized before Audit/);
  assert.match(auditWorkflow, /blocked_by=P0#/);
  const serializationIndex = auditWorkflow.indexOf("NO_ACTION Release serialized before Audit");
  const ciFetchIndex = auditWorkflow.indexOf('actions/runs/$WORKFLOW_RUN_ID');
  assert.ok(serializationIndex >= 0 && ciFetchIndex > serializationIndex,
    "canonical P0 serialization must short-circuit before CI/evidence Audit work");
});


test("Release preflights expected review blocks before merge API and keeps them non-terminal", () => {
  assert.match(workflow, /Preflight protected-branch mergeability/);
  assert.match(workflow, /reviewThreads\(first:100\)/);
  assert.match(workflow, /BLOCKED Release preflight: unresolved_review_threads=/);
  assert.match(workflow, /merge_ready=false/);
  assert.match(workflow, /steps\.merge_preflight\.outputs\.merge_ready == 'true'/);
  const preflightIndex = workflow.indexOf("Preflight protected-branch mergeability");
  const mergeIndex = workflow.indexOf("Canonical expected-head merge");
  assert.ok(preflightIndex >= 0 && mergeIndex > preflightIndex);
  assert.match(workflow, /Revoke authorization if merge preflight blocks activation/);
});

test("a transient GitHub API failure in the merge step retries instead of ending the release path", () => {
  const merge = workflow.slice(workflow.indexOf("- name: Canonical expected-head merge"), workflow.indexOf('echo "merged_main=$verified_merge_sha"'));
  assert.match(merge, /for merge_attempt in 1 2 3; do/, "the exact-head merge is attempted up to three times");
  assert.match(merge, /"false \$EXPECTED_HEAD"\) ;;/, "an unchanged unmerged head retries");
  assert.match(merge, /"false "\*\) echo "PR head moved; not retrying the merge\."; break ;;/, "a moved head stops the retry");
  assert.match(merge, /if ! pr="\$\(gh api "repos\/\$GITHUB_REPOSITORY\/pulls\/\$PR_NUMBER" 2>\/dev\/null\)" \|\| ! jq -e \. /, "a failed read-back retries instead of exiting");
  assert.match(merge, /sha="\$EXPECTED_HEAD"/, "the merge stays bound to the exact audited head");
  assert.match(merge, /\[ "\$base" = "\$AUDITED_BASE" \]/, "the read-back still requires the audited base");
});
