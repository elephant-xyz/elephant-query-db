# Illinois SOS corporation fixed-width pilot

Status: offline parser/mapper/loader pilot only. Three official Corporation
components were validated locally; Company Name is one day older than Master
and Agent, so the intersection pilot is non-production and non-publishable. No
database was changed and nothing was published.

## Official source and access findings

Reviewed August 13, 2026:

- [Illinois SOS Data Transparency Act portal](https://www.ilsos.gov/data/bus-serv-home.html)
  lists separate Corporation files for Master, Company Name, Agent, Annual
  Report, Assumed/Old Names, Stock, and Other, plus a separate LLC family. It
  describes these as public data sets, disclaims completeness/accuracy/fitness,
  and prohibits automated queries to the website.
- The portal's current **Corporations Bulk Data → Master** link is the static,
  lowercase URL
  [`https://apps.ilsos.gov/data/bs/cdxallmst.zip`](https://apps.ilsos.gov/data/bs/cdxallmst.zip).
  The former `www.ilsos.gov/data/bs/cdxallmst.zip` host/path returns 404 in a
  normal browser; the filename case was not the issue. A bounded browser GET
  with downloads denied verified HTTP 200, `application/zip`, 82,321,319 bytes,
  and `Last-Modified: Wed, 29 Jul 2026 00:12:57 GMT` without saving the file.
  The link is an ordinary anchor, not generated, session-bound, or form-backed.
- [Official Corporation fixed-width specification, version 004](https://www.ilsos.gov/content/dam/data/bs/proc_corp_data.pdf)
  says a complete Corporation run consists of seven full-snapshot files
  generated daily, not deltas. Every component joins by the unique eight-digit
  Illinois file number. Each file has a `RUN DATE = CCYYMMDD FILE: ...` header
  and `END OF FILE RECORD COUNT= NNNNNNN` trailer.
- The official Corporation widths are: Master 160, Company Name 197, Agent 164,
  Annual Report 126, Assumed/Old Names 222, Stock 101, and Other 119
  characters. This first pilot implements only Master, Company Name, and Agent.
- [Illinois Business Search terms](https://www.ilsos.gov/departments/business-services/business-searches.html)
  state that the interactive database is for individual searches only and
  prohibit copying or downloading bulk search results. It also provides
  `217-782-6961` for bulk-data contract information. This pilot never calls or
  automates that search site.
- [805 ILCS 5/1.25](https://ilga.gov/legislation/ilcs/documents/080500050K1.25.htm)
  requires annual and daily Corporation lists to be published as open data and
  identifies the president, secretary, registered agent, and registered-office
  address among the list fields.
- [Public Act 102-0049](https://ilga.gov/ftp/Public%20Acts/102/102-0049.htm)
  defines open data as machine-readable data freely available under an open
  license, without registration or restrictions that impede use or reuse.
  [805 ILCS 180/50-5](https://www.ilga.gov/documents/legislation/ilcs/documents/080501800K50-5.htm)
  applies equivalent open-data language to LLC lists at least monthly.

The portal makes download controls available and the statutes support reuse,
but the current portal does not clearly document a stable download API,
scheduled/automated retrieval conditions, rate limits, snapshot retention,
checksums, or a standalone license text attached to each file. Its blanket
automated-query prohibition makes unattended retrieval conditions unclear.
Accordingly, this phase did **not** issue an automated bulk download.

The open-data statutes support reuse, but the files contain names and addresses
of registered agents and corporate officers. The portal does not provide a
field-level privacy/republication guide for derived products. Until legal and
privacy review approves a field allowlist, public-export candidates are limited
to entity-level fields and carry `publicationApproved: false`. Agent, officer,
person, contact, and address fields remain private ingestion evidence.

### Validated Master snapshot

The manually downloaded July 29, 2026 Master snapshot is stored only in the
ignored external-volume directory
`downloads/illinois-sos/corp/2026-08-13/`:

- `cdxallmst.zip`: 82,328,501 bytes; SHA-256
  `cb47ff45c88ec0f5550fa0c0baf2f145a5abbca05f2dd00a477582b540f07b1a`
- one member, `cdxallmst.txt`: 256,677,815 bytes; SHA-256
  `99fe09d2d08c9e373cec65771d3f0ed15ea62829637c5fbaaa585e9fe30656f9`
- ZIP CRC/integrity: valid; no password or unexpected members
- header run date: `20260729`; trailer count: 1,981,387; parsed: 1,981,387;
  rejected: 0
- one retained source anomaly: invalid legacy incorporation date `19910229`;
  mapped date is null and the raw value remains in validation evidence

The portal file removes trailing spaces from its documented fixed-width rows.
The parser right-pads only for positional parsing, rejects overlong rows, and
preserves each original source line unchanged.

### Pilot-only component-date intersection

An explicit `--pilot-date-mismatch-intersection` streaming mode joined exact
Illinois file numbers without row-position or fuzzy fallback. Strict same-date
joining remains the default. Independent component provenance:

- Master `20260729`: 1,981,387 parsed; 0 rejected; 1 invalid legacy-date warning
- Agent `20260729`: 1,981,387 parsed; 0 rejected; 7 invalid legacy-date warnings
- Company Name `20260728`: 1,981,254 parsed; 0 rejected; 0 warnings
- duplicate file numbers: 0 in every component
- exact three-way intersection: 1,981,254
- Master/Agent without Name: 133; 88 have a detectable Master incorporation or
  transaction date after the Name run date
- Name without Master: 0; Name without Agent: 0; Master without Agent: 0

The offline Agent county-code aggregate produced 11,741 exact-intersection
registered-agent-office candidates for Rock Island County (`081`), across 124
city strings and 112 five-digit ZIP codes. These are agent-address candidates,
not confirmed company operating locations, occupancy, tenancy, or ownership.
No person names, street addresses, or contact details are emitted.

On August 14, a fresh Company Name download was byte-identical to the retained
July 28 artifact (same run date, count, size, and SHA-256), so it did not provide
a strict July 29 replacement. The validated redownload is retained separately
as `cdxallnam-20260728-redownload-20260814.zip`.

A private, partial, non-publishable load descriptor is ready at
`downloads/illinois-sos/corp/2026-08-13/illinois-sos-private-partial-20260729-manifest.json`.
It references the validated component hashes, exact 1,981,254-key intersection,
133 exclusions, component dates, privacy role limits, and the previously
approved stopped EC2 PostgreSQL target. No load was started.

## Generic contracts versus Florida assumptions

The reusable logical tables are:

- `companies`
- `business_registrations`
- `business_registration_addresses`
- `business_registration_parties`
- `business_registration_annual_reports`
- `business_registration_events`
- shared `addresses` and `people`

Their source metadata contract is generic PostgreSQL: stable
`(source_system, source_record_key)`, a source hash, artifact URI, loaded time,
and lossless `source_payload`. The loader uses `DATABASE_URL` and no Neon-only
API.

Florida Sunbiz remains a useful implementation reference, but these assumptions
must not leak into Illinois:

- source system `sunbiz`
- Florida document-number shapes
- FEI availability
- Florida filing/status codes
- three flattened annual-report slots
- `more_than_six_officers`
- Florida-specific address selection, ZIP-prefix scope, and S3 paths
- Sunbiz request-identifier prefixes and company reference keys
- treating a principal/mailing address as present when the Illinois component
  does not supply one

Illinois uses `source_system = 'illinois_sos'`, the eight-digit Illinois file
number as `document_number`, Illinois status/type codes, and the official
snapshot run date in source payload. The Corporation Master format combines
each president/secretary name and address into one 60-character field without a
documented delimiter. The pilot preserves each field as role-labelled raw
evidence and does not guess person or address boundaries.

The Agent component supplies a registered-agent/registered-office address. It
is stored with role `registered_agent_office`. It is not relabelled as a
principal address and does not imply that the corporation owns, occupies,
leases, or conducts business at a matched property.

## Implemented pilot

`src/loader/illinois-sos.ts` provides:

- strict header, trailer, count, numeric-field, date, and fixed-width validation
- strict Master/Name/Agent joins by Illinois file number and run date
- lossless provenance and role-labelled officer/agent evidence
- dependency-ordered mapping into the existing generic logical tables
- source-hash guarded idempotent PostgreSQL upserts
- Rock Island candidate selection by official Agent county code `081`
- normalized-address-hash comparison that emits evidence only, never a property
  relationship
- entity-only, not-approved public-export candidates

`scripts/run-illinois-sos-pilot.ts` never downloads data. It validates any one
local component offline. With all three implemented components it can join and
summarize the snapshot. Database matching and loading are separate opt-in flags:

```bash
# Offline validation only; DATABASE_URL is not needed.
npm run load:illinois-sos -- \
  --master downloads/illinois-sos/corp/2026-08-13/<official-master-file>

# Read-only appraisal count and address-hash match summary.
DATABASE_URL='postgresql://...' npm run load:illinois-sos -- \
  --master downloads/illinois-sos/corp/2026-08-13/<master> \
  --name downloads/illinois-sos/corp/2026-08-13/<name> \
  --agent downloads/illinois-sos/corp/2026-08-13/<agent> \
  --match-database

# Private idempotent load, only after the files and match summary are reviewed.
DATABASE_URL='postgresql://...' npm run load:illinois-sos -- \
  --master downloads/illinois-sos/corp/2026-08-13/<master> \
  --name downloads/illinois-sos/corp/2026-08-13/<name> \
  --agent downloads/illinois-sos/corp/2026-08-13/<agent> \
  --load
```

The repository ignores `downloads/`; official source files must never be added
to git.

## What was simulated

Tests use one fictional, non-PII corporation:

- 1 Master + 1 Name + 1 Agent record
- 5 prepared logical rows: address, company, registration, registration address,
  and registered-agent party
- 1 Rock Island registered-office candidate
- 2 synthetic appraisal-property hash matches for the same address
- first in-memory PostgreSQL-compatible run: 5 changed rows
- identical rerun: 0 changed and 5 unchanged rows

These are adapter-test counts. Official offline intersection counts are
documented above.

## Private partial load result

On 2026-08-14, the explicitly approved existing Rock Island EC2 PostgreSQL
database was started, loaded, verified, checkpointed, and stopped. No new AWS
resource was provisioned and no public publication was performed during the
private-load phase.

- staged exact intersection: 1,981,254
- excluded Master/Agent keys without a Name record: 133
- validation warnings retained: 8
- companies and business registrations: 1,981,254 each
- registered-agent office addresses and registration-address rows: 1,969,007
  each; 12,247 source records had no usable agent-office address
- registered-agent party rows: 1,977,061; 4,193 source records had no agent name
- official county-code `081` agent-office candidates: 11,741
- exact normalized appraisal-address-hash candidates: 13,694
- identical rerun: 0 inserts, 0 updates, and all eligible rows skipped
- appraisal parcels before and after: 65,806; appraisal table counts and
  timestamps were unchanged
- every registration carries `componentDateMismatch=true`, `coverage=partial`,
  `privacy=private`, and `publishable=false`
- reversible checkpoint:
  `/srv/ingest/backups/illinois-sos-preload-20260729`
- temporary encrypted S3 transfer objects were deleted; the EBS-backed instance
  was returned to `stopped`

These candidates are shared-address evidence only. Registered-agent addresses
do not establish an operating location, occupancy, tenancy, or ownership.

## Public organization-only publication

The user later accepted the mixed-date snapshot as current-as-published and
approved publication of a fail-closed non-PII organization subset. The separate
dataset was published on 2026-08-14 without modifying the 65,806-property
publication.

- schema: `illinois-sos-rock-island-corporate-registration-public-v1`
- rows and unique Illinois file numbers: 11,741
- scope: official registered-agent office county code `081`, represented only
  as coarse county label `Rock Island`
- statewide intersection: 1,981,254 of 1,981,387, or 99.9933%; 133 excluded
- excluded statewide records with county code `081`: 0
- component dates: Master/Agent `2026-07-29`, Name `2026-07-28`
- semantic privacy scan: 11,741 rows; zero forbidden keys or values
- organization-only fields: Illinois file number, legal company name, entity
  type/status, available incorporation date, source and snapshot labels, and
  coarse county scope
- explicitly absent: agent/officer/person names, all precise address/contact
  data, raw payloads, hashes, property IDs/matches, complaints, and reviews
- dedicated bucket:
  `elephant-oracle-corporate-registration-rock-island`
- manifest CID: `QmXcB1Z4NMtrb96MWnyckE3mS9x7jLXLVCorBDBMcAkxGh`
- Parquet CID: `QmY44DzhzYcTBjVbjQhDYdcpfMCoPpPFcUs8tjuk7cCbqJ`
- schema CID: `QmWxP8FaU2KQ4fsrrEnjTTNVxjvzQscLtwskZFdmopSwMJ`
- stable corporate IPNS:
  `k51qzi5uqu5dggdjnm0bym1p10gtu3o7dz3ipfaa4ccxgs73oohaqndzegk16d`
- coverage CID: `QmPZYuV65zqKuVrKUpnZ5bTkmHryPCSPdA1dSBmnoyFADa`
- stable coverage IPNS:
  `k51qzi5uqu5disduz18ogkvf3f2zgdsizl20o034fu8spgh2khri8uxmeo3khv`

The corporate IPNS resolves to a manifest that references the Parquet and schema
CIDs. Coverage reports 11,741 corporate rows with `expected_count=null`, so the
mixed-date snapshot is not misrepresented as a same-date complete source.
Permits and BBB remain un-ingested. The hosted MCP still exposes 65,806 property
rows and has no corporate row-query tool.

## Next explicit operator step

1. In a normal browser, open the
   [Illinois SOS Data Transparency Act portal](https://www.ilsos.gov/data/bus-serv-home.html).
2. Re-read the displayed terms, then manually obtain **Corporations Bulk Data
   → Company Name** with run date `20260729` to replace the one-day-lagged
   `20260728` component.
3. Do not use the interactive Business Search and do not script the portal.
4. Re-run the default strict three-component join before production use.
5. Before recurring downloads or public redistribution, obtain written
   confirmation from Illinois SOS Business Services (`217-782-6961`) covering
   unattended retrieval and retain the privacy-approved public field allowlist.
6. If a matching Name component is obtained, use the strict default join and
   review a replacement load separately; do not promote this partial load.

LLC files, BBB, recurring retrieval, a corporate row-query tool, and any
inferred property relationship remain out of scope.
