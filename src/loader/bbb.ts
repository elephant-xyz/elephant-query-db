import {
  buildNormalizedAddressKey,
  buildSourceMetadata,
  compactObject,
  extractPostalCodeFromAddress,
  hashNormalizedAddressKey,
  hashString,
  isJsonObject,
  normalizeName,
  normalizePostalCode,
  readBoolean,
  readDate,
  readInteger,
  readNumber,
  readString,
  readTimestamp,
  stableJsonStringify,
} from "./normalizers.js";
import type { JsonObject, LogicalTableName, PreparedRow, PreparedRowBundle } from "./types.js";

type BbbIdentity = {
  readonly profileKey: string;
  readonly companyKey: string;
  readonly addressKey: string;
};

type BbbAddress = {
  readonly sourceRecordKey: string;
  readonly fullAddress: string;
  readonly cityName: string | null;
  readonly stateCode: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly sourcePayload: JsonObject;
};

type ChildTableSpec = {
  readonly tableName: LogicalTableName;
  readonly sourceKeyPart: string;
  readonly aliases: readonly string[];
  readonly requiredColumns: readonly string[];
  readonly values: (payload: JsonObject, ordinal: number) => JsonObject;
  readonly uniqueIdentity?: (values: JsonObject) => string | null;
};

const BBB_SOURCE_SYSTEM = "bbb";
const BBB_SCORE_MODEL = "bbb-profile-v1";

/**
 * Map one staged BBB profile JSON record into query-db rows.
 *
 * This is lossless for the input record: the full profile lands in
 * `business_reputation_profiles.source_payload`, while every known repeatable
 * BBB section also gets its own logical table row with that child payload.
 *
 * @param params - BBB profile payload and provenance URI.
 * @returns Prepared rows for companies, addresses, BBB profile data, and contractor quality scoring.
 */
export function mapBbbBusinessProfile(params: {
  readonly record: unknown;
  readonly artifactUri: string | null;
}): PreparedRowBundle {
  if (!isJsonObject(params.record)) {
    return {
      rows: [],
      skippedRecords: [
        {
          artifactUri: params.artifactUri,
          reason: "BBB profile record is not a JSON object",
          sourcePayload: { value: params.record },
        },
      ],
    };
  }

  const identity = readIdentity(params.record);
  if (identity === null) {
    return {
      rows: [],
      skippedRecords: [
        {
          artifactUri: params.artifactUri,
          reason: "BBB profile record is missing a stable identifier, URL, or business name",
          sourcePayload: params.record,
        },
      ],
    };
  }

  const address = readBbbAddress(params.record, identity.addressKey);
  const rows: PreparedRow[] = [
    ...(address === null ? [] : [addressRow(address, params.artifactUri)]),
    companyRow(params.record, identity, params.artifactUri),
    profileRow(params.record, identity, address, params.artifactUri),
    ...childRows(params.record, identity.profileKey, params.artifactUri),
    ...contactRows(params.record, identity.profileKey, params.artifactUri),
    ...locationRows(params.record, identity.profileKey, params.artifactUri),
    ...complaintRows(params.record, identity.profileKey, params.artifactUri),
    ...qualityScoreRows(params.record, identity, params.artifactUri),
  ];

  return { rows: dedupeRows(rows), skippedRecords: [] };
}

/**
 * Expand one staged BBB profile artifact record into profile-shaped records.
 *
 * BBB browser-harvest or feed/export formats may deliver a single profile JSON object, a whole
 * JSON array, JSONL profile objects, or an envelope such as `{ businesses: [] }`
 * / `{ data: { profiles: [] } }`. This helper keeps the loader tolerant of
 * those artifact shapes while keeping live browser collection outside query-db.
 *
 * @param record - Parsed JSON value from a BBB artifact.
 * @returns Profile candidate records that can each be mapped with `mapBbbBusinessProfile`.
 */
export function expandBbbBusinessProfileRecords(record: unknown): readonly unknown[] {
  if (Array.isArray(record)) return record;
  if (!isJsonObject(record)) return [record];
  const directProfiles = readFirstArray(record, [
    "businesses",
    "business_profiles",
    "businessProfiles",
    "profiles",
    "results",
    "items",
  ]);
  if (directProfiles !== null) return directProfiles;
  const dataValue = readPath(record, "data");
  if (Array.isArray(dataValue)) return dataValue;
  if (isJsonObject(dataValue)) {
    const nestedProfiles = readFirstArray(dataValue, [
      "businesses",
      "business_profiles",
      "businessProfiles",
      "profiles",
      "results",
      "items",
    ]);
    if (nestedProfiles !== null) return nestedProfiles;
  }
  return [record];
}

