import { readString } from "./normalizers.js";

export type LeeAppraisalSearchSeed = {
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly leeStrap: string;
  readonly requestIdentifier: string;
  readonly bestPermitAddress: string;
};

export type LeeAppraisalSearchResult = {
  readonly searchedFor: string | null;
  readonly strap: string;
  readonly normalizedParcelIdentifier: string;
  readonly folioId: string;
  readonly ownerName: string | null;
  readonly siteAddress: string | null;
  readonly legalDescription: string | null;
  readonly detailPath: string;
  readonly detailUrl: string;
};

export type LeeAppraisalDetailSeed = {
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly bestPermitAddress: string;
  readonly requestIdentifier: string;
  readonly leeStrap: string;
  readonly normalizedParcelIdentifier: string;
  readonly folioId: string;
  readonly ownerName: string | null;
  readonly siteAddress: string | null;
  readonly legalDescription: string | null;
  readonly detailUrl: string;
};

const LEE_PROPERTY_SEARCH_URL = "https://www.leepa.org/Search/PropertySearch.aspx";
const LEE_DISPLAY_BASE_URL = "https://www.leepa.org";
const LEE_DISPLAY_PARCEL_URL = "https://leepa.org/Display/DisplayParcel.aspx";
const LEE_DETAIL_TRUE_FLAGS = [
  "PropertyDetailsCurrent",
  "PropertyDetails",
  "AuthDetails",
  "SalesDetails",
  "PermitDetails",
  "RenumberDetails",
  "GarbageDetails",
  "ElevationDetails",
] as const;

/**
 * Convert an Accela parcel identifier into the formatted Lee County STRAP form
 * accepted by the Lee County Property Appraiser search form.
 *
 * Accela commonly drops insignificant trailing zeroes from the final lot
 * segment. Lee STRAP search accepts the 17-digit expanded form represented as
 * `SS-TT-RR-AA-BBBBB.LLLL`, so shorter digit-only inputs are right-padded to
 * 17 digits before formatting.
 *
 * @param value - Raw permit parcel identifier from Accela or a formatted STRAP.
 * @returns Formatted Lee STRAP, or `null` when the input does not contain enough digits.
 */
export function formatLeeStrapForSearch(value: unknown): string | null {
  const text = readString(value);
  if (text === null) return null;
  const digits = text.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 17) return null;
  const expanded = digits.padEnd(17, "0");
  return [
    expanded.slice(0, 2),
    expanded.slice(2, 4),
    expanded.slice(4, 6),
    expanded.slice(6, 8),
    expanded.slice(8, 13),
  ].join("-").concat(".", expanded.slice(13, 17));
}

/**
 * Convert an Accela parcel identifier into a Lee STRAP by left-padding the final segment.
 *
 * This is a retry-only fallback for Accela parcel identifiers shorter than the
 * 17-digit Lee STRAP shape. Some Accela rows appear to drop leading zeroes from
 * the final `LLLL` segment rather than trailing zeroes; the primary formatter
 * intentionally keeps the older right-padding behavior for compatibility, while
 * this formatter lets the appraisal search retry the alternate interpretation.
 *
 * @param value - Raw permit parcel identifier from Accela or a formatted STRAP.
 * @returns Alternate formatted Lee STRAP, or `null` when no alternate exists.
 */
export function formatLeeStrapForFinalSegmentLeftPadSearch(value: unknown): string | null {
  const text = readString(value);
  if (text === null) return null;
  const digits = text.replace(/\D/g, "");
  if (digits.length < 14 || digits.length > 16) return null;
  const finalSegment = digits.slice(13).padStart(4, "0");
  const expanded = `${digits.slice(0, 13)}${finalSegment}`;
  const formatted = [
    expanded.slice(0, 2),
    expanded.slice(2, 4),
    expanded.slice(4, 6),
    expanded.slice(6, 8),
    expanded.slice(8, 13),
  ].join("-").concat(".", expanded.slice(13, 17));
  const primary = formatLeeStrapForSearch(value);
  return formatted === primary ? null : formatted;
}

/**
 * Build a search seed using a caller-supplied Lee STRAP value.
 *
 * @param params - Candidate fields plus the exact STRAP to send to the Lee appraiser search.
 * @returns Search seed preserving the original parcel/address evidence.
 */
export function buildLeeAppraisalSearchSeedWithStrap(params: {
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly bestPermitAddress: string;
  readonly leeStrap: string;
}): LeeAppraisalSearchSeed {
  return {
    rank: params.rank,
    parcelIdentifier: params.parcelIdentifier,
    leeStrap: params.leeStrap,
    requestIdentifier: params.leeStrap,
    bestPermitAddress: params.bestPermitAddress,
  };
}

/**
 * Build the seed payloads consumed by the oracle-node downloader Lambda for the
 * first appraisal phase: Lee STRAP search result capture.
 *
 * @param candidate - Curated parcel candidate with rank/address evidence.
 * @returns Seed documents and request identifier, or `null` for an unformattable parcel.
 */
