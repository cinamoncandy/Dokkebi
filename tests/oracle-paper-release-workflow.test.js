const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const workflow = fs.readFileSync(".github/workflows/oracle-paper-release.yml", "utf8");
const wrapper = fs.readFileSync("deploy/oracle/nusa-release-step.sh", "utf8").replaceAll("\r\n", "\n");
const runbook = fs.readFileSync("docs/operations/oracle-p1-008-runbook.md", "utf8");
const readiness = fs.readFileSync("scripts/oracle-readiness-check.js", "utf8");

/**
 * The Oracle PAPER host drifted behind protected main with nothing able to correct it (#1816).
 * Every step already existed as a script; what was missing was anything that ran them in the
 * runbook's order.
 *
 * The privileged work is routed through a single wrapper so sudoers grants one command instead of
 * eleven, two of which were wildcards: `tar *` can write any path on the host, and
 * `rm -rf /opt/nusa/releases/*` expanded a variable the caller controlled. These assertions cover
 * both halves -- the workflow calls the verbs in order, and the wrapper enforces what each verb is
 * allowed to do.
 */

const orderIn = (text, needles) => {
  const positions = needles.map((needle) => {
    const index = text.indexOf(needle);
    assert.ok(index > 0, `expected to find ${needle}`);
    return index;
  });
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `${needles[i]} must come after ${needles[i - 1]}`);
  }
};

test("the release refuses a source that is not exact protected main", () => {
  assert.match(workflow, /Refusing stale Oracle release/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /branches\/main/);
});

test("the release requires successful exact-source CI, found by a paginated lookup", () => {
  assert.match(workflow, /has no successful canonical CI run/);
  assert.match(workflow, /--paginate/, "a first-page lookup ages out and must not be used");
  assert.match(workflow, /actions\/workflows\/ci\.yml\/runs/);
});

test("the small PAPER host receives a sealed build instead of installing or building dependencies", () => {
  const prepare = workflow.slice(workflow.indexOf("  prepare:"), workflow.indexOf("  backup:"));
  const hostJobs = workflow.slice(workflow.indexOf("  backup:"));
  assert.match(prepare, /runs-on: ubuntu-latest/);
  assert.match(prepare, /pnpm install --frozen-lockfile/);
  assert.match(prepare, /pnpm run build/);
  assert.match(hostJobs, /runs-on: \[self-hosted, Linux, nusa-paper-host\]/);
  assert.match(hostJobs, /sha256sum --check --status/);
  assert.ok(hostJobs.indexOf("sha256sum --check --status") < hostJobs.indexOf('"$STEP" backup'));
  assert.doesNotMatch(hostJobs, /pnpm install|pnpm run build/);
});

test("the host drops only the verified temporary archive after extraction", () => {
  const unpackStart = workflow.indexOf("Verify and unpack the exact built release");
  const unpackEnd = workflow.indexOf("Require reviewed host release helper exact match", unpackStart);
  const unpack = workflow.slice(unpackStart, unpackEnd);
  orderIn(unpack, ["sha256sum --check --status", 'tar -xzf "$RUNNER_TEMP/nusa-release.tar.gz"', 'rm -- "$RUNNER_TEMP/nusa-release.tar.gz"']);
});

test("the host privileged helper must exactly match reviewed source before the isolated backup", () => {
  const backupJob = workflow.slice(workflow.indexOf("  backup:"), workflow.indexOf("  release:"));
  const helperGate = backupJob.indexOf("Require reviewed root-owned helper exact match before backup");
  const backup = backupJob.indexOf("Back up persistent state before release mutation");
  assert.ok(helperGate > 0 && helperGate < backup, "helper drift must fail before backup starts");
  assert.match(backupJob, /cmp --silent "\$STEP" "\$HELPER_PROOF"/);
  orderIn(backupJob, ["sha256sum --check --status", 'cmp --silent "$STEP" "$HELPER_PROOF"', 'sudo "$STEP" backup']);
  assert.match(backupJob, /Install the exact reviewed root-owned helper before backup\/release/);
});

