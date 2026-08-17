# Rock Island private company-location confidence

Generated from the private PostgreSQL target on August 14, 2026. This report
contains aggregate counts only. It contains no company names, addresses,
contacts, address hashes, or identifiers and is not publication approval.

## Evidence rules

- Low: exact property-address match to a registered-agent office only. This is
  service-of-process evidence, not an operating location, ownership, tenancy,
  occupancy, or headquarters claim.
- Medium: exact property-address match to an authoritative principal/business
  address component, without permit corroboration.
- High: exact SOS address match plus exact permit contractor/business company
  evidence for the same property. This supports a company/property evidence
  link, not ownership or headquarters.

Each company/property pair appears only in its strongest available tier.

## Aggregate result

- Low: `1,519` unique company/property matches, `1,490` companies, `850`
  properties.
- Medium: `0` matches, `0` companies, `0` properties.
- High: `0` matches, `0` companies, `0` properties.

No authoritative principal/business address component is currently loaded.
The current Rock Island permit rows did not produce an exact normalized
company-name or existing company-ID corroboration for these address matches.

## Collision and ambiguity counts

- Address hashes linked to multiple companies: `144`
- Address hashes linked to multiple properties: `13`
- Companies linked to multiple properties: `24`
- Properties linked to multiple companies: `150`
- Normalized company names shared by multiple companies: `6`

These collisions remain aggregate warnings. No row-level linkage was published
or persisted.

## Reconciliation context

The read-only run observed:

- Rock Island appraisal parcels: `65,806`
- Rock Island appraisal properties: `65,806`
- Rock Island normalized geometry rows: `66,516`
- Rock Island permit rows: `24,786`
- private Illinois SOS companies: `1,981,254`
- private Illinois SOS registrations: `1,981,254`
- private Illinois SOS registration addresses: `1,969,007`
- private Illinois SOS registration parties: `1,977,061`

The approved EC2 host was idle before and after this report and was returned to
the stopped state.
