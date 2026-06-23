import { describe, expect, it } from "vitest";

import { createQueryClient, type DatabaseQueryRunner } from "../scripts/run-data-load.js";
import {
  assertAppraisalPrefixIsScoped,
  buildAppraisalTransformedArtifactUri,
  buildNormalizedAddressKey,
  buildBulkMergeSql,
  buildCuratedCommercialCandidates,
  buildLeeAppraisalSearchSeed,
  buildLeeAppraisalDetailSeed,
  buildLeeDetailAddressSeed,
  buildLeeDetailInputCsv,
  buildLeeDetailPropertySeed,
  buildLeeSearchInputCsv,
  buildAppraisalMediaBlobPathname,
  buildAppraisalMediaFileRecord,
  buildPermitDocumentBlobPathname,
  expandBbbBusinessProfileRecords,
  buildScopedLoadSelectionFromManifest,
  extractLeeAppraisalSearchResult,
  extractLeeAppraisalMediaLinks,
  extractPostalCodeFromAddress,
  formatLeeStrapForFinalSegmentLeftPadSearch,
  formatLeeStrapForSearch,
  buildUpsertStatement,
  hashNormalizedAddressKey,
  addSunbizAddressReferencesToRows,
  mapAppraisalTransformedFile,
  mapBbbBusinessProfile,
  mapLeePermitDetail,
  mapSunbizAnnualReportsFromRegistration,
  mapSunbizClassRecord,
  isStorablePermitDocumentUrl,
  isLeePermitRecordSelected,
  isSunbizAddressRecordSelected,
  isSunbizClassRecordSelected,
  normalizeParcelIdentifier,
  parseJsonArtifactRecords,
  preparedRowsContainSelectedParcel,
  parseS3Uri,
  readDate,
  readSunbizDocumentNumberFromRequestIdentifier,
  readSunbizRelatedAddressPair,
  sanitizePostgresJsonValue,
  serializeBulkStageCsvHeader,
  serializeBulkStageCsvRow,
  stableJsonStringify,
  upsertPreparedRows,
  isSharedAppraisalOutputPrefix,
  normalizeS3PrefixForComparison,
  buildStreetAddressBase,
  classifyIndustrialPermit,
  inferMediaExtension,
  inferPermitDocumentExtension,
  type BulkTableColumn,
  type JsonObject,
  type LogicalTableName,
  type PreparedRow,
  type QueryClient,
  type QueryRowsResult,
} from "../src/loader/index.js";

describe("loader normalizers", () => {
  it("normalizes parcel ids, dates, names, and stable hashes deterministically", () => {
    const addressKey = buildNormalizedAddressKey("4980 Bayline Drive, North Fort Myers FL 33917");

    expect(normalizeParcelIdentifier("36-43-24-00-00001.0000")).toBe("36432400000010000");
    expect(readDate("5/6/2026")).toBe("2026-05-06");
    expect(readDate("2014-15-10")).toBeNull();
    expect(readDate("2/30/2026")).toBeNull();
    expect(addressKey).toBe("4980 bayline dr n fort myers fl 33917");
    expect(extractPostalCodeFromAddress("4980 Bayline Drive, North Fort Myers FL 33917")).toBe("33917");
    expect(extractPostalCodeFromAddress("12381 S CLEVELAND AV #501")).toBeNull();
    expect(hashNormalizedAddressKey(addressKey)).toHaveLength(64);
    expect(stableJsonStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(
      "{\"a\":{\"c\":3,\"d\":4},\"b\":2}",
    );
  });

  it("reduces permit and Sunbiz addresses to unit-insensitive street bases", () => {
    expect(buildStreetAddressBase("12800 UNIVERSITY DRIVE STE 600 FORT MYERS FL 33907")).toBe(
      "12800 university dr",
    );
    expect(buildStreetAddressBase("12381 S CLEVELAND AV #208")).toBe(
      "12381 s cleveland av",
    );
    expect(buildStreetAddressBase("16220 OLD US 41, Fort Myers, FL 33912")).toBe(
      "16220 old us 41",
    );
    expect(buildStreetAddressBase("COMMERCIAL")).toBeNull();
  });

  it("classifies industrial permit evidence with concrete use keywords", () => {
    const industrial = classifyIndustrialPermit({
      parcelIdentifier: "02442400000010010",
      permitNumber: "COM2026-00001",
      recordType: "Commercial Alteration",
      sourceRecordType: null,
      recordStatus: "Issued",
      sourceStatus: null,
      improvementStatus: null,
      workLocation: "4980 BAYLINE DR",
      sourceSearchAddress: null,
      normalizedAddressKey: null,
      unnormalizedAddress: null,
      commRes: "Commercial",
      projectDescription: "Tenant build-out for warehouse distribution space",
      description: null,
      sourceUrl: "https://example.test/permit",
      permitLinkCount: 0,
      storableDocumentLinkCount: 0,
      inspectionCount: 0,
      contactCount: 0,
    });
    const retail = classifyIndustrialPermit({
      parcelIdentifier: "02442400000010011",
      permitNumber: "COM2026-00002",
      recordType: "Commercial Alteration",
      sourceRecordType: null,
      recordStatus: "Issued",
      sourceStatus: null,
      improvementStatus: null,
      workLocation: "123 MAIN ST",
      sourceSearchAddress: null,
      normalizedAddressKey: null,
      unnormalizedAddress: null,
      commRes: "Commercial",
      projectDescription: "Retail storefront interior remodel",
      description: null,
      sourceUrl: "https://example.test/permit",
      permitLinkCount: 0,
      storableDocumentLinkCount: 0,
      inspectionCount: 0,
      contactCount: 0,
    });

    expect(industrial.isIndustrial).toBe(true);
    expect(industrial.matchedKeywords).toEqual(["warehouse", "distribution"]);
    expect(retail.isIndustrial).toBe(false);
    expect(retail.matchedKeywords).toEqual([]);
  });
});

describe("curated commercial sample selection", () => {
  it("selects commercial parcel candidates with matching Sunbiz address evidence", () => {
    const result = buildCuratedCommercialCandidates({
      limit: 10,
      permitRows: [
        {
          parcelIdentifier: "13-45-24-01-00002.0010",
          permitNumber: "COM2025-00001",
          recordType: "Commercial Alteration",
          sourceRecordType: null,
          recordStatus: "Closed-CO Issued",
          sourceStatus: null,
          improvementStatus: null,
          workLocation: "12800 UNIVERSITY DR STE 340",
          sourceSearchAddress: null,
          normalizedAddressKey: null,
          unnormalizedAddress: null,
          commRes: "Commercial",
          projectDescription: "Interior buildout",
          description: null,
          sourceUrl: "https://aca-prod.accela.com/LEECO/Cap/CapDetail.aspx",
          permitLinkCount: 3,
          storableDocumentLinkCount: 1,
          inspectionCount: 2,
          contactCount: 1,
        },
        {
          parcelIdentifier: "13-45-24-01-00002.0010",
          permitNumber: "ELE2025-00002",
          recordType: "Electrical",
          sourceRecordType: null,
          recordStatus: "Closed-CC Issued",
          sourceStatus: null,
          improvementStatus: null,
          workLocation: "12800 UNIVERSITY DR",
          sourceSearchAddress: null,
          normalizedAddressKey: null,
          unnormalizedAddress: null,
          commRes: null,
          projectDescription: "Low voltage",
          description: null,
          sourceUrl: null,
          permitLinkCount: 1,
          storableDocumentLinkCount: 0,
          inspectionCount: 1,
          contactCount: 1,
        },
        {
          parcelIdentifier: "36-43-24-00-00001.0000",
          permitNumber: "RES2025-00003",
          recordType: "Residential",
          sourceRecordType: null,
          recordStatus: "Closed-CC Issued",
          sourceStatus: null,
          improvementStatus: null,
          workLocation: "4980 BAYLINE DR",
          sourceSearchAddress: null,
          normalizedAddressKey: null,
          unnormalizedAddress: null,
          commRes: "Residential",
          projectDescription: "Kitchen",
          description: null,
          sourceUrl: null,
          permitLinkCount: 1,
          storableDocumentLinkCount: 0,
          inspectionCount: 1,
          contactCount: 0,
        },
      ],
      sunbizAddressRows: [
        {
          normalizedAddressKey: "12800 university dr 600 fort myers fl 33907",
          unnormalizedAddress: null,
          cityName: "FORT MYERS",
          postalCode: "33907",
        },
        {
          normalizedAddressKey: "9999 other rd fort myers fl 33907",
          unnormalizedAddress: null,
          cityName: "FORT MYERS",
          postalCode: "33907",
        },
      ],
    });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.parcelIdentifier).toBe("13452401000020010");
    expect(result.selected[0]?.addressBase).toBe("12800 university dr");
    expect(result.selected[0]?.permitCount).toBe(2);
    expect(result.selected[0]?.commercialPermitCount).toBe(1);
  });

  it("can keep non-commercial permit-coded candidates for later appraisal verification", () => {
    const result = buildCuratedCommercialCandidates({
      limit: 10,
      requireCommercialPermit: false,
      permitRows: [
        {
          parcelIdentifier: "36-43-24-00-00001.0000",
          permitNumber: "ELE2025-00002",
          recordType: "Electrical",
          sourceRecordType: null,
          recordStatus: "Closed-CC Issued",
          sourceStatus: null,
          improvementStatus: null,
          workLocation: "4980 BAYLINE DR",
          sourceSearchAddress: null,
          normalizedAddressKey: null,
          unnormalizedAddress: null,
          commRes: null,
          projectDescription: "Low voltage",
          description: null,
          sourceUrl: null,
          permitLinkCount: 1,
          storableDocumentLinkCount: 0,
          inspectionCount: 1,
          contactCount: 0,
        },
      ],
      sunbizAddressRows: [
        {
          normalizedAddressKey: "4980 bayline dr north fort myers fl 33917",
          unnormalizedAddress: null,
          cityName: "NORTH FORT MYERS",
          postalCode: "33917",
        },
      ],
    });

    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.commercialPermitCount).toBe(0);
  });

  it("rejects non-parcel Accela placeholders before ranking candidates", () => {
    const result = buildCuratedCommercialCandidates({
      limit: 10,
      requireCommercialPermit: false,
      permitRows: [
        {
          parcelIdentifier: "SOLARPREPAID*",
          permitNumber: "SOL2025-00001",
          recordType: "Solar",
          sourceRecordType: null,
          recordStatus: "Closed-CC Issued",
          sourceStatus: null,
          improvementStatus: null,
          workLocation: "4980 BAYLINE DR",
          sourceSearchAddress: null,
          normalizedAddressKey: null,
          unnormalizedAddress: null,
          commRes: null,
          projectDescription: "Solar prepaid placeholder",
          description: null,
          sourceUrl: null,
          permitLinkCount: 1,
          storableDocumentLinkCount: 0,
          inspectionCount: 1,
          contactCount: 0,
        },
      ],
      sunbizAddressRows: [
        {
          normalizedAddressKey: "4980 bayline dr north fort myers fl 33917",
          unnormalizedAddress: null,
          cityName: "NORTH FORT MYERS",
          postalCode: "33917",
        },
      ],
    });

    expect(result.selected).toHaveLength(0);
    expect(result.permitRowsWithUsableParcel).toBe(0);
  });
});

