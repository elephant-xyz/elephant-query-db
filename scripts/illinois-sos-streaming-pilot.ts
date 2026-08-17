import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export type IllinoisSosPilotComponent = "agent" | "master" | "name";

type PilotRecord = {
  readonly agentCity: string | null;
  readonly agentCountyCode: string | null;
  readonly agentPostalCode: string | null;
  readonly fileNumber: string;
  readonly incorporationDateCompact: string | null;
  readonly transactionDateCompact: string | null;
};

type PilotRecordGroup = {
  readonly fileNumber: string;
  readonly records: readonly PilotRecord[];
};

type MutableComponentStats = {
  duplicateFileNumberCount: number;
  headerFileLabel: string;
  outOfOrderRecordCount: number;
  parsedRecordCount: number;
  rejectedRecordCount: number;
  rejectionReasons: Record<string, number>;
  runDateCompact: string;
  sourceRecordCount: number;
  trailerRecordCount: number;
  validationWarningCount: number;
};

export type IllinoisSosStreamingComponentSummary = {
  readonly component: IllinoisSosPilotComponent;
  readonly duplicateFileNumberCount: number;
  readonly headerFileLabel: string;
  readonly outOfOrderRecordCount: number;
  readonly parsedRecordCount: number;
  readonly rejectedRecordCount: number;
  readonly rejectionReasons: Readonly<Record<string, number>>;
  readonly runDate: string;
  readonly sourcePath: string;
  readonly sourceRecordCount: number;
  readonly trailerRecordCount: number;
  readonly validationWarningCount: number;
};

export type IllinoisSosStreamingPilotResult = {
  readonly candidateAggregates: {
    readonly agentAddressCandidateCount: number;
    readonly candidateEntityCount: number;
    readonly distinctCityCount: number;
    readonly distinctPostalCodeCount: number;
    readonly role: "registered_agent_office";
    readonly state: "IL";
    readonly topCities: readonly {
      readonly city: string;
      readonly count: number;
    }[];
    readonly topPostalCodes: readonly {
      readonly count: number;
      readonly postalCode: string;
    }[];
  };
  readonly componentDateMismatch: boolean;
  readonly components: readonly IllinoisSosStreamingComponentSummary[];
  readonly event: "illinois_sos_pilot_intersection_finished";
  readonly join: {
    readonly agentNameIntersectionCount: number;
    readonly agentWithoutMasterCount: number;
    readonly agentWithoutNameCount: number;
    readonly exactThreeWayIntersectionCount: number;
    readonly masterAgentIntersectionCount: number;
    readonly masterNameIntersectionCount: number;
    readonly masterPotentiallyChangedAfterNameRunDateCount: number;
    readonly masterWithoutAgentCount: number;
    readonly masterWithoutNameCount: number;
    readonly masterWithoutNamePotentiallyNewOrChangedCount: number;
    readonly nameWithoutAgentCount: number;
    readonly nameWithoutMasterCount: number;
    readonly potentiallyStaleNameIntersectionCount: number;
    readonly unionFileNumberCount: number;
  };
  readonly joinKey: "exact_illinois_file_number";
  readonly mode: "pilot_component_date_mismatch_intersection";
  readonly productionEligible: false;
  readonly publishable: false;
  readonly throughput: {
    readonly elapsedSeconds: number;
    readonly sourceRecordsPerSecond: number;
    readonly totalSourceRecords: number;
  };
  readonly warnings: readonly {
    readonly code:
      | "component_date_mismatch"
      | "pilot_non_publishable"
      | "registered_agent_address_role_limit";
    readonly message: string;
  }[];
};

type PilotPaths = {
  readonly agentPath: string;
  readonly masterPath: string;
  readonly namePath: string;
};

const WIDTH_BY_COMPONENT: Readonly<Record<IllinoisSosPilotComponent, number>> = {
  agent: 164,
  master: 160,
  name: 197,
};

class PilotRecordValidationError extends Error {
  readonly code: string;

