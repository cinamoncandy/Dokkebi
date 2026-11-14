import { ACTIVE_WIP_CLAIM_MAX_AGE_MS, readActiveWip, readPersistentExecutionStrict, type ActiveWipClaim, type ExecutionCoordinatorNamespace } from "./executionCoordinator";

/**
 * Authenticated, read-only operator view of the existing ExecutionCoordinator (#903, #3108).
 * Authorized scope: owner decision of 2026-11-14 (bootstrap exception for this draft only). It reads through the existing `readActiveWip`
 * and `readPersistentExecution` helpers, which issue GET requests only. It never writes, prunes, claims, releases or dispatches, adds no
 * storage, no Coordinator and no queue, and does not change the WIP policy. Access is a Cloudflare Access JWT (RS256): signature,
 * issuer, audience, expiry, operator identity and hostname are all verified; every failure, including an unreachable key set, is a denial.
 */

export interface OperatorStatusEnv {
  /** Cloudflare Access team domain, for example `team.cloudflareaccess.com`. Absent or malformed means the route is closed. */
  readonly NUSA_ACCESS_TEAM_DOMAIN?: string;
  /** The Access application audience tag. */
  readonly NUSA_ACCESS_AUD?: string;
  /** Comma separated operator emails allowed to read (lower case compare). */
  readonly NUSA_ACCESS_OPERATOR_EMAILS?: string;
  /** Comma separated hostnames this route may be served on. */
  readonly NUSA_ACCESS_ALLOWED_HOSTS?: string;
  readonly NUSA_DEPLOYMENT_REVISION?: string;
  readonly NUSA_EXECUTION_COORDINATOR?: ExecutionCoordinatorNamespace;
}

export type AccessDenial =
  | "TOKEN_MISSING" | "TOKEN_MALFORMED" | "ALG_NOT_ALLOWED" | "KID_MISSING" | "KID_UNKNOWN" | "JWKS_UNAVAILABLE" | "SIGNATURE_INVALID"
  | "ISSUER_MISMATCH" | "AUDIENCE_MISMATCH" | "TOKEN_EXPIRED" | "TOKEN_NOT_YET_VALID" | "CLAIMS_INVALID" | "OPERATOR_NOT_ALLOWED" | "HOST_NOT_ALLOWED";

export interface AccessConfig { readonly teamDomain: string; readonly audience: string; readonly operators: readonly string[]; readonly hosts: readonly string[]; }
export type JwksFetcher = (url: string) => Promise<unknown>;

