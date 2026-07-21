import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./seed-workflows.ts", import.meta.url),
  "utf8",
);
const bundle = readFileSync(
  new URL("./seed-workflows.bundle.js", import.meta.url),
  "utf8",
);
const script = readFileSync(
  new URL(
    "./fixtures/dynamic-scripts/platform-incident-analysis.js",
    import.meta.url,
  ),
  "utf8",
);

describe("platform incident analysis seed", () => {
  it.each([source, bundle])("ships the canonical dynamic workflow", (text) => {
    expect(text).toContain("platform-incident-analysis");
    expect(text).toContain("PLATFORM_INCIDENT_ANALYSIS_WORKFLOW_ID");
    expect(text).toContain('engineType: "dynamic-script"');
  });

  it("keeps the automated agent action diagnostic-only", () => {
    expect(script).toContain("UNTRUSTED DATA");
    expect(script).toContain("Do not mutate Kubernetes resources");
    expect(script).toContain("approvalRequired");
    expect(script).not.toContain("create_pull_request");
    expect(script).not.toContain("execute_command");
  });
});