  /**
   * Create a structural source-record error safe for aggregate reporting.
   *
   * @param code - Stable non-PII rejection category.
   * @param message - Diagnostic that excludes source record contents.
   */
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Stream three official Illinois SOS components and compute an exact-key
 * intersection without retaining the full files or exposing personal fields.
 *
 * This function is intentionally pilot-only. Component dates remain separate,
 * the output is always non-production and non-publishable, and records are
 * joined exclusively by the eight-digit Illinois file number. Each component
 * must be sorted by file number; order violations stop the analysis rather
 * than triggering a fuzzy or row-position fallback.
 *
 * @param paths - Extracted Master, Company Name, and Agent file paths.
 * @returns Privacy-safe parse, coverage, warning, and candidate aggregates.
 */
export async function analyzeIllinoisSosStreamingIntersectionPilot(
  paths: PilotPaths,
): Promise<IllinoisSosStreamingPilotResult> {
  const startedAt = performance.now();
  const masterStats = createMutableStats();
  const nameStats = createMutableStats();
  const agentStats = createMutableStats();
  const masterIterator = streamComponentGroups(
    "master",
    paths.masterPath,
    masterStats,
  )[Symbol.asyncIterator]();
  const nameIterator = streamComponentGroups(
    "name",
    paths.namePath,
    nameStats,
  )[Symbol.asyncIterator]();
  const agentIterator = streamComponentGroups(
    "agent",
    paths.agentPath,
    agentStats,
  )[Symbol.asyncIterator]();

  let master = await masterIterator.next();
  let name = await nameIterator.next();
  let agent = await agentIterator.next();
  const join = {
    agentNameIntersectionCount: 0,
    agentWithoutMasterCount: 0,
    agentWithoutNameCount: 0,
    exactThreeWayIntersectionCount: 0,
    masterAgentIntersectionCount: 0,
    masterNameIntersectionCount: 0,
    masterPotentiallyChangedAfterNameRunDateCount: 0,
    masterWithoutAgentCount: 0,
    masterWithoutNameCount: 0,
    masterWithoutNamePotentiallyNewOrChangedCount: 0,
    nameWithoutAgentCount: 0,
    nameWithoutMasterCount: 0,
    potentiallyStaleNameIntersectionCount: 0,
    unionFileNumberCount: 0,
  };
  let candidateEntityCount = 0;
  let agentAddressCandidateCount = 0;
  const cityCounts = new Map<string, number>();
  const postalCodeCounts = new Map<string, number>();

  while (!master.done || !name.done || !agent.done) {
    const masterGroup = master.done ? null : master.value;
    const nameGroup = name.done ? null : name.value;
    const agentGroup = agent.done ? null : agent.value;
    const availableKeys = [
      masterGroup?.fileNumber ?? null,
      nameGroup?.fileNumber ?? null,
      agentGroup?.fileNumber ?? null,
    ].filter((value): value is string => value !== null);
    const fileNumber = availableKeys.sort()[0];
    if (fileNumber === undefined) break;

    const hasMaster = masterGroup?.fileNumber === fileNumber;
    const hasName = nameGroup?.fileNumber === fileNumber;
    const hasAgent = agentGroup?.fileNumber === fileNumber;
    join.unionFileNumberCount += 1;
    if (hasMaster && hasName) join.masterNameIntersectionCount += 1;
    if (hasMaster && hasAgent) join.masterAgentIntersectionCount += 1;
    if (hasName && hasAgent) join.agentNameIntersectionCount += 1;
    if (hasMaster && !hasName) join.masterWithoutNameCount += 1;
    if (hasName && !hasMaster) join.nameWithoutMasterCount += 1;
    if (hasMaster && !hasAgent) join.masterWithoutAgentCount += 1;
    if (hasAgent && !hasMaster) join.agentWithoutMasterCount += 1;
    if (hasName && !hasAgent) join.nameWithoutAgentCount += 1;
    if (hasAgent && !hasName) join.agentWithoutNameCount += 1;

    const masterChangedAfterNameRunDate =
      hasMaster &&
      masterGroup.records.some((record) =>
        recordChangedAfter(record, nameStats.runDateCompact),
      );
    if (masterChangedAfterNameRunDate) {
      join.masterPotentiallyChangedAfterNameRunDateCount += 1;
      if (!hasName) {
        join.masterWithoutNamePotentiallyNewOrChangedCount += 1;
      }
    }

    if (hasMaster && hasName && hasAgent) {
      join.exactThreeWayIntersectionCount += 1;
      if (masterChangedAfterNameRunDate) {
        join.potentiallyStaleNameIntersectionCount += 1;
      }
      const rockIslandAgents = agentGroup.records.filter(
        (record) => record.agentCountyCode === "081",
      );
      if (rockIslandAgents.length > 0) candidateEntityCount += 1;
      for (const record of rockIslandAgents) {
        agentAddressCandidateCount += 1;
        incrementAggregate(cityCounts, record.agentCity);
        incrementAggregate(postalCodeCounts, record.agentPostalCode);
      }
    }

    if (hasMaster) master = await masterIterator.next();
    if (hasName) name = await nameIterator.next();
    if (hasAgent) agent = await agentIterator.next();
  }

  const components = [
    buildComponentSummary("master", paths.masterPath, masterStats),
    buildComponentSummary("name", paths.namePath, nameStats),
    buildComponentSummary("agent", paths.agentPath, agentStats),
  ];
  const runDates = new Set(components.map((component) => component.runDate));
  const componentDateMismatch = runDates.size > 1;
  const totalSourceRecords = components.reduce(
    (total, component) => total + component.sourceRecordCount,
    0,
  );
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  const warnings: IllinoisSosStreamingPilotResult["warnings"][number][] = [
    {
      code: "pilot_non_publishable",
      message:
        "Pilot intersection only; component-date tolerance is not valid for production or publication.",
    },
    {
      code: "registered_agent_address_role_limit",
      message:
        "Agent-address candidates do not establish operating location, tenancy, occupancy, or ownership.",
    },
  ];
  if (componentDateMismatch) {
    warnings.unshift({
      code: "component_date_mismatch",
      message: components
        .map((component) => `${component.component}=${component.runDate}`)
        .join(", "),
    });
  }

  return {
    candidateAggregates: {
      agentAddressCandidateCount,
      candidateEntityCount,
      distinctCityCount: cityCounts.size,
      distinctPostalCodeCount: postalCodeCounts.size,
      role: "registered_agent_office",
      state: "IL",
      topCities: topAggregateEntries(cityCounts).map(({ count, value }) => ({
        city: value,
        count,
      })),
      topPostalCodes: topAggregateEntries(postalCodeCounts).map(
        ({ count, value }) => ({
          count,
          postalCode: value,
        }),
      ),
    },
    componentDateMismatch,
    components,
    event: "illinois_sos_pilot_intersection_finished",
    join,
    joinKey: "exact_illinois_file_number",
    mode: "pilot_component_date_mismatch_intersection",
    productionEligible: false,
    publishable: false,
    throughput: {
      elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      sourceRecordsPerSecond: Math.round(totalSourceRecords / elapsedSeconds),
      totalSourceRecords,
    },
    warnings,
  };
}

/**
 * Stream validated records grouped by exact file number.
 *
 * Grouping preserves duplicate diagnostics while allowing a bounded-memory
 * merge. Structural failures are rejected and counted; out-of-order keys stop
 * execution because a streaming merge would otherwise become incorrect.
 *
 * @param component - Component-specific positional schema.
 * @param path - Extracted source file path.
 * @param stats - Mutable aggregate counters owned by the caller.
 * @returns Async groups ordered by Illinois file number.
 */
async function* streamComponentGroups(
  component: IllinoisSosPilotComponent,
  path: string,
  stats: MutableComponentStats,
): AsyncGenerator<PilotRecordGroup> {
  const lines = createInterface({
    crlfDelay: Infinity,
    input: createReadStream(path, { encoding: "utf8" }),
  });
  let lineNumber = 0;
  let trailerSeen = false;
  let pendingFileNumber: string | null = null;
  let pendingRecords: PilotRecord[] = [];

  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1) {
      const header = parseHeader(line, path);
      stats.headerFileLabel = header.fileLabel;
      stats.runDateCompact = header.runDateCompact;
      continue;
    }
    if (line.startsWith("END OF FILE RECORD COUNT=")) {
      if (pendingFileNumber !== null) {
        yield { fileNumber: pendingFileNumber, records: pendingRecords };
        pendingFileNumber = null;
        pendingRecords = [];
      }
      stats.trailerRecordCount = parseTrailer(line, path);
      trailerSeen = true;
      continue;
    }
    if (trailerSeen) {
      throw new Error(`${path}:${lineNumber} contains data after the trailer`);
    }