function readIdentity(record: JsonObject): BbbIdentity | null {
  const existingKey = readFirstString(record, ["source_record_key", "request_identifier"]);
  const sourceValue =
    existingKey ??
    readFirstString(record, [
      "id",
      "profile_id",
      "profileId",
      "business_id",
      "businessId",
      "bbb_business_id",
      "bbbBusinessId",
      "business_url",
      "businessUrl",
      "profile_url",
      "profileUrl",
      "url",
      "name",
      "business_name",
      "businessName",
    ]);
  if (sourceValue === null) return null;
  const profileKey = existingKey?.startsWith("bbb:") === true
    ? existingKey
    : `bbb:profile:${hashString(sourceValue.toLowerCase())}`;
  return {
    profileKey,
    companyKey: `${profileKey}:company`,
    addressKey: `${profileKey}:address:primary`,
  };
}

function companyRow(record: JsonObject, identity: BbbIdentity, artifactUri: string | null): PreparedRow {
  const name = readBusinessName(record);
  return {
    tableName: "companies",
    values: compactObject({
      ...metadata(identity.companyKey, record, artifactUri),
      request_identifier: identity.companyKey,
      name,
      normalized_name: normalizeName(name),
      source_http_request: sourceHttpRequest(readProfileUrl(record)),
      source_payload: record,
    }),
  };
}

function profileRow(
  record: JsonObject,
  identity: BbbIdentity,
  address: BbbAddress | null,
  artifactUri: string | null,
): PreparedRow {
  const profileUrl = readProfileUrl(record);
  const rating = readBbbRating(record);
  const summary = readReviewComplaintSummary(record);
  const name = readBusinessName(record);
  return {
    tableName: "business_reputation_profiles",
    references: address === null
      ? { companySourceRecordKey: identity.companyKey }
      : {
          addressSourceRecordKey: address.sourceRecordKey,
          companySourceRecordKey: identity.companyKey,
        },
    values: compactObject({
      ...metadata(identity.profileKey, record, artifactUri),
      request_identifier: identity.profileKey,
      provider: "BBB",
      provider_profile_id: readFirstString(record, ["profile_id", "profileId", "id"]),
      provider_business_id: readFirstString(record, ["business_id", "businessId", "bbb_business_id", "bbbBusinessId"]),
      provider_bbb_id: readFirstString(record, ["bbb_id", "bbbId", "bbb.id"]),
      profile_url: profileUrl,
      profile_type: readFirstString(record, ["profile_type", "profileType", "type"]),
      profile_slug: readFirstString(record, ["slug", "profile_slug", "profileSlug"]),
      local_bbb_name: readFirstString(record, ["local_bbb", "localBbb", "local_bbb_name", "localBbbName"]),
      local_bbb_url: readFirstString(record, ["local_bbb_url", "localBbbUrl"]),
      name,
      legal_name: readFirstString(record, ["legal_name", "legalName"]),
      normalized_name: normalizeName(name),
      description: readFirstString(record, ["description", "business_overview", "businessOverview", "overview"]),
      phone: readFirstString(record, ["phone", "phone_number", "phoneNumber", "telephone"]),
      email: readFirstString(record, ["email", "email_address", "emailAddress"]),
      email_url: readFirstString(record, ["email_url", "emailUrl", "email_this_business", "emailThisBusiness"]),
      website_url: readFirstString(record, ["website", "website_url", "websiteUrl"]),
      is_accredited: readFirstBoolean(record, ["is_accredited", "isAccredited", "accredited", "bbb_accredited", "bbbAccredited"]),
      accreditation_status: readFirstString(record, ["accreditation_status", "accreditationStatus", "accredited_status", "accreditedStatus"]),
      accredited_since: readFirstDate(record, ["accredited_since", "accreditedSince", "accredited_date", "accreditedDate"]),
      accreditation_revoked_date: readFirstDate(record, ["accreditation_revoked_date", "accreditationRevokedDate"]),
      bbb_rating: rating,
      rating_score: bbbLetterGradeToScore(rating),
      rating_reason_not_rated: readFirstString(record, ["rating_reason_not_rated", "ratingReasonNotRated", "rating.reason_not_rated", "rating.rating_reason_not_rated"]),
      review_average_rating: summary.reviewAverageRating,
      review_count: summary.reviewCount,
      complaint_count: summary.complaintCount,
      closed_complaints_past_three_years: summary.closedComplaintsPastThreeYears,
      closed_complaints_past_twelve_months: summary.closedComplaintsPastTwelveMonths,
      unanswered_complaints: summary.unansweredComplaints,
      bbb_file_opened_date: readFirstDate(record, ["bbb_file_opened_date", "bbbFileOpenedDate", "bbb_file_opened", "bbbFileOpened"]),
      business_started_date: readFirstDate(record, ["business_start_date", "businessStartDate", "business_started", "businessStarted"]),
      business_local_started_date: readFirstDate(record, ["business_local_start_date", "businessLocalStartDate"]),
      business_incorporated_date: readFirstDate(record, ["incorporated_date", "incorporatedDate", "business_incorporated", "businessIncorporated"]),
      new_owner_date: readFirstDate(record, ["new_owner_date", "newOwnerDate"]),
      years_in_business: readFirstInteger(record, ["years_in_business", "yearsInBusiness"]),
      number_of_employees: readFirstInteger(record, ["num_employees", "numEmployees", "number_of_employees", "numberOfEmployees"]),
      entity_type: readFirstString(record, ["entity_type", "entityType", "type_of_entity", "typeOfEntity"]),
      hq_status: readFirstString(record, ["hq_status", "hqStatus", "hq_information.status", "hqInformation.status"]),
      source_retrieved_at: readFirstTimestamp(record, ["retrieved_at", "retrievedAt", "source_retrieved_at", "sourceRetrievedAt"]),
      parser_source: readFirstString(record, ["parser_source", "parserSource"]),
      schema_version: readFirstString(record, ["schema_version", "schemaVersion"]),
      source_http_request: sourceHttpRequest(profileUrl),
      source_payload: record,
    }),
  };
}

