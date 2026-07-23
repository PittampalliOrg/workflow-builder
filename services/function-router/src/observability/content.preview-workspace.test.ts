import { describe, expect, it } from "vitest";
import { redactDeep } from "./content.js";

describe("preview workspace trace redaction", () => {
  it("redacts receiver coordinates recursively", () => {
    expect(
      redactDeep({
        syncUrl: "http://receiver",
        nested: {
          syncCapability: "capability",
          syncToken: "token",
          kept: "value",
        },
      }),
    ).toEqual({
      syncUrl: "[REDACTED]",
      nested: {
        syncCapability: "[REDACTED]",
        syncToken: "[REDACTED]",
        kept: "value",
      },
    });
  });
});
