import type { EvolutionDiscoverySignal } from "./evolveOpportunityDiscovery";

type JsonObject = Record<string, unknown>;

type EligibleIssue = Readonly<{
  number: number;
  title: string;
  priority: 0 | 1;
  updatedAtMs: number;
  labels: readonly string[];
  capability: GithubIssueCapability;
  canonicalOwner?: string;
  conflictKeys?: readonly string[];
  codingTarget?: string;
}>;

export type GithubIssueCapability = "AUTOPILOT_TYPESCRIPT" | "RESEARCH" | "GENERAL" | "UNKNOWN";

export interface GithubIssueBacklogReadiness {
  readonly eligibleIssueCount: number;
  readonly capabilityBlockedIssueCount: number;
  readonly capabilityBlockedCapabilities: Readonly<Record<Exclude<GithubIssueCapability, "AUTOPILOT_TYPESCRIPT">, number>>;
  readonly signals: readonly EvolutionDiscoverySignal[];
}

const object = (value: unknown): JsonObject | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const positiveInteger = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
const OWNER = /^[A-Za-z0-9_.:/-]{1,120}$/;
const CONFLICT_KEY = /^[A-Za-z0-9_.:/-]{1,200}$/;
const CODING_TARGET = /^apps\/autopilot\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/;
const FORBIDDEN_CODING_TARGET = /(?:^|\/)(?:live|live-trading|broker|order|credential|secret|secrets|withdraw|transfer|production-authority)(?:\/|$)/i;

function explicitWorkMetadata(body: string): Readonly<{ canonicalOwner: string; conflictKeys: readonly string[] }> | null {
  const ownerMatches = [...body.matchAll(/^\s*canonicalOwner\s*:\s*([^\s]+)\s*$/gim)];
  const conflictMatches = [...body.matchAll(/^\s*conflictKeys\s*:\s*([^\n\r]+)\s*$/gim)];
  if (ownerMatches.length === 0 && conflictMatches.length === 0) return null;
  if (ownerMatches.length !== 1 || conflictMatches.length !== 1) throw new Error("BACKLOG_WORK_METADATA_AMBIGUOUS");
  const canonicalOwner = ownerMatches[0]?.[1]?.trim() ?? "";
  const conflictKeys = (conflictMatches[0]?.[1] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!OWNER.test(canonicalOwner) || conflictKeys.length === 0 || conflictKeys.length > 32 || new Set(conflictKeys).size !== conflictKeys.length || conflictKeys.some((key) => !CONFLICT_KEY.test(key))) throw new Error("BACKLOG_WORK_METADATA_INVALID");
  return Object.freeze({ canonicalOwner, conflictKeys: Object.freeze(conflictKeys) });
}

/**
 * An OWNER issue may name the one file its next increment belongs in with a single
 * `codingTarget: apps/autopilot/src/<file>.ts` line. The path is carried into the selected
 * problem, where the dispatch loop gives the first coding attempt a real excerpt of exactly that
 * file instead of none; without it the model must invent the diff context that the sandbox's
 * `git apply --check` compares byte for byte. Absent means unchanged behaviour. A repeated or
 * out-of-scope target makes the issue ineligible, like any other ambiguous work metadata: a
 * target the coding runner would refuse to patch must not reach it.
 */
function explicitCodingTarget(body: string): string | undefined {
  const matches = [...body.matchAll(/^\s*codingTarget\s*:\s*([^\s]+)\s*$/gim)];
  if (matches.length === 0) return undefined;
  const target = matches[0]?.[1]?.trim() ?? "";
  if (matches.length !== 1
    || !CODING_TARGET.test(target)
    || target.endsWith(".test.ts")
    || target.endsWith(".d.ts")
    || target === "apps/autopilot/src/index.ts"
    || target === "apps/autopilot/src/worker.ts"
    || FORBIDDEN_CODING_TARGET.test(target)) {
    throw new Error("BACKLOG_CODING_TARGET_INVALID");
  }
  return target;
}

function priorityFromTitle(title: string): 0 | 1 | null {
  const match = title.match(/^\s*\[?P([01])\]?(?:\s*[:\]-]|\s+|\[)/i);
  if (!match) return null;
  return match[1] === "0" ? 0 : 1;
}

