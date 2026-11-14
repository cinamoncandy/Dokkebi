# NUSA Security Hardening Report

Audited: 2026-11-01

| Gate | Result |
|---|---|
| Dependency vulnerability scan | PASS |
| Exact dependency backports | PASS |
| Dependency license verification | PASS |
| Lockfile integrity | PASS |
| Secret scan | PASS |
| Artifact checksum verification | NOT_APPLICABLE |
| Release signing verification | NOT_APPLICABLE (NOT_APPLICABLE) |

## Compensating controls

- None

Any advisory outside the exact mapped IDs/packages above remains blocking. A source-shape or version mismatch fails closed.

## Safety

- productionMutationAllowed=false remains required for release manifests.
- Live trading remains disabled.
- Credentials are not introduced or printed.
