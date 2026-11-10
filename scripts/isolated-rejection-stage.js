"use strict";

const STAGE_PATTERN = /^[A-Z][A-Z0-9_]{2,95}(?::[A-Za-z0-9_]{1,64}){0,4}$/;
const MAX_REJECTION_BODY_BYTES = 16 * 1024;

// Reads at most MAX_REJECTION_BODY_BYTES of a Worker rejection body and returns only its fixed stage constant.
// The stream is cancelled as soon as the cap is exceeded; any absence, error or invalid value yields undefined.
async function readBoundedRejectionStage(response, maxBytes = MAX_REJECTION_BODY_BYTES) {
  const reader = response?.body?.getReader?.();
  if (!reader) return undefined;
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    const candidate = JSON.parse(text)?.rejectionStage;
    return typeof candidate === "string" && STAGE_PATTERN.test(candidate) ? candidate : undefined;
  } catch {
    await reader.cancel().catch(() => {});
    return undefined;
  }
}

module.exports = { readBoundedRejectionStage, MAX_REJECTION_BODY_BYTES, STAGE_PATTERN };
