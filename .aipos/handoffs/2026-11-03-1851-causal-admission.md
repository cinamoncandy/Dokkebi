# CORE handoff — 2026-11-03 — #1851 causal admission

## Scope and owner

Continue the existing #1851 implementation under `.aipos/work-orders/WO-AUTOPILOT-20261030-1851-CAUSAL-ADMISSION.yaml`. The isolated local branch is `codex/1851-causal-admission-20261103` in the existing `nusa-1851-causal-admission` checkout. Its base and local HEAD are protected main `0e213243ac5b63e7fe900666b0055da9ca96de18`; implementation changes remain uncommitted. #1854 is closed and must not be revived. No active #1851 implementation PR was found in the current ownership check.

## Implemented locally

The WIP connects source/publisher OIDC and exact run identity checks to the existing causal admission, coordinator, CodingRunner, and `/coding/propose` and `/coding/publish` routes. It binds the proposal receipt to the source run, capability, requested patch, target, SHA, and expiry; the server recomputes the allowed one-file repair content from trusted source evidence rather than accepting client `validatedFiles`. Generic workflow failure fails closed before lease or dispatch. Existing issue/backlog admission remains a separate route. No new scheduler or execution engine was added.

These are local implementation claims backed by synthetic tests only. No real protected-main attestation, positive causal receipt, or `CODE_ACTIONABLE` decision has been observed or issued. The patch does not grant LIVE, order, transfer, or production mutation authority.

## Validation on current main

- Full isolated suite: 1,326/1,326 on the prior base `0e6161a7…` plus WIP; historical after main advanced.
- Current-main delta on `0e213243…`: 61/61 targeted tests passed.
- Current-main `typecheck`, `build`, `validate:full`, `lint:scripts` (0 errors, 47 warnings), AIPOS work-order provenance validation, and `git diff --check`: pass.
- `security:gate`: failed after three bounded attempts with `AUDIT_JSON_INCOMPLETE`. A direct audit report had zero high/critical findings, but the repository security gate itself did not pass; no override was applied.
- Do not claim the entire 1,326-test suite passed on `0e213243…`.

## Governance and next step

Commit gate is **NOT MET**. No commit, push, PR, CI dispatch, review request, or thread resolution was made. The security parser experiment remains excluded because it belongs to a separate existing work order and requires its own owner GO. Keep #2976 isolated at `BLOCKED_INDEPENDENT_IDENTITY`; its P1 disposition has no recognized independent GitHub identity yet, and it does not block local #1851 implementation work.

Next: retain this local WIP; resolve the security gate only through its own canonical work order and explicit owner authorization, then rerun required gates. Any causal positive path remains closed until genuine exact-source/protected-main evidence passes after governed inclusion. L1 remains PARTIAL; L2 HOLD; `LEARNING_LOOP_VERIFIED=false`; `PERFORMANCE_IMPROVEMENT=UNPROVEN`.

Preserved stashes: `605506ab219835df51c7fef03d3a3398b3879b5e` and `0c43ec3b25ab406f707fe420ee4350bc410009da`. Failure diagnostics remain in the worktree and those stashes. Safety: PAPER_ONLY, `liveAuthority=NONE`, `productionMutationAllowed=false`, `realOrderAuthority=false`, `realTransferAuthority=false`, `aiAuthority=ZERO_AUTHORITY`.

## Security-gate evidence follow-up

The existing #1851 worktree is accessible and protected main remains `0e213243ac5b63e7fe900666b0055da9ca96de18`. A separate local `codex/audit-json-output-hardening` checkout is clean, 3,492 commits behind current main, and has no parser diff; no matching remote branch or open Issue/PR was found. The 2026-11-03 dependency audit report says vulnerability scan PASS and audit shape mismatch NO, but it is not the raw output from the three failed gate attempts.

A read-only in-memory reproduction confirmed the current brace-counting parser rejects valid JSON containing an unmatched `{` inside a quoted string with `AUDIT_JSON_INCOMPLETE`; a quoted `}` case is rejected by JSON.parse. This confirms a parser defect for those inputs, **not** that any of the three actual failures had those inputs. No parser changes or gate retries were made. The first required transition remains recovery of the original stdout/stderr, exit codes, and raw `pnpm audit --json` output.

## Prior run output recovered from Codex history

The prior execution record shows `security:gate` failing with exit 1 after three bounded attempts and the reported `AUDIT_JSON_INCOMPLETE` message; a later invocation passed; a subsequent invocation failed the same way. Between these, a direct `pnpm audit --json` capture reported exit 1, 16,624 stdout bytes, empty stderr, valid JSON, 12 advisories (0 high/critical), and no audit error. The raw nested stdout from the failed attempts was not saved. This fail/pass/fail sequence is new evidence of intermittent behavior, but it still cannot distinguish quoted-brace parser failure from truncated/variable producer output. Do not patch based on this sequence alone.

The current-main full isolated suite then passed 1,326/1,326 after adding the installed Git for Windows Bash directory to PATH; the first Windows attempt had stopped at `spawnSync bash ENOENT`. A captured fresh direct audit and the nested audit from an instrumented gate PASS had identical SHA-256 `41cf3f9b19cc1e707f74a89875964c65dcfd7e1cf1f718e50bf840e3c25dd289`, 16,624 bytes, valid JSON, and passed the current parser. An intervening uninstrumented gate failed after its three retries; two instrumented gate invocations afterward passed. The raw nested input from the failed gate is still missing, so the parser remains unproven as the historical root cause and commit gate stays unmet pending failure-root-cause reconciliation.

