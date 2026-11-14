import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_WIP_CLAIM_MAX_AGE_MS, ExecutionCoordinator, admitActiveWip, readActiveWip, type ExecutionCoordinatorNamespace } from "./executionCoordinator";
import { handleOperatorCoordinatorStatus, parseAccessConfig, resetOperatorJwksCacheForTest, verifyAccessJwt, POLICY_ACTIVE_WIP_CAP, type AccessConfig, type OperatorStatusEnv } from "./operatorCoordinatorStatus";
import worker from "./worker";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

interface Call { readonly method: string; readonly path: string }
function namespace(hooks: { readonly calls?: Call[]; readonly override?: (call: Call, count: number) => Response | undefined } = {}): ExecutionCoordinatorNamespace {
  const coordinators = new Map<string, ExecutionCoordinator>();
  const counts = new Map<string, number>();
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: unknown) => {
      const name = (id as { name: string }).name;
      let coordinator = coordinators.get(name);
      if (!coordinator) { coordinator = new ExecutionCoordinator({ storage: new MemoryStorage() }); coordinators.set(name, coordinator); }
      const target = coordinator;
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const call = { method: request.method, path: new URL(request.url).pathname };
          hooks.calls?.push(call);
          const key = `${call.method} ${call.path}`;
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return Promise.resolve(hooks.override?.(call, count) ?? target.fetch(request));
        },
      };
    },
  };
}

const TEAM = "nusa-team.cloudflareaccess.com";
const AUD = "a".repeat(64);
const OPERATOR = "operator@example.com";
const HOST = "autopilot.example.com";
const NOW = 1_794_700_000_000;
const KID = "key-1";
const b64url = (input: ArrayBuffer | string): string => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
async function newKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
}
async function jwksOf(pair: CryptoKeyPair, kid = KID): Promise<{ keys: unknown[] }> {
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] };
}
const goodClaims = (over: Record<string, unknown> = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW / 1000 + 600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, email: OPERATOR, ...over });
async function token(pair: CryptoKeyPair, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: KID, typ: "JWT" }): Promise<string> {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(signature)}`;
}
const config: AccessConfig = { teamDomain: TEAM, audience: AUD, operators: [OPERATOR], hosts: [HOST] };
const env = (ns?: ExecutionCoordinatorNamespace, over: Partial<OperatorStatusEnv> = {}): OperatorStatusEnv => ({
  NUSA_ACCESS_TEAM_DOMAIN: TEAM, NUSA_ACCESS_AUD: AUD, NUSA_ACCESS_OPERATOR_EMAILS: OPERATOR, NUSA_ACCESS_ALLOWED_HOSTS: HOST,
  NUSA_DEPLOYMENT_REVISION: "a".repeat(40), ...(ns ? { NUSA_EXECUTION_COORDINATOR: ns } : {}), ...over,
});
const get = (jwt: string | null, host = HOST, method = "GET") => new Request(`https://${host}/operator/coordinator/status`, { method, headers: jwt === null ? {} : { "cf-access-jwt-assertion": jwt } });
const claim = { dedupeKey: "evolve-coding:abc:github-issue-3108", executionId: "evolve-coding:abc", canonicalOwner: "apps/cloud", conflictKeys: ["apps/cloud/src/cloudPaperExecutionBoundary.ts"], claimedAt: NOW - 60_000, maxConcurrent: 2 };

async function verify(jwt: string | null, pair: CryptoKeyPair, over: Partial<AccessConfig> = {}, fetchJwks?: (url: string) => Promise<unknown>, host = HOST) {
  resetOperatorJwksCacheForTest();
  const keys = await jwksOf(pair);
  return verifyAccessJwt(jwt, { ...config, ...over }, { now: NOW, requestHostname: host, fetchJwks: fetchJwks ?? (async () => keys) });
}

