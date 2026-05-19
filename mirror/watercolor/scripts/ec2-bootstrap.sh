#!/usr/bin/env bash
# ec2-bootstrap.sh — user-data script that prepares a freshly launched
# c6i.2xlarge for the watercolor build. Runs once at instance start.
#
# Responsibilities:
#   1. Install Go and rclone.
#   2. Format and mount the attached 2 TB gp3 volume at /data.
#   3. Clone reearth-papers and `go build` the builder binary.
#
# The actual `builder list` / `builder build` invocations are NOT run
# here — they're triggered manually after `ssh` so the operator can
# verify the box and adjust flags. See watercolor/README.md.

set -euo pipefail

GO_VERSION="1.23.4"
DATA_DEVICE="/dev/nvme1n1"        # 2 TB EBS attached as 2nd NVMe
DATA_MOUNT="/data"
REPO_URL="https://github.com/reearth/reearth-papers.git"
REPO_DIR="/home/ec2-user/reearth-papers"

log() { echo "[$(date -u +%FT%TZ)] $*" >&2; }

#------------------------------------------------------------------------
# 1. System packages
#------------------------------------------------------------------------
log "installing base packages"
dnf install -y git tar gcc unzip jq

#------------------------------------------------------------------------
# 2. Go
#------------------------------------------------------------------------
if ! command -v /usr/local/go/bin/go >/dev/null; then
  log "installing Go ${GO_VERSION}"
  curl -fsSLO "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "go${GO_VERSION}.linux-amd64.tar.gz"
  rm "go${GO_VERSION}.linux-amd64.tar.gz"
fi
echo 'export PATH=$PATH:/usr/local/go/bin' > /etc/profile.d/go.sh

#------------------------------------------------------------------------
# 3. rclone (used by upload-r2.sh)
#------------------------------------------------------------------------
if ! command -v rclone >/dev/null; then
  log "installing rclone"
  curl -fsSL https://rclone.org/install.sh | bash
fi

#------------------------------------------------------------------------
# 4. Data volume
#------------------------------------------------------------------------
if [[ -b "$DATA_DEVICE" ]]; then
  if ! blkid "$DATA_DEVICE" >/dev/null 2>&1; then
    log "formatting $DATA_DEVICE as xfs"
    mkfs.xfs -f "$DATA_DEVICE"
  fi
  mkdir -p "$DATA_MOUNT"
  if ! mountpoint -q "$DATA_MOUNT"; then
    log "mounting $DATA_DEVICE at $DATA_MOUNT"
    mount "$DATA_DEVICE" "$DATA_MOUNT"
  fi
  chown ec2-user:ec2-user "$DATA_MOUNT"
else
  log "WARNING: data device $DATA_DEVICE not found; falling back to root volume"
  mkdir -p "$DATA_MOUNT"
  chown ec2-user:ec2-user "$DATA_MOUNT"
fi

#------------------------------------------------------------------------
# 5. Build the builder binary as ec2-user
#------------------------------------------------------------------------
sudo -u ec2-user -i bash <<EOF
set -euo pipefail
export PATH="\$PATH:/usr/local/go/bin"
if [[ ! -d "$REPO_DIR" ]]; then
  git clone --depth 1 "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR/mirror/watercolor/builder"
go mod tidy
go build -o /home/ec2-user/builder .
EOF

log "bootstrap complete. SSH in and run: ./builder list ..."
