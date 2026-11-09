import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Restart-surviving copy of the last BLOCKED/ERROR reason of the closed-learning loop. The in-process value on /health
 * is erased by every restart, so a cycle that failed shortly before a deploy left no readable reason. The record is a
 * bare code plus a time written beside the durable Cloud state (same pattern and trust level as runtime-last-failure.json):
 * no free text, best-effort, never changes a decision, and never overwrites the single-slot runtime failure record.
 * For a TICK_ERROR the bounded error class (a fixed code, never the message) is kept too: after a restart the class used to be lost, so a
 * failed tick seen on /health could no longer be root-caused (P0 #2589).
 */
export const CLOSED_LEARNING_BLOCKED_RECORD_FILE = "closed-learning-last-blocked.json";
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export interface ClosedLearningBlockedRecord {
  readonly reason: string;
  readonly at: number;
  /** Bounded class of a TICK_ERROR (same code shape as the reason); absent for other reasons and for records written before this field. */
  readonly errorClass?: string;
}

export function closedLearningBlockedRecordPath(cloudStateDbPath: string): string | undefined {
  const normalized = cloudStateDbPath.trim();
  if (!normalized || normalized === ":memory:" || !path.isAbsolute(normalized)) return undefined;
  return path.join(path.dirname(normalized), CLOSED_LEARNING_BLOCKED_RECORD_FILE);
}

/** Returns true only after the atomic rename succeeded, so a caller can retry a failed best-effort write on a later tick. */
export function recordClosedLearningBlocked(cloudStateDbPath: string, record: ClosedLearningBlockedRecord): boolean {
  const file = closedLearningBlockedRecordPath(cloudStateDbPath);
  if (file == null || !CODE.test(record.reason) || !Number.isSafeInteger(record.at) || record.at < 0) return false;
  try {
    const temporary = `${file}.tmp`;
    const errorClass = record.errorClass !== undefined && CODE.test(record.errorClass) ? record.errorClass : undefined;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, reason: record.reason, at: record.at, ...(errorClass === undefined ? {} : { errorClass }) }), { mode: 0o600 });
    renameSync(temporary, file);
    return true;
  } catch {
    return false; // forensics must never change the loop
  }
}

export function readClosedLearningBlocked(cloudStateDbPath: string): ClosedLearningBlockedRecord | undefined {
  const file = closedLearningBlockedRecordPath(cloudStateDbPath);
  if (file == null || !existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || typeof parsed.reason !== "string" || !CODE.test(parsed.reason) || !Number.isSafeInteger(parsed.at) || (parsed.at as number) < 0) return undefined;
    const errorClass = typeof parsed.errorClass === "string" && CODE.test(parsed.errorClass) ? parsed.errorClass : undefined;
    return Object.freeze({ reason: parsed.reason, at: parsed.at as number, ...(errorClass === undefined ? {} : { errorClass }) });
  } catch {
    return undefined;
  }
}
