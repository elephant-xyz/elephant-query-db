import { createHash } from "node:crypto";

export type JsonObject = Readonly<Record<string, unknown>>;
export type GeoJsonPosition = readonly number[];
export type GeoJsonLinearRing = readonly GeoJsonPosition[];
export type GeoJsonPolygonCoordinates = readonly GeoJsonLinearRing[];
export type GeoJsonMultiPolygon = {
  readonly type: "MultiPolygon";
  readonly coordinates: readonly GeoJsonPolygonCoordinates[];
};

/**
 * Test whether a value is a JSON object.
 *
 * @param value - Candidate JSON value.
 * @returns Whether the value is a non-array object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialize JSON deterministically while preserving array order.
 *
 * @param value - JSON-compatible value.
 * @returns Canonical JSON text with recursively sorted object keys.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Value is not JSON-serializable");
  }
  return serialized;
}

/**
 * Hash a parsed source payload independently of JSON key ordering.
 *
 * @param value - Parsed JSON payload.
 * @returns Lowercase SHA-256 hexadecimal digest.
 */
export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Derive the exact loader key for a geometry sidecar.
 *
 * @param sourceSystem - County appraiser source-system key.
 * @param folio - Canonical request identifier.
 * @param entryName - ZIP entry such as data/geometry_2.json.
 * @returns Deterministic geometry source-record key.
 */
export function geometrySourceRecordKey(
  sourceSystem: string,
  folio: string,
  entryName: string,
): string {
  const fileName = entryName.split("/").at(-1);
  if (
    fileName === undefined ||
    !/^geometry(?:_\d+)?\.json$/u.test(fileName)
  ) {
    throw new Error(`Invalid geometry sidecar entry: ${entryName}`);
  }
  return `${sourceSystem}:${folio}:geometry:${fileName.replace(/\.json$/u, "")}`;
}

/**
 * Parse one coordinate pair without inventing or reordering values.
 *
 * @param value - Candidate GeoJSON position.
 * @returns Numeric longitude/latitude pair or null.
 */
function readPosition(value: unknown): GeoJsonPosition | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const position = value.map((entry) => Number(entry));
  const longitude = position[0];
  const latitude = position[1];
  return longitude !== undefined &&
    latitude !== undefined &&
    position.every((entry) => Number.isFinite(entry))
    ? position
    : null;
}

/**
 * Parse one appraiser point object.
 *
 * @param value - Candidate `{longitude, latitude}` point.
 * @returns Numeric longitude/latitude pair or null.
 */
function readPointObject(value: unknown): GeoJsonPosition | null {
  if (!isJsonObject(value)) return null;
  const longitude = Number(value.longitude);
  const latitude = Number(value.latitude);
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    ? [longitude, latitude]
    : null;
}

/**
 * Validate a complete closed GeoJSON ring.
 *
 * @param value - Candidate position array.
 * @returns Ring preserving source order, or null.
 */
function readCoordinateRing(value: unknown): GeoJsonLinearRing | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const positions = value.map((entry) => readPosition(entry));
  if (positions.some((position) => position === null)) return null;
  const ring = positions as GeoJsonPosition[];
  const first = ring[0];
  const last = ring.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    first[0] !== last[0] ||
    first[1] !== last[1]
  ) {
    return null;
  }
  return ring;
}

/**
 * Validate an appraiser ring made of point objects.
 *
 * @param value - Candidate point-object array.
 * @returns Ring preserving source order, or null.
 */
function readObjectRing(value: unknown): GeoJsonLinearRing | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const positions = value.map((entry) => readPointObject(entry));
  if (positions.some((position) => position === null)) return null;
  const ring = positions as GeoJsonPosition[];
  const first = ring[0];
  const last = ring.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    first[0] !== last[0] ||
    first[1] !== last[1]
  ) {
    return null;
  }
  return ring;
}

/**
 * Validate all rings in one GeoJSON polygon.
 *
 * @param value - Candidate polygon coordinates.
 * @returns Polygon with exterior and interior rings preserved, or null.
 */
function readPolygonCoordinates(
  value: unknown,
): GeoJsonPolygonCoordinates | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rings = value.map((entry) => readCoordinateRing(entry));
  return rings.some((ring) => ring === null)
    ? null
    : (rings as GeoJsonLinearRing[]);
}

/**
 * Read every polygon represented by one source geometry payload.
 *
 * Supports the Rock Island point-object `polygon` sidecar shape and exact
 * GeoJSON Polygon/MultiPolygon payloads, including interior rings. Open rings,
 * malformed points, and partial components fail closed rather than being
 * silently repaired.
 *
 * @param payload - Geometry source payload.
 * @returns Complete polygon list, or null for invalid/missing geometry.
 */
function readTopLevelPolygons(
  payload: unknown,
): readonly GeoJsonPolygonCoordinates[] | null {
  if (!isJsonObject(payload)) return null;
  const geoJsonCandidate = isJsonObject(payload.geometry)
    ? payload.geometry
    : payload;
  if (
    geoJsonCandidate.type === "Polygon" &&
    Array.isArray(geoJsonCandidate.coordinates)
  ) {
    const polygon = readPolygonCoordinates(geoJsonCandidate.coordinates);
    return polygon === null ? null : [polygon];
  }
  if (
    geoJsonCandidate.type === "MultiPolygon" &&
    Array.isArray(geoJsonCandidate.coordinates)
  ) {
    const polygons = geoJsonCandidate.coordinates.map((entry) =>
      readPolygonCoordinates(entry),
    );
    return polygons.some((polygon) => polygon === null)
      ? null
      : (polygons as GeoJsonPolygonCoordinates[]);
  }
  if (!Array.isArray(payload.polygon) || payload.polygon.length === 0) {
    return null;
  }
  const objectRing = readObjectRing(payload.polygon);
  if (objectRing !== null) return [[objectRing]];
  const coordinateRing = readCoordinateRing(payload.polygon);
  if (coordinateRing !== null) return [[coordinateRing]];
  const polygon = readPolygonCoordinates(payload.polygon);
  return polygon === null ? null : [polygon];
}

