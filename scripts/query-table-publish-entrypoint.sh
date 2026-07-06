#!/bin/sh
# County-generic "refresh" entrypoint: chains the query-table export -> validate ->
# publish scripts into ONE repeatable step (run as a single task or locally).
#
# Sequence (each step fails the run loudly on error via `set -e`):
#   1. export   run-query-table-export.ts     -> writes <OUT_DIR>/<COUNTY>/query-table.parquet
#   2. validate validate-query-table.ts       -> exits nonzero on any folio mismatch/dupe
#   3. publish  upload-query-table-to-filebase.ts -> re-points the oracle-query-table-<county> IPNS
#
# SAFE BY DEFAULT: validate runs in `parquet-only` mode (mid-ingest safe — skips the
# Neon-completeness gate so it doesn't false-fail while the loader is still adding
# folios), and publish runs as a DRY-RUN unless PUBLISH_APPROVED is non-empty. The
# dry-run default is the PII human-gate: a real IPNS publish only happens when a
# human explicitly approves it.
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
#   VALIDATE_MODE     (optional)  parquet-only (default, mid-ingest safe) | full
#                                 (completeness gate for a FINAL publish).
#   PUBLISH_APPROVED  (optional)  empty (default) => DRY-RUN publish (no upload);
#                                 non-empty => REAL publish. The PII human-gate.
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
VALIDATE_MODE="${VALIDATE_MODE:-parquet-only}"
PUBLISH_APPROVED="${PUBLISH_APPROVED:-}"

PARQUET="$OUT_DIR/$COUNTY/query-table.parquet"

if [ -n "$PUBLISH_APPROVED" ]; then
  PUBLISH_APPROVED_LOG="true"
else
  PUBLISH_APPROVED_LOG="false"
fi

echo "{\"event\":\"query_table_publish_entrypoint_started\",\"county\":\"$COUNTY\",\"step\":\"$STEP\",\"validateMode\":\"$VALIDATE_MODE\",\"publishApproved\":$PUBLISH_APPROVED_LOG}"

run_export() {
  # NOTE: use if/then, NOT `[ ... ] && ...` — under `set -e` a false test as the
  # function's last command makes the function return non-zero and aborts the run.
  EXPORT_ARGS="--county $COUNTY --env-file $ENV_FILE --out-dir $OUT_DIR"
  if [ -n "${MANIFEST:-}" ]; then
    EXPORT_ARGS="$EXPORT_ARGS --manifest $MANIFEST"
  fi
  # shellcheck disable=SC2086
  "$TSX" scripts/run-query-table-export.ts $EXPORT_ARGS
}

run_validate() {
  VALIDATE_ARGS="--county $COUNTY --env-file $ENV_FILE --parquet $PARQUET"
  if [ "$VALIDATE_MODE" = "parquet-only" ]; then
    VALIDATE_ARGS="$VALIDATE_ARGS --parquet-only"
  fi
  # shellcheck disable=SC2086
  "$TSX" scripts/validate-query-table.ts $VALIDATE_ARGS
}

run_publish() {
  PUBLISH_ARGS="--county $COUNTY --env-file $PUBLISH_ENV_FILE"
  if [ -z "$PUBLISH_APPROVED" ]; then
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