    stats.sourceRecordCount += 1;
    let record: PilotRecord;
    try {
      record = parsePilotRecord(component, line, lineNumber, stats);
    } catch (error) {
      const code =
        error instanceof PilotRecordValidationError
          ? error.code
          : "unexpected_record_error";
      stats.rejectedRecordCount += 1;
      stats.rejectionReasons[code] =
        (stats.rejectionReasons[code] ?? 0) + 1;
      continue;
    }
    stats.parsedRecordCount += 1;

    if (pendingFileNumber === null) {
      pendingFileNumber = record.fileNumber;
      pendingRecords = [record];
      continue;
    }
    if (record.fileNumber < pendingFileNumber) {
      stats.outOfOrderRecordCount += 1;
      throw new Error(
        `${path}:${lineNumber} is not ordered by Illinois file number`,
      );
    }
    if (record.fileNumber === pendingFileNumber) {
      stats.duplicateFileNumberCount += 1;
      pendingRecords.push(record);
      continue;
    }
    yield { fileNumber: pendingFileNumber, records: pendingRecords };
    pendingFileNumber = record.fileNumber;
    pendingRecords = [record];
  }

  if (!trailerSeen) throw new Error(`${path} is missing its trailer`);
  if (stats.trailerRecordCount !== stats.sourceRecordCount) {
    throw new Error(
      `${path} trailer count ${stats.trailerRecordCount} does not match ${stats.sourceRecordCount} source records`,
    );
  }
}

