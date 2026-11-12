# Handoff — executable dependency before declaration (#2772)

Fresh non-author review of `8c53adc89039caca4e99df7429ee8ffafcb2406d` found P1 in thread `PRRT_kwDOTUbne86yCNZM` (comment `4425523632`): a declaration could mask the executable JavaScript dependency in validator context.

The local repair checks TS implementation and runtime candidates before declarations, including the existing `dist/` fallback. The validator regression supplies both `module.d.ts` and `module.js` and asserts the executable content and exact-head evidence reference are used. Node 24.19 local validation: focused tests 38/38, pnpm test 1,310 isolated files, preflight/build/typecheck/validate:full/security, lint 0 errors and 47 baseline warnings, AIPOS YAML/drift/conformance/provenance, and diff check PASS. No successor SHA exists yet. Historical CI and review apply only to predecessor `8c53adc8...`.

Re-fetch the live #2772 head and protected main before any publication. Preserve Draft and all unresolved review threads; require fresh exact-head CI and companions, fresh non-author review, Formal Validator, independent Audit, and Release authorization in that order. No Oracle mutation or LIVE authority is granted.
