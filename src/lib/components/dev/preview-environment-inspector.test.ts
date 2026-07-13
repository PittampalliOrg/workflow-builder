import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("preview environment inspector boundary", () => {
  it("consumes the authorized runtime projection without importing server adapters", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "preview-environment-inspector.svelte"),
      "utf8",
    );

    expect(source).toContain("/api/dev-environments/vcluster/");
    expect(source).toContain("VclusterPreviewRuntimeView");
    expect(source).not.toContain("imageId");
    expect(source).not.toContain("resourceName");
    expect(source).not.toContain("$lib/server");
    expect(source).not.toContain("kubectl");
    expect(source).not.toContain("$lib/server/db");
  });

  it("describes unavailable workflow history without misidentifying preview deployments", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "preview-environment-inspector.svelte"),
      "utf8",
    );

    expect(source).toContain("Fleet workflow history is unavailable in this deployment.");
    expect(source).not.toContain("unavailable from this control plane");
  });
});
