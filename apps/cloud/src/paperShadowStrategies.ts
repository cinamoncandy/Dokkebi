import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PaperCandidateStrategySpec } from "../../../packages/contracts/src/paperCandidateExecutionBinding";
import { decodeBaselineShadow, type BaselineShadowPersisted } from "./paperBaselineShadow";

/**
 * Pre-registered extra shadow strategies (RSI mean reversion, Donchian breakout) next to the owner baseline's SMA shadow.
 * They run on the same completed minute bars and the same fee model through PaperBaselineShadow, so they are display and analysis
 * only: no order, ledger, fill, Risk, Governance or Research input, and never PAPER evidence. The parameters are FIXED here before
 * any result is seen and must not be tuned from the shadow's own outcome (that would be overfitting the observation).
 */
export const SHADOW_STRATEGY_VERSION = "shadow-strategies/version-1";
export const SHADOW_STRATEGY_IDS = ["rsi", "donchian"] as const;
export type ShadowStrategyId = (typeof SHADOW_STRATEGY_IDS)[number];

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const CODE_SHA = sha256({ shadowStrategies: SHADOW_STRATEGY_VERSION }).slice(0, 40);

export function shadowStrategySpec(id: ShadowStrategyId): PaperCandidateStrategySpec {
  const parameters = id === "rsi" ? Object.freeze({ period: 14, oversold: 30, overbought: 70 }) : Object.freeze({ channelPeriod: 20 });
  const familyId = id === "rsi" ? "rsi-mean-reversion" : "donchian-breakout";
  const identity = { candidateId: `shadow-${id}`, familyId, lineageId: "shadow-only", parameters, costModelVersion: "nusa-paper-cost-v1" };
  return Object.freeze({ ...identity, specificationHash: sha256(identity), codeSha: CODE_SHA });
}

export const shadowStrategyRecordPath = (cloudStateDbPath: string, id: ShadowStrategyId): string | undefined => {
  const normalized = cloudStateDbPath.trim();
  if (!normalized || normalized === ":memory:" || !path.isAbsolute(normalized)) return undefined;
  return path.join(path.dirname(normalized), `paper-shadow-${id}.json`);
};

/** True only after the atomic rename succeeded, so a caller can retry on a later tick. */
export function writeShadowStrategyRecord(cloudStateDbPath: string, id: ShadowStrategyId, value: BaselineShadowPersisted): boolean {
  const file = shadowStrategyRecordPath(cloudStateDbPath, id);
  if (file == null || decodeBaselineShadow(JSON.parse(JSON.stringify(value))) === undefined) return false;
  try {
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, file);
    return true;
  } catch { return false; }
}

export function readShadowStrategyRecord(cloudStateDbPath: string, id: ShadowStrategyId): BaselineShadowPersisted | undefined {
  const file = shadowStrategyRecordPath(cloudStateDbPath, id);
  if (file == null || !existsSync(file)) return undefined;
  try { return decodeBaselineShadow(JSON.parse(readFileSync(file, "utf8"))); } catch { return undefined; }
}
