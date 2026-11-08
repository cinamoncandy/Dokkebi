#!/usr/bin/env bash
# Single privileged entry point for the Oracle PAPER release.
#
# Without this the release needs eleven sudoers entries, two of them wildcards -- `tar *` and
# `rm -rf /opt/nusa/releases/*`. A wildcard in sudoers grants far more than the step needs: `tar`
# alone can write any path on the host, and the rm pattern depends on a shell variable the caller
# controls. Routing every privileged action through one verb lets sudoers grant exactly one
# command, and moves argument validation to where it can actually be enforced.
#
# This script is installed once at a fixed path OUTSIDE the release tree. That is deliberate: a
# privileged helper must not be replaceable by the releases it installs, or deploying a commit
# would be enough to rewrite the thing that runs as root.
#
# It grants no LIVE authority. It moves a symlink and restarts a PAPER_ONLY service.

set -euo pipefail

readonly DEPLOY_ROOT=/opt/nusa
readonly RELEASES="${DEPLOY_ROOT}/releases"
readonly RUNNER_TEMP_ROOT=/opt/actions-runner-nusa-paper/_work/_temp
readonly SERVICE=nusa.service
readonly RESEARCH_SERVICE=nusa-research.service
readonly RESEARCH_TIMER=nusa-research.timer
readonly AUTOPILOT_SERVICE=nusa-autopilot.service
readonly SERVICE_USER=nusa
readonly ACTIVATION_LOCK_DIR=/run/nusa-paper-activation
readonly ACTIVATION_LOCK_FILE="${ACTIVATION_LOCK_DIR}/activation.lock"
readonly SYSTEMD_UNIT_DIR=/etc/systemd/system
readonly RUNTIME_ENV=/etc/nusa/cloud-runtime.env
readonly PREVIOUS_RELEASE_FILE="${DEPLOY_ROOT}/.previous-release"
readonly RELEASE_RETENTION=0
readonly ROOT_DISK_GUARD_PERCENT=92
readonly ROOT_DISK_STAGE_MARGIN_BYTES=536870912
readonly POST_ACTIVATION_SOAK_SECONDS=180
readonly POST_ACTIVATION_CHECK_INTERVAL_SECONDS=10
readonly POST_ACTIVATION_ROUTE_PROOF_WINDOW_MS=30000
readonly POST_ACTIVATION_READY_WINDOW_MS=30000
readonly POST_ACTIVATION_READY_TIMEOUT_MS=2000
readonly POST_ACTIVATION_READY_RETRY_DELAY_MS=500

die() { printf '%s\n' "nusa-release-step: $*" >&2; exit 1; }

# Serialize every canonical operation that can change the active release or PAPER service.
# flock is released by the kernel when this process exits, including abnormal termination.
acquire_paper_activation_lock() {
  command -v flock >/dev/null 2>&1 || die "flock is required for safe PAPER activation serialization"
  install -d -o root -g root -m 0700 "$ACTIVATION_LOCK_DIR" || die "cannot create protected PAPER activation lock directory"
  [[ -d "$ACTIVATION_LOCK_DIR" && ! -L "$ACTIVATION_LOCK_DIR" ]] || die "PAPER activation lock directory is not a real directory"
  [[ "$(stat -c '%u:%g:%a' -- "$ACTIVATION_LOCK_DIR")" == "0:0:700" ]] || die "PAPER activation lock directory ownership/mode is unsafe"
  [[ ! -L "$ACTIVATION_LOCK_FILE" ]] || die "PAPER activation lock must not be a symlink"
  umask 077
  exec 9>>"$ACTIVATION_LOCK_FILE" || die "cannot open PAPER activation lock"
  [[ -f "$ACTIVATION_LOCK_FILE" && ! -L "$ACTIVATION_LOCK_FILE" ]] || die "PAPER activation lock is not a regular file"
  [[ "$(stat -c '%u:%g:%a' -- "$ACTIVATION_LOCK_FILE")" == "0:0:600" ]] || die "PAPER activation lock ownership/mode is unsafe"
  flock 9 || die "cannot acquire PAPER activation lock"
}

