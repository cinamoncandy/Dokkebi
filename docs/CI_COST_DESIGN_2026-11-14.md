# CI cost and queue design: what was measured and what is recommended (2026-11-14)

Status: DESIGN NOTE. It changes no workflow, required check or branch protection. Any later change to a required check or to a
governed workflow needs the owner's approval and a non-author review, and the safety checks (PAPER_ONLY, LIVE-blocking, authority
map, AI zero-authority, security gate) are never reduced. Improvement item 3 of `docs/PROPOSAL_SIMPLIFICATION_2026-11-14.md`.

## 1. What was observed (2026-11-14)

- Six PRs open at once left jobs queued for more than an hour. Each PR head runs about 17 checks; four of the heavy jobs in `ci.yml`
  (`validation`, the four `coverage-core` shards, `coverage-ui-e2e`) run on `windows-latest`, the rest on `ubuntu-latest`.
- `ci.yml` runs on every `pull_request` to `main` with no path filter. Every new head (including the automatic "merge main" commit
  that the release path adds when a PR is behind) restarts the whole set; PR runs cancel older runs of the same PR.
- A stale generated file (`CURRENT_TRUTH.md`) caused three separate CI failures in this batch; it is now generated on read (#3117).

## 2. Measurement: how many PRs could use a lighter set

Sample: the 40 most recently merged PRs, file lists read through the GitHub API on 2026-11-14.

| Class | PRs |
| --- | --- |
| only `docs/*.md` files, none of them read by a test or script | 0 of 40 |
| `docs/*.md` (not read by tests) plus `.aipos` records | 8 of 40 (20%) |
| anything touching code, tests, scripts, workflows, deploy or config | 32 of 40 (80%) |

Reason the first row is empty: every PR carries a work order, and 38 distinct `docs/*.md` files are read by tests or scripts; 17 tests
read `.aipos/`. A doc or record change can break such a test, so a path rule "docs/ is light" is **unsafe**.

## 3. Recommendation

| # | Idea | Gain | Risk | Decision |
| --- | --- | --- | --- | --- |
| C1 | Risk-proportional required set: a classifier job runs the light set only when every changed file is (a) a doc not read by any test or script, computed from the repository at the base SHA, or (b) exactly one new work-order file, and treats anything uncertain as heavy | about 20% of PRs | changes the required check set; the exact required check names could not be read (branch protection returned 403 to the agent token) | RECORD ONLY. Not worth the governance risk for the gain. Revisit after item 2 (one record per PR) and after the required names are read by the owner |
| C2 | Fewer reruns: avoid pushing commits that only restart CI (for example regenerating a file); the CURRENT_TRUTH change already removed the main cause | measured: 3 reruns in this batch | none | DONE (#3117) |
| C3 | Keep the Windows-only jobs to what needs Windows (CRLF and path behaviour), and move platform-neutral shards to `ubuntu-latest` | the Windows queue is the slowest part | a test that passes on Linux but fails on Windows would be missed; the platform-independent test validator exists for that class but is not proven to cover all of it | INVESTIGATE FIRST: list per job why it needs Windows; no change before that list is reviewed |
| C4 | Do not run all six PR workflows for a docs-only change in workflows other than `ci.yml` (they already use `paths` filters in some cases) | small | low | record only |

## 4. What is not claimed

No queue-time or cost figures were measured (the agent token cannot read billing or runner usage). The 20% figure is a count of merged PRs by
file class, not a time saving. Nothing here is a reason to skip a safety check.

## 5. Next step if the owner wants one

C3 inventory (read only): for each job in `ci.yml`, record why it is on Windows (a Windows-only script, CRLF handling, a path rule) and
whether a Linux run would catch the same defects. The result is a table in a doc PR; no workflow change.