/**
 * Parse only the non-PII fields needed for exact joining and aggregate
 * registered-office geography.
 *
 * Agent names and street addresses are deliberately never read into the
 * returned record. Company names are checked for non-emptiness but are not
 * retained or emitted.
 *
 * @param component - Positional record schema.
 * @param rawLine - Unmodified source record.
 * @param lineNumber - One-based line number.
 * @param stats - Validation-warning counter.
 * @returns Minimal privacy-safe pilot record.
 */
function parsePilotRecord(
  component: IllinoisSosPilotComponent,
  rawLine: string,
  lineNumber: number,
  stats: MutableComponentStats,
): PilotRecord {
  const expectedWidth = WIDTH_BY_COMPONENT[component];
  if (rawLine.length > expectedWidth) {
    throw new PilotRecordValidationError(
      "overlong_record",
      `${component}:${lineNumber} exceeds width ${expectedWidth}`,
    );
  }
  const line = rawLine.padEnd(expectedWidth, " ");
  const fileNumber = readDigits(line, 0, 8, "file_number");
  if (/^0+$/.test(fileNumber)) {
    throw new PilotRecordValidationError(
      "zero_file_number",
      `${component}:${lineNumber} has a zero file number`,
    );
  }

  if (component === "master") {
    readDigits(line, 16, 24, "extended_filing_date");
    readDigits(line, 24, 26, "origin_state_code");
    readDigits(line, 26, 29, "business_intent_code");
    readDigits(line, 29, 31, "status_code");
    readDigits(line, 31, 32, "corporation_type_code");
    const incorporationDateCompact = readOptionalDate(
      readDigits(line, 8, 16, "incorporation_date"),
      stats,
    );
    const transactionDateCompact = readOptionalDate(
      readDigits(line, 32, 40, "transaction_date"),
      stats,
    );
    return {
      agentCity: null,
      agentCountyCode: null,
      agentPostalCode: null,
      fileNumber,
      incorporationDateCompact,
      transactionDateCompact,
    };
  }
  if (component === "name") {
    if (line.slice(8).trim().length === 0) {
      throw new PilotRecordValidationError(
        "empty_company_name",
        `name:${lineNumber} has no company name`,
      );
    }
    return emptyPilotRecord(fileNumber);
  }

  readOptionalDate(readDigits(line, 143, 151, "agent_change_date"), stats);
  const rawPostalCode = readDigits(line, 152, 161, "agent_postal_code");
  const agentCountyCode = readDigits(line, 161, 164, "agent_county_code");
  return {
    agentCity: readText(line, 113, 143),
    agentCountyCode,
    agentPostalCode:
      /^0+$/.test(rawPostalCode) ? null : rawPostalCode.slice(0, 5),
    fileNumber,
    incorporationDateCompact: null,
    transactionDateCompact: null,
  };
}

