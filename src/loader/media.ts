import { createHash } from "node:crypto";

import { readString } from "./normalizers.js";

export type LeeAppraisalMediaKind =
  | "APPRAISAL_FLOOR_PLAN"
  | "APPRAISAL_PHOTO"
  | "APPRAISAL_TAX_MAP";

export type LeeAppraisalMediaLink = {
  readonly kind: LeeAppraisalMediaKind;
  readonly url: string;
  readonly identityKey: string;
  readonly label: string;
  readonly preferredWidth: number | null;
};

export type AppraisalMediaFileRecordInput = {
  readonly blobUrl: string;
  readonly contentSha256: string;
  readonly contentType: string | null;
  readonly index: number;
  readonly link: LeeAppraisalMediaLink;
  readonly requestIdentifier: string;
  readonly sourceHttpRequest: Record<string, unknown> | null;
  readonly uploadedAt: string;
};

const LEE_APPRAISAL_BASE_URL = "https://leepa.org";
const MEDIA_ATTRIBUTE_PATTERN = /\b(?:src|href)=["'](?<url>[^"']+)["']/gi;

/**
 * Extract Lee Property Appraiser media URLs that represent useful parcel assets
 * rather than page chrome.
 *
 * The Lee page repeats the same photo/floor-plan URLs at thumbnail and large
 * widths. This helper deduplicates by the stable parcel media identity and keeps
 * the largest-width candidate so the downstream Blob upload stores the best
 * available image for the property.
 *
 * @param html - Captured DisplayParcel HTML from the downloader output ZIP.
 * @param pageUrl - Absolute page URL used to resolve relative media paths.
 * @returns Stable media links sorted by media kind and identity.
 */
export function extractLeeAppraisalMediaLinks(
  html: string,
  pageUrl = LEE_APPRAISAL_BASE_URL,
): readonly LeeAppraisalMediaLink[] {
  const candidates = new Map<string, LeeAppraisalMediaLink>();
  for (const match of html.matchAll(MEDIA_ATTRIBUTE_PATTERN)) {
    const rawUrl = match.groups?.url;
    if (rawUrl === undefined) continue;
    const link = readLeeMediaLink(rawUrl, pageUrl);
    if (link === null) continue;
    const previous = candidates.get(link.identityKey);
    if (previous === undefined || comparePreferredMedia(link, previous) > 0) {
      candidates.set(link.identityKey, link);
    }
  }
  return [...candidates.values()].sort((left, right) => {
    const kindComparison = left.kind.localeCompare(right.kind);
    return kindComparison === 0 ? left.identityKey.localeCompare(right.identityKey) : kindComparison;
  });
}

/**
 * Build the `data/file_*.json` payload used by the appraisal loader for an
 * image-like asset uploaded to Vercel Blob.
 *
 * The current logical table has `ipfs_url` as its generic stored-file URL
 * column. For this load, that value stores the Vercel Blob public URL while the
 * original county URL and Blob metadata remain preserved in `source_payload`.
 *
 * @param input - Uploaded media metadata and source media link.
 * @returns JSON object compatible with `mapAppraisalTransformedFile`.
 */
export function buildAppraisalMediaFileRecord(
  input: AppraisalMediaFileRecordInput,
): Record<string, unknown> {
  return {
    request_identifier: input.requestIdentifier,
    document_type: input.link.kind,
    file_format: input.contentType,
    ipfs_url: input.blobUrl,
    name: input.link.label,
    original_url: input.link.url,
    source_http_request: input.sourceHttpRequest,
    source_payload: {
      content_sha256: input.contentSha256,
      media_identity_key: input.link.identityKey,
      media_kind: input.link.kind,
      original_url: input.link.url,
      storage_provider: "vercel_blob",
      storage_uri: input.blobUrl,
      uploaded_at: input.uploadedAt,
    },
  };
}

/**
 * Build a deterministic Vercel Blob pathname for a property media asset.
 *
 * @param params - County media link, request identifier, and optional extension.
 * @returns Pathname under the `appraisal-media/lee/` namespace.
 */
