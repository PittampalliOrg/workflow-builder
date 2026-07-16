import { describe, expect, it } from "vitest";
import {
  getWorkflowLaunchSurface,
  getWorkflowLaunchTarget,
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

	it("routes dynamic-script workflow metadata to the Dev surface", () => {
		const spec = {
			engine: "dynamic-script",
			script: "return {}",
			meta: {
				launch: { surface: "dev-environment", target: "control-plane" },
			},
		};

		expect(getWorkflowLaunchSurface(spec)).toBe("dev-environment");
		expect(getWorkflowLaunchTarget(spec)).toBe("control-plane");
	});

  it("keeps workflows without recognized metadata on generic Execute", () => {
    expect(getWorkflowLaunchSurface(null)).toBe("generic");
    expect(
      getWorkflowLaunchSurface({
        document: { "x-workflow-builder": { launch: { surface: "other" } } },
      }),
    ).toBe("generic");
		expect(
			getWorkflowLaunchSurface({
				engine: "dynamic-script",
				meta: { launch: { surface: "other" } },
			}),
		).toBe("generic");
		expect(
			getWorkflowLaunchSurface({
				engine: "dapr",
				meta: { launch: { surface: "dev-environment" } },
			}),
		).toBe("generic");
    expect(workflowLaunchHref("generic", "default")).toBeNull();
		expect(getWorkflowLaunchTarget(null)).toBe("any");
  });
});
