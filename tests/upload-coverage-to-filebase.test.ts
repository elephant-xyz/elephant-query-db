import { describe, expect, it } from "vitest";

/**
 * Dataset-coverage PUBLISH mechanics (safe, no-network).
 *
 * These tests pin the label-guard and gateway-URL construction. They perform NO
 * network I/O: the S3 client and the Filebase IPNS REST client (fetch) are
 * injected mocks, and credentials/labels are read from an injected `env` object
 * — never the process environment.
 */

import {
  assertFilebaseCredentials,
  buildCoverageGatewayUrls,
  buildCoverageKey,
  defaultCoverageIpnsLabel,
  geoIndexIpnsLabel,
  permitTableIpnsLabel,
  propertyIpnsLabel,
  queryTableIpnsLabel,
  resolveCoverageIpnsLabel,
  uploadCoverage,
} from "../scripts/upload-coverage-to-filebase.js";

const COVERAGE_LABEL = "oracle-dataset-coverage-lee";
const PROPERTY_LABEL = "oracle-open-data-lee";
const GEO_LABEL = "oracle-geo-index-lee";
const QUERY_TABLE_LABEL = "oracle-query-table-lee";
const PERMIT_TABLE_LABEL = "oracle-permit-table-lee";
const NETWORK_KEY = "k51qzicoveragenamexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const COVERAGE_BODY = Buffer.from(
  JSON.stringify({ county: "lee", exportedAt: "2026-07-08T00:00:00Z", datasets: [] }),
  "utf8",
);

type UploadArgs = Parameters<typeof uploadCoverage>[0];
const asClient = (c: unknown): UploadArgs["client"] => c as UploadArgs["client"];
const asFetch = (f: unknown): UploadArgs["fetchImpl"] => f as UploadArgs["fetchImpl"];

type SentCommand = { readonly bucket: string | undefined; readonly key: string | undefined };

function createMockS3Client(headerCid = "QmCoverageHeaderCidXXXXXXXXXXXXXXXXXXXXXXXXX") {
  const sent: SentCommand[] = [];
  const middlewares: { name: string; fn: (next: unknown, ctx: unknown) => unknown }[] = [];

  return {
    sent,
    middlewareStack: {
      add(fn: unknown, opts: { name: string }) {
        middlewares.push({ name: opts.name, fn: fn as (next: unknown, ctx: unknown) => unknown });
      },
      remove(name: string) {
        const i = middlewares.findIndex((m) => m.name === name);
        if (i >= 0) middlewares.splice(i, 1);
      },
    },
    async send(command: { input?: { Bucket?: string; Key?: string } }) {
      const input = command.input ?? {};
      sent.push({ bucket: input.Bucket, key: input.Key });

      const terminal = async (_args: unknown) => ({
        output: { $metadata: { httpStatusCode: 200 } },
        response: { statusCode: 200, headers: { "x-amz-meta-cid": headerCid } },
      });

      let handler: (args: unknown) => Promise<unknown> = terminal;
      for (const m of middlewares) {
        handler = m.fn(handler, {}) as (args: unknown) => Promise<unknown>;
      }

      const result = (await handler({ input })) as { output: unknown };
      return result.output;
    },
  };
}

type FetchCall = { readonly url: string; readonly method: string; readonly body: Record<string, unknown> | null };

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => payload };
}

function createMockFetch(networkKey = NETWORK_KEY) {
  const calls: FetchCall[] = [];

  const nameObject = (label: unknown, cid: unknown) => ({
    enabled: true,
    label,
    network_key: networkKey,
    cid: cid ?? "",
    sequence: 1,
    published_at: "2026-07-02T00:00:00.000Z",
    created_at: "2026-07-02T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
  });

  const fetchImpl = async (url: string | URL, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    calls.push({ url: String(url), method, body });

    if (method === "GET") return jsonResponse([]);
    return jsonResponse(nameObject(body?.["label"], body?.["cid"]));
  };

  return { fetchImpl, calls };
}

function fullEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    S3_ENDPOINT: "https://s3.filebase.io",
    S3_BUCKET: "elephant-oracle-query-table",
    S3_ACCESS_KEY_ID: "AKIA_TEST",
    S3_SECRET_ACCESS_KEY: "secret-test",
    FILEBASE_API_TOKEN: "filebase-token-test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Key — single JSON object
// ---------------------------------------------------------------------------

describe("buildCoverageKey — single JSON object", () => {
  it("derives a dataset-coverage/<county>/dataset-coverage.json key", () => {
    expect(buildCoverageKey("Lee")).toBe("dataset-coverage/lee/dataset-coverage.json");
  });
});

// ---------------------------------------------------------------------------
// Label resolution + clobber guard
// ---------------------------------------------------------------------------