# The SHA is the only caller-supplied value that reaches a path, so it is validated here rather
# than trusted from the workflow. Anything but a full lowercase commit SHA is refused outright.
validate_sha() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || die "expected a full lowercase commit SHA, refusing"
}

# Every path is rebuilt from the validated SHA. A caller cannot pass a path at all.
release_dir() { printf '%s/%s' "$RELEASES" "$1"; }

active_release() { readlink -f "${DEPLOY_ROOT}/current" 2>/dev/null || true; }

active_release_sha() {
  local release sha
  release="$(active_release)"
  [ -n "$release" ] || die "active release is unavailable"
  sha="${release##*/}"
  validate_sha "$sha"
  printf '%s' "$sha"
}

research_replay_snapshot_path() {
  local snapshot state_db
  # The root-owned runtime env is already the canonical source for these paths. Read only the two
  # path variables and never print secret-bearing environment contents.
  snapshot="$(set -a; source "$RUNTIME_ENV"; set +a; printf '%s' "${NUSA_RESEARCH_REPLAY_SNAPSHOT_PATH:-}")"
  if [ -n "$snapshot" ]; then
    [[ "$snapshot" = /* ]] || die "Research replay snapshot path must be absolute"
    printf '%s' "$snapshot"
    return
  fi
  state_db="$(set -a; source "$RUNTIME_ENV"; set +a; printf '%s' "${NUSA_CLOUD_STATE_DB_PATH:-}")"
  [[ "$state_db" = /* ]] || die "Cloud state path must be absolute before checking Research replay compatibility"
  printf '%s/research-replay-snapshots.json' "$(dirname "$state_db")"
}

segmented_replay_evidence_present() {
  local snapshot directory
  snapshot="$(research_replay_snapshot_path)"
  directory="${snapshot}.segments"
  [ -d "$directory" ] || return 1
  find "$directory" -maxdepth 1 -type f -name '*.json' -print -quit 2>/dev/null | grep -q .
}

assert_segmented_replay_compatible() {
  local dir="${1:-}"
  [ -d "$dir" ] || die "release directory missing while checking segmented Research replay compatibility: $dir"
  segmented_replay_evidence_present || return 0
  local reader="${dir}/apps/desktop/src/cloud/researchRunReplaySnapshotStore.ts"
  [ -f "$reader" ] || die "segmented Research evidence exists but candidate release has no replay reader"
  grep -q 'SEGMENTED_PERSISTENCE_REQUIRES_NEW_READER' "$reader" \
    || die "segmented Research evidence exists; refusing legacy replay reader activation/rollback"
}

# Bind the runtime's self-reported source identity to the exact immutable release.
# The environment file also contains secrets, so rewrite only the two source keys,
# preserve ownership/mode, never print its contents, and replace it atomically.
bind_runtime_source_identity() {
  local sha="${1:-}"
  validate_sha "$sha"
  [ -f "$RUNTIME_ENV" ] || die "runtime environment file missing: $RUNTIME_ENV"
  local tmp="${RUNTIME_ENV}.source-identity.$"
  umask 077
  awk -v sha="$sha" '
    BEGIN { commit_seen=0; commit_sha_seen=0 }
    /^NUSA_SOURCE_COMMIT=/ { print "NUSA_SOURCE_COMMIT=" sha; commit_seen=1; next }
    /^NUSA_SOURCE_COMMIT_SHA=/ { print "NUSA_SOURCE_COMMIT_SHA=" sha; commit_sha_seen=1; next }
    { print }
    END {
      if (!commit_seen) print "NUSA_SOURCE_COMMIT=" sha
      if (!commit_sha_seen) print "NUSA_SOURCE_COMMIT_SHA=" sha
    }
  ' "$RUNTIME_ENV" > "$tmp" || { rm -f -- "$tmp"; die "failed to build runtime source identity"; }
  chmod --reference="$RUNTIME_ENV" "$tmp"
  chown --reference="$RUNTIME_ENV" "$tmp"
  mv -f -- "$tmp" "$RUNTIME_ENV"
}

# Release scripts are read from the staged release itself, so the procedure always matches the
# commit being deployed rather than whatever happened to be installed earlier.
script_in() {
  local dir="$1"
  local name="$2"
  local path="${dir}/scripts/${name}"
  [ -f "$path" ] || die "missing ${name} in ${dir}"
  printf '%s' "$path"
}

# The resolver is part of this root-owned helper so the very first deployment does not depend on
# a resolver script in the old active release. Constrain both source and destination filesystems:
# systemd can cap one block device only, so multi-device/unsupported filesystems and split backup
# storage must fail closed instead of leaving part of the backup I/O unbounded.
backup_device_is_block() {
  [[ "$1" =~ ^/dev/[A-Za-z0-9._/-]+$ && -b "$1" ]]
}

backup_device_is_direct_disk_name() {
  [[ "$1" =~ ^/dev/[A-Za-z0-9._-]+$ && -b "$1" ]]
}

backup_path_is_directory() { [[ -d "$1" ]]; }

backup_block_device_for_paths() {
  local state_db="$1" backup_dir="$2"
  local state_source state_fstype backup_source backup_fstype
  local state_type backup_type state_parent backup_parent state_disk backup_disk
  [[ "$state_db" = /* && "$backup_dir" = /* ]] || { die "backup paths must be absolute"; return 1; }
  backup_path_is_directory "$backup_dir" || { die "backup directory must exist before topology verification"; return 1; }

  state_source="$(findmnt --noheadings --raw --output SOURCE --target "$state_db")" \
    || { die "cannot resolve state database filesystem"; return 1; }
  state_fstype="$(findmnt --noheadings --raw --output FSTYPE --target "$state_db")" \
    || { die "cannot resolve state database filesystem type"; return 1; }
  backup_source="$(findmnt --noheadings --raw --output SOURCE --target "$backup_dir")" \
    || { die "cannot resolve backup directory filesystem"; return 1; }
  backup_fstype="$(findmnt --noheadings --raw --output FSTYPE --target "$backup_dir")" \
    || { die "cannot resolve backup directory filesystem type"; return 1; }
  [[ "$state_fstype" == ext4 || "$state_fstype" == xfs ]] \
    || { die "state database filesystem type is not supported for single-device I/O limiting"; return 1; }
  [[ "$backup_fstype" == ext4 || "$backup_fstype" == xfs ]] \
    || { die "backup directory filesystem type is not supported for single-device I/O limiting"; return 1; }
  backup_device_is_block "$state_source" \
    || { die "state database filesystem source is not a verified local block device"; return 1; }
  backup_device_is_block "$backup_source" \
    || { die "backup directory filesystem source is not a verified local block device"; return 1; }

  state_type="$(lsblk --noheadings --raw --nodeps --output TYPE "$state_source")" \
    || { die "cannot resolve state database block topology"; return 1; }
  backup_type="$(lsblk --noheadings --raw --nodeps --output TYPE "$backup_source")" \
    || { die "cannot resolve backup directory block topology"; return 1; }
  state_parent="$(lsblk --noheadings --raw --output PKNAME "$state_source")" \
    || { die "cannot resolve state database parent disk"; return 1; }
  backup_parent="$(lsblk --noheadings --raw --output PKNAME "$backup_source")" \
    || { die "cannot resolve backup directory parent disk"; return 1; }

  if [[ "$state_type" == disk && -z "$state_parent" ]] && backup_device_is_direct_disk_name "$state_source"; then state_disk="$state_source"
  elif [[ "$state_type" == part && -n "$state_parent" && "$state_parent" != *$'\n'* && "$state_parent" =~ ^[A-Za-z0-9._-]+$ ]]; then state_disk="/dev/$state_parent"
  else die "state database backing topology is ambiguous"; return 1; fi
  if [[ "$backup_type" == disk && -z "$backup_parent" ]] && backup_device_is_direct_disk_name "$backup_source"; then backup_disk="$backup_source"
  elif [[ "$backup_type" == part && -n "$backup_parent" && "$backup_parent" != *$'\n'* && "$backup_parent" =~ ^[A-Za-z0-9._-]+$ ]]; then backup_disk="/dev/$backup_parent"
  else die "backup directory backing topology is ambiguous"; return 1; fi

  backup_device_is_block "$state_disk" \
    && [[ "$(lsblk --noheadings --raw --nodeps --output TYPE "$state_disk")" == disk ]] \
    || { die "state database backing device is not a verified disk"; return 1; }
  backup_device_is_block "$backup_disk" \
    && [[ "$(lsblk --noheadings --raw --nodeps --output TYPE "$backup_disk")" == disk ]] \
    || { die "backup directory backing device is not a verified disk"; return 1; }
  [[ "$state_disk" == "$backup_disk" ]] \
    || { die "backup directory and state database are on different backing disks"; return 1; }
  printf '%s' "$state_disk"
}

unit_in() {
  local dir="$1"
  local name="$2"
  local path="${dir}/deploy/oracle/${name}"
  [ -f "$path" ] || die "missing ${name} in ${dir}"
  printf '%s' "$path"
}

install_units_from_release() {
  local dir="$1"
  local legacy_ok="${2:-false}"
  [ -d "$dir" ] || die "release directory missing: ${dir}"
  install -o root -g root -m 0644 "$(unit_in "$dir" nusa.service)" "${SYSTEMD_UNIT_DIR}/${SERVICE}"
  install -o root -g root -m 0644 "$(unit_in "$dir" nusa-research.service)" "${SYSTEMD_UNIT_DIR}/${RESEARCH_SERVICE}"
  install -o root -g root -m 0644 "$(unit_in "$dir" nusa-research.timer)" "${SYSTEMD_UNIT_DIR}/${RESEARCH_TIMER}"
  if [ -f "${dir}/deploy/oracle/nusa-autopilot.service" ]; then
    install -o root -g root -m 0644 "${dir}/deploy/oracle/nusa-autopilot.service" "${SYSTEMD_UNIT_DIR}/${AUTOPILOT_SERVICE}"
  elif [ "$legacy_ok" = true ]; then
    systemctl disable --now "${AUTOPILOT_SERVICE}" 2>/dev/null || true
    rm -f -- "${SYSTEMD_UNIT_DIR}/${AUTOPILOT_SERVICE}"
  else
    die "missing nusa-autopilot.service in ${dir}"
  fi
  systemctl daemon-reload
}

enable_units() {
  local legacy_ok="${1:-false}"
  systemctl enable "${SERVICE}" "${RESEARCH_TIMER}"
  [ "$legacy_ok" = true ] || systemctl enable "${AUTOPILOT_SERVICE}"
}

restart_units() {
  local legacy_ok="${1:-false}"
  systemctl restart "${SERVICE}"
  [ "$legacy_ok" = true ] || systemctl restart "${AUTOPILOT_SERVICE}"
  systemctl start "${RESEARCH_TIMER}"
}

# A release can only run on a database whose applied migrations it knows: the migration runner refuses "database contains
# unknown migration" and the service never starts. After a release applies a new migration, rolling back to an older release
# therefore turns a readiness failure into an outage (2026-10-13: 3098387b7 applied 028, rollback to 2bb279335 left PAPER down).
# Returns 0 when every applied migration id is declared in the candidate release's storage source.
rollback_schema_compatible() {
  local dir="${1:-}" state_db known applied id
  [ -d "$dir" ] || return 1
  state_db="$(set -a; source "$RUNTIME_ENV"; set +a; printf '%s' "${NUSA_CLOUD_STATE_DB_PATH:-}")"
  [[ "$state_db" = /* ]] || return 1
  [ -f "$state_db" ] || return 0
  known="$(grep -ohE 'id: "[0-9]{3}_[a-z0-9_]+"' "$dir"/packages/storage/src/*.ts 2>/dev/null | sed -E 's/id: "([^"]+)"/\1/' | sort -u)"
  [ -n "$known" ] || return 1
  applied="$(node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); for (const row of db.prepare("SELECT id FROM schema_migrations").all()) console.log(row.id); db.close();' "$state_db" 2>/dev/null)" || return 1
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    grep -qxF "$id" <<<"$known" || { printf '%s\n' "nusa-release-step: rollback release does not know applied migration $id" >&2; return 1; }
  done <<<"$applied"
  return 0
}

rollback_and_restore() {
  local rollback_release rollback_legacy_ok=true
  rollback_release="$(previous_release)"
  [ -n "$rollback_release" ] || die "rollback release is unavailable"
  assert_segmented_replay_compatible "$rollback_release"
  # Legacy rollback releases may predate Autopilot. When the rollback release does contain the
  # canonical Autopilot unit, converge that process too; otherwise a symlink rollback can leave
  # Autopilot executing the rejected candidate from its already-resolved cwd.
  [ -f "${rollback_release}/deploy/oracle/nusa-autopilot.service" ] && rollback_legacy_ok=false
  NUSA_DEPLOY_ACTION=rollback node "$(script_in "$(active_release)" atomic-deploy.js)"
  bind_runtime_source_identity "$(active_release_sha)"
  install_units_from_release "$(active_release)" "$rollback_legacy_ok"
  enable_units "$rollback_legacy_ok"
  restart_units "$rollback_legacy_ok"
}

previous_release() {
  [ -f "$PREVIOUS_RELEASE_FILE" ] || return 0
  local path
  path="$(cat "$PREVIOUS_RELEASE_FILE" 2>/dev/null || true)"
  [ -n "$path" ] || return 0
  readlink -f "$path" 2>/dev/null || true
}

assert_stage_disk_headroom() {
  local source_tree="$1"
  local force_copy="${2:-false}"
  local total_bytes available_bytes source_bytes guard_free_bytes required_bytes source_device release_device
  total_bytes="$(df -P -B1 "$RELEASES" | awk 'NR == 2 { print $2 }')"
  available_bytes="$(df -P -B1 "$RELEASES" | awk 'NR == 2 { print $4 }')"
  source_bytes="$(du -sb -- "$source_tree" | awk '{ print $1 }')"
  source_device="$(stat -c '%d' -- "$source_tree")"
  release_device="$(stat -c '%d' -- "$RELEASES")"
  [[ "$total_bytes" =~ ^[0-9]+$ && "$available_bytes" =~ ^[0-9]+$ && "$source_bytes" =~ ^[0-9]+$ ]] \
    || die "could not determine stage disk headroom"
  guard_free_bytes=$(( (total_bytes * (100 - ROOT_DISK_GUARD_PERCENT) + 99) / 100 ))
  required_bytes=$(( guard_free_bytes + ROOT_DISK_STAGE_MARGIN_BYTES ))
  if [ "$force_copy" = "true" ] || [ "$source_device" != "$release_device" ]; then
    required_bytes=$((required_bytes + source_bytes))
  fi
  [ "$available_bytes" -ge "$required_bytes" ] \
    || die "insufficient root disk headroom for stage: available=$available_bytes required=$required_bytes source=$source_bytes"
}

validate_stage_source_tree() {
  local source_tree="$1" source_parent source_name runner_temp
  runner_temp="$(realpath -e -- "$RUNNER_TEMP_ROOT")" || die "trusted runner temp directory is unavailable"
  [ "$runner_temp" = "$RUNNER_TEMP_ROOT" ] || die "trusted runner temp directory resolved unexpectedly"
  [ ! -L "$source_tree" ] || die "release source tree must not be a symlink"
  source_tree="$(realpath -e -- "$source_tree")" || die "release source tree is unavailable"
  [ -d "$source_tree" ] || die "release source tree is not a directory"
  source_parent="${source_tree%/*}"
  source_name="${source_tree##*/}"
  [ "$source_parent" = "$runner_temp" ] && [[ "$source_name" =~ ^nusa-release-tree-[0-9]+$ ]] \
    || die "release source tree must be a direct runner-temp extraction"
  printf '%s\n' "$source_tree"
}

assert_root_disk_headroom() {
  local used_percent
  used_percent="$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
  [[ "$used_percent" =~ ^[0-9]+$ ]] || die "could not determine root disk usage"
  [ "$used_percent" -lt "$ROOT_DISK_GUARD_PERCENT" ] \
    || die "root disk usage ${used_percent}% is at/above ${ROOT_DISK_GUARD_PERCENT}% guard threshold"
}

prune_releases() {
  [ -d "$RELEASES" ] || die "release directory missing: $RELEASES"
  local active previous dir name kept=0 removed=0
  active="$(active_release)"
  previous="$(previous_release)"

  mapfile -t dirs < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)

  # Validate the entire candidate set before deleting anything.
  for dir in "${dirs[@]}"; do
    name="${dir##*/}"
    [[ "$name" =~ ^[0-9a-f]{40}$ ]] || die "unexpected release directory name: $name"
    [ ! -L "$dir" ] || die "release directory must not be a symlink: $dir"
  done

  for dir in "${dirs[@]}"; do
    [ "$dir" = "$active" ] && continue
    [ -n "$previous" ] && [ "$dir" = "$previous" ] && continue
    if [ "$kept" -lt "$RELEASE_RETENTION" ]; then
      kept=$((kept + 1))
      continue
    fi
    rm -rf -- "$dir"
    removed=$((removed + 1))
  done

  printf '%s\n' "nusa-release-step: prune complete; keptRecent=$kept removed=$removed active=$active previous=${previous:-none}"
}

