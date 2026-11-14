"use strict";

const path = require("node:path");

const SHA64 = /^[0-9a-f]{64}$/;
const PAPER_MARKET = /^KRW-[A-Z0-9-]+$/;
const FORBIDDEN_KEY = /(authorization|bearer|token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key|cookie|jwt|credential)/i;

function rejectForbidden(value, seen = new Set()) {
  if (value == null || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("closed-learning worker request must be acyclic");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error("closed-learning worker request contains a forbidden field");
    rejectForbidden(child, seen);
  }
  seen.delete(value);
}

function validateRequest(request) {
  rejectForbidden(request);
  if (request == null || typeof request !== "object" || Array.isArray(request)) throw new Error("closed-learning worker request is invalid");
  if (request.schemaVersion !== 1 || request.operation !== "REPLAY_PAPER_EVIDENCE") throw new Error("closed-learning worker operation is unsupported");
  const fingerprint = String(request.originalRunFingerprintSha256 || "").trim().toLowerCase();
  if (!SHA64.test(fingerprint)) throw new Error("closed-learning worker run fingerprint is invalid");
  const evidence = request.paperEvidenceByCandidate;
  if (evidence == null || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("closed-learning worker PAPER evidence map is invalid");
  for (const [candidateId, item] of Object.entries(evidence)) {
    if (!candidateId.trim() || candidateId.length > 240) throw new Error("closed-learning worker candidate identity is invalid");
    if (item == null || typeof item !== "object" || Array.isArray(item)) throw new Error("closed-learning worker candidate evidence is invalid");
  }
  return Object.freeze({ schemaVersion: 1, operation: "REPLAY_PAPER_EVIDENCE", originalRunFingerprintSha256: fingerprint, paperEvidenceByCandidate: evidence });
}

function snapshotPathFromEnv(env) {
  const value = String(env.NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH || "").trim();
  if (!value || value === ":memory:" || !path.isAbsolute(value)) throw new Error("NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH must be an absolute durable path");
  return value;
}

function defaultDependencies() {
  const { FileResearchRunReplaySnapshotStore } = require("../dist/apps/desktop/src/cloud/researchRunReplaySnapshotStore.js");
  const { replayResearchRunWithPaperEvidence } = require("../dist/apps/desktop/src/cloud/researchRunReplaySnapshot.js");
  return { FileResearchRunReplaySnapshotStore, replayResearchRunWithPaperEvidence };
}

function notDeployable(...reasons) {
  return Object.freeze({
    schemaVersion: 1,
    status: "NOT_DEPLOYABLE",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    authority: "PAPER_RESEARCH_ONLY",
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
}

function projectPaperDeployment(snapshot, replay, originalRunFingerprintSha256) {
  const run = replay.run;
  const qualification = replay.qualification;
  const replayRunFingerprintSha256 = String(run?.provenance?.runFingerprintSha256 || "").trim().toLowerCase();
  if (!SHA64.test(replayRunFingerprintSha256)) throw new Error("closed-learning worker replay provenance is invalid");
  const allocation = run.allocation;
  if (allocation == null) {
    // Why the League refused to allocate (a fixed code such as NO_ALLOCATABLE_CANDIDATES or INSUFFICIENT_DIVERSIFICATION_CAPACITY).
    // Only a value that already is a fixed upper-case code is passed on, prefixed so it cannot be mistaken for another reason.
    const unavailable = typeof run.allocationUnavailableReason === "string" && /^[A-Z][A-Z0-9_]{2,52}$/.test(run.allocationUnavailableReason)
      ? [`ALLOCATION_${run.allocationUnavailableReason}`]
      : [];
    return notDeployable("NO_ALLOCATION_ADVISORY", ...unavailable);
  }
  if (!Array.isArray(allocation.entries)) throw new Error("closed-learning worker allocation entries are invalid");
  if (allocation.entries.length !== 1) return notDeployable("ALLOCATION_NOT_SINGLE_CANDIDATE");

  const allocationEntry = allocation.entries[0];
  if (allocationEntry == null || typeof allocationEntry !== "object") throw new Error("closed-learning worker allocation entry is invalid");
  const candidateId = String(allocationEntry.id || "").trim();
  if (!candidateId || candidateId.length > 240) throw new Error("closed-learning worker allocation candidate identity is invalid");
  if (!Number.isFinite(allocationEntry.researchWeight) || allocationEntry.researchWeight <= 0 || allocationEntry.researchWeight > 1) {
    throw new Error("closed-learning worker allocation candidate weight is invalid");
  }

  const qualificationMatches = qualification.candidates.filter((candidate) => candidate.candidateId === candidateId);
  if (qualificationMatches.length !== 1) throw new Error("closed-learning worker allocated candidate qualification identity is invalid");
  if (qualificationMatches[0].outcome !== "QUALIFIED_FOR_LEAGUE") return notDeployable("ALLOCATED_CANDIDATE_NOT_QUALIFIED");

  const provenanceBindings = Array.isArray(run.provenance?.candidateBindings)
    ? run.provenance.candidateBindings.filter((binding) => binding.candidateId === candidateId)
    : [];
  if (provenanceBindings.length !== 1) throw new Error("closed-learning worker allocated candidate provenance is invalid");
  const provenance = provenanceBindings[0];
  const candidateVersion = String(provenance.specificationHash || "").trim().toLowerCase();
  const datasetId = String(provenance.datasetId || "").trim();
  const datasetContentSha256 = String(provenance.datasetContentSha256 || "").trim().toLowerCase();
  if (!SHA64.test(candidateVersion) || !datasetId || !SHA64.test(datasetContentSha256)) throw new Error("closed-learning worker allocated candidate immutable provenance is invalid");

  const snapshotCandidates = Array.isArray(snapshot?.candidates)
    ? snapshot.candidates.filter((candidate) => candidate?.id === candidateId)
    : [];
  if (snapshotCandidates.length !== 1) throw new Error("closed-learning worker allocated candidate snapshot identity is invalid");
  const manifest = snapshotCandidates[0]?.experiment?.manifest;
  const candidateSpecification = snapshotCandidates[0]?.candidateSpecification;
  if (candidateSpecification == null || typeof candidateSpecification !== "object" || Array.isArray(candidateSpecification)) throw new Error("closed-learning worker allocated candidate strategy specification is unavailable");
  if (candidateSpecification.candidateId !== candidateId || typeof candidateSpecification.familyId !== "string" || typeof candidateSpecification.lineageId !== "string" || !candidateSpecification.parameters || typeof candidateSpecification.parameters !== "object" || Array.isArray(candidateSpecification.parameters) || typeof candidateSpecification.codeSha !== "string" || typeof candidateSpecification.costModelVersion !== "string") {
    throw new Error("closed-learning worker allocated candidate strategy specification is invalid");
  }
  const specificationBinding = run.provenance.candidateBindings.find((binding) => binding.candidateId === candidateId);
  if (specificationBinding == null || specificationBinding.specificationHash == null || !SHA64.test(String(specificationBinding.specificationHash).trim().toLowerCase())) throw new Error("closed-learning worker allocated candidate strategy specification fingerprint is unavailable");
  if (candidateSpecification.codeSha.trim().toLowerCase() !== String(snapshot.sourceCommitSha).trim().toLowerCase()) throw new Error("closed-learning worker candidate strategy source provenance drifted");
  const market = String(manifest?.market || "").trim().toUpperCase();
  if (!market || !PAPER_MARKET.test(market)) return notDeployable("PAPER_MARKET_UNSUPPORTED");
  if (manifest.datasetId !== datasetId || String(manifest.contentSha256 || "").trim().toLowerCase() !== datasetContentSha256) {
    throw new Error("closed-learning worker allocated candidate dataset provenance drifted");
  }

  const researchDecisionReference = `closed-learning-replay:${replayRunFingerprintSha256}:${candidateId}`;
  const researchLineage = Object.freeze({
    schemaVersion: 1,
    candidateId,
    candidateVersion,
    originalRunFingerprintSha256,
    replayRunFingerprintSha256,
    researchDecisionReference,
    authority: "PAPER_RESEARCH_ONLY",
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
  const artifact = Object.freeze({
    schemaVersion: 1,
    candidateId,
    candidateVersion,
    market,
    advisory: allocation,
    candidateProvenance: Object.freeze([{ candidateId, datasetId, datasetContentSha256 }]),
    candidateStrategy: Object.freeze({
      candidateId,
      familyId: candidateSpecification.familyId.trim(),
      lineageId: candidateSpecification.lineageId.trim(),
      specificationHash: String(specificationBinding.specificationHash).trim().toLowerCase(),
      codeSha: candidateSpecification.codeSha.trim().toLowerCase(),
      costModelVersion: candidateSpecification.costModelVersion.trim(),
      parameters: Object.freeze({ ...candidateSpecification.parameters }),
    }),
    researchDecisionReference,
    researchLineage,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
  return Object.freeze({
    schemaVersion: 1,
    status: "DEPLOYABLE",
    reasons: Object.freeze(["SINGLE_CANONICAL_LEAGUE_ALLOCATION"]),
    artifact,
    authority: "PAPER_RESEARCH_ONLY",
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
}

function executeRequest(requestValue, env = process.env, dependencies = defaultDependencies()) {
  const request = validateRequest(requestValue);
  const store = new dependencies.FileResearchRunReplaySnapshotStore(snapshotPathFromEnv(env));
  const snapshot = store.read(request.originalRunFingerprintSha256);
  if (snapshot == null) throw new Error("closed-learning worker original Research snapshot is unavailable");
  const replay = dependencies.replayResearchRunWithPaperEvidence(snapshot, request.paperEvidenceByCandidate);
  if (replay == null || replay.qualification == null || replay.run == null) throw new Error("closed-learning worker replay result is invalid");
  const qualification = replay.qualification;
  if (qualification.liveAuthority !== "NONE" || qualification.productionMutationAllowed !== false || qualification.aiAuthority !== "ZERO_AUTHORITY") {
    throw new Error("closed-learning worker authority invariant violated");
  }
  const deployment = projectPaperDeployment(snapshot, replay, request.originalRunFingerprintSha256);
  return Object.freeze({
    schemaVersion: 1,
    operation: "REPLAY_PAPER_EVIDENCE",
    originalRunFingerprintSha256: request.originalRunFingerprintSha256,
    replayRunFingerprintSha256: replay.run.provenance.runFingerprintSha256,
    qualification,
    deployment,
    liveAuthority: "NONE",
    productionMutationAllowed: false,
    aiAuthority: "ZERO_AUTHORITY",
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; if (Buffer.byteLength(body, "utf8") > 8 * 1024 * 1024) reject(new Error("closed-learning worker request is too large")); });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const body = await readStdin();
  let request;
  try { request = JSON.parse(body); }
  catch { throw new Error("closed-learning worker request is not valid JSON"); }
  process.stdout.write(`${JSON.stringify(executeRequest(request))}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`closed-learning research worker failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { executeRequest, projectPaperDeployment, snapshotPathFromEnv, validateRequest };
