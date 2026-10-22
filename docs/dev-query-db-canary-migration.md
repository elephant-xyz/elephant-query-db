# DEV Query DB canary migration

Use this runbook only for the reviewed DEV schema checkpoint through migrations
`0009`–`0012`. It is the supported repair path for an existing Query DB whose
tables predate the Drizzle ledger.

Do not use `drizzle-kit generate`, a raw `psql -f`, or the normal loader as a
migration command. Do not run this procedure against PROD.

## Ownership and approval

The `elephant-xyz/elephant-query-db` repository owns the schema and migrations.
The existing Fargate reload path applies only its idempotent migration `0005`;
it does not apply the Drizzle journal. There is no automatic deployment step for
`0009`–`0012`.

Require all of the following before `--apply`:

1. Query DB schema-owner approval of the exact repository commit.
2. Deployment-owner approval of a DEV maintenance window.
3. A Neon backup branch or restore point created within the previous 24 hours,
   recorded as `BACKUP_REF` and `BACKUP_CREATED_AT`.
4. A complete operator-provided writer inventory, concrete pause/resume commands,
   and pause receipts in a private writer-pause proof file. A zero-activity
   database snapshot is not pause proof.
5. A direct, unpooled DEV `DATABASE_URL` injected through the approved secret
   mechanism. Never paste or print it.
6. A reviewed `--plan` from that same endpoint and commit.

## Supported commands

Run from the reviewed repository commit. Both commands emit fingerprints and
schema metadata only; they never print credentials or table rows.

Read-only plan:

```bash
npm run migrate:dev-canary -- \
  --plan \
  --environment DEV
```

Owner-approved apply:

```bash
npm run migrate:dev-canary -- \
  --apply \
  --environment DEV \
  --expected-endpoint-fingerprint "$ENDPOINT_FINGERPRINT" \
  --approval-ref "$APPROVAL_REF" \
  --backup-ref "$BACKUP_REF" \
  --backup-created-at "$BACKUP_CREATED_AT" \
  --writer-pause-proof "$WRITER_PAUSE_PROOF"
```

Set `ENDPOINT_FINGERPRINT` to the value from the approved plan. Set
`APPROVAL_REF` to the approved PR, change request, or ticket. Set `BACKUP_REF`
and `BACKUP_CREATED_AT` to the new Neon backup branch or restore point and its
ISO creation time. Repeat `--approval-ref` when more than one owner/change
approval applies. Set `WRITER_PAUSE_PROOF` to a private JSON file matching this
contract:

```json
{
  "schemaVersion": "query-db.dev-writer-pause-proof.v1",
  "environment": "DEV",
  "endpointFingerprint": "0123456789abcdef",
  "observedAt": "2026-10-22T12:00:00.000Z",
  "inventoryComplete": true,
  "inventoryRef": "operator-owned-writer-inventory-reference",
  "operatorProvided": true,
  "writers": [
    {
      "writerId": "operator-defined-writer",
      "kind": "step-functions",
      "ownerRef": "owner-confirmation-reference",
      "pauseCommand": "operator-provided pause command",
      "resumeCommand": "operator-provided resume command",
      "proofRef": "pause-execution receipt/reference",
      "paused": true
    }
  ]
}
```

Keep this proof outside Git. Do not put credentials, private rows, or literal
secret values in commands. This repository cannot prove the complete owning
Step Functions, ECS, and manual-loader inventory. The operator must provide it,
including at least one writer and concrete commands for every entry. The runner
rejects a stale proof, the wrong endpoint, an incomplete inventory, empty
commands, or a simple `--writers-paused` acknowledgement.

Read-only post-apply verification:

```bash
npm run migrate:dev-canary -- \
  --verify \
  --environment DEV \
  --expected-endpoint-fingerprint "$ENDPOINT_FINGERPRINT"
```

Run every reviewed `resumeCommand` only after this verification succeeds.
These values and the proof digest are audit evidence, not database credentials.

The apply command fails closed when:

- the environment is not exactly `DEV`;
- the endpoint fingerprint changed;
- the connection is pooled or points at a replica;
- approval is absent, the backup is absent or older than 24 hours, or concrete
  writer-pause evidence is absent or older than two hours;
- prerequisites, permissions, existing objects, indexes, constraints, or
  pinned journal/ledger hashes differ from the reviewed contract;
- the ledger has a duplicate, gap, unknown entry, or entry newer than `0012`; or
- another migration session holds the advisory lock.

For the verified `elephant-xyz/catalog` development binding, the default
`DATABASE_URL` is pooled and is intentionally rejected. Use the existing
`DATABASE_URL_UNPOOLED` value without printing it:

```bash
npx --yes vercel@latest env run \
  --environment development \
  --project catalog \
  --scope elephant-xyz \
  -- /bin/sh -c '
    DATABASE_URL="$DATABASE_URL_UNPOOLED" exec npm run migrate:dev-canary -- \
      --plan \
      --environment DEV
  '
```

