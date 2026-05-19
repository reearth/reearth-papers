#!/usr/bin/env bash
# upload-r2.sh — push the finished watercolor.pmtiles to Cloudflare R2.
#
# Uses the AWS CLI against R2's S3-compatible endpoint. AWS CLI handles
# multipart upload automatically for large files; tune the multipart
# threshold so we use generous part sizes (R2 caps total parts at 10k,
# matching S3).
#
# Credentials can be supplied either of two ways:
#   1. Direct via env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#   2. Fetched from SSM Parameter Store (preferred on EC2). Set
#      SSM_PREFIX (default: /reearth-papers/watercolor) — the script
#      reads {prefix}/r2-account-id, r2-access-key-id (SecureString),
#      r2-secret-access-key (SecureString). The instance's IAM role
#      needs ssm:GetParameters + kms:Decrypt; see watercolor/README.md.
#
# Optional env:
#   R2_BUCKET             default: reearth-papers
#   R2_KEY                default: mirror/watercolor/v1.pmtiles

set -euo pipefail

src="${1:?usage: upload-r2.sh <path-to-watercolor.pmtiles>}"

# Resolve credentials. Direct env wins; fall back to SSM lookup. We
# intentionally don't merge the two — pick one source so it's clear
# in logs which path was taken.
if [[ -n "${R2_ACCESS_KEY_ID:-}" ]]; then
  : "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required when R2_ACCESS_KEY_ID is set}"
  : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required when R2_ACCESS_KEY_ID is set}"
  echo "[upload-r2] using R2 credentials from environment"
else
  ssm_prefix="${SSM_PREFIX:-/reearth-papers/watercolor}"
  region="${AWS_REGION:-us-east-1}"
  echo "[upload-r2] fetching R2 credentials from SSM (${ssm_prefix}, region=${region})"
  # One call, three params — cheaper than three GetParameter calls and
  # all-or-nothing failure mode is what we want here.
  ssm_json=$(aws ssm get-parameters \
    --region "$region" \
    --with-decryption \
    --names \
      "${ssm_prefix}/r2-account-id" \
      "${ssm_prefix}/r2-access-key-id" \
      "${ssm_prefix}/r2-secret-access-key" \
    --query 'Parameters[*].[Name,Value]' --output text)
  while IFS=$'\t' read -r name value; do
    case "$name" in
      */r2-account-id)        R2_ACCOUNT_ID="$value" ;;
      */r2-access-key-id)     R2_ACCESS_KEY_ID="$value" ;;
      */r2-secret-access-key) R2_SECRET_ACCESS_KEY="$value" ;;
    esac
  done <<<"$ssm_json"
  : "${R2_ACCOUNT_ID:?missing ${ssm_prefix}/r2-account-id in SSM}"
  : "${R2_ACCESS_KEY_ID:?missing ${ssm_prefix}/r2-access-key-id in SSM}"
  : "${R2_SECRET_ACCESS_KEY:?missing ${ssm_prefix}/r2-secret-access-key in SSM}"
fi

bucket="${R2_BUCKET:-reearth-papers}"
key="${R2_KEY:-mirror/watercolor/v1.pmtiles}"
endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# Set AWS credentials in this shell only (subshells inherit). The host
# EC2's IAM role is used solely for the SSM lookup above; from here on
# we authenticate directly to R2 with the access key pair.
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
unset AWS_SESSION_TOKEN  # in case an IAM-role-assumed session was active
export AWS_DEFAULT_REGION="auto"

# 64 MiB multipart parts: at ~800 GB total we get ~12,800 parts,
# safely under R2's 10,000-part cap once we add the rounding. If the
# file is smaller this just falls back to a smaller part count.
aws s3 cp "$src" "s3://${bucket}/${key}" \
  --endpoint-url "$endpoint" \
  --cli-read-timeout 0 \
  --cli-connect-timeout 60 \
  --expected-size "$(stat -c %s "$src" 2>/dev/null || stat -f %z "$src")" \
  --metadata "source=long-term.cache.maps.stamen.com/watercolor"

echo "uploaded to s3://${bucket}/${key}"
