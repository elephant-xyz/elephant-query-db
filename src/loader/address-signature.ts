import { createHash } from "node:crypto";

/**
 * OpenDoor / Elephant `address:v1` identity.
 *
 * Any change to these rules (ZIP5, field order, lowercase, etc.) MUST bump
 * the signature version to `address:v2`. Do not call `normalizeAddressText` —
 * that helper expands ROAD→RD and NORTH→N, which this contract forbids.
 */
export const ADDRESS_SIGNATURE_VERSION = "v1";
export const ELEPHANT_ADDRESS_UUID_NAMESPACE =
  "47541537-6230-5494-bf31-221c5f53ccd5";
export const ADDRESS_SIGNATURE_DEFAULT_COUNTRY = "us";

export type AddressSignatureInput = {
  readonly country?: string | null;
  readonly state: string | null | undefined;
  readonly postalCode: string | null | undefined;
  readonly street: string | null | undefined;
  readonly unit?: string | null;
};

export type AddressIdentity = {
  readonly signature: string;
  readonly elephantToken: string;
  readonly elephantUuid: string;
};

export type ParsedUnnormalizedAddress = {
  readonly street: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
};

const TRAILING_STATE_ZIP_RE = /\b[A-Za-z]{2}\s+(\d{5})(?:-\d{4})?\s*$/;
const TRAILING_ZIP_RE = /\b(\d{5})(?:-\d{4})?\s*$/;

function normalizeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizePostalCode(value: unknown): string | null {
  const stripped = normalizeField(value).replace(/[-\s]/g, "");
  const digits = stripped.replace(/\D/g, "");
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

function serializePart(name: string, value: string): string {
  return `${name}:${Buffer.byteLength(value, "utf8")}:${value}`;
}

function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  if (namespaceBytes.byteLength !== 16) {
    throw new Error("UUID namespace must contain exactly 16 bytes");
  }
  const digest = createHash("sha1")
    .update(namespaceBytes)
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Split a free-text US address into the fields required by `address:v1`.
 * State is deliberately excluded: callers must use authoritative jurisdiction
 * metadata instead of trusting a possibly stale state token in source text.
 */
export function parseUnnormalizedAddress(
  value: string | null | undefined,
): ParsedUnnormalizedAddress {
  const empty: ParsedUnnormalizedAddress = {
    street: null,
    city: null,
    postalCode: null,
  };
  if (value === null || value === undefined) return empty;
  const trimmed = value.trim();
  if (trimmed.length === 0) return empty;

  const segments = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (segments.length === 0) return empty;

  let postalCode: string | null = null;
  const last = segments[segments.length - 1] ?? "";
  const stateZip = TRAILING_STATE_ZIP_RE.exec(last);
  const zipOnly = TRAILING_ZIP_RE.exec(last);
  if (stateZip?.[1] !== undefined) {
    postalCode = stateZip[1];
    const head = last.replace(TRAILING_STATE_ZIP_RE, "").trim();
    if (head.length > 0) segments[segments.length - 1] = head;
    else segments.pop();
  } else if (zipOnly?.[1] !== undefined) {
    postalCode = zipOnly[1];
    const head = last.replace(TRAILING_ZIP_RE, "").trim();
    if (head.length > 0) segments[segments.length - 1] = head;
    else segments.pop();
  }

  const street = segments[0] ?? null;
  const cityParts = segments.slice(1);
  const city = cityParts.length > 0 ? cityParts.join(", ") : null;
  return { street, city, postalCode };
}

/**
 * Mint identity for a **situs** (property-location) address.
 *
 * Always serializes an empty unit. Oracle `addresses.unit_identifier` is the
 * owner-mailing unit and must not be mixed with situs street/ZIP — that chimera
 * would disagree with consolidated JSON (which hashes the mailing row) and
 * with the published query-table street/ZIP.
 */
export function mintSitusAddressIdentity(input: {
  readonly state: string | null | undefined;
  readonly postalCode: string | null | undefined;
  readonly street: string | null | undefined;
}): AddressIdentity | null {
  return mintAddressIdentity({
    country: ADDRESS_SIGNATURE_DEFAULT_COUNTRY,
    state: input.state,
    postalCode: input.postalCode,
    street: input.street,
    unit: null,
  });
}

/**
 * Build the canonical `address:v1` signature and derived ids.
 * Returns `null` when country, state, postal_code (ZIP5), or street is empty.
 * Does not mutate `input`.
 *
 * Callers must pass street, postal, and unit from the **same** address.
 * For query-table / Hillsborough situs rows, use `mintSitusAddressIdentity`.
 */
export function mintAddressIdentity(
  input: AddressSignatureInput,
): AddressIdentity | null {
  const country = normalizeField(
    input.country ?? ADDRESS_SIGNATURE_DEFAULT_COUNTRY,
  );
  const state = normalizeField(input.state);
  const street = normalizeField(input.street);
  const unit = normalizeField(input.unit ?? "");
  const postalCode = normalizePostalCode(input.postalCode);
  if (
    country.length === 0 ||
    state.length === 0 ||
    postalCode === null ||
    street.length === 0
  ) {
    return null;
  }

  const signature = [
    `address:${ADDRESS_SIGNATURE_VERSION}`,
    serializePart("country", country),
    serializePart("state", state),
    serializePart("postal_code", postalCode),
    serializePart("street", street),
    serializePart("unit", unit),
  ].join("|");

  return {
    signature,
    elephantToken: createHash("sha256")
      .update(signature, "utf8")
      .digest("hex"),
    elephantUuid: uuidV5(signature, ELEPHANT_ADDRESS_UUID_NAMESPACE),
  };
}
