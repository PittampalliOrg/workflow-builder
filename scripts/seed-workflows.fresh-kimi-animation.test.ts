import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./seed-workflows.ts", import.meta.url),
  "utf8",
);

describe("fresh Kimi K3 animation seed", () => {
  it("creates the new dynamic workflow without reconciling prior animation workflows", () => {
    expect(source).toContain("KIMI_K3_ANIMATION_WORKFLOW_ID");
    expect(source).toContain('engineType: "dynamic-script"');
    expect(source).not.toContain('"three-b-one-b-skill-animation"');
    expect(source).not.toContain('"three-b-one-b-skill-animation-cli"');
  });
});