test("a valid Access token for an allowed operator and host reads the Coordinator state", async () => {
  resetOperatorJwksCacheForTest();
  const pair = await newKeyPair();
  const keys = await jwksOf(pair);
  const ns = namespace();
  assert.equal((await admitActiveWip(ns, claim)).admitted, true);
  const response = await handleOperatorCoordinatorStatus(get(await token(pair, goodClaims())), env(ns), { now: () => NOW, fetchJwks: async () => keys });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, any>;
  assert.equal(body.snapshot, "CONSISTENT");
  assert.equal(body.observedAt, NOW);
  assert.equal(body.workerRevision, "a".repeat(40));
  assert.equal(body.readOnly, true);
  assert.equal(body.beforeAfterClaimsEqual, true);
  assert.equal(body.policyActiveWipCap, POLICY_ACTIVE_WIP_CAP);
  assert.equal(body.liveAuthority, "NONE");
  assert.equal(body.productionMutationAllowed, false);
  assert.equal(body.aiAuthority, "ZERO_AUTHORITY");
  assert.equal(body.activeCount, 1);
  assert.equal(body.overPolicyCap, false);
  const view = body.claims[0];
  assert.equal(view.claimId, claim.executionId);
  assert.equal(view.canonicalOwner, "apps/cloud");
  assert.equal(view.claimedAt, claim.claimedAt);
  assert.equal(view.claimExpiresAt, claim.claimedAt + ACTIVE_WIP_CLAIM_MAX_AGE_MS);
  assert.equal(view.claimExpiryBasis, "COMPUTED_CLAIMED_AT_PLUS_ACTIVE_WIP_CLAIM_MAX_AGE_MS");
  assert.equal(view.claimState, "ACTIVE");
  assert.equal(view.leaseHolder, "UNKNOWN", "no holder is stored, so it is UNKNOWN");
  assert.equal(view.heartbeat, "UNKNOWN", "no heartbeat is stored, so it is UNKNOWN");
  assert.equal(view.persistentExecution, "NOT_STORED");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a read never writes: only GET requests to the two read paths reach the Coordinator, and the stored state is unchanged", async () => {
  resetOperatorJwksCacheForTest();
  const pair = await newKeyPair();
  const keys = await jwksOf(pair);
  const calls: Call[] = [];
  const ns = namespace({ calls });
  await admitActiveWip(ns, claim);
  calls.length = 0;
  const before = JSON.stringify((await readActiveWip(ns)).claims);
  calls.length = 0;
  const response = await handleOperatorCoordinatorStatus(get(await token(pair, goodClaims())), env(ns), { now: () => NOW, fetchJwks: async () => keys });
  assert.equal(response.status, 200);
  assert.ok(calls.length >= 3);
  assert.ok(calls.every((call) => call.method === "GET"), JSON.stringify(calls));
  assert.ok(calls.every((call) => call.path === "/active-wip" || call.path === "/execution"), JSON.stringify(calls));
  assert.equal(JSON.stringify((await readActiveWip(ns)).claims), before);
});

test("a stale claim is shown as expired but is not pruned, and an empty Coordinator reads as an empty read", async () => {
  resetOperatorJwksCacheForTest();
  const pair = await newKeyPair();
  const keys = await jwksOf(pair);
  const ns = namespace();
  await admitActiveWip(ns, { ...claim, claimedAt: NOW - ACTIVE_WIP_CLAIM_MAX_AGE_MS - 1_000 });
  const stale = await (await handleOperatorCoordinatorStatus(get(await token(pair, goodClaims())), env(ns), { now: () => NOW, fetchJwks: async () => keys })).json() as Record<string, any>;
  assert.equal(stale.claims[0].claimState, "EXPIRED_NOT_PRUNED");
  assert.equal(stale.activeCount, 0, "an expired claim is not counted as active");
  assert.equal(stale.storedClaimCount, 1);
  assert.equal((await readActiveWip(ns)).claims.length, 1, "the read did not prune");
  const empty = await (await handleOperatorCoordinatorStatus(get(await token(pair, goodClaims())), env(namespace()), { now: () => NOW, fetchJwks: async () => keys })).json() as Record<string, any>;
  assert.deepEqual([empty.snapshot, empty.claims, empty.activeCount], ["CONSISTENT", [], 0]);
});

