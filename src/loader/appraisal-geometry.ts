import {
  buildSourceMetadata,
  compactObject,
  isJsonObject,
} from "./normalizers.js";
import type {
  JsonObject,
  PreparedRow,
  SourceSystem,
} from "./types.js";

export type GeometrySourceType = "MultiPolygon" | "Polygon";
export type GeometryRingRole = "exterior" | "interior";
export type GeometryPosition = readonly number[];
export type GeometryLinearRing = readonly GeometryPosition[];
export type GeometryPolygonCoordinates = readonly GeometryLinearRing[];

type SourceGeometry = {
  readonly sourceGeometryType: GeometrySourceType;
  readonly polygons: readonly GeometryPolygonCoordinates[];
};

/**
 * Build normalized child rows for every ring represented by one transformed
 * geometry component.
 *
 * The existing `geometries` row remains the compatibility projection used by
 * latitude/longitude consumers. These child rows retain the exact coordinate
 * arrays from raw GeoJSON, while `polygon_index`, `ring_index`, and
 * `source_geometry_type` preserve Polygon/MultiPolygon hierarchy.
 *
 * @param params - Transformed geometry payload, identity, and source metadata.
 * @returns Dependency-ordered ring rows that reference the existing geometry row.
 * @throws Error when raw topology is malformed or cannot be matched exactly to
 * the transformed exterior-ring projection.
 */
export function mapAppraisalGeometryRingRows(params: {
  readonly artifactUri: string | null;
  readonly fileName: string;
  readonly geometrySourceRecordKey: string;
  readonly record: JsonObject;
  readonly requestIdentifier: string;
  readonly sourceSystem: SourceSystem;
}): readonly PreparedRow[] {
  const transformedExterior = readTransformedExteriorRing(params.record);
  if (transformedExterior === null) return [];

  const rawGeometry = readNestedRawGeometry(params.record);
  const polygonIndex =
    rawGeometry === null
      ? readGeometryFileIndex(params.fileName) ?? 0
      : selectRawPolygonIndex({
          fileName: params.fileName,
          polygons: rawGeometry.polygons,
          transformedExterior,
        });
  const sourceGeometryType =
    rawGeometry?.sourceGeometryType ??
    (polygonIndex === 0 ? "Polygon" : "MultiPolygon");
  const polygon =
    rawGeometry?.polygons[polygonIndex] ?? [transformedExterior];
  if (polygon === undefined) {
    throw new Error(
      `Geometry component ${params.fileName} has no raw polygon at index ${polygonIndex}`,
    );
  }

  return polygon.map((coordinates, ringIndex) => {
    const ringRole: GeometryRingRole =
      ringIndex === 0 ? "exterior" : "interior";
    const sourcePayload = {
      coordinates,
      geometrySourceRecordKey: params.geometrySourceRecordKey,
      polygonIndex,
      ringIndex,
      ringRole,
      sourceGeometryType,
    };
    const sourceRecordKey =
      `${params.geometrySourceRecordKey}:polygon:${polygonIndex}:ring:${ringIndex}`;
    return {
      tableName: "geometry_rings",
      references: {
        geometrySourceRecordKey: params.geometrySourceRecordKey,
      },
      values: compactObject({
        ...buildSourceMetadata({
          sourceSystem: params.sourceSystem,
          sourceRecordKey,
          sourcePayload,
          sourceArtifactUri: params.artifactUri,
        }),
        coordinates,
        polygon_index: polygonIndex,
        request_identifier: params.requestIdentifier,
        ring_index: ringIndex,
        ring_role: ringRole,
        source_geometry_type: sourceGeometryType,
        source_payload: sourcePayload,
      }),
    };
  });
}

/**
 * Read the exact nested raw GeoJSON carried by the appraisal provenance
 * sidecar.
 *
 * @param record - Enriched logical geometry payload.
 * @returns Source geometry and all polygon components, or null when no nested
 * raw geometry exists.
 * @throws Error when nested source geometry is present but malformed.
 */
export function readNestedAppraisalGeometry(
  record: JsonObject,
): SourceGeometry | null {
  return readNestedRawGeometry(record);
}

/**
 * Read the flat transformed exterior ring used by the current Lexicon geometry
 * projection.
 *
 * @param record - Logical geometry payload.
 * @returns Closed longitude/latitude ring, or null when the payload has no polygon.
 * @throws Error when a polygon is present but malformed or open.
 */
export function readTransformedAppraisalExteriorRing(
  record: JsonObject,
): GeometryLinearRing | null {
  return readTransformedExteriorRing(record);
}

function readNestedRawGeometry(record: JsonObject): SourceGeometry | null {
  if (!isJsonObject(record.source_payload)) return null;
  const raw = record.source_payload;
  const parcelPolygon = raw.parcel_polygon;
  if (typeof parcelPolygon === "string" && parcelPolygon.trim().length > 0) {
    return requireSourceGeometry(
      JSON.parse(parcelPolygon) as unknown,
      "source_payload.parcel_polygon",
    );
  }
  if (isJsonObject(parcelPolygon)) {
    return requireSourceGeometry(
      parcelPolygon,
      "source_payload.parcel_polygon",
    );
  }
  if (isJsonObject(raw.response) && Array.isArray(raw.response.features)) {
    const featureGeometries = raw.response.features.flatMap((feature, index) => {
      if (!isJsonObject(feature) || !isJsonObject(feature.geometry)) return [];
      if (isEmptyGeoJsonGeometry(feature.geometry)) return [];
      const parsed = readSourceGeometry(feature.geometry);
      if (parsed === null) {
        throw new Error(
          `source_payload.response.features[${index}] contains malformed GeoJSON`,
        );
      }
      return [parsed];
    });
    if (featureGeometries.length === 0) return null;
    const polygons = featureGeometries.flatMap(
      (geometry) => geometry.polygons,
    );
    return {
      sourceGeometryType:
        featureGeometries.length === 1 &&
        featureGeometries[0]?.sourceGeometryType === "Polygon"
          ? "Polygon"
          : "MultiPolygon",
      polygons,
    };
  }
  return null;
}