function childRows(record: JsonObject, profileKey: string, artifactUri: string | null): readonly PreparedRow[] {
  const specs: readonly ChildTableSpec[] = [
    {
      tableName: "business_reputation_alternate_names",
      sourceKeyPart: "alternate_name",
      aliases: ["alternate_names", "alternateNames", "also_known_as", "alsoKnownAs", "other_names", "otherNames"],
      requiredColumns: ["alternate_name"],
      values: (payload) => {
        const name = readFirstString(payload, ["name", "alternate_name", "alternateName", "value"]);
        return compactObject({
          alternate_name: name,
          normalized_name: normalizeName(name),
          name_type: readFirstString(payload, ["type", "name_type", "nameType"]),
        });
      },
      uniqueIdentity: (values) => lowerIdentity(values.alternate_name),
    },
    {
      tableName: "business_reputation_categories",
      sourceKeyPart: "category",
      aliases: ["categories", "business_categories", "businessCategories", "category"],
      requiredColumns: ["category_name"],
      values: (payload) => compactObject({
        category_name: readFirstString(payload, ["name", "title", "category", "category_name", "categoryName", "value"]),
        category_code: readFirstString(payload, ["code", "category_code", "categoryCode", "slug"]),
        category_url: readFirstString(payload, ["url", "href", "category_url", "categoryUrl"]),
        is_primary: readFirstBoolean(payload, ["is_primary", "isPrimary", "primary"]),
      }),
      uniqueIdentity: (values) => lowerIdentity(values.category_name),
    },
    {
      tableName: "business_reputation_rating_reasons",
      sourceKeyPart: "rating_reason",
      aliases: ["rating_reasons", "ratingReasons", "rating.rating_reasons", "rating.ratingReasons", "rating.reasons"],
      requiredColumns: ["reason_text"],
      values: (payload, ordinal) => compactObject({
        reason_ordinal: ordinal,
        reason_code: readFirstString(payload, ["code", "reason_code", "reasonCode"]),
        reason_text: readFirstString(payload, ["text", "reason", "description", "value"]),
        reason_impact: readFirstString(payload, ["impact", "reason_impact", "reasonImpact"]),
      }),
    },
    {
      tableName: "business_reputation_licenses",
      sourceKeyPart: "license",
      aliases: ["licenses", "business_licenses", "businessLicenses", "license_information", "licenseInformation", "licensing_information", "licensingInformation"],
      requiredColumns: ["license_number", "license_type", "raw_text"],
      values: (payload) => compactObject({
        license_number: readFirstString(payload, ["license_number", "licenseNumber", "number", "id"]),
        license_type: readFirstString(payload, ["license_type", "licenseType", "type"]),
        license_status: readFirstString(payload, ["status", "license_status", "licenseStatus"]),
        agency: readFirstString(payload, ["agency", "issuing_agency", "issuingAgency"]),
        jurisdiction: readFirstString(payload, ["jurisdiction", "state", "state_code", "stateCode"]),
        issue_date: readFirstDate(payload, ["issue_date", "issueDate", "issued_date", "issuedDate"]),
        expiration_date: readFirstDate(payload, ["expiration_date", "expirationDate", "expires", "expiresAt"]),
        raw_text: readFirstString(payload, ["raw_text", "rawText", "text", "description", "value"]),
      }),
    },
    {
      tableName: "business_reputation_service_areas",
      sourceKeyPart: "service_area",
      aliases: ["service_areas", "serviceAreas", "serving_areas", "servingAreas", "service_area", "serviceArea"],
      requiredColumns: ["area_name"],
      values: (payload) => compactObject({
        area_name: readFirstString(payload, ["name", "title", "area", "area_name", "areaName", "value"]),
        area_type: readFirstString(payload, ["type", "area_type", "areaType"]),
        city_name: readFirstString(payload, ["city", "city_name", "cityName", "addressLocality"]),
        county_name: readFirstString(payload, ["county", "county_name", "countyName"]),
        state_code: readFirstString(payload, ["state", "state_code", "stateCode", "addressRegion"]),
        postal_code: normalizePostalCode(readFirstString(payload, ["zip", "postal_code", "postalCode"])),
        country_code: readFirstString(payload, ["country", "country_code", "countryCode", "addressCountry"]),
      }),
      uniqueIdentity: (values) => lowerIdentity(values.area_name),
    },
    {
      tableName: "business_reputation_reviews",
      sourceKeyPart: "review",
      aliases: ["reviews", "customer_reviews", "customerReviews"],
      requiredColumns: ["provider_review_id", "review_text", "review_rating"],
      values: (payload) => compactObject({
        provider_review_id: readFirstString(payload, ["id", "review_id", "reviewId", "provider_review_id", "providerReviewId"]),
        review_date: readFirstDate(payload, ["date", "review_date", "reviewDate", "created_at", "createdAt"]),
        review_rating: readFirstNumber(payload, ["rating", "review_rating", "reviewRating", "stars"]),
        review_title: readFirstString(payload, ["title", "review_title", "reviewTitle"]),
        review_text: readFirstString(payload, ["text", "review_text", "reviewText", "comment", "body"]),
        reviewer_display_name: readFirstString(payload, ["reviewer", "reviewer_name", "reviewerName", "reviewer_display_name", "reviewerDisplayName"]),
        review_status: readFirstString(payload, ["status", "review_status", "reviewStatus"]),
        business_response_date: readFirstDate(payload, ["business_response_date", "businessResponseDate", "response.date"]),
        business_response_text: readFirstString(payload, ["business_response", "businessResponse", "business_response_text", "businessResponseText", "response.text"]),
      }),
    },
    {
      tableName: "business_reputation_media",
      sourceKeyPart: "media",
      aliases: ["media", "images", "image", "photos", "videos"],
      requiredColumns: ["url"],
      values: (payload) => compactObject({
        media_kind: readFirstString(payload, ["type", "media_kind", "mediaKind", "kind"]) ?? "MEDIA",
        url: readFirstString(payload, ["url", "content_url", "contentUrl", "image", "src", "value"]),
        title: readFirstString(payload, ["title", "name"]),
        description: readFirstString(payload, ["description", "caption", "alt"]),
        content_type: readFirstString(payload, ["content_type", "contentType", "mime_type", "mimeType"]),
        storage_uri: readFirstString(payload, ["storage_uri", "storageUri"]),
      }),
      uniqueIdentity: (values) => readString(values.url),
    },
    {
      tableName: "business_reputation_external_links",
      sourceKeyPart: "external_link",
      aliases: ["social_media_links", "socialMediaLinks", "social_links", "socialLinks", "links"],
      requiredColumns: ["url"],
      values: (payload) => compactObject({
        link_kind: readFirstString(payload, ["kind", "type", "link_kind", "linkKind"]) ?? "LINK",
        url: readFirstString(payload, ["url", "href", "value"]),
        label: readFirstString(payload, ["label", "title", "name"]),
      }),
      uniqueIdentity: (values) => `${readString(values.link_kind) ?? "LINK"}:${readString(values.url) ?? ""}`,
    },
  ];

  const website = readFirstString(record, ["website", "website_url", "websiteUrl"]);
  return [
    ...specs.flatMap((spec) => rowsForSpec(record, profileKey, artifactUri, spec)),
    ...(website === null
      ? []
      : rowsForSpec(
          { websiteLink: { kind: "WEBSITE", url: website, label: "Website" } },
          profileKey,
          artifactUri,
          {
            tableName: "business_reputation_external_links",
            sourceKeyPart: "external_link",
            aliases: ["websiteLink"],
            requiredColumns: ["url"],
            values: (payload) => compactObject({
              link_kind: readFirstString(payload, ["kind"]),
              url: readFirstString(payload, ["url"]),
              label: readFirstString(payload, ["label"]),
            }),
            uniqueIdentity: (values) => `${readString(values.link_kind) ?? "LINK"}:${readString(values.url) ?? ""}`,
          },
        )),
  ];
}

