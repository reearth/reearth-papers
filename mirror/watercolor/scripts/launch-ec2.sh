#!/usr/bin/env bash
# launch-ec2.sh — spawn a one-shot c6i.2xlarge in us-east-1 wired up
# for the watercolor build. Prints the instance ID and an SSH command
# on success.
#
# Required env:
#   AWS_PROFILE         (e.g. eukarya — set in your shell)
#
# Auto-resolved (override via env if you want non-default names):
#   KEY_NAME              default: watercolor-build (created by setup-aws-resources.sh)
#   IAM_INSTANCE_PROFILE  default: watercolor-build
#   SECURITY_GROUP_ID     default: looked up by name `watercolor-build` in the default VPC
#   SUBNET_ID             default: first subnet in the default VPC
#
# If any of the auto-resolved resources don't exist this script tells
# you to run setup-aws-resources.sh first rather than guessing.
#
# Spot vs on-demand: this launches on-demand by default to keep the
# build resumable without juggling spot interruptions. If you want
# spot, add `--instance-market-options ...` to the run-instances call.

set -euo pipefail

: "${AWS_PROFILE:?AWS_PROFILE is required}"

# Export region so every `aws` call picks it up — using a wrapper
# function here trips a known `set -e` + function-in-`if`-condition
# bash bug that causes early exit on the first non-existent resource.
export AWS_REGION="${AWS_REGION:-us-east-1}"
REGION="$AWS_REGION"
NAME_DEFAULT="watercolor-build"
INSTANCE_TYPE="${INSTANCE_TYPE:-c6i.2xlarge}"
VOLUME_SIZE_GIB="${VOLUME_SIZE_GIB:-2000}"  # 2 TB data volume

KEY_NAME="${KEY_NAME:-$NAME_DEFAULT}"
IAM_INSTANCE_PROFILE="${IAM_INSTANCE_PROFILE:-$NAME_DEFAULT}"

# Amazon Linux 2023 — looked up via SSM parameter so we always get the
# region-current AMI without hardcoding an ID that ages out.
AMI_PARAM="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_DATA="$SCRIPT_DIR/ec2-bootstrap.sh"

#------------------------------------------------------------------------
# Pre-flight: verify the four resources exist; emit clear error if not.
#------------------------------------------------------------------------
missing=()

aws ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1 \
  || missing+=("EC2 key pair '$KEY_NAME'")

aws iam get-instance-profile --instance-profile-name "$IAM_INSTANCE_PROFILE" >/dev/null 2>&1 \
  || missing+=("IAM instance profile '$IAM_INSTANCE_PROFILE'")

vpc_id=$(aws ec2 describe-vpcs \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
if [[ -z "$vpc_id" || "$vpc_id" == "None" ]]; then
  echo "❌ no default VPC in $REGION" >&2
  exit 1
fi

if [[ -z "${SECURITY_GROUP_ID:-}" ]]; then
  SECURITY_GROUP_ID=$(aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=$NAME_DEFAULT" "Name=vpc-id,Values=$vpc_id" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
fi
[[ -z "$SECURITY_GROUP_ID" || "$SECURITY_GROUP_ID" == "None" ]] \
  && missing+=("security group '$NAME_DEFAULT' in $vpc_id")

if [[ -z "${SUBNET_ID:-}" ]]; then
  # Pick a default subnet in an AZ that actually offers our instance
  # type — `us-east-1e` etc. lack newer generations like c6i.
  supported_azs=$(aws ec2 describe-instance-type-offerings \
    --location-type availability-zone \
    --filters "Name=instance-type,Values=$INSTANCE_TYPE" \
    --query 'InstanceTypeOfferings[].Location' --output text)
  if [[ -z "$supported_azs" ]]; then
    echo "❌ $INSTANCE_TYPE not offered in any AZ of $REGION" >&2
    exit 1
  fi
  # Build a `Values=us-east-1a,us-east-1b,…` filter to match only those AZs.
  az_csv=$(echo "$supported_azs" | tr '[:space:]' ',' | sed 's/,$//')
  SUBNET_ID=$(aws ec2 describe-subnets \
    --filters \
      "Name=vpc-id,Values=$vpc_id" \
      "Name=default-for-az,Values=true" \
      "Name=availability-zone,Values=$az_csv" \
    --query 'Subnets[0].SubnetId' --output text)
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "❌ missing AWS resources:" >&2
  for m in "${missing[@]}"; do echo "   - $m" >&2; done
  echo "" >&2
  echo "run ./setup-aws-resources.sh first (it creates everything idempotently)." >&2
  exit 1
fi

ami_id=$(aws ssm get-parameter \
  --name "$AMI_PARAM" \
  --query 'Parameter.Value' --output text)

cat <<EOF
▶ launching with:
  AMI:              $ami_id
  instance type:    $INSTANCE_TYPE
  data volume:      ${VOLUME_SIZE_GIB} GiB gp3
  key pair:         $KEY_NAME
  instance profile: $IAM_INSTANCE_PROFILE
  security group:   $SECURITY_GROUP_ID
  subnet:           $SUBNET_ID
EOF

# Build the block device mapping: root 30 GiB + data 2 TB gp3.
block_devices=$(cat <<JSON
[
  {"DeviceName": "/dev/xvda", "Ebs": {"VolumeSize": 30, "VolumeType": "gp3", "DeleteOnTermination": true}},
  {"DeviceName": "/dev/sdb",  "Ebs": {"VolumeSize": $VOLUME_SIZE_GIB, "VolumeType": "gp3", "DeleteOnTermination": true, "Iops": 6000, "Throughput": 250}}
]
JSON
)

instance_id=$(aws ec2 run-instances \
  --image-id "$ami_id" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --user-data "file://$USER_DATA" \
  --block-device-mappings "$block_devices" \
  --iam-instance-profile "Name=$IAM_INSTANCE_PROFILE" \
  --security-group-ids "$SECURITY_GROUP_ID" \
  --subnet-id "$SUBNET_ID" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=watercolor-build},{Key=Project,Value=reearth-papers}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "instance: $instance_id"

echo "waiting for instance to enter running state …"
aws ec2 wait instance-running --instance-ids "$instance_id"

public_dns=$(aws ec2 describe-instances \
  --instance-ids "$instance_id" \
  --query 'Reservations[0].Instances[0].PublicDnsName' --output text)

key_path="$HOME/.ssh/${KEY_NAME}.pem"
cat <<EOF

ready.
  instance:  $instance_id
  ssh:       ssh -i $key_path ec2-user@$public_dns
  terminate: ./terminate-ec2.sh $instance_id

bootstrap is running async via user-data; wait ~3 min before SSH'ing
in, then check /var/log/cloud-init-output.log for progress.
EOF
