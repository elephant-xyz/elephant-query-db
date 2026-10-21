# DEV Query DB canary migration

Use this runbook only for the reviewed DEV schema checkpoint through migrations
`0009`–`0011`. It is the supported repair path for an existing Query DB whose
tables predate the Drizzle ledger.

Do not use `drizzle-kit generate`, a raw `psql -f`, or the normal loader as a
migration command. Do not run this procedure against PROD.

## Ownership and approval

The `elephant-xyz/elephant-query-db` repository owns the schema and migrations.
The existing Fargate reload path applies only its idempotent migration `0005`;
it does not apply the Drizzle journal. There is no automatic deployment step for
`0009`–`0011`.

Require all of the following before `--apply`:

1. Query DB schema-owner approval of the exact repository commit.
2. Deployment-owner approval of a DEV maintenance window.
3. A fresh Neon backup branch or restore point recorded as `BACKUP_REF`.
4. All Query DB loaders and other writers paused and confirmed idle.
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
  --writers-paused
```

Set `ENDPOINT_FINGERPRINT` to the value from the approved plan. Set
`APPROVAL_REF` to the approved PR, change request, or ticket. Set `BACKUP_REF`
to the new Neon backup branch or restore point. These values are audit
references, not database credentials.

The apply command fails closed when:

- the environment is not exactly `DEV`;
- the endpoint fingerprint changed;
- the connection is pooled or points at a replica;
- approval, backup, or writer-pause acknowledgement is absent;
- prerequisites, permissions, existing objects, indexes, constraints, or
  ledger hashes differ from the reviewed contract; or
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
      --writers-paused
  '
```

Export the three non-secret audit variables before the wrapper. Do not replace
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

5. Verify every target column, table, index, constraint, and validation state.
6. Only after successful verification, record the exact checked-in hashes and
   journal timestamps for `0009`, `0010`, and `0011` in
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
  phases and keeps exactly three target ledger rows.

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
7. **Ledger** — exactly the reviewed hashes/timestamps for `0009`–`0011` are
   present.
8. **Replay** — a second `--plan` has no pending action.
9. **Canary** — rerun the same one-property Leon canary and review its readback
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

Never improvise a destructive down migration on DEV, and never carry this
procedure to PROD without a separate reviewed plan based on PROD metadata.
