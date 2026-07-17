import { describe, expect, it } from "vitest";
import { __previewTargetDevelopmentForTest } from "$lib/server/application/preview-target-development";

const { normalizeWorkflowInput } = __previewTargetDevelopmentForTest;

describe("preview development multi-service fail-fast", () => {
  it("accepts exactly one service", () => {
    expect(
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder"],
      }),
    ).toMatchObject({ services: ["workflow-builder"] });
  });

  it("rejects more than one service before any dispatch", () => {
    expect(() =>
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder", "function-router"],
      }),
    ).toThrow(
      "multi-service preview development is not yet supported: only 1 service may be requested (got 2)",
    );
  });

  it("still rejects an empty service list with the generic validation error", () => {
    expect(() =>
      normalizeWorkflowInput({ intent: "x", services: [] }),
    ).toThrow("preview development workflow input is invalid");
  });
});
