# Illinois SOS bulk expansion

## Official source inventory

Reviewed on August 14, 2026:

- [Business Data Transparency portal](https://www.ilsos.gov/data/bus-serv-home.html)
- [Corporation fixed-width specification, version 004](https://www.ilsos.gov/content/dam/data/bs/proc_corp_data.pdf)
- [LLC fixed-width specification](https://www.ilsos.gov/content/dam/data/bs/proc_llc_data.pdf)

The portal publishes daily full snapshots. Every text file has a
`RUN DATE = CCYYMMDD FILE: ...` header and a seven-digit
`END OF FILE RECORD COUNT=` trailer. The run date is component-specific;
components must not be assigned a shared date merely because they were
downloaded together.

The portal lists seven Corporation components:

- Master — `cdxallmst.zip`, 160-character records. Locally retained run date:
  `2026-07-29`; already parsed and privately loaded.
- Company Name — `cdxallnam.zip`, 197 characters. Locally retained run date:
  `2026-07-28`; already parsed and privately loaded as the explicitly reviewed
  partial-date intersection.
- Agent — `cdxallagt.zip`, 164 characters. Locally retained run date:
  `2026-07-29`; already parsed and privately loaded.
- Annual Report — `cdxallarp.zip`, 126 characters; not downloaded.
- Assumed/Old Names — `cdxallaon.zip`, 222 characters; not downloaded.
- Stock — `cdxallstk.zip`, 101 characters; not downloaded.
- Other — `cdxalloth.zip`, 127 characters; not downloaded.

The portal lists eight LLC components:

- Master — `llcallmst.zip`, 136-character records.
- Company Name — `llcallnam.zip`, 128 characters.
- Agent — `llcallagt.zip`, 164 characters.
- Annual Report — `llcallarp.zip`, 74 characters.
- Assumed Names — `llcallase.zip`, 281 characters.
- Old Names — `llcallold.zip`, 139 characters.
- Managers/Members — `llcallmgr.zip`, 163 characters.
- Series — `llcallser.zip`, 277 characters.

All unresolved manual downloads use the official static path:

`https://apps.ilsos.gov/data/bs/<filename>`

For example, the exact LLC Master URL is
`https://apps.ilsos.gov/data/bs/llcallmst.zip`. Replace only the filename with
one of the names above.

## Download result and blocker

No new bulk file was downloaded or loaded in this change.

The official portal HTML and documentation were visible through indexed
official pages, but direct command-line retrieval from `www.ilsos.gov` timed
out and the bulk transfer is Akamai/browser-sensitive. The portal also
explicitly prohibits automated queries. No interactive entity search,
anti-automation bypass, mirror, or third-party copy was used.

The current run date for each missing component is therefore unknown until an
operator downloads that exact official `apps.ilsos.gov` ZIP and reads its
internal header. A web-page access date or ZIP download date is not a valid
substitute. Put manually downloaded files on the external volume under the
ignored `downloads/illinois-sos/` tree; do not add source files to git.

## Implemented parser and private loader

`src/loader/illinois-sos-bulk.ts` implements every missing Corporation
component and all eight LLC components from the official positions. It:

- validates documented record widths, control records, and trailer counts;
- joins evidence by the official eight-digit file number without assuming that
  Corporation and LLC number spaces are shared;
- preserves each component's independent internal run date, original line,
  exact source artifact URI, source filename, and source line number;
- retains implied-decimal numeric values as exact source digits;
- creates source-hash-guarded rows for idempotent reruns.

The additive `illinois_sos_component_records` table is private source evidence.
Database checks force:

- `privacy_classification = 'private_non_publishable'`;
- `publication_approved = false`.

Names, registered-agent offices, manager/member details, precise addresses,
and contacts are not copied into public company, address, or relationship
tables. Existing safe public corporate data is unchanged.

Offline validation example:

```bash
npm run load:illinois-sos-components -- \
  --file corporation:annual_report:downloads/illinois-sos/corp/<date>/cdxallarp.txt \
  --file llc:master:downloads/illinois-sos/llc/<date>/llcallmst.txt
```

Private load after source review, database checkpoint, and host-idle check:

```bash
DATABASE_URL='postgresql://...' npm run load:illinois-sos-components -- \
  --file llc:master:downloads/illinois-sos/llc/<date>/llcallmst.txt \
  --load
```

`--load` runs a second pass in the same transaction and aborts unless that
pass changes zero rows.
