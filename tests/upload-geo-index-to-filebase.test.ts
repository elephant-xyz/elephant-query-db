import { describe, expect, it } from "vitest";

/**
 * Story 3 — geo-index PUBLISH mechanics (safe, no-network).
 *
 * ALL TESTS IN THIS FILE ARE INTENTIONALLY RED.
 * `../scripts/upload-geo-index-to-filebase.js` does not exist yet, so the
 * per-test dynamic import throws and every test fails until the geo-index
 * uploader/helper is built. (Dynamic import keeps each failure a counted RED
 * rather than one uncounted collection error.)
 *
 * These tests pin the *publish mechanics* the infra validation calls for. They
 * deliberately do NOT perform any network I/O: the S3 client and the Filebase
 * IPNS REST client (fetch) are injected mocks, and credentials/labels are read
 * from an injected `env` object — never the process environment.
 *
 * ── Contract the future module MUST export ───────────────────────────────────
 *
 *   buildGeoIndexKey(county: string): string
 *     → the SINGLE object key for the derived geo index, e.g.
 *       "geo-indexes/lee/geo-index.json". Never "properties/..." or "shards/...".
 *
 *   planGeoIndexUpload(opts: { county: string }): { objects: { key: string; contentType: string }[] }
 *     → the complete list of objects this publisher will upload. For the geo
 *       index this is EXACTLY ONE object (the geo-index.json key). The existing
 *       property publisher uploads 511k property files + shards + index +
 *       manifest; this publisher must touch none of those.
 *
 *   resolveGeoIpnsLabel(env): string
 *     → resolves the geo IPNS label from FILEBASE_GEO_IPNS_LABEL (preferred) or
 *       FILEBASE_IPNS_LABEL. MUST throw if the resolved label equals
 *       "oracle-open-data-lee" (the property dataset's label) — publishing the
 *       geo index under the property pointer would clobber the property dataset.
 *
 *   assertFilebaseCredentials(env): void
 *     → throws an explicit error naming the missing variable when any required
 *       Filebase/S3 credential is absent.
 *
 *   uploadGeoIndex(opts: {
 *     client;            // injected S3-like client with .send(command)
 *     fetchImpl;         // injected fetch for the Filebase IPNS REST API
 *     env;               // injected credentials + label source
 *     county: string;
 *     body: Buffer;      // the validated local geo-index.json bytes
 *   }): Promise<{ key: string; cid: string; ipnsLabel: string; ipnsName: string }>
 *     → validates credentials FIRST (throws before any upload when missing),
 *       resolves+guards the geo IPNS label, uploads ONLY the single geo-index
 *       object, derives the single geo index CID, re-points the geo IPNS label,
 *       and records the label + resolved IPNS name. It must never upload a
 *       properties/* or shards/* key and never write the property IPNS label.
 */

const UPLOAD_MODULE = "../scripts/upload-geo-index-to-filebase.js";

const PROPERTY_LABEL = "oracle-open-data-lee";
const GEO_LABEL = "oracle-geo-index-lee";

const GEO_INDEX_BODY = Buffer.from(
  `${JSON.stringify({
    schemaVersion: "1",
    county: "lee",
    exportedAt: "2026-06-24T00:00:00.000Z",
    count: 1,
    entries: [
      {
        parcelIdentifier: "1234567890",
        requestIdentifier: "REQ-1234567890",
        folio: "0001234567",
        latitude: 26.640628,
        longitude: -81.872605,
        currentAvmValue: 350000,
        propertyType: "COMMERCIAL",
      },
    ],
  })}\n`,
  "utf8",
);

// ---------------------------------------------------------------------------
// Test doubles — no network. The S3 client records every key it is asked to
// PUT; the fetch double emulates the minimal Filebase IPNS REST surface.
// ---------------------------------------------------------------------------

type SentCommand = { readonly bucket: string | undefined; readonly key: string | undefined };

interface MockS3Client {
  readonly sent: SentCommand[];
  readonly middlewareStack: {
    add: (fn: unknown, opts: { name: string }) => void;
    remove: (name: string) => void;
  };
  send: (command: { input?: { Bucket?: string; Key?: string } }) => Promise<unknown>;
}

