#!/usr/bin/env bash
set -euo pipefail

county=
watermark=
while (($# > 0)); do
  case "$1" in
    --county)
      county="${2:?--county requires a value}"
      shift 2
      ;;
    --watermark)
      watermark="${2:?--watermark requires a value}"
      shift 2
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

: "${PUBLISH_DATA_ROOT:?PUBLISH_DATA_ROOT is required}"
: "${PUBLISH_QUERY_DB_DIR:?PUBLISH_QUERY_DB_DIR is required}"
[[ "$county" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
[[ "$watermark" =~ ^[a-f0-9]{64}$ ]]

cd "$PUBLISH_QUERY_DB_DIR"
npm run verify:publication-envelope -- \
  --root "$PUBLISH_DATA_ROOT/publication/$county/$watermark" \
  --county "$county" \
  --expected-watermark "$watermark"
