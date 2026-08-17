import { describe, expect, it } from "vitest";

import { parseIllinoisSosComponentOptions } from "../scripts/run-illinois-sos-components.js";
import {
  ILLINOIS_SOS_BULK_COMPONENT_SPECS,
  joinIllinoisSosBulkComponentEvidence,
  mapIllinoisSosBulkComponentFile,
  parseIllinoisSosBulkComponentFile,
  type IllinoisSosBulkComponentSpec,
} from "../src/loader/index.js";

describe("Illinois SOS supplemental Corporation and LLC bulk components", () => {
  it("parses every official fixed-width component with its documented width", () => {
    for (const spec of ILLINOIS_SOS_BULK_COMPONENT_SPECS) {
      const parsed = parseIllinoisSosBulkComponentFile({
        component: spec.component,
        contents: buildFile(spec, "20260814"),
        entityKind: spec.entityKind,
        sourceArtifactUri: `file:///private/${spec.entityKind}-${spec.component}.txt`,
        sourceFileName: `${spec.entityKind}-${spec.component}.txt`,
      });

      expect(parsed.recordLength).toBe(spec.recordLength);
      expect(parsed.runDate).toBe("2026-08-14");
      expect(parsed.records).toHaveLength(1);
      expect(parsed.records[0]?.fileNumber).toBe("12345678");
      expect(parsed.records[0]?.rawLine).toHaveLength(spec.recordLength);
    }
  });

  it("keeps component run dates independent", () => {
    const masterSpec = mustGetSpec("llc", "master");
    const nameSpec = mustGetSpec("llc", "name");
    const master = parseIllinoisSosBulkComponentFile({
      component: "master",
      contents: buildFile(masterSpec, "20260813"),
      entityKind: "llc",
      sourceArtifactUri: "file:///private/llc-master.txt",
      sourceFileName: "llc-master.txt",
    });
    const name = parseIllinoisSosBulkComponentFile({
      component: "name",
      contents: buildFile(nameSpec, "20260814"),
      entityKind: "llc",
      sourceArtifactUri: "file:///private/llc-name.txt",
      sourceFileName: "llc-name.txt",
    });

    expect(master.runDate).toBe("2026-08-13");
    expect(name.runDate).toBe("2026-08-14");
    expect(master.records[0]?.fileNumber).toBe(name.records[0]?.fileNumber);
    expect(joinIllinoisSosBulkComponentEvidence([name, master])).toEqual([
      expect.objectContaining({
        entityKind: "llc",
        fileNumber: "12345678",
        components: [
          expect.objectContaining({
            component: "master",
            runDate: "2026-08-13",
          }),
          expect.objectContaining({
            component: "name",
            runDate: "2026-08-14",
          }),
        ],
      }),
    ]);
  });

  it("does not collide identical Corporation and LLC file numbers", () => {
    const corporationSpec = mustGetSpec("corporation", "stock");
    const llcSpec = mustGetSpec("llc", "master");
    const corporation = parseIllinoisSosBulkComponentFile({
      component: "stock",
      contents: buildFile(corporationSpec, "20260814"),
      entityKind: "corporation",
      sourceArtifactUri: "file:///private/corp-stock.txt",
      sourceFileName: "corp-stock.txt",
    });
    const llc = parseIllinoisSosBulkComponentFile({
      component: "master",
      contents: buildFile(llcSpec, "20260814"),
      entityKind: "llc",
      sourceArtifactUri: "file:///private/llc-master.txt",
      sourceFileName: "llc-master.txt",
    });

    expect(
      joinIllinoisSosBulkComponentEvidence([corporation, llc]).map(
        (entity) => `${entity.entityKind}:${entity.fileNumber}`,
      ),
    ).toEqual(["corporation:12345678", "llc:12345678"]);
  });

  it("maps source records only to the private non-publishable table", () => {
    const spec = mustGetSpec("llc", "manager_member");
    const parsed = parseIllinoisSosBulkComponentFile({
      component: "manager_member",
      contents: buildFile(spec, "20260814"),
      entityKind: "llc",
      sourceArtifactUri: "file:///private/llc-manager.txt",
      sourceFileName: "llc-manager.txt",
    });
    const rows = mapIllinoisSosBulkComponentFile(parsed);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tableName).toBe("illinois_sos_component_records");
    expect(rows[0]?.values).toMatchObject({
      entity_kind: "llc",
      file_number: "12345678",
      privacy_classification: "private_non_publishable",
      publication_approved: false,
      snapshot_date: "2026-08-14",
    });
    expect(
      rows.some((row) =>
        ["addresses", "companies", "business_registrations"].includes(
          row.tableName,
        ),
      ),
    ).toBe(false);
  });

  it("accepts repeatable local files and requires a supported pair", () => {
    expect(
      parseIllinoisSosComponentOptions([
        "--file",
        "corporation:stock:/private/corp-stock.txt",
        "--file",
        "llc:manager_member:/private/llc-manager.txt",
        "--load",
      ]),
    ).toMatchObject({
      inputs: [
        {
          component: "stock",
          entityKind: "corporation",
          path: "/private/corp-stock.txt",
        },
        {
          component: "manager_member",
          entityKind: "llc",
          path: "/private/llc-manager.txt",
        },
      ],
      load: true,
    });
    expect(() =>
      parseIllinoisSosComponentOptions([
        "--file",
        "corporation:manager_member:/private/no.txt",
      ]),
    ).toThrow(/Unsupported/u);
  });
});

function mustGetSpec(
  entityKind: "corporation" | "llc",
  component: string,
): IllinoisSosBulkComponentSpec {
  const spec = ILLINOIS_SOS_BULK_COMPONENT_SPECS.find(
    (candidate) =>
      candidate.entityKind === entityKind &&
      candidate.component === component,
  );
  if (spec === undefined) {
    throw new Error(`Missing test component ${entityKind}:${component}`);
  }
  return spec;
}

function buildFile(
  spec: IllinoisSosBulkComponentSpec,
  runDate: string,
): string {
  const characters = Array.from({ length: spec.recordLength }, () => " ");
  for (const field of spec.fields) {
    const width = field.end - field.start + 1;
    const value =
      field.name === "file_number"
        ? "12345678"
        : field.kind === "text"
          ? ""
          : "0".repeat(width);
    writeFixedWidth(characters, field.start, field.end, value);
  }
  const record = characters.join("");
  return [
    `RUN DATE = ${runDate} FILE: TEST`.padEnd(spec.recordLength, " "),
    record,
    "END OF FILE RECORD COUNT=0000001".padEnd(spec.recordLength, " "),
    "",
  ].join("\n");
}

function writeFixedWidth(
  characters: string[],
  start: number,
  end: number,
  value: string,
): void {
  const width = end - start + 1;
  if (value.length > width) {
    throw new Error(`Test value exceeds positions ${start}-${end}`);
  }
  const padded = value.padEnd(width, " ");
  for (let offset = 0; offset < width; offset += 1) {
    characters[start - 1 + offset] = padded[offset] ?? " ";
  }
}