After owner approval, backup, and writer pause, use the same wrapper with the
apply arguments:

```bash
npx --yes vercel@latest env run \
  --environment development \
  --project catalog \
  --scope elephant-xyz \
  -- /bin/sh -c '
    DATABASE_URL="$DATABASE_URL_UNPOOLED" exec npm run migrate:dev-canary -- \
      --apply \
      --environment DEV \
      --expected-endpoint-fingerprint "$ENDPOINT_FINGERPRINT" \
      --approval-ref "$APPROVAL_REF" \
      --backup-ref "$BACKUP_REF" \
      --backup-created-at "$BACKUP_CREATED_AT" \
      --writer-pause-proof "$WRITER_PAUSE_PROOF"
  '
```

Export the non-secret audit variables before the wrapper. The proof path must
remain available inside the command environment. Do not replace
`DATABASE_URL_UNPOOLED` with a literal URL in shell history.

## DDL contract and order

The command preserves migration order while using an online equivalent for the
large `addresses` table:

1. Apply `0009_rock_island_geometry_illinois_sos` unchanged in one transaction:
   create `geometry_rings`, create `illinois_sos_component_records`, then add
   their constraints and indexes. It does not alter or rewrite existing
   `geometries` rows.
2. Apply the column portion of `0010_address_identity` in one short
   transaction: add nullable `addresses.elephant_uuid uuid` and
   `addresses.elephant_token text`.
3. Build `addresses_elephant_uuid_idx` and
   `addresses_elephant_token_idx` one at a time with `CREATE INDEX
CONCURRENTLY`. The checked-in generated migration uses blocking
   `CREATE INDEX`; do not run it directly on the live DEV table.
4. Apply `0011_identity_pair_constraint` as `NOT VALID`, then validate it
   online. The final validated definition is identical to the checked-in
   migration:

   ```sql
   (elephant_uuid IS NULL) = (elephant_token IS NULL)
   ```

5. Apply `0012_private_bbb_persistence` atomically. Create its eight empty
   tables first, build all thirty indexes while those tables are empty, then
   add its thirteen `ON DELETE RESTRICT` foreign keys last. This preserves the
   generated migration's constraints while minimizing how long locks on
   `companies`, `properties`, and `property_improvements` are held.
6. Verify every target column, table, index, foreign key, constraint, and
   validation state.
7. Only after successful verification, record the four pinned checked-in
   hashes and journal timestamps for `0009` through `0012` in
   `drizzle.__drizzle_migrations`.

The ledger entries form the reviewed checkpoint for a database whose older
schema was installed before migration recording. They do not replay or claim
new data changes for older migrations.

## Compatibility and data safety

- All changes are additive. The command has no `DELETE`, `UPDATE`, `TRUNCATE`,
  data backfill, or publication step.
- Existing address rows receive `NULL` for both new nullable columns without a
  table rewrite.
- Existing loaders remain compatible because both-null identity is valid.
- The current loader writes both identity values together. The check rejects a
  future one-sided identity write.
- `geometry_rings` references existing `geometries` with `ON DELETE CASCADE`;
  migration `0009` does not modify parent rows.
- Failed transactional phases roll back. The Drizzle ledger is not advanced
  until the complete final schema verifies.
- Re-running the same approved command is idempotent. It verifies completed
  phases and keeps exactly four target ledger rows.
- Repository journal entries, timestamps, and SQL hashes are pinned. The
  runner rejects a changed file, missing target entry, unknown target-era
  entry, or migration newer than `0012`.

## Lock and table-size risk

The 2026-10-21 read-only DEV inspection reported approximately:

- 10,869,128 address rows;
- 14,611,619,840 bytes of address heap;
- 7,197,089,792 bytes of existing address indexes; and
- 23,071,301,632 bytes total for `addresses`.

Re-run `--plan` immediately before the window; its current metadata supersedes
these observations.

Risk by phase:

- `0009`: creates new empty tables. Catalog and referenced-table locks are
  short, but the foreign key briefly locks `geometries`.
- Nullable columns: PostgreSQL 17 performs metadata-only adds, but each change
  still needs `ACCESS EXCLUSIVE` on `addresses`. A five-second lock timeout
  fails instead of waiting behind long transactions.
- Concurrent indexes: allow normal reads and writes, but each scans the full
  address heap and consumes I/O, CPU, temporary space, WAL, and index storage.
  Run one at a time during the approved low-traffic window.
- Constraint add: takes a brief `ACCESS EXCLUSIVE` lock without scanning old
  rows because it is added `NOT VALID`.
- Constraint validation: scans the address table under `SHARE UPDATE
EXCLUSIVE`; reads and ordinary writes continue, but concurrent schema work
  must not run.
