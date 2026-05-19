#!/usr/bin/env bash
# setup-aws-resources.sh — create (or reuse) the AWS resources the
# watercolor build EC2 needs:
#
#   - IAM role + instance profile granting S3 (requester-pays read on
#     long-term.cache.maps.stamen.com) + SSM read + KMS decrypt
#   - EC2 key pair (private key saved to ~/.ssh/watercolor-build.pem)
#   - Security group allowing SSH from the caller's current public IP
#
# All operations are idempotent: re-running this script after a prior
# run is safe and just re-uses existing resources. Run once before
# `launch-ec2.sh`.
#
# Usage:
#   AWS_PROFILE=eukarya ./setup-aws-resources.sh
#
# Outputs the resource names that launch-ec2.sh expects (as env vars
# you can copy-paste, or just re-run launch-ec2.sh which uses the
# same defaults).

set -euo pipefail

# Export region so every `aws` call picks it up — using a wrapper
# function here trips a known `set -e` + function-in-`if`-condition
# bash bug that causes early exit on the first non-existent resource.
export AWS_REGION="${AWS_REGION:-us-east-1}"
REGION="$AWS_REGION"
NAME="${RESOURCE_NAME:-watercolor-build}"
KEY_PATH="${KEY_PATH:-$HOME/.ssh/${NAME}.pem}"

# Resource names — predictable defaults so launch-ec2.sh can find them
# without env-var passing.
IAM_ROLE_NAME="${NAME}"
IAM_PROFILE_NAME="${NAME}"
SG_NAME="${NAME}"
KEY_NAME="${NAME}"

#------------------------------------------------------------------------
# 0. Sanity: which account are we touching?
#------------------------------------------------------------------------
ident=$(aws sts get-caller-identity --query 'Arn' --output text)
account=$(aws sts get-caller-identity --query 'Account' --output text)
echo "▶ acting as $ident (account $account, region $REGION)"

#------------------------------------------------------------------------
# 1. IAM role + instance profile
#------------------------------------------------------------------------
trust_policy=$(cat <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
)

inline_policy=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StamenWatercolorRead",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::long-term.cache.maps.stamen.com",
        "arn:aws:s3:::long-term.cache.maps.stamen.com/*"
      ]
    },
    {
      "Sid": "R2CredsFromSSM",
      "Effect": "Allow",
      "Action": ["ssm:GetParameters", "ssm:GetParametersByPath"],
      "Resource": "arn:aws:ssm:${REGION}:${account}:parameter/reearth-papers/watercolor/*"
    },
    {
      "Sid": "SsmDecrypt",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "*",
      "Condition": {
        "StringEquals": {"kms:ViaService": "ssm.${REGION}.amazonaws.com"}
      }
    }
  ]
}
JSON
)

if aws iam get-role --role-name "$IAM_ROLE_NAME" >/dev/null 2>&1; then
  echo "✓ IAM role exists: $IAM_ROLE_NAME"
else
  echo "▶ creating IAM role: $IAM_ROLE_NAME"
  aws iam create-role \
    --role-name "$IAM_ROLE_NAME" \
    --assume-role-policy-document "$trust_policy" \
    --description "watercolor build EC2 - see mirror/watercolor/scripts/setup-aws-resources.sh" \
    >/dev/null
fi

# put-role-policy is idempotent (replaces if already present) so we
# always run it — that way policy edits in this script propagate.
aws iam put-role-policy \
  --role-name "$IAM_ROLE_NAME" \
  --policy-name "${NAME}-policy" \
  --policy-document "$inline_policy"
echo "✓ inline policy applied"

if aws iam get-instance-profile --instance-profile-name "$IAM_PROFILE_NAME" >/dev/null 2>&1; then
  echo "✓ instance profile exists: $IAM_PROFILE_NAME"
else
  echo "▶ creating instance profile: $IAM_PROFILE_NAME"
  aws iam create-instance-profile --instance-profile-name "$IAM_PROFILE_NAME" >/dev/null
fi

# add-role-to-instance-profile fails if the role is already attached, so
# probe first.
attached=$(aws iam get-instance-profile \
  --instance-profile-name "$IAM_PROFILE_NAME" \
  --query 'InstanceProfile.Roles[].RoleName' --output text)
if [[ "$attached" != *"$IAM_ROLE_NAME"* ]]; then
  echo "▶ attaching role to instance profile"
  aws iam add-role-to-instance-profile \
    --instance-profile-name "$IAM_PROFILE_NAME" \
    --role-name "$IAM_ROLE_NAME"
fi

#------------------------------------------------------------------------
# 2. EC2 key pair
#------------------------------------------------------------------------
if aws ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
  echo "✓ key pair exists in AWS: $KEY_NAME"
  if [[ ! -f "$KEY_PATH" ]]; then
    echo "  ⚠ but local file $KEY_PATH is missing — AWS won't let us"
    echo "    re-export the private key. Delete the key pair in EC2 and"
    echo "    re-run this script to regenerate, or restore from a backup."
  fi
else
  echo "▶ creating key pair: $KEY_NAME → $KEY_PATH"
  mkdir -p "$(dirname "$KEY_PATH")"
  aws ec2 create-key-pair \
    --key-name "$KEY_NAME" \
    --key-type ed25519 \
    --query 'KeyMaterial' --output text >"$KEY_PATH"
  chmod 600 "$KEY_PATH"
fi

#------------------------------------------------------------------------
# 3. Security group (default VPC, SSH from caller's current IP)
#------------------------------------------------------------------------
vpc_id=$(aws ec2 describe-vpcs \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
if [[ -z "$vpc_id" || "$vpc_id" == "None" ]]; then
  echo "❌ no default VPC in $REGION — create one or set SUBNET_ID manually" >&2
  exit 1
fi

sg_id=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$vpc_id" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [[ -z "$sg_id" || "$sg_id" == "None" ]]; then
  echo "▶ creating security group: $SG_NAME in $vpc_id"
  sg_id=$(aws ec2 create-security-group \
    --group-name "$SG_NAME" \
    --description "watercolor build EC2 - SSH from operator IP" \
    --vpc-id "$vpc_id" \
    --query 'GroupId' --output text)
else
  echo "✓ security group exists: $sg_id"
fi

# Look up the caller's current public IP and authorize SSH from it.
# `checkip.amazonaws.com` is a tiny AWS-served endpoint that returns
# just the requesting IP — cheaper than parsing ifconfig.me etc.
my_ip=$(curl -fsSL https://checkip.amazonaws.com | tr -d '[:space:]')
cidr="${my_ip}/32"
if aws ec2 describe-security-groups --group-ids "$sg_id" \
    --query 'SecurityGroups[0].IpPermissions[?ToPort==`22`].IpRanges[].CidrIp' \
    --output text | grep -qw "$cidr"; then
  echo "✓ SSH from $cidr already allowed"
else
  echo "▶ authorizing SSH ingress from $cidr"
  aws ec2 authorize-security-group-ingress \
    --group-id "$sg_id" \
    --protocol tcp --port 22 --cidr "$cidr" >/dev/null
fi

#------------------------------------------------------------------------
# Done — print what launch-ec2.sh needs
#------------------------------------------------------------------------
cat <<EOF

ready. launch-ec2.sh will pick these up by default (same names):
  IAM_INSTANCE_PROFILE  $IAM_PROFILE_NAME
  KEY_NAME              $KEY_NAME             ($KEY_PATH)
  SECURITY_GROUP_ID     $sg_id

next:
  ./launch-ec2.sh
EOF
