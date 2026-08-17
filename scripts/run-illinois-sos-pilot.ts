import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { analyzeIllinoisSosStreamingIntersectionPilot } from "./illinois-sos-streaming-pilot.js";
import {
  buildIllinoisSosRockIslandAddressCandidates,
  buildIllinoisSosPublicExportCandidates,
  joinIllinoisSosCorporationSnapshot,
  loadIllinoisSosCorporationSnapshot,
  matchIllinoisSosRockIslandCandidates,
  parseIllinoisSosCorporationFile,
  type IllinoisSosCorporationAgentRecord,
  type IllinoisSosCorporationComponent,
  type IllinoisSosCorporationMasterRecord,
  type IllinoisSosCorporationNameRecord,
  type IllinoisSosParsedComponentFile,
  type IllinoisSosParsedFile,
  type JsonObject,
  type QueryClient,
  type QueryRowsResult,
} from "../src/loader/index.js";

type PilotOptions = {
  readonly agentPath: string | null;
  readonly load: boolean;
  readonly masterPath: string | null;
  readonly matchDatabase: boolean;
  readonly namePath: string | null;
  readonly pilotDateMismatchIntersection: boolean;
};

type DatabaseQueryRunner = {
  readonly query: <Row extends JsonObject = JsonObject>(
    text: string,
    values: readonly unknown[],
  ) => Promise<{ readonly rows: readonly Row[] }>;
};

type AppraisalAddressRow = JsonObject & {
  readonly normalized_address_hash: string;
  readonly property_id: string;
};

type PropertyCountRow = JsonObject & {
  readonly property_count: number;
};

/**
 * Validate one or more locally obtained Illinois SOS corporation components,
 * optionally join the Master/Name/Agent trio, compare registered-office
 * addresses to Rock Island appraisal addresses, and idempotently load the
 * private logical tables.
 *
 * This command never downloads from Illinois SOS. Source files must be placed
 * under an ignored local directory by an operator who has reviewed the current
 * portal terms.
 *
 * @returns Promise resolved after validation and any explicitly requested
 * database operations finish.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.pilotDateMismatchIntersection) {
    if (options.load || options.matchDatabase) {
      throw new Error(
        "--pilot-date-mismatch-intersection cannot be combined with database options",
      );
    }
    if (
      options.masterPath === null ||
      options.namePath === null ||
      options.agentPath === null
    ) {
      throw new Error(
        "--pilot-date-mismatch-intersection requires --master, --name, and --agent",
      );
    }
    const result = await analyzeIllinoisSosStreamingIntersectionPilot({
      agentPath: resolve(options.agentPath),
      masterPath: resolve(options.masterPath),
      namePath: resolve(options.namePath),
    });
    console.log(JSON.stringify(result));
    return;
  }
  const parsedFiles: IllinoisSosParsedComponentFile[] = [];
  if (options.masterPath !== null) {
    parsedFiles.push(await readComponent("master", options.masterPath));
  }
  if (options.namePath !== null) {
    parsedFiles.push(await readComponent("name", options.namePath));
  }
  if (options.agentPath !== null) {
    parsedFiles.push(await readComponent("agent", options.agentPath));
  }
  console.log(
    JSON.stringify({
      event: "illinois_sos_components_validated",
      components: parsedFiles.map((file) => {
        const malformedRecordCount = file.records.filter(
          (record) => (record.validationIssues?.length ?? 0) > 0,
        ).length;
        const validationIssueCount = file.records.reduce(
          (count, record) => count + (record.validationIssues?.length ?? 0),
          0,
        );
        return {
          component: file.component,
          malformedRecordCount,
          recordCount: file.records.length,
          rejectedRecordCount: 0,
          runDate: file.runDate,
          sourceFileName: file.sourceFileName,
          validationIssueCount,
        };
      }),
    }),
  );

  const masterFile = parsedFiles.find((file) => file.component === "master");
  const nameFile = parsedFiles.find((file) => file.component === "name");
  const agentFile = parsedFiles.find((file) => file.component === "agent");
  if (masterFile === undefined || nameFile === undefined || agentFile === undefined) {
    if (options.load || options.matchDatabase) {
      throw new Error("--load and --match-database require --master, --name, and --agent");
    }
    return;
  }

  const snapshot = joinIllinoisSosCorporationSnapshot({
    agentFile,
    masterFile,
    nameFile,
  });
  const rockIslandCandidates =
    buildIllinoisSosRockIslandAddressCandidates(snapshot);
  const publicCandidates = buildIllinoisSosPublicExportCandidates(snapshot);
  console.log(
    JSON.stringify({
      event: "illinois_sos_snapshot_joined",
      corporationCount: snapshot.corporations.length,
      privacyReviewCandidateCount: publicCandidates.length,
      publicationApprovedCount: 0,
      rockIslandRegisteredOfficeCandidateCount: rockIslandCandidates.length,
      runDate: snapshot.runDate,
    }),
  );

  if (!options.load && !options.matchDatabase) return;
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required for --load or --match-database");
  }
  const pool = new Pool({
    application_name: "illinois-sos-corporation-pilot",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    max: 2,
  });
  const client = createQueryClient(pool);
  try {
    if (options.matchDatabase) {
      const propertyCount = await readRockIslandPropertyCount(client);
      const appraisalAddresses = await readRockIslandAppraisalAddresses(
        client,
        rockIslandCandidates.map((candidate) => candidate.normalizedAddressHash),
      );
      const matches = matchIllinoisSosRockIslandCandidates(
        rockIslandCandidates,
        appraisalAddresses.map((address) => ({
          normalizedAddressHash: address.normalized_address_hash,
          propertyId: address.property_id,
        })),
      );
      console.log(
        JSON.stringify({
          event: "illinois_sos_rock_island_match_summary",
          appraisalPropertyCount: propertyCount,
          matchedCandidateCount: matches.length,
          matchedPropertyCount: new Set(
            matches.flatMap((match) => match.matchedPropertyIds),
          ).size,
          registeredOfficeCandidateCount: rockIslandCandidates.length,
          relationshipInference: "none",
        }),
      );
    }
    if (options.load) {
      const counters = await loadIllinoisSosCorporationSnapshot(client, snapshot);
      console.log(
        JSON.stringify({
          event: "illinois_sos_load_finished",
          ...counters,
          sourceSystem: "illinois_sos",
        }),
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * Read and validate one local fixed-width component without changing its bytes.
 *
 * @param component - Official corporation component kind.
 * @param path - Operator-provided local path.
 * @returns Parsed and validated component file.
 */