test("the privileged backup resolves both paths inside the reviewed root-owned helper and fails closed on unsupported topology", () => {
  const backupStart = wrapper.indexOf("  backup)");
  const backupEnd = wrapper.indexOf("\n\n  preflight)", backupStart);
  const backup = wrapper.slice(backupStart, backupEnd);
  const resolver = wrapper.slice(wrapper.indexOf("backup_device_is_block()"), wrapper.indexOf("unit_in()"));
  assert.ok(backup.length > 0 && resolver.length > 0);
  assert.match(backup, /NUSA_CLOUD_STATE_DB_PATH/);
  assert.match(backup, /NUSA_BACKUP_DIR/);
  assert.match(backup, /backup_block_device_for_paths "\$state_db" "\$backup_dir"/);
  assert.doesNotMatch(backup, /oracle-backup-device\.js/, "root backup must not execute a release-owned topology resolver");
  assert.match(resolver, /ext4 \|\| "\$state_fstype" == xfs/, "bounded backup supports only explicitly reviewed local filesystems");
  assert.match(resolver, /different backing disks/);
  assert.match(resolver, /backup_device_is_direct_disk_name/, "direct-disk names have a stricter device-path predicate");
  assert.match(backup, /IOReadBandwidthMax=\$\{backup_device\} 1048576/);
  assert.match(backup, /IOWriteBandwidthMax=\$\{backup_device\} 1048576/);
  assert.ok(backup.indexOf("backup_block_device_for_paths") < backup.indexOf("systemd-run"), "topology validation must finish before the backup process starts");
  assert.match(backup, /systemd-run --quiet --collect --scope/);
  assert.match(backup, /nice -n 19 runuser -u "\$SERVICE_USER"/);
  assert.match(backup, /env NUSA_DB="\$state_db" NUSA_BACKUP_DIR="\$backup_dir"/);
});

test("the calculated long backup budget is isolated from the short activation job", () => {
  const backupJob = workflow.slice(workflow.indexOf("  backup:"), workflow.indexOf("  release:"));
  const releaseJob = workflow.slice(workflow.indexOf("  release:"));
  const databaseMiB = 957;
  const observedMiBPerSecond = 0.8;
  const fullFilePhases = 6;
  const backupSafetyMargin = 0.30;
  const roundUpToMinutes = 30;
  const rawBackupMinutes = (databaseMiB * fullFilePhases) / observedMiBPerSecond / 60;
  const requiredBackupMinutes = rawBackupMinutes * (1 + backupSafetyMargin);
  const budgetedBackupMinutes = Math.ceil(requiredBackupMinutes / roundUpToMinutes) * roundUpToMinutes;
  const backupStep = backupJob.slice(backupJob.indexOf("Back up persistent state before release mutation"));
  const backupStepTimeout = Number(backupStep.match(/timeout-minutes:\s*(\d+)/)?.[1]);
  const releaseTimeout = Number(releaseJob.match(/timeout-minutes:\s*(\d+)/)?.[1]);

  assert.equal(Math.round(rawBackupMinutes * 10) / 10, 119.6);
  assert.equal(Math.round(requiredBackupMinutes * 10) / 10, 155.5);
  assert.equal(budgetedBackupMinutes, 180);
  assert.equal(backupStepTimeout, budgetedBackupMinutes, "backup-only timeout must be derived from the recorded production envelope");
  assert.ok(backupStepTimeout - requiredBackupMinutes >= 20, "calculated backup envelope needs at least twenty minutes of explicit margin");
  assert.equal(releaseTimeout, 40, "stage/preflight/activation keeps its independent short host-job budget");
  assert.match(readiness, /NUSA_READY_STARTUP_WAIT_MS \|\| 300_000/);
  assert.match(readiness, /startupWaitMs > 300_000/);
  assert.match(wrapper, /POST_ACTIVATION_SOAK_SECONDS=180/);
});

