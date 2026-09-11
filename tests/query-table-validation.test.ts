import { describe, expect, it } from "vitest";

import {
  parseOptions,
  validatePublishedIdentity,
} from "../scripts/validate-query-table.js";

const validIdentity = {
  state_code: "FL",
  address_street: "11659 JONATHAN RD",
  address_zip: "32225",
  elephant_uuid: "c3a982a7-1102-50b8-b2cd-6cb3fca2060f",
  elephant_token:
    "da5b90e067f162ea35eb482befaea835b32df7861adb282c6fb3983f17fa325e",
};

describe("query-table identity publication gate", () => {
  it("supports a strict completeness gate for scoped publications", () => {
    expect(
      parseOptions(["--county", "duval", "--require-complete-address-identity"])
        .requireCompleteAddressIdentity,
    ).toBe(true);
  });

  it("accepts the deterministic address:v1 pair", () => {
    expect(validatePublishedIdentity(validIdentity)).toBe("valid");
  });

  it("rejects eligible rows with missing or partial identity", () => {
    expect(
      validatePublishedIdentity({
        ...validIdentity,
        elephant_uuid: null,
        elephant_token: null,
      }),
    ).toBe("missing");
    expect(
      validatePublishedIdentity({
        ...validIdentity,
        elephant_token: null,
      }),
    ).toBe("incomplete");
  });

  it("rejects identities that disagree with the canonical address", () => {
    expect(
      validatePublishedIdentity({
        ...validIdentity,
        address_street: "11659 JONATHAN ROAD",
      }),
    ).toBe("mismatch");
  });

  it("allows incomplete canonical addresses only when identity is absent", () => {
    expect(
      validatePublishedIdentity({
        state_code: "FL",
        address_street: "123 MAIN ST",
        address_zip: null,
        elephant_uuid: null,
        elephant_token: null,
      }),
    ).toBe("ineligible");
  });
});
