import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeNullComparators, type NullComparatorPersisted } from "./paperNullComparators";

/** Restart-surviving counters of the null comparators, beside the Cloud state (same trust level as paper-baseline-shadow.json). Best-effort; display only. */
export const NULL_COMPARATORS_RECORD_FILE = "paper-null-comparators.json";

export function nullComparatorsRecordPath(cloudStateDbPath: string): string | undefined {
  const normalized = cloudStateDbPath.trim();
  if (!normalized || normalized === ":memory:" || !path.isAbsolute(normalized)) return undefined;
  return path.join(path.dirname(normalized), NULL_COMPARATORS_RECORD_FILE);
}

/** True only after the atomic rename succeeded, so a caller can retry on a later tick. */
export function writeNullComparatorsRecord(cloudStateDbPath: string, value: NullComparatorPersisted): boolean {
  const file = nullComparatorsRecordPath(cloudStateDbPath);
  if (file == null || decodeNullComparators(JSON.parse(JSON.stringify(value))) === undefined) return false;
  try {
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

export function readNullComparatorsRecord(cloudStateDbPath: string): NullComparatorPersisted | undefined {
  const file = nullComparatorsRecordPath(cloudStateDbPath);
  if (file == null || !existsSync(file)) return undefined;
  try { return decodeNullComparators(JSON.parse(readFileSync(file, "utf8"))); } catch { return undefined; }
}