function rowsForSpec(
  record: JsonObject,
  profileKey: string,
  artifactUri: string | null,
  spec: ChildTableSpec,
): readonly PreparedRow[] {
  const seen = new Set<string>();
  const rows: PreparedRow[] = [];
  for (const [index, entry] of readEntries(record, spec.aliases).entries()) {
    const payload = payloadObject(entry);
    const values = compactObject({ ...spec.values(payload, index + 1), source_payload: payload });
    if (!hasRequiredValue(values, spec.requiredColumns)) continue;
    const identity = spec.uniqueIdentity?.(values);
    if (identity !== null && identity !== undefined) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    const sourceRecordKey = `${profileKey}:${spec.sourceKeyPart}:${index + 1}:${hashJson(payload)}`;
    rows.push({
      tableName: spec.tableName,
      references: { businessReputationProfileSourceRecordKey: profileKey },
      values: compactObject({
        ...metadata(sourceRecordKey, payload, artifactUri),
        ...values,
      }),
    });
  }
  return rows;
}

function contactRows(record: JsonObject, profileKey: string, artifactUri: string | null): readonly PreparedRow[] {
  const entries = readEntries(record, [
    "contacts",
    "business_management",
    "businessManagement",
    "management",
    "employee",
    "employees",
  ]);
  const rows: PreparedRow[] = [];
  for (const [index, entry] of entries.entries()) {
    const payload = payloadObject(entry);
    const contactName = readContactName(payload);
    if (contactName === null) continue;
    const contactKey = `${profileKey}:contact:${index + 1}:${hashJson(payload)}`;
    const personKey = `${contactKey}:person`;
    rows.push({
      tableName: "people",
      values: compactObject({
        ...metadata(personKey, payload, artifactUri),
        request_identifier: personKey,
        full_name: contactName,
        normalized_name: normalizeName(contactName),
        source_payload: payload,
      }),
    });
    rows.push({
      tableName: "business_reputation_contacts",
      references: {
        businessReputationProfileSourceRecordKey: profileKey,
        personSourceRecordKey: personKey,
      },
      values: compactObject({
        ...metadata(contactKey, payload, artifactUri),
        contact_name: contactName,
        normalized_name: normalizeName(contactName),
        title: readFirstString(payload, ["title", "job_title", "jobTitle"]),
        role: readFirstString(payload, ["role", "contact_role", "contactRole"]),
        phone: readFirstString(payload, ["phone", "telephone", "phone_number", "phoneNumber"]),
        email: readFirstString(payload, ["email", "email_address", "emailAddress"]),
        source_payload: payload,
      }),
    });
  }
  return rows;
}

