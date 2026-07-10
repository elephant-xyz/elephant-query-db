# incremental-county — source-agnostic per-county incremental ingestion

**Two** Step Functions state machines, split by responsibility, sharing one ECS cluster + image:

- **LOAD machine** (`incremental-county-load`) — **source-agnostic**. Run **one execution per
  source/track per county** (appraisal, permits, sunbiz, bbb). It loads one track
  incrementally, and — when it changed rows — flips a per-county **publish-pending** flag in
  S3, then loops. It **never publishes**; it only loads and signals. The machine knows nothing
  about "appraisal": the track and its S3 prefix are passed in the execution input.
- **PUBLISH machine** (`incremental-county-publish`) — **per-county singleton**. Run **one
  execution per county**. It polls the publish-pending flag; when set it clears the flag,
  exports+validates the county query-table Parquet, and re-points `oracle-query-table-<county>`
  IPNS. It also writes the coverage JSON contract and publishes it to its own
  `oracle-dataset-coverage-<county>` IPNS; no coverage JSON is written to S3. It **coalesces**
  signals from every LOAD execution, so appraisal and permit loads never race on the single shared
  county Parquet.

Two Fargate task definitions share **one** image (`Dockerfile.reload`, which copies the
whole `scripts/` dir so all entrypoints ship in the image). A Fargate command override
cannot *replace* the image `ENTRYPOINT`, so each task definition sets its own `EntryPoint`:

- **load** → `scripts/incremental-load-entrypoint.sh` — maps a single `TRACK` +
  `SOURCE_PREFIX` to the loader's per-track flag and always runs `--incremental`. Takes a
  global `pg_try_advisory_lock` (exits 0 if busy) and writes a status JSON to
  `INCREMENTAL_STATUS_URI` with **exactly** `{ "processed": <number>, "skipped": <boolean> }`.
- **publish** → `scripts/query-table-publish-entrypoint.sh`, env-driven by `COUNTY`,
  `VALIDATE_MODE` (`parquet-only` | `full`), and `PUBLISH_APPROVED` (empty = dry-run).
  Exports `query-table.parquet` from Neon, validates, uploads to Filebase, re-points
  `oracle-query-table-<county>` IPNS (`county-query-table-publish` skill), then publishes
  `.dataset-coverage/<county>/dataset-coverage.json` to Filebase/IPFS under
  `oracle-dataset-coverage-<county>` for MCP/Miranda consumption.

## Why the split

Publishing is **per-county**, not per-source: the query-table Parquet is ONE file per county
that joins appraisal + permits + sunbiz + bbb. If publish lived inside the load loop, running
two load executions (appraisal + permits) would run two publishes racing on the same IPNS
pointer and rebuilding the whole Parquet twice. Splitting makes load fan out per source while
publish stays a single, debounced, per-county writer.

Sources also have different lifecycles: appraisal **drains and succeeds**; permit **deltas loop
forever**. One execution per source lets each own its own cadence, watermark, and status key.

## LOAD machine loop (one per source/track)

```
IncrementalLoad (load task, .sync, retry x2)  [env: TRACK, SOURCE_PREFIX, JURISDICTION_KEY]
      │  writes {processed,skipped} -> s3://statusBucket/statusKey
      ▼
ReadStatus ── ReadFeeder ──(missing)── FeederMissing (nextSourceRowNumber=0)
      │            │                         │
      ▼            ▼                         ▼
                 ChangedChoice
   skipped==true ─────────────────────────────────────► Wait ──► (loop) IncrementalLoad
   processed>0  ─► SetPublishPending (s3 flag = {"pending":true}) ─┐
   else ──────────────────────────────────────────────────────────┴─► CompleteChoice
                                                                          │
   feeder.nextSourceRowNumber >= seedTotal AND skipped==false ─────────► Succeed
   else ──────────────────────────────────────────────────────────────► Wait ──► (loop)
```

