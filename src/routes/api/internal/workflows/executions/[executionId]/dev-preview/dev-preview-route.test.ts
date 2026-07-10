import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("internal workflow execution dev-preview route", () => {
  it("resolves canonical execution ids through workflow-data", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
      "utf8",
    );

    expect(source).toContain("getApplicationAdapters");
    expect(source).toContain("workflowData.resolveCanonicalExecutionId");
    expect(source).toContain("workflowData.getExecutionById");
    expect(source).toContain("workflowData.isPlatformAdmin");
    expect(source).toContain("requirePreviewActionInternal(request)");
    expect(source).not.toContain("requireInternal(request)");
    expect(source).toContain("previewEnvironmentProvisioner.provision");
    expect(source).toContain("status: result.ok ? 200 : 503");
    expect(source).toContain("previewEnvironmentProvisioner.teardown");
    expect(source).not.toContain("$lib/server/workflows/dev-preview");
    expect(source).not.toContain("$lib/server/workflows/dev-environments");
    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toContain("drizzle-orm");
  });
});