# A startup blocked by the fail-closed PAPER writer clock guard may recover once.  Scope the
# journal to this activation so stale diagnostics from an older attempt cannot authorize reset.
recover_abandoned_writer_lease_once() {
  local dir="$1"
  local since="$2"
  journalctl -u "$SERVICE" --since "$since" --no-pager -o cat 2>/dev/null | grep -q 'PAPER_WRITER_CLOCK_ANOMALY' || return 1
  printf '%s\n' "nusa-release-step: current candidate hit PAPER_WRITER_CLOCK_ANOMALY; attempting one fail-closed lease recovery" >&2
  runuser -u "$SERVICE_USER" -- bash -c 'set -a; source "$1"; set +a; exec node "$2"' _ "$RUNTIME_ENV" "$(script_in "$dir" reset-paper-writer-lease.js)" || return 1
  restart_units
  node "$(script_in "$dir" oracle-readiness-check.js)"
}

prove_post_activation_stability() {
  local dir="$1"
  local expected_sha="$2"
  local deadline attempt=0 current_sha
  validate_sha "$expected_sha"
  deadline=$((SECONDS + POST_ACTIVATION_SOAK_SECONDS))

  while :; do
    attempt=$((attempt + 1))
    current_sha="$(active_release_sha)"
    [ "$current_sha" = "$expected_sha" ] || {
      printf '%s\n' "nusa-release-step: active release identity drifted during soak: expected=$expected_sha actual=$current_sha" >&2
      return 1
    }
    systemctl is-active --quiet "$SERVICE" || return 1
    systemctl is-active --quiet "$AUTOPILOT_SERVICE" || return 1

    # The initial activation readiness owns the long cold-start budget. During the bounded soak,
    # keep each request short but allow a 30s retry window: the 1 GB Oracle host has observed
    # startup event-loop stalls longer than 5s even after /ready first passed. A truly lost listener
    # still fails closed within this bounded window, well inside the 180s soak. The two non-mutating
    # mobile-owner route probes keep their separate bounded proof window.
    NUSA_READY_STARTUP_WAIT_MS="$POST_ACTIVATION_READY_WINDOW_MS" \
      NUSA_READY_ROUTE_PROOF_WAIT_MS="$POST_ACTIVATION_ROUTE_PROOF_WINDOW_MS" \
      NUSA_READY_TIMEOUT_MS="$POST_ACTIVATION_READY_TIMEOUT_MS" \
      NUSA_READY_RETRY_DELAY_MS="$POST_ACTIVATION_READY_RETRY_DELAY_MS" \
      node "$(script_in "$dir" oracle-readiness-check.js)" || return 1
    NUSA_AUTOPILOT_READY_TIMEOUT_MS=5000 \
      node "$(script_in "$dir" autopilot-readiness.js)" || return 1

    printf '%s\n' "nusa-release-step: post-activation stability check $attempt passed for $expected_sha"
    (( SECONDS >= deadline )) && break
    sleep "$POST_ACTIVATION_CHECK_INTERVAL_SECONDS"
  done

  printf '%s\n' "nusa-release-step: ${POST_ACTIVATION_SOAK_SECONDS}s stability soak passed for $expected_sha"
}

