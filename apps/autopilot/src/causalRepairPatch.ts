import { CAUSAL_REPAIR_TARGET } from "./causalProposalReceipt";

const MAX_PATCH_BYTES = 64_000;
const MAX_SOURCE_BYTES = 20_000;
const MAX_RESULT_BYTES = 128_000;

export interface CausalPublishedFile {
  readonly path: string;
  readonly content: string;
}

function invalid(): never {
  throw new Error("CAUSAL_REPAIR_PATCH_INVALID");
}

/** Applies only a strict, one-file unified diff against the exact source text fetched by the Worker. */
export function applyCausalRepairPatch(source: string, patch: string): string {
  if (typeof source !== "string" || !source || new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES
    || typeof patch !== "string" || !patch.trim() || new TextEncoder().encode(patch).byteLength > MAX_PATCH_BYTES) invalid();
  if (source.replace(/\r\n/g, "").includes("\r")) invalid();
  const sourceNewline = source.includes("\r\n") ? "\r\n" : "\n";
  const normalizedPatch = patch.trim().replace(/\r\n/g, "\n");
  const lines = normalizedPatch.split("\n");
  if (lines[0] !== "diff --git a/" + CAUSAL_REPAIR_TARGET + " b/" + CAUSAL_REPAIR_TARGET) invalid();

  let index = 1;
  if (lines[index]?.startsWith("index ")) {
    if (!/^index [0-9a-f]{7,40}\.{2}[0-9a-f]{7,40}(?: [0-7]{6})?$/i.test(lines[index]!)) invalid();
    index += 1;
  }
  if (lines[index] !== "--- a/" + CAUSAL_REPAIR_TARGET || lines[index + 1] !== "+++ b/" + CAUSAL_REPAIR_TARGET) invalid();
  index += 2;

  const hadFinalNewline = source.endsWith("\n");
  const sourceLines = source.replace(/\r\n/g, "\n").split("\n");
  if (hadFinalNewline) sourceLines.pop();
  const output: string[] = [];
  let sourceCursor = 0;
  let hunkCount = 0;

  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines[index]!);
    if (!header) invalid();
    const oldStart = Number(header[1]);
    const newStart = Number(header[3]);
    if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart) || oldStart < 0 || newStart < 0) invalid();
    index += 1;
    const body: string[] = [];
    while (index < lines.length && !lines[index]!.startsWith("@@ ")) {
      if (lines[index]!.startsWith("\\")) invalid();
      if (!/^[ +\-]/.test(lines[index]!)) invalid();
      body.push(lines[index]!);
      index += 1;
    }
    if (body.length === 0) invalid();

    let oldCount = 0;
    let newCount = 0;
    for (const line of body) {
      if (line.startsWith(" ")) { oldCount += 1; newCount += 1; }
      else if (line.startsWith("-")) oldCount += 1;
      else if (line.startsWith("+")) newCount += 1;
    }
    if (oldCount === 0 && newCount === 0) invalid();
    // Hunk count numerals are normalized by the trusted consumer before git apply. Recompute
    // counts from the signed patch body here, but still enforce exact source and output positions.
    const oldPosition = oldCount === 0 ? oldStart : oldStart - 1;
    const newPosition = newCount === 0 ? newStart : newStart - 1;
    if (oldPosition !== sourceCursor || newPosition !== output.length + (oldPosition - sourceCursor)
      || oldPosition > sourceLines.length) invalid();
    output.push(...sourceLines.slice(sourceCursor, oldPosition));
    sourceCursor = oldPosition;

    for (const line of body) {
      const text = line.slice(1);
      if (line.startsWith(" ")) {
        if (sourceLines[sourceCursor] !== text) invalid();
        output.push(text);
        sourceCursor += 1;
      } else if (line.startsWith("-")) {
        if (sourceLines[sourceCursor] !== text) invalid();
        sourceCursor += 1;
      } else {
        output.push(text);
      }
    }
    hunkCount += 1;
  }
  if (hunkCount === 0) invalid();
  output.push(...sourceLines.slice(sourceCursor));
  const normalizedResult = output.join("\n") + (hadFinalNewline ? "\n" : "");
  const result = sourceNewline === "\r\n" ? normalizedResult.replace(/\n/g, "\r\n") : normalizedResult;
  if (!result || new TextEncoder().encode(result).byteLength > MAX_RESULT_BYTES || result === source) invalid();
  return result;
}

export function verifyCausalPublishedFiles(
  expectedContent: string,
  submitted: readonly CausalPublishedFile[],
): readonly CausalPublishedFile[] {
  if (!Array.isArray(submitted) || submitted.length !== 1
    || submitted[0]!.path !== CAUSAL_REPAIR_TARGET
    || submitted[0]!.content !== expectedContent) {
    throw new Error("CAUSAL_PUBLISH_CONTENT_MISMATCH");
  }
  return Object.freeze([Object.freeze({ path: CAUSAL_REPAIR_TARGET, content: expectedContent })]);
}