/**
 * Construct a component-neutral record for Name rows.
 *
 * @param fileNumber - Exact eight-digit Illinois file number.
 * @returns Minimal record with no retained company or person name.
 */
function emptyPilotRecord(fileNumber: string): PilotRecord {
  return {
    agentCity: null,
    agentCountyCode: null,
    agentPostalCode: null,
    fileNumber,
    incorporationDateCompact: null,
    transactionDateCompact: null,
  };
}

/**
 * Parse one component header while preserving its independent run date.
 *
 * @param line - Header source line.
 * @param path - Source path used in errors.
 * @returns Compact run date and file label.
 */
function parseHeader(
  line: string,
  path: string,
): { readonly fileLabel: string; readonly runDateCompact: string } {
  const match = /^RUN DATE\s*=\s*(\d{8})\s+FILE:\s*(.+)$/.exec(
    line.trimEnd(),
  );
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`${path} has an invalid header`);
  }
  if (!isValidCompactDate(match[1])) {
    throw new Error(`${path} has invalid header run date ${match[1]}`);
  }
  return { fileLabel: match[2].trim(), runDateCompact: match[1] };
}

/**
 * Parse one exact seven-digit trailer count.
 *
 * @param line - Trailer source line.
 * @param path - Source path used in errors.
 * @returns Declared source-record count.
 */
function parseTrailer(line: string, path: string): number {
  const match = /^END OF FILE RECORD COUNT=\s*(\d{7})\s*$/.exec(line);
  if (match?.[1] === undefined) {
    throw new Error(`${path} has an invalid trailer`);
  }
  return Number.parseInt(match[1], 10);
}

/**
 * Read a required numeric positional field.
 *
 * @param line - Right-padded fixed-width record.
 * @param start - Zero-based inclusive position.
 * @param end - Zero-based exclusive position.
 * @param fieldName - Non-PII rejection category.
 * @returns Exact source digits.
 */
function readDigits(
  line: string,
  start: number,
  end: number,
  fieldName: string,
): string {
  const value = line.slice(start, end);
  if (value.length !== end - start || !/^\d+$/.test(value)) {
    throw new PilotRecordValidationError(
      `invalid_${fieldName}`,
      `${fieldName} is not numeric`,
    );
  }
  return value;
}

/**
 * Read a trimmed non-sensitive geographic text field.
 *
 * @param line - Right-padded fixed-width record.
 * @param start - Zero-based inclusive position.
 * @param end - Zero-based exclusive position.
 * @returns Trimmed text or null.
 */
