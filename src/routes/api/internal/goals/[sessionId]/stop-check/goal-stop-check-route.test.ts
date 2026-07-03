import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalGoalControlResult } from "$lib/server/application/internal-goal-control";

const mocks = vi.hoisted(() => ({
	internalGoalControl: {
		stopCheck: vi.fn(
			async (): Promise<InternalGoalControlResult> => ({
				body: { goalStatus: "active" },
			}),
		),
	},
	requireInternal: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		internalGoalControl: mocks.internalGoalControl,
	}),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { POST } from "./+server";

describe("/api/internal/goals/[sessionId]/stop-check route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.internalGoalControl.stopCheck.mockResolvedValue({
			body: { goalStatus: "active" },
		});
	});

	it("keeps stop-check behavior behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("internalGoalControl.stopCheck");
		expect(source).not.toContain("kickGoalLoop");
		expect(source).not.toContain("getCurrentGoal");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates stop-hook checks and maps HTTP status", async () => {
		const request = new Request("http://localhost", { method: "POST" });
		const response = (await POST({
			params: { sessionId: "session-1" },
			request,
		} as never)) as Response;

		expect(mocks.requireInternal).toHaveBeenCalledWith(request);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ goalStatus: "active" });
		expect(mocks.internalGoalControl.stopCheck).toHaveBeenCalledWith({
			sessionId: "session-1",
		});

		mocks.internalGoalControl.stopCheck.mockResolvedValueOnce({
			httpStatus: 400,
			body: { error: "sessionId required" },
		});
		const missing = (await POST({
			params: {},
			request,
		} as never)) as Response;
		expect(missing.status).toBe(400);
		await expect(missing.json()).resolves.toEqual({
			error: "sessionId required",
		});
	});
});