function locationRows(record: JsonObject, profileKey: string, artifactUri: string | null): readonly PreparedRow[] {
  const hq = readFirstValue(record, ["hq_information", "hqInformation"]);
  const entries = [
    ...readEntries(record, ["locations", "business_locations", "businessLocations", "additional_locations", "additionalLocations", "branches"]),
    ...(hq === null ? [] : [hq]),
  ];
  const rows: PreparedRow[] = [];
  for (const [index, entry] of entries.entries()) {
    const payload = payloadObject(entry);
    const locationKey = `${profileKey}:location:${index + 1}:${hashJson(payload)}`;
    const address = readBbbAddress(payload, `${locationKey}:address`);
    if (address !== null) rows.push(addressRow(address, artifactUri));
    rows.push({
      tableName: "business_reputation_locations",
      references: address === null
        ? { businessReputationProfileSourceRecordKey: profileKey }
        : {
            addressSourceRecordKey: address.sourceRecordKey,
            businessReputationProfileSourceRecordKey: profileKey,
          },
      values: compactObject({
        ...metadata(locationKey, payload, artifactUri),
        relationship_type: readFirstString(payload, ["relationship_type", "relationshipType", "type"]) ?? (index >= entries.length - 1 && hq !== null ? "HQ" : "LOCATION"),
        location_name: readFirstString(payload, ["name", "location_name", "locationName", "business_name", "businessName"]),
        provider_profile_id: readFirstString(payload, ["profile_id", "profileId", "id"]),
        provider_business_id: readFirstString(payload, ["business_id", "businessId"]),
        provider_bbb_id: readFirstString(payload, ["bbb_id", "bbbId"]),
        profile_url: readFirstString(payload, ["url", "profile_url", "profileUrl", "business_url", "businessUrl"]),
        phone: readFirstString(payload, ["phone", "telephone", "phone_number", "phoneNumber"]),
        source_payload: payload,
      }),
    });
  }
  return rows;
}

function complaintRows(record: JsonObject, profileKey: string, artifactUri: string | null): readonly PreparedRow[] {
  const rows: PreparedRow[] = [];
  for (const [index, entry] of readEntries(record, ["complaints", "customer_complaints", "customerComplaints"]).entries()) {
    const payload = payloadObject(entry);
    const complaintText = readFirstString(payload, ["text", "complaint_text", "complaintText", "body", "summary"]);
    const providerComplaintId = readFirstString(payload, ["id", "complaint_id", "complaintId", "provider_complaint_id", "providerComplaintId"]);
    if (complaintText === null && providerComplaintId === null) continue;
    const complaintKey = `${profileKey}:complaint:${providerComplaintId ?? `${index + 1}:${hashJson(payload)}`}`;
    rows.push({
      tableName: "business_reputation_complaints",
      references: { businessReputationProfileSourceRecordKey: profileKey },
      values: compactObject({
        ...metadata(complaintKey, payload, artifactUri),
        provider_complaint_id: providerComplaintId,
        complaint_date: readFirstDate(payload, ["date", "complaint_date", "complaintDate", "filed_date", "filedDate"]),
        complaint_closed_date: readFirstDate(payload, ["closed_date", "closedDate", "complaint_closed_date", "complaintClosedDate"]),
        complaint_type: readFirstString(payload, ["type", "complaint_type", "complaintType"]),
        complaint_category: readFirstString(payload, ["category", "complaint_category", "complaintCategory"]),
        complaint_status: readFirstString(payload, ["status", "complaint_status", "complaintStatus"]),
        complaint_summary: readFirstString(payload, ["summary", "complaint_summary", "complaintSummary"]),
        complaint_text: complaintText,
        desired_outcome: readFirstString(payload, ["desired_outcome", "desiredOutcome"]),
        resolution_text: readFirstString(payload, ["resolution", "resolution_text", "resolutionText"]),
        customer_display_name: readFirstString(payload, ["customer", "customer_name", "customerName", "customer_display_name", "customerDisplayName"]),
        source_payload: payload,
      }),
    });
    rows.push(...complaintEventRows(payload, complaintKey, artifactUri));
  }
  return rows;
}

