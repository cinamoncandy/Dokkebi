const test = require("node:test");
const assert = require("node:assert/strict");
const { SqliteDatabase } = require("../dist/packages/storage/src/index.js");
const { SqliteNusaUserAccessRepository } = require("../dist/apps/cloud/src/operatorUserAccess.js");
const { MobileSessionService, MOBILE_PAIRING_TTL_MS } = require("../dist/apps/cloud/src/mobileSessionService.js");
const pairingHttp = require("../dist/apps/cloud/src/mobileSessionHttp.js");

const DEVICE = "nusa-install-device-0001";
const OTHER_DEVICE = "nusa-install-device-0002";
const OWNER = Object.freeze({ userId: "owner", email: "owner@nusa.local", scopes: ["users:manage"] });
const OWNER_TOKEN = ["owner", "pairing", "fixture", "0123456789"].join("-");

function fixture() {
  const db = new SqliteDatabase(":memory:");
  const users = new SqliteNusaUserAccessRepository(db);
  users.ensureOwner({ id: OWNER.userId, email: OWNER.email }, 1);
  users.registerUser({ id: "mobile-user", email: "mobile@example.com" }, 2);
  users.changeStatus({ actorUserId: OWNER.userId, targetUserId: "mobile-user", action: "APPROVE", now: 3 });
  const service = new MobileSessionService(db, users);
  const deps = Object.freeze({
    sessionService: service,
    legacyTokenVerifier: Object.freeze({ ownerPrincipal: OWNER, verify: (value) => value === OWNER_TOKEN ? OWNER : undefined }),
    userAccessRepository: users,
  });
  return { db, users, service, deps };
}

function request(method, body, authorization) {
  return Object.freeze({ method, body: JSON.stringify(body), headers: Object.freeze(authorization ? { authorization } : {}) });
}

test("approved pairing atomically issues a device-bound session without storing a bootstrap secret", () => {
  const { db, service } = fixture();
  try {
    const started = service.startPairing(DEVICE, 100);
    assert.equal(started.state, "PENDING");
    assert.match(started.verificationCode, /^\d{6}$/);
    assert.equal(service.approvePairing({ actorUserId: OWNER.userId, actorScopes: OWNER.scopes, targetUserId: "mobile-user", requestId: started.requestId, verificationCode: started.verificationCode, now: 101 }), true);
    const tokens = service.exchangePairing(started.requestId, DEVICE, 102);
    assert.ok(tokens);
    assert.ok(service.verifyAccess(tokens.accessToken, 103));
    assert.equal(service.refresh(tokens.refreshToken, 104, DEVICE).accessToken.length > 16, true);
    assert.equal(service.exchangePairing(started.requestId, DEVICE, 105), undefined, "exchange is one use");
    const schema = db.connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mobile_pairing_requests'").get().sql;
    const rows = db.connection.prepare("SELECT * FROM mobile_pairing_requests").all();
    const serialized = JSON.stringify(rows);
    assert.doesNotMatch(schema, /bootstrap_token/i);
    assert.equal(serialized.includes(started.requestId), false);
    assert.equal(serialized.includes(started.verificationCode), false);
    assert.equal(serialized.includes(tokens.accessToken), false);
    assert.equal(serialized.includes(tokens.refreshToken), false);
    const audit = JSON.stringify(db.connection.prepare("SELECT event,reason FROM mobile_session_audit").all());
    assert.equal(audit.includes(started.requestId), false);
    assert.equal(audit.includes(started.verificationCode), false);
  } finally { db.close(); }
});

