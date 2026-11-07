/**
 * Display-only model for the "학습" studies timeline. No I/O and no authority. The list mirrors the frozen pre-registrations
 * (docs/research-ledger): dates are the designs' first verdict print times, nothing here is a measurement.
 */
const DAY = 86_400_000;

export interface RegisteredStudy {
  readonly id: string;
  readonly name: string;
  readonly verdictAtMs: number;
  readonly frozen: boolean;
}

/** Verdict times are the first print times of the registered designs (UTC). */
export const REGISTERED_STUDIES: ReadonlyArray<RegisteredStudy> = Object.freeze([
  Object.freeze({ id: "호가", name: "호가 연구(ML)", verdictAtMs: Date.parse("2026-10-29T02:00:00Z"), frozen: false }),
  Object.freeze({ id: "S2~S4", name: "긴 보유 · 지정가 · 일간 횡단면", verdictAtMs: Date.parse("2026-12-05T02:00:00Z"), frozen: true }),
  Object.freeze({ id: "S5", name: "호가 불균형 15분 신호", verdictAtMs: Date.parse("2026-12-20T02:00:00Z"), frozen: true }),
]);

export interface StudyRow {
  readonly id: string;
  readonly name: string;
  readonly dateLabel: string;
  readonly status: string;
  readonly tone: "ORDER" | "ATTENTION" | "MUTED";
  readonly next: boolean;
}

/** The one registered study whose result the host Research service reports (server heartbeat `orderBookStudy`). */
const RESULT_STUDY_ID_BY_ROW: Readonly<Record<string, string>> = Object.freeze({ "호가": "ML_ORDERBOOK_60M_20261029" });

export interface StudyResultView {
  readonly status: "HOLDOUT_PASS" | "HOLDOUT_FAIL";
  readonly eligible: number;
}

/**
 * Parses the server's `orderBookStudy` object for the study with `studyId`. Anything that is not exactly the versioned shape
 * (wrong version or id, unknown status, non-integer or negative count, non-boolean, extra keys) is treated as absent.
 */
export function parseStudyResult(raw: unknown, studyId: string): StudyResultView | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).some((k) => !["schemaVersion", "studyId", "status", "eligible", "discoveryPass", "resultFileMtimeMs"].includes(k))) return null;
  if (v.schemaVersion !== 1 || v.studyId !== studyId) return null;
  if (v.status !== "HOLDOUT_PASS" && v.status !== "HOLDOUT_FAIL") return null;
  if (typeof v.discoveryPass !== "boolean") return null;
  if (typeof v.eligible !== "number" || !Number.isSafeInteger(v.eligible) || v.eligible < 0 || v.eligible > 1_000_000) return null;
  if (v.resultFileMtimeMs !== undefined && !(typeof v.resultFileMtimeMs === "number" && Number.isSafeInteger(v.resultFileMtimeMs) && v.resultFileMtimeMs >= 0)) return null;
  return Object.freeze({ status: v.status, eligible: v.eligible });
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `orderBookStudy` is the untrusted server object; pass it as received. Pass/fail is only ever claimed from a valid one. */
export function buildStudyTimeline(nowMs: number, studies: ReadonlyArray<RegisteredStudy> = REGISTERED_STUDIES, orderBookStudy?: unknown): ReadonlyArray<StudyRow> {
  const sorted = [...studies].sort((a, b) => a.verdictAtMs - b.verdictAtMs);
  const nextIndex = sorted.findIndex((s) => s.verdictAtMs > nowMs);
  return Object.freeze(sorted.map((s, i) => {
    const d = new Date(s.verdictAtMs);
    const left = Math.ceil((s.verdictAtMs - nowMs) / DAY);
    const dateLabel = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const past = s.verdictAtMs <= nowMs;
    const resultStudyId = RESULT_STUDY_ID_BY_ROW[s.id];
    const result = past && resultStudyId !== undefined ? parseStudyResult(orderBookStudy, resultStudyId) : null;
    if (past && resultStudyId !== undefined) {
      const markets = result == null ? "" : ` · 대상 시장 ${result.eligible}개`;
      if (result?.status === "HOLDOUT_PASS") return Object.freeze({ id: s.id, name: s.name, dateLabel, status: `합격 · 앞으로 모의로만 검증할 후보예요 (실전 아님)${markets}`, tone: "ORDER" as const, next: i === nextIndex });
      if (result?.status === "HOLDOUT_FAIL") return Object.freeze({ id: s.id, name: s.name, dateLabel, status: `불합격 · 그대로 기록해요${markets}`, tone: "ATTENTION" as const, next: i === nextIndex });
      return Object.freeze({ id: s.id, name: s.name, dateLabel, status: "판정 시점이 지났는데 서버가 결과를 아직 안 보냈어요", tone: "ATTENTION" as const, next: i === nextIndex });
    }
    const status = past ? "판정 시점이 지났어요 · 결과를 확인하세요" : `${s.frozen ? "설계 고정됨" : "결과 대기"} · ${left}일 남음`;
    return Object.freeze({ id: s.id, name: s.name, dateLabel, status, tone: past ? "ATTENTION" as const : s.frozen ? "MUTED" as const : "ATTENTION" as const, next: i === nextIndex });
  }));
}
