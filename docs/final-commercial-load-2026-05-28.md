# Final Commercial Load - 2026-05-28

Loaded the Vercel Neon database `elephant-query-db` with a curated Lee County commercial-property dataset. The database was cleared before the main load, then incrementally filled with 30 additional exact parcel matches so the final canonical Lee appraisal parcel count is above 1000.

## Selection

- Main manifest: `.loader-runs/curated-commercial-sample/curated-commercial-final-1000-success-manifest.json`
- Canonical fill manifest: `.loader-runs/curated-commercial-sample/curated-commercial-canonical-fill-manifest.json`
- Final canonical Lee appraisal parcels: 1007
- Final properties: 1008
- Fill candidates: 30 exact raw-permit parcel id to canonical-appraisal parcel id matches

## Final Neon Counts

- `parcels`: 1007 distinct parcel identifiers
- `properties`: 1008 rows, 1007 distinct parcel identifiers
- `property_improvements`: 41003 Lee Accela permit/improvement rows
- `permit_links`: 45682
- `permit_custom_fields`: 41686
- `inspections`: 590
- `permit_contacts`: 1950
- `companies`: 31514
- `business_registrations`: 31514
- `addresses`: 63119

Source checks:

- Parcel sources containing `qpublic`: 0
- Parcel sources containing `columbia`: 0
- Parcel sources containing `leepa`: 1007

## Appraisal Media

All appraisal media rows have Vercel Blob URLs in `files.ipfs_url` and nested `source_payload.source_payload.storage_uri`.

- `APPRAISAL_FLOOR_PLAN`: 4497 / 4497 stored
- `APPRAISAL_PHOTO`: 1809 / 1809 stored
- `APPRAISAL_TAX_MAP`: 890 / 890 stored
- Pending appraisal media rows: 0

The canonical-fill media backfill used the temporary AWS Lambda `elephant-query-db-appraisal-media-backfill-20260528` and uploaded 227 of 227 pending rows with 0 failures.

## Permit Documents

- Permit links with stored documents: 10790
- Permit links with content hashes: 10790
- Final-1000 document uploader: 10685 uploaded, 5354 source failures
- Canonical-fill document uploader: 105 uploaded, 52 source failures

Most source failures were stale Accela document URLs returning HTTP 403 or 404. The original `permit_links.url` values remain in Neon even when the source document could not be copied to Blob.

## Source Spot Check

Checked DB parcel `03442400000370010` back to its source artifact:

- Source artifact: `s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/curated-commercial-2000-20260528/appraisal/transformed-data-with-media/1446-03442400000370010-folio-10534793/transformed_output.zip`
- Source parcel request: `10534793`
- Source county: `Lee`
- Source appraiser URL: `https://leepa.org/Display/DisplayParcel.aspx`
- DB property address: `354 PONDELLA RD, NORTH FORT MYERS FL 33903`
- DB legal description: `SE 1/2 OF S/E 1/4 OF SE 1/4 AS DESC IN INST #2006-381740`
- DB media row `lee_appraiser:10534793:file:file_appraisal_media_001` now has a Vercel Blob URL.

Checked permit `USE2007-00574` back to its source artifact:

- Source artifact: `s3://elephant-oracle-node-environmentbucket-mmsoo3xbdi80/permit-harvest/lee-permit-backfill-20260525/lee/extracted/permits/use2007-00574-ea89f48d5765.json`
- Source parcel: `03442400000370010 *`
- Source work location: `354 PONDELLA RD N FT MYERS 33903`
- Source Accela URL host: `aca-prod.accela.com/LEECO`
- DB permit parcel normalized to `03442400000370010`
- DB work location and Accela URL match the source.

## Run Artifacts

- Full stage log: `.loader-runs/logs/final-1000-stage.log`
- Full load log: `.loader-runs/logs/final-1000-load.log`
- Canonical fill stage log: `.loader-runs/logs/canonical-fill-stage.log`
- Canonical fill load log: `.loader-runs/logs/canonical-fill-load.log`
- Appraisal media backfill result: `.loader-runs/logs/appraisal-media-backfill-canonical-fill-1.json`
- Full permit document state: `.loader-runs/curated-commercial-appraisal/permit-document-upload-final-1000-state.jsonl`
- Canonical fill permit document state: `.loader-runs/curated-commercial-appraisal/permit-document-upload-canonical-fill-state.jsonl`
