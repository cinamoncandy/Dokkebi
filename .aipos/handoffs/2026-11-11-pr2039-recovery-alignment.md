# Issue #903 / PR #2039 recovery alignment

Observed protected main `ad0085fd994f68dd827ed52a022a50ad84057a13`; existing Draft PR head `a283a73aa9fa177d4320496328e858017e3ac0a0` was published and has 16 successful / 3 skipped checks. These results apply only to that predecessor. It was conflicting with main in generated CURRENT_TRUTH. An isolated local merge regenerates the summary and preserves main's causal verification switch OFF.

Local integration validation: 82 focused tests, 1343 isolated test files, non-incremental build, root/mobile typecheck, validate:full, security, AIPOS YAML and workflow authority map PASS; lint reports zero errors and 48 existing warnings. This evidence covers the integrated working tree, not a remote CI or review. Logs are in `nusa-2039-recovery-evidence-20261111`.

Historical handoffs describing unpublished pre-a283 successors are historical; do not repeat their push instructions. The local merge is not yet a published exact head: require local validation, current PR/main recheck, fresh CI for any published successor, and independent non-author disposition of the unresolved review threads. Do not self-approve, dispatch, deploy or merge.

Inventory completeness, operational WIP/lease and automated coding E2E remain unverified. A separate isolated causal receipt for source run 42923997847 and consumer run 42924120287 reports CODE_ACTIONABLE with one bounded CodingRunner execution and replay rejection within one harness; it is tied to source SHA 4b66244310d6fad9abf37b38e8c1b0b030bfb47d, not current-main admission or complete L1.

PAPER_ONLY / ZERO_AUTHORITY / FAIL_CLOSED; no real orders, transfers or production mutation.
