import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertDedicatedPlacesBucket,
  assertFilebaseCredentials,
  buildPlacesGatewayUrls,
  defaultPlacesBucket,
  defaultPlacesIpnsLabel,
  planPlacesUpload,
  propertyIpnsLabel,
  resolvePlacesIpnsLabel,
  restorePlacesIpnsPointer,
  uploadPlacesTable,
} from "../scripts/upload-places-table-to-filebase.js";

const PLACES_LABEL = "oracle-open-data-lee-places";
const PROPERTY_LABEL = "oracle-open-data-lee";
const NETWORK_KEY = "k51qziplacesnamexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const BUCKET_CID = "QmPlacesBucketDirectoryCidXXXXXXXXXXXXXXXXXXXX";

type UploadArgs = Parameters<typeof uploadPlacesTable>[0];
const asClient = (c: unknown): UploadArgs["client"] => c as UploadArgs["client"];
const asFetch = (f: unknown): UploadArgs["fetchImpl"] => f as UploadArgs["fetchImpl"];

type SentCommand = {
  readonly name: string;
  readonly bucket: string | undefined;
  readonly key: string | undefined;
};

function createMockS3Client(headerCid = BUCKET_CID) {
  const sent: SentCommand[] = [];
  const middlewares: { name: string; fn: (next: unknown, ctx: unknown) => unknown }[] = [];

  return {
    sent,
    middlewareStack: {
      add(fn: unknown, opts: { name: string }) {
        middlewares.push({ name: opts.name, fn: fn as (next: unknown, ctx: unknown) => unknown });
      },
      remove(name: string) {
        const i = middlewares.findIndex((row) => row.name === name);
        if (i >= 0) middlewares.splice(i, 1);
      },
    },
    async send(command: {
      constructor?: { name?: string };
      input?: { Bucket?: string; Key?: string };
    }) {
      const name = command.constructor?.name ?? "Unknown";
      sent.push({ name, bucket: command.input?.Bucket, key: command.input?.Key });
      const terminal = async (_args: unknown) => ({
        output: { $metadata: { httpStatusCode: 200 }, Contents: [] },
        response: { statusCode: 200, headers: { "x-amz-meta-cid": headerCid } },
      });
      let handler: (args: unknown) => Promise<unknown> = terminal;
      for (const middleware of middlewares) {
        handler = middleware.fn(handler, {}) as (args: unknown) => Promise<unknown>;
      }
      const result = (await handler({ input: command.input })) as { output: unknown };
      return result.output;
    },
  };
}

function createMockFetch() {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const fetchImpl = async (url: string | URL, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>);
    calls.push({ url: String(url), method, body });
    if (method === "GET") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [],
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        enabled: true,
        label: PLACES_LABEL,
        network_key: NETWORK_KEY,
        cid: body?.["cid"] ?? BUCKET_CID,
        sequence: 1,
        published_at: "2026-08-13T00:00:00.000Z",
        created_at: "2026-08-13T00:00:00.000Z",
        updated_at: "2026-08-13T00:00:00.000Z",
      }),
    };
  };
  return { fetchImpl, calls };
}

function fullEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    S3_ENDPOINT: "https://s3.filebase.io",
    S3_BUCKET: "elephant-oracle-open-data-lee-places",
    S3_ACCESS_KEY_ID: "FBKEY",
    S3_SECRET_ACCESS_KEY: "FBSECRET",
    FILEBASE_API_TOKEN: "FBTOKEN",
    FILEBASE_IPNS_LABEL: PLACES_LABEL,
    ...overrides,
  };
}

describe("places publish guards", () => {
  it("plans NOTICE, sibling index, and parquet under the county prefix", () => {
    expect(planPlacesUpload({ county: "lee" }).objects.map((object) => object.key)).toEqual([
      "NOTICE.txt",
      "lee/index.json",
      "lee/places-table.parquet",
    ]);
  });

  it("uses the dedicated places bucket and IPNS label", () => {
    expect(defaultPlacesBucket("lee")).toBe("elephant-oracle-open-data-lee-places");
    expect(defaultPlacesIpnsLabel("lee")).toBe("oracle-open-data-lee-places");
    expect(resolvePlacesIpnsLabel(fullEnv(), "lee")).toBe(PLACES_LABEL);
  });

  it("refuses the property dataset bucket and label", () => {
    expect(() => assertDedicatedPlacesBucket("elephant-oracle-open-data", "lee")).toThrow(
      /own Filebase bucket/,
    );
    expect(() =>
      resolvePlacesIpnsLabel(fullEnv({ FILEBASE_IPNS_LABEL: PROPERTY_LABEL }), "lee"),
    ).toThrow(/oracle-open-data-lee-places/);
    expect(propertyIpnsLabel("lee")).toBe("oracle-open-data-lee");
  });

  it("builds gateway URLs for NOTICE, index, and parquet", () => {
    const urls = buildPlacesGatewayUrls(NETWORK_KEY, "lee");
    expect(urls.filebaseNotice).toContain("/NOTICE.txt");
    expect(urls.filebaseIndex).toContain("/lee/index.json");
    expect(urls.filebaseParquet).toContain("/lee/places-table.parquet");
  });
});