test("the workflow runs the release verbs in the runbook's order", () => {
  // Staging precedes preflight because the runbook runs both checks from the exact release tree.
  // Activation owns switch + unit convergence + readiness + rollback as one fail-closed boundary.
  orderIn(workflow, ['"$STEP" backup', '"$STEP" stage', '"$STEP" preflight', '"$STEP" activate']);
  assert.doesNotMatch(workflow, /"\$STEP"\s+(switch|restart|readiness|rollback)\b/, "activation must not be split across workflow steps");
});

test("a release that cannot prove either runtime ready is rolled back, not left serving", () => {
  const activateStart = wrapper.indexOf("  activate)");
  const activateEnd = wrapper.indexOf("\n  rollback)", activateStart);
  const activateCase = wrapper.slice(activateStart, activateEnd);
  assert.ok(activateCase.length > 0, "activate must be an explicit wrapper case");
  orderIn(activateCase, ["atomic-deploy.js", "bind_runtime_source_identity", "install_units_from_release", "enable_units", "restart_units", "oracle-readiness-check.js", "autopilot-readiness.js"]);
  assert.match(activateCase, /rollback_and_restore/, "activation failure must restore the previous release and unit set");
  assert.match(activateCase, /systemctl is-active --quiet "\$SERVICE"/);
  assert.match(activateCase, /systemctl is-active --quiet "\$AUTOPILOT_SERVICE"/);

  const rollbackHelper = wrapper.slice(wrapper.indexOf("rollback_and_restore()"), wrapper.indexOf("\n}\n", wrapper.indexOf("rollback_and_restore()")) + 2);
  orderIn(rollbackHelper, ["rollback_legacy_ok=true", "nusa-autopilot.service", "NUSA_DEPLOY_ACTION=rollback", "bind_runtime_source_identity", "install_units_from_release", "enable_units", "restart_units"]);
  assert.match(rollbackHelper, /rollback_legacy_ok=false/, "a modern rollback release must restart its own Autopilot runtime");
  assert.match(rollbackHelper, /restart_units "\$rollback_legacy_ok"/, "rollback restart policy must follow the rollback release capability");
  assert.doesNotMatch(rollbackHelper, /restart_units true/, "modern rollback must not unconditionally leave the candidate Autopilot running");
  assert.doesNotMatch(wrapper, /scripts\/[a-z0-9-]*restore[a-z0-9-]*\.js/i);
  assert.doesNotMatch(rollbackHelper, /rm\s+-rf\s+\/var\/lib\/nusa|DROP\s+TABLE/i, "the failure path must not touch persistent state");
});

test("writer lease recovery is diagnosis-scoped, fail-closed, and bounded to one retry", () => {
  const recoverStart = wrapper.indexOf("recover_abandoned_writer_lease_once()");
  const recoverEnd = wrapper.indexOf("\n}\n", recoverStart) + 2;
  const recover = wrapper.slice(recoverStart, recoverEnd);
  assert.ok(recover.length > 0);
  assert.match(recover, /journalctl -u "\$SERVICE" --since "\$since"/, "old journal evidence must not authorize recovery");
  assert.match(recover, /PAPER_WRITER_CLOCK_ANOMALY/);
  assert.match(recover, /reset-paper-writer-lease\.js/);
  assert.match(recover, /runuser -u "\$SERVICE_USER"/, "lease reset must not run as root");
  orderIn(recover, ["reset-paper-writer-lease.js", "restart_units", "oracle-readiness-check.js"]);

  const activateStart = wrapper.indexOf("  activate)");
  const activateEnd = wrapper.indexOf("\n  rollback)", activateStart);
  const activate = wrapper.slice(activateStart, activateEnd);
  assert.equal((activate.match(/recover_abandoned_writer_lease_once/g) ?? []).length, 1, "activation gets exactly one recovery attempt");
  assert.match(activate, /activation_started=.*date --iso-8601=seconds/);
  assert.match(activate, /paper_ready=false/);
  assert.match(activate, /rollback_and_restore/, "failed recovery must retain the existing rollback boundary");
  assert.doesNotMatch(recover, /DELETE|DROP|UPDATE|INSERT|\/var\/lib\/nusa/, "the privileged wrapper must delegate persistent-state safety to the canonical reset script");
});

