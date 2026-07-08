#!/bin/sh
# County publish entrypoint for incremental-county-publish.
#
# Chains:
#   1. query-table  export -> validate -> publish  (oracle-query-table-<county> IPNS)
#   2. permit-table export -> validate -> publish  (oracle-permit-table-<county> IPNS)
#   3. oracle_dataset_coverage snapshot -> S3 (incremental-status/<county>/dataset-coverage.json)
#
# Env (inherited from query-table-publish-entrypoint + additions):
#   COUNTY            (required)
#   PUBLISH_APPROVED  empty => dry-run uploads
#   VALIDATE_MODE     parquet-only (default) | full
#   SKIP_PERMIT_PUBLISH set to "true" to skip permit-table when a county has no permit rows yet
#   STATUS_BUCKET     AWS status bucket for coverage snapshot (from Step Functions)
set -eu

TSX="node_modules/.bin/tsx"

: "${COUNTY:?COUNTY is required}"

echo "{\"event\":\"county_publish_entrypoint_started\",\"county\":\"$COUNTY\"}"

# Property query-table (existing entrypoint).
sh scripts/query-table-publish-entrypoint.sh

# Permit-table (separate IPNS; teammate inline harvest feeds Neon).
if [ "${SKIP_PERMIT_PUBLISH:-false}" = "true" ]; then
  echo "{\"event\":\"permit_table_publish_skipped\",\"county\":\"$COUNTY\"}"
else
  PERMIT_OUT="${PERMIT_OUT_DIR:-.permit-table-export}"
  PERMIT_PARQUET="$PERMIT_OUT/$COUNTY/permit-table.parquet"
  USE_ENV_FILE=true
  if [ -n "${DATABASE_URL:-}" ]; then
    USE_ENV_FILE=false
  fi

  EXPORT_ARGS="--county $COUNTY --out-dir $PERMIT_OUT"
  VALIDATE_ARGS="--county $COUNTY --parquet $PERMIT_PARQUET"
  PUBLISH_ARGS="--county $COUNTY"
  if [ "$USE_ENV_FILE" = true ]; then
    ENV_FILE="${ENV_FILE:-.env.local}"
    PUBLISH_ENV_FILE="${PUBLISH_ENV_FILE:-$ENV_FILE}"
    EXPORT_ARGS="$EXPORT_ARGS --env-file $ENV_FILE"
    VALIDATE_ARGS="$VALIDATE_ARGS --env-file $ENV_FILE"
    PUBLISH_ARGS="$PUBLISH_ARGS --env-file $PUBLISH_ENV_FILE"
  fi
  if [ "${VALIDATE_MODE:-parquet-only}" = "parquet-only" ]; then
    VALIDATE_ARGS="$VALIDATE_ARGS --parquet-only"
  fi
  if [ -z "${PUBLISH_APPROVED:-}" ]; then
    PUBLISH_ARGS="$PUBLISH_ARGS --dry-run"
  fi

  # shellcheck disable=SC2086
  $TSX scripts/run-permit-table-export.ts $EXPORT_ARGS
  # shellcheck disable=SC2086
  $TSX scripts/validate-permit-table.ts $VALIDATE_ARGS
  # shellcheck disable=SC2086
  $TSX scripts/upload-permit-table-to-filebase.ts $PUBLISH_ARGS
fi

# Coverage snapshot for Donphan / getOracleDatasetInfo contract (rows upserted in Neon).
if [ -n "${STATUS_BUCKET:-}" ]; then
  # shellcheck disable=SC2086
  $TSX scripts/write-oracle-dataset-coverage-snapshot.ts
else
  echo "{\"event\":\"oracle_dataset_coverage_snapshot_skipped\",\"reason\":\"STATUS_BUCKET unset\"}"
fi

echo "{\"event\":\"county_publish_entrypoint_finished\",\"county\":\"$COUNTY\"}"