function complaintEventRows(complaint: JsonObject, complaintKey: string, artifactUri: string | null): readonly PreparedRow[] {
  return readEntries(complaint, ["events", "timeline", "complaint_events", "complaintEvents"]).flatMap((entry, index) => {
    const payload = payloadObject(entry);
    const eventType = readFirstString(payload, ["type", "event_type", "eventType", "status"]);
    const eventText = readFirstString(payload, ["text", "event_text", "eventText", "comment", "body"]);
    if (eventType === null && eventText === null) return [];
    const sourceRecordKey = `${complaintKey}:event:${index + 1}:${hashJson(payload)}`;
    return [
      {
        tableName: "business_reputation_complaint_events" as const,
        references: { businessReputationComplaintSourceRecordKey: complaintKey },
        values: compactObject({
          ...metadata(sourceRecordKey, payload, artifactUri),
          event_date: readFirstDate(payload, ["date", "event_date", "eventDate", "created_at", "createdAt"]),
          event_type: eventType ?? "COMMENT",
          actor_name: readFirstString(payload, ["actor", "actor_name", "actorName"]),
          actor_role: readFirstString(payload, ["actor_role", "actorRole", "role"]),
          event_text: eventText,
          source_payload: payload,
        }),
      },
    ];
  });
}

function qualityScoreRows(record: JsonObject, identity: BbbIdentity, artifactUri: string | null): readonly PreparedRow[] {
  const rating = readBbbRating(record);
  const summary = readReviewComplaintSummary(record);
  const isAccredited = readFirstBoolean(record, ["is_accredited", "isAccredited", "accredited", "bbb_accredited", "bbbAccredited"]);
  const ratingScore = bbbLetterGradeToScore(rating);
  if (ratingScore === null && isAccredited === null && summary.complaintCount === null && summary.reviewAverageRating === null) {
    return [];
  }
  const complaintsThreeYears = summary.closedComplaintsPastThreeYears ?? summary.complaintCount ?? 0;
  const complaintsTwelveMonths = summary.closedComplaintsPastTwelveMonths ?? 0;
  let score = ratingScore ?? 50;
  if (isAccredited === true) score += 5;
  if (isAccredited === false) score -= 2;
  score -= Math.min(25, complaintsThreeYears * 2);
  score -= Math.min(10, complaintsTwelveMonths * 2);
  if (summary.reviewAverageRating !== null && summary.reviewCount !== null && summary.reviewCount >= 3) {
    score += (summary.reviewAverageRating - 3) * 4;
  }
  const boundedScore = Math.max(0, Math.min(100, Number(score.toFixed(2))));
  const factorPayload = compactObject({
    accreditationStatus: readFirstString(record, ["accreditation_status", "accreditationStatus"]),
    bbbRating: rating,
    closedComplaintsPastThreeYears: summary.closedComplaintsPastThreeYears,
    closedComplaintsPastTwelveMonths: summary.closedComplaintsPastTwelveMonths,
    complaintCount: summary.complaintCount,
    isAccredited,
    ratingScore,
    reviewAverageRating: summary.reviewAverageRating,
    reviewCount: summary.reviewCount,
    scoringModel: BBB_SCORE_MODEL,
  });
  const sourceRecordKey = `${identity.profileKey}:contractor_quality_score:${BBB_SCORE_MODEL}`;
  return [
    {
      tableName: "contractor_quality_scores",
      references: {
        businessReputationProfileSourceRecordKey: identity.profileKey,
        companySourceRecordKey: identity.companyKey,
      },
      values: compactObject({
        ...metadata(sourceRecordKey, factorPayload, artifactUri),
        request_identifier: sourceRecordKey,
        scoring_model: BBB_SCORE_MODEL,
        score: boundedScore,
        score_band: scoreBand(boundedScore),
        match_confidence: "source_profile",
        match_method: "bbb_profile_identity",
        factor_payload: factorPayload,
        source_payload: factorPayload,
      }),
    },
  ];
}