export function buildAppraisalMediaBlobPathname(params: {
  readonly extension: string;
  readonly link: LeeAppraisalMediaLink;
  readonly requestIdentifier: string;
}): string {
  const digest = createHash("sha256").update(params.link.url).digest("hex").slice(0, 16);
  const extension = sanitizeExtension(params.extension);
  const safeIdentity = params.link.identityKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return [
    "appraisal-media",
    "lee",
    params.requestIdentifier,
    `${safeIdentity}-${digest}${extension}`,
  ].join("/");
}

/**
 * Infer a compact file extension from a response content type or URL path.
 *
 * @param params - Optional content type and original URL.
 * @returns Extension including the leading dot.
 */
export function inferMediaExtension(params: {
  readonly contentType: string | null;
  readonly url: string;
}): string {
  const contentType = params.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (contentType === "image/jpeg" || contentType === "image/jpg") return ".jpg";
  if (contentType === "image/png") return ".png";
  if (contentType === "image/gif") return ".gif";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "application/pdf") return ".pdf";
  try {
    const pathname = new URL(params.url).pathname;
    const extension = /\.[a-z0-9]{2,8}$/i.exec(pathname)?.[0];
    return extension === undefined ? ".bin" : sanitizeExtension(extension);
  } catch {
    return ".bin";
  }
}

function readLeeMediaLink(rawUrl: string, pageUrl: string): LeeAppraisalMediaLink | null {
  const url = absolutizeLeeUrl(rawUrl, pageUrl);
  if (url === null) return null;
  const parsed = new URL(url);
  const pathname = parsed.pathname.toLowerCase();
  if (pathname.endsWith("/dotnet/photo/photo.aspx")) {
    const id = readString(parsed.searchParams.get("id"));
    if (id === null) return null;
    return {
      kind: "APPRAISAL_PHOTO",
      url: parsed.toString(),
      identityKey: `photo:${id}`,
      label: `Lee appraisal photo ${id}`,
      preferredWidth: readWidth(parsed),
    };
  }
  if (pathname.endsWith("/dotnet/floorplan/floorplangenerator.aspx")) {
    const folioId = readString(parsed.searchParams.get("FolioID")) ?? "unknown";
    const buildingNo = readString(parsed.searchParams.get("BuildingNo")) ?? "unknown";
    const floorNo = readString(parsed.searchParams.get("FloorNo")) ?? "unknown";
    const taxYear = readString(parsed.searchParams.get("TaxYear")) ?? readString(parsed.searchParams.get("Current")) ?? "current";
    return {
      kind: "APPRAISAL_FLOOR_PLAN",
      url: parsed.toString(),
      identityKey: `floorplan:${folioId}:${buildingNo}:${floorNo}:${taxYear}`,
      label: `Lee appraisal floor plan building ${buildingNo} floor ${floorNo}`,
      preferredWidth: readWidth(parsed),
    };
  }
  if (pathname.endsWith("/taxmapimage/taxmapimage.aspx")) {
    const folioId = readString(parsed.searchParams.get("FolioID")) ?? "unknown";
    return {
      kind: "APPRAISAL_TAX_MAP",
      url: parsed.toString(),
      identityKey: `taxmap:${folioId}`,
      label: `Lee appraisal tax map ${folioId}`,
      preferredWidth: readWidth(parsed),
    };
  }
  return null;
}

function absolutizeLeeUrl(rawUrl: string, pageUrl: string): string | null {
  try {
    const decoded = rawUrl.replace(/&amp;/gi, "&").trim();
    const parsed = new URL(decoded, pageUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function comparePreferredMedia(left: LeeAppraisalMediaLink, right: LeeAppraisalMediaLink): number {
  return (left.preferredWidth ?? 0) - (right.preferredWidth ?? 0);
}

function readWidth(url: URL): number | null {
  const widthText = readString(url.searchParams.get("Width")) ?? readString(url.searchParams.get("w"));
  if (widthText === null) return null;
  const parsed = Number(widthText);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeExtension(extension: string): string {
  const normalized = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  return /^\.[a-z0-9]{1,8}$/.test(normalized) ? normalized : ".bin";
}
