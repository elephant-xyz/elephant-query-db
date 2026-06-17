import { buildNormalizedAddressKey, normalizeParcelIdentifier, readString } from "./normalizers.js";

const STREET_SUFFIX_TOKENS = new Set<string>([
  "aly",
  "ave",
  "av",
  "blvd",
  "bnd",
  "cir",
  "ct",
  "cv",
  "dr",
  "expy",
  "hwy",
  "ln",
  "loop",
  "pkwy",
  "pl",
  "plz",
  "rd",
  "row",
  "sq",
  "st",
  "ter",
  "trl",
  "way",
]);

const BAD_ADDRESS_BASES = new Set<string>([
  "commercial",
  "miscellaneous",
  "pool",
  "residential",
]);

const INDUSTRIAL_PERMIT_KEYWORD_PATTERNS: readonly [keyword: string, pattern: RegExp][] = [
  ["industrial", /\bindustrial\b/i],
  ["warehouse", /\bware\s*house\b|\bwarehouse\b/i],
  ["distribution", /\bdistribution\b|\blogistics\b/i],
  ["manufacturing", /\bmanufactur(?:e|ing|er)\b/i],
  ["factory", /\bfactory\b/i],
  ["plant", /\b(?:processing|production|industrial)\s+plant\b/i],
  ["fabrication", /\bfabricat(?:e|ion|or)\b/i],
  ["cold storage", /\bcold\s+storage\b/i],
  ["self storage", /\bself[-\s]?storage\b|\bmini[-\s]?warehouse\b/i],
  ["truck terminal", /\btruck(?:ing)?\s+terminal\b|\bfreight\s+terminal\b/i],
  ["flex industrial", /\bflex\s+industrial\b/i],
] as const;

const LEE_AREA_CITY_NAMES = [
  "ALVA",
  "BOCA GRANDE",
  "BOKEELIA",
  "BONITA SPRINGS",
  "CAPE CORAL",
  "ESTERO",
  "FORT MYERS",
  "FORT MYERS BEACH",
  "FT MYERS",
  "FT MYERS BEACH",
  "LEHIGH ACRES",
  "MATLACHA",
  "N FORT MYERS",
  "NORTH FORT MYERS",
  "PINE ISLAND",
  "SANIBEL",
  "ST JAMES CITY",
] as const;

const LEE_AREA_POSTAL_CODES = [
  "33901",
  "33903",
  "33904",
  "33905",
  "33907",
  "33908",
  "33909",
  "33912",
  "33913",
  "33914",
  "33916",
  "33917",
  "33919",
  "33920",
  "33921",
  "33922",
  "33924",
  "33928",
  "33931",
  "33932",
  "33936",
  "33956",
  "33957",
  "33965",
  "33966",
  "33967",
  "33971",
  "33972",
  "33973",
  "33974",
  "33976",
  "33990",
  "33991",
  "33993",
] as const;

export type PermitEvidenceRow = {
  readonly parcelIdentifier: string | null;
  readonly permitNumber: string | null;
  readonly recordType: string | null;
  readonly sourceRecordType: string | null;
  readonly recordStatus: string | null;
  readonly sourceStatus: string | null;
  readonly improvementStatus: string | null;
  readonly workLocation: string | null;
  readonly sourceSearchAddress: string | null;
  readonly normalizedAddressKey: string | null;
  readonly unnormalizedAddress: string | null;
  readonly commRes: string | null;
  readonly projectDescription: string | null;
  readonly description: string | null;
  readonly sourceUrl: string | null;
  readonly permitLinkCount: number;
  readonly storableDocumentLinkCount: number;
  readonly inspectionCount: number;
  readonly contactCount: number;
};

export type SunbizAddressEvidenceRow = {
  readonly normalizedAddressKey: string | null;
  readonly unnormalizedAddress: string | null;
  readonly cityName: string | null;
  readonly postalCode: string | null;
};

export type CuratedCandidatePermitSummary = {
  readonly permitNumber: string;
  readonly recordStatus: string | null;
  readonly recordType: string | null;
  readonly sourceUrl: string | null;
};

