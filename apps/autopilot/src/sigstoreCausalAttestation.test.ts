import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { verifyCausalProducerAttestation } from "./sigstoreCausalAttestation";

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