test("pairing approval requires active OWNER users:manage, target activity, matching device, expiry, and bounded starts", () => {
  const { db, users, service, deps } = fixture();
  try {
    const now = Date.now();
    const started = service.startPairing(DEVICE, now);
    const forbidden = pairingHttp.handleMobilePairingApproveHttp(request("POST", { requestId: started.requestId, verificationCode: started.verificationCode, targetUserId: "mobile-user" }), deps);
    assert.equal(forbidden.status, 403);
    assert.equal(service.exchangePairing(started.requestId, OTHER_DEVICE, now + 1), undefined);
    users.changeStatus({ actorUserId: OWNER.userId, targetUserId: "mobile-user", action: "SUSPEND", now: now + 2 });
    const inactive = pairingHttp.handleMobilePairingApproveHttp(request("POST", { requestId: started.requestId, verificationCode: started.verificationCode, targetUserId: "mobile-user" }, `Bearer ${OWNER_TOKEN}`), deps);
    assert.equal(inactive.status, 409);
    assert.equal(JSON.parse(inactive.body).error, "TARGET_USER_NOT_ACTIVE");
    assert.equal(service.pairingStatus(started.requestId, DEVICE, now + MOBILE_PAIRING_TTL_MS).state, "EXPIRED");
    assert.equal(db.connection.prepare("SELECT state FROM mobile_pairing_requests WHERE request_id_hash=?").get(require("node:crypto").createHash("sha256").update(started.requestId).digest("hex")).state, "EXPIRED");
  } finally { db.close(); }
});

test("same-device retry supersedes a pending request before TTL without preserving approval or exchange capability", () => {
  const { db, service, deps } = fixture();
  try {
    const firstResponse = pairingHttp.handleMobilePairingStartHttp(request("POST", { deviceId: DEVICE }), deps);
    const replacementResponse = pairingHttp.handleMobilePairingStartHttp(request("POST", { deviceId: DEVICE }), deps);
    assert.equal(firstResponse.status, 201);
    assert.equal(replacementResponse.status, 201);
    const first = JSON.parse(firstResponse.body);
    const replacement = JSON.parse(replacementResponse.body);
    const now = Date.now();

    assert.notEqual(replacement.requestId, first.requestId);
    assert.equal(service.pairingStatus(first.requestId, DEVICE, now)?.state, "EXPIRED");
    assert.equal(service.approvePairing({ actorUserId: OWNER.userId, actorScopes: OWNER.scopes, targetUserId: "mobile-user", requestId: first.requestId, verificationCode: first.verificationCode, now }), false);
    assert.equal(service.exchangePairing(first.requestId, DEVICE, now), undefined);
    assert.equal(service.pairingStatus(replacement.requestId, DEVICE, now)?.state, "PENDING");
    const audit = JSON.stringify(db.connection.prepare("SELECT event,reason FROM mobile_session_audit WHERE event='PAIRING_SUPERSEDED'").all());
    assert.match(audit, /SAME_DEVICE_RETRY/);
    assert.equal(audit.includes(first.requestId), false);
    assert.equal(audit.includes(first.verificationCode), false);
  } finally { db.close(); }
});

test("an unauthenticated same-device start cannot cancel an owner-approved request", () => {
  const { db, service } = fixture();
  try {
    const now = 2_000_000;
    const approved = service.startPairing(DEVICE, now);
    assert.equal(service.approvePairing({ actorUserId: OWNER.userId, actorScopes: OWNER.scopes, targetUserId: "mobile-user", requestId: approved.requestId, verificationCode: approved.verificationCode, now: now + 1 }), true);

    assert.throws(() => service.startPairing(DEVICE, now + 2), /pairing request limit reached/);
    assert.equal(service.pairingStatus(approved.requestId, DEVICE, now + 2)?.state, "APPROVED");
    assert.ok(service.exchangePairing(approved.requestId, DEVICE, now + 2), "the approved request can still be exchanged by its own client");
  } finally { db.close(); }
});

