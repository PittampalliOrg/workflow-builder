import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentLegacyWorkflowRuntimeCompatibilityPolicy } from "./workflow-mcp-auth";

const now = new Date("2026-07-18T20:00:00.000Z");

describe("EnvironmentLegacyWorkflowRuntimeCompatibilityPolicy", () => {
  afterEach(() => {
    delete process.env.WORKFLOW_MCP_LEGACY_RUNTIME_COMPAT_UNTIL;
  });

  it("is disabled by default and for invalid or elapsed cutoffs", () => {
    const policy = new EnvironmentLegacyWorkflowRuntimeCompatibilityPolicy(
      () => now,
    );
    expect(policy.isEnabled()).toBe(false);
    process.env.WORKFLOW_MCP_LEGACY_RUNTIME_COMPAT_UNTIL = "not-a-date";
    expect(policy.isEnabled()).toBe(false);
    process.env.WORKFLOW_MCP_LEGACY_RUNTIME_COMPAT_UNTIL =
      "2026-07-18T19:59:59.000Z";
    expect(policy.isEnabled()).toBe(false);
  });

  it("accepts only a future cutoff within the 48-hour safety bound", () => {
    const policy = new EnvironmentLegacyWorkflowRuntimeCompatibilityPolicy(
      () => now,
    );
    process.env.WORKFLOW_MCP_LEGACY_RUNTIME_COMPAT_UNTIL =
      "2026-07-19T20:00:00.000Z";
    expect(policy.isEnabled()).toBe(true);
    process.env.WORKFLOW_MCP_LEGACY_RUNTIME_COMPAT_UNTIL =
      "2026-07-21T20:00:01.000Z";
    expect(policy.isEnabled()).toBe(false);
  });
});