test("activation owns a bounded post-readiness stability soak and disk guard", () => {
  assert.match(wrapper, /readonly ROOT_DISK_GUARD_PERCENT=92/);
  assert.match(wrapper, /readonly ROOT_DISK_STAGE_MARGIN_BYTES=536870912/);
  assert.match(wrapper, /readonly POST_ACTIVATION_SOAK_SECONDS=180/);
  assert.match(wrapper, /readonly POST_ACTIVATION_CHECK_INTERVAL_SECONDS=10/);
  assert.match(wrapper, /readonly POST_ACTIVATION_ROUTE_PROOF_WINDOW_MS=30000/);
  assert.match(wrapper, /readonly POST_ACTIVATION_READY_WINDOW_MS=30000/);
  assert.match(wrapper, /readonly POST_ACTIVATION_READY_TIMEOUT_MS=2000/);
  assert.match(wrapper, /readonly POST_ACTIVATION_READY_RETRY_DELAY_MS=500/);
  assert.match(runbook, /Initial authenticated `\/ready` keeps the 300-second cold-start budget, with each request capped at 5 seconds and 1-second retry delay\./);
  assert.match(runbook, /initial activation uses each route request cap of 5 seconds and a 1-second retry delay\./);
  assert.match(runbook, /During soak, authenticated `\/ready` uses a bounded 30-second retry window, with each request capped at 2 seconds and 500 ms retry delay/);
  assert.match(runbook, /post-activation checks, with route requests capped at 2 seconds and a 500 ms retry delay/);

  const routeProofWindow = Number(wrapper.match(/readonly POST_ACTIVATION_ROUTE_PROOF_WINDOW_MS=(\d+)/)?.[1]);
  const readyWindow = Number(wrapper.match(/readonly POST_ACTIVATION_READY_WINDOW_MS=(\d+)/)?.[1]);
  const requestTimeout = Number(wrapper.match(/readonly POST_ACTIVATION_READY_TIMEOUT_MS=(\d+)/)?.[1]);
  const retryDelay = Number(wrapper.match(/readonly POST_ACTIVATION_READY_RETRY_DELAY_MS=(\d+)/)?.[1]);
  const twoAttemptsAcrossBothOwnerRoutes = 2 * ((2 * requestTimeout) + retryDelay);
  assert.equal(readyWindow, 30_000, "post-activation /ready retries must survive the observed startup stall class without using the long cold-start budget");
  assert.ok(readyWindow < 180_000, "post-activation /ready proof remains bounded inside the 180s soak");
  assert.ok(
    routeProofWindow >= twoAttemptsAcrossBothOwnerRoutes,
    "route proof must let both owner routes each survive one transient timeout without weakening /ready failure speed",
  );

  const diskStart = wrapper.indexOf("assert_root_disk_headroom()");
  const diskEnd = wrapper.indexOf("\n}\n", diskStart) + 2;
  const disk = wrapper.slice(diskStart, diskEnd);
  assert.match(disk, /df -P \/|ROOT_DISK_GUARD_PERCENT/);

  const stageGateStart = wrapper.indexOf("assert_stage_disk_headroom()");
  const stageGateEnd = wrapper.indexOf("\n}\n", stageGateStart) + 2;
  const stageGate = wrapper.slice(stageGateStart, stageGateEnd);
  assert.match(stageGate, /du -sb/);
  assert.match(stageGate, /stat -c '%d'/);
  assert.match(stageGate, /source_device.*release_device/);
  assert.match(stageGate, /ROOT_DISK_STAGE_MARGIN_BYTES/);
  assert.match(stageGate, /ROOT_DISK_GUARD_PERCENT/);

  const stageCaseStart = wrapper.indexOf("  stage)");
  const stageCaseEnd = wrapper.indexOf("\n\n  switch)", stageCaseStart);
  assert.match(wrapper.slice(stageCaseStart, stageCaseEnd), /assert_stage_disk_headroom "\$source_tree"/);
  const stageCase = wrapper.slice(stageCaseStart, stageCaseEnd);
  assert.match(stageCase, /mv --no-copy -T -- "\$source_tree" "\$dir"/);
  assert.match(stageCase, /assert_stage_disk_headroom "\$source_tree" true/);
  assert.match(stageCase, /tar -cf - .*tar -xf -/s);
  orderIn(stageCase, ['mv --no-copy -T -- "$source_tree" "$dir"', 'assert_stage_disk_headroom "$source_tree" true', 'tar -cf - --exclude=.git -C "$source_tree" .']);

  const preflightStart = wrapper.indexOf("  preflight)");
  const preflightEnd = wrapper.indexOf("\n\n  install-units)", preflightStart);
  assert.match(wrapper.slice(preflightStart, preflightEnd), /assert_root_disk_headroom/);

  const soakStart = wrapper.indexOf("prove_post_activation_stability()");
  const soakEnd = wrapper.indexOf("\n}\n", soakStart) + 2;
  const soak = wrapper.slice(soakStart, soakEnd);
  assert.ok(soak.length > 0);
  assert.match(soak, /active_release_sha/);
  assert.match(soak, /oracle-readiness-check\.js/);
  assert.match(soak, /autopilot-readiness\.js/);
  assert.match(soak, /sleep "\$POST_ACTIVATION_CHECK_INTERVAL_SECONDS"/);
  assert.match(soak, /NUSA_READY_STARTUP_WAIT_MS="\$POST_ACTIVATION_READY_WINDOW_MS"/);
  assert.match(soak, /NUSA_READY_ROUTE_PROOF_WAIT_MS="\$POST_ACTIVATION_ROUTE_PROOF_WINDOW_MS"/);
  assert.match(wrapper, /POST_ACTIVATION_ROUTE_PROOF_WINDOW_MS=30000/);
  assert.match(soak, /NUSA_READY_TIMEOUT_MS="\$POST_ACTIVATION_READY_TIMEOUT_MS"/);
  assert.match(soak, /NUSA_READY_RETRY_DELAY_MS="\$POST_ACTIVATION_READY_RETRY_DELAY_MS"/);

  const activateStart = wrapper.indexOf("  activate)");
  const activateEnd = wrapper.indexOf("\n  readiness)", activateStart);
  const activate = wrapper.slice(activateStart, activateEnd);
  orderIn(activate, ["oracle-readiness-check.js", "autopilot-readiness.js", "prove_post_activation_stability", "activation accepted"]);
  assert.match(activate, /stability_ready=false/);
  assert.match(activate, /rollback_and_restore/, "failed soak must stay inside the activation rollback boundary");

  assert.doesNotMatch(workflow.slice(workflow.indexOf("  release:")), /rm -rf|find .* -delete/, "workflow deletion remains forbidden; disk admission belongs to the bounded helper");
});

