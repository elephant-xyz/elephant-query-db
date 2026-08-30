export type IllinoisSosLocationConfidenceTier = "high" | "low" | "medium";

export type IllinoisSosLocationEvidence = {
  readonly addressRole: string;
  readonly companyKey: string;
  readonly exactPermitBusinessCorroboration: boolean;
  readonly normalizedAddressHash: string;
  readonly normalizedCompanyName: string | null;
  readonly propertyKey: string;
};

export type IllinoisSosLocationTierAggregate = {
  readonly matchCount: number;
  readonly uniqueCompanyCount: number;
  readonly uniquePropertyCount: number;
};

export type IllinoisSosLocationConfidenceReport = {
  readonly collisions: {
    readonly addressHashesWithMultipleCompanies: number;
    readonly addressHashesWithMultipleProperties: number;
    readonly companiesWithMultipleProperties: number;
    readonly normalizedNamesWithMultipleCompanies: number;
    readonly propertiesWithMultipleCompanies: number;
  };
  readonly evidenceRules: {
    readonly high: string;
    readonly low: string;
    readonly medium: string;
  };
  readonly tiers: Readonly<
    Record<IllinoisSosLocationConfidenceTier, IllinoisSosLocationTierAggregate>
  >;
};

const AUTHORITATIVE_BUSINESS_ADDRESS_ROLES = new Set([
  "business_address",
  "entity_principal",
  "principal_business_address",
  "principal_office",
]);

/**
 * Produce privacy-safe aggregate confidence tiers from private row-level
 * evidence. Company names, addresses, hashes, and identifiers never appear in
 * the returned report.
 *
 * Duplicate company/property evidence is assigned only to its strongest tier.
 * A registered-agent office alone remains low confidence and never asserts an
 * operating location.
 *
 * @param evidence - Private exact-address and permit corroboration evidence.
 * @returns Aggregate-only tier and collision counts.
 */
export function aggregateIllinoisSosLocationConfidence(
  evidence: readonly IllinoisSosLocationEvidence[],
): IllinoisSosLocationConfidenceReport {
  const strongestByMatch = new Map<
    string,
    {
      readonly companyKey: string;
      readonly normalizedAddressHash: string;
      readonly normalizedCompanyName: string | null;
      readonly propertyKey: string;
      readonly tier: IllinoisSosLocationConfidenceTier;
    }
  >();
  for (const item of evidence) {
    const tier = classifyEvidence(item);
    const key = `${item.companyKey}\u0000${item.propertyKey}`;
    const existing = strongestByMatch.get(key);
    if (existing !== undefined && tierRank(existing.tier) >= tierRank(tier)) {
      continue;
    }
    strongestByMatch.set(key, {
      companyKey: item.companyKey,
      normalizedAddressHash: item.normalizedAddressHash,
      normalizedCompanyName: item.normalizedCompanyName,
      propertyKey: item.propertyKey,
      tier,
    });
  }
  const matches = [...strongestByMatch.values()];
  return {
    collisions: {
      addressHashesWithMultipleCompanies: countGroupsWithMultipleValues(
        matches,
        (match) => match.normalizedAddressHash,
        (match) => match.companyKey,
      ),
      addressHashesWithMultipleProperties: countGroupsWithMultipleValues(
        matches,
        (match) => match.normalizedAddressHash,
        (match) => match.propertyKey,
      ),
      companiesWithMultipleProperties: countGroupsWithMultipleValues(
        matches,
        (match) => match.companyKey,
        (match) => match.propertyKey,
      ),
      normalizedNamesWithMultipleCompanies: countGroupsWithMultipleValues(
        matches.filter(
          (
            match,
          ): match is typeof match & { readonly normalizedCompanyName: string } =>
            match.normalizedCompanyName !== null,
        ),
        (match) => match.normalizedCompanyName,
        (match) => match.companyKey,
      ),
      propertiesWithMultipleCompanies: countGroupsWithMultipleValues(
        matches,
        (match) => match.propertyKey,
        (match) => match.companyKey,
      ),
    },
    evidenceRules: {
      high:
        "Exact SOS address match plus exact permit contractor/business name evidence for the same property; evidence of a link, not ownership or headquarters.",
      low:
        "Registered-agent office exact-address match only; not an operating location.",
      medium:
        "Exact authoritative principal/business address match without permit corroboration.",
    },
    tiers: {
      high: aggregateTier(matches, "high"),
      low: aggregateTier(matches, "low"),
      medium: aggregateTier(matches, "medium"),
    },
  };
}

function classifyEvidence(
  evidence: IllinoisSosLocationEvidence,
): IllinoisSosLocationConfidenceTier {
  if (evidence.exactPermitBusinessCorroboration) return "high";
  if (AUTHORITATIVE_BUSINESS_ADDRESS_ROLES.has(evidence.addressRole)) {
    return "medium";
  }
  return "low";
}

function tierRank(tier: IllinoisSosLocationConfidenceTier): number {
  if (tier === "high") return 3;
  if (tier === "medium") return 2;
  return 1;
}

function aggregateTier(
  matches: readonly {
    readonly companyKey: string;
    readonly propertyKey: string;
    readonly tier: IllinoisSosLocationConfidenceTier;
  }[],
  tier: IllinoisSosLocationConfidenceTier,
): IllinoisSosLocationTierAggregate {
  const tierMatches = matches.filter((match) => match.tier === tier);
  return {
    matchCount: tierMatches.length,
    uniqueCompanyCount: new Set(tierMatches.map((match) => match.companyKey))
      .size,
    uniquePropertyCount: new Set(tierMatches.map((match) => match.propertyKey))
      .size,
  };
}

function countGroupsWithMultipleValues<Item>(
  items: readonly Item[],
  readGroup: (item: Item) => string,
  readValue: (item: Item) => string,
): number {
  const valuesByGroup = new Map<string, Set<string>>();
  for (const item of items) {
    const group = readGroup(item);
    const values = valuesByGroup.get(group) ?? new Set<string>();
    values.add(readValue(item));
    valuesByGroup.set(group, values);
  }
  return [...valuesByGroup.values()].filter((values) => values.size > 1).length;
}
