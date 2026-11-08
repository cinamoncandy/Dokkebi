import assert from "node:assert/strict";
import test from "node:test";
import { handleCodexWipCoordination, type WorkerEnv } from "./worker";
import { ExecutionCoordinator, admitActiveWip, readActiveWip, type ExecutionCoordinatorNamespace } from "./executionCoordinator";
import { CODEX_WIP_AUDIENCE } from "./githubActionsOidc";

const REPOSITORY = "cinamoncandy/NUSA";
const WORKFLOW_PATH = ".github/workflows/autopilot-codex-coding.yml";
const SHA = "a".repeat(40);
const NOW = 1_800_000_000_000;

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

function namespace(): ExecutionCoordinatorNamespace {
  const coordinators = new Map<string, ExecutionCoordinator>();
  return {
    idFromName: (name) => ({ name }),
    get: (id) => {
      const name = (id as { name: string }).name;
      let coordinator = coordinators.get(name);
      if (!coordinator) {
        coordinator = new ExecutionCoordinator({ storage: new MemoryStorage() });
        coordinators.set(name, coordinator);
      }
      const target = coordinator;
      return { fetch: (input, init) => target.fetch(new Request(input, init)) };
    },
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function oidcFixture(overrides: Record<string, unknown> = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: CODEX_WIP_AUDIENCE,
    exp: Math.floor(NOW / 1000) + 300,
    nbf: Math.floor(NOW / 1000) - 10,
    iat: Math.floor(NOW / 1000) - 10,
    repository: REPOSITORY,
    ref: "refs/heads/main",
    event_name: "workflow_dispatch",
    workflow_ref: `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`,
    sha: SHA,
    run_id: "12345",
    run_attempt: "2",
    ...overrides,
  };
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "fixture-kid", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const bytes = new TextEncoder().encode(`${header}.${payload}`);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, bytes));
  const token = `${header}.${payload}.${base64Url(signature)}`;
  return {
    token,
    jwks: { keys: [{ ...jwk, kid: "fixture-kid", alg: "RS256", use: "sig" }] },
    claims,
  };
}

const issue = (number = 903) => ({
  number,
  title: "[P0][Autopilot] bounded coordinator change",
  body: `Implement a bounded Autopilot change. liveAuthority=NONE productionMutationAllowed=false aiAuthority=ZERO_AUTHORITY\ncanonicalOwner: apps/autopilot\nconflictKeys: issue:${number},module:apps/autopilot/src`,
  state: "open",
  author_association: "OWNER",
  updated_at: "2026-11-08T00:00:00Z",
  labels: [],
});

