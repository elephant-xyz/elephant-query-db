# RUNBOOK — AWS EC2 Bulk IPFS Publish (Lee County)

Use this runbook the moment the DB load finishes.
Everything runs on a temporary EC2 box in us-east-1 (same region as Neon + Filebase).

---

## Overview

| Step | What happens |
|------|-------------|
| 1 | Launch a `c7g.2xlarge` (or `c7i.2xlarge`) EC2 instance in us-east-1 |
| 2 | SSH in, run the bootstrap script |
| 3 | Set 7 env vars from the vault |
| 4 | Run export + upload inside tmux |
| 5 | Record the IPNS name and index CID |
| 6 | Terminate the instance + EBS volume |

---

## Cost estimate

| Resource | Rate | Duration | Cost |
|----------|------|----------|------|
| `c7g.2xlarge` (arm64, on-demand) | ~$0.29/hr | ~4–6 h | ~$1.50–$1.80 |
| `c7i.2xlarge` (x86, on-demand) alt | ~$0.34/hr | ~4–6 h | ~$1.80–$2.10 |
| 150 GB gp3 EBS | ~$0.008/GB-month | 1 h | <$0.02 |
| Data transfer (outbound ~80 GB) | ~$0.09/GB | — | ~$7 |

**Total: ~$9–$10.** Use spot for ~70% savings if you can tolerate possible interruption (the upload is resumable).

Time estimate: export ~1–3 h, upload ~1–3 h (EC2 → Filebase is fast within us-east-1).

---

## Step 1 — Get the latest Amazon Linux 2023 AMI

```bash
aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64 \
  --region us-east-1 \
  --query Parameter.Value \
  --output text
```

For x86 (`c7i.2xlarge`), use:

```bash
aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64 \
  --region us-east-1 \
  --query Parameter.Value \
  --output text
```

Save the AMI id (e.g. `ami-0abcdef1234567890`) for the next step.

---

## Step 2 — Launch the instance

Replace the angle-bracket placeholders before running.

```bash
aws ec2 run-instances \
  --region us-east-1 \
  --image-id <AMI_ID_FROM_STEP_1> \
  --instance-type c7g.2xlarge \
  --key-name <YOUR_KEY_PAIR_NAME> \
  --security-group-ids <SG_ID_WITH_SSH_22_IN_AND_ALL_OUT> \
  --subnet-id <PUBLIC_SUBNET_ID> \
  --block-device-mappings '[{
    "DeviceName": "/dev/xvda",
    "Ebs": {
      "VolumeSize": 150,
      "VolumeType": "gp3",
      "DeleteOnTermination": true
    }
  }]' \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Name,Value=elephant-ipfs-publish},{Key=Project,Value=elephant},{Key=ManagedBy,Value=manual}]' \
    'ResourceType=volume,Tags=[{Key=Name,Value=elephant-ipfs-publish-root}]' \
  --associate-public-ip-address \
  --output json | tee /tmp/ec2-launch.json

# Extract the instance id for later use
INSTANCE_ID=$(jq -r '.Instances[0].InstanceId' /tmp/ec2-launch.json)
echo "Instance: ${INSTANCE_ID}"
```

**Instance type alternatives:**
- `c7g.2xlarge` — ARM64 (Graviton3), 8 vCPU, 16 GB RAM — cheapest for CPU-heavy export
- `c7i.2xlarge` — x86_64, same shape — use this if you need x86 compatibility

**Security group requirements:**
- Inbound: TCP 22 from your IP
- Outbound: all traffic (needs to reach Neon, Filebase, and GitHub)

Wait ~60 seconds for the instance to reach `running` state:

```bash
aws ec2 wait instance-running --instance-ids "${INSTANCE_ID}" --region us-east-1
PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --region us-east-1 \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)
echo "Public IP: ${PUBLIC_IP}"
```

---

## Step 3 — SSH in and run the bootstrap

```bash
ssh -i ~/.ssh/<YOUR_KEY_PAIR>.pem ec2-user@"${PUBLIC_IP}"
```

Once on the box:

```bash
# Download and run the bootstrap (installs Node 22, clones the repo, npm install)
curl -fsSL \
  https://raw.githubusercontent.com/soofi-xyz/elephant-query-db/feat/bulk-ipfs-publish/scripts/aws-publish-bootstrap.sh \
  | bash
```

Alternatively, if you already have the repo locally:

```bash
scp -i ~/.ssh/<YOUR_KEY_PAIR>.pem \
  /path/to/elephant-query-db/scripts/aws-publish-bootstrap.sh \
  ec2-user@"${PUBLIC_IP}":/tmp/bootstrap.sh
ssh -i ~/.ssh/<YOUR_KEY_PAIR>.pem ec2-user@"${PUBLIC_IP}" "bash /tmp/bootstrap.sh"
```

The bootstrap is idempotent — safe to re-run.

---

## Step 4 — Set the 7 env vars

