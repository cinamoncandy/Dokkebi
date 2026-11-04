import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyCausalRepairPatch, verifyCausalPublishedFiles } from "./causalRepairPatch";
import { CAUSAL_REPAIR_TARGET } from "./causalProposalReceipt";

function patch(body: readonly string[], hunk = "@@ -1,8 +1,9 @@"): string {
  return [
    "diff --git a/" + CAUSAL_REPAIR_TARGET + " b/" + CAUSAL_REPAIR_TARGET,
    "index 1234567..89abcde 100644",
    "--- a/" + CAUSAL_REPAIR_TARGET,
    "+++ b/" + CAUSAL_REPAIR_TARGET,
    hunk,
    ...body,
  ].join("\n");
}

describe("server-side causal repair patch application", () => {
  it("derives the published file from the exact source and signed patch body", () => {
    const source = "export const enabled = true;\nexport const untouched = 1;\n";
    const candidate = applyCausalRepairPatch(source, patch([
      "-export const enabled = true;",
      "+export const enabled = false;",
      " export const untouched = 1;",
    ]));
    assert.equal(candidate, "export const enabled = false;\nexport const untouched = 1;\n");
  });

  it("recomputes stale hunk counts while preserving strict source positions", () => {
    const source = "a\nb\nc\n";
    const candidate = applyCausalRepairPatch(source, patch([
      " a",
      "-b",
      "+B",
      " c",
    ], "@@ -1,99 +1,2 @@"));
    assert.equal(candidate, "a\nB\nc\n");
  });

  it("preserves CRLF source and rejects client content that differs from the applied patch", () => {
    const source = "a\r\nb\r\n";
    const candidate = applyCausalRepairPatch(source, patch([
      " a",
      "-b",
      "+B",
    ], "@@ -1,2 +1,2 @@"));
    assert.equal(candidate, "a\r\nB\r\n");
    assert.deepEqual(verifyCausalPublishedFiles(candidate, [{ path: CAUSAL_REPAIR_TARGET, content: candidate }]), [
      { path: CAUSAL_REPAIR_TARGET, content: candidate },
    ]);
    assert.throws(
      () => verifyCausalPublishedFiles(candidate, [{ path: CAUSAL_REPAIR_TARGET, content: "attacker-controlled" }]),
      /CAUSAL_PUBLISH_CONTENT_MISMATCH/,
    );
    assert.throws(
      () => verifyCausalPublishedFiles(candidate, [{ path: "apps/autopilot/src/worker.ts", content: candidate }]),
      /CAUSAL_PUBLISH_CONTENT_MISMATCH/,
    );
  });

  it("rejects forged context, wrong target, second file, and no-op patches", () => {
    const source = "export const enabled = true;\n";
    assert.throws(() => applyCausalRepairPatch(source, patch([
      "-export const enabled = false;",
      "+export const enabled = true;",
    ])), /CAUSAL_REPAIR_PATCH_INVALID/);
    assert.throws(() => applyCausalRepairPatch(source, patch([
      "-export const enabled = true;",
      "+export const enabled = false;",
    ]).replaceAll(CAUSAL_REPAIR_TARGET, "apps/autopilot/src/worker.ts")), /CAUSAL_REPAIR_PATCH_INVALID/);
    assert.throws(() => applyCausalRepairPatch(source, patch([
      "-export const enabled = true;",
      "+export const enabled = false;",
      "diff --git a/other.ts b/other.ts",
    ])), /CAUSAL_REPAIR_PATCH_INVALID/);
    assert.throws(() => applyCausalRepairPatch(source, patch([
      " export const enabled = true;",
    ])), /CAUSAL_REPAIR_PATCH_INVALID/);
  });
});
