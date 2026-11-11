/**
 * One structured log line per Workers AI call, so provider budget decisions (C1 coding vs C2 audit
 * split, retry counts, context size) rest on observed usage instead of guesses. Numbers only: the
 * prompt and response bodies are never logged.
 */
export type AiCaller = "C1_CODING" | "C2_AUDIT" | "C3_JEV";

export interface AiCallUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

/**
 * Neurons per 1M tokens for the models production callers use (Cloudflare Workers AI pricing, as
 * supplied by the owner 2026-09-24). A model not listed here reports estimatedNeurons: null --
 * an unknown rate is never guessed.
 */
export const WORKERS_AI_NEURONS_PER_MILLION_TOKENS: Readonly<Record<string, Readonly<{ input: number; output: number }>>> = Object.freeze({
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": Object.freeze({ input: 26_668, output: 204_805 }),
  "@cf/meta/llama-3.1-8b-instruct-fast": Object.freeze({ input: 4_119, output: 34_868 }),
});

/** Estimated neurons for one call, or null when the model rate or either token count is unknown. */
export function estimateWorkersAiNeurons(model: string, usage: AiCallUsage): number | null {
  const rate = WORKERS_AI_NEURONS_PER_MILLION_TOKENS[model];
  if (rate == null || usage.promptTokens == null || usage.completionTokens == null) return null;
  return Math.round((usage.promptTokens * rate.input + usage.completionTokens * rate.output) / 1_000_000 * 100) / 100;
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

export function aiCallUsage(response: unknown): AiCallUsage {
  const usage = response != null && typeof response === "object" ? (response as { usage?: unknown }).usage : undefined;
  const record = usage != null && typeof usage === "object" ? usage as Record<string, unknown> : {};
  return Object.freeze({ promptTokens: count(record.prompt_tokens), completionTokens: count(record.completion_tokens) });
}

export function logAiCall(input: Readonly<{
  caller: AiCaller;
  model: string;
  attempt: number;
  promptChars: number;
  response: unknown;
  reviewSegment?: Readonly<{ index: number; count: number; changedFiles: number; diffChars: number }>;
}>, log: (line: string) => void = console.log): void {
  try {
    const usage = aiCallUsage(input.response);
    log(JSON.stringify({
      event: "NUSA_AI_CALL",
      caller: input.caller,
      model: input.model,
      attempt: input.attempt,
      promptChars: input.promptChars,
      ...(input.reviewSegment ? {
        reviewSegment: input.reviewSegment.index,
        reviewSegmentCount: input.reviewSegment.count,
        reviewSegmentFileCount: input.reviewSegment.changedFiles,
        reviewSegmentDiffChars: input.reviewSegment.diffChars,
      } : {}),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      estimatedNeurons: estimateWorkersAiNeurons(input.model, usage),
      liveAuthority: "NONE",
      productionMutationAllowed: false,
      aiAuthority: "ZERO_AUTHORITY",
    }));
  } catch {
    // Telemetry never changes the outcome of the call it observes.
  }
}
