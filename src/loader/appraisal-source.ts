const SHARED_APPRAISAL_OUTPUT_PREFIXES = new Set(["outputs"]);
const TRANSFORMED_APPRAISAL_OUTPUT_FILENAME = "transformed_output.zip";

/**
 * Normalize an S3 prefix for safety checks.
 *
 * The appraisal workflow has historically written all county outputs into the
 * same top-level `outputs/` prefix. This helper strips leading/trailing slashes
 * and lowercases the value so equivalent CLI inputs are treated the same.
 *
 * @param prefix - Raw S3 prefix supplied by a CLI option or default.
 * @returns Canonical prefix text without leading or trailing slashes.
 */
export function normalizeS3PrefixForComparison(prefix: string): string {
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * Detect whether an appraisal prefix is the shared workflow output namespace.
 *
 * The shared namespace contains artifacts from multiple Florida counties, so it
 * must not be loaded into the Lee-specific query database without a separate
 * manifest or county filter.
 *
 * @param prefix - Raw S3 prefix supplied by a CLI option or default.
 * @returns True when the prefix is the unpartitioned appraisal output prefix.
 */
export function isSharedAppraisalOutputPrefix(prefix: string): boolean {
  return SHARED_APPRAISAL_OUTPUT_PREFIXES.has(normalizeS3PrefixForComparison(prefix));
}

/**
 * Assert that an appraisal staging prefix is scoped more narrowly than `outputs/`.
 *
 * @param prefix - Raw S3 prefix that would be enumerated for appraisal artifacts.
 * @throws Error when the prefix points at the shared multi-county output namespace.
 */
export function assertAppraisalPrefixIsScoped(prefix: string): void {
  if (isSharedAppraisalOutputPrefix(prefix) === false) return;
  throw new Error(
    "Refusing to stage appraisal artifacts from shared S3 prefix 'outputs/'. " +
      "That prefix contains multiple counties; provide a Lee-only appraisal manifest or scoped prefix before loading appraisal data.",
  );
}

/**
 * Build the canonical S3 URI for a transformed appraisal artifact stored under
 * one immediate child prefix.
 *
 * Older workflow outputs used child prefixes ending in `.csv/`; the curated Lee
 * appraisal pipeline writes folio-named child prefixes instead. In both cases
 * the transformed ZIP file has the same leaf filename, so discovery should
 * accept any non-empty immediate child prefix under an already scoped appraisal
 * root.
 *
 * @param params - S3 bucket name and one `ListObjectsV2` common-prefix value.
 * @param params.bucket - Bucket containing the transformed appraisal outputs.
 * @param params.commonPrefix - Immediate child prefix returned by S3, usually ending in `/`.
 * @returns Full S3 URI for the child `transformed_output.zip`, or `null` for unusable prefixes.
 */
export function buildAppraisalTransformedArtifactUri(params: {
  readonly bucket: string;
  readonly commonPrefix: string | undefined;
}): string | null {
  if (params.commonPrefix === undefined) return null;
  const normalizedPrefix = params.commonPrefix.trim().replace(/\/+$/, "");
  if (normalizedPrefix.length === 0) return null;
  const childName = normalizedPrefix.split("/").at(-1);
  if (childName === undefined || childName.length === 0) return null;
  return `s3://${params.bucket}/${normalizedPrefix}/${TRANSFORMED_APPRAISAL_OUTPUT_FILENAME}`;
}
