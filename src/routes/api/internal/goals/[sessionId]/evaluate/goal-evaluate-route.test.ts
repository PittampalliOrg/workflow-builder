import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalGoalControlResult } from "$lib/server/application/internal-goal-control";

const mocks = vi.hoisted(() => ({
	internalGoalControl: {
		evaluateCompletion: vi.fn(
			async (): Promise<InternalGoalControlResult> => ({
				body: {
					met: true,
					skipped: false,
					feedback: "passed",
					results: [],
				},
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

describe("/api/internal/goals/[sessionId]/evaluate route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.internalGoalControl.evaluateCompletion.mockResolvedValue({
			body: {
				met: true,
				skipped: false,
				feedback: "passed",
				results: [],
			},
		});
	});

	it("keeps goal evaluation behavior behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("internalGoalControl.evaluateCompletion");
		expect(source).not.toContain("evaluateGoalCompletion");
		expect(source).not.toContain("markGoalComplete");
		expect(source).not.toContain("finalizeCompletedWorkflowGoal");
		expect(source).not.toContain("appendEvent");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates internal goal evaluation requests", async () => {
		const request = new Request("http://localhost", { method: "POST" });
		const response = (await POST({
			params: { sessionId: "session-1" },
			request,
		} as never)) as Response;

		expect(mocks.requireInternal).toHaveBeenCalledWith(request);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			met: true,
			skipped: false,
			feedback: "passed",
			results: [],
		});
		expect(mocks.internalGoalControl.evaluateCompletion).toHaveBeenCalledWith({
			sessionId: "session-1",
		});
	});

	it("maps application HTTP statuses", async () => {
		mocks.internalGoalControl.evaluateCompletion.mockResolvedValueOnce({
			httpStatus: 400,
			body: { met: false, feedback: "sessionId required" },
		});

		const response = (await POST({
			params: {},
			request: new Request("http://localhost", { method: "POST" }),
		} as never)) as Response;

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			met: false,
			feedback: "sessionId required",
		});
	});
});
