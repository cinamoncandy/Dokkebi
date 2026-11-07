# CORE handoff — 2026-11-05 — #1816 Oracle Release Convergence

## Scope and owner

Continue `.aipos/work-orders/WO-OPS-20261105-ORACLE-CONVERGENCE-1816.yaml` on branch `fix/oracle-convergence-host-evidence-1816`, based on protected-main `185c52c22691a5a35b13fe024cb39d810719a833`. The previous PR #1817 is CLOSED/UNMERGED because its stale diff conflicted with current main. Do not reuse its manually supplied `oracle_observed_sha` input as evidence; no active replacement PR was found at recovery.

## Verified canonical evidence

- Protected main at recovery: `185c52c22691a5a35b13fe024cb39d810719a833`.
- Oracle PAPER Release run `41966440881`, attempt 1, completed SUCCESS on that exact SHA. The release job log reports `deploymentResult=DEPLOYED` and `currentRelease=/opt/nusa/releases/185c52c22691a5a35b13fe024cb39d810719a833`.
- Release artifact `nusa-paper-release`: artifact `13387348034`, digest `sha256:248a777eaa072c9a3f4cd5760c9d28e53abbc5eb4a055d90c601ece05301946d`.
- Read-only Oracle Host Diagnose run `41969155063`, attempt 1, completed SUCCESS after the Release on the same self-hosted runner (runner id 24, `nusa-paper-host-datascale`). Its logs record `/opt/nusa/current` resolving to the exact main release and host observation time `2026-11-05T04:39:33Z`.
- Existing Convergence run `41958436826` failed before the later Release and Host Diagnose; it is historical and cannot satisfy post-release evidence.
- A local read-only evaluation of the run, attempt-specific jobs, artifact metadata and actual GitHub job logs passes the new Oracle evidence contract. It is not an official receipt from the updated workflow.

## Implementation

The Watchdog now gates receipt dispatch on the latest exact-main Oracle Release success and a later successful read-only Host Diagnose. It does not dispatch either workflow. The Receipt reads the exact run attempt, jobs, release artifact identity and job logs from GitHub, binds both host jobs to the same runner id/name/group, parses the Release's actual deployed path and the Host Diagnose's observed current symlink plus timestamp, and requires main = Release = host. The receipt keeps `RELEASE_PROVENANCE_UNKNOWN` because the separate source approval chain was not reconstructed.

No Oracle Release, host diagnose, deployment, restart, or production mutation was run by this implementation session.

## Validation and next step

Focused Oracle convergence/governance tests: 23/23 PASS. The complete isolated repository suite passed: 1,328 test files. `pnpm run validate:full`, root/mobile `pnpm run typecheck`, `pnpm run security:gate`, and `pnpm run lint:scripts` pass; lint reports 0 errors / 47 existing warnings. YAML parsing, Bash syntax parsing, workflow action input validation, action pin validation, workflow authority map validation (39 workflows), and `git diff --check` pass. `pnpm install --frozen-lockfile` completed in this isolated clone. The receipt now rechecks protected main immediately before final convergence classification so a late main advance remains incomplete.

Next inspect the final diff, commit the local branch and use the canonical #1816 Draft PR path for exact-head CI and an independent review. No merge, new Oracle Release, or canonical convergence claim is authorized by these local checks.

Safety remains `PAPER_ONLY`, `liveAuthority=NONE`, `productionMutationAllowed=false`, `realOrderAuthority=false`, `realTransferAuthority=false`, `aiAuthority=ZERO_AUTHORITY`.