const TEAM_DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/;
const AUDIENCE = /^[A-Za-z0-9_-]{8,128}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const EMAIL = /^[^\s@,]{1,64}@[^\s@,]{1,255}$/;
const MAX_TOKEN_CHARS = 8192;
const NOT_BEFORE_SKEW_MS = 60_000;
const JWKS_TTL_MS = 300_000;
const JWKS_MIN_REFETCH_MS = 60_000;
const JWKS_MAX_KEYS = 16;
const MAX_ACTIVE_CLAIMS_SHOWN = 8;
/** The canonical policy cap of #903. It is reported for comparison only; this route enforces nothing. */
export const POLICY_ACTIVE_WIP_CAP = 2;
const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** Parses the configuration; undefined means the route stays closed (fail closed on any missing or malformed value). */
export function parseAccessConfig(env: OperatorStatusEnv): AccessConfig | undefined {
  const teamDomain = (env.NUSA_ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase();
  const audience = (env.NUSA_ACCESS_AUD ?? "").trim();
  const operators = (env.NUSA_ACCESS_OPERATOR_EMAILS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
  const hosts = (env.NUSA_ACCESS_ALLOWED_HOSTS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
  if (!TEAM_DOMAIN.test(teamDomain) || !AUDIENCE.test(audience)) return undefined;
  if (operators.length === 0 || operators.length > 16 || !operators.every((item) => EMAIL.test(item))) return undefined;
  if (hosts.length === 0 || hosts.length > 8 || !hosts.every((item) => HOSTNAME.test(item))) return undefined;
  return Object.freeze({ teamDomain, audience, operators: Object.freeze(operators), hosts: Object.freeze(hosts) });
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch { return undefined; }
}
function decodeJsonPart(value: string): Record<string, unknown> | undefined {
  const bytes = base64UrlToBytes(value);
  if (!bytes) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export interface JwksCacheEntry { readonly keys: ReadonlyMap<string, JsonWebKey>; readonly fetchedAt: number; readonly lastAttemptAt: number; }
export type JwksCache = Map<string, JwksCacheEntry>;
/** The key sets of this Worker isolate. A caller may pass its own cache (the tests do), so no reset function needs to be exported. */
const sharedJwksCache: JwksCache = new Map();
const NO_KEYS: ReadonlyMap<string, JsonWebKey> = new Map();

/**
 * Keys come from the cache while they are fresh. A fetch is attempted at most once per JWKS_MIN_REFETCH_MS per team domain, **whether or not it
 * succeeds**: a failing or malformed key endpoint cannot be hammered by repeated requests, and an unknown key id cannot force a refetch storm.
 */
async function loadKeys(jwksCache: JwksCache, teamDomain: string, now: number, fetchJwks: JwksFetcher, force: boolean): Promise<ReadonlyMap<string, JsonWebKey> | undefined> {
  const cached = jwksCache.get(teamDomain);
  const fresh = cached !== undefined && cached.keys.size > 0 && now - cached.fetchedAt < JWKS_TTL_MS;
  if (fresh && !force) return cached.keys;
  if (cached !== undefined && now - cached.lastAttemptAt < JWKS_MIN_REFETCH_MS) return fresh ? cached.keys : undefined;
  const fail = () => {
    jwksCache.set(teamDomain, { keys: cached?.keys ?? NO_KEYS, fetchedAt: cached?.fetchedAt ?? 0, lastAttemptAt: now });
    return fresh ? cached.keys : undefined;
  };
  try {
    const body = await fetchJwks(`https://${teamDomain}/cdn-cgi/access/certs`) as { keys?: unknown };
    if (!body || !Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > JWKS_MAX_KEYS) return fail();
    const keys = new Map<string, JsonWebKey>();
    for (const entry of body.keys as unknown[]) {
      const key = entry as Record<string, unknown>;
      if (key && key.kty === "RSA" && typeof key.kid === "string" && typeof key.n === "string" && typeof key.e === "string" && (key.alg === undefined || key.alg === "RS256") && (key.use === undefined || key.use === "sig")) {
        keys.set(key.kid, { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true });
      }
    }
    if (keys.size === 0) return fail();
    jwksCache.set(teamDomain, { keys, fetchedAt: now, lastAttemptAt: now });
    return keys;
  } catch {
    return fail();
  }
}

async function defaultFetchJwks(url: string): Promise<unknown> {
  const response = await fetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error("JWKS_HTTP_ERROR");
  const text = await response.text();
  if (text.length > 65_536) throw new Error("JWKS_TOO_LARGE");
  return JSON.parse(text);
}

export async function verifyAccessJwt(
  token: string | null,
  config: AccessConfig,
  context: { readonly now: number; readonly requestHostname: string; readonly fetchJwks: JwksFetcher; readonly jwksCache?: JwksCache },
): Promise<{ readonly ok: true; readonly operator: string } | { readonly ok: false; readonly code: AccessDenial }> {
  const deny = (code: AccessDenial) => ({ ok: false as const, code });
  if (token === null || token.trim() === "") return deny("TOKEN_MISSING");
  if (token.length > MAX_TOKEN_CHARS) return deny("TOKEN_MALFORMED");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return deny("TOKEN_MALFORMED");
  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  const signature = base64UrlToBytes(parts[2]);
  if (!header || !claims || !signature || signature.length === 0) return deny("TOKEN_MALFORMED");
  if (header.alg !== "RS256") return deny("ALG_NOT_ALLOWED");
  if (typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 200) return deny("KID_MISSING");
  const jwksCache = context.jwksCache ?? sharedJwksCache;
  let keys = await loadKeys(jwksCache, config.teamDomain, context.now, context.fetchJwks, false);
  if (!keys) return deny("JWKS_UNAVAILABLE");
  let jwk = keys.get(header.kid);
  if (!jwk) {
    keys = await loadKeys(jwksCache, config.teamDomain, context.now, context.fetchJwks, true);
    if (!keys) return deny("JWKS_UNAVAILABLE");
    jwk = keys.get(header.kid);
    if (!jwk) return deny("KID_UNKNOWN");
  }
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { valid = false; }
  if (!valid) return deny("SIGNATURE_INVALID");
  // From here on the token is genuine; the claims are still checked one by one.
  if (claims.iss !== `https://${config.teamDomain}`) return deny("ISSUER_MISMATCH");
  const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!audiences.every((item) => typeof item === "string") || !audiences.includes(config.audience)) return deny("AUDIENCE_MISMATCH");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return deny("CLAIMS_INVALID");
  if (claims.exp * 1000 <= context.now) return deny("TOKEN_EXPIRED");
  for (const name of ["nbf", "iat"] as const) {
    const value = claims[name];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return deny("CLAIMS_INVALID");
    if (value * 1000 > context.now + NOT_BEFORE_SKEW_MS) return deny("TOKEN_NOT_YET_VALID");
  }
  if (typeof claims.email !== "string") return deny("OPERATOR_NOT_ALLOWED");
  const operator = claims.email.trim().toLowerCase();
  if (!EMAIL.test(operator) || !config.operators.includes(operator)) return deny("OPERATOR_NOT_ALLOWED");
  if (!config.hosts.includes(context.requestHostname.toLowerCase())) return deny("HOST_NOT_ALLOWED");
  return Object.freeze({ ok: true as const, operator });
}

const SAFE_TEXT = /^[A-Za-z0-9_.:/-]{1,200}$/;
const safeText = (value: unknown): string => typeof value === "string" && SAFE_TEXT.test(value) ? value : "UNKNOWN";
const safeTime = (value: unknown): number | "UNKNOWN" => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : "UNKNOWN";

interface ClaimView {
  readonly claimId: string; readonly dedupeKey: string; readonly canonicalOwner: string; readonly conflictKeys: readonly string[];
  readonly claimedAt: number | "UNKNOWN";
  readonly claimExpiresAt: number | "UNKNOWN";
  readonly claimExpiryBasis: "COMPUTED_CLAIMED_AT_PLUS_ACTIVE_WIP_CLAIM_MAX_AGE_MS";
  readonly claimState: "ACTIVE" | "EXPIRED_NOT_PRUNED" | "UNKNOWN";
  readonly leaseHolder: "UNKNOWN"; readonly heartbeat: "UNKNOWN";
  readonly persistentExecution: "UNKNOWN" | "NOT_STORED" | {
    readonly state: string; readonly taskId: string; readonly leaseExpiresAt: number | "UNKNOWN"; readonly updatedAt: number | "UNKNOWN"; readonly leaseState: "LEASE_ACTIVE" | "LEASE_EXPIRED" | "UNKNOWN";
  };
}

function describeClaim(claim: ActiveWipClaim, now: number, persistent: unknown): ClaimView {
  const claimedAt = safeTime(claim.claimedAt);
  const claimExpiresAt = claimedAt === "UNKNOWN" ? "UNKNOWN" : claimedAt + ACTIVE_WIP_CLAIM_MAX_AGE_MS;
  const record = persistent as { state?: unknown; leaseExpiresAt?: unknown; updatedAt?: unknown; taskId?: unknown } | null | "UNKNOWN";
  let persistentExecution: ClaimView["persistentExecution"];
  if (record === "UNKNOWN") persistentExecution = "UNKNOWN";
  else if (record === null) persistentExecution = "NOT_STORED";
  else {
    const leaseExpiresAt = safeTime(record.leaseExpiresAt);
    persistentExecution = { state: safeText(record.state), taskId: safeText(record.taskId), leaseExpiresAt, updatedAt: safeTime(record.updatedAt), leaseState: leaseExpiresAt === "UNKNOWN" ? "UNKNOWN" : now < leaseExpiresAt ? "LEASE_ACTIVE" : "LEASE_EXPIRED" };
  }
  return Object.freeze({
    claimId: safeText(claim.executionId), dedupeKey: safeText(claim.dedupeKey), canonicalOwner: safeText(claim.canonicalOwner),
    conflictKeys: Object.freeze(Array.isArray(claim.conflictKeys) ? claim.conflictKeys.slice(0, 32).map(safeText) : []),
    claimedAt, claimExpiresAt, claimExpiryBasis: "COMPUTED_CLAIMED_AT_PLUS_ACTIVE_WIP_CLAIM_MAX_AGE_MS" as const,
    claimState: claimExpiresAt === "UNKNOWN" ? "UNKNOWN" as const : now < claimExpiresAt ? "ACTIVE" as const : "EXPIRED_NOT_PRUNED" as const,
    leaseHolder: "UNKNOWN" as const, heartbeat: "UNKNOWN" as const, persistentExecution,
  });
}

/** Reads the active WIP claims twice around the per-claim execution reads. An unequal pair, or any failed read, is reported as UNKNOWN, never as an empty slot. */
export async function readCoordinatorSnapshot(namespace: ExecutionCoordinatorNamespace, now: number, revision: string): Promise<Record<string, unknown>> {
  const header = { schemaVersion: 1, observedAt: now, workerRevision: revision, policyActiveWipCap: POLICY_ACTIVE_WIP_CAP, liveAuthority: "NONE", productionMutationAllowed: false, aiAuthority: "ZERO_AUTHORITY", readOnly: true };
  const isObject = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value);
  let first;
  try { first = await readActiveWip(namespace); } catch { return { ...header, snapshot: "UNAVAILABLE", claims: "UNKNOWN", activeCount: "UNKNOWN" }; }
  if (first.claims.length > MAX_ACTIVE_CLAIMS_SHOWN) return { ...header, snapshot: "UNAVAILABLE", claims: "UNKNOWN", activeCount: "UNKNOWN" };
  // An entry that is not an object cannot be described at all: the whole snapshot is unproven, not partly empty.
  if (!first.claims.every(isObject)) return { ...header, snapshot: "MALFORMED", claims: "UNKNOWN", activeCount: "UNKNOWN" };
  const executions: unknown[] = [];
  for (const claim of first.claims) {
    try {
      if (typeof claim.dedupeKey !== "string" || claim.dedupeKey.length === 0) { executions.push("UNKNOWN"); continue; }
      const record = await readPersistentExecutionStrict(namespace, claim.dedupeKey);
      // A stored record for another identity says nothing about this claim.
      executions.push(record !== null && record.dedupeKey !== claim.dedupeKey ? "UNKNOWN" : record);
    } catch { executions.push("UNKNOWN"); }
  }
  let second;
  try { second = await readActiveWip(namespace); } catch { return { ...header, snapshot: "UNAVAILABLE", claims: "UNKNOWN", activeCount: "UNKNOWN" }; }
  if (!second.claims.every(isObject)) return { ...header, snapshot: "MALFORMED", claims: "UNKNOWN", activeCount: "UNKNOWN" };
  if (JSON.stringify(first.claims) !== JSON.stringify(second.claims)) return { ...header, snapshot: "INCONSISTENT", claims: "UNKNOWN", activeCount: "UNKNOWN" };
  const claims = first.claims.map((claim, index) => describeClaim(claim, now, executions[index]));
  const activeCount = claims.filter((claim) => claim.claimState === "ACTIVE").length;
  return { ...header, snapshot: "CONSISTENT", beforeAfterClaimsEqual: true, claims, storedClaimCount: claims.length, activeCount, overPolicyCap: activeCount > POLICY_ACTIVE_WIP_CAP };
}

function safeRevision(value: string | undefined): string { return typeof value === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(value) ? value : "UNKNOWN"; }

export async function handleOperatorCoordinatorStatus(
  request: Request,
  env: OperatorStatusEnv,
  dependencies: { readonly now?: () => number; readonly fetchJwks?: JwksFetcher; readonly jwksCache?: JwksCache } = {},
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const config = parseAccessConfig(env);
  if (!config || !env.NUSA_EXECUTION_COORDINATOR) return json({ error: "OPERATOR_STATUS_NOT_CONFIGURED" }, 503);
  const now = (dependencies.now ?? Date.now)();
  const verdict = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), config, {
    now, requestHostname: new URL(request.url).hostname, fetchJwks: dependencies.fetchJwks ?? defaultFetchJwks, jwksCache: dependencies.jwksCache,
  });
  // One body for every denial, so the response is not an oracle for which check failed.
  if (!verdict.ok) return json({ error: "UNAUTHORIZED" }, 401);
  return json(await readCoordinatorSnapshot(env.NUSA_EXECUTION_COORDINATOR, now, safeRevision(env.NUSA_DEPLOYMENT_REVISION)), 200);
}