function githubFetch(fixture: Awaited<ReturnType<typeof oidcFixture>>, options: { run?: Record<string, unknown>; issue?: unknown; pulls?: unknown; mainSha?: string | null } = {}) {
  const defaultRun = {
    id: Number(fixture.claims.run_id),
    run_attempt: Number(fixture.claims.run_attempt),
    repository: { full_name: REPOSITORY },
    path: WORKFLOW_PATH,
    head_sha: fixture.claims.sha,
    head_branch: "main",
    event: fixture.claims.event_name,
    status: "in_progress",
  };
  return async (input: string) => {
    const url = String(input);
    if (url.endsWith("/.well-known/jwks")) return new Response(JSON.stringify(fixture.jwks), { status: 200 });
    if (url.includes("/actions/runs/")) return new Response(JSON.stringify({ ...defaultRun, ...options.run }), { status: 200 });
    if (url.endsWith("/git/ref/heads/main")) return options.mainSha === null
      ? new Response("unavailable", { status: 503 })
      : new Response(JSON.stringify({ object: { sha: options.mainSha ?? fixture.claims.sha } }), { status: 200 });
    if (url.includes("/issues?")) return new Response(JSON.stringify([options.issue ?? issue()]), { status: 200 });
    if (url.includes("/pulls?")) return new Response(JSON.stringify(options.pulls ?? []), { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

function request(token: string, action: string, issueNumber = 903, headSha = SHA): Request {
  return new Request("https://worker.example.test/coding/codex-wip", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ action, issueNumber, headSha }),
  });
}

function env(coordinator: ExecutionCoordinatorNamespace): WorkerEnv {
  return {
    NUSA_GITHUB_REPOSITORY: REPOSITORY,
    NUSA_GITHUB_TOKEN: "read-only-github-token",
    NUSA_EXECUTION_COORDINATOR: coordinator,
  } as unknown as WorkerEnv;
}

test("Codex claims the existing WIP slot, rejects duplicate admission, and releases with a durable replay tombstone", async () => {
  const coordinator = namespace();
  const fixture = await oidcFixture();
  const fetchImpl = githubFetch(fixture);
  const dependencies = { now: () => NOW, fetchImpl };
  const claimed = await handleCodexWipCoordination(request(fixture.token, "claim"), env(coordinator), dependencies);
  assert.equal(claimed.status, 201);
  const claim = await claimed.json() as { accepted: boolean; executionId: string; dedupeKey: string };
  assert.equal(claim.accepted, true);
  const active = await readActiveWip(coordinator);
  assert.equal(active.claims.length, 1);
  assert.equal(active.claims[0]?.canonicalOwner, "apps/autopilot");
  assert.deepEqual(active.claims[0]?.conflictKeys, ["issue:903", "module:apps/autopilot/src"]);

  const duplicate = await handleCodexWipCoordination(request(fixture.token, "claim"), env(coordinator), dependencies);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json() as { error: string }).error, "ALREADY_ACTIVE");
  assert.equal((await readActiveWip(coordinator)).claims.length, 1);

  const released = await handleCodexWipCoordination(request(fixture.token, "release"), env(coordinator), dependencies);
  assert.equal(released.status, 200);
  assert.equal((await released.json() as { released: boolean }).released, true);
  const completionResponse = await coordinator.get(coordinator.idFromName("evolve-active-wip-v1")).fetch("https://execution-coordinator/active-wip/completions");
  const completion = (await completionResponse.json() as { completions: Array<{ kind: string }> }).completions[0];
  assert.equal(completion?.kind, "CLAIM_RELEASED");
  assert.equal((await readActiveWip(coordinator)).claims.length, 0);

  const replay = await handleCodexWipCoordination(request(fixture.token, "claim"), env(coordinator), dependencies);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json() as { error: string }).error, "ACTIVE_WIP_REPLAYED");
});

test("Codex claim is bound to the live OIDC workflow, task selection, and available two-slot capacity", async () => {
  const coordinator = namespace();
  const valid = await oidcFixture();
  const wrongWorkflow = await oidcFixture({ event_name: "workflow_dispatch", workflow_ref: `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main` });
  assert.equal((await handleCodexWipCoordination(request(wrongWorkflow.token, "claim"), env(coordinator), { now: () => NOW, fetchImpl: githubFetch(wrongWorkflow) })).status, 401);

  const staleRun = await handleCodexWipCoordination(request(valid.token, "claim"), env(coordinator), {
    now: () => NOW,
    fetchImpl: githubFetch(valid, { run: { status: "completed" } }),
  });
  assert.equal(staleRun.status, 401);

  const linkedIssue = await handleCodexWipCoordination(request(valid.token, "claim"), env(coordinator), {
    now: () => NOW,
    fetchImpl: githubFetch(valid, { pulls: [{ number: 100, title: "fix", body: "Refs #903" }] }),
  });
  assert.equal(linkedIssue.status, 409);
  assert.equal((await readActiveWip(coordinator)).claims.length, 0);

  await admitActiveWip(coordinator, { dedupeKey: "existing:wip:1", executionId: "existing:exec:1", canonicalOwner: "owner-1", conflictKeys: ["path:1"], claimedAt: NOW, maxConcurrent: 2 });
  await admitActiveWip(coordinator, { dedupeKey: "existing:wip:2", executionId: "existing:exec:2", canonicalOwner: "owner-2", conflictKeys: ["path:2"], claimedAt: NOW, maxConcurrent: 2 });
  const full = await handleCodexWipCoordination(request(valid.token, "claim"), env(coordinator), { now: () => NOW, fetchImpl: githubFetch(valid) });
  assert.equal(full.status, 409);
  assert.equal((await full.json() as { error: string }).error, "WIP_LIMIT_REACHED");
  assert.equal((await readActiveWip(coordinator)).claims.length, 2);
});