- A **skipped** cycle (advisory lock busy) never signals or completes — it waits and retries.
- **processed > 0** flips the per-county publish-pending flag (the PUBLISH machine consumes it).
- The loop **completes** when the feeder has drained (`nextSourceRowNumber >= seedTotal`) and the
  load was not skipped. For a track with **no feeder** (permits), ReadFeeder falls back to
  `nextSourceRowNumber=0`, so completion never fires and it loops forever on daily deltas.

## PUBLISH machine loop (one per county)

```
ReadPending (s3 getObject publish-pending.json) ──(missing)── NotPending (pending=false)
      │                                                             │
      ▼                                                             ▼
   PendingChoice                                                PublishWait ─► (loop) ReadPending
   pending==true ─► ClearPending (flag = {"pending":false})
                        │  (clear BEFORE publish: a load during export re-flags -> next cycle republishes; never misses)
                        ▼
                    GetApproval ──(missing)── NoApproval
                        │
                        ▼
                    ExportPublish (query-table export + validate + upload, parquet-only) ─► PublishWait ─► (loop)
```

Both machines preserve the original input across the loop by writing each step's result to a
scratch `ResultPath` (`$.loadResult`, `$.statusRead`, `$.pendingRead`, `$.approval`, …).

## LOAD execution input contract (one per source/track)

```json
{
  "county": "palm-beach",
  "jurisdictionKey": "palm_beach_appraiser",
  "track": "appraisal",
  "sourcePrefix": "outputs/palm-beach-property-first-seed/palm-beach-fullcounty-20260705/",
  "seedTotal": 644139,
  "statusBucket": "elephant-oracle-node-environmentbucket-mmsoo3xbdi80",
  "statusKey": "incremental-status/palm-beach/appraisal.json",
  "feederStateBucket": "elephant-oracle-node-environmentbucket-mmsoo3xbdi80",
  "feederStateKey": "permit-harvest/palm-beach-property-first-seed-all-20260705/feeder-state.json",
  "waitSeconds": 900
}
```

| Field | Meaning |
|-------|---------|
| `county` | County slug (hyphen form, e.g. `miami-dade`). Keys the SSM approval param, IPNS label `oracle-query-table-<county>`, and the shared publish-pending flag. |
| `jurisdictionKey` | Loader `source_system` / parcel `jurisdiction_key` (e.g. `palm_beach_appraiser`). |
| `track` | **The one source this execution loads:** `appraisal` \| `permits` \| `sunbiz` \| `bbb`. |
| `sourcePrefix` | S3 prefix of that track's artifacts the loader reads. |
| `seedTotal` | Total source rows (number). Completion fires when the feeder checkpoint reaches this. Use a tiny sentinel (e.g. `1`) + a missing feeder key for forever-looping delta tracks. |
| `statusBucket` / `statusKey` | Where the load writes / the machine reads the `{processed,skipped}` status JSON. **Use a per-track key** (`.../<county>/<track>.json`). |
| `feederStateBucket` / `feederStateKey` | The seed feeder's `feeder-state.json` (its `nextSourceRowNumber` is the drain watermark). Point at a missing key for tracks with no feeder. |
| `waitSeconds` | Seconds to wait between loop cycles (number). |

## PUBLISH execution input contract (one per county)

```json
{
  "county": "palm-beach",
  "statusBucket": "elephant-oracle-node-environmentbucket-mmsoo3xbdi80",
  "waitSeconds": 900
}
```

The publish machine reads/clears `s3://<statusBucket>/incremental-status/<county>/publish-pending.json`.

## One-time: approve publishing for a county

Publishing is gated by an SSM parameter per county. Until it is set to `true`, `PUBLISH_APPROVED`
resolves to empty and the publish task runs as a **dry-run** (the state machine still exercises the
full path; the parameter simply flips dry-run off):

```bash
aws ssm put-parameter \
  --name /oracle/palm-beach/publish-approved \
  --value true \
  --type String \
  --overwrite
```