export function buildLeeAppraisalSearchSeed(candidate: {
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly bestPermitAddress: string;
}): LeeAppraisalSearchSeed | null {
  const leeStrap = formatLeeStrapForSearch(candidate.parcelIdentifier);
  if (leeStrap === null) return null;
  return {
    rank: candidate.rank,
    parcelIdentifier: candidate.parcelIdentifier,
    leeStrap,
    requestIdentifier: leeStrap,
    bestPermitAddress: candidate.bestPermitAddress,
  };
}

/**
 * Build the property seed document for a Lee STRAP search capture.
 *
 * @param seed - Search seed generated from a curated candidate.
 * @returns JSON-serializable property seed object for `property_seed.json`.
 */
export function buildLeeSearchPropertySeed(seed: LeeAppraisalSearchSeed): Record<string, unknown> {
  const sourceHttpRequest = { url: LEE_PROPERTY_SEARCH_URL, method: "GET" };
  return {
    source_http_request: sourceHttpRequest,
    request_identifier: seed.requestIdentifier,
    parcel_id: seed.parcelIdentifier,
  };
}

/**
 * Build the address seed document for a Lee STRAP search capture.
 *
 * The `county_jurisdiction` remains `Lee` for downstream appraisal transforms;
 * `input.csv` carries the synthetic county name used only to select the
 * temporary `LeeCurated` browser flow in oracle-node.
 *
 * @param seed - Search seed generated from a curated candidate.
 * @returns JSON-serializable address seed object for `unnormalized_address.json`.
 */
export function buildLeeSearchAddressSeed(seed: LeeAppraisalSearchSeed): Record<string, unknown> {
  const sourceHttpRequest = { url: LEE_PROPERTY_SEARCH_URL, method: "GET" };
  return {
    source_http_request: sourceHttpRequest,
    request_identifier: seed.requestIdentifier,
    full_address: seed.bestPermitAddress,
    county_jurisdiction: "Lee",
    longitude: null,
    latitude: null,
  };
}

/**
 * Build the one-row input CSV used by oracle-node to choose the `LeeCurated`
 * browser flow from S3 while keeping Lee jurisdiction in the JSON seeds.
 *
 * @param seed - Search seed generated from a curated candidate.
 * @returns CSV text with a header and one data row.
 */
export function buildLeeSearchInputCsv(seed: LeeAppraisalSearchSeed): string {
  return [
    "county,rank,parcel_identifier,lee_strap,address",
    [
      "LeeCurated",
      String(seed.rank),
      seed.parcelIdentifier,
      seed.leeStrap,
      csvField(seed.bestPermitAddress),
    ].join(","),
    "",
  ].join("\n");
}

/**
 * Combine the original curated search seed with the Folio ID discovered from
 * LEEPA search results so the second prepare phase can capture the full
 * DisplayParcel detail page.
 *
 * @param params - Search seed and parsed search-result page values.
 * @returns Detail seed with original curated evidence plus LEEPA Folio fields.
 */
export function buildLeeAppraisalDetailSeed(params: {
  readonly searchSeed: LeeAppraisalSearchSeed;
  readonly searchResult: LeeAppraisalSearchResult;
}): LeeAppraisalDetailSeed {
  return {
    rank: params.searchSeed.rank,
    parcelIdentifier: params.searchSeed.parcelIdentifier,
    bestPermitAddress: params.searchSeed.bestPermitAddress,
    requestIdentifier: params.searchResult.folioId,
    leeStrap: params.searchResult.strap,
    normalizedParcelIdentifier: params.searchResult.normalizedParcelIdentifier,
    folioId: params.searchResult.folioId,
    ownerName: params.searchResult.ownerName,
    siteAddress: params.searchResult.siteAddress,
    legalDescription: params.searchResult.legalDescription,
    detailUrl: params.searchResult.detailUrl,
  };
}

/**
 * Build the `source_http_request` object used by the existing Lee appraisal
 * transform for direct DisplayParcel/Folio detail captures.
 *
 * @param folioId - Lee Property Appraiser Folio ID.
 * @returns JSON-serializable GET request descriptor with the detail sections enabled.
 */
export function buildLeeDetailSourceHttpRequest(folioId: string): Record<string, unknown> {
  return {
    url: LEE_DISPLAY_PARCEL_URL,
    method: "GET",
    multiValueQueryString: {
      FolioID: [folioId],
      ...Object.fromEntries(LEE_DETAIL_TRUE_FLAGS.map((flag) => [flag, ["True"]])),
    },
  };
}

/**
 * Build the property seed document for a Lee DisplayParcel detail capture.
 *
 * @param seed - Detail seed generated from a parsed LEEPA STRAP-search result.
 * @returns JSON-serializable property seed object for `property_seed.json`.
 */
