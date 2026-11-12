# Handoff — emitted `.js` specifier source resolution P1 (#2772)

## Current transition

- Work order: `WO-AUTOPILOT-20261017-FRESH-VALIDATOR-GATE`
- PR #2772: OPEN / Draft / mergeable; keep Draft.
- Protected main and PR base at fresh verification: `f144b940925dc04df7c0849fbaad9e5f14f5befe`.
- Exact predecessor head: `832313e9e1993158e46b1c7915eabab07b70bd85`.
- Fresh review request: comment `6525583442`.
- New P1 thread: `PRRT_kwDOTUbne86yAvTS`; finding comment `4424899846`.
- Predecessor exact-head CI `41073548219` and five required companion workflows were SUCCESS. They are historical for the repair successor.

## Finding and repair

The resolver searched for emitted `.js` paths and appended extensions, but did not substitute the emitted extension with its tracked TypeScript source counterpart. Thus a relative import like `./nusaEngineeringPortfolioScheduler.js` could leave the validator without the `.ts` definition and fail closed before review.

The bounded repair maps `.js/.jsx/.mjs/.cjs` to `.ts/.tsx/.d.ts`, `.tsx/.d.ts`, `.mts/.d.mts`, and `.cts/.d.cts` candidates respectively, before existing runtime-extension and index candidates. Existing `dist/` source fallback remains. A regression exercises the complete `executeIndependentValidator` retrieval path for the repository's `.js` import shape and asserts the exact-head `.ts` body and evidence reference reach the validation prompt.

Files changed for the P1: `apps/autopilot/src/auditRunner.ts` and `apps/autopilot/src/auditRunner.test.ts`.

## Local evidence

- Focused `auditRunner` tests: 37/37 PASS.
- `pnpm run preflight`, `build`, `typecheck`, `validate:full`, and `security:gate`: PASS.
- `pnpm run lint`: 0 errors / 47 warnings; clean-main baseline is 47 warnings.
- `pnpm test`: PASS, including preflight/build and 1,310 isolated test files.
- AIPOS YAML (547 files), drift, cross-AI conformance, provenance, and `git diff --check`: PASS.

Security-gate report/SBOM outputs in `docs/audits/` are generated, untracked artifacts and are not part of the intended repair.

## Next transition

Publish a non-force successor to the existing #2772 branch only after confirming its remote ref still equals `832313e9...`. Then require exact-successor CI and all five companions, followed by a fresh non-author review of that exact SHA. Keep Draft; do not self-resolve threads. Formal Validator, Audit, Release, and merge remain pending independent gates.

Safety: `PAPER_ONLY`; `liveAuthority=NONE`; `productionMutationAllowed=false`; `realOrderAuthority=false`; `realTransferAuthority=false`; `aiAuthority=ZERO_AUTHORITY`.