describe("scoped final load helpers", () => {
  it("builds scoped parcel and address sets from a curated manifest", () => {
    const selection = buildScopedLoadSelectionFromManifest({
      candidates: [
        {
          parcelIdentifier: "13-45-24-01-00002.0010",
          addressBase: "12800 UNIVERSITY DRIVE",
          appraisalOutputS3Uri: "s3://example-bucket/appraisal/one/transformed_output.zip",
          bestPermitAddress: "ignored",
        },
        {
          parcelIdentifier: "36-43-24-00-00001.0000",
          bestPermitAddress: "4980 BAYLINE DR, NORTH FORT MYERS FL 33917",
        },
      ],
    });

    expect(selection.sourceCandidateCount).toBe(2);
    expect(selection.appraisalArtifactUris.has("s3://example-bucket/appraisal/one/transformed_output.zip")).toBe(true);
    expect(selection.parcelIdentifiers.has("13452401000020010")).toBe(true);
    expect(selection.parcelIdentifiers.has("36432400000010000")).toBe(true);
    expect(selection.addressBases.has("12800 university dr")).toBe(true);
    expect(selection.addressBases.has("4980 bayline dr")).toBe(true);
  });

  it("uses explicit appraisal artifact URIs and falls back to parcel matching", () => {
    const exactArtifactSelection = buildScopedLoadSelectionFromManifest({
      candidates: [
        {
          parcelIdentifier: "13-45-24-01-00002.0010",
          addressBase: "12800 university dr",
          appraisalOutputS3Uri: "s3://example-bucket/appraisal/selected/transformed_output.zip",
        },
      ],
    });

    const selectedArtifactRow = {
      tableName: "parcels",
      values: {
        parcel_identifier: "99999999999999999",
        source_artifact_uri: "s3://example-bucket/appraisal/selected/transformed_output.zip",
      },
    } satisfies PreparedRow;
    const matchingParcelWrongArtifactRow = {
      tableName: "parcels",
      values: {
        parcel_identifier: "13452401000020010",
        source_artifact_uri: "s3://example-bucket/appraisal/other/transformed_output.zip",
      },
    } satisfies PreparedRow;
    const unrelatedParcelWrongArtifactRow = {
      tableName: "parcels",
      values: {
        parcel_identifier: "99999999999999999",
        source_artifact_uri: "s3://example-bucket/appraisal/other/transformed_output.zip",
      },
    } satisfies PreparedRow;

    expect(preparedRowsContainSelectedParcel([selectedArtifactRow], exactArtifactSelection)).toBe(true);
    expect(preparedRowsContainSelectedParcel([matchingParcelWrongArtifactRow], exactArtifactSelection)).toBe(true);
    expect(preparedRowsContainSelectedParcel([unrelatedParcelWrongArtifactRow], exactArtifactSelection)).toBe(false);

    const parcelOnlySelection = buildScopedLoadSelectionFromManifest({
      candidates: [
        {
          parcelIdentifier: "13-45-24-01-00002.0010",
          addressBase: "12800 university dr",
        },
      ],
    });

    expect(preparedRowsContainSelectedParcel([matchingParcelWrongArtifactRow], parcelOnlySelection)).toBe(true);
  });

  it("filters permit and Sunbiz records by scoped parcel/address evidence", () => {
    const selection = buildScopedLoadSelectionFromManifest({
      candidates: [
        {
          parcelIdentifier: "13-45-24-01-00002.0010",
          addressBase: "12800 university dr",
        },
      ],
    });

    expect(isLeePermitRecordSelected({ parcelIdentifier: "13452401000020010" }, selection)).toBe(true);
    expect(isLeePermitRecordSelected({
      moreDetails: { "Parcel Number": "36-43-24-00-00001.0000" },
    }, selection)).toBe(false);
    expect(isSunbizAddressRecordSelected({
      request_identifier: "sunbiz:address:abc",
      unnormalized_address: "12800 UNIVERSITY DR STE 600 FORT MYERS FL 33907",
    }, selection)).toBe(true);
    expect(isSunbizAddressRecordSelected({
      request_identifier: "sunbiz:address:def",
      unnormalized_address: "9999 OTHER RD FORT MYERS FL 33907",
    }, selection)).toBe(false);
  });

  it("keeps Sunbiz document classes and attaches relationship address references", () => {
    const relatedPair = readSunbizRelatedAddressPair({
      relationship_type: "business_registration_address_has_address",
      from: {
        type: "business_registration_address",
        request_identifier: "sunbiz:N92000000500:business_registration_address:principal",
      },
      to: {
        type: "address",
        request_identifier: "sunbiz:address:2da0744eec6559d593829efa",
      },
    });

    expect(relatedPair).toEqual({
      relationshipType: "business_registration_address_has_address",
      relatedSourceRecordKey: "sunbiz:N92000000500:business_registration_address:principal",
      addressSourceRecordKey: "sunbiz:address:2da0744eec6559d593829efa",
      documentNumber: "N92000000500",
    });
    expect(readSunbizDocumentNumberFromRequestIdentifier("sunbiz:N92000000500:company")).toBe("N92000000500");

    const selectedDocuments = new Set(["N92000000500"]);
    const selectedAddresses = new Set(["sunbiz:address:2da0744eec6559d593829efa"]);
    expect(isSunbizClassRecordSelected({
      classType: "business_registration",
      record: { document_number: "N92000000500" },
      selectedAddressSourceRecordKeys: selectedAddresses,
      selectedDocumentNumbers: selectedDocuments,
    })).toBe(true);
    expect(isSunbizClassRecordSelected({
      classType: "address",
      record: { request_identifier: "sunbiz:address:2da0744eec6559d593829efa" },
      selectedAddressSourceRecordKeys: selectedAddresses,
      selectedDocumentNumbers: selectedDocuments,
    })).toBe(true);

    const rows: readonly PreparedRow[] = [
      {
        tableName: "business_registration_addresses",
        values: {
          source_record_key: "sunbiz:N92000000500:business_registration_address:principal",
          source_system: "sunbiz",
        },
      },
    ];
    const enrichedRows = addSunbizAddressReferencesToRows(
      rows,
      new Map([[
        "sunbiz:N92000000500:business_registration_address:principal",
        "sunbiz:address:2da0744eec6559d593829efa",
      ]]),
    );

    expect(enrichedRows[0]?.references?.addressSourceRecordKey).toBe("sunbiz:address:2da0744eec6559d593829efa");
  });
});