test("a persistent execution record is shown with its stored lease expiry; an unreadable one is UNKNOWN", async () => {
  resetOperatorJwksCacheForTest();
  const pair = await newKeyPair();
  const keys = await jwksOf(pair);
  const failing = namespace({ override: (call) => call.path === "/execution" ? new Response("{}", { status: 500 }) : undefined });
  await admitActiveWip(failing, claim);
  const body = await (await handleOperatorCoordinatorStatus(get(await token(pair, goodClaims())), env(failing), { now: () => NOW, fetchJwks: async () => keys })).json() as Record<string, any>;
  assert.equal(body.claims[0].persistentExecution, "UNKNOWN");
  const withRecord = namespace({ override: (call) => call.path === "/execution" ? new Response(JSON.stringify({ record: { dedupeKey: claim.dedupeKey, executionId: claim.executionId, state: "RUNNING", leaseExpiresAt: NOW + 1_000, updatedAt: NOW - 5_000, taskId: "issue-3108", provider: "secret-provider", headSha: "b".repeat(40) } }), { status: 200 }) : undefined });
  await admitActiveWip(withRecord, claim);
  const second = await (await handleOperatorCoordinatorStatus(get(await token(pair, goodClaims())), env(withRecord), { now: () => NOW, fetchJwks: async () => keys })).json() as Record<string, any>;
  assert.deepEqual(second.claims[0].persistentExecution, { state: "RUNNING", taskId: "issue-3108", leaseExpiresAt: NOW + 1_000, updatedAt: NOW - 5_000, leaseState: "LEASE_ACTIVE" });
  assert.doesNotMatch(JSON.stringify(second), /secret-provider/, "fields that are not part of the view are never echoed");
});

test("an inconsistent or unreadable snapshot is UNKNOWN, never an empty slot", async () => {
  resetOperatorJwksCacheForTest();
  const pair = await newKeyPair();
  const keys = await jwksOf(pair);
  const claimOf = (id: string) => ({ dedupeKey: `k:${id}`, executionId: id, canonicalOwner: "apps/cloud", conflictKeys: ["a"], claimedAt: NOW - 1_000 });
  const shifting = namespace({ override: (call, count) => call.path === "/active-wip" ? new Response(JSON.stringify({ claims: [claimOf(count === 1 ? "one" : "two")], activeExecutions: 1 }), { status: 200 }) : undefined });
  const inconsistent = await (await handleOperatorCoordinatorStatus(get(await token(pair, goodClaims())), env(shifting), { now: () => NOW, fetchJwks: async () => keys })).json() as Record<string, any>;
  assert.deepEqual([inconsistent.snapshot, inconsistent.claims, inconsistent.activeCount], ["INCONSISTENT", "UNKNOWN", "UNKNOWN"]);
  const broken = namespace({ override: (call) => call.path === "/active-wip" ? new Response("{}", { status: 500 }) : undefined });
  const unavailable = await (await handleOperatorCoordinatorStatus(get(await token(pair, goodClaims())), env(broken), { now: () => NOW, fetchJwks: async () => keys })).json() as Record<string, any>;
  assert.deepEqual([unavailable.snapshot, unavailable.claims, unavailable.activeCount], ["UNAVAILABLE", "UNKNOWN", "UNKNOWN"]);
});

test("unsafe stored values are shown as UNKNOWN instead of being echoed", async () => {
  resetOperatorJwksCacheForTest();
  const pair = await newKeyPair();
  const keys = await jwksOf(pair);
  const odd = namespace({ override: (call) => call.path === "/active-wip" ? new Response(JSON.stringify({ claims: [{ dedupeKey: "k", executionId: "<script>alert(1)</script>", canonicalOwner: "x y", conflictKeys: ["ok:1", "bad key"], claimedAt: "yesterday" }], activeExecutions: 1 }), { status: 200 }) : undefined });
  const body = await (await handleOperatorCoordinatorStatus(get(await token(pair, goodClaims())), env(odd), { now: () => NOW, fetchJwks: async () => keys })).json() as Record<string, any>;
  assert.equal(body.claims[0].claimId, "UNKNOWN");
  assert.equal(body.claims[0].canonicalOwner, "UNKNOWN");
  assert.deepEqual(body.claims[0].conflictKeys, ["ok:1", "UNKNOWN"]);
  assert.equal(body.claims[0].claimedAt, "UNKNOWN");
  assert.equal(body.claims[0].claimState, "UNKNOWN");
  assert.equal(body.activeCount, 0, "a claim whose age is unproven is not counted as active");
});