test("every privileged action goes through the one wrapper command", () => {
  const sudoCalls = workflow.match(/sudo\s+\S+/g) ?? [];
  assert.ok(sudoCalls.length > 0);
  for (const call of sudoCalls) {
    assert.match(call, /sudo\s+"\$STEP"/, `sudoers must grant one command only, found: ${call}`);
  }
  assert.match(workflow, /STEP: \/opt\/nusa\/bin\/nusa-release-step/);
});

test("activation and rollback atomically bind runtime source identity to the selected release", () => {
  const bindStart = wrapper.indexOf("bind_runtime_source_identity()");
  const bindEnd = wrapper.indexOf("\n}\n", bindStart) + 2;
  const bind = wrapper.slice(bindStart, bindEnd);
  assert.ok(bind.length > 0);
  assert.match(bind, /NUSA_SOURCE_COMMIT=/);
  assert.match(bind, /NUSA_SOURCE_COMMIT_SHA=/);
  assert.match(bind, /chmod --reference/);
  assert.match(bind, /chown --reference/);
  assert.match(bind, /mv -f -- "\$tmp" "\$RUNTIME_ENV"/);
  assert.doesNotMatch(bind, /cat\s+"?\$RUNTIME_ENV"?/, "release must never print the secret-bearing runtime environment");

  const activateStart = wrapper.indexOf("  activate)");
  const activateEnd = wrapper.indexOf("\n  rollback)", activateStart);
  const activate = wrapper.slice(activateStart, activateEnd);
  orderIn(activate, ["atomic-deploy.js", "bind_runtime_source_identity", "restart_units"]);

  const rollbackStart = wrapper.indexOf("rollback_and_restore()");
  const rollbackEnd = wrapper.indexOf("\n}\n", rollbackStart) + 2;
  const rollback = wrapper.slice(rollbackStart, rollbackEnd);
  orderIn(rollback, ["NUSA_DEPLOY_ACTION=rollback", "bind_runtime_source_identity", "restart_units"]);
  assert.match(rollback, /active_release_sha/);
});

