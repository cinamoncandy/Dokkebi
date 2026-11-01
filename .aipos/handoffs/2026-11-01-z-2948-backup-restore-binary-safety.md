# CORE handoff — 2026-11-01 — Issue #2948

Scope: owner-authored P1 work order `WO-OPS-20261101-2948-BACKUP-RESTORE-BINARY-SAFETY` on branch `WO-OPS-20261101-2948-BACKUP-RESTORE-BINARY-SAFETY`, based on protected main `dc9e4758515792a683d2b234a3cf20eca1508ca9` at claim time. This follows the fresh implementation inventory after independent gates on #2975/#2973/#2955 and canonical WIP access for #1851 remained external waits.

## Confirmed issue and scope

Issue #2948 is OPEN, P1, authored by repository owner `cinamoncandy`, and has no existing open PR or matching implementation branch. The reported production snapshot is 1,306,017,792 bytes; its source checksum and SQLite `quick_check`/`integrity_check` passed, while `scripts/backup-restore.js backup` fails before manifest creation because `secretFindings` converts the entire file Buffer to one UTF-8 string. Fresh main still contains that implementation. Open #2877 changes the Oracle release helper/workflow and does not touch this script/test family.

The permitted change is limited to the existing backup/verify/verify-only drill path: bounded-memory byte copying, hashing, and secret scanning; exact manifest and source identity behavior; read-only `quick_check` and `integrity_check` on copied `DATABASE_SNAPSHOT` drill artifacts; deterministic regressions. Destructive restore stays unsupported. No host or Oracle operation, source DB write, evidence deletion, retention, deployment, restart, lease, LIVE, or financial authority change is permitted.

## Current execution

- Protected main at branch claim: `dc9e4758515792a683d2b234a3cf20eca1508ca9` (fresh `git ls-remote` at start).
- Canonical owner: `nusa-server-automation` for this isolated server backup scope.
- Branch: `WO-OPS-20261101-2948-BACKUP-RESTORE-BINARY-SAFETY`.
- Initial checkout: clean and exactly at claimed base.
- Dependency environment: fresh `corepack pnpm@11.7.0 install --frozen-lockfile`, lockfile unchanged, postinstall security backports PASS.
- First broken transition: large binary `DATABASE_SNAPSHOT` → bounded backup/verify/drill → integrity-checked copied SQLite file.
- Next: implement and test the bounded binary path. Keep PR Draft after local gates; require fresh exact-head CI and a fresh independent review before further governance.

## Validation update

- Bounded chunked SHA-256, secret scanning, stable-source copying, and read-only SQLite integrity checks are implemented in the existing backup/verify/drill path.
- Focused backup/restore suites: 58/58 PASS, including a 512 MiB sparse binary artifact above Node's maximum string length, chunk-boundary secret detection, copied SQLite checks, and malformed-database fail-closed cleanup.
- `pnpm run preflight`, `pnpm run typecheck`, `pnpm run validate:full`, and `pnpm run security:gate`: PASS.
- `pnpm run lint`: 0 errors, 47 warnings, equal to the recorded baseline; no warning from the changed test remains.
- `pnpm test`: PASS, 1323 isolated test files.
- `git diff --check`: PASS. The test runner removed a pre-existing tracked failure log as designed; the known original file was restored so this task does not alter that historical artifact.
- Security gate generated the dated dependency audit, secret scan, hardening report, and SBOM; retain these as validation artifacts.
- Still not committed or opened as a PR. Next: final scope/diff review, commit, one Draft PR for #2948, exact-head checks, and independent review. No merge, release, or host operation.

Safety remains `PAPER_ONLY`, `liveAuthority=NONE`, `productionMutationAllowed=false`, `realOrderAuthority=false`, `realTransferAuthority=false`, `aiAuthority=ZERO_AUTHORITY`.
