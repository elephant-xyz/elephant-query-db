import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import AdmZip from "adm-zip";
import { Pool } from "pg";

import { artifactPathOnEbs } from "./repair-rock-island-geometry-source-payload.js";
import { isJsonObject } from "./public-geometry.js";

const SOURCE_SYSTEM = "rock_island_appraiser";
const EXPECTED_FOLIOS = 65_806;

type ArtifactRow = {
  readonly request_identifier: string;
  readonly source_artifact_uri: string;
};

type FieldCounter = {
  occurrences: number;
  folios: Set<string>;
};

type InventoryOptions = {
  readonly outputPath: string;
  readonly concurrency: number;
};

function isPrivateFamilyKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.startsWith("taxbill") ||
    normalized.startsWith("owner") ||
    normalized.startsWith("purchased_email") ||
    normalized.startsWith("purchased_phone") ||
    normalized.startsWith("contact_suppression") ||
    normalized.startsWith("campaign_history") ||
    normalized.startsWith("owner_responses") ||
    normalized.startsWith("contact") ||
    normalized.startsWith("campaign")
  );
}

function recordKey(
  counters: Map<string, FieldCounter>,
  key: string,
  folio: string,
): void {
  const existing = counters.get(key) ?? {
    occurrences: 0,
    folios: new Set<string>(),
  };
  existing.occurrences += 1;
  existing.folios.add(folio);
  counters.set(key, existing);
}

function inventoryValue(
  value: unknown,
  folio: string,
  counters: Map<string, FieldCounter>,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => inventoryValue(entry, folio, counters));
    return;
  }
  if (!isJsonObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (isPrivateFamilyKey(key)) recordKey(counters, key, folio);
    inventoryValue(nested, folio, counters);
  }
}

function readRawSourcePayload(row: ArtifactRow): unknown {
  const zip = new AdmZip(artifactPathOnEbs(row.source_artifact_uri));
  const entry = zip.getEntry("data/source_payload.ndjson");
  if (entry === null) {
    throw new Error(`Missing source_payload sidecar for ${row.request_identifier}`);
  }
  const lines = entry
    .getData()
    .toString("utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new Error(
      `Invalid source_payload sidecar record count for ${row.request_identifier}`,
    );
  }
  return JSON.parse(lines[0] ?? "null") as unknown;
}

function parseOptions(argv: readonly string[]): InventoryOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token?.startsWith("--") === true && next !== undefined && !next.startsWith("--")) {
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  const outputPath = values.get("output");
  if (outputPath === undefined) throw new Error("--output is required");
  const concurrency = Number.parseInt(values.get("concurrency") ?? "12", 10);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("--concurrency must be between 1 and 32");
  }
  return { outputPath, concurrency };
}

/**
 * Inventory only private-family field names across every retained source ZIP.
 *
 * @param options - Output path and bounded ZIP-reader concurrency.
 * @returns Name-only inventory with occurrence and folio counts.
 */
export async function inventoryRockIslandSourceFields(
  options: InventoryOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query<ArtifactRow>(
      `SELECT request_identifier, source_artifact_uri
         FROM parcels
        WHERE source_system = $1
        ORDER BY request_identifier`,
      [SOURCE_SYSTEM],
    );
    if (result.rows.length !== EXPECTED_FOLIOS) {
      throw new Error(
        `Source field inventory requires ${EXPECTED_FOLIOS} folios; received ${result.rows.length}`,
      );
    }
    const partial: Array<Map<string, FieldCounter>> = new Array(result.rows.length);
    let nextIndex = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(options.concurrency, result.rows.length) },
        async () => {
          while (true) {
            const index = nextIndex;
            nextIndex += 1;
            const row = result.rows[index];
            if (row === undefined) return;
            const counters = new Map<string, FieldCounter>();
            inventoryValue(
              readRawSourcePayload(row),
              row.request_identifier,
              counters,
            );
            partial[index] = counters;
          }
        },
      ),
    );
    const combined = new Map<string, FieldCounter>();
    for (const counters of partial) {
      counters.forEach((counter, key) => {
        const existing = combined.get(key) ?? {
          occurrences: 0,
          folios: new Set<string>(),
        };
        existing.occurrences += counter.occurrences;
        counter.folios.forEach((folio) => existing.folios.add(folio));
        combined.set(key, existing);
      });
    }
    const fields = [...combined.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, counter]) => ({
        name,
        occurrences: counter.occurrences,
        folioCount: counter.folios.size,
      }));
    const inventory = {
      schemaVersion: "1",
      sourceSystem: SOURCE_SYSTEM,
      scannedFolios: result.rows.length,
      fields,
      inventorySha256: createHash("sha256")
        .update(JSON.stringify(fields))
        .digest("hex"),
    };
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(
      options.outputPath,
      `${JSON.stringify(inventory, null, 2)}\n`,
      { mode: 0o600 },
    );
    return inventory;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const inventory = await inventoryRockIslandSourceFields(
    parseOptions(process.argv.slice(2)),
  );
  console.log(JSON.stringify({ event: "source_field_inventory_complete", ...inventory }));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "source_field_inventory_failed", error: message }));
    process.exit(1);
  });
}