> The county slug in the SSM name MUST match the `county` in the PUBLISH execution input
> (hyphen form, e.g. `palm-beach`). If the parameter does not exist, the publish machine catches
> the lookup failure and proceeds with `PUBLISH_APPROVED=""` (dry-run).

## Deploy

```bash
AWS_PROFILE=elephant-oracle-node \
DATABASE_URL_SECRET_ARN=<secret holding the DIRECT ep-mute-leaf URL> \
PUBLISH_CREDS_SECRET_ARN=<JSON secret with the 5 Filebase keys> \
SUBNET_IDS=subnet-0f1d2efb1cf3a92e5 \
SECURITY_GROUP_ID=<sg allowing outbound 443/5432> \
./deploy.sh
```

> `DATABASE_URL_SECRET_ARN` must hold the **direct/unpooled** Neon URL (the loader's permanent
> stage table + advisory lock need session semantics; the pooled endpoint breaks them).

`deploy.sh` builds/pushes the image from `Dockerfile.reload`, deploys the pure-CloudFormation
template, and prints ready-to-run `start-execution` commands for BOTH machines.

## Run

Start one PUBLISH execution per county, and one LOAD execution per source/track:

```bash
LOAD_ARN=$(aws cloudformation describe-stacks --stack-name incremental-county-stack \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" --output text)
PUBLISH_ARN=$(aws cloudformation describe-stacks --stack-name incremental-county-stack \
  --query "Stacks[0].Outputs[?OutputKey=='PublishStateMachineArn'].OutputValue" --output text)

# per county (singleton):
aws stepfunctions start-execution --state-machine-arn "$PUBLISH_ARN" --name <county>-publish \
  --input '{ "county": "<county>", "statusBucket": "...", "waitSeconds": 900 }'

# per source/track (repeat for appraisal, permits, …):
aws stepfunctions start-execution --state-machine-arn "$LOAD_ARN" --name <county>-appraisal \
  --input '{ ...see LOAD contract above... }'
```

Watch CloudWatch log group `/ecs/incremental-county` (streams `load` and `publish`).

## Flag / verify before first prod run

Confirm before trusting a live county:

1. **Feeder-state field name** — the completion check reads `feeder.nextSourceRowNumber`. This was
   confirmed against the `permit-harvest-worker` Lambda
   (`oracle-node/workflow/lambdas/permit-harvest-worker/index.mjs`), which writes the
   `permit-harvest.property-first-seed-feeder-state.v2` schema with a numeric
   `nextSourceRowNumber` (one-based next CSV row). Still, **verify against a real
   `feeder-state.json` in S3** for the target county before the first prod run — if the schema
   ever changes, update the `CompleteChoice.And[0].Variable` path in `template.yaml` to match.
2. **`PublishCredsSecretArn` shape** — the publish task pulls 5 keys from a **single JSON** secret
   via `ValueFrom: <arn>:<key>::`: `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`, `FILEBASE_API_TOKEN`. Confirm the secret is JSON with exactly those keys
   (not a plaintext secret, and not per-key secret ARNs) or the publish task will fail to start.
3. **Incremental watermark coverage** — `appraisal` and `permits` both filter by a per-track
   artifact-URI ledger, so their delta cycles are cheap (only new artifacts are staged/merged,
   and a cycle with nothing pending skips the merge). `sunbiz`/`bbb` have no per-artifact
   watermark yet, so a single sunbiz/bbb LOAD execution fully reloads each cycle (idempotent,
   just not cheap) — run those on a slow cadence or one-shot until their ledger lands.
   - Appraisal ledger: `incremental-ledgers/<jurisdictionKey>/artifact-uris.json` (legacy path).
   - Permit ledger: `incremental-ledgers/<jurisdictionKey>/permits/artifact-uris.json`.
4. **Per-track status keys** — every LOAD execution for a county MUST use a distinct `statusKey`
   (`incremental-status/<county>/<track>.json`); sharing one key would let tracks overwrite each
   other's `{processed,skipped}` status.
