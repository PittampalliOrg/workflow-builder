import { error } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requirePlatformAdmin } from "$lib/server/platform-admin";
import { deleteWorkflowActorReminders } from "$lib/server/workflow-ops";
import { POST } from "./workflow-ops/instances/[instanceId]/reminders/delete/+server";

vi.mock("$lib/server/platform-admin", () => ({
	requirePlatformAdmin: vi.fn(),
}));

vi.mock("$lib/server/workflow-ops", () => ({
	deleteWorkflowActorReminders: vi.fn(),
}));

describe("workflow-ops reminder recovery API", () => {
	beforeEach(() => {
		vi.mocked(requirePlatformAdmin).mockReset();
		vi.mocked(deleteWorkflowActorReminders).mockReset();
	});

	it("rejects unauthenticated access before deleting reminders", async () => {
		vi.mocked(requirePlatformAdmin).mockImplementationOnce(async () => {
			throw error(401, "Authentication required");
		});

		try {
			await POST({
				locals: { session: null },
				params: { instanceId: "workflow-1" },
				request: new Request("http://localhost/api/workflow-ops/instances/workflow-1/reminders/delete", {
					method: "POST",
					body: JSON.stringify({ reminderNames: ["new-event-abc"] }),
				}),
			} as never);
			throw new Error("Expected POST to reject");
		} catch (err) {
			expect(err).toMatchObject({ status: 401 });
		}
		expect(deleteWorkflowActorReminders).not.toHaveBeenCalled();
	});

	it("forwards validated admin requests to workflow ops service", async () => {
		vi.mocked(requirePlatformAdmin).mockResolvedValueOnce(undefined);
		vi.mocked(deleteWorkflowActorReminders).mockResolvedValueOnce({
			instanceId: "workflow-1",
			deleted: ["new-event-abc"],
			failed: [],
		});

		const response = (await POST({
			locals: {
				session: {
					userId: "admin-1",
					email: "admin@example.com",
					projectId: "project-1",
					platformId: "platform-1",
				},
			},
			params: { instanceId: "workflow-1" },
			request: new Request("http://localhost/api/workflow-ops/instances/workflow-1/reminders/delete", {
				method: "POST",
				body: JSON.stringify({
					reminderNames: ["new-event-abc"],
					reason: "operator recovery",
				}),
			}),
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			instanceId: "workflow-1",
			deleted: ["new-event-abc"],
		});
		expect(deleteWorkflowActorReminders).toHaveBeenCalledWith("workflow-1", {
			reminderNames: ["new-event-abc"],
			reason: "operator recovery",
		});
	});
});