function addressRow(address: BbbAddress, artifactUri: string | null): PreparedRow {
  const normalizedAddressKey = buildNormalizedAddressKey(address.fullAddress);
  return {
    tableName: "addresses",
    values: compactObject({
      ...metadata(address.sourceRecordKey, address.sourcePayload, artifactUri),
      request_identifier: address.sourceRecordKey,
      unnormalized_address: address.fullAddress,
      normalized_address_key: normalizedAddressKey,
      normalized_address_hash: hashNormalizedAddressKey(normalizedAddressKey),
      city_name: address.cityName,
      state_code: address.stateCode,
      postal_code: address.postalCode ?? extractPostalCodeFromAddress(address.fullAddress),
      country_code: address.countryCode ?? "US",
      latitude: address.latitude,
      longitude: address.longitude,
      source_payload: address.sourcePayload,
    }),
  };
}

function readBbbAddress(record: JsonObject, sourceRecordKey: string): BbbAddress | null {
  const rawAddress = readFirstValue(record, ["address", "business_address", "businessAddress", "primary_address", "primaryAddress"]);
  const payload = payloadObject(rawAddress ?? record);
  const street = readFirstString(payload, ["streetAddress", "street_address", "address_line_1", "addressLine1", "line1", "line_1", "address1"]);
  const line2 = readFirstString(payload, ["address_line_2", "addressLine2", "line2", "line_2", "address2"]);
  const cityName = readFirstString(payload, ["addressLocality", "city", "city_name", "cityName"]);
  const stateCode = readFirstString(payload, ["addressRegion", "state", "state_code", "stateCode"]);
  const postalCode = normalizePostalCode(readFirstString(payload, ["postalCode", "postal_code", "zip", "zip_code", "zipCode"]));
  const countryCode = readFirstString(payload, ["addressCountry", "country", "country_code", "countryCode"]);
  const fullAddress = readFirstString(payload, ["fullAddress", "full_address", "single_line", "singleLine", "address", "value"])
    ?? joinText([street, line2, cityName, stateCode, postalCode]);
  if (fullAddress === null) return null;
  const geo = payloadObject(readFirstValue(payload, ["geo", "coordinates"]));
  return {
    sourceRecordKey,
    fullAddress,
    cityName,
    stateCode,
    postalCode,
    countryCode,
    latitude: readFirstNumber(payload, ["latitude", "lat"]) ?? readFirstNumber(geo, ["latitude", "lat"]),
    longitude: readFirstNumber(payload, ["longitude", "lng", "lon"]) ?? readFirstNumber(geo, ["longitude", "lng", "lon"]),
    sourcePayload: payload,
  };
}

function readBusinessName(record: JsonObject): string | null {
  return readFirstString(record, ["name", "business_name", "businessName", "legal_name", "legalName", "title"]);
}

function readProfileUrl(record: JsonObject): string | null {
  return readFirstString(record, ["profile_url", "profileUrl", "business_url", "businessUrl", "businessProfileUrl", "business_profile_url", "url"]);
}

function readBbbRating(record: JsonObject): string | null {
  return readFirstString(record, ["bbb_rating", "bbbRating", "rating", "rating.bbb_rating", "rating.bbbRating", "rating.letter_grade", "rating.letterGrade"]);
}

function readReviewComplaintSummary(record: JsonObject): {
  readonly closedComplaintsPastThreeYears: number | null;
  readonly closedComplaintsPastTwelveMonths: number | null;
  readonly complaintCount: number | null;
  readonly reviewAverageRating: number | null;
  readonly reviewCount: number | null;
  readonly unansweredComplaints: number | null;
} {
  const summary = payloadObject(readFirstValue(record, ["reviews_complaints_summary", "reviewsComplaintsSummary", "review_complaint_summary", "reviewComplaintSummary"]));
  const source = Object.keys(summary).length === 0 ? record : summary;
  return {
    closedComplaintsPastThreeYears: readFirstInteger(source, ["total_closed_complaints_past_three_years", "totalClosedComplaintsPastThreeYears", "closed_complaints_past_three_years", "closedComplaintsPastThreeYears"]),
    closedComplaintsPastTwelveMonths: readFirstInteger(source, ["total_closed_complaints_past_twelve_months", "totalClosedComplaintsPastTwelveMonths", "closed_complaints_past_twelve_months", "closedComplaintsPastTwelveMonths"]),
    complaintCount: readFirstInteger(source, ["complaints_total", "complaintsTotal", "complaint_count", "complaintCount"]),
    reviewAverageRating: readFirstNumber(source, ["average_of_review_star_ratings", "averageOfReviewStarRatings", "average_review_rating", "averageReviewRating", "review_average_rating", "reviewAverageRating"]),
    reviewCount: readFirstInteger(source, ["reviews_total", "reviewsTotal", "review_count", "reviewCount", "number_of_reviews", "numberOfReviews"]),
    unansweredComplaints: readFirstInteger(source, ["unanswered_complaints", "unansweredComplaints"]),
  };
}

