import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeIllinoisSosStreamingIntersectionPilot } from "../scripts/illinois-sos-streaming-pilot.js";
import { parseIllinoisSosPilotOptions } from "../scripts/run-illinois-sos-pilot.js";

describe("Illinois SOS streaming mismatch pilot", () => {
  it("joins only the exact three-way file-number intersection", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "illinois-sos-streaming-pilot-"),
    );
    const masterPath = join(directory, "cdxallmst.txt");
    const namePath = join(directory, "cdxallnam.txt");
    const agentPath = join(directory, "cdxallagt.txt");
    try {
      await Promise.all([
        writeFile(
          masterPath,
          buildComponentFile("20260729", "CORP MASTER DATA", [
            buildMasterRecord("00000001", "20200101", "20260729"),
            buildMasterRecord("00000002", "20260729", "20260729"),
          ]),
        ),
        writeFile(
          namePath,
          buildComponentFile("20260728", "CORP MASTER NAME DATA", [
            "00000001SYNTHETIC ENTITY ONE",
            "00000003SYNTHETIC ENTITY THREE",
          ]),
        ),
        writeFile(
          agentPath,
          buildComponentFile("20260729", "CORP AGENT DATA", [
            buildAgentRecord("00000001", "MOLINE", "61265", "081"),
            buildAgentRecord("00000002", "ROCK ISLAND", "61201", "081"),
          ]),
        ),
      ]);

      const result = await analyzeIllinoisSosStreamingIntersectionPilot({
        agentPath,
        masterPath,
        namePath,
      });

      expect(result).toMatchObject({
        candidateAggregates: {
          agentAddressCandidateCount: 1,
          candidateEntityCount: 1,
          role: "registered_agent_office",
          state: "IL",
        },
        componentDateMismatch: true,
        join: {
          agentNameIntersectionCount: 1,
          agentWithoutMasterCount: 0,
          agentWithoutNameCount: 1,
          exactThreeWayIntersectionCount: 1,
          masterAgentIntersectionCount: 2,
          masterNameIntersectionCount: 1,
          masterPotentiallyChangedAfterNameRunDateCount: 2,
          masterWithoutAgentCount: 0,
          masterWithoutNameCount: 1,
          masterWithoutNamePotentiallyNewOrChangedCount: 1,
          nameWithoutAgentCount: 1,
          nameWithoutMasterCount: 1,
          potentiallyStaleNameIntersectionCount: 1,
          unionFileNumberCount: 3,
        },
        joinKey: "exact_illinois_file_number",
        productionEligible: false,
        publishable: false,
      });
      expect(result.warnings.map((warning) => warning.code)).toContain(
        "component_date_mismatch",
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("SYNTHETIC ENTITY");
      expect(serialized).not.toContain("PRIVATE AGENT PERSON");
      expect(serialized).not.toContain("PRIVATE STREET ADDRESS");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps date-mismatch tolerance explicit and off by default", () => {
    const strict = parseIllinoisSosPilotOptions(["--master", "master.txt"]);
    const pilot = parseIllinoisSosPilotOptions([
      "--master",
      "master.txt",
      "--name",
      "name.txt",
      "--agent",
      "agent.txt",
      "--pilot-date-mismatch-intersection",
    ]);

    expect(strict.pilotDateMismatchIntersection).toBe(false);
    expect(pilot.pilotDateMismatchIntersection).toBe(true);
  });
});

/**
 * Build a control-record-wrapped synthetic component.
 *
 * @param runDate - Independent component CCYYMMDD run date.
 * @param label - Header file label.
 * @param records - Ordered component records.
 * @returns Complete source text.
 */
function buildComponentFile(
  runDate: string,
  label: string,
  records: readonly string[],
): string {
  return [
    `RUN DATE=${runDate}   FILE:${label}`,
    ...records,
    `END OF FILE RECORD COUNT= ${String(records.length).padStart(7, "0")}`,
  ].join("\r\n");
}

/**
 * Build one synthetic Master record.
 *
 * @param fileNumber - Exact join key.
 * @param incorporationDate - Compact incorporation date.
 * @param transactionDate - Compact transaction date.
 * @returns Right-trimmed Master record.
 */
function buildMasterRecord(
  fileNumber: string,
  incorporationDate: string,
  transactionDate: string,
): string {
  let line = " ".repeat(160);
  line = writeField(line, 0, 8, fileNumber);
  line = writeField(line, 8, 16, incorporationDate);
  line = writeField(line, 16, 24, "00000000");
  line = writeField(line, 24, 26, "17");
  line = writeField(line, 26, 29, "012");
  line = writeField(line, 29, 31, "00");
  line = writeField(line, 31, 32, "4");
  line = writeField(line, 32, 40, transactionDate);
  return line.trimEnd();
}

/**
 * Build one synthetic Agent record without person or street values.
 *
 * @param fileNumber - Exact join key.
 * @param city - Aggregate-safe city.
 * @param postalCode - Five-digit ZIP code.
 * @param countyCode - Illinois county code.
 * @returns Official-width Agent record.
 */
function buildAgentRecord(
  fileNumber: string,
  city: string,
  postalCode: string,
  countyCode: string,
): string {
  let line = " ".repeat(164);
  line = writeField(line, 0, 8, fileNumber);
  line = writeField(line, 8, 68, "PRIVATE AGENT PERSON");
  line = writeField(line, 68, 113, "PRIVATE STREET ADDRESS");
  line = writeField(line, 113, 143, city);
  line = writeField(line, 143, 151, "00000000");
  line = writeField(line, 152, 161, `${postalCode}0000`);
  return writeField(line, 161, 164, countyCode);
}

/**
 * Replace one exact-width positional field.
 *
 * @param line - Existing fixed-width row.
 * @param start - Zero-based inclusive position.
 * @param end - Zero-based exclusive position.
 * @param value - Left-aligned field value.
 * @returns Updated row with unchanged total width.
 */
function writeField(
  line: string,
  start: number,
  end: number,
  value: string,
): string {
  const width = end - start;
  if (value.length > width) throw new Error(`Value exceeds width ${width}`);
  return `${line.slice(0, start)}${value.padEnd(width)}${line.slice(end)}`;
}