function hasSafetyContract(body: string): boolean {
  return body.includes("liveAuthority=NONE")
    && body.includes("productionMutationAllowed=false")
    && /aiAuthority\s*=\s*ZERO_AUTHORITY/i.test(body)
    && !/liveAuthority\s*=\s*(?:LIVE|WRITE|FULL|ENABLED)/i.test(body)
    && !/productionMutationAllowed\s*=\s*true/i.test(body)
    && !/aiAuthority\s*=\s*(?!ZERO_AUTHORITY\b)[A-Z0-9_]+/i.test(body);
}

/**
 * Explicit, allowlisted capability routing for the existing CodingRunner.
 * Unknown or unsupported domains remain observable but never become READY.
 */
function capabilityForIssue(title: string, body: string): GithubIssueCapability {
  const textValue = `${title}\n${body}`;
  if (/\bapps\/autopilot\/src\b/i.test(body)
    || /\bautopilot\b/i.test(title)
    || /autonomous development control plane/i.test(title)) {
    return "AUTOPILOT_TYPESCRIPT";
  }
  if (/\b(?:research|market intelligence|oos|walk[- ]forward|league|allocation|regime|paper evidence)\b/i.test(textValue)) {
    return "RESEARCH";
  }
  if (/\b(?:mobile|android|ios|ui|ux|cloudflare|deployment|release|website|desktop)\b/i.test(textValue)) {
    return "GENERAL";
  }
  return "UNKNOWN";
}

function labelNames(issue: JsonObject): readonly string[] {
  if (!Array.isArray(issue.labels)) return Object.freeze([]);
  return Object.freeze(issue.labels.flatMap((entry) => {
    if (typeof entry === "string") return [entry.toLowerCase()];
    const item = object(entry);
    const name = text(item?.name);
    return name ? [name.toLowerCase()] : [];
  }));
}

function isExplicitlyBlocked(issue: JsonObject): boolean {
  const labels = labelNames(issue);
  return labels.some((label) => /(?:^|[-_ ])(?:hold|blocked|human[_ -]?only|rework)(?:$|[-_ ])/i.test(label));
}