test("Codex release from another run cannot release the original task claim", async () => {
  const coordinator = namespace();
  const owner = await oidcFixture();
  const claim = await handleCodexWipCoordination(request(owner.token, "claim"), env(coordinator), { now: () => NOW, fetchImpl: githubFetch(owner) });
  assert.equal(claim.status, 201);
  const otherRun = await oidcFixture({ run_id: "54321" });
  const denied = await handleCodexWipCoordination(request(otherRun.token, "release"), env(coordinator), { now: () => NOW + 1_000, fetchImpl: githubFetch(otherRun) });
  assert.equal(denied.status, 409);
  assert.equal((await readActiveWip(coordinator)).claims.length, 1);
});

test("Codex client cannot substitute a different checkout SHA for the authenticated run SHA", async () => {
  const fixture = await oidcFixture();
  const response = await handleCodexWipCoordination(request(fixture.token, "claim", 903, "b".repeat(40)), env(namespace()), {
    now: () => NOW,
    fetchImpl: githubFetch(fixture),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, "CODEX_WIP_HEAD_SHA_MISMATCH");
});

test("Codex claim rejects a moved or unavailable protected main before creating a WIP claim", async () => {
  const coordinator = namespace();
  const fixture = await oidcFixture();
  const movedMain = await handleCodexWipCoordination(request(fixture.token, "claim"), env(coordinator), {
    now: () => NOW,
    fetchImpl: githubFetch(fixture, { mainSha: "b".repeat(40) }),
  });
  assert.equal(movedMain.status, 409);
  assert.equal((await movedMain.json() as { error: string }).error, "CODEX_WIP_MAIN_MISMATCH");
  assert.equal((await readActiveWip(coordinator)).claims.length, 0);

  const unavailableMain = await handleCodexWipCoordination(request(fixture.token, "claim"), env(coordinator), {
    now: () => NOW,
    fetchImpl: githubFetch(fixture, { mainSha: null }),
  });
  assert.equal(unavailableMain.status, 503);
  assert.equal((await unavailableMain.json() as { error: string }).error, "CODEX_WIP_MAIN_UNAVAILABLE");
  assert.equal((await readActiveWip(coordinator)).claims.length, 0);
});

test("Codex claim endpoint rejects forged and expired OIDC tokens before WIP admission", async () => {
  const coordinator = namespace();
  const valid = await oidcFixture();
  const [header, payload, signature] = valid.token.split(".");
  assert.ok(header && payload && signature);
  const replacement = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  const forged = await handleCodexWipCoordination(request(`${header}.${payload}.${replacement}`, "claim"), env(coordinator), {
    now: () => NOW,
    fetchImpl: githubFetch(valid),
  });
  assert.equal(forged.status, 401);

  const expired = await oidcFixture({ exp: Math.floor(NOW / 1000) - 120 });
  const expiredResponse = await handleCodexWipCoordination(request(expired.token, "claim"), env(coordinator), {
    now: () => NOW,
    fetchImpl: githubFetch(expired),
  });
  assert.equal(expiredResponse.status, 401);
  assert.equal((await readActiveWip(coordinator)).claims.length, 0);
});

test("missing coordinator, GitHub authority, and malformed request all fail closed", async () => {
  const fixture = await oidcFixture();
  const unavailable = await handleCodexWipCoordination(request(fixture.token, "claim"), {} as WorkerEnv, { now: () => NOW, fetchImpl: githubFetch(fixture) });
  assert.equal(unavailable.status, 503);
  const malformed = await handleCodexWipCoordination(new Request("https://worker.example.test/coding/codex-wip", { method: "POST" }), env(namespace()));
  assert.equal(malformed.status, 401);
});