describe("Lee appraisal search helpers", () => {
  it("formats Accela parcel identifiers as Lee STRAP search values", () => {
    expect(formatLeeStrapForSearch("2445240000005002")).toBe("24-45-24-00-00005.0020");
    expect(formatLeeStrapForSearch("24452400000051000")).toBe("24-45-24-00-00005.1000");
    expect(formatLeeStrapForSearch("06-46-24-00-00003.1100")).toBe("06-46-24-00-00003.1100");
    expect(formatLeeStrapForSearch("not a parcel")).toBeNull();
    expect(formatLeeStrapForFinalSegmentLeftPadSearch("0248253014000001")).toBe(
      "02-48-25-30-14000.0001",
    );
    expect(formatLeeStrapForFinalSegmentLeftPadSearch("06-46-24-00-00003.1100")).toBeNull();
  });

  it("builds LeeCurated search seeds while preserving Lee jurisdiction in JSON seeds", () => {
    const seed = buildLeeAppraisalSearchSeed({
      rank: 1,
      parcelIdentifier: "2445240000005002",
      bestPermitAddress: "12995 S CLEVELAND AVE",
    });

    expect(seed?.leeStrap).toBe("24-45-24-00-00005.0020");
    expect(buildLeeSearchInputCsv(seed!)).toContain("LeeCurated,1,2445240000005002");
  });

  it("extracts Folio ID and site evidence from a Lee STRAP search result page", () => {
    const result = extractLeeAppraisalSearchResult(`
      <span class="resultsHeader">Search by <u>STRAP</u> for <em>'24452400000050020'</em> found 1 match</span>
      <div class="item">24-45-24-00-00005.0020</div>
      <div class="item">10211376</div>
      <div class="bold">FM HOTEL OFFICE VENTURE LP</div>
      <div class="itemAddAndLegal">
        <div>5255 BIG PINE WAY</div>
        <div>FORT MYERS FL 33907</div>
      </div>
      <div class="itemAddAndLegal">
        <div>PARL NW 1/4 OF NW 1/4 IN AS DESC IN OR 3265 PG 3329</div>
      </div>
      <a href="/Display/DisplayParcel.aspx?FolioID=10211376" title="Display Parcel Details For 24-45-24-00-00005.0020">Parcel Details</a>
    `);

    expect(result).toMatchObject({
      searchedFor: "24452400000050020",
      strap: "24-45-24-00-00005.0020",
      normalizedParcelIdentifier: "24452400000050020",
      folioId: "10211376",
      ownerName: "FM HOTEL OFFICE VENTURE LP",
      siteAddress: "5255 BIG PINE WAY, FORT MYERS FL 33907",
      detailUrl: "https://www.leepa.org/Display/DisplayParcel.aspx?FolioID=10211376",
    });
  });

  it("builds Lee Folio detail seeds that use the real Lee browser flow", () => {
    const searchSeed = buildLeeAppraisalSearchSeed({
      rank: 1,
      parcelIdentifier: "2445240000005002",
      bestPermitAddress: "12995 S CLEVELAND AVE",
    });
    const searchResult = extractLeeAppraisalSearchResult(`
      <span class="resultsHeader">Search by <u>STRAP</u> for <em>'24452400000050020'</em> found 1 match</span>
      <div class="item">24-45-24-00-00005.0020</div>
      <div class="item">10211376</div>
      <div class="bold">FM HOTEL OFFICE VENTURE LP</div>
      <div class="itemAddAndLegal">
        <div>5255 BIG PINE WAY</div>
        <div>FORT MYERS FL 33907</div>
      </div>
      <a href="/Display/DisplayParcel.aspx?FolioID=10211376" title="Display Parcel Details For 24-45-24-00-00005.0020">Parcel Details</a>
    `);

    const detailSeed = buildLeeAppraisalDetailSeed({
      searchSeed: searchSeed!,
      searchResult: searchResult!,
    });
    const propertySeed = buildLeeDetailPropertySeed(detailSeed);
    const addressSeed = buildLeeDetailAddressSeed(detailSeed);

    expect(buildLeeDetailInputCsv(detailSeed)).toContain("Lee,1,24452400000050020");
    expect(propertySeed).toMatchObject({
      request_identifier: "10211376",
      parcel_id: "24452400000050020",
      original_parcel_id: "2445240000005002",
      folio_id: "10211376",
    });
    expect(propertySeed.source_http_request).toMatchObject({
      url: "https://leepa.org/Display/DisplayParcel.aspx",
      method: "GET",
      multiValueQueryString: {
        FolioID: ["10211376"],
        PropertyDetailsCurrent: ["True"],
        PermitDetails: ["True"],
      },
    });
    expect(addressSeed).toMatchObject({
      request_identifier: "10211376",
      full_address: "5255 BIG PINE WAY, FORT MYERS FL 33907",
      county_jurisdiction: "Lee",
    });
  });
});

