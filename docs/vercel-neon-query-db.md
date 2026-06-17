# Vercel Neon Query DB Provisioning

Date recorded: 2026-05-26

## Resource

- Vercel team/workspace: `elephant-xyz`
- Marketplace integration: Neon Postgres
- Resource name: `elephant-query-db`
- Vercel resource ID: `store_B1a1SflhBXyo7LaB`
- Neon external resource ID: `raspy-frost-51580436`
- Installation ID: `icfg_X7iBTade9EBSqFZVQfHznUFW`
- Region: `iad1`
- Billing plan: `Launch`
- Project connections at creation time: none (`projects: []`)

Dashboard:

```text
https://vercel.com/d/dashboard/integrations/neon/icfg_X7iBTade9EBSqFZVQfHznUFW/resources/store_B1a1SflhBXyo7LaB
```

## Provisioning command used

```bash
vercel integration add neon \
  --scope elephant-xyz \
  --name elephant-query-db \
  --no-connect \
  --metadata region=iad1 \
  --metadata auth=false \
  --format=json \
  --non-interactive
```

The `--no-connect` flag was intentional: this makes the Neon database a reusable team resource that can later be connected to whichever Vercel project needs query access.

## Verification command used

```bash
vercel integration list --all --integration neon --scope elephant-xyz --format=json
```

Expected resource entry:

```json
{
  "id": "store_B1a1SflhBXyo7LaB",
  "name": "elephant-query-db",
  "status": "available",
  "product": "Neon",
  "installationId": "icfg_X7iBTade9EBSqFZVQfHznUFW",
  "projects": []
}
```

## Next steps

1. Connect the resource to the Vercel project that will serve/query the data.
2. Pull the project env after connection so `DATABASE_URL` and related Neon variables are available locally.
3. Apply the generated query database migration:

   ```text
   migrations/0000_vengeful_ezekiel_stane.sql
   ```

4. Run the loader/upsert pipeline against the connected Neon `DATABASE_URL`.

Do not commit database credentials. Store them only in Vercel environment variables, local `.env.local`, or an approved secret store.