function requireSourceGeometry(
  value: unknown,
  fieldName: string,
): SourceGeometry {
  const parsed = readSourceGeometry(value);
  if (parsed === null) {
    throw new Error(`${fieldName} contains malformed GeoJSON`);
  }
  return parsed;
}

function readSourceGeometry(value: unknown): SourceGeometry | null {
  if (!isJsonObject(value)) return null;
  if (value.type === "Polygon") {
    const polygon = readPolygonCoordinates(value.coordinates);
    return polygon === null
      ? null
      : { sourceGeometryType: "Polygon", polygons: [polygon] };
  }
  if (value.type !== "MultiPolygon" || !Array.isArray(value.coordinates)) {
    return null;
  }
  const polygons = value.coordinates.map((entry) =>
    readPolygonCoordinates(entry),
  );
  if (polygons.length === 0 || polygons.some((polygon) => polygon === null)) {
    return null;
  }
  return {
    sourceGeometryType: "MultiPolygon",
    polygons: polygons as GeometryPolygonCoordinates[],
  };
}

function readPolygonCoordinates(
  value: unknown,
): GeometryPolygonCoordinates | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rings = value.map((entry) => readCoordinateRing(entry));
  return rings.some((ring) => ring === null)
    ? null
    : (rings as GeometryLinearRing[]);
}

function readCoordinateRing(value: unknown): GeometryLinearRing | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const positions = value.map((entry) => readCoordinatePosition(entry));
  if (positions.some((position) => position === null)) return null;
  const ring = positions as GeometryPosition[];
  return isClosedRing(ring) ? ring : null;
}

function readCoordinatePosition(value: unknown): GeometryPosition | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const position = value.map((entry) => Number(entry));
  return position.every((entry) => Number.isFinite(entry)) ? position : null;
}

function readTransformedExteriorRing(
  record: JsonObject,
): GeometryLinearRing | null {
  if (record.polygon === undefined || record.polygon === null) return null;
  if (!Array.isArray(record.polygon) || record.polygon.length < 4) {
    throw new Error("Transformed geometry polygon is not a closed linear ring");
  }
  const positions = record.polygon.map((entry) => {
    if (Array.isArray(entry)) return readCoordinatePosition(entry);
    if (!isJsonObject(entry)) return null;
    const longitude = Number(entry.longitude);
    const latitude = Number(entry.latitude);
    return Number.isFinite(longitude) && Number.isFinite(latitude)
      ? ([longitude, latitude] as const)
      : null;
  });
  if (positions.some((position) => position === null)) {
    throw new Error("Transformed geometry polygon contains an invalid position");
  }
  const ring = positions as GeometryPosition[];
  if (!isClosedRing(ring)) {
    throw new Error("Transformed geometry polygon is not closed");
  }
  return ring;
}

function isClosedRing(ring: GeometryLinearRing): boolean {
  const first = ring[0];
  const last = ring.at(-1);
  return (
    first !== undefined &&
    last !== undefined &&
    first[0] === last[0] &&
    first[1] === last[1]
  );
}

function readGeometryFileIndex(fileName: string): number | null {
  if (fileName === "geometry.json") return 0;
  const ordinal = /^geometry_(\d+)\.json$/u.exec(fileName)?.[1];
  if (ordinal === undefined) return null;
  const parsed = Number.parseInt(ordinal, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed - 1 : null;
}

function selectRawPolygonIndex(params: {
  readonly fileName: string;
  readonly polygons: readonly GeometryPolygonCoordinates[];
  readonly transformedExterior: GeometryLinearRing;
}): number {
  const fileIndex = readGeometryFileIndex(params.fileName);
  if (
    fileIndex !== null &&
    params.polygons[fileIndex] !== undefined &&
    ringsHaveSameProjection(
      params.transformedExterior,
      params.polygons[fileIndex]?.[0],
    )
  ) {
    return fileIndex;
  }
  const matchingIndexes = params.polygons.flatMap((polygon, polygonIndex) =>
    ringsHaveSameProjection(params.transformedExterior, polygon[0])
      ? [polygonIndex]
      : [],
  );
  if (matchingIndexes.length !== 1 || matchingIndexes[0] === undefined) {
    throw new Error(
      `Geometry component ${params.fileName} matched ${matchingIndexes.length} raw polygon exteriors`,
    );
  }
  return matchingIndexes[0];
}

function ringsHaveSameProjection(
  left: GeometryLinearRing,
  right: GeometryLinearRing | undefined,
): boolean {
  if (right === undefined || left.length !== right.length) return false;
  return left.every(
    (position, index) =>
      position[0] === right[index]?.[0] &&
      position[1] === right[index]?.[1],
  );
}

function isEmptyGeoJsonGeometry(value: JsonObject): boolean {
  if (!Array.isArray(value.coordinates)) return false;
  if (value.type === "Polygon") {
    return value.coordinates.every(
      (ring) => Array.isArray(ring) && ring.length === 0,
    );
  }
  if (value.type === "MultiPolygon") {
    return value.coordinates.every(
      (polygon) =>
        Array.isArray(polygon) &&
        polygon.every(
          (ring) => Array.isArray(ring) && ring.length === 0,
        ),
    );
  }
  return false;
}
