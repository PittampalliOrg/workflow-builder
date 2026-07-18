import { afterEach, describe, expect, it, vi } from "vitest";
import { __previewTargetDevelopmentForTest } from "$lib/server/application/preview-target-development";

const { normalizeWorkflowInput } = __previewTargetDevelopmentForTest;

// Mirrors MAX_SERVICES in preview-target-development.ts. The gate accepts up to
// this many services when the flag is on and always rejects more.
const MAX_SERVICES = 16;
function serviceList(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `svc-${index}`);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("preview development multi-service gate (flag default off)", () => {
  it("accepts exactly one service", () => {
    vi.stubEnv("PREVIEW_DEV_MULTISERVICE", "");
    expect(
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder"],
      }),
    ).toMatchObject({ services: ["workflow-builder"] });
  });

  it("rejects more than one service before any dispatch when the flag is off", () => {
    vi.stubEnv("PREVIEW_DEV_MULTISERVICE", "");
    expect(() =>
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder", "function-router"],
      }),
    ).toThrow(
      "multi-service preview development is not yet supported: only 1 service may be requested (got 2)",
    );
  });

  it("treats any value other than 'true' as off", () => {
    vi.stubEnv("PREVIEW_DEV_MULTISERVICE", "1");
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
    vi.stubEnv("PREVIEW_DEV_MULTISERVICE", "");
    expect(() =>
      normalizeWorkflowInput({ intent: "x", services: [] }),
    ).toThrow("preview development workflow input is invalid");
  });
});

describe("preview development multi-service gate (flag on)", () => {
  it("accepts more than one service when the flag is enabled", () => {
    vi.stubEnv("PREVIEW_DEV_MULTISERVICE", "true");
    expect(
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder", "function-router"],
      }),
    ).toMatchObject({ services: ["workflow-builder", "function-router"] });
  });

  it("accepts up to MAX_SERVICES services", () => {
    vi.stubEnv("PREVIEW_DEV_MULTISERVICE", "true");
    const services = serviceList(MAX_SERVICES);
    expect(normalizeWorkflowInput({ intent: "x", services })).toMatchObject({
      services,
    });
  });

  it("rejects more than MAX_SERVICES services even with the flag on", () => {
    vi.stubEnv("PREVIEW_DEV_MULTISERVICE", "true");
    expect(() =>
      normalizeWorkflowInput({
        intent: "x",
        services: serviceList(MAX_SERVICES + 1),
      }),
    ).toThrow("preview development workflow input is invalid");
  });

  it("still rejects an empty service list with the flag on", () => {
    vi.stubEnv("PREVIEW_DEV_MULTISERVICE", "true");
    expect(() =>
      normalizeWorkflowInput({ intent: "x", services: [] }),
    ).toThrow("preview development workflow input is invalid");
  });

  it("still rejects a duplicated service with the flag on", () => {
    vi.stubEnv("PREVIEW_DEV_MULTISERVICE", "true");
    expect(() =>
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder", "workflow-builder"],
      }),
    ).toThrow("preview development workflow input is invalid");
  });
});

describe("preview development excluded services", () => {
  it("rejects swebench-coordinator regardless of the flag", () => {
    vi.stubEnv("PREVIEW_DEV_MULTISERVICE", "true");
    expect(() =>
      normalizeWorkflowInput({
        intent: "x",
        services: ["swebench-coordinator"],
      }),
    ).toThrow(
      "preview development does not support swebench-coordinator (not preview-native adoptable)",
    );
  });

  it("rejects swebench-coordinator inside a multi-service list", () => {
    vi.stubEnv("PREVIEW_DEV_MULTISERVICE", "true");
    expect(() =>
      normalizeWorkflowInput({
        intent: "x",
        services: ["workflow-builder", "swebench-coordinator"],
      }),
    ).toThrow(
      "preview development does not support swebench-coordinator (not preview-native adoptable)",
    );
  });
});
