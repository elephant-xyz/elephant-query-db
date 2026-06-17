import { readFile, writeFile } from "node:fs/promises";

import AdmZip from "adm-zip";

import { extractLeeAppraisalSearchResult } from "../src/loader/index.js";

type ParseSearchResultOptions = {
  readonly inputZip: string;
  readonly output: string | null;
};

/**
 * Parse one prepared Lee STRAP-search output ZIP and print the first Folio ID
 * mapping discovered in the captured result page.
 *
 * @returns Promise that resolves after JSON is printed or written.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const result = await parseZip(options.inputZip);
  const text = JSON.stringify({ inputZip: options.inputZip, result }, null, 2).concat("\n");
  if (options.output === null) {
    process.stdout.write(text);
  } else {
    await writeFile(options.output, text, "utf8");
  }
}

/**
 * Parse the first HTML file from a prepared output ZIP.
 *
 * @param inputZip - Local prepared ZIP path downloaded from S3.
 * @returns Extracted search result object or `null` when no result link exists.
 */
async function parseZip(inputZip: string): Promise<ReturnType<typeof extractLeeAppraisalSearchResult>> {
  const zip = new AdmZip(Buffer.from(await readFile(inputZip)));
  const htmlEntry = zip.getEntries().find((entry) => entry.entryName.endsWith(".html"));
  if (htmlEntry === undefined) throw new Error(`No HTML entry found in ${inputZip}`);
  return extractLeeAppraisalSearchResult(zip.readAsText(htmlEntry));
}

/**
 * Parse CLI options for the search-result parser.
 *
 * @param args - Raw command-line arguments after the script name.
 * @returns Normalized options.
 */
function parseOptions(args: readonly string[]): ParseSearchResultOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === undefined || !raw.startsWith("--")) continue;
    const equalsIndex = raw.indexOf("=");
    if (equalsIndex > 2) {
      values.set(raw.slice(2, equalsIndex), raw.slice(equalsIndex + 1));
      continue;
    }
    const key = raw.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, "true");
    }
  }

  const inputZip = values.get("input-zip");
  if (inputZip === undefined || inputZip.trim().length === 0) {
    throw new Error("--input-zip is required");
  }
  return {
    inputZip,
    output: values.get("output") ?? null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error(JSON.stringify({ event: "lee_appraisal_search_result_parse_failed", error: message }));
    process.exitCode = 1;
  });
}
