#!/usr/bin/env bash
# Build, package and deploy the stack with nothing but the AWS CLI.
set -euo pipefail

cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-ap-southeast-4}"
STACK="${STACK_NAME:-threads-deleter}"
BUILD_DIR=".build/app"

: "${THREADS_APP_ID:?set THREADS_APP_ID}"
: "${THREADS_APP_SECRET:?set THREADS_APP_SECRET}"
: "${STATE_SECRET:?set STATE_SECRET (openssl rand -hex 32)}"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${ARTIFACT_BUCKET:-threads-deleter-artifacts-${ACCOUNT}-${REGION}}"

if ! aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "Creating artifact bucket $BUCKET"
  aws s3api create-bucket \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
  aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
    --lifecycle-configuration '{"Rules":[{"ID":"expire-old-artifacts","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":30}}]}'
fi

echo "Building $BUILD_DIR"
rm -rf .build
mkdir -p "$BUILD_DIR"
cp -R src "$BUILD_DIR/"
cp package.json package-lock.json "$BUILD_DIR/"
( cd "$BUILD_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null )
rm -f "$BUILD_DIR/package.json" "$BUILD_DIR/package-lock.json"

echo "Packaging"
aws cloudformation package \
  --template-file infra/template.yaml \
  --s3-bucket "$BUCKET" \
  --s3-prefix "$STACK" \
  --output-template-file .build/packaged.yaml \
  --region "$REGION" >/dev/null

echo "Deploying $STACK to $REGION"
aws cloudformation deploy \
  --template-file .build/packaged.yaml \
  --stack-name "$STACK" \
  --capabilities CAPABILITY_IAM \
  --region "$REGION" \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "ThreadsAppId=$THREADS_APP_ID" \
    "ThreadsAppSecret=$THREADS_APP_SECRET" \
    "StateSecret=$STATE_SECRET" \
    "RedirectUri=${REDIRECT_URI:-}" \
    "ThreadsScope=${THREADS_SCOPE:-}" \
    "CustomDomainName=${CUSTOM_DOMAIN_NAME:-}" \
    "CertificateArn=${CERTIFICATE_ARN:-}"

aws cloudformation describe-stacks \
  --stack-name "$STACK" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs' \
  --output table
