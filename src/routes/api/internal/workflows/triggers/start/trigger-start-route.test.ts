import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	triggeredWorkflowStart: {
		handleTriggerMessage: vi.fn(async () => ({ daprStatus: "SUCCESS" })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		triggeredWorkflowStart: mocks.triggeredWorkflowStart,
	}),
}));

import { POST } from "./+server";

describe("/api/internal/workflows/triggers/start route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.triggeredWorkflowStart.handleTriggerMessage.mockResolvedValue({
			daprStatus: "SUCCESS",
		});
	});

	it("keeps trigger-start behavior behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("triggeredWorkflowStart.handleTriggerMessage");
		expect(source).not.toContain("startWorkflowRun");
		expect(source).not.toContain("triggerExecutionId");
		expect(source).not.toContain("admitTriggeredRun");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates parsed trigger messages and returns Dapr SUCCESS", async () => {
		const body = { id: "ce-1", data: { workflowId: "workflow-1" } };
		const response = await POST({
			request: new Request("http://localhost/api/internal/workflows/triggers/start", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ status: "SUCCESS" });
		expect(
			mocks.triggeredWorkflowStart.handleTriggerMessage,
		).toHaveBeenCalledWith(body);
	});

	it("maps application RETRY results to Dapr RETRY", async () => {
		mocks.triggeredWorkflowStart.handleTriggerMessage.mockResolvedValueOnce({
			daprStatus: "RETRY",
		});

		const response = await POST({
			request: new Request("http://localhost/api/internal/workflows/triggers/start", {
				method: "POST",
				body: JSON.stringify({ id: "ce-1" }),
			}),
		} as never);

		await expect(response.json()).resolves.toEqual({ status: "RETRY" });
	});

	it("ACKs invalid JSON without invoking the application service", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/internal/workflows/triggers/start", {
				method: "POST",
				body: "{",
			}),
		} as never);

		await expect(response.json()).resolves.toEqual({ status: "SUCCESS" });
		expect(
			mocks.triggeredWorkflowStart.handleTriggerMessage,
		).not.toHaveBeenCalled();
	});
});
