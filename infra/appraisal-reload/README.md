# appraisal-reload — serial Fargate re-load

Re-loads the Lee County appraisal data into the query DB correctly (folio-keyed) without
risking the laptop or hitting the EC2 vCPU quota wall.

## Why Fargate (not Lambda, not EC2)
- **EC2 is blocked** — on-demand *and* Spot vCPU are both capped at 1 on this account; every
  other family is 0. A quota case is open but ungranted.
- **Fargate has a separate quota** (6 vCPU, available now) and **no 15-min limit** — required
  because the FK-safe clear and the serial merge each move millions of rows.
- **Serial, single task** — the appraisal loader interleaves stage+merge per batch and writes
  shared parent tables (`addresses`/`companies`/`people`). Running it in parallel deadlocks on
  those parents (the cause of the earlier 30,851-parcel loss), so the re-load runs as **one**
  task. Reuses the proven loader unchanged.

## Flow (Step Functions)
```
EmitCostMetric (Lambda, no gate) → RunReload (Fargate task, .sync, retry x2)
```
The Fargate container (`Dockerfile.reload` → `scripts/reload-appraisal-entrypoint.sh`) runs:
1. `ensure-folio-constraint.ts` — idempotent migration 0005 (folio unique key).
2. `clear-appraisal-source.ts` — FK-safe, **batched** `DELETE WHERE source_system='lee_appraiser'`
   in reverse FK order; **never** touches `addresses`/`companies`/`people` or the `lee_accela`
   permit rows.
3. `run-bulk-data-load.ts` (unchanged) — full-county load, `--batch-size 20000`.
4. `validate-appraisal-folio.ts` — asserts distinct folios ≥ `EXPECTED_MIN_PARCELS`,
   `total == distinct` (no collapse), and zero orphaned properties. Fails the task if short.

## Deploy
```bash
AWS_PROFILE=elephant-oracle-node \
DATABASE_URL_SECRET_ARN=<secret holding the DIRECT ep-mute-leaf URL> \
SUBNET_IDS=subnet-0f1d2efb1cf3a92e5 \
SECURITY_GROUP_ID=<sg allowing outbound 443/5432> \
./deploy.sh
```
> The secret must hold the **direct/unpooled** Neon URL (COPY + the permanent stage table need
> session semantics; the pooled endpoint breaks them).

## Run
```bash
ARN=$(aws cloudformation describe-stacks --stack-name appraisal-reload-stack \
  --query "Stacks[0].Outputs[?OutputKey=='StateMachineArn'].OutputValue" --output text)
aws stepfunctions start-execution --state-machine-arn "$ARN"
```
Watch CloudWatch log group `/ecs/appraisal-reload`. Expect `validate_appraisal_folio`
`passed:true` with `distinctFolios ≈ 511,695`.

## Test against a throwaway Neon branch first
Point `DATABASE_URL_SECRET_ARN` at a secret holding a **branch** URL and set a small
`SCOPE_MANIFEST` + `EXPECTED_MIN_PARCELS` via a task-definition override before the prod run.