export type CuratedCommercialCandidate = {
  readonly rank: number;
  readonly parcelIdentifier: string;
  readonly rawParcelIdentifiers: readonly string[];
  readonly score: number;
  readonly addressBase: string;
  readonly bestPermitAddress: string;
  readonly permitCount: number;
  readonly commercialPermitCount: number;
  readonly nonVoidPermitCount: number;
  readonly inspectionCount: number;
  readonly contactCount: number;
  readonly permitLinkCount: number;
  readonly storableDocumentLinkCount: number;
  readonly sunbizAddressCount: number;
  readonly sunbizCities: readonly string[];
  readonly sunbizPostalCodes: readonly string[];
  readonly samplePermits: readonly CuratedCandidatePermitSummary[];
};

export type CuratedCandidateBuildResult = {
  readonly selected: readonly CuratedCommercialCandidate[];
  readonly candidateCount: number;
  readonly parcelGroupCount: number;
  readonly permitRowsWithUsableParcel: number;
  readonly permitRowsWithUsableAddress: number;
  readonly sunbizAddressRowsWithUsableBase: number;
};

export type IndustrialPermitClassification = {
  readonly isIndustrial: boolean;
  readonly matchedKeywords: readonly string[];
};

type MutableSunbizAddressBase = {
  addressCount: number;
  readonly cityNames: Set<string>;
  readonly postalCodes: Set<string>;
};

type MutableParcelGroup = {
  readonly parcelIdentifier: string;
  readonly rawParcelIdentifiers: Set<string>;
  readonly addressBases: Map<string, MutableParcelAddressGroup>;
  permitCount: number;
  commercialPermitCount: number;
  nonVoidPermitCount: number;
  inspectionCount: number;
  contactCount: number;
  permitLinkCount: number;
  storableDocumentLinkCount: number;
  readonly samplePermits: CuratedCandidatePermitSummary[];
};

type MutableParcelAddressGroup = {
  readonly addressBase: string;
  readonly bestPermitAddress: string;
  permitCount: number;
};

/**
 * Lee-area city names used to keep Sunbiz address evidence scoped to the same market.
 *
 * @returns Immutable city-name list suitable for SQL `ANY($1::text[])` predicates.
 */
export function leeAreaCityNames(): readonly string[] {
  return LEE_AREA_CITY_NAMES;
}

/**
 * Lee-area ZIP5 values used as a second Sunbiz scope guard.
 *
 * @returns Immutable postal-code list suitable for SQL `ANY($1::text[])` predicates.
 */
export function leeAreaPostalCodes(): readonly string[] {
  return LEE_AREA_POSTAL_CODES;
}

/**
 * Reduce a full address or normalized address key to the street-level base used
 * for parcel-to-Sunbiz association.
 *
 * The returned value intentionally drops unit/suite, city, state, ZIP, and country
 * tokens. That lets `12800 UNIVERSITY DR STE 600 FORT MYERS FL 33907` match a
 * permit at `12800 UNIVERSITY DR, 1-UNIVERSITY DR` while still requiring an exact
 * street number and street name.
 *
 * @param value - Raw address text or a pre-normalized address key.
 * @returns Street-number/street-name base, or `null` when the input is not a usable property address.
 */
export function buildStreetAddressBase(value: unknown): string | null {
  const normalized = buildNormalizedAddressKey(value);
  if (normalized === null) return null;
  return buildStreetAddressBaseFromNormalizedKey(normalized);
}

/**
 * Reduce an already normalized address key to the street-level base.
 *
 * @param normalizedAddressKey - Lowercase address key from the loader normalizer.
 * @returns Street-level address base, or `null` when the key is unusable.
 */
