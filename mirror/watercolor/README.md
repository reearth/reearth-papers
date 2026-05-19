# watercolor

One-shot pipeline that snapshots Stamen's Watercolor raster tiles from the
upstream `long-term.cache.maps.stamen.com` S3 bucket into a single
PMTiles archive in R2. The archive is then served as `/watercolor/{z}/{x}/{y}.jpg`
by the root `reearth-papers` Worker (see `../../src/watercolor.ts`).

Unlike its sibling `../protomaps/` (which re-runs monthly to track
upstream Protomaps builds via a Cloudflare Workflow), this is
**build once and forget** — Watercolor is a frozen historical raster
set, donated to the Smithsonian. Building runs on a one-shot EC2
instance in `us-east-1` (same region as the upstream S3 bucket, so
intra-region transfer is free). The output is a single immutable
`v1.pmtiles` object in the shared `reearth-papers` R2 bucket under
the `mirror/watercolor/` prefix.

## Upstream facts

- Bucket: `s3://long-term.cache.maps.stamen.com/watercolor/{z}/{x}/{y}.jpg`
- Region: `us-east-1`
- Mode: **requester-pays** (set `--request-payer requester`)
- Total tiles: ~56M (sparse — only locations that were ever requested
  during Stamen's hosting era are cached; high-zoom rural tiles return
  403/404)
- Average tile size: ~16 KB JPEG
- Generated: 2016 onwards, frozen since the Stadia / Cooper Hewitt
  handover

## Output

- Object: `s3://reearth-papers/mirror/watercolor/v1.pmtiles` (R2)
- Expected size: ~600–800 GB after PMTiles tile dedup
- Tile compression: none (JPEG bytes are already compressed)
- Tile type: `MimeType=image/jpeg`, PMTiles `tile_type = 2` (jpeg)

## Cost (one-shot, us-east-1)

| Item                                              | Est.    |
|---------------------------------------------------|---------|
| S3 GET × 56M @ $0.0004 / 1k                       | $22     |
| S3 → EC2 transfer (same region)                   | $0      |
| EC2 c6i.2xlarge spot, 8 h                         | ~$2     |
| EBS gp3 2 TB × 8 h                                | ~$0.50  |
| EC2 → R2 egress (~700 GB) @ $0.09 / GB            | ~$63    |
| **Total**                                         | **~$90**|

Cloudflare R2 inbound and storage:

- Class A write ops (multipart parts, ~14k parts at 50 MiB) — trivial
- Storage at $0.015 / GB / mo × 700 GB = **~$10.5 / mo**
- Egress: **free** (R2's value prop)

## AWS resources

`setup-aws-resources.sh` (idempotent, run from your local machine once
before the first build) provisions everything the EC2 needs:

- IAM role + instance profile named `watercolor-build` with permissions
  for upstream S3 (requester-pays read on `long-term.cache.maps.stamen.com`),
  SSM read on `/reearth-papers/watercolor/*`, and the corresponding
  KMS Decrypt
- EC2 key pair named `watercolor-build`; private key written to
  `~/.ssh/watercolor-build.pem`
- Security group named `watercolor-build` in the default VPC, allowing
  SSH from your current public IP only

`launch-ec2.sh` looks these up by the same default names — no env vars
to pass. The R2 token never gives us cross-account write access here:
it's a Cloudflare API token whose Access Key ID / Secret are stored as
SecureStrings in SSM (see `put-r2-creds.sh`).

## Runbook

### 1. Pre-flight (local, run once before the first build)

```bash
export AWS_PROFILE=eukarya
cd mirror/watercolor/scripts

# 1a. Confirm bucket is reachable and tile sizes look right
aws s3api head-object \
  --bucket long-term.cache.maps.stamen.com \
  --key watercolor/0/0/0.jpg \
  --request-payer requester

# 1b. Create IAM role / instance profile / key pair / security group.
#     Idempotent — safe to re-run.
./setup-aws-resources.sh

# 1c. Generate an R2 API token in the Cloudflare dashboard
#     (R2 → Manage R2 API Tokens → Object Read & Write, scoped to
#      the reearth-papers bucket, with a short TTL), then push the
#     creds into SSM. The script prompts so the secret never lands
#     in shell history or `ps`.
./put-r2-creds.sh
```

### 2. Launch EC2

```bash
./launch-ec2.sh             # spawns c6i.2xlarge + 2 TB gp3 in us-east-1
```

The launcher prints the instance ID and SSH command. The bootstrap
script (`ec2-bootstrap.sh`) installs Go, builds the binary, and exits —
the actual run is triggered manually so you can inspect the box first.

### 3. Build PMTiles (on EC2)

```bash
# SSH in (the launcher prints the exact command)
ssh ec2-user@<ip>

# Phase 1: enumerate every object in the watercolor/ prefix. Output is a
# sorted manifest the builder can stream through deterministically.
./builder list \
  --bucket long-term.cache.maps.stamen.com \
  --prefix watercolor/ \
  --concurrency 64 \
  --out /data/manifest.tsv

# Phase 2: stream tiles into PMTiles in Hilbert tile-id order.
# Resumable: a checkpoint file is written every N tiles.
./builder build \
  --manifest /data/manifest.tsv \
  --bucket long-term.cache.maps.stamen.com \
  --concurrency 256 \
  --out /data/watercolor.pmtiles
```

### 4. Upload to R2

```bash
# Credentials are fetched from SSM automatically; no env setup needed
# on the box (the IAM role grants ssm:GetParameters + kms:Decrypt).
~/reearth-papers/mirror/watercolor/scripts/upload-r2.sh /data/watercolor.pmtiles
```

### 5. Verify, shut down, and rotate the credential

```bash
# Test the worker route
curl -I https://papers.reearth.land/watercolor/10/909/403.jpg

# Terminate the EC2 instance + detach EBS (both DeleteOnTermination)
./scripts/terminate-ec2.sh <instance-id>

# Remove the now-unused R2 creds from SSM so they can't be reused if
# the token leaks. The Cloudflare-side token should also be revoked
# via the dashboard for defense in depth.
aws ssm delete-parameters --profile eukarya --region us-east-1 --names \
  /reearth-papers/watercolor/r2-account-id \
  /reearth-papers/watercolor/r2-access-key-id \
  /reearth-papers/watercolor/r2-secret-access-key

# (Optional) tear down the IAM role / instance profile / key pair / SG.
# Skip if you expect another run within a few weeks.
aws iam delete-role-policy --role-name watercolor-build --policy-name watercolor-build-policy
aws iam remove-role-from-instance-profile --instance-profile-name watercolor-build --role-name watercolor-build
aws iam delete-instance-profile --instance-profile-name watercolor-build
aws iam delete-role --role-name watercolor-build
aws ec2 delete-key-pair --region us-east-1 --key-name watercolor-build
aws ec2 delete-security-group --region us-east-1 --group-id <sg-id>
```

## Attribution

The Worker MUST advertise both upstream attributions on every response:

```
Map tiles by Stamen Design, under CC BY 4.0.
Data by OpenStreetMap, under ODbL.
```

These are emitted as a `License` and `X-Attribution` header by
`../../src/watercolor.ts`, and embedded into any MapLibre style that uses
the archive.
