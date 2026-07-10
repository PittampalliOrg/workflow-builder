import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("preview control hexagonal boundary", () => {
  it("owns identity and capability contracts inside the application ports", () => {
    const controlPort = readFileSync(
      resolve(repoRoot, "src/lib/server/application/ports/preview-control.ts"),
      "utf8",
    );
    const capabilityAdapter = readFileSync(
      resolve(repoRoot, "src/lib/server/preview-control-capability.ts"),
      "utf8",
    );
    const inwardPaths = [
      "src/lib/server/application/ports/dev-previews.ts",
      "src/lib/server/application/ports/preview-artifact-transfer.ts",
      "src/lib/server/application/ports/preview-read-broker.ts",
      "src/lib/server/application/ports/preview-runtime.ts",
      "src/lib/server/application/preview-pr-adoption.ts",
    ];

    expect(controlPort).toContain("export type PreviewControlIdentity");
    expect(controlPort).toContain("export type PreviewCapabilityBundle");
    expect(capabilityAdapter).toContain(
      'from "$lib/server/application/ports/preview-control"',
    );
    for (const path of inwardPaths) {
      const source = readFileSync(resolve(repoRoot, path), "utf8");
      expect(source).not.toContain("$lib/server/preview-control-capability");
      expect(source).not.toContain("$env/");
      expect(source).not.toContain("node:crypto");
    }
  });
});