export function buildStreetAddressBaseFromNormalizedKey(
  normalizedAddressKey: string,
): string | null {
  const tokens = normalizedAddressKey
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length < 3) return null;

  if (BAD_ADDRESS_BASES.has(tokens.join(" "))) return null;
  const first = tokens[0];
  if (first === undefined || /^\d+[a-z]?$/.test(first) === false) return null;

  const suffixIndex = tokens.findIndex((token, index) => index > 0 && STREET_SUFFIX_TOKENS.has(token));
  if (suffixIndex >= 2) return tokens.slice(0, suffixIndex + 1).join(" ");

  const usHighwayIndex = tokens.findIndex(
    (token, index) => token === "us" && index > 0 && tokens[index + 1] !== undefined,
  );
  if (usHighwayIndex >= 1) return tokens.slice(0, usHighwayIndex + 2).join(" ");

  return null;
}

/**
 * Classify whether one permit row carries industrial-property evidence.
 *
 * The classifier intentionally uses concrete industrial use-case keywords rather
 * than a broad commercial gate. It is meant for prioritization, not for final
 * property typing; the appraiser track remains the source of truth once the
 * scoped parcel is loaded.
 *
 * @param row - Permit evidence row from Lee Accela detail data.
 * @returns Industrial classification with the matched keywords used for ranking and audit output.
 */
export function classifyIndustrialPermit(row: PermitEvidenceRow): IndustrialPermitClassification {
  const text = industrialClassificationText(row);
  const matchedKeywords = INDUSTRIAL_PERMIT_KEYWORD_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([keyword]) => keyword);
  return {
    isIndustrial: matchedKeywords.length > 0,
    matchedKeywords,
  };
}

/**
 * Decide whether one permit should be treated as industrial-priority evidence.
 *
 * @param row - Permit evidence row from Lee Accela detail data.
 * @returns `true` when any industrial keyword pattern matches the permit text.
 */
export function isIndustrialPermit(row: PermitEvidenceRow): boolean {
  return classifyIndustrialPermit(row).isIndustrial;
}

/**
 * Build a deterministic ranked set of commercial-property candidates that have
 * both permit evidence and Sunbiz address evidence.
 *
 * @param params - Permit rows, Sunbiz address rows, and maximum selected count.
 * @returns Selected candidates plus diagnostic counts for the manifest.
 */
