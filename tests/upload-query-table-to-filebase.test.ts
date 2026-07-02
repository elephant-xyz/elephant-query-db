import { describe, expect, it } from "vitest";

/**
 * Query-table PUBLISH mechanics (safe, no-network).
 *
 * These tests pin the label-guard and gateway-URL construction the infra
 * validation calls for. They perform NO network I/O: the S3 client and the
 * Filebase IPNS REST client (fetch) are injected mocks, and credentials/labels
 * are read from an injected `env` object — never the process environment.
 */

import {
  assertFilebaseCredentials,
  buildQueryTableGatewayUrls,
  buildQueryTableKey,
  defaultQueryTableIpnsLabel,
  geoIndexIpnsLabel,
  planQueryTableUpload,
  propertyIpnsLabel,
  resolveQueryTableIpnsLabel,
  uploadQueryTable,
} from "../scripts/upload-query-table-to-filebase.js";

const QUERY_TABLE_LABEL = "oracle-query-table-lee";
const PROPERTY_LABEL = "oracle-open-data-lee";
const GEO_LABEL = "oracle-geo-index-lee";
const NETWORK_KEY = "k51qzitablleenamexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const PARQUET_BODY = Buffer.from("PAR1-fake-parquet-bytes-for-cid-derivation", "utf8");

// The mocks are structural stand-ins for the AWS S3 client / global fetch; cast
// them to the exact parameter types so the (statically typed) call sites accept
// them without pulling in the SDK's full MiddlewareStack surface.
type UploadArgs = Parameters<typeof uploadQueryTable>[0];
const asClient = (c: unknown): UploadArgs["client"] => c as UploadArgs["client"];
const asFetch = (f: unknown): UploadArgs["fetchImpl"] => f as UploadArgs["fetchImpl"];

// ---------------------------------------------------------------------------
// Test doubles — no network.
// ---------------------------------------------------------------------------

type SentCommand = { readonly bucket: string | undefined; readonly key: string | undefined };

function createMockS3Client(headerCid = "QmQueryTableHeaderCidXXXXXXXXXXXXXXXXXXXXXXX") {
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
// Key + plan — single object only
// ---------------------------------------------------------------------------

describe("buildQueryTableKey / planQueryTableUpload — single object only", () => {
  it("derives a single query-table key that is neither a properties/* nor a shards/* key", () => {
    const key = buildQueryTableKey("Lee");
    expect(key).toBe("query-tables/lee/query-table.parquet");
    expect(key.startsWith("properties/")).toBe(false);
    expect(key.startsWith("shards/")).toBe(false);
    expect(key).not.toBe("index.json");
    expect(key).not.toBe("manifest.json");
  });

  it("plans EXACTLY one object — never the property files, shards, index or manifest", () => {
    const plan = planQueryTableUpload({ county: "lee" });
    expect(plan.objects).toHaveLength(1);
    expect(plan.objects[0]?.key).toBe("query-tables/lee/query-table.parquet");
  });
});

// ---------------------------------------------------------------------------
// Label resolution + clobber guard
// ---------------------------------------------------------------------------

describe("resolveQueryTableIpnsLabel — separate-label contract", () => {
  it("defaults to oracle-query-table-<county> when the override is unset", () => {
    expect(resolveQueryTableIpnsLabel(fullEnv(), "lee")).toBe(QUERY_TABLE_LABEL);
    expect(defaultQueryTableIpnsLabel("lee")).toBe(QUERY_TABLE_LABEL);
  });

  it("uses FILEBASE_QUERY_TABLE_IPNS_LABEL when set", () => {
    const env = fullEnv({ FILEBASE_QUERY_TABLE_IPNS_LABEL: "custom-label" });
    expect(resolveQueryTableIpnsLabel(env, "lee")).toBe("custom-label");
  });

  it("THROWS when the resolved label equals the property dataset label", () => {
    expect(propertyIpnsLabel("lee")).toBe(PROPERTY_LABEL);
    const env = fullEnv({ FILEBASE_QUERY_TABLE_IPNS_LABEL: PROPERTY_LABEL });
    expect(() => resolveQueryTableIpnsLabel(env, "lee")).toThrow(/property dataset label/);
  });

  it("THROWS when the resolved label equals the geo-index label", () => {
    expect(geoIndexIpnsLabel("lee")).toBe(GEO_LABEL);
    const env = fullEnv({ FILEBASE_QUERY_TABLE_IPNS_LABEL: GEO_LABEL });
    expect(() => resolveQueryTableIpnsLabel(env, "lee")).toThrow(/geo-index label/);
  });
});

// ---------------------------------------------------------------------------
// Gateway URL construction
// ---------------------------------------------------------------------------

describe("buildQueryTableGatewayUrls", () => {
  it("builds both the Filebase and dweb.link gateway forms from the network key", () => {
    const urls = buildQueryTableGatewayUrls(NETWORK_KEY);
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

  it("throws naming S3_BUCKET when it is missing", () => {
    expect(() => assertFilebaseCredentials(fullEnv({ S3_BUCKET: undefined }))).toThrow(/S3_BUCKET/);
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

describe("uploadQueryTable — single-object upload + IPNS recording", () => {
  it("rejects and never calls S3.send or the IPNS API when credentials are missing", async () => {
    const client = createMockS3Client();
    const { fetchImpl, calls } = createMockFetch();

    await expect(
      uploadQueryTable({
        client: asClient(client),
        fetchImpl: asFetch(fetchImpl),
        env: fullEnv({ S3_SECRET_ACCESS_KEY: undefined }),
        county: "lee",
        body: PARQUET_BODY,
      }),
    ).rejects.toThrow();

    expect(client.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("PUTs exactly one object and re-points the query-table label at the derived CID", async () => {
    const client = createMockS3Client();
    const { fetchImpl, calls } = createMockFetch();

    const result = await uploadQueryTable({
      client: asClient(client),
      fetchImpl: asFetch(fetchImpl),
      env: fullEnv(),
      county: "lee",
      body: PARQUET_BODY,
    });

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.key).toBe("query-tables/lee/query-table.parquet");
    expect(result.key).toBe("query-tables/lee/query-table.parquet");
    expect(result.ipnsLabel).toBe(QUERY_TABLE_LABEL);
    expect(result.ipnsName).toBe(NETWORK_KEY);
    expect(result.cid.length).toBeGreaterThan(0);
    expect(result.gatewayUrls.filebase).toBe(`https://ipfs.filebase.io/ipns/${NETWORK_KEY}`);

    const writes = calls.filter((c) => c.method === "POST" || c.method === "PUT");
    expect(writes.map((c) => c.body?.["label"])).toContain(QUERY_TABLE_LABEL);
    expect(writes.map((c) => c.body?.["cid"])).toContain(result.cid);
  });

  it("never writes the property or geo IPNS label, and refuses a property-label env", async () => {
    const client = createMockS3Client();
    const { fetchImpl, calls } = createMockFetch();

    await expect(
      uploadQueryTable({
        client: asClient(client),
        fetchImpl: asFetch(fetchImpl),
        env: fullEnv({ FILEBASE_QUERY_TABLE_IPNS_LABEL: PROPERTY_LABEL }),
        county: "lee",
        body: PARQUET_BODY,
      }),
    ).rejects.toThrow();

    expect(client.sent).toHaveLength(0);
    for (const c of calls) {
      expect(c.body?.["label"]).not.toBe(PROPERTY_LABEL);
      expect(c.body?.["label"]).not.toBe(GEO_LABEL);
    }
  });
});