describe("resolveCoverageIpnsLabel — separate-label contract", () => {
  it("defaults to oracle-dataset-coverage-<county> when the override is unset", () => {
    expect(resolveCoverageIpnsLabel(fullEnv(), "lee")).toBe(COVERAGE_LABEL);
    expect(defaultCoverageIpnsLabel("lee")).toBe(COVERAGE_LABEL);
  });

  it("uses FILEBASE_COVERAGE_IPNS_LABEL when set", () => {
    const env = fullEnv({ FILEBASE_COVERAGE_IPNS_LABEL: "custom-label" });
    expect(resolveCoverageIpnsLabel(env, "lee")).toBe("custom-label");
  });

  it("THROWS when the resolved label equals the property dataset label", () => {
    expect(propertyIpnsLabel("lee")).toBe(PROPERTY_LABEL);
    const env = fullEnv({ FILEBASE_COVERAGE_IPNS_LABEL: PROPERTY_LABEL });
    expect(() => resolveCoverageIpnsLabel(env, "lee")).toThrow(/property dataset/);
  });

  it("THROWS when the resolved label equals the geo-index label", () => {
    expect(geoIndexIpnsLabel("lee")).toBe(GEO_LABEL);
    const env = fullEnv({ FILEBASE_COVERAGE_IPNS_LABEL: GEO_LABEL });
    expect(() => resolveCoverageIpnsLabel(env, "lee")).toThrow(/geo-index/);
  });

  it("THROWS when the resolved label equals the query-table label", () => {
    expect(queryTableIpnsLabel("lee")).toBe(QUERY_TABLE_LABEL);
    const env = fullEnv({ FILEBASE_COVERAGE_IPNS_LABEL: QUERY_TABLE_LABEL });
    expect(() => resolveCoverageIpnsLabel(env, "lee")).toThrow(/query-table/);
  });

  it("THROWS when the resolved label equals the permit-table label", () => {
    expect(permitTableIpnsLabel("lee")).toBe(PERMIT_TABLE_LABEL);
    const env = fullEnv({ FILEBASE_COVERAGE_IPNS_LABEL: PERMIT_TABLE_LABEL });
    expect(() => resolveCoverageIpnsLabel(env, "lee")).toThrow(/permit-table/);
  });
});

// ---------------------------------------------------------------------------
// Gateway URL construction
// ---------------------------------------------------------------------------

describe("buildCoverageGatewayUrls", () => {
  it("builds both the Filebase and dweb.link gateway forms from the network key", () => {
    const urls = buildCoverageGatewayUrls(NETWORK_KEY);
    expect(urls.filebase).toBe(`https://ipfs.filebase.io/ipns/${NETWORK_KEY}`);
    expect(urls.dweb).toBe(`https://${NETWORK_KEY}.ipns.dweb.link/`);
  });
});

// ---------------------------------------------------------------------------
// Credential gate
// ---------------------------------------------------------------------------

describe("assertFilebaseCredentials — explicit error before upload", () => {
  it("does not throw when all required credentials are present", () => {
    expect(() => assertFilebaseCredentials(fullEnv())).not.toThrow();
  });

  it("throws naming FILEBASE_API_TOKEN when it is missing", () => {
    expect(() => assertFilebaseCredentials(fullEnv({ FILEBASE_API_TOKEN: undefined }))).toThrow(
      /FILEBASE_API_TOKEN/,
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end publish (mocked network)
// ---------------------------------------------------------------------------

describe("uploadCoverage — single-object upload + IPNS recording", () => {
  it("rejects and never calls S3.send or the IPNS API when credentials are missing", async () => {
    const client = createMockS3Client();
    const { fetchImpl, calls } = createMockFetch();

    await expect(
      uploadCoverage({
        client: asClient(client),
        fetchImpl: asFetch(fetchImpl),
        env: fullEnv({ S3_SECRET_ACCESS_KEY: undefined }),
        county: "lee",
        body: COVERAGE_BODY,
      }),
    ).rejects.toThrow();

    expect(client.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("PUTs exactly one JSON object and re-points the coverage label at the derived CID", async () => {
    const client = createMockS3Client();
    const { fetchImpl, calls } = createMockFetch();

    const result = await uploadCoverage({
      client: asClient(client),
      fetchImpl: asFetch(fetchImpl),
      env: fullEnv(),
      county: "lee",
      body: COVERAGE_BODY,
    });

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.key).toBe("dataset-coverage/lee/dataset-coverage.json");
    expect(result.key).toBe("dataset-coverage/lee/dataset-coverage.json");
    expect(result.ipnsLabel).toBe(COVERAGE_LABEL);
    expect(result.ipnsName).toBe(NETWORK_KEY);
    expect(result.cid.length).toBeGreaterThan(0);
    expect(result.gatewayUrls.filebase).toBe(`https://ipfs.filebase.io/ipns/${NETWORK_KEY}`);

    const writes = calls.filter((c) => c.method === "POST" || c.method === "PUT");
    expect(writes.map((c) => c.body?.["label"])).toContain(COVERAGE_LABEL);
    expect(writes.map((c) => c.body?.["cid"])).toContain(result.cid);
  });

  it("never writes another dataset's IPNS label, and refuses a query-table-label env", async () => {
    const client = createMockS3Client();
    const { fetchImpl, calls } = createMockFetch();

    await expect(
      uploadCoverage({
        client: asClient(client),
        fetchImpl: asFetch(fetchImpl),
        env: fullEnv({ FILEBASE_COVERAGE_IPNS_LABEL: QUERY_TABLE_LABEL }),
        county: "lee",
        body: COVERAGE_BODY,
      }),
    ).rejects.toThrow();

    expect(client.sent).toHaveLength(0);
    for (const c of calls) {
      expect(c.body?.["label"]).not.toBe(QUERY_TABLE_LABEL);
      expect(c.body?.["label"]).not.toBe(PROPERTY_LABEL);
    }
  });
});