| Variable | Where to get it | Notes |
|----------|----------------|-------|
| `DATABASE_URL` | Vault: `Credentials/neo-open-data-neon-db.md` | Neon unpooled URL for `ep-mute-leaf` (aws-us-east-1) |
| `S3_ACCESS_KEY_ID` | Vault: `Credentials/filebase-oracle-open-data.md` | Filebase key |
| `S3_SECRET_ACCESS_KEY` | Vault: `Credentials/filebase-oracle-open-data.md` | Filebase secret |
| `S3_BUCKET` | Fixed value | `elephant-oracle-open-data` |
| `S3_ENDPOINT` | Fixed value | `https://s3.filebase.io` |
| `FILEBASE_API_TOKEN` | Vault: `Credentials/filebase-oracle-open-data.md` | For IPNS update |
| `FILEBASE_IPNS_LABEL` | Fixed value | `oracle-open-data-lee` |

On the EC2 box, inside the tmux session (step 5), export them:

```bash
export DATABASE_URL="postgresql://USER:PASSWORD@ep-mute-leaf-XXXXXXXX.us-east-1.aws.neon.tech/neondb?sslmode=require"
export S3_ACCESS_KEY_ID="<from vault>"
export S3_SECRET_ACCESS_KEY="<from vault>"
export S3_BUCKET="elephant-oracle-open-data"
export S3_ENDPOINT="https://s3.filebase.io"
export FILEBASE_API_TOKEN="<from vault>"
export FILEBASE_IPNS_LABEL="oracle-open-data-lee"
```

Quick sanity check:

```bash
echo "DB=${DATABASE_URL:0:30}... KEY=${S3_ACCESS_KEY_ID:0:8}... BUCKET=${S3_BUCKET}"
```

---

## Step 5 — Run inside tmux (survives SSH disconnect)

```bash
tmux new -s publish
```

Inside tmux:

```bash
cd ~/elephant-query-db

# Export phase (~1–3 h, ~501k files written to .property-consolidation-export/)
npm run export:property-consolidation -- --shard-size 10000 \
  2>&1 | tee ".export-$(date +%Y%m%d-%H%M%S).log"

# Upload phase (~1–3 h, uploads to Filebase → IPFS)
npm run publish:ipfs-upload \
  2>&1 | tee ".upload-runs/publish-$(date +%Y%m%d-%H%M%S).log"
```

**To detach from tmux without stopping the run:** `Ctrl+B` then `D`

**To reattach after reconnecting via SSH:** `tmux attach -t publish`

**Resume behavior:** Both scripts checkpoint. If the connection drops mid-run or you Ctrl+C, re-run the same command — it skips already-completed work automatically.

---

## Step 6 — Collect the IPNS name and index CID

At the end of a successful upload run the script prints:

```
=== INDEX CID ===
Qm...
Set ORACLE_OPEN_DATA_INDEX_CID=Qm... in your MCP/NEO environment.

=== IPNS ===
IPNS name: k51q...
Set ORACLE_OPEN_DATA_IPNS=k51q... in your MCP/NEO environment.
```

To extract from the log if you missed it:

```bash
grep '"event":"upload_session_complete"' .upload-runs/publish-*.log | tail -1 \
  | jq '{indexCid, ipnsName}'
```

**What these are for:**
- `ORACLE_OPEN_DATA_INDEX_CID` — the content-addressed root of the sharded index (immutable, changes each publish)
- `ORACLE_OPEN_DATA_IPNS` — the mutable IPNS pointer (stable; set this once in NEO's MCP config and it always resolves to the latest publish)

Hand both values to Mykyta / the NEO MCP story to wire them into `ORACLE_OPEN_DATA_IPNS`.

---

## Step 7 — Teardown

Terminate the instance (the root EBS volume has `DeleteOnTermination: true`, so it is deleted automatically):

```bash
aws ec2 terminate-instances \
  --instance-ids "${INSTANCE_ID}" \
  --region us-east-1

aws ec2 wait instance-terminated \
  --instance-ids "${INSTANCE_ID}" \
  --region us-east-1

echo "Instance ${INSTANCE_ID} terminated."
```

Confirm no orphaned volumes:

```bash
aws ec2 describe-volumes \
  --filters "Name=tag:Name,Values=elephant-ipfs-publish-root" \
  --region us-east-1 \
  --query 'Volumes[*].{Id:VolumeId,State:State}' \
  --output table
```

---

## Optional — Pass bootstrap as user-data (fully automated launch)

You can bake the bootstrap into the launch command so the box is ready immediately on first SSH:

```bash
aws ec2 run-instances \
  ... (all flags above) ... \
  --user-data file://scripts/aws-publish-bootstrap.sh
```

The bootstrap will run as root via cloud-init. Env vars still need to be set manually in step 4 — they are never injected automatically.

---

## Troubleshooting

**Node version wrong after bootstrap:**

```bash
node --version   # must be v22.x.x
which node       # should be /usr/bin/node or /usr/bin/node-22
```

If `node` still points to an older version, run:

```bash
sudo alternatives --set node /usr/bin/node-22
```

**Export OOM or killed:**

The export streams from Neon and writes to disk; it should not OOM on a 16 GB instance. If it does, reduce `--batch-size` (default 250):

```bash
npm run export:property-consolidation -- --shard-size 10000 --batch-size 100
```

**Upload rate-limit from Filebase:**

Reduce concurrency (default 32):

```bash
npm run publish:ipfs-upload -- --concurrency 8
```

**Disk full:**

Check usage: `df -h`. The export writes ~80 GB. If `/` is too small, increase the EBS volume to 200 GB in step 2.
