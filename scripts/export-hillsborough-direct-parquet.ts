import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { ParquetWriter } from "@dsnp/parquetjs";
import AdmZip from "adm-zip";

import {
  buildQueryTableParquetSchema,
  type QueryTableRow,
} from "./run-query-table-export.js";
import { parseUnnormalizedAddress } from "./run-property-consolidation-export.js";

/**
 * Options for direct Hillsborough Parquet generation.
 */
export type HillsboroughDirectParquetOptions = {
  readonly parcelsDir: string;
  readonly permitsJsonl: string;
  readonly enrichedPermitsJsonl: string;
  readonly municipalEnrichedJsonl: string;
  readonly bbbProfilesDir: string;
  readonly outDir: string;
  readonly limit: number | null;
  readonly progressFile: string;
};

export function parseOptions(argv: readonly string[]): HillsboroughDirectParquetOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }

  const limitRaw = values.get("limit");
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : null;

  return {
    parcelsDir: values.get("parcels-dir") ?? "../oracle-node-hillsborough/downloads/hillsborough/full-run",
    permitsJsonl:
      values.get("permits-jsonl") ??
      "../oracle-node-hillsborough/downloads/hillsborough/full-permits/normalized-permits.jsonl",
    enrichedPermitsJsonl:
      values.get("enriched-permits-jsonl") ??
      "../oracle-node-hillsborough/downloads/hillsborough/full-permits/enriched-permits.jsonl",
    municipalEnrichedJsonl:
      values.get("municipal-enriched-jsonl") ??
      "../oracle-node-hillsborough/downloads/hillsborough/full-permits/municipal-enriched-temp.jsonl",
    bbbProfilesDir:
      values.get("bbb-profiles-dir") ??
      "../oracle-node-hillsborough/downloads/hillsborough/bbb-harvest/profiles",
    outDir: values.get("out-dir") ?? "../oracle-node-hillsborough/downloads/hillsborough/publish",
    limit: limit !== null && !Number.isNaN(limit) ? limit : null,
    progressFile:
      values.get("progress-file") ??
      "../oracle-node-hillsborough/downloads/hillsborough/publish-progress.json",
  };
}

/**
 * Aggregated permit and CRM signals for a parcel.
 */
export type ParcelPermitAggregate = {
  count: number;
  hasRoof: boolean;
  hasSolar: boolean;
  hasHvac: boolean;
  hasBbbContractor: boolean;
  fallbackRoofMaterial: string | null;
};

/**
 * Load BBB profiles index by license number and name for fast cross-joins across all trades.
 */
