import { describe, expect, it } from "vitest";
import type { DevPreviewsResult } from "$lib/server/application/ports";
import { withDevPreviewFailureSummary } from "$lib/server/application/preview-provisioning-result";

function failedResult(
  services: DevPreviewsResult["services"],
): DevPreviewsResult {
  return { executionId: "exec-1", services, ok: false };
}

describe("withDevPreviewFailureSummary", () => {
  it("returns a successful result unchanged", () => {
    const result: DevPreviewsResult = {
      executionId: "exec-1",
      services: [],
      ok: true,
    };
    expect(withDevPreviewFailureSummary(result)).toBe(result);
  });

  it("bounds untrusted service labels and multiline failure details", () => {
    const result = withDevPreviewFailureSummary(
      failedResult([
        {
          service: `service\r\ninjected-${"x".repeat(100)}`,
          ok: false,
          error: `detail\nsecond line-${"y".repeat(300)}`,
        },
      ]),
    );
    expect(result).toHaveProperty("error");
    const error = "error" in result ? result.error : "";
    expect(error).not.toMatch(/[\r\n]/);
    expect(error.length).toBeLessThanOrEqual(1_600);
    expect(error).toContain("service injected");
    expect(error).toContain("detail second line");
  });

  it("caps the aggregate summary independently of per-field limits", () => {
    const result = withDevPreviewFailureSummary(
      failedResult(
        Array.from({ length: 5 }, (_, index) => ({
          service: `service-${index}-${"x".repeat(100)}`,
          ok: false,
          error: `failure-${index}-${"y".repeat(300)}`,
        })),
      ),
    );
    const error = "error" in result ? result.error : "";
    expect(error).toHaveLength(1_600);
  });

  it("reports at most five failed services", () => {
    const result = withDevPreviewFailureSummary(
      failedResult(
        Array.from({ length: 6 }, (_, index) => ({
          service: `service-${index + 1}`,
          ok: false,
          error: "failed",
        })),
      ),
    );
    const error = "error" in result ? result.error : "";
    expect(error).toContain("service-5");
    expect(error).not.toContain("service-6");
  });

  it("uses a stable fallback when no failed service result is present", () => {
    const result = withDevPreviewFailureSummary(failedResult([]));
    expect(result).toMatchObject({
      error: "dev-preview provision failed without a service result",
    });
  });
});
