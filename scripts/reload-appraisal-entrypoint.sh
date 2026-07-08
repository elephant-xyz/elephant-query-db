#!/bin/sh
# Container entrypoint for the serial appraisal re-load (run as a single Fargate task).
#
# Sequence (each step fails the task loudly on error via `set -e`):
#   1. ensure folio unique constraint (idempotent migration 0005)
#   2. clear appraisal-owned rows (FK-safe, batched, source_system=$JURISDICTION_KEY)
#   3. run the EXISTING proven bulk loader over the whole county (batch mode)
#   4. validate the result BY FOLIO (fails if distinct folios are short)
#
# COUNTY-GENERIC + MULTI-TRACK: defaults preserve today's Lee behavior byte-for-byte
# (JURISDICTION_KEY=lee_appraiser, TRACKS=appraisal). For a NEW county set JURISDICTION_KEY
# and SKIP_CLEAR=1 (fresh county needs no clear; the loader upsert is idempotent), and
# override APPRAISAL_PREFIX + EXPECTED_PARCELS. One task can load several tracks by setting
# TRACKS + SUNBIZ_PREFIX/BBB_PREFIX.
#
# Env:
#   DATABASE_URL          (required)  direct/unpooled Neon endpoint
#   APPRAISAL_PREFIX      (required)  e.g. outputs/lee-property-first-seed/lee-fullcounty-20260619/
#   JURISDICTION_KEY      (optional)  appraisal source_system / parcel jurisdiction_key (default lee_appraiser)
#                                     — scopes the clear + the loaded rows + the folio validation.
#   TRACKS                (optional)  comma-separated loader tracks (default appraisal); e.g. appraisal,sunbiz,bbb
#   SUNBIZ_PREFIX         (optional)  S3 prefix for the sunbiz track (only used when TRACKS includes sunbiz)
#   BBB_PREFIX            (optional)  S3 prefix for the bbb track (only used when TRACKS includes bbb)
#   APPRAISAL_BUCKET      (optional)  overrides the loader default bucket
#   BATCH_SIZE            (optional)  default 20000
#   SCOPE_MANIFEST        (optional)  S3-URI manifest path/URL to scope a TEST subset
#   SKIP_CLEAR            (optional)  set to skip the clear step on a resumed run (or a fresh county)
#   INCREMENTAL           (optional)  set to load only artifacts not already in the DB (skip already-loaded; safe cadence re-runs)
#   EXPECTED_MIN_PARCELS  (optional)  validate threshold (default 510000)
#   STEP                  (optional)  all (default) | migrate | clear | load | validate
#                                     — run a single step (e.g. STEP=validate for a read-only smoke).
set -eu

TSX="node_modules/.bin/tsx"
STEP="${STEP:-all}"

# County-generic defaults (Lee-preserving). Exported so the clear + validate TS scripts,
# which read these from the environment directly, resolve the SAME source_system value.
JURISDICTION_KEY="${JURISDICTION_KEY:-lee_appraiser}"
TRACKS="${TRACKS:-appraisal}"
export JURISDICTION_KEY TRACKS

echo "{\"event\":\"reload_entrypoint_started\",\"step\":\"$STEP\"}"

# Read-only single step (does NOT require APPRAISAL_PREFIX): handy for smoke tests / redrive.
if [ "$STEP" = "validate" ]; then
  exec $TSX scripts/validate-appraisal-folio.ts
fi
if [ "$STEP" = "migrate" ]; then
  exec $TSX scripts/ensure-folio-constraint.ts
fi
if [ "$STEP" = "clear" ]; then
  $TSX scripts/ensure-folio-constraint.ts
  exec $TSX scripts/clear-appraisal-source.ts
fi

: "${APPRAISAL_PREFIX:?APPRAISAL_PREFIX is required}"
if [ -n "${INCREMENTAL:-}" ]; then
  : "${BATCH_SIZE:=500}"
else
  : "${BATCH_SIZE:=20000}"
fi

build_load_args() {
  # NOTE: use if/then, NOT `[ ... ] && ...` — under `set -e` a false test as the
  # function's last command makes the function return non-zero and aborts the script
  # (this silently skipped the whole load when SCOPE_MANIFEST was unset).
  LOAD_ARGS="--tracks $TRACKS --jurisdiction-key $JURISDICTION_KEY --appraisal-prefix $APPRAISAL_PREFIX --batch-size $BATCH_SIZE"
  if [ -n "${APPRAISAL_BUCKET:-}" ]; then
    LOAD_ARGS="$LOAD_ARGS --bucket $APPRAISAL_BUCKET"
  fi
  if [ -n "${SUNBIZ_PREFIX:-}" ]; then
    LOAD_ARGS="$LOAD_ARGS --sunbiz-prefix $SUNBIZ_PREFIX"
  fi
  if [ -n "${BBB_PREFIX:-}" ]; then
    LOAD_ARGS="$LOAD_ARGS --bbb-prefix $BBB_PREFIX"
  fi
  if [ -n "${SCOPE_MANIFEST:-}" ]; then
    LOAD_ARGS="$LOAD_ARGS --scope-manifest $SCOPE_MANIFEST"
  fi
  if [ -n "${INCREMENTAL:-}" ]; then
    LOAD_ARGS="$LOAD_ARGS --incremental"
  fi
  return 0
}

if [ "$STEP" = "load" ]; then
  build_load_args
  # shellcheck disable=SC2086
  exec $TSX scripts/run-bulk-data-load.ts $LOAD_ARGS
fi

# STEP=all — the full sequence.
# 1. migration (idempotent)
$TSX scripts/ensure-folio-constraint.ts

# 2. clear appraisal slate (skippable on resume)
if [ -z "${SKIP_CLEAR:-}" ]; then
  $TSX scripts/clear-appraisal-source.ts
else
  echo '{"event":"clear_skipped"}'
fi

# 3. run the existing bulk loader (unchanged)
build_load_args
# shellcheck disable=SC2086
$TSX scripts/run-bulk-data-load.ts $LOAD_ARGS

# 4. validate by folio
$TSX scripts/validate-appraisal-folio.ts

echo '{"event":"reload_entrypoint_finished"}'