async function loadBbbIndex(bbbProfilesDir: string): Promise<{
  readonly licenses: Set<string>;
  readonly names: Set<string>;
}> {
  const licenses = new Set<string>();
  const names = new Set<string>();

  const baseDirs = [
    bbbProfilesDir,
    bbbProfilesDir.replace("bbb-harvest", "bbb-harvest-hvac"),
    bbbProfilesDir.replace("bbb-harvest", "bbb-harvest-solar"),
  ];

  for (const bDir of baseDirs) {
    if (!existsSync(bDir)) continue;
    const files = readdirSync(bDir).filter((f) => f.endsWith(".jsonl"));
    for (const f of files) {
      const profilePath = join(bDir, f);
      const rl = createInterface({
        input: createReadStream(profilePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line);
          if (Array.isArray(p.licenses)) {
            for (const lic of p.licenses) {
              const raw = String(lic.rawText || "");
              const matches = raw.match(/\b(C[A-Z]{2}\d{5,8}|CCC\d+|CBC\d+|CGC\d+|CMC\d+|CAC\d+|CVC\d+|EC\d+)\b/gi);
              if (matches) {
                for (const m of matches) licenses.add(m.toUpperCase());
              }
            }
          }
          const bName = String(p.name || p.businessName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          if (bName.length > 3) names.add(bName);
        } catch {}
      }
    }
  }

  return { licenses, names };
}

/**
 * Load permit stats per folio/pin into an in-memory Map for O(1) joins.
 */
async function loadPermitStats(
  permitsJsonlPath: string,
  enrichedPermitsPath: string,
  municipalPermitsPath: string,
  bbbIndex: { licenses: Set<string>; names: Set<string> },
): Promise<Map<string, ParcelPermitAggregate>> {
  const stats = new Map<string, ParcelPermitAggregate>();

  // 1. Ingest baseline normalized permits
  if (existsSync(permitsJsonlPath)) {
    const rl = createInterface({
      input: createReadStream(permitsJsonlPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line);
        const key = p.parcel_identifier || p.request_identifier;
        if (!key) continue;

        const isRoof = Boolean(p.is_roof_permit);
        const desc = String(p.project_description || "").toLowerCase();
        const isSolar = desc.includes("solar") || desc.includes("photovoltaic");
        const isHvac = desc.includes("ac ") || desc.includes("hvac") || desc.includes("heat pump") || desc.includes("mechanical");

        const existing = stats.get(key);
        if (existing) {
          existing.count += 1;
          if (isRoof) existing.hasRoof = true;
          if (isSolar) existing.hasSolar = true;
          if (isHvac) existing.hasHvac = true;
        } else {
          stats.set(key, {
            count: 1,
            hasRoof: isRoof,
            hasSolar: isSolar,
            hasHvac: isHvac,
            hasBbbContractor: false,
            fallbackRoofMaterial: null,
          });
        }
      } catch {}
    }
  }

  // 2. Ingest enriched permit details (Accela + Municipal)
  const enrichedFiles = [enrichedPermitsPath, municipalPermitsPath].filter((f) => existsSync(f));
  for (const filePath of enrichedFiles) {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line);
        const key = p.parcel_identifier || p.request_identifier;
        if (!key) continue;

        const agg = stats.get(key);
        if (!agg) continue;

        if (p.roofing_material && !agg.fallbackRoofMaterial) {
          agg.fallbackRoofMaterial = String(p.roofing_material).trim();
        }

        const c = p.contractor;
        if (c) {
          const lic = c.licenseNumber ? String(c.licenseNumber).toUpperCase() : null;
          const bName = c.businessName ? String(c.businessName).toLowerCase().replace(/[^a-z0-9]/g, "") : null;
          if ((lic && bbbIndex.licenses.has(lic)) || (bName && bbbIndex.names.has(bName))) {
            agg.hasBbbContractor = true;
          }
        }
      } catch {}
    }
  }

  return stats;
}

/**
 * Extract flat QueryTableRow directly from parcel files asynchronously.
 */
