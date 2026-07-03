import { describe, expect, it, vi } from "vitest";
import { ApplicationSandboxEventsService } from "$lib/server/application/sandbox-events";
import type { SandboxAgentEventReadPort } from "$lib/server/application/ports";

describe("ApplicationSandboxEventsService", () => {
	it("delegates sandbox agent event reads through the application port", async () => {
		const events: SandboxAgentEventReadPort = {
			listSandboxAgentEvents: vi.fn(async () => [
				{
					id: 7,
					type: "tool_call_start",
					data: { toolName: "bash" },
					timestamp: "2026-07-03T00:00:00.000Z",
				},
			]),
		};
		const service = new ApplicationSandboxEventsService(events);

		await expect(
			service.listSandboxAgentEvents({
				sandboxName: "agent-host-session-1",
				afterEventId: 6,
				limit: 20,
			}),
		).resolves.toEqual([
			{
				id: 7,
				type: "tool_call_start",
				data: { toolName: "bash" },
				timestamp: "2026-07-03T00:00:00.000Z",
			},
		]);
		expect(events.listSandboxAgentEvents).toHaveBeenCalledWith({
			sandboxName: "agent-host-session-1",
			afterEventId: 6,
			limit: 20,
		});
	});
});