test("same-device supersession preserves the global active-pairing cap for other devices", () => {
  const { db, service } = fixture();
  try {
    const now = 3_000_000;
    const firstDevice = "nusa-global-device-000";
    for (let index = 0; index < 100; index += 1) assert.ok(service.startPairing(`${firstDevice}${index}`, now));
    assert.ok(service.startPairing(`${firstDevice}0`, now + 1), "the same device may replace its own pending request at the global cap");
    assert.throws(() => service.startPairing("nusa-global-device-overflow", now + 1), /limit reached/);
  } finally { db.close(); }
});

test("ACTIVE OWNER users:manage may approve by a unique verification code, while scope-less and ambiguous approvals fail closed", () => {
  const { db, service, deps } = fixture();
  try {
    const now = Date.now();
    const unique = service.startPairing(DEVICE, now);
    assert.throws(() => service.approvePairing({ actorUserId: OWNER.userId, actorScopes: [], targetUserId: "mobile-user", verificationCode: unique.verificationCode, now: now + 1 }), /owner authority required/);
    const approved = pairingHttp.handleMobilePairingApproveHttp(request("POST", { verificationCode: unique.verificationCode, targetUserId: "mobile-user" }, `Bearer ${OWNER_TOKEN}`), deps);
    assert.equal(approved.status, 200);
    assert.equal(service.exchangePairing(unique.requestId, DEVICE, now + 2)?.accessToken.length > 16, true);

    const first = service.startPairing(DEVICE, now + 10);
    const second = service.startPairing(OTHER_DEVICE, now + 11);
    const hash = require("node:crypto").createHash("sha256").update(first.verificationCode).digest("hex");
    db.connection.prepare("UPDATE mobile_pairing_requests SET verification_code_hash=? WHERE request_id_hash=?")
      .run(hash, require("node:crypto").createHash("sha256").update(second.requestId).digest("hex"));
    const ambiguous = pairingHttp.handleMobilePairingApproveHttp(request("POST", { verificationCode: first.verificationCode, targetUserId: "mobile-user" }, `Bearer ${OWNER_TOKEN}`), deps);
    assert.equal(ambiguous.status, 409);
    assert.equal(service.pairingStatus(first.requestId, DEVICE, now + 12).state, "PENDING");
    assert.equal(service.pairingStatus(second.requestId, OTHER_DEVICE, now + 12).state, "PENDING");
  } finally { db.close(); }
});

test("OWNER can approve their own unique pairing with the six-digit code only", () => {
  const { db, service, deps } = fixture();
  try {
    const now = Date.now();
    const started = service.startPairing(DEVICE, now);
    const approval = pairingHttp.handleMobilePairingApproveHttp(
      request("POST", { verificationCode: started.verificationCode }, `Bearer ${OWNER_TOKEN}`),
      deps
    );
    assert.equal(approval.status, 200);
    const tokens = service.exchangePairing(started.requestId, DEVICE, now + 1);
    assert.ok(tokens);
    assert.equal(service.me(tokens.accessToken, now + 2)?.userId, OWNER.userId);
  } finally { db.close(); }
});

test("pairing HTTP returns only status and rotating session tokens, never a bootstrap credential", () => {
  const { db, service, deps } = fixture();
  try {
    const startedResponse = pairingHttp.handleMobilePairingStartHttp(request("POST", { deviceId: DEVICE }), deps);
    const started = JSON.parse(startedResponse.body);
    const approval = pairingHttp.handleMobilePairingApproveHttp(request("POST", { requestId: started.requestId, verificationCode: started.verificationCode, targetUserId: "mobile-user" }, `Bearer ${OWNER_TOKEN}`), deps);
    assert.equal(approval.status, 200);
    const exchange = pairingHttp.handleMobilePairingExchangeHttp(request("POST", { requestId: started.requestId, deviceId: DEVICE }), deps);
    assert.equal(exchange.status, 200);
    const payload = JSON.parse(exchange.body);
    assert.equal("bootstrapToken" in payload, false);
    assert.equal("bootstrap_token" in payload, false);
    assert.ok(payload.accessToken);
    assert.ok(payload.refreshToken);
  } finally { db.close(); }
});