/**
 * Read only the transformed per-component geometry projection.
 *
 * @param payload - Logical geometry payload.
 * @returns Transformed component polygons without consulting nested raw data.
 */
export function readTransformedPolygons(
  payload: unknown,
): readonly GeoJsonPolygonCoordinates[] | null {
  return readTopLevelPolygons(payload);
}

/**
 * Read the exact raw GeoJSON retained inside a loader source_payload sidecar.
 *
 * @param payload - Enriched logical geometry payload.
 * @returns Raw source polygons, or null when no nested source geometry exists.
 */
export function readNestedRawPolygons(
  payload: unknown,
): readonly GeoJsonPolygonCoordinates[] | null {
  if (!isJsonObject(payload) || !isJsonObject(payload.source_payload)) {
    return null;
  }
  const raw = payload.source_payload;
  const parcelPolygon = raw.parcel_polygon;
  if (
    typeof parcelPolygon === "string" &&
    parcelPolygon.trim().length > 0
  ) {
    const parsed = JSON.parse(parcelPolygon) as unknown;
    const polygons = readTopLevelPolygons(parsed);
    if (polygons === null) {
      throw new Error("Nested parcel_polygon is not valid GeoJSON");
    }
    return polygons;
  }
  if (isJsonObject(parcelPolygon)) {
    const polygons = readTopLevelPolygons(parcelPolygon);
    if (polygons === null) {
      throw new Error("Nested parcel_polygon is not valid GeoJSON");
    }
    return polygons;
  }
  if (isJsonObject(raw.response) && Array.isArray(raw.response.features)) {
    const polygons = raw.response.features.flatMap((feature, index) => {
      if (!isJsonObject(feature) || !isJsonObject(feature.geometry)) return [];
      const geometryType = feature.geometry.type;
      const coordinates = feature.geometry.coordinates;
      const isEmptyPolygon =
        geometryType === "Polygon" &&
        Array.isArray(coordinates) &&
        coordinates.every(
          (ring) => Array.isArray(ring) && ring.length === 0,
        );
      const isEmptyMultiPolygon =
        geometryType === "MultiPolygon" &&
        Array.isArray(coordinates) &&
        coordinates.every(
          (polygon) =>
            Array.isArray(polygon) &&
            polygon.every(
              (ring) => Array.isArray(ring) && ring.length === 0,
            ),
        );
      if (isEmptyPolygon || isEmptyMultiPolygon) return [];
      const featurePolygons = readTopLevelPolygons(feature.geometry);
      if (featurePolygons === null) {
        const diagnosticGeometryType =
          typeof feature.geometry.type === "string"
            ? feature.geometry.type
            : "missing";
        const polygonComponents =
          diagnosticGeometryType === "MultiPolygon" && Array.isArray(coordinates)
            ? coordinates
            : diagnosticGeometryType === "Polygon" && Array.isArray(coordinates)
              ? [coordinates]
              : [];
        const ringLengths = polygonComponents.map((polygon) =>
          Array.isArray(polygon)
            ? polygon.map((ring) => (Array.isArray(ring) ? ring.length : -1))
            : [-1],
        );
        throw new Error(
          `Nested raw GeoJSON feature ${index} has invalid geometry type=${diagnosticGeometryType} ringLengths=${JSON.stringify(ringLengths)}`,
        );
      }
      return featurePolygons;
    });
    if (polygons.length > 0) return polygons;
  }
  const direct = readTopLevelPolygons(raw);
  if (direct !== null) return direct;
  return null;
}

/**
 * Read every polygon represented by one source geometry payload, preferring
 * exact nested raw provenance over the transformed component projection.
 *
 * @param payload - Geometry source payload.
 * @returns Complete polygon list, or null for invalid/missing geometry.
 */
export function readSourcePolygons(
  payload: unknown,
): readonly GeoJsonPolygonCoordinates[] | null {
  return readNestedRawPolygons(payload) ?? readTopLevelPolygons(payload);
}

/**
 * Build one county-record MultiPolygon without dropping any component.
 *
 * @param payloads - Geometry source payloads for one folio.
 * @returns Exact MultiPolygon, or null when the folio has no geometry rows.
 */
export function buildExactMultiPolygon(
  payloads: readonly unknown[],
): GeoJsonMultiPolygon | null {
  if (payloads.length === 0) return null;
  const nested = payloads
    .map((payload) => readNestedRawPolygons(payload))
    .filter(
      (
        polygons,
      ): polygons is readonly GeoJsonPolygonCoordinates[] =>
        polygons !== null,
    );
  if (nested.length > 0) {
    if (nested.length !== payloads.length) {
      throw new Error("Geometry components have inconsistent nested source_payload");
    }
    const expected = canonicalJson(nested[0]);
    if (nested.some((polygons) => canonicalJson(polygons) !== expected)) {
      throw new Error("Geometry components disagree on nested raw GeoJSON");
    }
    return { type: "MultiPolygon", coordinates: nested[0] ?? [] };
  }
  const polygons = payloads.flatMap((payload, index) => {
    const parsed = readSourcePolygons(payload);
    if (parsed === null) {
      throw new Error(`Invalid geometry source_payload at component ${index}`);
    }
    return parsed;
  });
  return { type: "MultiPolygon", coordinates: polygons };
}
