const { readFileSync } = require("node:fs");
const {
  validateArtifactArchiveDigest,
  validateCurrentMainSha,
  validateSourceArtifact,
  validateSourceRun,
} = require("./lib/exact-head-paper-readiness-source.js");

function parseJsonEnvironment(name) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.length === 0) throw new Error(`PAPER_READINESS_SOURCE_REJECTED:${name}_MISSING`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`PAPER_READINESS_SOURCE_REJECTED:${name}_MALFORMED`);
  }
}

function main(argv = process.argv.slice(2), environment = process.env) {
  const [mode] = argv;
  if (mode === "run") {
    const verified = validateSourceRun(parseJsonEnvironment("SOURCE_RUN_JSON"), {
      sourceRunId: environment.EXPECTED_SOURCE_RUN_ID,
      sourceRunAttempt: environment.EXPECTED_SOURCE_RUN_ATTEMPT,
      targetSha: environment.EXPECTED_TARGET_SHA,
      currentMainSha: environment.EXPECTED_CURRENT_MAIN_SHA,
      repository: environment.EXPECTED_REPOSITORY,
      requireTokenDispatch: environment.REQUIRE_TOKEN_DISPATCH === "true",
    });
    process.stdout.write(`SOURCE_RUN_VERIFIED run=${verified.runId} attempt=${verified.runAttempt} sha=${verified.headSha}\n`);
    return verified;
  }

  if (mode === "current-main") {
    const verified = validateCurrentMainSha(environment.EXPECTED_TARGET_SHA, environment.EXPECTED_CURRENT_MAIN_SHA);
    process.stdout.write(`CURRENT_MAIN_VERIFIED sha=${verified.currentMainSha}\n`);
    return verified;
  }

  if (mode === "artifact") {
    const verified = validateSourceArtifact(parseJsonEnvironment("SOURCE_ARTIFACT_JSON"), {
      sourceRunId: environment.EXPECTED_SOURCE_RUN_ID,
      repositoryId: environment.EXPECTED_REPOSITORY_ID,
      targetSha: environment.EXPECTED_TARGET_SHA,
      artifactName: environment.EXPECTED_ARTIFACT_NAME,
    });
    process.stdout.write(`SOURCE_ARTIFACT_VERIFIED artifact=${verified.artifactId} run=${environment.EXPECTED_SOURCE_RUN_ID}\n`);
    return verified;
  }

  if (mode === "artifact-archive") {
    const [, archivePath, expectedDigest] = argv;
    if (!archivePath || !expectedDigest) throw new Error("usage: node scripts/validate-exact-head-paper-readiness-source.js artifact-archive <zip-path> <sha256-digest>");
    const digest = validateArtifactArchiveDigest(readFileSync(archivePath), expectedDigest);
    process.stdout.write(`SOURCE_ARTIFACT_ARCHIVE_VERIFIED digest=${digest}\n`);
    return digest;
  }

  throw new Error("usage: node scripts/validate-exact-head-paper-readiness-source.js <run|current-main|artifact|artifact-archive>");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "PAPER_READINESS_SOURCE_REJECTED:UNKNOWN"}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