verb="${1:-}"
shift || true

case "$verb" in
  backup)
    state_db="$(set -a; source "$RUNTIME_ENV"; set +a; printf '%s' "${NUSA_CLOUD_STATE_DB_PATH:-}")"
    backup_dir="$(set -a; source "$RUNTIME_ENV"; set +a; printf '%s' "${NUSA_BACKUP_DIR:-/var/backups/nusa}")"
    [[ "$state_db" = /* ]] || die "Cloud state path must be absolute before backup"
    [[ "$backup_dir" = /* ]] || die "Backup directory must be absolute before backup"
    if [ ! -e "$backup_dir" ]; then install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 -- "$backup_dir"; fi
    [[ -d "$backup_dir" && ! -L "$backup_dir" ]] || die "Backup directory must be a real directory"
    # Resolve from the installed root-owned helper, not from the old active release. Both database
    # and backup destination must map to one verified ext4/xfs disk before any backup work begins.
    backup_device="$(backup_block_device_for_paths "$state_db" "$backup_dir")" \
      || die "backup storage topology could not be verified before backup"
    # The numeric systemd bandwidth value is bytes/second: 1,048,576 is exactly 1 MiB/s.
    # Limit only this child in its transient cgroup; failure never falls back to an uncapped backup.
    exec systemd-run --quiet --collect --scope \
      -p "IOReadBandwidthMax=${backup_device} 1048576" \
      -p "IOWriteBandwidthMax=${backup_device} 1048576" \
      nice -n 19 runuser -u "$SERVICE_USER" -- env NUSA_DB="$state_db" NUSA_BACKUP_DIR="$backup_dir" node "$(script_in "$(active_release)" sqlite-backup.js)"
    ;;

  preflight)
    validate_sha "${1:-}"
    dir="$(release_dir "$1")"
    [ -d "$dir" ] || die "release not staged: $dir"
    assert_segmented_replay_compatible "$dir"
    assert_root_disk_headroom
    node "$(script_in "$dir" host-security-validate.js)"
    NUSA_ORACLE_RELEASE_DIR="$dir" exec node "$(script_in "$dir" oracle-validate.js)"
    ;;

  install-units)
    validate_sha "${1:-}"
    dir="$(release_dir "$1")"
    [ -d "$dir" ] || die "release not staged: $dir"
    assert_segmented_replay_compatible "$dir"
    acquire_paper_activation_lock
    install_units_from_release "$dir"
    enable_units
    ;;

  prune)
    prune_releases
    ;;

  stage)
    validate_sha "${1:-}"
    source_tree="$(validate_stage_source_tree "${2:-}")"
    assert_stage_disk_headroom "$source_tree"
    dir="$(release_dir "$1")"
    # A staged release is immutable once `current` points at it. Replacing the active release
    # would mutate what the running service is executing.
    if [ -e "$dir" ]; then
      [ "$(readlink -f "$dir")" = "$(active_release)" ] && die "refusing to restage the active release"
      rm -rf -- "$dir"
    fi
    if [ "$(stat -c '%d' -- "$source_tree")" = "$(stat -c '%d' -- "$RELEASES")" ]; then
      chown -R "${SERVICE_USER}:${SERVICE_USER}" -- "$source_tree"
      if ! mv --no-copy -T -- "$source_tree" "$dir"; then
        # Same st_dev can still cross a bind-mount boundary. Never let mv silently copy after
        # the reduced rename-only headroom gate; re-check full-copy headroom before copying.
        assert_stage_disk_headroom "$source_tree" true
        install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 -- "$dir"
        tar -cf - --exclude=.git -C "$source_tree" . | tar -xf - -C "$dir"
        chown -R "${SERVICE_USER}:${SERVICE_USER}" -- "$dir"
      fi
    else
      install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 -- "$dir"
      tar -cf - --exclude=.git -C "$source_tree" . | tar -xf - -C "$dir"
      chown -R "${SERVICE_USER}:${SERVICE_USER}" -- "$dir"
    fi
    ;;

  switch)
    validate_sha "${1:-}"
    dir="$(release_dir "$1")"
    assert_segmented_replay_compatible "$dir"
    acquire_paper_activation_lock
    NUSA_COMMIT_SHA="$1" node "$(script_in "$dir" atomic-deploy.js)"
    bind_runtime_source_identity "$1"
    ;;

  rollback)
    acquire_paper_activation_lock
    rollback_release="$(previous_release)"
    [ -n "$rollback_release" ] || die "rollback release is unavailable"
    assert_segmented_replay_compatible "$rollback_release"
    NUSA_DEPLOY_ACTION=rollback node "$(script_in "$(active_release)" atomic-deploy.js)"
    bind_runtime_source_identity "$(active_release_sha)"
    ;;

  restart)
    acquire_paper_activation_lock
    systemctl daemon-reload
    enable_units
    restart_units
    ;;

  activate)
    validate_sha "${1:-}"
    dir="$(release_dir "$1")"
    [ -d "$dir" ] || die "release not staged: $dir"
    assert_segmented_replay_compatible "$dir"
    acquire_paper_activation_lock
    NUSA_COMMIT_SHA="$1" node "$(script_in "$dir" atomic-deploy.js)"
    activation_started="$(date --iso-8601=seconds)"
    paper_ready=false
    if bind_runtime_source_identity "$1" && install_units_from_release "$dir" && enable_units && restart_units; then
      if node "$(script_in "$dir" oracle-readiness-check.js)"; then
        paper_ready=true
      elif recover_abandoned_writer_lease_once "$dir" "$activation_started"; then
        paper_ready=true
      fi
    fi
    autopilot_ready=false
    stability_ready=false
    if [ "$paper_ready" = true ] && node "$(script_in "$dir" autopilot-readiness.js)"; then
      autopilot_ready=true
      if prove_post_activation_stability "$dir" "$1"; then
        stability_ready=true
      fi
    fi
    if [ "$paper_ready" != true ] || [ "$autopilot_ready" != true ] || [ "$stability_ready" != true ]; then
      if ! rollback_schema_compatible "$(previous_release)"; then
        # Rolling back would leave nothing running. Keep the new release and its units active and fail the step loudly.
        printf '%s\n' "nusa-release-step: activation of $1 did not prove readiness, but the previous release cannot open the migrated database; keeping $1 active (no rollback)" >&2
        exit 1
      fi
      printf '%s\n' "nusa-release-step: activation failed for $1; restoring previous release" >&2
      rollback_and_restore
      node "$(script_in "$(active_release)" oracle-readiness-check.js)" || die "rollback PAPER readiness failed"
      node "$(script_in "$(active_release)" autopilot-readiness.js)" || die "rollback Autopilot readiness failed"
      exit 1
    fi
    systemctl is-active --quiet "$SERVICE" || die "PAPER service is not active after activation"
    systemctl is-active --quiet "$AUTOPILOT_SERVICE" || die "Autopilot service is not active after activation"
    printf '%s\n' "nusa-release-step: activation accepted for $1"
    ;;

  readiness)
    exec node "$(script_in "$(active_release)" oracle-readiness-check.js)"
    ;;

  *)
    die "unknown verb '${verb}'. Expected: backup|preflight|install-units|prune|stage|switch|activate|rollback|restart|readiness"
    ;;
esac
