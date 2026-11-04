# CLAUDE.md

This repository's rules for every agent are in [`AGENTS.md`](AGENTS.md). Read and follow it first; this file only adds
Claude Code specifics and cannot override it.

1. Start with the AIPOS recovery steps in `AGENTS.md` (`.aipos/aipos.yaml`, `.aipos/CURRENT_TRUTH.md`, `.aipos/state.yaml` plus `.aipos/state.d/*.yaml`, the active work order).
   The repository, not the conversation, is the source of truth.
2. Read the most recent handoff in `.aipos/handoffs/` (`<date>-main-handoff.md`, newest date first) for the
   current state and the next safe actions. Re-verify it on GitHub before acting.
3. Know your role (`AGENTS.md`, "Operating roles"; `docs/CLAUDE_CENTERED_OPERATING_MODEL.md` §0). Unset or `main` is
   CORE (design, implementation, operations, research, records); `validator`/`assistant` is a fresh review session.
4. For autonomous engineering, CI/PR handling and deployment, follow `docs/NUSA_CORE_MASTER_INSTRUCTIONS.md`.
5. Safety is not negotiable: PAPER_ONLY, `liveAuthority=NONE`, `productionMutationAllowed=false`,
   `aiAuthority=ZERO_AUTHORITY`. Never merge or approve your own PR, never bypass Audit or Release, and never loosen
   risk limits, thresholds or capital. Merging happens only through the release path or the owner.
6. One task is one branch and one PR. Search for an existing open PR or claim branch first and continue it; do not open
   a duplicate. Code or workflow PRs open as drafts until the non-author `/grill-me` review is done. Run the relevant
   tests and `pnpm run preflight` (or the validators listed in the work order) before any push.
7. In the cloud sandbox, tests run from the compiled `dist/` output (`npx tsc -p tsconfig.json`, then
   `node -r ./tests/register-dist.cjs --test <file>`). `check-runtime` and `validate:full` need Node 24 and are left to CI.
   A stale `dist/**/*.test.js` file with no matching source is not a real failure.
8. Report what was and was not verified. If CI fails on a stale head or a transient GitHub 5xx, say so rather than
   changing code to fit it. The owner writes Korean in easy language: answer briefly and only when action is needed.