test("every token defect is denied with its own cause", async () => {
  const pair = await newKeyPair();
  const other = await newKeyPair();
  const ok = await token(pair, goodClaims());
  const parts = ok.split(".");
  const code = async (jwt: string | null, over: Partial<AccessConfig> = {}, fetchJwks?: (url: string) => Promise<unknown>, host = HOST) => (await verify(jwt, pair, over, fetchJwks, host) as { code?: string }).code;
  assert.equal((await verify(ok, pair)).ok, true);
  assert.equal(await code(null), "TOKEN_MISSING");
  assert.equal(await code("  "), "TOKEN_MISSING");
  assert.equal(await code("a.b"), "TOKEN_MALFORMED");
  assert.equal(await code(`${parts[0]}..${parts[2]}`), "TOKEN_MALFORMED");
  assert.equal(await code(`${parts[0]}.${parts[1]}.!!!`), "TOKEN_MALFORMED");
  assert.equal(await code(`${parts[0]}.${parts[1]}.${"a".repeat(9000)}`), "TOKEN_MALFORMED");
  assert.equal(await code(`${b64url("not json")}.${parts[1]}.${parts[2]}`), "TOKEN_MALFORMED");
  assert.equal(await code(await token(pair, goodClaims(), { alg: "none", kid: KID })), "ALG_NOT_ALLOWED");
  assert.equal(await code(await token(pair, goodClaims(), { alg: "HS256", kid: KID })), "ALG_NOT_ALLOWED");
  assert.equal(await code(await token(pair, goodClaims(), { alg: "RS256" })), "KID_MISSING");
  assert.equal(await code(await token(pair, goodClaims(), { alg: "RS256", kid: "other-key" })), "KID_UNKNOWN");
  assert.equal(await code(await token(other, goodClaims())), "SIGNATURE_INVALID", "signed by a key that is not in the key set");
  assert.equal(await code(`${parts[0]}.${b64url(JSON.stringify(goodClaims({ email: "attacker@example.com" })))}.${parts[2]}`), "SIGNATURE_INVALID", "payload changed after signing");
  assert.equal(await code(await token(pair, goodClaims({ iss: "https://evil.cloudflareaccess.com" }))), "ISSUER_MISMATCH");
  assert.equal(await code(await token(pair, goodClaims({ aud: ["b".repeat(64)] }))), "AUDIENCE_MISMATCH");
  assert.equal(await code(await token(pair, goodClaims({ aud: [AUD, 7] }))), "AUDIENCE_MISMATCH");
  assert.equal(await code(await token(pair, goodClaims({ aud: undefined }))), "AUDIENCE_MISMATCH");
  assert.equal(await code(await token(pair, goodClaims({ exp: NOW / 1000 - 1 }))), "TOKEN_EXPIRED");
  assert.equal(await code(await token(pair, goodClaims({ exp: NOW / 1000 }))), "TOKEN_EXPIRED", "expiry is exclusive");
  assert.equal(await code(await token(pair, goodClaims({ exp: undefined }))), "CLAIMS_INVALID");
  assert.equal(await code(await token(pair, goodClaims({ exp: "tomorrow" }))), "CLAIMS_INVALID");
  assert.equal(await code(await token(pair, goodClaims({ nbf: NOW / 1000 + 3600 }))), "TOKEN_NOT_YET_VALID");
  assert.equal(await code(await token(pair, goodClaims({ iat: NOW / 1000 + 3600 }))), "TOKEN_NOT_YET_VALID");
  assert.equal(await code(await token(pair, goodClaims({ nbf: "soon" }))), "CLAIMS_INVALID");
  assert.equal(await code(await token(pair, goodClaims({ email: undefined, common_name: "service-token" }))), "OPERATOR_NOT_ALLOWED", "a service token is not an operator");
  assert.equal(await code(await token(pair, goodClaims({ email: "someone@example.com" }))), "OPERATOR_NOT_ALLOWED");
  assert.equal(await code(await token(pair, goodClaims({ email: `${OPERATOR},attacker@example.com` }))), "OPERATOR_NOT_ALLOWED");
  assert.equal((await verify(await token(pair, goodClaims({ email: OPERATOR.toUpperCase() })), pair)).ok, true, "the operator compare ignores case");
  assert.equal(await code(ok, {}, undefined, "other.example.com"), "HOST_NOT_ALLOWED");
  assert.equal(await code(ok, {}, undefined, "autopilot.example.com.evil.com"), "HOST_NOT_ALLOWED");
});

