#!/usr/bin/env bash
# Build + push the shared reload image to ECR, then deploy the incremental-county stack.
#
# ONE image (Dockerfile.reload) carries BOTH entrypoints:
#   scripts/reload-appraisal-entrypoint.sh   (the incremental load task)
#   scripts/query-table-publish-entrypoint.sh (the publish task)
#
# Usage:
#   AWS_PROFILE=elephant-oracle-node \
#   DATABASE_URL_SECRET_ARN=arn:aws:secretsmanager:...:secret:query-db-direct-url \
#   PUBLISH_CREDS_SECRET_ARN=arn:aws:secretsmanager:...:secret:filebase-publish-creds \
#   SUBNET_IDS=subnet-0f1d2efb1cf3a92e5 \
#   SECURITY_GROUP_ID=sg-xxxx \
#   ./deploy.sh
#
# Re-points the SAME stack each run; the image tag is the short git sha.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK_NAME:-incremental-county-stack}"
REPO="${ECR_REPO:-incremental-county}"
: "${DATABASE_URL_SECRET_ARN:?set DATABASE_URL_SECRET_ARN}"
: "${PUBLISH_CREDS_SECRET_ARN:?set PUBLISH_CREDS_SECRET_ARN (JSON secret with the 5 Filebase keys)}"
: "${SUBNET_IDS:?set SUBNET_IDS (comma-separated)}"
: "${SECURITY_GROUP_ID:?set SECURITY_GROUP_ID}"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ECR_HOST="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
TAG="$(git -C "$(dirname "$0")/../.." rev-parse --short HEAD 2>/dev/null || echo latest)"
IMAGE_URI="${ECR_HOST}/${REPO}:${TAG}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"  # elephant-query-db

echo ">> ensure ECR repo"
aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$REGION" >/dev/null

echo ">> docker login + build + push ($IMAGE_URI)"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_HOST"
docker build --platform linux/amd64 -f "$REPO_ROOT/Dockerfile.reload" -t "$IMAGE_URI" "$REPO_ROOT"
docker push "$IMAGE_URI"

echo ">> sam deploy"
sam deploy \
  --template-file "$(dirname "$0")/template.yaml" \
  --stack-name "$STACK" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --parameter-overrides \
    ImageUri="$IMAGE_URI" \
    DatabaseUrlSecretArn="$DATABASE_URL_SECRET_ARN" \
    PublishCredsSecretArn="$PUBLISH_CREDS_SECRET_ARN" \
    SubnetIds="$SUBNET_IDS" \
    SecurityGroupId="$SECURITY_GROUP_ID"

ARN="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" --output text)"

echo ">> done. Start a self-looping run with (Palm Beach example):"
cat <<EOF
   aws stepfunctions start-execution \\
     --state-machine-arn $ARN \\
     --input '{
       "county": "palm_beach",
       "jurisdictionKey": "palm_beach_appraiser",
       "appraisalPrefix": "outputs/palm-beach-property-first-seed/palm-beach-fullcounty-20260705/",
       "expectLetterStraps": "0",
       "seedTotal": 644139,
       "statusBucket": "elephant-oracle-node-environmentbucket-mmsoo3xbdi80",
       "statusKey": "incremental-status/palm_beach/status.json",
       "feederStateBucket": "elephant-oracle-node-environmentbucket-mmsoo3xbdi80",
       "feederStateKey": "permit-harvest/palm-beach-property-first-seed-all-20260705/feeder-state.json",
       "waitSeconds": 900
     }'
EOF
