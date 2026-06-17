import { createHash } from "node:crypto";

export type PermitDocumentBlobPathInput = {
  readonly permitNumber: string | null;
  readonly sourceRecordKey: string;
  readonly url: string;
  readonly extension: string;
};

/**
 * Determine whether a permit link is worth downloading into Blob storage.
 *
 * Lee Accela detail pages include navigation links and JavaScript placeholders
 * next to true document URLs. This predicate keeps the link patterns that have
 * historically represented PDFs, routed document downloads, or Accela document
 * endpoints while ignoring page chrome.
 *
 * @param url - Raw permit link URL from the `permit_links` table or source JSON.
 * @returns `true` when the URL should be attempted as a source document.
 */
export function isStorablePermitDocumentUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  if (lower.length === 0) return false;
  if (lower.startsWith("javascript:")) return false;
  if (lower.startsWith("http://") === false && lower.startsWith("https://") === false) return false;
  return (
    lower.includes(".pdf") ||
    lower.includes("urlrouting.ashx") ||
    lower.includes("digitalprojects") ||
    lower.includes("/documents/") ||
    lower.includes("showdocument") ||
    lower.includes("documentdownload")
  );
}

/**
 * Build a deterministic Vercel Blob pathname for a permit source document.
 *
 * @param input - Permit source key, original URL, optional permit number, and extension.
 * @returns Pathname under the `permit-documents/lee/` namespace.
 */
export function buildPermitDocumentBlobPathname(input: PermitDocumentBlobPathInput): string {
  const urlHash = createHash("sha256").update(input.url).digest("hex");
  const keyHash = createHash("sha256").update(input.sourceRecordKey).digest("hex").slice(0, 16);
  const permitSegment = sanitizePathSegment(input.permitNumber ?? "unknown-permit");
  const extension = sanitizeExtension(input.extension);
  return [
    "permit-documents",
    "lee",
    permitSegment,
    `${keyHash}-${urlHash.slice(0, 16)}${extension}`,
  ].join("/");
}

/**
 * Infer a document extension from an HTTP content type or URL path.
 *
 * @param params - Optional content type and original document URL.
 * @returns Extension including the leading dot.
 */
export function inferPermitDocumentExtension(params: {
  readonly contentType: string | null;
  readonly url: string;
}): string {
  const contentType = params.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (contentType === "application/pdf") return ".pdf";
  if (contentType === "image/jpeg" || contentType === "image/jpg") return ".jpg";
  if (contentType === "image/png") return ".png";
  if (contentType === "text/html") return ".html";
  try {
    const extension = /\.[a-z0-9]{2,8}$/i.exec(new URL(params.url).pathname)?.[0];
    return extension === undefined ? ".bin" : sanitizeExtension(extension);
  } catch {
    return ".bin";
  }
}

function sanitizePathSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "unknown";
}

function sanitizeExtension(extension: string): string {
  const normalized = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  return /^\.[a-z0-9]{1,8}$/.test(normalized) ? normalized : ".bin";
}
