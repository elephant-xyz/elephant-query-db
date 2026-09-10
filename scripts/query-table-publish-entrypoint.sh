#!/bin/sh
# County-generic "refresh" entrypoint: chains the query-table export -> validate ->
# publish scripts into ONE repeatable step (run as a single task or locally).
#
# Sequence (each step fails the run loudly on error via `set -e`):
#   1. export   run-query-table-export.ts     -> writes <OUT_DIR>/<COUNTY>/query-table.parquet
#   2. validate validate-query-table.ts       -> exits nonzero on any folio mismatch/dupe
#   3. publish  upload-query-table-to-filebase.ts -> re-points the oracle-query-table-<county> IPNS
#
# SAFE BY DEFAULT: validate runs in `parquet-only` mode for an unapproved
# dry-run. A live publish requires PUBLISH_APPROVED=1 and full database
# reconciliation; every other non-empty approval value is rejected.
#
# Env:
#   COUNTY            (required)  hyphen slug, e.g. palm-beach. MUST be hyphen form — an
#                                 underscore slug breaks the MCP (per the
#                                 county-query-table-publish skill).
#   ENV_FILE          (optional)  DB creds for export/validate (default .env.local).
#   PUBLISH_ENV_FILE  (optional)  Filebase creds for publish (default $ENV_FILE).
#   OUT_DIR           (optional)  export output root (default .query-table-export).
#   MANIFEST          (optional)  consolidation manifest path; when set, passes
#                                 --manifest to export to populate property_cid. When
#                                 unset, export runs with property_cid NULL (fine for
#                                 analytical use).
#   VALIDATE_MODE     (optional)  parquet-only (default for dry-run) | full
#                                 (required and default for a FINAL publish).
#   PUBLISH_APPROVED  (optional)  empty (default) => DRY-RUN publish (no upload);
#                                 exactly 1 => REAL publish. Any other value fails.
#   STEP              (optional)  all (default) | export | validate | publish
#                                 — run a single stage.
set -eu

TSX="node_modules/.bin/tsx"
STEP="${STEP:-all}"

# County-generic env-driven defaults.
: "${COUNTY:?COUNTY is required (hyphen slug, e.g. palm-beach)}"
ENV_FILE="${ENV_FILE:-.env.local}"
PUBLISH_ENV_FILE="${PUBLISH_ENV_FILE:-$ENV_FILE}"
OUT_DIR="${OUT_DIR:-.query-table-export}"
PUBLISH_APPROVED="${PUBLISH_APPROVED:-}"

PARQUET="$OUT_DIR/$COUNTY/query-table.parquet"
VALIDATION_REPORT="$OUT_DIR/$COUNTY/validation-report.json"

if [ "$PUBLISH_APPROVED" = "1" ]; then
  PUBLISH_APPROVED_LOG="true"
  VALIDATE_MODE="${VALIDATE_MODE:-full}"
elif [ -z "$PUBLISH_APPROVED" ]; then
  PUBLISH_APPROVED_LOG="false"
  VALIDATE_MODE="${VALIDATE_MODE:-parquet-only}"
else
  echo "PUBLISH_APPROVED must be empty or exactly 1" >&2
  exit 1
fi

if [ "$PUBLISH_APPROVED_LOG" = "true" ] && [ "$VALIDATE_MODE" != "full" ]; then
  echo "Approved publication requires VALIDATE_MODE=full" >&2
  exit 1
fi

echo "{\"event\":\"query_table_publish_entrypoint_started\",\"county\":\"$COUNTY\",\"step\":\"$STEP\",\"validateMode\":\"$VALIDATE_MODE\",\"publishApproved\":$PUBLISH_APPROVED_LOG}"

# Fargate injects DATABASE_URL + Filebase creds via Secrets Manager. Node 22 also
# treats `--env-file` as a *runtime* flag, so passing it to tsx makes node try to
# open `.env.local` and exit before our script runs.
USE_ENV_FILE=true
if [ -n "${DATABASE_URL:-}" ]; then
  USE_ENV_FILE=false
fi

run_export() {
  # NOTE: use if/then, NOT `[ ... ] && ...` — under `set -e` a false test as the
  # function's last command makes the function return non-zero and aborts the run.
  EXPORT_ARGS="--county $COUNTY --out-dir $OUT_DIR"
  if [ "$USE_ENV_FILE" = true ]; then
    EXPORT_ARGS="$EXPORT_ARGS --env-file $ENV_FILE"
  fi
  if [ -n "${MANIFEST:-}" ]; then
    EXPORT_ARGS="$EXPORT_ARGS --manifest $MANIFEST"
  fi
  # shellcheck disable=SC2086
  "$TSX" scripts/run-query-table-export.ts $EXPORT_ARGS
}

run_validate() {
  VALIDATE_ARGS="--county $COUNTY --parquet $PARQUET --report $VALIDATION_REPORT"
  if [ "$USE_ENV_FILE" = true ]; then
    VALIDATE_ARGS="$VALIDATE_ARGS --env-file $ENV_FILE"
  fi
  if [ "$VALIDATE_MODE" = "parquet-only" ]; then
    VALIDATE_ARGS="$VALIDATE_ARGS --parquet-only"
  fi
  # shellcheck disable=SC2086
  "$TSX" scripts/validate-query-table.ts $VALIDATE_ARGS
}

run_publish() {
  PUBLISH_ARGS="--county $COUNTY --parquet $PARQUET --validation-report $VALIDATION_REPORT"
  if [ "$USE_ENV_FILE" = true ]; then
    PUBLISH_ARGS="$PUBLISH_ARGS --env-file $PUBLISH_ENV_FILE"
  fi
  if [ "$PUBLISH_APPROVED_LOG" = "false" ]; then
    PUBLISH_ARGS="$PUBLISH_ARGS --dry-run"
  fi
  # shellcheck disable=SC2086
  "$TSX" scripts/upload-query-table-to-filebase.ts $PUBLISH_ARGS
}

if [ "$STEP" = "export" ]; then
  run_export
elif [ "$STEP" = "validate" ]; then
  run_validate
elif [ "$STEP" = "publish" ]; then
  run_publish
elif [ "$STEP" = "all" ]; then
  run_export
  run_validate
  run_publish
else
  echo "{\"event\":\"query_table_publish_entrypoint_bad_step\",\"step\":\"$STEP\"}" >&2
  exit 1
fi

echo "{\"event\":\"query_table_publish_entrypoint_finished\",\"county\":\"$COUNTY\",\"step\":\"$STEP\"}"