test("the wrapper lives outside the release tree it installs", () => {
  assert.match(workflow, /STEP: \/opt\/nusa\/bin\//, "a release must not be able to rewrite the root helper");
  assert.doesNotMatch(workflow, /STEP: \/opt\/nusa\/(current|releases)/);
});

test("the wrapper validates the SHA and confines privileged staging to the runner temp", () => {
  assert.match(wrapper, /\^\[0-9a-f\]\{40\}\$/, "the SHA is validated in the wrapper, not trusted from the caller");
  assert.match(wrapper, /release_dir\(\)/, "paths are rebuilt from the validated SHA");
  assert.match(wrapper, /RUNNER_TEMP_ROOT=\/opt\/actions-runner-nusa-paper\/_work\/_temp/);
  assert.match(wrapper, /nusa-release-tree-\[0-9\]\+/);
  assert.match(wrapper, /\[ -d "\$source_tree" \]/);
  assert.match(wrapper, /set -euo pipefail/);
});

test("the wrapper refuses an unknown verb instead of doing something else", () => {
  assert.match(wrapper, /unknown verb/);
  for (const verb of ["backup", "preflight", "install-units", "prune", "stage", "switch", "activate", "rollback", "restart", "readiness"]) {
    assert.match(wrapper, new RegExp(`^\\s*${verb}\\)`, "m"), `${verb} must be an explicit case`);
  }
});

test("the wrapper never restages the active release", () => {
  assert.match(wrapper, /refusing to restage the active release/);
});

test("bounded release pruning preserves rollback safety and validates before deletion", () => {
  const pruneStart = wrapper.indexOf("prune_releases()");
  const pruneEnd = wrapper.indexOf("\n}\n", pruneStart) + 2;
  const prune = wrapper.slice(pruneStart, pruneEnd);
  assert.match(prune, /active_release/);
  assert.match(prune, /previous_release/);
  assert.match(wrapper, /readonly RELEASE_RETENTION=0/);
  assert.match(prune, /Validate the entire candidate set before deleting anything/);
  assert.ok(prune.indexOf("unexpected release directory name") < prune.indexOf("rm -rf --"), "validation must dominate deletion");
  assert.match(prune, /\[ "\$dir" = "\$active" \] && continue/);
  assert.match(prune, /\[ -n "\$previous" \] && \[ "\$dir" = "\$previous" \] && continue/);
  assert.doesNotMatch(prune, /\/var\/lib\/nusa|\/var\/backups\/nusa/);
});

test("the wrapper runs the exact-release validation and activation scripts", () => {
  for (const script of ["sqlite-backup.js", "host-security-validate.js", "oracle-validate.js", "atomic-deploy.js", "oracle-readiness-check.js", "autopilot-readiness.js"]) {
    assert.ok(wrapper.includes(script), `${script} must be run by the wrapper`);
    assert.ok(fs.existsSync(`scripts/${script}`), `scripts/${script} must exist`);
  }
  for (const documented of ["sqlite-backup.js", "host-security-validate.js", "oracle-validate.js", "oracle-readiness-check.js", "autopilot-readiness.js"]) {
    assert.ok(runbook.includes(documented), `${documented} must remain documented for operators`);
  }
  assert.match(runbook, /nusa-release-step activate/, "the runbook must document the atomic activation boundary");
  assert.match(wrapper, /script_in\(\)/, "scripts are read from the release being deployed");
});

test("the release is dispatch-only and holds no repository write authority", () => {
  const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("permissions:"));
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /\bpush:/, "a production host writer must not run on every merge");
  assert.doesNotMatch(on, /schedule:/);
  assert.doesNotMatch(on, /pull_request/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.match(workflow, /nusa-paper-host/);
  assert.doesNotMatch(workflow, /nusa-codex-dev/, "the development runner's contract forbids deploying");
});

