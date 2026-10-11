#!/usr/bin/env bash
# Online SQLite backup using the running release image, with no AWS credentials.
set -euo pipefail
umask 077

verus_running_image() {
  local container_id=$1 image_id image_ref local_image_id
  image_id=$(docker inspect --format '{{.Image}}' "$container_id") || return 1
  image_ref=$(docker inspect --format '{{.Config.Image}}' "$container_id") || return 1
  [[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || {
    printf '%s\n' 'Could not identify the running release image.' >&2
    return 1
  }
  [[ ${#image_ref} -le 2048 && $image_ref =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$ ]] || {
    printf '%s\n' 'The running container has an invalid image reference.' >&2
    return 1
  }
  local_image_id=$(docker image inspect --format '{{.Id}}' "$image_ref") || {
    printf '%s\n' 'The running release image is unavailable locally; restore its preserved release tag before backing up.' >&2
    return 1
  }
  [[ $local_image_id == "$image_id" ]] || {
    printf '%s\n' 'The running release tag now names another image; refusing an unverified backup helper.' >&2
    return 1
  }
  printf '%s\n' "$image_ref"
}

main() {
  [[ $EUID == 0 ]] || { printf '%s\n' 'Run this backup as root.' >&2; exit 1; }
  /usr/local/sbin/verus-require-data-disk
  exec 9>/run/lock/verus-backup.lock
  flock -n 9 || { printf '%s\n' 'Another Verus backup is running.' >&2; exit 1; }

  data_mount=/srv/verus-data
  workspace=$data_mount/workspace
  backup_dir=$data_mount/backups
  source_db=$workspace/mindtrust.sqlite
  [[ -f "$source_db" && ! -L "$source_db" && -d "$backup_dir" && ! -L "$backup_dir" ]] || {
    printf '%s\n' 'Expected regular database and prepared backup directory are missing.' >&2
    exit 1
  }

  # Preserve at least 1 GiB of free space beyond the estimated new backup size.
  required_bytes=$(( $(stat -c %s "$source_db") + 1073741824 ))
  if [[ -f $source_db-wal ]]; then
    required_bytes=$(( required_bytes + $(stat -c %s "$source_db-wal") ))
  fi
  available_kib=$(df -Pk "$data_mount" | awk 'NR == 2 { print $4 }')
  [[ $available_kib =~ ^[0-9]+$ ]] && (( available_kib * 1024 > required_bytes )) || {
    printf '%s\n' 'Not enough free disk space for another backup plus 1 GiB reserve; review retained backups.' >&2
    exit 1
  }

  mapfile -t containers < <(docker ps --filter label=com.docker.compose.project=verus --filter label=com.docker.compose.service=mindtrust --filter status=running --format '{{.ID}}')
  [[ ${#containers[@]} == 1 ]] || { printf '%s\n' 'Expected exactly one running Verus application container.' >&2; exit 1; }
  image_ref=$(verus_running_image "${containers[0]}")
  backup_name=verus-$(date -u +%Y%m%dT%H%M%SZ).sqlite

  # The isolated helper receives no application secrets and cannot reach the network.
  # SQLite's online backup captures committed WAL data; no raw live-file copy is used.
  docker run --rm --pull=never --network none --read-only --user node \
    --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 64 --memory 512m \
    --tmpfs /tmp:size=64m,mode=1777 \
    --mount "type=bind,src=$workspace,dst=/app/data,readonly" \
    --mount "type=bind,src=$backup_dir,dst=/backups" \
    "$image_ref" sh -eu -c 'npm run backup -- create "$1" "$2"; npm run backup -- verify "$2"' \
    verus-backup /app/data/mindtrust.sqlite "/backups/$backup_name"

  printf '%s\n' "$backup_name" > "$backup_dir/latest-verified"
  sync -f "$data_mount"
  printf '%s\n' "Verified Verus backup: $backup_name"
  # No pruning: preserve all existing files. Review capacity and retention as an operator.
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
