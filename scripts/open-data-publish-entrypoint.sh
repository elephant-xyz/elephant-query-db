#!/bin/sh
# County-generic open-data publish entrypoint (county-open-data-publish skill).
#
# Chains property consolidation export -> Filebase/IPFS upload so downstream MCP/NEO
# keep reading oracle-open-data-<county> IPNS (per-property JSON + sharded index).
#
# Sequence (each step fails loudly via `set -e`):
#   1. export  run-property-consolidation-export.ts
#   2. upload  upload-consolidation-to-filebase.ts  (resumable checkpoint)
#
# SAFE BY DEFAULT: upload runs as DRY-RUN unless PUBLISH_APPROVED is non-empty.
#
# Env:
#   COUNTY            (required) hyphen slug, e.g. miami-dade
#   OUT_DIR           (optional) export root (default .property-consolidation-export-<county>)
#   SHARD_SIZE        (optional) shard size for index.json (default 10000)
#   UPLOAD_CONCURRENCY (optional) parallel S3 puts (default 64)
#   VALIDATE_MODE     (optional) parquet-only (default, mid-ingest cycle) | full (final:
#                     forces index/shard re-upload via --force-index)
#   PUBLISH_APPROVED  (optional) empty => dry-run upload; non-empty => live IPNS publish
#   FILEBASE_IPNS_LABEL (optional) defaults to oracle-open-data-<county>
#   STEP              (optional) all (default) | export | upload
set -eu

TSX="node_modules/.bin/tsx"
STEP="${STEP:-all}"

: "${COUNTY:?COUNTY is required (hyphen slug, e.g. miami-dade)}"

OUT_DIR="${OUT_DIR:-.property-consolidation-export-${COUNTY}}"
SHARD_SIZE="${SHARD_SIZE:-10000}"
UPLOAD_CONCURRENCY="${UPLOAD_CONCURRENCY:-64}"
VALIDATE_MODE="${VALIDATE_MODE:-parquet-only}"
PUBLISH_APPROVED="${PUBLISH_APPROVED:-}"

if [ -z "${FILEBASE_IPNS_LABEL:-}" ]; then
  export FILEBASE_IPNS_LABEL="oracle-open-data-${COUNTY}"
fi

if [ -n "$PUBLISH_APPROVED" ]; then
  PUBLISH_APPROVED_LOG="true"
else
  PUBLISH_APPROVED_LOG="false"
fi

echo "{\"event\":\"open_data_publish_entrypoint_started\",\"county\":\"$COUNTY\",\"step\":\"$STEP\",\"validateMode\":\"$VALIDATE_MODE\",\"outDir\":\"$OUT_DIR\",\"ipnsLabel\":\"$FILEBASE_IPNS_LABEL\",\"publishApproved\":$PUBLISH_APPROVED_LOG}"

USE_ENV_FILE=true
if [ -n "${DATABASE_URL:-}" ]; then
  USE_ENV_FILE=false
fi

run_export() {
  EXPORT_ARGS="--county $COUNTY --out-dir $OUT_DIR --shard-size $SHARD_SIZE"
  if [ "$USE_ENV_FILE" = true ]; then
    EXPORT_ARGS="$EXPORT_ARGS --env-file .env.local"
  fi
  # shellcheck disable=SC2086
  "$TSX" scripts/run-property-consolidation-export.ts $EXPORT_ARGS
}

run_upload() {
  UPLOAD_ARGS="--export-dir $OUT_DIR --concurrency $UPLOAD_CONCURRENCY"
  if [ "$VALIDATE_MODE" = "full" ]; then
    UPLOAD_ARGS="$UPLOAD_ARGS --force-index"
  fi
  if [ -z "$PUBLISH_APPROVED" ]; then
    UPLOAD_ARGS="$UPLOAD_ARGS --dry-run"
  fi
  # shellcheck disable=SC2086
  "$TSX" scripts/upload-consolidation-to-filebase.ts $UPLOAD_ARGS
}

if [ "$STEP" = "export" ]; then
  run_export
elif [ "$STEP" = "upload" ]; then
  run_upload
elif [ "$STEP" = "all" ]; then
  run_export
  run_upload
else
  echo "{\"event\":\"open_data_publish_entrypoint_bad_step\",\"step\":\"$STEP\"}" >&2
  exit 1
fi

echo "{\"event\":\"open_data_publish_entrypoint_finished\",\"county\":\"$COUNTY\",\"step\":\"$STEP\"}"