- `0012`: creates eight new empty tables, thirteen restrictive foreign keys,
  and thirty secondary indexes. It neither scans nor rewrites a BBB table
  because every target table is new and empty. Non-concurrent index creation is
  online-safe here and avoids `CREATE INDEX CONCURRENTLY` transaction
  restrictions. The runner creates those indexes before foreign keys so locks
  on existing parents are acquired only at the end of the short atomic phase.
  Foreign-key validation scans the empty children, not the large parent tables.
  The remaining risk is brief catalog/reference locking on `companies`,
  `properties`, and `property_improvements`; the five-second lock timeout fails
  closed rather than waiting behind a writer. Re-run the plan for current parent
  table sizes and keep all writers paused.

Do not resume loaders merely because the column phase completed. Wait for final
verification and the ledger checkpoint.

## Checkpoints

Record only the row-free JSON reports and approved references:

1. **Plan** — direct connection, expected endpoint/database/role fingerprints,
   no blockers, current table sizes, and no unexpected newer ledger entry.
2. **Backup** — fresh Neon backup reference and owner-confirmed restore test or
   documented restore procedure.
3. **Writer pause** — loader/workflow owners confirm no active writer or manual
   load.
4. **0009** — both tables, constraints, and indexes match.
5. **0010** — both nullable columns and both valid/ready indexes match.
6. **0011** — the pair check exists and `convalidated=true`.
7. **0012** — exactly eight private BBB tables, thirteen validated restrictive
   foreign keys, and thirty valid/ready secondary indexes exist.
8. **Ledger** — exactly the reviewed hashes/timestamps for `0009`–`0012` are
   present.
9. **Replay** — `--verify` has no pending action.
10. **Canary** — rerun the same one-property Leon canary and review its readback
    before approving any larger batch.

## Recovery and rollback

- **Lock timeout:** no queued migration is left behind. Keep writers paused,
  identify the long transaction from metadata, and reschedule or obtain owner
  approval before retrying.
- **Concurrent index failure:** PostgreSQL may leave an invalid index. The
  command stops and names it. Inspect `pg_index`; after owner approval, use
  `DROP INDEX CONCURRENTLY` for that invalid target index only, then rerun.
- **Constraint validation failure:** keep writers paused. The `NOT VALID`
  constraint still protects new or changed rows. Use a read-only aggregate to
  determine whether historical rows contain a one-sided identity, review a
  separate repair, and rerun validation. Do not silently drop the constraint.
- **Failure before ledger recording:** fix the reviewed cause and rerun. The
  schema phases are idempotent and the ledger remains behind until all checks
  pass.
- **Application regression after success:** roll back the application first
  and leave the nullable additive schema in place. A normal down migration
  would discard identity data or new table data and is not supported.
- **Database recovery required:** keep writers stopped and restore or cut over
  to the recorded Neon backup under deployment-owner approval. Account for any
  writes after the restore point before resuming.

Before the first private BBB load only, an owner-approved `0012` rollback may
remove the empty additive tables. Keep writers paused, retain the fresh backup,
and first prove read-only that all eight tables are empty:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
  SELECT sum(row_count) AS private_bbb_rows
  FROM (
    SELECT count(*) AS row_count FROM bbb_property_link_evidence
    UNION ALL SELECT count(*) FROM bbb_reconciliation_matches
    UNION ALL SELECT count(*) FROM bbb_reconciliation_runs
    UNION ALL SELECT count(*) FROM bbb_profile_category_memberships
    UNION ALL SELECT count(*) FROM bbb_profile_snapshots
    UNION ALL SELECT count(*) FROM bbb_artifact_watermarks
    UNION ALL SELECT count(*) FROM bbb_harvest_categories
    UNION ALL SELECT count(*) FROM bbb_harvest_runs
  ) counts;
"
```

Only when the result is exactly zero, run this reviewed rollback transaction.
It deliberately has no `CASCADE` and removes only the exact pinned `0012`
ledger row:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE bbb_property_link_evidence;
DROP TABLE bbb_reconciliation_matches;
DROP TABLE bbb_reconciliation_runs;
DROP TABLE bbb_profile_category_memberships;
DROP TABLE bbb_profile_snapshots;
DROP TABLE bbb_artifact_watermarks;
DROP TABLE bbb_harvest_categories;
DROP TABLE bbb_harvest_runs;
DO $$
DECLARE
  deleted_rows integer;
BEGIN
  DELETE FROM drizzle.__drizzle_migrations
  WHERE created_at = 1792617628787
    AND hash = 'b8eab46ca1b8acb5b86af9fd749a87577440222b2176dd1c98fd7ec5754de81a';
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  IF deleted_rows <> 1 THEN
    RAISE EXCEPTION 'Pinned 0012 ledger row was not removed';
  END IF;
END
$$;
COMMIT;
SQL
```

Then rerun the read-only plan and retain the rollback receipt. If any private
BBB row exists, do not run this rollback; preserve immutable evidence and use a
reviewed roll-forward correction.

Never improvise a destructive down migration on DEV, and never carry this
procedure to PROD without a separate reviewed plan based on PROD metadata.
