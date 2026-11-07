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

  it("applies valid first and later hunks after untouched source gaps", () => {
    const source = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
    const candidate = applyCausalRepairPatch(source, [
      "diff --git a/" + CAUSAL_REPAIR_TARGET + " b/" + CAUSAL_REPAIR_TARGET,
      "--- a/" + CAUSAL_REPAIR_TARGET,
      "+++ b/" + CAUSAL_REPAIR_TARGET,
      "@@ -3 +3 @@",
      "-three",
      "+THREE",
      "@@ -6 +6 @@",
      "-six",
      "+SIX",
    ].join("\n"));
    assert.equal(candidate, "one\ntwo\nTHREE\nfour\nfive\nSIX\nseven\neight\n");
  });

  it("rejects overlapping or position-inconsistent hunks", () => {
    const source = "one\ntwo\nthree\nfour\nfive\nsix\n";
    const header = [
      "diff --git a/" + CAUSAL_REPAIR_TARGET + " b/" + CAUSAL_REPAIR_TARGET,
      "--- a/" + CAUSAL_REPAIR_TARGET,
      "+++ b/" + CAUSAL_REPAIR_TARGET,
      "@@ -2 +2 @@", "-two", "+TWO",
    ];
    assert.throws(() => applyCausalRepairPatch(source, [...header, "@@ -2 +2 @@", "-two", "+SECOND"].join("\n")), /CAUSAL_REPAIR_PATCH_INVALID/);
    assert.throws(() => applyCausalRepairPatch(source, [...header, "@@ -5 +6 @@", "-five", "+FIVE"].join("\n")), /CAUSAL_REPAIR_PATCH_INVALID/);
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
