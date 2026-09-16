#!/bin/sh
set -eu

volume_path="${RAILWAY_VOLUME_MOUNT_PATH:-}"

if [ -n "$volume_path" ]; then
  case "$volume_path" in
    /)
      echo "RAILWAY_VOLUME_MOUNT_PATH não pode apontar para /." >&2
      exit 1
      ;;
    /*)
      mkdir -p "$volume_path"
      chown node:node "$volume_path"
      ;;
    *)
      echo "RAILWAY_VOLUME_MOUNT_PATH deve ser absoluto." >&2
      exit 1
      ;;
  esac
fi

exec gosu node "$@"
