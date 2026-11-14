# CI cost and queue design: what was measured and what is recommended (2026-11-14)

Status: DESIGN NOTE. It changes no workflow, required check or branch protection. Any later change to a required check or to a
governed workflow needs the owner's approval and a non-author review, and the safety checks (PAPER_ONLY, LIVE-blocking, authority
map, AI zero-authority, security gate) are never reduced. Improvement item 3 of `docs/PROPOSAL_SIMPLIFICATION_2026-11-14.md`.

## 1. What was observed (2026-11-14)

- **Observed, not measured:** while six PRs were open at once, checks stayed queued for more than an hour (seen in the check-run lists of the
  PRs on 2026-11-14 between about 19:30 and 20:45 KST; no timing was recorded).
- Each PR head runs about 17 checks. In `ci.yml`, 4 job definitions run on `windows-latest`: `validation`, `coverage-core` (a matrix of 4 shards, so 4 runs),
  `coverage-ui-e2e` and the aggregate `coverage` (which needs the other two): 7 Windows runs per head. The other jobs run on `ubuntu-latest`.
- `ci.yml` runs on every `pull_request` to `main` with no path filter. Every new head (including the automatic "merge main" commit
  that the release path adds when a PR is behind) restarts the whole set; PR runs cancel older runs of the same PR.
- A stale generated file (`CURRENT_TRUTH.md`) caused three separate CI failures in this batch; it is now generated on read (#3117).

## 2. Measurement: how many PRs could use a lighter set

Sample (fixed, so it can be repeated): the 40 merged PRs with these numbers, file lists read through the GitHub API on 2026-11-14
(`GET /repos/cinamoncandy/NUSA/pulls/<n>/files`, up to 100 files per PR):

`3078 3079 3080 3082 3083 3084 3085 3086 3087 3088 3089 3090 3091 3092 3093 3094 3095 3096 3097 3098 3099 3100 3101 3102 3103 3104 3105 3106 3107 3109 3110 3111 3112 3113 3114 3115 3116 3117 3119 3120`

Classification rule (shell, run by the agent): `REF` = the sorted unique set of `docs/<name>.md` strings that appear in `tests/*.js`,
`scripts/*.js` and `scripts/*.mjs` (`grep -ho "docs/[A-Za-z0-9_./-]*\.md" ... | sort -u`, 38 distinct files). A PR is "docs only" if every file is
`docs/*.md` and not in `REF`; "docs plus records" if every file is such a doc or under `.aipos/`; otherwise "everything else" (full CI set; not necessarily a code or config change). The 17 tests that
read `.aipos/` are `grep -l "\.aipos" tests/*.js`.

| Class | PRs |
| --- | --- |
| only `docs/*.md` files, none of them in `REF` | 0 of 40 |
| `docs/*.md` (not in `REF`) plus `.aipos` records | 9 of 40 (22.5%) |
| everything else: keeps the full CI set (includes PRs that change code, tests, scripts, workflows, deploy or config, but also a PR that changes only a doc that a test or script reads); the sample did not separate these further | 31 of 40 |

The earlier count in this note's first version (8 of 40) used the 40 most recent merges at that moment; the sample above is fixed and gives 9. The
share is a count of PRs by file class, not a time or cost saving.

Reason the first row is empty: every PR carries a work order, and 38 distinct `docs/*.md` files are read by tests or scripts; 17 tests
read `.aipos/`. A doc or record change can break such a test, so a path rule "docs/ is light" is **unsafe**.

## 3. Recommendation

| # | Idea | Gain | Risk | Decision |
| --- | --- | --- | --- | --- |
| C1 | Risk-proportional required set: a classifier job runs the light set only when every changed file is (a) a doc not read by any test or script, computed from the repository at the base SHA, or (b) exactly one new work-order file, and treats anything uncertain as heavy | about 22% of PRs by count (not a time saving) | changes the required check set; the exact required check names could not be read (branch protection returned 403 to the agent token) | RECORD ONLY. Not worth the governance risk for the gain. Revisit after item 2 (one record per PR) and after the required names are read by the owner |
| C2 | Fewer reruns: avoid pushing commits that only restart CI (for example regenerating a file); the CURRENT_TRUTH change already removed the main cause | measured: 3 reruns in this batch | none | DONE (#3117) |
| C3 | Keep the Windows-only jobs to what needs Windows (CRLF and path behaviour), and move platform-neutral shards to `ubuntu-latest` | the Windows queue is the slowest part | a test that passes on Linux but fails on Windows would be missed; the platform-independent test validator exists for that class but is not proven to cover all of it | INVESTIGATE FIRST: list per job why it needs Windows; no change before that list is reviewed |
| C4 | Do not run all six PR workflows for a docs-only change in workflows other than `ci.yml` (they already use `paths` filters in some cases) | small | low | record only |

## 4. What is not claimed

No queue-time or cost figures were measured (the agent token cannot read billing or runner usage; see the observation in section 1). The 22.5% figure is a count of merged PRs by
file class, not a time saving. "Observed" above means seen in check lists without recorded timings; "not measured" means no systematic queue-time or cost
data was collected. Nothing here is a reason to skip a safety check.

## 5. Next step if the owner wants one

C3 inventory (read only): for each of the 4 Windows job definitions in `ci.yml` (`validation`, `coverage-core`, `coverage-ui-e2e`, `coverage`), record why it is on Windows (a Windows-only script, CRLF handling, a path rule) and
whether a Linux run would catch the same defects. The result is a table in a doc PR; no workflow change.
