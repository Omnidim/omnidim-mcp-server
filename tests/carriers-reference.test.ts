import { describe, it, expect } from "vitest";
import { RESOURCE_URIS, getResourceText } from "../src/procedures.js";

// `carrier` is required on searchPhoneNumbers and purchasePhoneNumber and has
// no enum, and this server validates the tool schema before the call leaves,
// so the `409 carrier_required` body that lists the valid values never comes
// back. This resource is the only place an agent here can learn them. A spec
// regen that rewords the tool description cannot restore it, which is exactly
// how the values went missing once.
describe("the carriers reference", () => {
  it("is registered", () => {
    expect(RESOURCE_URIS).toContain("omnidim://reference/carriers");
  });

  it("names every carrier an agent can be asked to buy from", () => {
    const text = getResourceText("omnidim://reference/carriers") ?? "";
    for (const value of ["carrier-1", "carrier-2-new", "carrier-us"]) {
      expect(text, `missing ${value}`).toContain(value);
    }
  });

  it("is pointed at from the routing guide", () => {
    expect(getResourceText("omnidim://guide/routing")).toContain(
      "omnidim://reference/carriers",
    );
  });
});