test("the deployed identity and fail-closed authority are always recorded", () => {
  assert.match(workflow, /currentRelease=/);
  // A superseded source skips every host step yet the run stays green; the receipt must say so.
  for (const result of ["SKIPPED_MAIN_MOVED", "FAILED", "DEPLOYED", "FAILED_ACTIVATION_IDENTITY"]) assert.match(workflow, new RegExp(`RESULT=${result}\\b`));
  assert.match(workflow, /SOURCE_FRESH: \$\{\{ steps\.source_fresh\.outputs\.fresh \}\}/);
  assert.match(workflow, /if \[ "\$SOURCE_FRESH" != "true" \]; then\r?\n\s+RESULT=SKIPPED_MAIN_MOVED/);
  assert.match(workflow, /\[ "\$\(basename "\$CURRENT_RELEASE"\)" = "\$SOURCE_SHA" \]/, "DEPLOYED only when current resolves to the requested source");
  assert.match(workflow, /deploymentResult=\$RESULT/);
  assert.match(workflow, />> "\$GITHUB_STEP_SUMMARY"/);
  assert.match(workflow, /liveAuthority=NONE/);
  assert.match(workflow, /productionMutationAllowed=false/);
  assert.match(workflow, /aiAuthority=ZERO_AUTHORITY/);
});


test("the privileged helper declares helper locals before expanding them under nounset", () => {
  const scriptIn = wrapper.slice(wrapper.indexOf("script_in()"), wrapper.indexOf("\n}\n", wrapper.indexOf("script_in()")) + 2);
  const unitIn = wrapper.slice(wrapper.indexOf("unit_in()"), wrapper.indexOf("\n}\n", wrapper.indexOf("unit_in()")) + 2);

  for (const helper of [scriptIn, unitIn]) {
    assert.match(helper, /local dir="\$1"\n\s*local name="\$2"\n\s*local path=/);
    assert.doesNotMatch(helper, /local dir="\$1" name="\$2" path=/);
  }
});


