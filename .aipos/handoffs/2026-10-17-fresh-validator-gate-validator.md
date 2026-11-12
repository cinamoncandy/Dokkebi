# Handoff — P0 fresh non-author VALIDATOR gate (#2760)

## Exact review target

Fetch the current head of the eventual Draft PR for `fix/validator-evidence-gate-2760` immediately before review. Do not trust a SHA self-recorded by the implementation branch. Base must be current protected `main`.

This is a **bootstrap governance repair**: the author session discovered that #2744 merged without the operating-model-required fresh `/grill-me` review. Do not let the existence of the new automated VALIDATOR implementation count as the independent review of this PR itself. This PR still requires a separate fresh non-author session under `docs/GRILL_ME_PROTOCOL.md` before Ready.

## Incident and first broken transition

#2744 had exact-head CI and companion workflows green but zero fresh reviews. A concurrent Ready event at `2026-10-17T06:22:56Z` was followed by deterministic Audit, `nusa/release-authorized`, and release-bot merge at `06:24:22Z`.

The direct code bypass was then found in `apps/autopilot/src/githubExecutor.ts`: `AUDIT_REQUEST` selected `nusa_autopilot_audit`, which invokes deterministic Audit/Release directly, while the existing `Autopilot Execution Consumer` already contained the independent Audit lane. Therefore the intended transition was not machine-enforced.

Canonical transition after this change:

`exact-head CI`
→ `AUDIT_REQUEST / nusa_autopilot_execution`
→ `canonical execution consumer`
→ `fresh stateless VALIDATOR_REQUEST`
→ `P0=0 / P1=0 trusted exact-head artifact`
→ `independent Audit`
→ `deterministic Audit`
→ `nusa/release-authorized`
→ `protected merge`

## Review focus

Please adversarially prove or falsify all of these on the exact final head:

1. There is no remaining normal `AUDIT_REQUEST` ingress that can dispatch `nusa_autopilot_audit` directly.
2. The fresh VALIDATOR call is a separate stateless provider call over the exact immutable base..head diff and canonical CI, not a PR-comment convention and not a reuse of the author session's claimed verdict.
3. P0/P1 cannot be downgraded to notes; P2 cannot become a blocker; any malformed/ambiguous response fails closed.
4. `auditAllowed` means only transition to independent Audit and grants no GitHub approval, Audit authority, Release authority, or merge authority.
5. `trusted-validator-evidence.json` binds repository/PR/head/base/CI and source workflow run+attempt, and deterministic Audit fetches it from the canonical execution-consumer artifact rather than trusting dispatch payload claims.
6. Deterministic Audit validates the artifact before its PASS authority. Release independently fetches/revalidates it before authorization and again before merge.
7. Missing/stale/wrong-head/wrong-base/wrong-CI/wrong-run/P0/P1/blocker/unsafe evidence all fail closed.
8. Existing Audit exact-head re-fetch, companion workflows, P0 serialization, review-thread preflight, release authorization app, post-merge CI and deployment flows remain intact.
9. No second queue/scheduler/Audit/Release/merge engine was introduced.
10. `liveAuthority=NONE`, `productionMutationAllowed=false`, `aiAuthority=ZERO_AUTHORITY` remain exact.

Blocking findings should be P0/P1 and remain unresolved until corrected on a successor head. A P2-only review may allow Ready only when explicitly non-blocking. This review itself is not Audit, Release, merge, deployment, or learning-loop completion.

## Current local evidence

- RED before implementation: fresh-validator gate contract `0/3 PASS` (all three fail as expected).
- Current focused static/control-plane/evidence suite: `37/37 PASS`.
- Workflow authority map, pinned actions, action inputs, AIPOS YAML: PASS.
- Build/typecheck/full gates: verify from the final committed head; do not rely on this handoff's snapshot.

## Safety / limits

No trading/Risk/Research thresholds are changed. #2744 history is preserved. The separate learning truth remains unchanged: no genuine DEPLOYABLE Research challenger or closed-learning cycle exists yet, and `PERFORMANCE_IMPROVEMENT=UNPROVEN`.

## Post-incident runtime truth

The merged #2744 main 8eff53fc362b588817d885eff1598d172848790e subsequently failed real Oracle PAPER activation in run 39010145930 and rolled back to 58a8e4fbb32fcc8dee018bd6563982e4e3ba0a8c; runtime acceptance for #2744 is therefore false. The independent runtime defect is tracked as P0 #2770 and must not be conflated with this governance fix.
