# Rock Island normalized geometry-ring proof

## Authoritative count definitions

The approved EBS-backed PostgreSQL host
`rock-island-ingest-ec2-20260810` was started on August 14, 2026 for
reconciliation and the approved additive backfill. The recount used the exact
corrected property files referenced by index CID
`QmP7WZiZhY1NyCCzzinNX3SCgobA8WqDmZ94xkzkLEaLUS` and manifest CID
`QmbcVQnR1uCc743vUKYSoYkj1GuZd8WYKDN6A5ijJVGtVq`.

GeoJSON terms are counted as follows:

- property/feature: one exported property JSON record;
- geometry component/row: one normalized `geometries` row;
- polygon: one `Polygon`, or one child coordinate array of a `MultiPolygon`;
- exterior ring: ring index `0` of a polygon, therefore equal to polygon count;
- interior ring: every polygon ring after index `0`;
- total rings: exterior plus interior rings.

The immutable corrected bytes contain:

- properties/features: `65,806`;
- geometry components/rows: `66,516`;
- unique polygons: `66,516`;
- unique exterior rings: `66,516`;
- unique interior rings: `44`, across `31` folios;
- unique total rings: `66,560`;
- malformed geometries: `0`.

The normalized database has the same `65,806` folios and `66,516` flat
exterior components. It has no `geometry_rings` child table yet, so its exact
topology gap is `44` interior rings. The gap is not `56` and is not zero.

## Why the prior 68,126 / 68,170 report was larger

Every normalized component for a multi-component folio retains the same full
folio-level raw MultiPolygon in `source_payload`. The old validators called
`readSourcePolygons` once per component and summed those observations. That
counts the same raw polygon again for each sibling component:

- raw polygon observations across component payloads: `68,126`;
- raw ring observations across component payloads: `68,170`;
- duplicated exterior observations: `1,610`;
- duplicated interior observations: `0`.

These are provenance observations, not unique GeoJSON polygons/rings. The
corrected `parcelPolygon` uses the raw folio topology once and therefore has
`66,516 + 44 = 66,560` unique rings. The earlier `56` was derived from an
unverified `68,114` exterior assumption; no immutable property bytes or live
database query produced either `68,114` exteriors or `56` interiors.

## Safety decision

The backfill gate now requires the unique topology above. It selects the one
raw polygon whose exterior matches each normalized component, so repeated
folio-level source payloads cannot duplicate sibling polygons. Apply migration
`0007` and the backfill only when the host is idle, and require:

- exactly `65,806` parcels, `66,516` components, `66,516` exteriors, `44`
  interiors, and `66,560` total child-ring rows;
- zero ring rows without a `geometries` parent;
- zero duplicate `(geometry_id, polygon_index, ring_index)` keys;
- unchanged appraisal, permit, and Illinois corporate counts;
- zero changed rows on the idempotent rerun.

The corrected public property bytes already preserve all `44` interior rings
in `parcelPolygon` and preserve exact raw provenance. A normalized database
repair does not require republication because the public bytes do not change.

## Prepared implementation

- `migrations/0009_rock_island_geometry_illinois_sos.sql` adds the child
  `geometry_rings` representation without changing existing geometry columns.
- `src/loader/appraisal-geometry.ts` preserves Polygon/MultiPolygon indexes,
  exterior/interior roles, exact coordinates, and source provenance.
- `scripts/backfill-rock-island-geometry-rings.ts` provides dry-run,
  advisory-lock, checkpoint, rollback, verification, and idempotency behavior.

The exact interior-ring source-key set is written beside each private backfill
manifest as a mode-`0600` `*.interior-ring-set.json` artifact with coordinates
excluded.

## Applied result

The geometry-ring DDL now versioned in
`0009_rock_island_geometry_illinois_sos.sql` and the ring backfill were applied
after the address/class publication dry-run worker finished. Private evidence
is in `/srv/ingest/private/rock-island/geometry-rings-20260814/`:

- apply manifest: `backfill-apply.json`;
- rollback SQL: `backfill-apply.json.rollback.sql`;
- checkpoint schema: `ri_geometry_rings_reconcile_20260814`;
- exact 44-ring set: `backfill-apply.json.interior-ring-set.json`;
- exact-set SHA-256:
  `f33f0da25ece27068bc5da9b77dc058c9540e133641e470d5e5e2250383e1b8b`;
- idempotency manifest: `backfill-idempotency.json`.

The first apply inserted `66,560` child rows. The rerun changed `0`. Final
verification found `66,516` exteriors, `44` interiors across `31` folios,
zero parent/ring orphans, zero duplicate source/index keys, and unchanged
appraisal, permit, and Illinois corporate counts. The database was idle before
shutdown, and the approved host was returned to `stopped`.
