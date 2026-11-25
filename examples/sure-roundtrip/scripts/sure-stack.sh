#!/bin/sh
# Runs Sure at a pinned commit, from Sure's own published image and compose file.
# Usage: scripts/sure-stack.sh up [buggy|fixed]   |   scripts/sure-stack.sh down
set -eu

cd "$(dirname "$0")/.."
BUGGY_SHA=44aad3a14b8873f93ac2428a19525cbc27bc5f0d
BUGGY_DIGEST=sha256:7e62e22f5fb10528c0b4a17254c823e26e164c34ee345239f5793f7f7aa9853b
FIXED_SHA=cd5ad7e037dc6dca5cdfc4b36c8bbe13d02537c3
FIXED_DIGEST=sha256:d1321cca735f69c88002cb66d7d9a0d030769bb0957bec1eca9de9a515e9b226

compose() {
  docker compose -p sure-rt -f .stack/compose.yml -f compose.override.yml "$@"
}

case "${1:-}" in
  up)
    variant="${2:-buggy}"
    if [ "$variant" = fixed ]; then sha=$FIXED_SHA; digest=$FIXED_DIGEST; else sha=$BUGGY_SHA; digest=$BUGGY_DIGEST; fi
    mkdir -p .stack
    curl -fsSL -o .stack/compose.yml "https://raw.githubusercontent.com/we-promise/sure/$BUGGY_SHA/compose.example.yml"
    secret=$(grep '^SECRET_KEY_BASE=' .stack/.env 2>/dev/null | cut -d= -f2 || true)
    [ -n "$secret" ] || secret=$(openssl rand -hex 64)
    printf 'SURE_IMAGE_TAG=sha-%s@%s\nPORT=127.0.0.1:3300\nSECRET_KEY_BASE=%s\n' "$sha" "$digest" "$secret" > .stack/.env
    compose --env-file .stack/.env up -d
    printf 'Waiting for Sure (%s, %s) on http://127.0.0.1:3300 ' "$variant" "$sha"
    i=0
    until curl -fs -o /dev/null http://127.0.0.1:3300/up; do
      i=$((i + 1)); [ "$i" -lt 120 ] || { echo 'timed out'; exit 1; }
      printf '.'; sleep 2
    done
    echo ' ready'
    ;;
  down)
    compose --env-file .stack/.env down -v
    ;;
  *)
    echo 'usage: scripts/sure-stack.sh up [buggy|fixed] | down' >&2
    exit 2
    ;;
esac