test("an unreachable, empty or malformed key set is a denial (fail closed)", async () => {
  const pair = await newKeyPair();
  const ok = await token(pair, goodClaims());
  const keys = await jwksOf(pair);
  const code = async (fetchJwks: (url: string) => Promise<unknown>) => (await verify(ok, pair, {}, fetchJwks) as { code?: string }).code;
  assert.equal(await code(async () => { throw new Error("network down"); }), "JWKS_UNAVAILABLE");
  assert.equal(await code(async () => ({ keys: [] })), "JWKS_UNAVAILABLE");
  assert.equal(await code(async () => ({ nokeys: true })), "JWKS_UNAVAILABLE");
  assert.equal(await code(async () => null), "JWKS_UNAVAILABLE");
  assert.equal(await code(async () => ({ keys: [{ kty: "oct", kid: KID, k: "x" }] })), "JWKS_UNAVAILABLE", "only RSA signing keys count");
  assert.equal(await code(async () => ({ keys: Array.from({ length: 40 }, (_, index) => ({ ...keys.keys[0] as object, kid: `k${index}` })) })), "JWKS_UNAVAILABLE", "an oversized key set is refused");
  let requested = "";
  assert.equal((await verify(ok, pair, {}, async (url) => { requested = url; return keys; })).ok, true);
  assert.equal(requested, `https://${TEAM}/cdn-cgi/access/certs`, "the key set is fetched only from the configured team domain");
});

test("an unknown key id refetches the key set at most once per minute", async () => {
  resetOperatorJwksCacheForTest();
  const pair = await newKeyPair();
  const keys = await jwksOf(pair);
  let fetches = 0;
  const fetchJwks = async () => { fetches += 1; return keys; };
  const unknown = await token(pair, goodClaims(), { alg: "RS256", kid: "rotated-key" });
  const at = (now: number) => ({ now, requestHostname: HOST, fetchJwks });
  assert.deepEqual(await verifyAccessJwt(unknown, config, at(NOW)), { ok: false, code: "KID_UNKNOWN" });
  assert.equal(fetches, 1, "the key set was fetched just now, so an unknown key id does not fetch it again");
  assert.deepEqual(await verifyAccessJwt(unknown, config, at(NOW + 30_000)), { ok: false, code: "KID_UNKNOWN" });
  assert.equal(fetches, 1, "still within a minute of the last fetch");
  assert.deepEqual(await verifyAccessJwt(unknown, config, at(NOW + 61_000)), { ok: false, code: "KID_UNKNOWN" });
  assert.equal(fetches, 2, "after a minute one refetch is allowed (a rotated key)");
  assert.deepEqual(await verifyAccessJwt(unknown, config, at(NOW + 62_000)), { ok: false, code: "KID_UNKNOWN" });
  assert.equal(fetches, 2, "and then rate limited again");
});