export function buildLeeDetailPropertySeed(seed: LeeAppraisalDetailSeed): Record<string, unknown> {
  return {
    source_http_request: buildLeeDetailSourceHttpRequest(seed.folioId),
    request_identifier: seed.requestIdentifier,
    parcel_id: seed.normalizedParcelIdentifier,
    original_parcel_id: seed.parcelIdentifier,
    strap: seed.leeStrap,
    folio_id: seed.folioId,
  };
}

/**
 * Build the address seed document for a Lee DisplayParcel detail capture.
 *
 * @param seed - Detail seed generated from a parsed LEEPA STRAP-search result.
 * @returns JSON-serializable address seed object for `unnormalized_address.json`.
 */
export function buildLeeDetailAddressSeed(seed: LeeAppraisalDetailSeed): Record<string, unknown> {
  return {
    source_http_request: buildLeeDetailSourceHttpRequest(seed.folioId),
    request_identifier: seed.requestIdentifier,
    full_address: seed.siteAddress ?? seed.bestPermitAddress,
    county_jurisdiction: "Lee",
    longitude: null,
    latitude: null,
  };
}

/**
 * Build the one-row input CSV used by oracle-node for the Folio detail phase.
 *
 * `county` is the real Lee jurisdiction here so the downloader uses the
 * existing `browser-flows/Lee.json` detail-page capture flow.
 *
 * @param seed - Detail seed generated from a parsed LEEPA STRAP-search result.
 * @returns CSV text with a header and one data row.
 */
export function buildLeeDetailInputCsv(seed: LeeAppraisalDetailSeed): string {
  return [
    "county,rank,parcel_identifier,lee_strap,folio_id,address",
    [
      "Lee",
      String(seed.rank),
      seed.normalizedParcelIdentifier,
      seed.leeStrap,
      seed.folioId,
      csvField(seed.siteAddress ?? seed.bestPermitAddress),
    ].join(","),
    "",
  ].join("\n");
}

/**
 * Extract the first Lee Property Appraiser STRAP-search result from a captured
 * result page.
 *
 * @param html - Captured LEEPA search-result HTML.
 * @returns Parsed Folio/STRAP result, or `null` when no parcel-detail link is present.
 */
export function extractLeeAppraisalSearchResult(html: string): LeeAppraisalSearchResult | null {
  const detailMatch = /href="(?<path>\/Display\/DisplayParcel\.aspx\?FolioID=(?<folioId>\d+))"/i.exec(html);
  const path = detailMatch?.groups?.path;
  const folioId = detailMatch?.groups?.folioId;
  if (path === undefined || folioId === undefined) return null;

  const titleMatch = /Display Parcel Details For (?<strap>\d{2}-\d{2}-\d{2}-[A-Z0-9]{2}-[A-Z0-9]{5}\.[A-Z0-9]{4})/i.exec(html);
  const rowMatch = /<div class="item">(?<strap>\d{2}-\d{2}-\d{2}-[A-Z0-9]{2}-[A-Z0-9]{5}\.[A-Z0-9]{4})<\/div>\s*<div class="item">(?<folio>\d+)<\/div>/i.exec(html);
  const strap = titleMatch?.groups?.strap ?? rowMatch?.groups?.strap;
  if (strap === undefined) return null;

  return {
    searchedFor: extractSearchedFor(html),
    strap,
    normalizedParcelIdentifier: strap.replace(/\D/g, ""),
    folioId,
    ownerName: extractFirstClassText(html, "bold"),
    siteAddress: extractSiteAddress(html),
    legalDescription: extractLegalDescription(html),
    detailPath: path,
    detailUrl: `${LEE_DISPLAY_BASE_URL}${path}`,
  };
}

function extractSearchedFor(html: string): string | null {
  const match = /Search by <u>STRAP<\/u> for\s*<em>'(?<value>[^']+)'<\/em>/i.exec(html);
  return match?.groups?.value ?? null;
}

function extractFirstClassText(html: string, className: string): string | null {
  const expression = new RegExp(`<div class="${escapeRegExp(className)}">(?<text>[\\s\\S]*?)<\\/div>`, "i");
  const match = expression.exec(html);
  return normalizeHtmlText(match?.groups?.text);
}

function extractSiteAddress(html: string): string | null {
  const match = /<div class="itemAddAndLegal">\s*<div>(?<line1>[^<]+)<\/div>\s*<div>(?<line2>[^<]+)<\/div>/i.exec(html);
  const line1 = normalizeHtmlText(match?.groups?.line1);
  const line2 = normalizeHtmlText(match?.groups?.line2);
  if (line1 === null && line2 === null) return null;
  return [line1, line2].filter((line): line is string => line !== null).join(", ");
}

function extractLegalDescription(html: string): string | null {
  const blocks = [...html.matchAll(/<div class="itemAddAndLegal">(?<body>[\s\S]*?)<\/div>\s*<\/div>/gi)];
  const legalBlock = blocks[1]?.groups?.body;
  return normalizeHtmlText(legalBlock);
}

function normalizeHtmlText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : null;
}

function csvField(value: string): string {
  if (/[",\n\r]/.test(value) === false) return value;
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
