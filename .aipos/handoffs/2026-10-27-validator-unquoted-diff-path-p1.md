# PR #2772 — unquoted Git diff path P1 handoff

## Current target

- Repository: `cinamoncandy/NUSA`
- PR: #2772, `OPEN / Draft / mergeable`
- Existing branch: `fix/validator-evidence-gate-2760`
- Protected `main` and PR base: `e7f8a426a57a08339eae3778ca50de6512d6acd9`
- Verified remote predecessor: `ef58af74c03ff504ac82f89def26e3c2e279280a`
- Fresh review finding: review `5665534229`, comment `4387534372`, P1

## Finding and repair

The unquoted `diff --git a/<old> b/<new>` header cannot be split using a first/last ` b/` heuristic when that byte sequence occurs in either filename. The repair enumerates valid boundary candidates and resolves each diff block against exact GitHub PR files metadata (`filename`, `status`, and `previous_filename` for renames). Matching consumes the full changed-file set independent of API ordering; ambiguity, unsafe paths, malformed metadata, and mismatches fail closed. Audit and Validator evidence references use the same resolution.

Regression coverage includes paths with spaces and embedded ` b/`, changed-file metadata order differing from diff order, rename/add/delete cases, unsafe paths, malformed and C-quoted paths, and strict UTF-8 octal decoding.

## Verification

Node 24.19.0. `pnpm run preflight`, build, typecheck, `pnpm run validate:full`, `pnpm run security:gate`, lint, `pnpm test`, AIPOS YAML/drift/conformance, focused Validator (25/25), Audit runner (34/34), Audit contract (16/16), and `git diff --check` pass. Full suite: 1,290 isolated test files. Lint: zero errors and 45 existing warnings. The first full-suite attempt exposed stale test fixture assumptions about the new metadata; those fixtures were corrected, then the full suite passed.

## Next permitted action

Recheck authentication and the existing PR branch expected head before publishing one non-force successor. The local GitHub CLI token currently fails authentication, although public REST/ref reads succeed. If authenticated publication is unavailable, keep this validated successor local and report the exact auth blocker. Keep Draft; do not self-resolve review threads, approve, Audit, Release, merge, or mutate Oracle.

Safety: `PAPER_ONLY`; `liveAuthority=NONE`; `productionMutationAllowed=false`; `realOrderAuthority=false`; `realTransferAuthority=false`; `aiAuthority=ZERO_AUTHORITY`.