describe("appraisal and permit document media helpers", () => {
  it("extracts useful Lee appraisal media links and keeps the largest duplicate", () => {
    const links = extractLeeAppraisalMediaLinks(`
      <img src="/dotnet/photo/photo.aspx?id=1874899&amp;Width=440" />
      <a href="/dotnet/photo/photo.aspx?id=1874899&amp;Width=640">large</a>
      <img src="https://gissvr.leepa.org/TaxMapImage/TaxMapImage.aspx?FolioID=10196140&amp;w=387&amp;h=290" />
      <a href="/dotnet/FloorPlan/FloorPlanGenerator.aspx?FolioID=10196140&amp;BuildingNo=1&amp;FloorNo=1&amp;Current=true&amp;Weight=640">plan</a>
      <img src="/images/LeePALogo.png" />
    `);

    expect(links.map((link) => [link.kind, link.identityKey, link.preferredWidth])).toEqual([
      ["APPRAISAL_FLOOR_PLAN", "floorplan:10196140:1:1:true", null],
      ["APPRAISAL_PHOTO", "photo:1874899", 640],
      ["APPRAISAL_TAX_MAP", "taxmap:10196140", 387],
    ]);
    expect(links[1]?.url).toContain("Width=640");
  });

  it("builds stored appraisal media file records for the files table", () => {
    const [link] = extractLeeAppraisalMediaLinks(
      `<a href="/dotnet/photo/photo.aspx?id=1874899&amp;Width=640">photo</a>`,
    );
    const blobPath = buildAppraisalMediaBlobPathname({
      extension: inferMediaExtension({ contentType: "image/jpeg", url: link!.url }),
      link: link!,
      requestIdentifier: "10196140",
    });
    const record = buildAppraisalMediaFileRecord({
      blobUrl: "https://blob.vercel-storage.com/appraisal-media/photo.jpg",
      contentSha256: "abc123",
      contentType: "image/jpeg",
      index: 1,
      link: link!,
      requestIdentifier: "10196140",
      sourceHttpRequest: { url: "https://leepa.org/Display/DisplayParcel.aspx", method: "GET" },
      uploadedAt: "2026-05-28T00:00:00.000Z",
    });

    expect(blobPath).toMatch(/^appraisal-media\/lee\/10196140\/photo-1874899-[a-f0-9]{16}\.jpg$/);
    expect(record).toMatchObject({
      request_identifier: "10196140",
      document_type: "APPRAISAL_PHOTO",
      file_format: "image/jpeg",
      ipfs_url: "https://blob.vercel-storage.com/appraisal-media/photo.jpg",
      original_url: link!.url,
      source_payload: {
        storage_provider: "vercel_blob",
        storage_uri: "https://blob.vercel-storage.com/appraisal-media/photo.jpg",
      },
    });
  });

  it("identifies storable permit document URLs and deterministic Blob paths", () => {
    expect(isStorablePermitDocumentUrl("https://aca-prod.accela.com/LEECO/UrlRouting.ashx?type=document")).toBe(
      true,
    );
    expect(isStorablePermitDocumentUrl("javascript:void(0)")).toBe(false);
    expect(inferPermitDocumentExtension({ contentType: "application/pdf", url: "https://example.test/doc" })).toBe(
      ".pdf",
    );
    expect(
      buildPermitDocumentBlobPathname({
        extension: ".pdf",
        permitNumber: "COM2025-00001",
        sourceRecordKey: "lee_accela:permit:COM2025-00001:link:document:abc",
        url: "https://example.test/document.pdf",
      }),
    ).toMatch(/^permit-documents\/lee\/com2025-00001\/[a-f0-9]{16}-[a-f0-9]{16}\.pdf$/);
  });
});

describe("loader artifact readers", () => {
  it("parses S3 URIs into AWS SDK bucket and key inputs", () => {
    expect(parseS3Uri("s3://elephant-bucket/permit-harvest/job/detail.json")).toEqual({
      bucket: "elephant-bucket",
      key: "permit-harvest/job/detail.json",
    });
  });

  it("parses whole JSON arrays and JSONL files with source line numbers", () => {
    const jsonRecords = parseJsonArtifactRecords({
      artifactUri: "file:///tmp/records.json",
      text: "[{\"id\":1},{\"id\":2}]",
    });
    const jsonlRecords = parseJsonArtifactRecords({
      artifactUri: "s3://bucket/chunk.jsonl",
      text: "{\"id\":1}\n\n{\"id\":2}\n",
      format: "jsonl",
    });

    expect(jsonRecords).toHaveLength(2);
    expect(jsonRecords[0]?.lineNumber).toBeNull();
    expect(jsonlRecords.map((entry) => entry.lineNumber)).toEqual([1, 3]);
  });
});

describe("appraisal source safety", () => {
  it("rejects the shared multi-county appraisal output prefix", () => {
    expect(normalizeS3PrefixForComparison("/outputs/")).toBe("outputs");
    expect(isSharedAppraisalOutputPrefix("outputs/")).toBe(true);
    expect(() => assertAppraisalPrefixIsScoped("outputs/")).toThrow(
      /multiple counties/,
    );
  });

  it("accepts scoped appraisal prefixes", () => {
    expect(isSharedAppraisalOutputPrefix("outputs/lee/")).toBe(false);
    expect(() => assertAppraisalPrefixIsScoped("outputs/lee/")).not.toThrow();
  });

  it("builds transformed artifact URIs for legacy and curated appraisal child prefixes", () => {
    expect(buildAppraisalTransformedArtifactUri({
      bucket: "bucket",
      commonPrefix: "outputs/lee/parcel.csv/",
    })).toBe("s3://bucket/outputs/lee/parcel.csv/transformed_output.zip");
    expect(buildAppraisalTransformedArtifactUri({
      bucket: "bucket",
      commonPrefix: "curated-commercial/appraisal/transformed-data-with-media/0001-folio-123/",
    })).toBe(
      "s3://bucket/curated-commercial/appraisal/transformed-data-with-media/0001-folio-123/transformed_output.zip",
    );
    expect(buildAppraisalTransformedArtifactUri({
      bucket: "bucket",
      commonPrefix: undefined,
    })).toBeNull();
  });
});