test("every denial answers with the same body, and the Coordinator is never touched", async () => {
  resetOperatorJwksCacheForTest();
  const pair = await newKeyPair();
  const keys = await jwksOf(pair);
  const calls: Call[] = [];
  const ns = namespace({ calls });
  const attempts: Array<string | null> = [null, "garbage", await token(await newKeyPair(), goodClaims()), await token(pair, goodClaims({ exp: NOW / 1000 - 5 })), await token(pair, goodClaims({ email: "x@example.com" }))];
  for (const attempt of attempts) {
    const response = await handleOperatorCoordinatorStatus(get(attempt), env(ns), { now: () => NOW, fetchJwks: async () => keys });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
  }
  const hostile = await handleOperatorCoordinatorStatus(get(await token(pair, goodClaims()), "evil.example.com"), env(ns), { now: () => NOW, fetchJwks: async () => keys });
  assert.equal(hostile.status, 401);
  assert.equal(calls.length, 0, "no denied request reached the Coordinator");
});

test("a missing or malformed configuration keeps the route closed", async () => {
  const pair = await newKeyPair();
  const keys = await jwksOf(pair);
  const ns = namespace();
  const jwt = await token(pair, goodClaims());
  const closed: Array<Partial<OperatorStatusEnv>> = [
    { NUSA_ACCESS_TEAM_DOMAIN: undefined }, { NUSA_ACCESS_TEAM_DOMAIN: "evil.com" }, { NUSA_ACCESS_TEAM_DOMAIN: "a.b.cloudflareaccess.com" },
    { NUSA_ACCESS_TEAM_DOMAIN: `${TEAM}/path` }, { NUSA_ACCESS_TEAM_DOMAIN: `${TEAM}:443` }, { NUSA_ACCESS_AUD: undefined }, { NUSA_ACCESS_AUD: "short" },
    { NUSA_ACCESS_OPERATOR_EMAILS: undefined }, { NUSA_ACCESS_OPERATOR_EMAILS: " , " }, { NUSA_ACCESS_OPERATOR_EMAILS: "not-an-email" },
    { NUSA_ACCESS_ALLOWED_HOSTS: undefined }, { NUSA_ACCESS_ALLOWED_HOSTS: "*" }, { NUSA_ACCESS_ALLOWED_HOSTS: "https://autopilot.example.com" },
  ];
  for (const over of closed) {
    assert.equal(parseAccessConfig(env(ns, over)), undefined, JSON.stringify(over));
    const response = await handleOperatorCoordinatorStatus(get(jwt), env(ns, over), { now: () => NOW, fetchJwks: async () => keys });
    assert.equal(response.status, 503, JSON.stringify(over));
  }
  assert.equal((await handleOperatorCoordinatorStatus(get(jwt), env(undefined), { now: () => NOW, fetchJwks: async () => keys })).status, 503, "no Coordinator binding");
  assert.deepEqual(parseAccessConfig(env(ns)), config);
});

test("only GET is served", async () => {
  const pair = await newKeyPair();
  const keys = await jwksOf(pair);
  const jwt = await token(pair, goodClaims());
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
    const response = await handleOperatorCoordinatorStatus(new Request(`https://${HOST}/operator/coordinator/status`, { method, headers: { "cf-access-jwt-assertion": jwt } }), env(namespace()), { now: () => NOW, fetchJwks: async () => keys });
    assert.equal(response.status, 405, method);
  }
});

test("the Worker serves the route closed unless fully configured and leaves the other routes alone", async () => {
  const closed = await worker.fetch(new Request(`https://${HOST}/operator/coordinator/status`), { NUSA_EXECUTION_COORDINATOR: namespace() } as never);
  assert.equal(closed.status, 503);
  const post = await worker.fetch(new Request(`https://${HOST}/operator/coordinator/status`, { method: "POST", body: "{}" }), { NUSA_EXECUTION_COORDINATOR: namespace() } as never);
  assert.equal(post.status, 405);
  const other = await worker.fetch(new Request(`https://${HOST}/operator/coordinator/other`), {} as never);
  assert.notEqual(other.status, 200);
});