function linkedIssueNumbers(openPulls: readonly unknown[]): ReadonlySet<number> {
  const linked = new Set<number>();
  for (const value of openPulls) {
    const pull = object(value);
    if (!pull) continue;
    // A linked PR blocks duplicate admission unless the runtime has positively
    // verified that its head is behind current main. Missing/unknown evidence
    // remains blocking (fail closed).
    if (pull.nusa_stale_against_main === true) continue;
    const haystack = `${text(pull.title) ?? ""}\n${text(pull.body) ?? ""}`;
    for (const match of haystack.matchAll(/#(\d+)/g)) {
      const issueNumber = Number(match[1]);
      if (Number.isSafeInteger(issueNumber) && issueNumber > 0) linked.add(issueNumber);
    }
  }
  return linked;
}

function eligibleIssue(value: unknown, linked: ReadonlySet<number>): EligibleIssue | null {
  const issue = object(value);
  if (!issue || text(issue.state)?.toLowerCase() !== "open" || object(issue.pull_request)) return null;
  if (text(issue.author_association)?.toUpperCase() !== "OWNER" || isExplicitlyBlocked(issue)) return null;

  const number = positiveInteger(issue.number);
  const title = text(issue.title);
  const body = text(issue.body);
  if (!number || !title || !body || linked.has(number)) return null;

  const priority = priorityFromTitle(title);
  if (priority === null || !hasSafetyContract(body)) return null;

  const updatedAt = text(issue.updated_at);
  const updatedAtMs = updatedAt ? Date.parse(updatedAt) : 0;
  let metadata: ReturnType<typeof explicitWorkMetadata>;
  let codingTarget: string | undefined;
  try {
    metadata = explicitWorkMetadata(body);
    codingTarget = explicitCodingTarget(body);
  } catch {
    return null;
  }
  return Object.freeze({
    number,
    title,
    priority,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
    labels: labelNames(issue).slice().sort(),
    capability: capabilityForIssue(title, body),
    ...(metadata ?? {}),
    ...(codingTarget === undefined ? {} : { codingTarget }),
  });
}

/**
 * Open PRs whose staleness is worth probing: only those that reference an issue that would be
 * eligible if unlinked. Probing every open PR cost two GitHub calls per PR on every scheduled
 * tick, which exhausted the token's rate limit (GITHUB_HTTP_403) and stopped all coding dispatch.
 * PRs not selected stay unprobed and therefore keep blocking their issue (fail closed).
 */
export function selectStalenessProbePulls(issues: readonly unknown[], openPulls: readonly unknown[], max: number): ReadonlySet<unknown> {
  const unlinked: ReadonlySet<number> = new Set();
  const candidates = new Set<number>();
  for (const value of issues) {
    const eligible = eligibleIssue(value, unlinked);
    if (eligible) candidates.add(eligible.number);
  }
  const selected = new Set<unknown>();
  if (candidates.size === 0 || max <= 0) return selected;
  for (const value of openPulls) {
    if (selected.size >= max) break;
    const pull = object(value);
    if (!pull) continue;
    const haystack = `${text(pull.title) ?? ""}\n${text(pull.body) ?? ""}`;
    for (const match of haystack.matchAll(/#(\d+)/g)) {
      if (candidates.has(Number(match[1]))) { selected.add(value); break; }
    }
  }
  return selected;
}

export function deriveGithubIssueBacklogReadiness(
  issues: readonly unknown[],
  openPulls: readonly unknown[],
  observedAt: Date,
): GithubIssueBacklogReadiness {
  if (!Array.isArray(issues) || !Array.isArray(openPulls) || !(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
    return Object.freeze({
      eligibleIssueCount: 0,
      capabilityBlockedIssueCount: 0,
      capabilityBlockedCapabilities: Object.freeze({ RESEARCH: 0, GENERAL: 0, UNKNOWN: 0 }),
      signals: Object.freeze([]),
    });
  }

  const linked = linkedIssueNumbers(openPulls);
  const candidates = issues
    .map((issue) => eligibleIssue(issue, linked))
    .filter((issue): issue is EligibleIssue => issue !== null)
    .sort((left, right) => left.priority - right.priority || right.updatedAtMs - left.updatedAtMs || left.number - right.number);

  const capabilityBlockedCapabilities = { RESEARCH: 0, GENERAL: 0, UNKNOWN: 0 } as Record<Exclude<GithubIssueCapability, "AUTOPILOT_TYPESCRIPT">, number>;
  for (const candidate of candidates) {
    if (candidate.capability !== "AUTOPILOT_TYPESCRIPT") capabilityBlockedCapabilities[candidate.capability] += 1;
  }
  const eligible = candidates.filter((candidate) => candidate.capability === "AUTOPILOT_TYPESCRIPT" && candidate.canonicalOwner && candidate.conflictKeys?.length);

  const signals = eligible.slice(0, 1).map((issue) => Object.freeze({
    id: `github-issue-${issue.number}`,
    source: "github-issue-backlog",
    reference: `github://issue/${issue.number}`,
    problem: `GitHub issue #${issue.number}: ${issue.title}. Implement only the next smallest verifiable apps/autopilot/src control-plane increment while preserving PAPER_ONLY, liveAuthority=NONE, productionMutationAllowed=false, and aiAuthority=ZERO_AUTHORITY.${issue.codingTarget === undefined ? "" : ` Target file: ${issue.codingTarget}.`}`,
    observedAt: observedAt.toISOString(),
    evidenceQuality: 0.95,
    impact: issue.priority === 0 ? 0.95 : 0.85,
    confidence: 0.85,
    risk: 0.2,
    reversibility: 0.9,
    ...(issue.canonicalOwner === undefined ? {} : { canonicalOwner: issue.canonicalOwner }),
    ...(issue.conflictKeys === undefined ? {} : { conflictKeys: issue.conflictKeys }),
  } satisfies EvolutionDiscoverySignal));

  return Object.freeze({
    eligibleIssueCount: eligible.length,
    capabilityBlockedIssueCount: candidates.length - eligible.length,
    capabilityBlockedCapabilities: Object.freeze({ ...capabilityBlockedCapabilities }),
    signals: Object.freeze(signals),
  });
}

export function deriveGithubIssueBacklogSignals(
  issues: readonly unknown[],
  openPulls: readonly unknown[],
  observedAt: Date,
): readonly EvolutionDiscoverySignal[] {
  return deriveGithubIssueBacklogReadiness(issues, openPulls, observedAt).signals;
}

export interface CodexBacklogTask {
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string;
  readonly capability: GithubIssueCapability;
  readonly canonicalOwner: string;
  readonly conflictKeys: readonly string[];
  readonly eligibility: Readonly<{
    readonly state: "open";
    readonly authorAssociation: "OWNER";
    readonly priority: 0 | 1;
    readonly updatedAtMs: number;
    readonly labels: readonly string[];
    readonly linkedOpenPullRequest: false;
  }>;
}

/**
 * Canonical identity for the exact issue snapshot selected in the read-only job. The consumer
 * claim endpoint recomputes this value from a fresh GitHub read before it admits the WIP slot.
 */
export function codexBacklogTaskSnapshot(task: CodexBacklogTask): string {
  return JSON.stringify({
    issueNumber: task.issueNumber,
    title: task.title,
    body: task.body,
    capability: task.capability,
    canonicalOwner: task.canonicalOwner,
    conflictKeys: [...task.conflictKeys],
    eligibility: {
      state: task.eligibility.state,
      authorAssociation: task.eligibility.authorAssociation,
      priority: task.eligibility.priority,
      updatedAtMs: task.eligibility.updatedAtMs,
      labels: [...task.eligibility.labels],
      linkedOpenPullRequest: task.eligibility.linkedOpenPullRequest,
    },
  });
}

export async function codexBacklogTaskSnapshotDigest(task: CodexBacklogTask): Promise<string> {
  const bytes = new TextEncoder().encode(codexBacklogTaskSnapshot(task));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Next owner backlog issue for the ChatGPT Codex coding engine (autopilot-codex-coding.yml).
 *
 * Same eligibility as the Workers AI path (open, owner-authored, not explicitly blocked, priority
 * title, safety contract, valid work metadata, no open PR already linked) but not limited to
 * AUTOPILOT_TYPESCRIPT: Codex also takes the RESEARCH/GENERAL issues the Workers AI runner reports
 * as capability-blocked. UNKNOWN capability stays excluded. Exactly one issue, highest priority
 * first, so one Codex account works one task at a time.
 */
export function selectCodexBacklogTask(issues: readonly unknown[], openPulls: readonly unknown[]): CodexBacklogTask | null {
  const linked = linkedIssueNumbers(openPulls);
  const byNumber = new Map<number, JsonObject>();
  for (const value of issues) {
    const issue = object(value);
    const number = positiveInteger(issue?.number);
    if (issue && number) byNumber.set(number, issue);
  }
  const candidate = issues
    .map((issue) => eligibleIssue(issue, linked))
    .filter((issue): issue is EligibleIssue => issue !== null && issue.capability !== "UNKNOWN"
      && Boolean(issue.canonicalOwner) && Boolean(issue.conflictKeys?.length))
    .sort((left, right) => left.priority - right.priority || right.updatedAtMs - left.updatedAtMs || left.number - right.number)[0];
  if (!candidate) return null;
  return Object.freeze({
    issueNumber: candidate.number,
    title: candidate.title,
    body: text(byNumber.get(candidate.number)?.body) ?? "",
    capability: candidate.capability,
    canonicalOwner: candidate.canonicalOwner!,
    conflictKeys: Object.freeze([...candidate.conflictKeys!]),
    eligibility: Object.freeze({
      state: "open" as const,
      authorAssociation: "OWNER" as const,
      priority: candidate.priority,
      updatedAtMs: candidate.updatedAtMs,
      labels: Object.freeze([...candidate.labels]),
      linkedOpenPullRequest: false as const,
    }),
  });
}
