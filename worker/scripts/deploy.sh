#!/usr/bin/env bash
# Deploy the papers-tile worker + its container, then wait for the
# container rollout to finish so the deploy step doesn't return "green"
# while the old image is still serving traffic.
#
# Adapted from eukachan/scripts/deploy.sh.

set -euo pipefail

# Worker + container class names — must match wrangler.toml. Cloudflare
# names the deployed container `<worker_name>-<class_name_lowercase>`.
WORKER_NAME="papers-tile-worker"
CONTAINER_CLASS="tilecontainer"
CONTAINER_NAME="${WORKER_NAME}-${CONTAINER_CLASS}"

echo "▶ wrangler deploy"
# `--containers-rollout immediate` skips the default gradual rollout. For
# a stateless tile renderer, instant cutover is fine and gives us a
# deterministic moment to wait for.
DEPLOY_OUTPUT=$(npx wrangler deploy --containers-rollout immediate 2>&1) || {
  echo "$DEPLOY_OUTPUT"
  echo "❌ wrangler deploy failed"
  exit 1
}
echo "$DEPLOY_OUTPUT"

# If wrangler reported no container image change, the rollout step is a
# no-op — skip the poll loop entirely.
if echo "$DEPLOY_OUTPUT" | grep -qiE "no changes to be made|no changes"; then
  echo "✅ No container changes; rollout wait skipped."
  exit 0
fi

# The wrangler deploy log line looks like:
#   ... papers-tile-worker-tilecontainer:abcdef0123 ...
# We extract the trailing image tag (a git-sha-like hex) and poll
# `wrangler containers info` until that tag is the live one.
DEPLOYED_TAG=$(echo "$DEPLOY_OUTPUT" \
  | grep -oE "${CONTAINER_NAME}:[a-f0-9]+" \
  | tail -1 \
  | cut -d: -f2)

if [ -z "${DEPLOYED_TAG}" ]; then
  echo "⚠️  Could not parse deployed image tag from wrangler output; skipping rollout wait."
  exit 0
fi

echo "▶ Waiting for container rollout (tag: ${DEPLOYED_TAG})"

# `wrangler containers list` is a unicode-bordered table; grab the ID
# column (the first column, between the first two │ characters).
CONTAINER_ID=$(npx wrangler containers list 2>&1 \
  | grep "${CONTAINER_NAME}" \
  | awk -F'│' '{print $2}' \
  | tr -d ' ' \
  | head -1)

if [ -z "${CONTAINER_ID}" ]; then
  echo "⚠️  Could not find container ID for ${CONTAINER_NAME}; skipping rollout wait."
  exit 0
fi

# Poll for up to 20 minutes (120 × 10s). New-container provisioning on
# Cloudflare side can take a while the first time (image pull + tier
# placement); steady-state rollouts of an existing container are usually
# under a minute.
ROLLOUT_MAX_ATTEMPTS=120
for i in $(seq 1 "${ROLLOUT_MAX_ATTEMPTS}"); do
  CONTAINER_INFO=$(npx wrangler containers info "${CONTAINER_ID}" 2>&1)
  if echo "${CONTAINER_INFO}" | grep -q "${DEPLOYED_TAG}"; then
    echo "✅ Container rollout complete (${DEPLOYED_TAG})"
    exit 0
  fi
  if [ "$i" -eq "${ROLLOUT_MAX_ATTEMPTS}" ]; then
    echo "⚠️  Container rollout timed out after $((ROLLOUT_MAX_ATTEMPTS * 10 / 60)) minutes"
    exit 1
  fi
  echo "  Waiting... (${i}/${ROLLOUT_MAX_ATTEMPTS})"
  sleep 10
done
