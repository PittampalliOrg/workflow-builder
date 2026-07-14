import { describe, expect, it } from "vitest";
import {
  getWorkflowLaunchSurface,
  workflowLaunchHref,
} from "$lib/utils/workflow-launch";

describe("workflow launch metadata", () => {
  it("routes context-launched workflows to the Dev surface", () => {
    const spec = {
      document: {
        "x-workflow-builder": {
          launch: { surface: "dev-environment" },
        },
      },
    };

    expect(getWorkflowLaunchSurface(spec)).toBe("dev-environment");
    expect(workflowLaunchHref("dev-environment", "team/workspace")).toBe(
      "/workspaces/team%2Fworkspace/dev?launch=1",
    );
  });

  it("keeps workflows without recognized metadata on generic Execute", () => {
    expect(getWorkflowLaunchSurface(null)).toBe("generic");
    expect(
      getWorkflowLaunchSurface({
        document: { "x-workflow-builder": { launch: { surface: "other" } } },
      }),
    ).toBe("generic");
    expect(workflowLaunchHref("generic", "default")).toBeNull();
  });
});