A pass-through capture preload was then verified on one bounded gate invocation. It intercepted the existing `execFileSync(cmd.exe, ... pnpm audit --json)` call, preserved its original return/throw behavior and options, and saved per-attempt stdout/stderr plus timing/exit metadata under TEMP only. This gate passed with one audit attempt: child exit 1, stdout 16,624 bytes, stderr 0, valid JSON, parser PASS, 904 ms, no signal/timeout/exec error. This is successful-path evidence, not the missing failed-attempt input. Keep the capture instrumentation ready for the next bounded gate observation; no parser or repository source change was made.

### Next bounded observation (2026-11-03 02:37Z)

Fresh `git ls-remote` and local `HEAD` still matched protected main at `0e213243ac5b63e7fe900666b0055da9ca96de18`. The first capture invocation did not reach the security gate: Node rejected a Windows-backslash preload path in `NODE_OPTIONS`; this was an instrumentation bootstrap error, not a repository gate result. The path was corrected to slash form and one bounded `pnpm run security:gate` completed PASS. Its single child audit attempt exited 1 normally, had 16,624 stdout bytes, 0 stderr bytes, valid JSON, parser PASS, SHA-256 `41cf3f9b19cc1e707f74a89875964c65dcfd7e1cf1f718e50bf840e3c25dd289`, and elapsed 681 ms. Raw streams and metadata are preserved under TEMP at `nusa-security-capture-20261103T023736Z`; do not publish raw content without secret-safe review. This is another successful-path capture and still does not establish the historical failure input or root cause. No source/policy change, commit, push, PR, CI request, or retry-policy change was made. Keep `COMMIT_GATE=NOT_MET`, `L1=PARTIAL`, `L2=HOLD`.

## Bounded observation outcome and commit-gate rejudication (2026-11-03 02:54Z)

Fresh local HEAD and `git ls-remote origin refs/heads/main` matched `0e213243ac5b63e7fe900666b0055da9ca96de18`. The authorized maximum of five normally started `security:gate` observations completed, all PASS. Each had one child audit attempt with exit 1, no signal/timeout/exec error, 16,624 stdout bytes, zero stderr bytes, valid JSON, current parser PASS, and the same stdout SHA-256 `41cf3f9b19cc1e707f74a89875964c65dcfd7e1cf1f718e50bf840e3c25dd289`; elapsed times were 677, 650, 739, 776, and 653 ms. Per-run raw streams and metadata remain in five separate TEMP directories. A separate preload bootstrap error occurred before a gate started and is excluded from the five.

Outcome: `AUDIT_JSON_INCOMPLETE=NOT_REPRODUCED_IN_BOUNDED_OBSERVATION`; historical root cause remains `UNRESOLVED`. No additional polling is authorized by this work order. The current #1851 work-order prerequisite that relevant security gates pass before commit is satisfied. The later `bootstrap_staged_inclusion_20261031` governance order explicitly allows fail-closed Gate A inclusion before genuine positive protected-main attestation; no current canonical policy explicitly requires reconstructing the historical intermittent parser failure as a separate commit prerequisite. The timeout-triage runbook is scoped to `AUDIT_UNAVAILABLE:timeout` and was not used to reclassify this JSON error. Therefore `COMMIT_GATE=MET_FOR_GATE_A_FAIL_CLOSED_STAGED_INCLUSION` only. This is not L1 completion, a positive causal receipt, `CODE_ACTIONABLE`, CI/review/Validator/Audit/Release acceptance, or merge authorization. Preserve all existing safety boundaries.

Fresh GitHub inventory found #1851 still open, no open PR matching #1851, and the local canonical branch absent remotely; #1854 remains closed and is not revived. Next transition is a single local implementation commit on the existing WIP branch, then a non-force push of that branch and a fresh PR inventory before deciding whether one Draft PR is required. Exact-head CI and independent review remain pending.

## Current exact-head checkpoint — 2026-11-03 04:04 UTC

This section supersedes earlier “uncommitted/no PR” and `COMMIT_GATE=NOT_MET` snapshots above; those statements remain historical records of their observation times.

- Protected `main` and PR #2992 base: `e85b2ea0042c4da4515063a2a498232ea19866c1`.
- PR #2992 remains OPEN / Draft / mergeable at `8fdfe4bc6a0585f12e67ea82f9cd01f3d91d41ad`.
- Exact-head checks: 19 completed, 16 success and 3 intentional skips. The PR body records local validation; it is not independent acceptance.
- Latest security-gate adjudication makes `COMMIT_GATE=MET_FOR_GATE_A_FAIL_CLOSED_STAGED_INCLUSION` only. Historical `AUDIT_JSON_INCOMPLETE` root cause remains unresolved and was not reproduced in the bounded five-run observation.
- A separate fresh read-only validator inspected the committed diff and relevant paths. Result: `FAIL`, P0=0, P1=1, P2=0. It found inconsistent AIPOS chronology: the Gate A commit-gate decision coexists with stale `NOT_MET`/capture-next text, while this handoff leads with pre-commit/no-PR claims. The reviewer reported no additional code P0/P1 in inspected paths, did not run tests, and did not submit a GitHub review.
- Repair AIPOS by appending this superseding checkpoint; preserve earlier entries as historical. No application code change is indicated by this finding. After metadata validation, use only this existing branch/PR. The successor requires fresh exact-head CI and fresh independent review.
- Genuine protected-main attestation, positive causal receipt, `CODE_ACTIONABLE`, and positive CodingRunner E2E remain absent. `L1=PARTIAL`, `L2=HOLD`; safety remains PAPER_ONLY and ZERO_AUTHORITY.