async function extractQueryTableRowAsync(params: {
  readonly parcelDir: string;
  readonly folio: string;
  readonly permitStats: Map<string, ParcelPermitAggregate>;
}): Promise<QueryTableRow | null> {
  const { parcelDir, folio, permitStats } = params;
  let parcelData: Record<string, any> | null = null;
  let unnormAddr: Record<string, any> | null = null;

  const pPath = join(parcelDir, "parcel-data.json");
  const aPath = join(parcelDir, "unnormalized_address.json");

  try {
    const [pText, aText] = await Promise.all([
      readFile(pPath, "utf8").catch(() => null),
      readFile(aPath, "utf8").catch(() => null),
    ]);
    if (pText) parcelData = JSON.parse(pText);
    if (aText) unnormAddr = JSON.parse(aText);
  } catch {}

  // Fallback to transformed_output.zip if parcel-data.json is missing
  if (!parcelData) {
    const zipPath = join(parcelDir, "transformed_output.zip");
    if (existsSync(zipPath)) {
      try {
        const zip = new AdmZip(zipPath);
        const pEntry = zip.getEntry("parcel-data.json");
        if (pEntry) parcelData = JSON.parse(pEntry.getData().toString("utf8"));
        const aEntry = zip.getEntry("unnormalized_address.json");
        if (aEntry && !unnormAddr) unnormAddr = JSON.parse(aEntry.getData().toString("utf8"));
      } catch {}
    }
  }

  if (!parcelData && !unnormAddr) return null;

  const p = parcelData || {};
  const propCard = p.propertyCard || {};
  const pin = p.pin || folio;
  const siteAddr = p.siteAddress || unnormAddr?.full_address || unnormAddr?.unnormalized_address || null;
  const parsedAddr = siteAddr ? parseUnnormalizedAddress(siteAddr) : { street: null, city: null, postalCode: null };

  // Building characteristics
  let exteriorWall: string | null = null;
  let roofCover: string | null = null;
  let builtYear: number | null = null;
  let livableArea: number | null = null;
  let totalArea: number | null = null;

  if (Array.isArray(p.buildings) && p.buildings.length > 0) {
    const b0 = p.buildings[0];
    if (b0) {
      if (b0.actualYear && Number(b0.actualYear) > 1800) builtYear = Number(b0.actualYear);
      else if (b0.effectiveYear && Number(b0.effectiveYear) > 1800) builtYear = Number(b0.effectiveYear);

      if (b0.grossArea && Number(b0.grossArea) > 0) totalArea = Number(b0.grossArea);
      if (b0.heatedArea && Number(b0.heatedArea) > 0) livableArea = Number(b0.heatedArea);

      if (Array.isArray(b0.constructionInfo)) {
        for (const c of b0.constructionInfo) {
          const elemCode = String(c?.element?.code || "").trim();
          const descr = String(c?.constructionDetail?.description || "").trim();
          if (elemCode === "EW" && descr) exteriorWall = descr;
          if (elemCode === "RC" && descr) roofCover = descr;
        }
      }
    }
  }

  // Valuations
  let marketVal: number | null = null;
  let assessedVal: number | null = null;
  let landVal: number | null = null;

  if (Array.isArray(p.valueSummary)) {
    for (const v of p.valueSummary) {
      if (v.marketVal && marketVal === null) marketVal = Number(v.marketVal);
      if (v.assessedVal && assessedVal === null) assessedVal = Number(v.assessedVal);
    }
  }
  if (propCard.current) {
    if (propCard.current.land && Number(propCard.current.land) > 0) landVal = Number(propCard.current.land);
  }

  // Sales
  let lastSaleDate: string | null = null;
  let lastSalePrice: number | null = null;
  if (Array.isArray(p.salesHistory) && p.salesHistory.length > 0) {
    const s0 = p.salesHistory[0];
    if (s0) {
      if (s0.date) lastSaleDate = String(s0.date).trim();
      if (s0.price && Number(s0.price) > 0) lastSalePrice = Number(s0.price);
    }
  }

  // Permits join
  const pStat = permitStats.get(folio) || permitStats.get(pin) || null;
  const embeddedPermitsCount = Array.isArray(p.permitInfo) ? p.permitInfo.length : 0;
  const permitCount = pStat ? pStat.count : embeddedPermitsCount;
  const hasPermits = permitCount > 0;
  const hasBbbContractor = pStat ? pStat.hasBbbContractor : false;

  // Fallback roof covering material from deep permit enrichment if appraisal is blank
  if (!roofCover && pStat?.fallbackRoofMaterial) {
    roofCover = pStat.fallbackRoofMaterial;
  }

  // Owner
  const ownerName = p.owner ? String(p.owner).replace(/;\s*$/, "").trim() : null;
  const ownerCount = ownerName ? (ownerName.includes(";") || ownerName.includes("&") ? 2 : 1) : null;

  const lotAcre = p.acreage ? Number(p.acreage) : (propCard.acreage ? Number(propCard.acreage) : null);
  const lotSqft = lotAcre ? Math.round(lotAcre * 43560) : null;

  const lat = unnormAddr?.latitude ? Number(unnormAddr.latitude) : null;
  const lon = unnormAddr?.longitude ? Number(unnormAddr.longitude) : null;

  return {
    property_id: pin,
    property_cid: null,
    request_identifier: pin,
    parcel_identifier: folio,
    source_system: "hillsborough_appraiser",
    county_name: "Hillsborough",
    state_code: "FL",
    address_street: parsedAddr.street,
    address_city: parsedAddr.city || (unnormAddr?.city ? String(unnormAddr.city) : "Tampa"),
    address_zip: parsedAddr.postalCode || (p.mailingAddress?.zip ? String(p.mailingAddress.zip).slice(0, 5) : null),
    latitude: lat,
    longitude: lon,
    lot_size_acre: lotAcre,
    lot_area_sqft: lotSqft,
    exterior_wall_material: exteriorWall,
    roof_covering_material: roofCover,
    property_type: p.landUse?.description || propCard.landUse?.description || null,
    property_usage_type: p.landUse?.code || propCard.landUse?.code || null,
    built_year: builtYear,
    livable_floor_area: livableArea,
    total_area: totalArea,
    assessed_value: assessedVal,
    market_value: marketVal,
    land_value: landVal,
    avm_value: marketVal,
    owner_name: ownerName,
    owners_text: ownerName,
    owner_count: ownerCount,
    owner_occupied: null,
    last_sale_date: lastSaleDate,
    last_sale_price: lastSalePrice,
    subdivision: p.subdivision?.description || propCard.subdivision?.description || null,
    has_permits: hasPermits,
    permit_count: permitCount,
    has_sunbiz_tenant: false,
    has_bbb_contractor: hasBbbContractor,
    has_pa_corp_tenant: false,
    hoa_flag: null,
  };
}

