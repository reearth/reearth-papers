#!/usr/bin/env bash
# terminate-ec2.sh — tear down the build instance and its attached EBS.
# Both root and data volumes are marked DeleteOnTermination so this is
# the only cleanup needed.

set -euo pipefail

: "${AWS_PROFILE:?AWS_PROFILE is required}"

instance_id="${1:?usage: terminate-ec2.sh <instance-id>}"
REGION="us-east-1"

aws ec2 terminate-instances --region "$REGION" --instance-ids "$instance_id" >/dev/null
aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$instance_id"
echo "terminated $instance_id"
