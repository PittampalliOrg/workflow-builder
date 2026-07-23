import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("preview workspace hexagonal boundary", () => {
  it("keeps framework, auth, and composition concerns out of the use case", () => {
    const source = readFileSync(
      new URL("./preview-workspace.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/@sveltejs\/kit|\$app\//);
    expect(source).not.toContain("getApplicationAdapters");
    expect(source).not.toContain("internal-auth");
  });
});