describe("source mappers", () => {
  it("maps a Lee permit detail into permit, address, inspection, contact, link, and custom-field rows", () => {
    const bundle = mapLeePermitDetail({
      artifactUri: "s3://bucket/lee/extracted/permits/ELE2025-02590.json",
      record: {
        recordNumber: "ELE2025-02590",
        recordType: "Electrical",
        recordStatus: "Closed-CC Issued",
        retrievedAt: "2026-05-26T12:00:00Z",
        sourceUrl: "https://aca-prod.accela.com/LEECO/Cap/CapDetail.aspx",
        workLocation: "4980 Bayline Drive North Fort Myers FL 33917",
        applicant: "Mizpah Integrations Inc.",
        licensedProfessional:
          "STEPHEN P HAMMER HAMMER SALES LTD INC 13251 MCGREGOR BLVD FORT MYERS, FL, 33919 Certified General Cntr CGC043289",
        projectDescription: "Data low voltage",
        moreDetails: {
          "Parcel Number": "36-43-24-00-00001.0000",
          Type: "Electrical",
          "Private Provider Plan Review?": "No",
          "Estimated Job Value": "$1,250.00",
        },
        completedInspections: [
          {
            result: "Pass",
            inspectionCode: "304",
            inspectionType: "Rough Electric",
            inspectionIdentifier: "6490527",
            inspectorName: "Robert Fontaine Jr",
            resultedDate: "07/31/2025",
          },
        ],
        rawText:
          "Fees *Fee Reductions Paid / Discounted* Fees: Date Invoice Number Amount 07/31/2025 12345 $125.50 View Details",
        documentLinks: [
          { text: "Document", url: "https://example.test/doc.pdf" },
          { text: "Duplicate document", url: "https://example.test/doc.pdf" },
        ],
      },
    });

    const propertyImprovement = findRow(bundle.rows, "property_improvements");
    const addresses = bundle.rows.filter((row) => row.tableName === "addresses");
    const address = addresses[0];
    const contractorAddress = addresses[1];
    const contractorPerson = findRow(bundle.rows, "people");
    const contractorCompany = findRow(bundle.rows, "companies");
    const licensedProfessionalContact = bundle.rows.find(
      (row) => row.tableName === "permit_contacts" && row.values.contact_role === "LICENSED_PROFESSIONAL",
    );
    const permitLinks = bundle.rows.filter((row) => row.tableName === "permit_links");
    const permitEvents = bundle.rows.filter((row) => row.tableName === "permit_events");
    const permitFees = bundle.rows.filter((row) => row.tableName === "permit_fees");

    expect(bundle.skippedRecords).toEqual([]);
    expect(bundle.rows.map((row) => row.tableName)).toEqual([
      "addresses",
      "addresses",
      "people",
      "companies",
      "property_improvements",
      "permit_contacts",
      "permit_contacts",
      "inspections",
      "permit_events",
      "permit_events",
      "permit_fees",
      "permit_links",
      "permit_custom_fields",
      "permit_custom_fields",
      "permit_custom_fields",
      "permit_custom_fields",
    ]);
    expect(propertyImprovement.references?.addressSourceRecordKey).toBe(
      "lee_accela:permit:ELE2025-02590:work_location",
    );
    expect(propertyImprovement.references?.companySourceRecordKey).toBe(
      contractorCompany.values.source_record_key,
    );
    expect(propertyImprovement.values.parcel_identifier).toBe("36432400000010000");
    expect(address?.values.normalized_address_hash).toEqual(
      hashNormalizedAddressKey("4980 bayline dr n fort myers fl 33917"),
    );
    expect(contractorAddress?.values.normalized_address_key).toBe(
      "13251 mcgregor blvd fort myers fl 33919",
    );
    expect(contractorPerson.values.full_name).toBe("STEPHEN P HAMMER");
    expect(contractorCompany.values.name).toBe("HAMMER SALES LTD INC");
    expect(contractorCompany.values.normalized_name).toBe("HAMMER SALES LTD INC");
    expect(licensedProfessionalContact?.references?.personSourceRecordKey).toBe(
      contractorPerson.values.source_record_key,
    );
    expect(licensedProfessionalContact?.references?.companySourceRecordKey).toBe(
      contractorCompany.values.source_record_key,
    );
    expect(licensedProfessionalContact?.references?.addressSourceRecordKey).toBe(
      contractorAddress?.values.source_record_key,
    );
    expect(licensedProfessionalContact?.values.license_type).toBe("Certified General Cntr");
    expect(licensedProfessionalContact?.values.license_number).toBe("CGC043289");
    expect(propertyImprovement.values.fee).toBe(125.5);
    expect(permitEvents.map((row) => row.values.event_type)).toEqual([
      "RECORD_STATUS",
      "INSPECTION_RESULT",
    ]);
    expect(permitEvents[0]?.values.event_status).toBe("Closed-CC Issued");
    expect(permitEvents[1]?.values.actor_name).toBe("Robert Fontaine Jr");
    expect(permitFees).toHaveLength(1);
    expect(permitFees[0]?.values.fee_code).toBe("12345");
    expect(permitFees[0]?.values.assessed_amount).toBe(125.5);
    expect(permitFees[0]?.values.paid_amount).toBe(125.5);
    expect(permitLinks).toHaveLength(1);
    expect(permitLinks[0]?.values.url).toBe("https://example.test/doc.pdf");
  });

  it("maps only the visible Accela status when historic pages include portal chrome", () => {
    const rawRecordStatus =
      "Closed-Conversion Create a New Collection * Name: Description: spell check Add Cancel Record Info Record Details Processing Status Related Records Inspections Payments Fees";
    const bundle = mapLeePermitDetail({
      artifactUri: "s3://bucket/lee/extracted/permits/COM199903906.json",
      record: {
        recordNumber: "COM199903906",
        recordType: "Commercial",
        recordStatus: rawRecordStatus,
        retrievedAt: "2026-05-26T12:00:00Z",
        sourceUrl: "https://aca-prod.accela.com/LEECO/Cap/CapDetail.aspx",
        workLocation: "100 Industrial Way Fort Myers FL 33901",
      },
    });

    const propertyImprovement = findRow(bundle.rows, "property_improvements");
    const permitEvent = bundle.rows.find((row) => row.tableName === "permit_events");

    expect(propertyImprovement.values.improvement_status).toBe("Closed-Conversion");
    expect(propertyImprovement.values.source_status).toBe("Closed-Conversion");
    expect(propertyImprovement.values.record_status).toBe("Closed-Conversion");
    expect(permitEvent?.values.event_status).toBe("Closed-Conversion");
    expect(propertyImprovement.values.source_payload).toMatchObject({
      recordStatus: rawRecordStatus,
    });
  });

  it("maps appraisal property rows with direct parcel and site-address references", () => {
    const bundle = mapAppraisalTransformedFile({
      artifactUri: "s3://bucket/appraisal/property.json",
      filePath: "property.json",
      requestIdentifier: "36-43-24-00-00001.0000",
      record: {
        request_identifier: "36-43-24-00-00001.0000",
        parcel_identifier: "36-43-24-00-00001.0000",
        property_type: "Commercial",
        property_structure_built_year: "1.1",
      },
    });
    const property = findRow(bundle.rows, "properties");

    expect(property.references?.parcelSourceRecordKey).toBe(
      "lee_appraiser:36-43-24-00-00001.0000:parcel:property_seed",
    );
    expect(property.references?.addressSourceRecordKey).toBe(
      "lee_appraiser:36-43-24-00-00001.0000:address:site",
    );
    expect(property.values.property_structure_built_year).toBe(1);
  });

  it("maps Lee appraisal owner, tax, lot, sales, and permit-history files into logical child rows", () => {
    const ownerBundle = mapAppraisalTransformedFile({
      artifactUri: "s3://bucket/appraisal/transformed_output.zip",
      filePath: "data/company_1.json",
      record: {
        request_identifier: "10211376",
        name: "Bayline Holdings LLC",
      },
    });
    const taxBundle = mapAppraisalTransformedFile({
      artifactUri: "s3://bucket/appraisal/transformed_output.zip",
      filePath: "data/tax_2025.json",
      record: {
        request_identifier: "10211376",
        tax_year: "2025",
        property_market_value_amount: "$250,000.00",
        property_assessed_value_amount: "$225,000.00",
        property_taxable_value_amount: "$200,000.00",
      },
    });
    const lotBundle = mapAppraisalTransformedFile({
      artifactUri: "s3://bucket/appraisal/transformed_output.zip",
      filePath: "data/lot.json",
      record: {
        request_identifier: "10211376",
        lot_area_sqft: "10890",
      },
    });
    const saleBundle = mapAppraisalTransformedFile({
      artifactUri: "s3://bucket/appraisal/transformed_output.zip",
      filePath: "data/sales_1.json",
      record: {
        request_identifier: "10211376",
        purchase_price_amount: "100",
        ownership_transfer_date: "1997-12-17",
      },
    });
    const improvementBundle = mapAppraisalTransformedFile({
      artifactUri: "s3://bucket/appraisal/transformed_output.zip",
      filePath: "data/property_improvement_1.json",
      record: {
        request_identifier: "10211376",
        improvement_type: "GeneralBuilding",
        improvement_status: "Completed",
        improvement_action: "Other",
        completion_date: "2024-11-18",
        permit_number: "ELE2024-04218",
        permit_required: "true",
      },
    });

    const company = findRow(ownerBundle.rows, "companies");
    const ownership = findRow(ownerBundle.rows, "ownerships");
    const tax = findRow(taxBundle.rows, "taxes");
    const valuation = findRow(taxBundle.rows, "property_valuations");
    const lot = findRow(lotBundle.rows, "lots");
    const sale = findRow(saleBundle.rows, "sales_histories");
    const improvement = findRow(improvementBundle.rows, "property_improvements");

    expect(company.values.name).toBe("Bayline Holdings LLC");
    expect(ownership.references?.propertySourceRecordKey).toBe("lee_appraiser:10211376:property:property");
    expect(ownership.references?.companySourceRecordKey).toBe("lee_appraiser:10211376:company:company_1");
    expect(ownership.values.owned_by).toBe("Bayline Holdings LLC");
    expect(tax.references?.propertySourceRecordKey).toBe("lee_appraiser:10211376:property:property");
    expect(tax.values.tax_year).toBe(2025);
    expect(tax.values.property_market_value_amount).toBe(250000);
    expect(valuation.references?.propertySourceRecordKey).toBe("lee_appraiser:10211376:property:property");
    expect(valuation.values.current_avm_value).toBe(250000);
    expect(valuation.values.valuation_date).toBe("2025-01-01");
    expect(lot.references?.propertySourceRecordKey).toBe("lee_appraiser:10211376:property:property");
    expect(lot.values.lot_area_sqft).toBe(10890);
    expect(sale.references?.propertySourceRecordKey).toBe("lee_appraiser:10211376:property:property");
    expect(sale.values.purchase_price_amount).toBe(100);
    expect(sale.values.ownership_transfer_date).toBe("1997-12-17");
    expect(improvement.references?.propertySourceRecordKey).toBe("lee_appraiser:10211376:property:property");
    expect(improvement.values.permit_number).toBe("ELE2024-04218");
    expect(improvement.values.permit_required).toBe(true);
    expect(improvement.values.completion_date).toBe("2024-11-18");
    expect(improvement.values.more_details).toEqual({});
  });

  it("maps Sunbiz records with company and registration references", () => {
    const registrationBundle = mapSunbizClassRecord({
      artifactUri: "s3://bucket/classes/business_registration/chunk-0001.jsonl",
      classType: "business_registration",
      record: {
        request_identifier: "sunbiz:P01000000001:business_registration",
        document_number: "P01000000001",
        entity_name: "BAYLINE HOLDINGS LLC",
        annual_report_1_year: "2026",
        annual_report_1_date: "04/12/2026",
      },
    });
    const reportBundle = mapSunbizAnnualReportsFromRegistration({
      artifactUri: "s3://bucket/classes/business_registration/chunk-0001.jsonl",
      record: registrationBundle.rows[0]?.values,
    });

    const registration = findRow(registrationBundle.rows, "business_registrations");
    const annualReport = findRow(reportBundle.rows, "business_registration_annual_reports");

    expect(registration.references?.companySourceRecordKey).toBe(
      "sunbiz:P01000000001:company",
    );
    expect(annualReport.references?.businessRegistrationDocumentNumber).toBe("P01000000001");
    expect(annualReport.values.report_date).toBe("2026-04-12");
  });

  it("maps authorized BBB profiles losslessly into reputation and scoring tables", () => {
    const profile = {
      id: "bbb-business-123",
      name: "Hammer Sales LTD INC",
      profileUrl: "https://www.bbb.org/us/fl/fort-myers/profile/contractor/hammer-sales-ltd-inc-123",
      websiteUrl: "https://hammer.example.test",
      phone: "239-555-0100",
      accredited: true,
      accreditedSince: "01/15/2018",
      rating: { letterGrade: "A+" },
      reviewsComplaintsSummary: {
        averageOfReviewStarRatings: 4.5,
        reviewsTotal: 4,
        totalClosedComplaintsPastThreeYears: 2,
        totalClosedComplaintsPastTwelveMonths: 1,
      },
      address: {
        streetAddress: "13251 McGregor Blvd",
        addressLocality: "Fort Myers",
        addressRegion: "FL",
        postalCode: "33919-1234",
      },
      alternateNames: [{ name: "Hammer Construction" }],
      categories: [{ name: "General Contractor", primary: true }],
      ratingReasons: [{ text: "Time in business" }],
      licenses: [{ licenseNumber: "CGC043289", licenseType: "Certified General Contractor" }],
      serviceAreas: [{ name: "Lee County", type: "county", state: "FL" }],
      businessManagement: [{ name: "Stephen P Hammer", title: "President" }],
      locations: [
        {
          type: "BRANCH",
          name: "Hammer Sales Fort Myers",
          address: {
            streetAddress: "13300 McGregor Blvd",
            addressLocality: "Fort Myers",
            addressRegion: "FL",
            postalCode: "33919",
          },
        },
      ],
      reviews: [{ id: "review-1", rating: 5, text: "Great work", date: "2026-01-02" }],
      complaints: [
        {
          id: "complaint-1",
          status: "Answered",
          text: "Scheduling issue",
          events: [{ date: "2026-02-01", type: "Business Response", text: "Resolved" }],
        },
      ],
      images: [{ url: "https://cdn.example.test/logo.png", type: "IMAGE" }],
      socialMediaLinks: [{ type: "FACEBOOK", url: "https://facebook.example.test/hammer" }],
    };
    const expandedProfiles = expandBbbBusinessProfileRecords({ data: { profiles: [profile] } });
    const bundle = mapBbbBusinessProfile({
      artifactUri: "s3://bucket/bbb/authorized/profiles.json",
      record: expandedProfiles[0],
    });

    const company = findRow(bundle.rows, "companies");
    const reputationProfile = findRow(bundle.rows, "business_reputation_profiles");
    const contact = findRow(bundle.rows, "business_reputation_contacts");
    const complaint = findRow(bundle.rows, "business_reputation_complaints");
    const complaintEvent = findRow(bundle.rows, "business_reputation_complaint_events");
    const score = findRow(bundle.rows, "contractor_quality_scores");

    expect(expandedProfiles).toHaveLength(1);
    expect(bundle.skippedRecords).toEqual([]);
    expect(bundle.rows.map((row) => row.tableName)).toEqual(expect.arrayContaining([
      "addresses",
      "companies",
      "people",
      "business_reputation_profiles",
      "business_reputation_alternate_names",
      "business_reputation_categories",
      "business_reputation_rating_reasons",
      "business_reputation_contacts",
      "business_reputation_licenses",
      "business_reputation_service_areas",
      "business_reputation_locations",
      "business_reputation_reviews",
      "business_reputation_complaints",
      "business_reputation_complaint_events",
      "business_reputation_media",
      "business_reputation_external_links",
      "contractor_quality_scores",
    ]));
    expect(company.values.name).toBe("Hammer Sales LTD INC");
    expect(reputationProfile.references?.companySourceRecordKey).toBe(company.values.source_record_key);
    expect(reputationProfile.values.provider).toBe("BBB");
    expect(reputationProfile.values.bbb_rating).toBe("A+");
    expect(reputationProfile.values.review_count).toBe(4);
    expect(reputationProfile.values.closed_complaints_past_three_years).toBe(2);
    expect(reputationProfile.values.source_payload).toMatchObject({ id: "bbb-business-123" });
    expect(contact.values.contact_name).toBe("Stephen P Hammer");
    expect(complaintEvent.references?.businessReputationComplaintSourceRecordKey).toBe(
      complaint.values.source_record_key,
    );
    expect(score.references?.businessReputationProfileSourceRecordKey).toBe(
      reputationProfile.values.source_record_key,
    );
    expect(score.references?.companySourceRecordKey).toBe(company.values.source_record_key);
    expect(score.values.scoring_model).toBe("bbb-profile-v1");
    expect(score.values.score).toBe(100);
    expect(score.values.factor_payload).toMatchObject({ bbbRating: "A+", isAccredited: true });
  });
});

