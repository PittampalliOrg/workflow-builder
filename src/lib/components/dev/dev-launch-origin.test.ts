import { describe, expect, it } from "vitest";
import { resolvePreviewLaunchOrigin } from "$lib/components/dev/dev-launch-origin";

describe("resolvePreviewLaunchOrigin", () => {
  it("uses the current browser origin instead of stale server configuration", () => {
    expect(
      resolvePreviewLaunchOrigin(
        "https://workflow-builder-ryzen.example.test",
        "https://wfb-app-live-c478-0712a.example.test",
      ),
    ).toBe("https://wfb-app-live-c478-0712a.example.test");
  });

  it("retains the configured origin as a non-browser fallback", () => {
    expect(
      resolvePreviewLaunchOrigin(
        " https://workflow-builder-ryzen.example.test ",
        null,
      ),
    ).toBe("https://workflow-builder-ryzen.example.test");
  });
});
