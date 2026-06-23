# IPFS Publish Runbook — Lee County Consolidated Properties

> **PII safety note:** This upload pushes ~501k per-property JSON files (including ownership names, addresses, assessed values) to public IPFS via Filebase. Once pinned they are **globally readable**. Stefan must personally authorise and run the publish step; do not delegate to an automated agent without that explicit sign-off.

## Prerequisites

- The `export:property-consolidation` run has completed and `.property-consolidation-export/` is present with `manifest.json`, `index.json`, `shards/shard-NNNN.json`, and all `properties/<uuid>.json` files.
- Filebase S3 credentials are in the vault at `Credentials/filebase-oracle-open-data.md`.
- For IPNS, set a label (`FILEBASE_IPNS_LABEL`) — no separate token is needed. The IPNS bearer token is auto-derived from the S3 keys. See [IPNS One-Time Setup](#ipns-one-time-setup).
- Working directory: `elephant-query-db/`.

---

## Sharded Index Format

After the export runs, two new artifacts are produced in `.property-consolidation-export/`:

### `index.json`

Top-level index that lists all shards. Shape:

```json
{
  "schemaVersion": "1",
  "county": "lee",
  "exportedAt": "2026-06-23T10:00:00Z",
  "completedAt": "2026-06-23T12:30:00Z",
  "propertyCount": 516848,
  "shardSize": 10000,
  "totalBytes": 123456789,
  "shards": [
    {
      "shardIndex": 0,
      "fromParcel": "0100000000001",
      "toParcel":   "0199999999999",
      "count": 10000,
      "shardCid": "QmABC..."
    }
  ]
}
```

### `shards/shard-NNNN.json`

One file per 10,000 properties (by default), sorted by `parcelIdentifier`. Shape:

```json
{
  "schemaVersion": "1",
  "shardIndex": 0,
  "fromParcel": "0100000000001",
  "toParcel":   "0199999999999",
  "count": 10000,
  "entries": [
    {
      "propertyId": "<uuid>",
      "parcelIdentifier": "0100000000001",
      "cid": "QmXYZ...",
      "fileSizeBytes": 2048
    }
  ]
}
```

Each shard entry contains only the four fields needed for lookup — no absolute paths, no sha256. The full property JSON is at `properties/<uuid>.json` (and at `ipfs://<cid>`).

---

## Step 1 — Re-run the export (if stale or missing)

If you need a fresh export (e.g. after new data was loaded into the DB):

```bash
npm run export:property-consolidation
```

The default shard size is **10,000 entries per shard** (controlled by `--shard-size N`). For ~516k Lee properties this produces ~52 shard files.

This writes:
- `.property-consolidation-export/properties/<uuid>.json` — one file per property
- `.property-consolidation-export/manifest.json` — flat index (back-compat)
- `.property-consolidation-export/index.json` — sharded top-level index
- `.property-consolidation-export/shards/shard-NNNN.json` — per-shard entry files

The script logs `Index CID: Qm...` at the end. The full run takes 15–30 minutes for ~516k records.

Skip this step if you already have a complete, up-to-date export.

---

## Step 2 — Export Filebase credentials from the vault

### S3 credentials (required)

Open `~/ObsidianVault/Projects/Elephant/Credentials/filebase-oracle-open-data.md` and export:

```bash
export S3_ACCESS_KEY_ID="<accessKeyId from vault>"
export S3_SECRET_ACCESS_KEY="<secretAccessKey from vault>"
export S3_BUCKET="elephant-oracle-open-data"
export S3_ENDPOINT="https://s3.filebase.io"   # default; change only if instructed
```

### IPNS label (recommended)

To update the IPNS mutable pointer after each publish (recommended for production), set a label. **No separate token is required** — the IPNS bearer token is auto-derived from the S3 keys above (`base64(S3_ACCESS_KEY_ID:S3_SECRET_ACCESS_KEY)`):

```bash
export FILEBASE_IPNS_LABEL="oracle-open-data-lee"   # or your chosen label
```

`FILEBASE_API_TOKEN` remains an optional override if you ever need a different token; leave it unset to use the auto-derived one.

Verify all vars are set:

```bash
echo "KEY=${S3_ACCESS_KEY_ID:0:8}... BUCKET=${S3_BUCKET} ENDPOINT=${S3_ENDPOINT}"
echo "IPNS_LABEL=${FILEBASE_IPNS_LABEL}"
```

---

## Step 3 — Dry run (mandatory pre-check)

```bash
npm run publish:ipfs-upload -- --dry-run
```

Expected output (new sharded mode):

```
{"event":"upload_session_started", "propertyCount": 516848, "entriesToUpload": 516848, "shardCount": 52, "hasShardedIndex": true, ...}
{"event":"dry_run_summary", "wouldUpload": 516901, ...}
[dry-run] Would upload 516848 property files + 52 shard files + index.json + manifest.json (... MB total). No uploads performed.
```

If `propertyCount` looks wrong, stop and investigate the export.

Smoke-test with 10 real property files:

```bash
npm run publish:ipfs-upload -- --limit 10
```

---

## Step 4 — Full publish

```bash
npm run publish:ipfs-upload 2>&1 | tee .upload-runs/publish-$(date +%Y%m%d-%H%M%S).log
```

**Upload order (enforced by the script):**

1. All `properties/<uuid>.json` files — in parallel up to `--concurrency` (default 32)
2. All `shards/shard-NNNN.json` files — in parallel (same semaphore)
3. `index.json` — only after all shards succeed
4. `manifest.json` — last, after index.json (back-compat)
5. IPNS pointer update — only after index.json is uploaded (if `FILEBASE_IPNS_LABEL` is set; token auto-derived from S3 keys)

If any step fails, the subsequent steps are skipped. Re-run to resume — the checkpoint skips already-uploaded keys.

### Adjusting concurrency

```bash
npm run publish:ipfs-upload -- --concurrency 8    # lower if hitting rate limits
npm run publish:ipfs-upload -- --concurrency 64   # higher (test with --limit 100 first)
```

---

## Step 5 — Resume after interruption

```bash
npm run publish:ipfs-upload 2>&1 | tee -a .upload-runs/publish-resume-$(date +%Y%m%d-%H%M%S).log
```

The checkpoint at `.upload-runs/filebase-upload-checkpoint.json` records every successfully uploaded key. Already-uploaded keys are **skipped** automatically. Upload order is still enforced: shards before index.json, index.json before manifest.json.

---

## Step 6 — Collect the index and manifest CIDs

At the end of a successful run, the script prints:

```
=== INDEX CID ===
Qm...
Set ORACLE_OPEN_DATA_INDEX_CID=Qm... in your MCP/NEO environment.

=== MANIFEST CID ===
Qm...
Set ORACLE_OPEN_DATA_MANIFEST_CID=Qm... in your MCP/NEO environment.

=== IPNS ===
IPNS name: k51q...
Set ORACLE_OPEN_DATA_IPNS=k51q... in your MCP/NEO environment.
```

From the structured log:

```bash
grep '"event":"upload_session_complete"' .upload-runs/publish-*.log | tail -1 | jq '{indexCid, manifestCid, ipnsName}'
```

From the checkpoint file:

```bash
jq '.entries[] | select(.key == "index.json") | .cid' .upload-runs/filebase-upload-checkpoint.json
jq '.entries[] | select(.key == "manifest.json") | .cid' .upload-runs/filebase-upload-checkpoint.json
```

---

## Step 7 — Set the CIDs in downstream environments

The MCP server and NEO catalog consume two new env vars:

```
ORACLE_OPEN_DATA_INDEX_CID=<index CID from step 6>
ORACLE_OPEN_DATA_IPNS=<ipns name from step 6>
```

The legacy `ORACLE_OPEN_DATA_MANIFEST_CID` is still supported for back-compat but the sharded index is preferred for scale.

> **Do NOT change the MCP or NEO code here.** This runbook stops at obtaining and recording the CIDs. The downstream wiring is covered by the MCP/NEO story.

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `S3_ACCESS_KEY_ID` | Yes | Filebase S3 access key |
| `S3_SECRET_ACCESS_KEY` | Yes | Filebase S3 secret key |
| `S3_BUCKET` | Yes | Filebase bucket name (e.g. `elephant-oracle-open-data`) |
| `S3_ENDPOINT` | No | Filebase S3 endpoint (default: `https://s3.filebase.io`) |
| `FILEBASE_IPNS_LABEL` | No* | Label for the IPNS name (e.g. `oracle-open-data-lee`) — set this to enable IPNS updates |
| `FILEBASE_API_TOKEN` | No | Override for the IPNS bearer token. If unset, it is auto-derived as `base64(S3_ACCESS_KEY_ID:S3_SECRET_ACCESS_KEY)` |

*Optional but strongly recommended for production publishes — without IPNS, consumers must track the raw CID manually. IPNS needs **only** the S3 keys plus this label; the token is auto-derived.

---

## IPNS One-Time Setup

IPNS (InterPlanetary Name System) provides a **mutable pointer** to the latest index CID. Instead of hardcoding a CID in downstream configs, consumers resolve an IPNS name which always points to the current index.

### Authentication — no extra token needed

The Filebase IPNS API (`https://api.filebase.io/v1/names`) authenticates with the **same S3 keys** used for uploads:

```
Authorization: Bearer base64(S3_ACCESS_KEY_ID:S3_SECRET_ACCESS_KEY)
```

The script derives this automatically. There is **no separate API token to create** — just set `FILEBASE_IPNS_LABEL`. `FILEBASE_API_TOKEN` exists only as an optional override.

### How IPNS works in this publish flow

- On the **first publish**: the script `GET`s `/v1/names/{label}` (404 → not found), then `POST`s `/v1/names` with `{label, cid}` to create the name pointing at the uploaded `index.json` CID.
- On **subsequent publishes**: the script finds the existing name by label and `PUT`s `/v1/names/{label}` with `{cid}` to update the pointer to the new `index.json` CID (the API bumps the record `sequence`).
- The returned IPNS name — the `network_key` (e.g. `k51q...`) — is stable across publishes; only the target CID changes.

### Downstream consumption

```
ORACLE_OPEN_DATA_IPNS=k51q...
```

Consumers resolve this via: `ipfs.name.resolve(ipnsName)` → current `index.json` CID → shard listing → per-property CIDs.

---

## CID verification

For each property file, the uploader asserts that the CID returned by Filebase (`x-amz-meta-cid`) matches the pre-computed CID in `manifest.json`. For shard files, the expected CID comes from `index.json`'s `shards[].shardCid`. Mismatches are logged with `"event":"cid_mismatch"` — the pre-computed CID is treated as authoritative.

```bash
grep '"event":"cid_mismatch"' .upload-runs/publish-*.log | wc -l
```

Zero mismatches is the goal.

---

## Failure recovery

If the run exits with failures:

1. Check the error lines: `grep '"event":"upload_failed"' .upload-runs/publish-*.log | head -20`
2. Re-run with the same command — the checkpoint skips clean files.
3. If a specific file keeps failing, check whether the file is readable and non-empty.
4. If >1% of files fail persistently, pause and investigate Filebase rate limits or account status.

---

## File layout produced

```
elephant-query-db/
  .property-consolidation-export/
    manifest.json                     <- uploaded LAST; flat index (back-compat)
    index.json                        <- sharded top-level index; uploaded before manifest
    shards/
      shard-0000.json                 <- 10k entries sorted by parcelIdentifier
      shard-0001.json
      ...
      shard-0051.json
    properties/
      <uuid>.json                     <- one file per property
  .upload-runs/
    filebase-upload-checkpoint.json   <- resume state; safe to delete after a clean full run
    publish-<timestamp>.log           <- tee'd log from the run
```