describe("loader SQL helpers", () => {
  it("serializes generic bulk-stage CSV rows with JSON values and reference keys", () => {
    const header = serializeBulkStageCsvHeader();
    const row = serializeBulkStageCsvRow({
      rowIndex: 1,
      row: {
        tableName: "properties",
        references: {
          addressSourceRecordKey: "lee_appraiser:parcel-1:address:site",
          parcelSourceRecordKey: "lee_appraiser:parcel-1:parcel:property_seed",
        },
        values: {
          source_system: "lee_appraiser",
          source_record_key: "lee_appraiser:parcel-1:property:property",
          source_record_hash: "hash-1",
          source_payload: { ok: true },
          property_type: "Commercial, Mixed",
        },
      },
    });

    expect(header).toBe(
      "row_index,table_name,source_system,source_record_key,source_record_hash,source_artifact_uri,values_json,references_json\n",
    );
    expect(row).toContain("lee_appraiser:parcel-1:property:property");
    expect(row).toContain("\"{\"\"addressSourceRecordKey\"\"");
    expect(row).toContain("\"\"Commercial, Mixed\"\"");
  });

  it("sanitizes PostgreSQL-incompatible NUL characters before JSONB staging", () => {
    const sanitized = sanitizePostgresJsonValue({
      html: "before\u0000after",
      nested: ["ok", "bad\u0000value"],
      unchanged: 1,
    });
    const row = serializeBulkStageCsvRow({
      rowIndex: 1,
      row: {
        tableName: "business_reputation_profiles",
        values: {
          source_system: "bbb",
          source_record_key: "bbb:profile:nul-test",
          source_record_hash: "hash-1",
          source_payload: { html: "before\u0000after" },
        },
      },
    });

    expect(sanitized).toEqual({
      html: "before�after",
      nested: ["ok", "bad�value"],
      unchanged: 1,
    });
    expect(row).not.toContain("\\u0000");
    expect(row).toContain("before�after");
  });

  it("builds set-based bulk merge SQL with source-key reference joins", () => {
    const statement = buildBulkMergeSql({
      stageTableName: "elephant_bulk_stage_rows",
      tableName: "properties",
      columns: tableColumns("properties", [
        "property_id",
        "parcel_id",
        "address_id",
        "parcel_identifier",
        "source_system",
        "source_record_key",
        "source_record_hash",
        "source_artifact_uri",
        "source_payload",
        "created_at",
        "updated_at",
        "loaded_at",
      ]),
    });

    expect(statement).toContain("jsonb_populate_record(NULL::\"public\".\"properties\"");
    expect(statement).toContain("LEFT JOIN \"public\".\"addresses\" \"ref_address\"");
    expect(statement).toContain("LEFT JOIN \"public\".\"parcels\" \"ref_parcel\"");
    expect(statement).toContain("ON CONFLICT (\"source_system\", \"source_record_key\")");
    expect(statement).toContain(
      "WHERE \"public\".\"properties\".\"source_record_hash\" IS DISTINCT FROM EXCLUDED.\"source_record_hash\"",
    );
  });

  it("hydrates Sunbiz registration address fields from referenced address rows in bulk merge", () => {
    const statement = buildBulkMergeSql({
      stageTableName: "elephant_bulk_stage_rows",
      tableName: "business_registration_addresses",
      columns: tableColumns("business_registration_addresses", [
        "business_registration_address_id",
        "business_registration_id",
        "address_id",
        "request_identifier",
        "document_number",
        "address_role",
        "line_1",
        "line_2",
        "city",
        "state",
        "zip",
        "country",
        "single_line",
        "normalized",
        "source_system",
        "source_record_key",
        "source_record_hash",
        "source_artifact_uri",
        "source_payload",
        "created_at",
        "updated_at",
        "loaded_at",
      ]),
    });

    expect(statement).toContain("LEFT JOIN \"public\".\"addresses\" \"ref_address\"");
    expect(statement).toContain(
      "'line_1', COALESCE(NULLIF(s.\"values_json\" ->> 'line_1', ''), \"ref_address\".\"unnormalized_address\")",
    );
    expect(statement).toContain(
      "'zip', COALESCE(NULLIF(s.\"values_json\" ->> 'zip', ''), \"ref_address\".\"postal_code\")",
    );
    expect(statement).toContain(
      "OR \"public\".\"business_registration_addresses\".\"address_id\" IS DISTINCT FROM EXCLUDED.\"address_id\"",
    );
    expect(statement).toContain(
      "OR \"public\".\"business_registration_addresses\".\"single_line\" IS DISTINCT FROM EXCLUDED.\"single_line\"",
    );
  });

  it("uses ownership-specific owner FK columns in bulk merge reference joins", () => {
    const statement = buildBulkMergeSql({
      stageTableName: "elephant_bulk_stage_rows",
      tableName: "ownerships",
      columns: tableColumns("ownerships", [
        "ownership_id",
        "property_id",
        "owner_person_id",
        "owner_company_id",
        "ownership_identifier",
        "owned_by",
        "source_system",
        "source_record_key",
        "source_record_hash",
        "source_artifact_uri",
        "source_payload",
        "created_at",
        "updated_at",
        "loaded_at",
      ]),
    });

    expect(statement).toContain(
      "'owner_person_id', \"ref_owner_person\".\"person_id\"",
    );
    expect(statement).toContain(
      "'owner_company_id', \"ref_owner_company\".\"company_id\"",
    );
    expect(statement).not.toContain("'person_id', \"ref_person\".\"person_id\"");
    expect(statement).not.toContain("'company_id', \"ref_company\".\"company_id\"");
    expect(statement).toContain(
      "OR \"public\".\"ownerships\".\"owner_person_id\" IS DISTINCT FROM EXCLUDED.\"owner_person_id\"",
    );
  });

  it("refreshes appraisal property-improvement property references during bulk replay", () => {
    const statement = buildBulkMergeSql({
      stageTableName: "elephant_bulk_stage_rows",
      tableName: "property_improvements",
      columns: tableColumns("property_improvements", [
        "property_improvement_id",
        "property_id",
        "parcel_id",
        "address_id",
        "contractor_company_id",
        "request_identifier",
        "permit_number",
        "source_system",
        "source_record_key",
        "source_record_hash",
        "source_artifact_uri",
        "source_payload",
        "created_at",
        "updated_at",
        "loaded_at",
      ]),
    });

    expect(statement).toContain("'property_id', \"ref_property\".\"property_id\"");
    expect(statement).toContain(
      "'contractor_company_id', \"ref_contractor_company\".\"company_id\"",
    );
    expect(statement).toContain(
      "OR \"public\".\"property_improvements\".\"property_id\" IS DISTINCT FROM EXCLUDED.\"property_id\"",
    );
    expect(statement).toContain(
      "OR \"public\".\"property_improvements\".\"contractor_company_id\" IS DISTINCT FROM EXCLUDED.\"contractor_company_id\"",
    );
  });

  it("adapts a lazy database query runner without requiring an eager connection", async () => {
    const calls: QueryCall[] = [];
    const runner: DatabaseQueryRunner = {
      async query<Row extends JsonObject = JsonObject>(
        text: string,
        values: readonly unknown[],
      ): Promise<QueryRowsResult<Row>> {
        calls.push({ text, values });
        return rows([{ ok: true }]);
      },
    };
    const client = createQueryClient(runner);

    const result = await client.query("select $1::int as ok", [1]);

    expect(result.rows).toEqual([{ ok: true }]);
    expect(calls).toEqual([{ text: "select $1::int as ok", values: [1] }]);
  });

  it("builds source-hash guarded upserts for prepared rows", () => {
    const statement = buildUpsertStatement({
      tableName: "addresses",
      values: {
        source_system: "lee_accela",
        source_record_key: "lee_accela:permit:ELE2025-02590:work_location",
        source_record_hash: "hash-1",
        source_artifact_uri: "s3://bucket/detail.json",
        source_payload: { ok: true },
        unnormalized_address: "4980 BAYLINE DR",
      },
    });

    expect(statement.text).toContain("ON CONFLICT (\"source_system\", \"source_record_key\")");
    expect(statement.text).toContain(
      "WHERE \"addresses\".\"source_record_hash\" IS DISTINCT FROM EXCLUDED.\"source_record_hash\"",
    );
    expect(statement.text).toContain("$2::jsonb");
    expect(statement.values).toContain(JSON.stringify({ ok: true }));
  });

  it("upserts permit links by parent permit, link kind, and URL", () => {
    const statement = buildUpsertStatement({
      tableName: "permit_links",
      values: {
        property_improvement_id: "00000000-0000-0000-0000-000000000002",
        link_kind: "DOCUMENT",
        url: "https://example.test/doc.pdf",
        source_system: "lee_accela",
        source_record_key: "lee_accela:permit:ELE2025-02590:link:document:hash",
        source_record_hash: "hash-1",
        source_payload: { ok: true },
      },
    });

    expect(statement.text).toContain(
      "ON CONFLICT (\"property_improvement_id\", \"link_kind\", \"url\")",
    );
  });

  it("upserts parcels by jurisdiction and folio (request_identifier)", () => {
    const statement = buildUpsertStatement({
      tableName: "parcels",
      values: {
        jurisdiction_key: "lee_appraiser",
        request_identifier: "00000000540000",
        parcel_identifier: "00-00-00-00-0540.0000",
        source_system: "lee_appraiser",
        source_record_key: "lee_appraiser:00000000540000:parcel:property_seed",
        source_record_hash: "hash-1",
        source_payload: { ok: true },
      },
    });

    // Parcels must dedup on the folio, NOT the digits-only parcel_identifier,
    // so STRAPs that differ only by letters (e.g. condo units `…0001A`) stay
    // distinct instead of collapsing into one row.
    expect(statement.text).toContain(
      "ON CONFLICT (\"jurisdiction_key\", \"request_identifier\")",
    );
  });

  it("registers write specs for reserved future source tables", () => {
    const valuationStatement = buildUpsertStatement({
      tableName: "property_valuations",
      values: {
        source_system: "lee_appraiser",
        source_record_key: "lee_appraiser:parcel:valuation",
        source_record_hash: "hash-1",
        source_payload: { value: 1 },
      },
    });
    const eventStatement = buildUpsertStatement({
      tableName: "business_registration_events",
      values: {
        source_system: "sunbiz",
        source_record_key: "sunbiz:P01000000001:event:1",
        source_record_hash: "hash-1",
        source_payload: { event: true },
      },
    });

    expect(valuationStatement.text).toContain("RETURNING \"property_valuation_id\"");
    expect(eventStatement.text).toContain("RETURNING \"business_registration_event_id\"");
  });

  it("resolves source-key references while batch upserting rows", async () => {
    const calls: QueryCall[] = [];
    const client: QueryClient = {
      async query<Row extends JsonObject = JsonObject>(
        text: string,
        values: readonly unknown[],
      ): Promise<QueryRowsResult<Row>> {
        calls.push({ text, values });
        if (text.includes("FROM \"addresses\"")) {
          return rows([{ address_id: "00000000-0000-0000-0000-000000000001" }]);
        }
        if (text.includes("FROM \"companies\"")) {
          return rows([{ company_id: "00000000-0000-0000-0000-000000000003" }]);
        }
        if (text.startsWith("INSERT INTO \"property_improvements\"")) {
          return rows([{ property_improvement_id: "00000000-0000-0000-0000-000000000002" }]);
        }
        return rows([]);
      },
    };

    const counters = await upsertPreparedRows(client, [
      {
        tableName: "property_improvements",
        references: {
          addressSourceRecordKey: "lee_accela:permit:ELE2025-02590:work_location",
          companySourceRecordKey: "lee_accela:contractor_company:hash",
        },
        values: {
          source_system: "lee_accela",
          source_record_key: "lee_accela:permit:ELE2025-02590",
          source_record_hash: "hash-1",
          source_artifact_uri: "s3://bucket/detail.json",
          permit_number: "ELE2025-02590",
          source_payload: { permit: true },
        },
      },
    ]);

    const insertCall = calls.find((call) =>
      call.text.startsWith("INSERT INTO \"property_improvements\""),
    );

    expect(counters).toEqual({ attemptedRows: 1, changedRows: 1, unchangedRows: 0 });
    expect(insertCall?.text).toContain("\"address_id\"");
    expect(insertCall?.text).toContain("\"contractor_company_id\"");
    expect(insertCall?.values).toContain("00000000-0000-0000-0000-000000000001");
    expect(insertCall?.values).toContain("00000000-0000-0000-0000-000000000003");
  });

  it("resolves appraisal owner and improvement references to physical FK columns", async () => {
    const calls: QueryCall[] = [];
    const client: QueryClient = {
      async query<Row extends JsonObject = JsonObject>(
        text: string,
        values: readonly unknown[],
      ): Promise<QueryRowsResult<Row>> {
        calls.push({ text, values });
        if (text.includes("FROM \"properties\"")) {
          return rows([{ property_id: "00000000-0000-0000-0000-000000000010" }]);
        }
        if (text.includes("FROM \"people\"")) {
          return rows([{ person_id: "00000000-0000-0000-0000-000000000011" }]);
        }
        if (text.startsWith("INSERT INTO \"ownerships\"")) {
          return rows([{ ownership_id: "00000000-0000-0000-0000-000000000012" }]);
        }
        if (text.startsWith("INSERT INTO \"property_improvements\"")) {
          return rows([{ property_improvement_id: "00000000-0000-0000-0000-000000000013" }]);
        }
        return rows([]);
      },
    };

    const counters = await upsertPreparedRows(client, [
      {
        tableName: "ownerships",
        references: {
          personSourceRecordKey: "lee_appraiser:10211376:person:person_1",
          propertySourceRecordKey: "lee_appraiser:10211376:property:property",
        },
        values: {
          source_system: "lee_appraiser",
          source_record_key: "lee_appraiser:10211376:ownership:person_1",
          source_record_hash: "hash-1",
          source_artifact_uri: "s3://bucket/appraisal.zip",
          owned_by: "Jane Owner",
          source_payload: { owner: true },
        },
      },
      {
        tableName: "property_improvements",
        references: {
          propertySourceRecordKey: "lee_appraiser:10211376:property:property",
        },
        values: {
          source_system: "lee_appraiser",
          source_record_key: "lee_appraiser:10211376:property_improvement:1",
          source_record_hash: "hash-2",
          source_artifact_uri: "s3://bucket/appraisal.zip",
          permit_number: "COM2026-00001",
          source_payload: { improvement: true },
        },
      },
    ]);

    const ownershipInsert = calls.find((call) => call.text.startsWith("INSERT INTO \"ownerships\""));
    const improvementInsert = calls.find((call) =>
      call.text.startsWith("INSERT INTO \"property_improvements\""),
    );

    expect(counters).toEqual({ attemptedRows: 2, changedRows: 2, unchangedRows: 0 });
    expect(ownershipInsert?.text).toContain("\"owner_person_id\"");
    expect(ownershipInsert?.text).not.toContain("\"person_id\"");
    expect(ownershipInsert?.text).toContain(
      "OR \"ownerships\".\"owner_person_id\" IS DISTINCT FROM EXCLUDED.\"owner_person_id\"",
    );
    expect(ownershipInsert?.values).toContain("00000000-0000-0000-0000-000000000010");
    expect(ownershipInsert?.values).toContain("00000000-0000-0000-0000-000000000011");
    expect(improvementInsert?.text).toContain("\"property_id\"");
    expect(improvementInsert?.text).toContain(
      "OR \"property_improvements\".\"property_id\" IS DISTINCT FROM EXCLUDED.\"property_id\"",
    );
    expect(improvementInsert?.values).toContain("00000000-0000-0000-0000-000000000010");
  });
});

type QueryCall = {
  readonly text: string;
  readonly values: readonly unknown[];
};

function findRow(rows: readonly PreparedRow[], tableName: LogicalTableName): PreparedRow {
  const row = rows.find((candidate) => candidate.tableName === tableName);
  if (row === undefined) throw new Error(`Missing row for table ${tableName}`);
  return row;
}

function rows<Row extends JsonObject>(values: readonly JsonObject[]): QueryRowsResult<Row> {
  return { rows: values as readonly Row[] };
}

function tableColumns(
  tableName: LogicalTableName,
  columnNames: readonly string[],
): readonly BulkTableColumn[] {
  return columnNames.map((columnName, index) => ({
    table_name: tableName,
    column_name: columnName,
    ordinal_position: index + 1,
  }));
}