/**
 * Format records for parquetjs (strip nulls/undefined for optional fields).
 */
function toParquetRecord(row: QueryTableRow): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && value !== undefined) record[key] = value;
  }
  return record;
}

export async function runHillsboroughDirectParquet(options: HillsboroughDirectParquetOptions): Promise<{
  readonly totalParcels: number;
  readonly parquetPath: string;
  readonly fileSizeBytes: number;
}> {
  await mkdir(options.outDir, { recursive: true });
  const parquetPath = join(options.outDir, "query-table.parquet");

  console.log(
    JSON.stringify({
      event: "hillsborough_direct_parquet_started",
      parcelsDir: options.parcelsDir,
      permitsJsonl: options.permitsJsonl,
      enrichedPermitsJsonl: options.enrichedPermitsJsonl,
      outDir: options.outDir,
      limit: options.limit,
    }),
  );

  console.log("Loading BBB roofer profiles index...");
  const bbbIndex = await loadBbbIndex(options.bbbProfilesDir);
  console.log(`Loaded ${bbbIndex.licenses.size} BBB roofer licenses and ${bbbIndex.names.size} contractor names.`);

  console.log("Loading permits and enriched contractor joins into memory index...");
  const permitStats = await loadPermitStats(
    options.permitsJsonl,
    options.enrichedPermitsJsonl,
    options.municipalEnrichedJsonl,
    bbbIndex,
  );
  console.log(`Loaded deep permit indexes for ${permitStats.size.toLocaleString()} distinct properties.`);

  const schema = buildQueryTableParquetSchema();
  const writer = await ParquetWriter.openFile(schema, parquetPath, {
    useDataPageV2: false,
  });

  const allDirs = readdirSync(options.parcelsDir).filter((d) => !d.startsWith(".") && !d.startsWith("_"));
  const targetDirs = options.limit !== null ? allDirs.slice(0, options.limit) : allDirs;
  const targetCount = targetDirs.length;
  let processedCount = 0;
  const startedAt = Date.now();
  let lastLogTime = startedAt;

  const BATCH_SIZE = 512;
  for (let i = 0; i < targetDirs.length; i += BATCH_SIZE) {
    const chunk = targetDirs.slice(i, i + BATCH_SIZE);
    const rows = await Promise.all(
      chunk.map((folio) =>
        extractQueryTableRowAsync({
          parcelDir: join(options.parcelsDir, folio),
          folio,
          permitStats,
        }),
      ),
    );

    for (const row of rows) {
      if (row) {
        await writer.appendRow(toParquetRecord(row));
        processedCount += 1;
      }
    }

    const now = Date.now();
    if (now - lastLogTime >= 2000 || processedCount >= targetCount) {
      lastLogTime = now;
      const elapsedSec = Math.max(1, (now - startedAt) / 1000);
      const rate = Math.round(processedCount / elapsedSec);
      const remaining = Math.max(0, targetCount - processedCount);
      const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;

      try {
        writeFileSync(
          options.progressFile,
          JSON.stringify({
            status: processedCount >= targetCount ? "completed" : "in_progress",
            processedCount,
            targetCount,
            parcelsPerSecond: rate,
            etaSeconds: etaSec,
            updatedAt: new Date(now).toISOString(),
          }),
          "utf8",
        );
      } catch {}

      console.log(
        JSON.stringify({
          event: "parquet_progress",
          processed: processedCount,
          target: targetCount,
          pct: ((processedCount / targetCount) * 100).toFixed(1),
          ratePerSec: rate,
          etaSec,
        }),
      );
    }
  }

  await writer.close();
  const fileSizeBytes = statSync(parquetPath).size;

  try {
    writeFileSync(
      options.progressFile,
      JSON.stringify({
        status: "completed",
        processedCount,
        targetCount,
        parcelsPerSecond: 0,
        etaSeconds: 0,
        fileSizeBytes,
        parquetPath,
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
  } catch {}

  console.log(
    JSON.stringify({
      event: "hillsborough_direct_parquet_finished",
      totalParcels: processedCount,
      parquetPath,
      fileSizeBytes,
    }),
  );

  return {
    totalParcels: processedCount,
    parquetPath,
    fileSizeBytes,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  await runHillsboroughDirectParquet(options);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error("Error generating Hillsborough Direct Parquet:", error);
    process.exit(1);
  });
}
