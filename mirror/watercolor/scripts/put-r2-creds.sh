#!/usr/bin/env bash
# put-r2-creds.sh — store R2 credentials in AWS SSM Parameter Store so
# the EC2 build instance can fetch them at upload time without ever
# touching a file on disk. Run this once from your local machine after
# generating the R2 API token in the Cloudflare dashboard.
#
# Reads the secret values from interactive prompts (-s = no echo) so
# they don't end up in shell history or `ps` output. The account ID is
# not a secret and is read non-silently for visual confirmation.
#
# Usage:
#   AWS_PROFILE=eukarya ./put-r2-creds.sh
#
# Optional env:
#   SSM_PREFIX  default: /reearth-papers/watercolor
#   AWS_REGION  default: us-east-1

set -euo pipefail

ssm_prefix="${SSM_PREFIX:-/reearth-papers/watercolor}"
region="${AWS_REGION:-us-east-1}"

read -rp "Cloudflare account ID: " account_id
read -rsp "R2 access key ID: " access_key_id; echo
read -rsp "R2 secret access key: " secret_access_key; echo

put() {
  local name="$1" value="$2" type="$3"
  aws ssm put-parameter \
    --region "$region" \
    --name "$name" \
    --value "$value" \
    --type "$type" \
    --overwrite >/dev/null
  echo "  ✓ $name ($type)"
}

echo "writing to ${ssm_prefix} in ${region} …"
put "${ssm_prefix}/r2-account-id"        "$account_id"        String
put "${ssm_prefix}/r2-access-key-id"     "$access_key_id"     SecureString
put "${ssm_prefix}/r2-secret-access-key" "$secret_access_key" SecureString

cat <<EOF

done. To remove these later (e.g. once the upload is finished):

  aws ssm delete-parameters --region $region --names \\
    ${ssm_prefix}/r2-account-id \\
    ${ssm_prefix}/r2-access-key-id \\
    ${ssm_prefix}/r2-secret-access-key
EOF