async function readComponent(
  component: "agent",
  path: string,
): Promise<IllinoisSosParsedFile<IllinoisSosCorporationAgentRecord, "agent">>;
async function readComponent(
  component: "master",
  path: string,
): Promise<IllinoisSosParsedFile<IllinoisSosCorporationMasterRecord, "master">>;
async function readComponent(
  component: "name",
  path: string,
): Promise<IllinoisSosParsedFile<IllinoisSosCorporationNameRecord, "name">>;
async function readComponent(
  component: IllinoisSosCorporationComponent,
  path: string,
): Promise<IllinoisSosParsedComponentFile> {
  const absolutePath = resolve(path);
  const parsed = parseIllinoisSosCorporationFile({
    component,
    contents: await readFile(absolutePath, "utf8"),
    sourceArtifactUri: pathToFileURL(absolutePath).href,
    sourceFileName: basename(absolutePath),
  });
  if (parsed.component === "agent") return parsed;
  if (parsed.component === "master") return parsed;
  return parsed;
}

/**
 * Adapt a generic PostgreSQL pool to the loader's provider-neutral query
 * contract.
 *
 * @param runner - pg-compatible query runner.
 * @returns Loader query client.
 */
function createQueryClient(runner: DatabaseQueryRunner): QueryClient {
  return {
    async query<Row extends JsonObject = JsonObject>(
      text: string,
      values: readonly unknown[],
    ): Promise<QueryRowsResult<Row>> {
      const result = await runner.query<Row>(text, values);
      return { rows: result.rows };
    },
  };
}

/**
 * Read appraisal address evidence only for candidate hashes.
 *
 * @param client - Generic PostgreSQL query client.
 * @param normalizedAddressHashes - Candidate normalized hashes.
 * @returns Property IDs and hashes used by the pure offline matcher.
 */
async function readRockIslandAppraisalAddresses(
  client: QueryClient,
  normalizedAddressHashes: readonly string[],
): Promise<readonly AppraisalAddressRow[]> {
  if (normalizedAddressHashes.length === 0) return [];
  const result = await client.query<AppraisalAddressRow>(
    [
      `SELECT p.property_id::text AS property_id,`,
      `a.normalized_address_hash::text AS normalized_address_hash`,
      `FROM properties p`,
      `JOIN addresses a ON a.address_id = p.address_id`,
      `WHERE p.source_system = $1`,
      `AND a.normalized_address_hash = ANY($2::text[])`,
    ].join(" "),
    ["rock_island_appraiser", normalizedAddressHashes],
  );
  return result.rows;
}

/**
 * Count Rock Island properties for reconciliation with the completed appraisal.
 *
 * @param client - Generic PostgreSQL query client.
 * @returns Current property count.
 */
async function readRockIslandPropertyCount(client: QueryClient): Promise<number> {
  const result = await client.query<PropertyCountRow>(
    `SELECT count(*)::int AS property_count FROM properties WHERE source_system = $1`,
    ["rock_island_appraiser"],
  );
  return result.rows[0]?.property_count ?? 0;
}

/**
 * Parse the small, explicit pilot CLI surface.
 *
 * @param argv - Arguments after the script name.
 * @returns Validated local paths and opt-in database actions.
 */
export function parseIllinoisSosPilotOptions(argv: readonly string[]): PilotOptions {
  return parseOptions(argv);
}

function parseOptions(argv: readonly string[]): PilotOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token ?? ""}`);
    }
    const key = token.slice(2);
    if (
      key === "load" ||
      key === "match-database" ||
      key === "pilot-date-mismatch-intersection"
    ) {
      values.set(key, "true");
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    values.set(key, value);
    index += 1;
  }
  const recognized = new Set([
    "agent",
    "load",
    "master",
    "match-database",
    "name",
    "pilot-date-mismatch-intersection",
  ]);
  for (const key of values.keys()) {
    if (!recognized.has(key)) throw new Error(`Unknown option: --${key}`);
  }
  const options = {
    agentPath: values.get("agent") ?? null,
    load: values.has("load"),
    masterPath: values.get("master") ?? null,
    matchDatabase: values.has("match-database"),
    namePath: values.get("name") ?? null,
    pilotDateMismatchIntersection: values.has(
      "pilot-date-mismatch-intersection",
    ),
  };
  if (
    options.agentPath === null &&
    options.masterPath === null &&
    options.namePath === null
  ) {
    throw new Error("Provide at least one of --master, --name, or --agent");
  }
  return options;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
