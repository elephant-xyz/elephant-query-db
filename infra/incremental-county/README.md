# incremental-county — self-looping per-county incremental ingestion

A Step Functions state machine that keeps a county's query DB caught up with its
appraisal source **incrementally**, and publishes open data as it goes — then loops.
One execution runs for the life of a county's ingestion: load a little, publish if
anything changed, wait, repeat, and do a final full publish once the seed feeder has
drained the whole source.

Two Fargate task definitions share **one** image (`Dockerfile.reload`, which copies the
whole `scripts/` dir so both entrypoints ship in the image). A Fargate command override
cannot *replace* the image `ENTRYPOINT`, so each task definition sets its own `EntryPoint`:

- **load** → `scripts/reload-appraisal-entrypoint.sh` with `STEP=load INCREMENTAL=1
  SKIP_CLEAR=1` — incremental-only load (no clear, no completeness validate). Takes a
  global `pg_try_advisory_lock` (exits 0 if busy) and writes a status JSON to
  `INCREMENTAL_STATUS_URI` with **exactly** `{ "processed": <number>, "skipped": <boolean> }`.
- **publish** → `scripts/query-table-publish-entrypoint.sh`, env-driven by `COUNTY`,
  `VALIDATE_MODE` (`parquet-only` | `full`), and `PUBLISH_APPROVED` (empty = dry-run).

## State machine loop

```
IncrementalLoad (load task, .sync, retry x2)
      │  writes {processed,skipped} -> s3://statusBucket/statusKey
      ▼
ReadStatus  ── ReadFeeder ──(missing)── FeederMissing
      │            │                         │
      ▼            ▼                         ▼
              GetApproval ──(missing)── NoApproval
                   │
                   ▼
             ChangedChoice
   skipped==true ─────────────────────────► Wait ──► (loop) IncrementalLoad
   processed>0  ─► ExportPublish (parquet-only) ─┐
   else ─────────────────────────────────────────┴─► CompleteChoice
                                                          │
   feeder.nextSourceRowNumber >= seedTotal               │
     AND processed==0 AND skipped==false ─► FinalPublish (full) ─► Succeed
   else ──────────────────────────────────────────────► Wait ──► (loop)
```

- A **skipped** cycle (advisory lock was busy) never publishes or completes — it just waits and retries.
- A cycle that **processed > 0** artifacts publishes incrementally (`parquet-only`), then re-checks completion.
- The loop **completes** only when the seed feeder has drained the source
  (`nextSourceRowNumber >= seedTotal`) *and* the last load processed nothing new and wasn't skipped —
  then it runs one `full` publish and succeeds.

The original execution input is preserved across the loop by writing every step's result to a
scratch `ResultPath` (`$.loadResult`, `$.statusRead`, `$.feederRead`, `$.approval`, …), never over the input.

## Execution input contract

```json
{
  "county": "palm_beach",
  "jurisdictionKey": "palm_beach_appraiser",
  "appraisalPrefix": "outputs/palm-beach-property-first-seed/palm-beach-fullcounty-20260705/",
  "expectLetterStraps": "0",
  "seedTotal": 644139,
  "statusBucket": "elephant-oracle-node-environmentbucket-mmsoo3xbdi80",
  "statusKey": "incremental-status/palm_beach/status.json",
  "feederStateBucket": "elephant-oracle-node-environmentbucket-mmsoo3xbdi80",
  "feederStateKey": "permit-harvest/palm-beach-property-first-seed-all-20260705/feeder-state.json",
  "waitSeconds": 900
}
```

| Field | Meaning |
|-------|---------|
| `county` | County slug; used for the SSM approval param and passed to the publish task as `COUNTY`. |
| `jurisdictionKey` | Appraisal `source_system` / parcel `jurisdiction_key` (e.g. `palm_beach_appraiser`). |
| `appraisalPrefix` | S3 prefix of the county's appraisal artifacts the loader reads. |
| `expectLetterStraps` | `"true"` for Lee-style letter STRAPs, `"0"` for numeric-folio counties (Palm Beach). |
| `seedTotal` | Total source rows (number). Completion fires when the feeder checkpoint reaches this. |
| `statusBucket` / `statusKey` | Where the load writes / the machine reads the `{processed,skipped}` status JSON. |
| `feederStateBucket` / `feederStateKey` | The seed feeder's `feeder-state.json` (its `nextSourceRowNumber` is the drain watermark). |
| `waitSeconds` | Seconds to wait between loop cycles (number). |

## One-time: approve publishing for a county

Publishing is gated by an SSM parameter per county. Until it is set to `true`, `PUBLISH_APPROVED`
resolves to empty and the publish task runs as a **dry-run** (the state machine still exercises the
full path; the parameter simply flips dry-run off):

```bash
aws ssm put-parameter \
  --name /oracle/palm_beach/publish-approved \
  --value true \
  --type String \
  --overwrite
```

If the parameter does not exist, the machine catches the lookup failure and proceeds with `PUBLISH_APPROVED=""` (dry-run).

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
template, and prints a ready-to-run `aws stepfunctions start-execution` with the full input contract.

## Run

```bash
ARN=$(aws cloudformation describe-stacks --stack-name incremental-county-stack \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" --output text)
aws stepfunctions start-execution --state-machine-arn "$ARN" --input '{ ...see contract above... }'
```

Watch CloudWatch log group `/ecs/incremental-county` (streams `load` and `publish`).

## Flag / verify before first prod run

Two things could **not** be fully verified here — confirm both before trusting a live county:

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