describe("assertFilebaseCredentials", () => {
  it("throws naming S3_BUCKET when missing", () => {
    expect(() => assertFilebaseCredentials(fullEnv({ S3_BUCKET: undefined }))).toThrow(/S3_BUCKET/);
  });
});

describe("uploadPlacesTable", () => {
  it("does not call S3 or IPNS when credentials are missing", async () => {
    const client = createMockS3Client();
    const { fetchImpl, calls } = createMockFetch();
    await expect(
      uploadPlacesTable({
        client: asClient(client),
        fetchImpl: asFetch(fetchImpl),
        env: fullEnv({ S3_SECRET_ACCESS_KEY: undefined }),
        county: "lee",
        artifactDir: "/tmp/missing-places-publish",
      }),
    ).rejects.toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(client.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("uploads the three artifact keys then creates the places IPNS label", async () => {
    const dir = await mkdtemp(join(tmpdir(), "places-publish-"));
    try {
      await mkdir(join(dir, "lee"));
      await writeFile(join(dir, "NOTICE.txt"), "notice\n");
      await writeFile(join(dir, "lee", "index.json"), "{\"artifact\":\"places-table\"}\n");
      await writeFile(join(dir, "lee", "places-table.parquet"), Buffer.from("PAR1"));
      const client = createMockS3Client();
      const { fetchImpl, calls } = createMockFetch();
      const result = await uploadPlacesTable({
        client: asClient(client),
        fetchImpl: asFetch(fetchImpl),
        env: fullEnv(),
        county: "lee",
        artifactDir: dir,
      });
      expect(result.ipnsLabel).toBe(PLACES_LABEL);
      expect(result.ipnsName).toBe(NETWORK_KEY);
      expect(result.cid).toBe(BUCKET_CID);
      expect(client.sent.map((row) => row.key).filter(Boolean)).toEqual([
        "NOTICE.txt",
        "lee/index.json",
        "lee/places-table.parquet",
      ]);
      expect(calls.some((call) => call.method === "POST" && call.body?.["label"] === PLACES_LABEL)).toBe(
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not report success when the IPNS pointer update fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "places-publish-failure-"));
    try {
      await mkdir(join(dir, "lee"));
      await writeFile(join(dir, "NOTICE.txt"), "notice\n");
      await writeFile(join(dir, "lee", "index.json"), "{}\n");
      await writeFile(join(dir, "lee", "places-table.parquet"), Buffer.from("PAR1"));
      const client = createMockS3Client();
      const calls: string[] = [];
      const failingFetch = async (
        url: string | URL,
        init?: { method?: string },
      ) => {
        const method = init?.method ?? "GET";
        calls.push(method);
        if (method === "GET") {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => [
              {
                enabled: true,
                label: PLACES_LABEL,
                network_key: NETWORK_KEY,
                cid: "QmPreviousWorkingCid",
                sequence: 3,
                published_at: "2026-07-22T00:00:00.000Z",
                created_at: "2026-07-22T00:00:00.000Z",
                updated_at: "2026-07-22T00:00:00.000Z",
              },
            ],
          };
        }
        return {
          ok: false,
          status: 503,
          statusText: "Unavailable",
          json: async () => ({ error: "temporary failure" }),
        };
      };
      await expect(
        uploadPlacesTable({
          client: asClient(client),
          fetchImpl: asFetch(failingFetch),
          env: fullEnv(),
          county: "lee",
          artifactDir: dir,
        }),
      ).rejects.toThrow();
      expect(calls).toEqual(["GET", "PUT"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restores the previous CID after a downstream failure", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = async (
      _url: string | URL,
      init?: { method?: string; body?: string },
    ) => {
      const method = init?.method ?? "GET";
      const body =
        init?.body === undefined
          ? null
          : (JSON.parse(init.body) as Record<string, unknown>);
      requests.push({ method, body });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () =>
          method === "GET"
            ? [
                {
                  enabled: true,
                  label: PLACES_LABEL,
                  network_key: NETWORK_KEY,
                  cid: BUCKET_CID,
                  sequence: 4,
                  published_at: "2026-08-13T00:00:00.000Z",
                  created_at: "2026-07-22T00:00:00.000Z",
                  updated_at: "2026-08-13T00:00:00.000Z",
                },
              ]
            : {},
      };
    };
    await restorePlacesIpnsPointer({
      fetchImpl: asFetch(fetchImpl),
      env: fullEnv(),
      county: "lee",
      previousCid: "QmPreviousWorkingCid",
    });
    expect(requests).toEqual([
      { method: "GET", body: null },
      {
        method: "PUT",
        body: { cid: "QmPreviousWorkingCid", enabled: true },
      },
    ]);
  });
});