function readText(line: string, start: number, end: number): string | null {
  const value = line.slice(start, end).trim();
  return value.length === 0 ? null : value;
}

/**
 * Parse an optional source date and count invalid legacy calendar values.
 *
 * @param value - Eight numeric CCYYMMDD characters.
 * @param stats - Component warning counter.
 * @returns Valid compact date, or null for absent/invalid values.
 */
function readOptionalDate(
  value: string,
  stats: MutableComponentStats,
): string | null {
  if (/^0+$/.test(value) || /^9+$/.test(value)) return null;
  if (!isValidCompactDate(value)) {
    stats.validationWarningCount += 1;
    return null;
  }
  return value;
}

/**
 * Validate an eight-digit UTC calendar date.
 *
 * @param value - Candidate CCYYMMDD date.
 * @returns True only for a real calendar date.
 */
function isValidCompactDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/**
 * Determine whether a Master record may postdate the Name component.
 *
 * @param record - Minimal Master record.
 * @param nameRunDateCompact - Company Name component run date.
 * @returns True when incorporation or transaction date is later.
 */
function recordChangedAfter(
  record: PilotRecord,
  nameRunDateCompact: string,
): boolean {
  return (
    (record.incorporationDateCompact !== null &&
      record.incorporationDateCompact > nameRunDateCompact) ||
    (record.transactionDateCompact !== null &&
      record.transactionDateCompact > nameRunDateCompact)
  );
}

/**
 * Increment a non-sensitive aggregate when a value is available.
 *
 * @param counts - Aggregate map.
 * @param value - City or postal code, never a person/street field.
 */
function incrementAggregate(
  counts: Map<string, number>,
  value: string | null,
): void {
  if (value === null) return;
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

/**
 * Return the twenty most common aggregate values deterministically.
 *
 * @param counts - Aggregate map.
 * @returns Count-descending privacy-safe aggregate rows.
 */
function topAggregateEntries(
  counts: ReadonlyMap<string, number>,
): readonly {
  readonly count: number;
  readonly value: string;
}[] {
  return [...counts.entries()]
    .sort(([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount === leftCount
        ? leftValue.localeCompare(rightValue)
        : rightCount - leftCount,
    )
    .slice(0, 20)
    .map(([value, count]) => ({ count, value }));
}

/**
 * Initialize bounded component counters.
 *
 * @returns Mutable counters populated during streaming.
 */
function createMutableStats(): MutableComponentStats {
  return {
    duplicateFileNumberCount: 0,
    headerFileLabel: "",
    outOfOrderRecordCount: 0,
    parsedRecordCount: 0,
    rejectedRecordCount: 0,
    rejectionReasons: {},
    runDateCompact: "",
    sourceRecordCount: 0,
    trailerRecordCount: 0,
    validationWarningCount: 0,
  };
}

/**
 * Freeze mutable stream counters into a serializable component summary.
 *
 * @param component - Component kind.
 * @param sourcePath - Extracted source path.
 * @param stats - Completed stream counters.
 * @returns Independent component provenance and validation counts.
 */
function buildComponentSummary(
  component: IllinoisSosPilotComponent,
  sourcePath: string,
  stats: MutableComponentStats,
): IllinoisSosStreamingComponentSummary {
  return {
    component,
    duplicateFileNumberCount: stats.duplicateFileNumberCount,
    headerFileLabel: stats.headerFileLabel,
    outOfOrderRecordCount: stats.outOfOrderRecordCount,
    parsedRecordCount: stats.parsedRecordCount,
    rejectedRecordCount: stats.rejectedRecordCount,
    rejectionReasons: stats.rejectionReasons,
    runDate: `${stats.runDateCompact.slice(0, 4)}-${stats.runDateCompact.slice(4, 6)}-${stats.runDateCompact.slice(6, 8)}`,
    sourcePath,
    sourceRecordCount: stats.sourceRecordCount,
    trailerRecordCount: stats.trailerRecordCount,
    validationWarningCount: stats.validationWarningCount,
  };
}