/**
 * A mock S3 client faithful enough to drive either CID strategy the publisher
 * might use: it records the PUT key, and — if the publisher reuses the existing
 * `x-amz-meta-cid` capture middleware — it surfaces a CID header through that
 * middleware. (The skill recommends pre-computing the CID locally with
 * ipfs-only-hash instead; both paths are supported so the test does not pin the
 * mechanism, only the observable result.)
 */
function createMockS3Client(headerCid = "QmGeoIndexHeaderCidXXXXXXXXXXXXXXXXXXXXXXXXX"): MockS3Client {
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
        handler = (m.fn(handler, {}) as (args: unknown) => Promise<unknown>);
      }

      const result = (await handler({ input })) as { output: unknown };
      return result.output;
    },
  };
}

type FetchCall = { readonly url: string; readonly method: string; readonly body: Record<string, unknown> | null };

function jsonResponse(payload: unknown): {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
} {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  };
}

/**
 * Emulates the Filebase IPNS REST API (`/v1/names`): GET list returns a BARE
 * ARRAY, POST create and PUT update return a single name object whose resolvable
 * IPNS name is the `network_key` field. Records every call so the test can
 * assert which label/CID was published and — critically — that the property
 * label is never written.
 */
function createMockFetch(networkKey = "k51qzigeoindexleenamexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx") {
  const calls: FetchCall[] = [];

  const nameObject = (label: unknown, cid: unknown) => ({
    enabled: true,
    label,
    network_key: networkKey,
    cid: cid ?? "",
    sequence: 1,
    published_at: "2026-06-24T00:00:00.000Z",
    created_at: "2026-06-24T00:00:00.000Z",
    updated_at: "2026-06-24T00:00:00.000Z",
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

    if (method === "GET") {
      return jsonResponse([]);
    }
    // POST create / PUT update both return the resulting name object.
    return jsonResponse(nameObject(body?.["label"], body?.["cid"]));
  };

  return { fetchImpl, calls };
}

function fullEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    S3_ENDPOINT: "https://s3.filebase.io",
    S3_BUCKET: "elephant-oracle-geo-index",
    S3_ACCESS_KEY_ID: "AKIA_TEST",
    S3_SECRET_ACCESS_KEY: "secret-test",
    FILEBASE_API_TOKEN: "filebase-token-test",
    FILEBASE_GEO_IPNS_LABEL: GEO_LABEL,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1 — only the single geo-index object is planned/uploaded
// ---------------------------------------------------------------------------

describe("buildGeoIndexKey / planGeoIndexUpload — single object only (AC1, red)", () => {
  it("derives a single geo-index key that is neither a properties/* nor a shards/* key", async () => {
    const { buildGeoIndexKey } = await import(UPLOAD_MODULE);
    const key = buildGeoIndexKey("lee");
    expect(key).toBe("geo-indexes/lee/geo-index.json");
    expect(key.startsWith("properties/")).toBe(false);
    expect(key.startsWith("shards/")).toBe(false);
    expect(key).not.toBe("index.json");
    expect(key).not.toBe("manifest.json");
  });

  it("plans EXACTLY one object — never the property files, shards, index or manifest", async () => {
    const { planGeoIndexUpload } = await import(UPLOAD_MODULE);
    const plan = planGeoIndexUpload({ county: "lee" });
    expect(plan.objects).toHaveLength(1);
    expect(plan.objects[0].key).toBe("geo-indexes/lee/geo-index.json");
    for (const obj of plan.objects) {
      expect(obj.key.startsWith("properties/")).toBe(false);
      expect(obj.key.startsWith("shards/")).toBe(false);
      expect(obj.key).not.toBe("index.json");
      expect(obj.key).not.toBe("manifest.json");
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — separate IPNS label; refuse the property dataset's label
// ---------------------------------------------------------------------------

describe("resolveGeoIpnsLabel — separate-label contract (AC2, red)", () => {
  it("uses FILEBASE_GEO_IPNS_LABEL when set", async () => {
    const { resolveGeoIpnsLabel } = await import(UPLOAD_MODULE);
    expect(resolveGeoIpnsLabel(fullEnv({ FILEBASE_GEO_IPNS_LABEL: GEO_LABEL }))).toBe(GEO_LABEL);
  });

  it("falls back to FILEBASE_IPNS_LABEL when the geo-specific var is unset", async () => {
    const { resolveGeoIpnsLabel } = await import(UPLOAD_MODULE);
    const env = fullEnv({ FILEBASE_GEO_IPNS_LABEL: undefined, FILEBASE_IPNS_LABEL: GEO_LABEL });
    expect(resolveGeoIpnsLabel(env)).toBe(GEO_LABEL);
  });

  it("prefers FILEBASE_GEO_IPNS_LABEL over FILEBASE_IPNS_LABEL when both are set", async () => {
    const { resolveGeoIpnsLabel } = await import(UPLOAD_MODULE);
    const env = fullEnv({ FILEBASE_GEO_IPNS_LABEL: GEO_LABEL, FILEBASE_IPNS_LABEL: "some-other-label" });
    expect(resolveGeoIpnsLabel(env)).toBe(GEO_LABEL);
  });

  it("THROWS when the resolved label equals the property dataset label oracle-open-data-lee", async () => {
    const { resolveGeoIpnsLabel } = await import(UPLOAD_MODULE);
    const env = fullEnv({ FILEBASE_GEO_IPNS_LABEL: PROPERTY_LABEL });
    expect(() => resolveGeoIpnsLabel(env)).toThrow();
  });

  it("THROWS when the property label leaks in via the fallback FILEBASE_IPNS_LABEL", async () => {
    const { resolveGeoIpnsLabel } = await import(UPLOAD_MODULE);
    const env = fullEnv({ FILEBASE_GEO_IPNS_LABEL: undefined, FILEBASE_IPNS_LABEL: PROPERTY_LABEL });
    expect(() => resolveGeoIpnsLabel(env)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC4 — missing credentials produce an explicit error before any upload
// ---------------------------------------------------------------------------

describe("assertFilebaseCredentials — explicit error before upload (AC4, red)", () => {
  it("does not throw when all required credentials are present", async () => {
    const { assertFilebaseCredentials } = await import(UPLOAD_MODULE);
    expect(() => assertFilebaseCredentials(fullEnv())).not.toThrow();
  });

  it("throws naming S3_ACCESS_KEY_ID when it is missing", async () => {
    const { assertFilebaseCredentials } = await import(UPLOAD_MODULE);
    expect(() => assertFilebaseCredentials(fullEnv({ S3_ACCESS_KEY_ID: undefined }))).toThrow(
      /S3_ACCESS_KEY_ID/,
    );
  });

  it("throws naming S3_SECRET_ACCESS_KEY when it is missing", async () => {
    const { assertFilebaseCredentials } = await import(UPLOAD_MODULE);
    expect(() => assertFilebaseCredentials(fullEnv({ S3_SECRET_ACCESS_KEY: undefined }))).toThrow(
      /S3_SECRET_ACCESS_KEY/,
    );
  });

  it("throws naming S3_BUCKET when it is missing", async () => {
    const { assertFilebaseCredentials } = await import(UPLOAD_MODULE);
    expect(() => assertFilebaseCredentials(fullEnv({ S3_BUCKET: undefined }))).toThrow(/S3_BUCKET/);
  });
});

describe("uploadGeoIndex — refuses to upload without credentials (AC4, red)", () => {
  it("rejects and never calls S3.send or the IPNS API when credentials are missing", async () => {
    const { uploadGeoIndex } = await import(UPLOAD_MODULE);
    const client = createMockS3Client();
    const { fetchImpl, calls } = createMockFetch();

    await expect(
      uploadGeoIndex({
        client,
        fetchImpl,
        env: fullEnv({ S3_SECRET_ACCESS_KEY: undefined }),
        county: "lee",
        body: GEO_INDEX_BODY,
      }),
    ).rejects.toThrow();

    expect(client.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC1 + AC3 — uploads only the single object, derives the CID, records the
// geo IPNS label/name, and never touches the property dataset.
// ---------------------------------------------------------------------------

describe("uploadGeoIndex — single-object upload + IPNS recording (AC1, AC3, red)", () => {
  it("PUTs exactly one object: the geo-index key, never properties/* or shards/*", async () => {
    const { uploadGeoIndex } = await import(UPLOAD_MODULE);
    const client = createMockS3Client();
    const { fetchImpl } = createMockFetch();

    const result = await uploadGeoIndex({
      client,
      fetchImpl,
      env: fullEnv(),
      county: "lee",
      body: GEO_INDEX_BODY,
    });

    expect(client.sent).toHaveLength(1);
    const [sentCommand] = client.sent;
    expect(sentCommand).toBeDefined();
    expect(sentCommand?.key).toBe("geo-indexes/lee/geo-index.json");
    expect(result.key).toBe("geo-indexes/lee/geo-index.json");
    for (const command of client.sent) {
      expect(command.key?.startsWith("properties/")).toBe(false);
      expect(command.key?.startsWith("shards/")).toBe(false);
      expect(command.key).not.toBe("index.json");
      expect(command.key).not.toBe("manifest.json");
    }
  });

  it("derives a single non-empty geo index CID and re-points the geo IPNS label to it", async () => {
    const { uploadGeoIndex } = await import(UPLOAD_MODULE);
    const client = createMockS3Client();
    const { fetchImpl, calls } = createMockFetch();

    const result = await uploadGeoIndex({
      client,
      fetchImpl,
      env: fullEnv(),
      county: "lee",
      body: GEO_INDEX_BODY,
    });

    expect(typeof result.cid).toBe("string");
    expect(result.cid.length).toBeGreaterThan(0);
    expect(result.ipnsLabel).toBe(GEO_LABEL);
    expect(typeof result.ipnsName).toBe("string");
    expect(result.ipnsName.length).toBeGreaterThan(0);

    // The IPNS pointer that was written must carry the geo label AND the
    // derived CID — proving the single geo CID is what we published.
    const writes = calls.filter((c) => c.method === "POST" || c.method === "PUT");
    const labelsWritten = writes.map((c) => c.body?.["name"] ?? c.body?.["label"]);
    const cidsWritten = writes.map((c) => c.body?.["cid"]);
    expect(labelsWritten).toContain(GEO_LABEL);
    expect(cidsWritten).toContain(result.cid);
  });

  it("never writes the property dataset IPNS label oracle-open-data-lee", async () => {
    const { uploadGeoIndex } = await import(UPLOAD_MODULE);
    const client = createMockS3Client();
    const { fetchImpl, calls } = createMockFetch();

    const result = await uploadGeoIndex({
      client,
      fetchImpl,
      env: fullEnv(),
      county: "lee",
      body: GEO_INDEX_BODY,
    });

    expect(result.ipnsLabel).not.toBe(PROPERTY_LABEL);
    for (const c of calls) {
      expect(c.body?.["name"]).not.toBe(PROPERTY_LABEL);
      expect(c.body?.["label"]).not.toBe(PROPERTY_LABEL);
    }
  });

  it("refuses to publish when the env would point the geo index at the property label", async () => {
    const { uploadGeoIndex } = await import(UPLOAD_MODULE);
    const client = createMockS3Client();
    const { fetchImpl, calls } = createMockFetch();

    await expect(
      uploadGeoIndex({
        client,
        fetchImpl,
        env: fullEnv({ FILEBASE_GEO_IPNS_LABEL: PROPERTY_LABEL }),
        county: "lee",
        body: GEO_INDEX_BODY,
      }),
    ).rejects.toThrow();

    // The guard must fire before any property-clobbering write reaches Filebase.
    for (const c of calls) {
      expect(c.body?.["name"]).not.toBe(PROPERTY_LABEL);
    }
  });
});
