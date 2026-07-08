#!/bin/sh
# Source-AGNOSTIC incremental load entrypoint for the incremental-county state machine.
#
# One execution == one source (track). This script knows NOTHING about "appraisal": the
# state machine passes a single TRACK and a SOURCE_PREFIX, and this maps that prefix to
# the loader's per-track flag. Appraisal, permits, sunbiz, and bbb all run through the
# exact same path — only TRACK + SOURCE_PREFIX differ.
#
# It always runs the loader in --incremental mode: the loader loads only artifacts not
# already in Neon and writes a machine-readable status JSON to INCREMENTAL_STATUS_URI with
# EXACTLY { "processed": <number>, "skipped": <boolean> }. The state machine reads that to
# decide whether to flag a publish and whether to loop or complete.
#
# Env:
#   TRACK                 (required)  ONE of: appraisal | permits | sunbiz | bbb.
#   SOURCE_PREFIX         (required)  S3 prefix of the track's artifacts the loader reads.
#   JURISDICTION_KEY      (required)  loader source_system / parcel jurisdiction_key
#                                     (e.g. miami_dade_appraiser). Scopes the loaded rows.
#   INCREMENTAL_STATUS_URI(required)  s3:// URI the loader writes {processed,skipped} to.
#   DATABASE_URL          (required)  direct/unpooled Neon endpoint (injected by Fargate).
#   SOURCE_BUCKET         (optional)  overrides the loader's default artifact bucket.
#   BATCH_SIZE            (optional)  loader batch size (default 500 for incremental).
#   SCOPE_MANIFEST        (optional)  S3-URI manifest to scope a TEST subset.
set -eu

TSX="node_modules/.bin/tsx"

: "${TRACK:?TRACK is required (one of: appraisal|permits|sunbiz|bbb)}"
: "${SOURCE_PREFIX:?SOURCE_PREFIX is required}"
: "${JURISDICTION_KEY:?JURISDICTION_KEY is required}"
: "${BATCH_SIZE:=500}"
export JURISDICTION_KEY

echo "{\"event\":\"incremental_load_entrypoint_started\",\"track\":\"$TRACK\"}"

# Map the single TRACK + SOURCE_PREFIX to the loader's per-track prefix flag.
case "$TRACK" in
  appraisal) PREFIX_FLAG="--appraisal-prefix $SOURCE_PREFIX" ;;
  permits) PREFIX_FLAG="--permit-prefix $SOURCE_PREFIX" ;;
  sunbiz) PREFIX_FLAG="--sunbiz-prefix $SOURCE_PREFIX" ;;
  bbb) PREFIX_FLAG="--bbb-prefix $SOURCE_PREFIX" ;;
  *)
    echo "{\"event\":\"incremental_load_entrypoint_bad_track\",\"track\":\"$TRACK\"}" >&2
    exit 1
    ;;
esac

LOAD_ARGS="--tracks $TRACK --jurisdiction-key $JURISDICTION_KEY --batch-size $BATCH_SIZE --incremental $PREFIX_FLAG"
if [ -n "${SOURCE_BUCKET:-}" ]; then
  LOAD_ARGS="$LOAD_ARGS --bucket $SOURCE_BUCKET"
fi
if [ -n "${SCOPE_MANIFEST:-}" ]; then
  LOAD_ARGS="$LOAD_ARGS --scope-manifest $SCOPE_MANIFEST"
fi

# shellcheck disable=SC2086
exec $TSX scripts/run-bulk-data-load.ts $LOAD_ARGS
