#!/usr/bin/env bash
# Build + push the reload image to ECR, then deploy the SAM stack.
#
# Usage:
#   AWS_PROFILE=elephant-oracle-node \
#   DATABASE_URL_SECRET_ARN=arn:aws:secretsmanager:...:secret:query-db-direct-url \
#   SUBNET_IDS=subnet-0f1d2efb1cf3a92e5 \
#   SECURITY_GROUP_ID=sg-xxxx \
#   ./deploy.sh
#
# Re-points the SAME stack each run; the image tag is the short git sha.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK_NAME:-appraisal-reload-stack}"
REPO="${ECR_REPO:-appraisal-reload}"
: "${DATABASE_URL_SECRET_ARN:?set DATABASE_URL_SECRET_ARN}"
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
    SubnetIds="$SUBNET_IDS" \
    SecurityGroupId="$SECURITY_GROUP_ID"

echo ">> done. Start a run with:"
echo "   aws stepfunctions start-execution --state-machine-arn \$(aws cloudformation describe-stacks --stack-name $STACK --query \"Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue\" --output text)"
