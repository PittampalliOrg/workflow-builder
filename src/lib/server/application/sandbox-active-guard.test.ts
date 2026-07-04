import { describe, expect, it, vi } from "vitest";
import {
	ApplicationSandboxActiveGuardService,
	type SandboxActiveSessionGuardPort,
} from "$lib/server/application/sandbox-active-guard";

describe("ApplicationSandboxActiveGuardService", () => {
	it("delegates sandbox active-session lookup through the port", async () => {
		const port: SandboxActiveSessionGuardPort = {
			activeSessionForSandboxName: vi.fn(async () => ({
				active: true,
				scope: { projectId: "project-1", userId: "user-1" },
			})),
		};
		const service = new ApplicationSandboxActiveGuardService(port);

		await expect(
			service.activeSessionForSandboxName("sandbox-1"),
		).resolves.toEqual({
			active: true,
			scope: { projectId: "project-1", userId: "user-1" },
		});
		expect(port.activeSessionForSandboxName).toHaveBeenCalledWith("sandbox-1");
	});
});