test("rollback restores a legacy release that predates the Autopilot systemd unit", () => {
  const rollbackStart = wrapper.indexOf("rollback_and_restore()");
  const rollbackEnd = wrapper.indexOf("\n}\n", rollbackStart) + 2;
  const rollback = wrapper.slice(rollbackStart, rollbackEnd);
  assert.match(rollback, /rollback_legacy_ok=true/);
  assert.match(rollback, /\[ -f "\$\{rollback_release\}\/deploy\/oracle\/nusa-autopilot\.service" \] && rollback_legacy_ok=false/);
  assert.match(rollback, /install_units_from_release "\$\(active_release\)" "\$rollback_legacy_ok"/);
  assert.match(rollback, /enable_units "\$rollback_legacy_ok"/);
  assert.match(rollback, /restart_units "\$rollback_legacy_ok"/);

  const installStart = wrapper.indexOf("install_units_from_release()");
  const installEnd = wrapper.indexOf("\n}\n", installStart) + 2;
  const installUnits = wrapper.slice(installStart, installEnd);
  assert.match(installUnits, /if \[ -f "\$\{dir\}\/deploy\/oracle\/nusa-autopilot\.service" \]/);
  assert.match(installUnits, /systemctl disable --now "\$\{AUTOPILOT_SERVICE\}"/);
  assert.match(installUnits, /rm -f -- "\$\{SYSTEMD_UNIT_DIR\}\/\$\{AUTOPILOT_SERVICE\}"/);
  assert.match(installUnits, /die "missing nusa-autopilot\.service/, "forward activation must still fail closed when the unit is missing");
});

test("superseded releases are pruned before helper proof download so a full disk cannot fail the backup", () => {
  const backupJob = workflow.slice(workflow.indexOf("  backup:"), workflow.indexOf("  release:"));
  const recheck = backupJob.indexOf("Recheck exact protected main before backup");
  const prune = backupJob.indexOf('sudo "$STEP" prune');
  const download = backupJob.indexOf("Download exact-source helper proof");
  const backup = backupJob.indexOf('"$STEP" backup');
  assert.ok(prune > recheck && prune < download, "prune must run after the main recheck and before the backup artifact download");
  assert.ok(prune < backup, "prune must free space before the backup");
  assert.equal(workflow.split('"$STEP" prune').length - 1, 1, "prune is invoked exactly once");
  assert.doesNotMatch(workflow, /rm -rf|find .* -delete/, "the workflow itself never deletes; only the bounded helper does");
});

test("the sealed release ships dist and scripts without the workspace node_modules, plus only the ws runtime package", () => {
  const sealStart = workflow.indexOf("      - name: Seal the built release");
  const sealEnd = workflow.indexOf("      - name: Upload built release", sealStart);
  assert.ok(sealStart > 0 && sealEnd > sealStart);
  const seal = workflow.slice(sealStart, sealEnd);
  orderIn(seal, [
    'tar -cf - --exclude=.git --exclude=node_modules . | tar -xf - -C "$STAGE"',
    'cp -RL node_modules/ws "$STAGE/node_modules/ws"',
    'require("./dist/apps/cloud/src/closedLearningProductionRuntime.js")',
    'tar -czf "$RUNNER_TEMP/nusa-release.tar.gz" -C "$STAGE" .',
    "157286400",
    'echo "sha=',
  ]);
  assert.doesNotMatch(seal, /tar -czf "\$RUNNER_TEMP\/nusa-release\.tar\.gz" --exclude=\.git \./, "the old whole-workspace seal must not return");
});

test("the host runtime needs no package besides ws: nothing the host units and release helper can reach imports another bare package", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  // Entry points of every systemd unit and release-helper verb (deploy/oracle/*.service, nusa-release-step.sh), plus the scripts the research snapshot spawns.
  const entries = [
    "scripts/start-cloud-runtime.js", "scripts/autopilot-runtime.js", "scripts/run-cloud-research-snapshot.js", "scripts/atomic-deploy.js",
    "scripts/oracle-validate.js", "scripts/oracle-readiness-check.js", "scripts/autopilot-readiness.js", "scripts/host-security-validate.js",
    "scripts/reset-paper-writer-lease.js", "scripts/sqlite-backup.js", "services/nusa-mcp/server.js", "services/upbit-readonly/server.js",
    "dist/packages/storage/src/sqliteIntegrityBootstrap.js", "dist/apps/cloud/src/runtime.js", "dist/apps/cloud/src/closedLearningProductionRuntime.js",
  ];
  const sealed = new Set(["ws"]);
  const seen = new Set();
  const bare = new Map();
  const resolveRelative = (from, spec) => {
    const base = path.resolve(path.dirname(from), spec);
    for (const candidate of [base, `${base}.js`, `${base}.cjs`, path.join(base, "index.js")]) if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    return null;
  };
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)|\b(?:import|export)\b[^"'`;]*?\bfrom\s+["']([^"']+)["']|\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec.startsWith(".")) { const next = resolveRelative(file, spec); if (next != null) walk(next); continue; }
      if (spec.startsWith("node:")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!sealed.has(name)) bare.set(name, path.relative(".", file));
    }
  };
  if (!fs.existsSync("dist")) return;
  for (const entry of entries) { assert.ok(fs.existsSync(entry), `host entry point missing: ${entry}`); walk(path.resolve(entry)); }
  assert.ok(seen.size > 100, `the host import graph should be large (saw ${seen.size} files); the walk is broken`);
  assert.deepEqual([...bare.entries()], [], "a host-reachable file imports a package the sealed release does not ship; add it to the seal in oracle-paper-release.yml");
});
