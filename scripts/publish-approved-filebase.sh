#!/usr/bin/env bash
set -euo pipefail

if [[ "${PUBLISH_APPROVED:-}" != "1" ]]; then
  printf 'Durable Publish approval is required\n' >&2
  exit 1
fi

county="${PUBLISH_COUNTY:?PUBLISH_COUNTY is required}"
watermark="${PUBLISH_WATERMARK:?PUBLISH_WATERMARK is required}"
if [[ ! "$county" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  printf 'Invalid county slug\n' >&2
  exit 1
fi
if [[ ! "$watermark" =~ ^[a-f0-9]{64}$ ]]; then
  printf 'Invalid publication watermark\n' >&2
  exit 1
fi

credential_file="${PUBLISH_CREDENTIAL_FILE:?PUBLISH_CREDENTIAL_FILE is required}"
publication_file="${PUBLISH_CONFIG_FILE:?PUBLISH_CONFIG_FILE is required}"
query_db_dir="${PUBLISH_QUERY_DB_DIR:?PUBLISH_QUERY_DB_DIR is required}"
data_root="${PUBLISH_DATA_ROOT:?PUBLISH_DATA_ROOT is required}"
service_user="${PUBLISH_SERVICE_USER:?PUBLISH_SERVICE_USER is required}"
publication_root="$data_root/publication/${county}/${watermark}"

[[ "$(stat -c %a "$credential_file")" == "600" ]]
[[ "$(stat -c %U "$credential_file")" == "$service_user" ]]

set -a
# shellcheck disable=SC1090
source "$credential_file"
# shellcheck disable=SC1090
source "$publication_file"
set +a

: "${FILEBASE_S3_ENDPOINT:?FILEBASE_S3_ENDPOINT is required}"
: "${OPEN_DATA_BUCKET:?OPEN_DATA_BUCKET is required}"
: "${OPEN_DATA_IPNS_LABEL:?OPEN_DATA_IPNS_LABEL is required}"
: "${QUERY_TABLE_BUCKET:?QUERY_TABLE_BUCKET is required}"
: "${QUERY_TABLE_IPNS_LABEL:?QUERY_TABLE_IPNS_LABEL is required}"
: "${COVERAGE_BUCKET:?COVERAGE_BUCKET is required}"
: "${COVERAGE_IPNS_LABEL:?COVERAGE_IPNS_LABEL is required}"

if [[ "$FILEBASE_S3_ENDPOINT" != "https://s3.filebase.com" ]]; then
  printf 'Only the documented Filebase S3 endpoint is allowed\n' >&2
  exit 1
fi

export S3_ENDPOINT="$FILEBASE_S3_ENDPOINT"
export S3_ACCESS_KEY_ID="$FILEBASE_ACCESS_KEY"
export S3_SECRET_ACCESS_KEY="$FILEBASE_SECRET_KEY"
export FILEBASE_API_TOKEN
FILEBASE_API_TOKEN="$(
  printf '%s:%s' "$FILEBASE_ACCESS_KEY" "$FILEBASE_SECRET_KEY" | base64 | tr -d '\n'
)"
unset FILEBASE_ACCESS_KEY FILEBASE_SECRET_KEY

cd "$query_db_dir"

S3_BUCKET="$OPEN_DATA_BUCKET" \
FILEBASE_IPNS_LABEL="$OPEN_DATA_IPNS_LABEL" \
npm run publish:ipfs-upload -- \
  --export-dir "$publication_root/property" \
  --concurrency 16 \
  --force-index

S3_BUCKET="$QUERY_TABLE_BUCKET" \
FILEBASE_QUERY_TABLE_IPNS_LABEL="$QUERY_TABLE_IPNS_LABEL" \
npm run publish:query-table -- \
  --county "$county" \
  --parquet "$publication_root/query/$county/query-table.parquet"

S3_BUCKET="$COVERAGE_BUCKET" \
FILEBASE_COVERAGE_IPNS_LABEL="$COVERAGE_IPNS_LABEL" \
npm run publish:coverage -- \
  --county "$county" \
  --coverage "$publication_root/coverage/dataset-coverage.json"

printf '{"event":"publication_remote_verified","watermark":"%s","propertyCount":65806}\n' \
  "$watermark"
