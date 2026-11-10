import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { verifyCausalProducerAttestation, verifyIsolatedCausalVerificationAttestation } from "./sigstoreCausalAttestation";

const fixturePath = join(process.cwd(), "apps/autopilot/src/test-fixtures/sigstore-upstream-valid.json");
const source = Object.freeze({ repository: "cinamoncandy/NUSA", sha: "a".repeat(40), runId: "456", runAttempt: "1" });

function readFixture(): Record<string, any> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, any>;
}

test("cryptographically valid upstream Sigstore evidence is rejected when signer identity is not the pinned NUSA producer", async () => {
  // This upstream fixture is a crypto control only; its publisher is deliberately not NUSA.
  await assert.rejects(verifyCausalProducerAttestation(readFixture().bundle, source), {
    message: "CAUSAL_ATTESTATION_SIGNER_REJECTED",
  });
});

test("tampered DSSE signature fails closed before any source or causal identity can be accepted", async () => {
  const fixture = readFixture();
  const signature = fixture.bundle.dsseEnvelope.signatures[0].sig as string;
  const bytes = Uint8Array.from(atob(signature), (character) => character.charCodeAt(0));
  bytes[bytes.length - 1] ^= 1;
  fixture.bundle.dsseEnvelope.signatures[0].sig = btoa(String.fromCharCode(...bytes));
  await assert.rejects(verifyCausalProducerAttestation(fixture.bundle, source), {
    message: "CAUSAL_ATTESTATION_INVALID",
  });
});

test("malformed bundles fail closed", async () => {
  await assert.rejects(verifyCausalProducerAttestation({ mediaType: "application/json" }, source), {
    message: "CAUSAL_ATTESTATION_INVALID",
  });
});

test("isolated proof verification is fail-closed and does not reuse production admission", async () => {
  await assert.rejects(
    verifyIsolatedCausalVerificationAttestation({ mediaType: "application/json" }, source),
    { message: "ISOLATED_CAUSAL_VERIFICATION_INVALID" },
  );
  await assert.rejects(
    verifyIsolatedCausalVerificationAttestation({ mediaType: "application/json" }, { ...source, sha: "invalid" }),
    { message: "ISOLATED_CAUSAL_VERIFICATION_INVALID" },
  );
});

// A genuine bundle from the isolated workflow on main (source run 42812292317, sha 7714c22a). Before the fix every
// genuine NUSA signature was rejected: Fulcio's SAN is the full https://github.com/... URL, not the bare workflow ref.
const genuineIsolatedPath = join(process.cwd(), "apps/autopilot/src/test-fixtures/isolated-causal-attestation-run-42812292317.json");
const genuineIsolatedSource = Object.freeze({ sha: "7714c22a3439c332e93841ea79535082cc27be2e", runId: "42812292317", runAttempt: "1" });

test("a genuine isolated NUSA attestation verifies and carries the certificate's full-URL signer identity", async () => {
  const bundle = JSON.parse(readFileSync(genuineIsolatedPath, "utf8"));
  const verified = await verifyIsolatedCausalVerificationAttestation(bundle, genuineIsolatedSource);
  assert.equal(verified.domain, "NUSA_ISOLATED_CAUSAL_VERIFICATION_V1");
  assert.equal(verified.source.sha, genuineIsolatedSource.sha);
  assert.equal(verified.source.runId, genuineIsolatedSource.runId);
  assert.equal(verified.signerIdentity.subjectAlternativeName, "https://github.com/cinamoncandy/NUSA/.github/workflows/causal-verification.yml@refs/heads/main");
  assert.equal(verified.signerIdentity.issuer, "https://token.actions.githubusercontent.com");
});

test("the same genuine bundle is still refused for any other source run, sha or attempt", async () => {
  const bundle = JSON.parse(readFileSync(genuineIsolatedPath, "utf8"));
  for (const wrong of [{ ...genuineIsolatedSource, runId: "42812292318" }, { ...genuineIsolatedSource, sha: "b".repeat(40) }, { ...genuineIsolatedSource, runAttempt: "2" }]) {
    await assert.rejects(verifyIsolatedCausalVerificationAttestation(bundle, wrong));
  }
  // and it can never pass as a production CI producer attestation (different workflow identity and predicate)
  await assert.rejects(verifyCausalProducerAttestation(bundle, { repository: "cinamoncandy/NUSA", ...genuineIsolatedSource }));
});