export function buildCuratedCommercialCandidates(params: {
  readonly permitRows: readonly PermitEvidenceRow[];
  readonly requireCommercialPermit?: boolean;
  readonly sunbizAddressRows: readonly SunbizAddressEvidenceRow[];
  readonly limit: number;
}): CuratedCandidateBuildResult {
  const requireCommercialPermit = params.requireCommercialPermit ?? true;
  const sunbizByBase = buildSunbizAddressBaseMap(params.sunbizAddressRows);
  const parcelGroups = new Map<string, MutableParcelGroup>();
  let permitRowsWithUsableParcel = 0;
  let permitRowsWithUsableAddress = 0;

  for (const row of params.permitRows) {
    const parcelIdentifier = normalizeParcelIdentifier(row.parcelIdentifier);
    if (parcelIdentifier === null) continue;
    if (isUsableLeeParcelIdentifier(parcelIdentifier) === false) continue;
    permitRowsWithUsableParcel += 1;

    const addressText = choosePermitAddressText(row);
    const addressBase = buildStreetAddressBase(addressText);
    if (addressBase === null) continue;
    permitRowsWithUsableAddress += 1;

    const group = getOrCreateParcelGroup(parcelGroups, parcelIdentifier);
    const rawParcel = readString(row.parcelIdentifier);
    if (rawParcel !== null) group.rawParcelIdentifiers.add(rawParcel);
    group.permitCount += 1;
    group.inspectionCount += row.inspectionCount;
    group.contactCount += row.contactCount;
    group.permitLinkCount += row.permitLinkCount;
    group.storableDocumentLinkCount += row.storableDocumentLinkCount;
    if (isCommercialPermit(row)) group.commercialPermitCount += 1;
    if (isNonVoidPermit(row)) group.nonVoidPermitCount += 1;

    const addressGroup = group.addressBases.get(addressBase) ?? {
      addressBase,
      bestPermitAddress: addressText,
      permitCount: 0,
    };
    addressGroup.permitCount += 1;
    group.addressBases.set(addressBase, addressGroup);

    const permitNumber = readString(row.permitNumber);
    if (permitNumber !== null && group.samplePermits.length < 8) {
      group.samplePermits.push({
        permitNumber,
        recordStatus: readString(row.recordStatus),
        recordType: readString(row.recordType) ?? readString(row.sourceRecordType),
        sourceUrl: readString(row.sourceUrl),
      });
    }
  }

  const candidates: CuratedCommercialCandidate[] = [];
  for (const group of parcelGroups.values()) {
    if (requireCommercialPermit && group.commercialPermitCount <= 0) continue;
    if (group.nonVoidPermitCount <= 0) continue;
    const bestAddress = selectBestAddressGroup(group, sunbizByBase);
    if (bestAddress === null) continue;

    const sunbizEvidence = sunbizByBase.get(bestAddress.addressBase);
    if (sunbizEvidence === undefined || sunbizEvidence.addressCount <= 0) continue;

    candidates.push({
      rank: 0,
      parcelIdentifier: group.parcelIdentifier,
      rawParcelIdentifiers: [...group.rawParcelIdentifiers].sort(),
      score: scoreCandidate(group, bestAddress, sunbizEvidence),
      addressBase: bestAddress.addressBase,
      bestPermitAddress: bestAddress.bestPermitAddress,
      permitCount: group.permitCount,
      commercialPermitCount: group.commercialPermitCount,
      nonVoidPermitCount: group.nonVoidPermitCount,
      inspectionCount: group.inspectionCount,
      contactCount: group.contactCount,
      permitLinkCount: group.permitLinkCount,
      storableDocumentLinkCount: group.storableDocumentLinkCount,
      sunbizAddressCount: sunbizEvidence.addressCount,
      sunbizCities: [...sunbizEvidence.cityNames].sort().slice(0, 8),
      sunbizPostalCodes: [...sunbizEvidence.postalCodes].sort().slice(0, 8),
      samplePermits: group.samplePermits,
    });
  }

  const selected = candidates
    .sort(compareCandidates)
    .slice(0, params.limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  return {
    selected,
    candidateCount: candidates.length,
    parcelGroupCount: parcelGroups.size,
    permitRowsWithUsableParcel,
    permitRowsWithUsableAddress,
    sunbizAddressRowsWithUsableBase: [...sunbizByBase.values()].reduce(
      (count, group) => count + group.addressCount,
      0,
    ),
  };
}

function buildSunbizAddressBaseMap(
  rows: readonly SunbizAddressEvidenceRow[],
): ReadonlyMap<string, MutableSunbizAddressBase> {
  const byBase = new Map<string, MutableSunbizAddressBase>();
  for (const row of rows) {
    const addressBase = buildStreetAddressBase(
      row.normalizedAddressKey ?? row.unnormalizedAddress,
    );
    if (addressBase === null) continue;

    const group = byBase.get(addressBase) ?? {
      addressCount: 0,
      cityNames: new Set<string>(),
      postalCodes: new Set<string>(),
    };
    group.addressCount += 1;
    const city = readString(row.cityName);
    const postalCode = readString(row.postalCode);
    if (city !== null) group.cityNames.add(city.toUpperCase());
    if (postalCode !== null) group.postalCodes.add(postalCode);
    byBase.set(addressBase, group);
  }
  return byBase;
}

function choosePermitAddressText(row: PermitEvidenceRow): string {
  return (
    readString(row.sourceSearchAddress) ??
    readString(row.workLocation) ??
    readString(row.normalizedAddressKey) ??
    readString(row.unnormalizedAddress) ??
    ""
  );
}

function getOrCreateParcelGroup(
  parcelGroups: Map<string, MutableParcelGroup>,
  parcelIdentifier: string,
): MutableParcelGroup {
  const existing = parcelGroups.get(parcelIdentifier);
  if (existing !== undefined) return existing;
  const created: MutableParcelGroup = {
    parcelIdentifier,
    rawParcelIdentifiers: new Set<string>(),
    addressBases: new Map<string, MutableParcelAddressGroup>(),
    permitCount: 0,
    commercialPermitCount: 0,
    nonVoidPermitCount: 0,
    inspectionCount: 0,
    contactCount: 0,
    permitLinkCount: 0,
    storableDocumentLinkCount: 0,
    samplePermits: [],
  };
  parcelGroups.set(parcelIdentifier, created);
  return created;
}

function isUsableLeeParcelIdentifier(value: string): boolean {
  return /^\d{13,17}$/.test(value);
}

function isCommercialPermit(row: PermitEvidenceRow): boolean {
  const permitNumber = readString(row.permitNumber)?.toUpperCase() ?? "";
  const fields = [
    row.recordType,
    row.sourceRecordType,
    row.commRes,
    row.projectDescription,
    row.description,
  ]
    .flatMap((value) => {
      const text = readString(value);
      return text === null ? [] : [text.toUpperCase()];
    })
    .join(" ");

  return permitNumber.startsWith("COM") || fields.includes("COMMERCIAL");
}

function industrialClassificationText(row: PermitEvidenceRow): string {
  return [
    row.permitNumber,
    row.recordType,
    row.sourceRecordType,
    row.commRes,
    row.projectDescription,
    row.description,
    row.workLocation,
    row.sourceSearchAddress,
    row.unnormalizedAddress,
  ]
    .flatMap((value) => {
      const text = readString(value);
      return text === null ? [] : [text];
    })
    .join(" ");
}

function isNonVoidPermit(row: PermitEvidenceRow): boolean {
  const fields = [row.recordStatus, row.sourceStatus, row.improvementStatus, row.projectDescription, row.description]
    .flatMap((value) => {
      const text = readString(value);
      return text === null ? [] : [text.toUpperCase()];
    })
    .join(" ");
  return fields.includes("VOID") === false && fields.includes("TEST") === false;
}

function selectBestAddressGroup(
  group: MutableParcelGroup,
  sunbizByBase: ReadonlyMap<string, MutableSunbizAddressBase>,
): MutableParcelAddressGroup | null {
  const addressGroups = [...group.addressBases.values()].filter((addressGroup) =>
    sunbizByBase.has(addressGroup.addressBase),
  );
  if (addressGroups.length === 0) return null;
  return addressGroups.sort((left, right) => {
    const leftSunbiz = sunbizByBase.get(left.addressBase)?.addressCount ?? 0;
    const rightSunbiz = sunbizByBase.get(right.addressBase)?.addressCount ?? 0;
    return rightSunbiz - leftSunbiz || right.permitCount - left.permitCount || left.addressBase.localeCompare(right.addressBase);
  })[0] ?? null;
}

function scoreCandidate(
  group: MutableParcelGroup,
  addressGroup: MutableParcelAddressGroup,
  sunbizEvidence: MutableSunbizAddressBase,
): number {
  return (
    1_000 +
    Math.min(group.commercialPermitCount, 20) * 45 +
    Math.min(group.nonVoidPermitCount, 30) * 20 +
    Math.min(group.inspectionCount, 20) * 6 +
    Math.min(group.contactCount, 20) * 4 +
    Math.min(group.storableDocumentLinkCount, 20) * 8 +
    Math.min(group.permitLinkCount, 30) +
    Math.min(sunbizEvidence.addressCount, 20) * 35 +
    Math.min(addressGroup.permitCount, 20) * 12
  );
}

function compareCandidates(
  left: CuratedCommercialCandidate,
  right: CuratedCommercialCandidate,
): number {
  return (
    right.score - left.score ||
    right.commercialPermitCount - left.commercialPermitCount ||
    right.permitCount - left.permitCount ||
    right.sunbizAddressCount - left.sunbizAddressCount ||
    left.parcelIdentifier.localeCompare(right.parcelIdentifier)
  );
}