function readContactName(payload: JsonObject): string | null {
  const fullName = readFirstString(payload, ["name", "fullName", "full_name", "contact_name", "contactName"]);
  if (fullName !== null) return fullName;
  return joinText([
    readFirstString(payload, ["honorificPrefix", "prefix", "prefix_name", "prefixName"]),
    readFirstString(payload, ["givenName", "first_name", "firstName"]),
    readFirstString(payload, ["additionalName", "middle_name", "middleName"]),
    readFirstString(payload, ["familyName", "last_name", "lastName"]),
    readFirstString(payload, ["honorificSuffix", "suffix", "suffix_name", "suffixName"]),
  ]);
}

function readEntries(record: JsonObject, aliases: readonly string[]): readonly unknown[] {
  for (const alias of aliases) {
    const value = readPath(record, alias);
    if (isJsonObject(value) && Array.isArray(value.links)) return value.links;
    const entries = toEntries(value);
    if (entries.length > 0) return entries;
  }
  return [];
}

function toEntries(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  const text = readString(value);
  if (text !== null) return [text];
  if (isJsonObject(value) && Object.keys(value).length > 0) return [value];
  return [];
}

function readFirstValue(record: JsonObject, aliases: readonly string[]): unknown | null {
  for (const alias of aliases) {
    const value = readPath(record, alias);
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function readFirstArray(record: JsonObject, aliases: readonly string[]): readonly unknown[] | null {
  for (const alias of aliases) {
    const value = readPath(record, alias);
    if (Array.isArray(value)) return value;
  }
  return null;
}

function readFirstString(record: JsonObject, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const value = readString(readPath(record, alias));
    if (value !== null) return value;
  }
  return null;
}

function readFirstNumber(record: JsonObject, aliases: readonly string[]): number | null {
  for (const alias of aliases) {
    const value = readNumber(readPath(record, alias));
    if (value !== null) return value;
  }
  return null;
}

function readFirstInteger(record: JsonObject, aliases: readonly string[]): number | null {
  for (const alias of aliases) {
    const value = readInteger(readPath(record, alias));
    if (value !== null) return value;
  }
  return null;
}

function readFirstBoolean(record: JsonObject, aliases: readonly string[]): boolean | null {
  for (const alias of aliases) {
    const value = readBoolean(readPath(record, alias));
    if (value !== null) return value;
  }
  return null;
}

function readFirstDate(record: JsonObject, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const value = readDate(readPath(record, alias));
    if (value !== null) return value;
  }
  return null;
}

function readFirstTimestamp(record: JsonObject, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const value = readTimestamp(readPath(record, alias));
    if (value !== null) return value;
  }
  return null;
}

function readPath(record: JsonObject, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function hasRequiredValue(values: JsonObject, columns: readonly string[]): boolean {
  return columns.some((column) => values[column] !== undefined && values[column] !== null);
}

function payloadObject(value: unknown): JsonObject {
  if (isJsonObject(value)) return value;
  const text = readString(value);
  if (text !== null) return { value: text };
  return { value };
}

function metadata(
  sourceRecordKey: string,
  sourcePayload: JsonObject,
  artifactUri: string | null,
): ReturnType<typeof buildSourceMetadata> {
  return buildSourceMetadata({
    sourceSystem: BBB_SOURCE_SYSTEM,
    sourceRecordKey,
    sourcePayload,
    sourceArtifactUri: artifactUri,
  });
}

function bbbLetterGradeToScore(value: string | null): number | null {
  if (value === null) return null;
  switch (value.toUpperCase().replace(/\s+/g, "")) {
    case "A+":
      return 95;
    case "A":
      return 90;
    case "A-":
      return 85;
    case "B+":
      return 80;
    case "B":
      return 75;
    case "B-":
      return 70;
    case "C+":
      return 65;
    case "C":
      return 60;
    case "C-":
      return 55;
    case "D+":
      return 50;
    case "D":
      return 45;
    case "D-":
      return 40;
    case "F":
      return 25;
    case "NR":
    case "NORATING":
      return null;
    default:
      return null;
  }
}

function scoreBand(score: number): string {
  if (score >= 85) return "excellent";
  if (score >= 70) return "good";
  if (score >= 55) return "fair";
  return "poor";
}

function sourceHttpRequest(url: string | null): JsonObject | null {
  return url === null ? null : { method: "GET", url };
}

function joinText(parts: readonly (string | null)[]): string | null {
  const text = parts.filter((part): part is string => part !== null).join(" ").replace(/\s+/g, " ").trim();
  return text.length === 0 ? null : text;
}

function hashJson(value: JsonObject): string {
  return hashString(stableJsonStringify(value));
}

function lowerIdentity(value: unknown): string | null {
  const text = readString(value);
  return text === null ? null : text.toLowerCase();
}

function dedupeRows(rows: readonly PreparedRow[]): readonly PreparedRow[] {
  const seen = new Set<string>();
  const deduped: PreparedRow[] = [];
  for (const row of rows) {
    const key = `${row.tableName}:${readString(row.values.source_system) ?? ""}:${readString(row.values.source_record_key) ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}
