# Open Lexicon Gaps

These are facts we should preserve in Postgres now and consider adding to the Elephant lexicon later.

## Permit / Accela gaps

Current best lexicon class: `property_improvement`.

Missing or weakly represented facts:

- dedicated `permit` or `jurisdiction_record` class
- Accela record id / alt id / module / record type hierarchy
- permit description and work-location details
- contacts by role: applicant, owner, contractor, licensed professional, architect, engineer
- contractor license numbers and license status
- workflow/status events with event date, actor, comments, and task name
- fee line items, payment status, assessed amount, paid amount, balance
- inspection comments, inspectors, result text, scheduling windows
- documents/attachments with document type, S3 URI, source URL, upload date
- custom field groups and field names from Accela

Current schema handling:

- main permit facts land in `property_improvements`
- contacts/events/fees/document links/custom fields land in `permit_*` extension tables
- full Accela payload remains in `source_payload` for every related row

## Sunbiz gaps

New classes now exist locally for:

- `business_registration`
- `business_registration_address`
- `business_registration_party`

Still missing or weakly represented facts:

- `business_registration_event` for `corevent.zip` filing history
- annual reports as repeatable child records instead of three fixed fields
- registered agent/officer party normalization into person/company subclasses
- explicit FEI normalization/visibility policy
- document image links and filing document metadata

Current schema handling:

- quarterly corporate records land in `business_registrations`
- principal/mailing address roles land in `business_registration_addresses`
- registered agents and officers land in `business_registration_parties`
- future `corevent.zip` records land in `business_registration_events`

## Appraisal gaps

Current lexicon coverage is broad, and the schema now has typed projections for property, parcel, ownership, tax, sale, structure, flood/storm, utility, layout, and lot output files. The Lee County appraiser source may still expose source-specific facts that need decisions:

- appraisal land lines / land use rows as repeatable child records
- parcel geometry quality and source CRS metadata
- tax district/millage breakdowns by authority
- exemption detail rows by exemption code/year
- building/extra feature rows that do not map cleanly to `structure` or `layout`
- owner name strings that cannot be safely split into person/company

Current schema handling:

- appraiser core facts land in existing lexicon-aligned typed tables
- ambiguous details should stay in `source_payload` until a reliable mapper exists
- matching decisions should update direct logical foreign keys only when confidence is high; otherwise keep the unmatched evidence in typed columns and `source_payload`
