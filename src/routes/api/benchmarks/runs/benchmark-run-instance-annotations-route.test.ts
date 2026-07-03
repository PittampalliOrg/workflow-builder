import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowDataMock = vi.hoisted(() => ({
	deleteBenchmarkRunInstanceAnnotation: vi.fn(),
	getBenchmarkRunInstanceAnnotations: vi.fn(),
	upsertBenchmarkRunInstanceAnnotation: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: workflowDataMock,
	}),
}));

import {
	DELETE,
	GET,
	POST,
} from "./[runId]/instances/[instanceId]/annotations/+server";

describe("benchmark run-instance annotations route", () => {
	beforeEach(() => {
		workflowDataMock.deleteBenchmarkRunInstanceAnnotation.mockReset();
		workflowDataMock.getBenchmarkRunInstanceAnnotations.mockReset();
		workflowDataMock.upsertBenchmarkRunInstanceAnnotation.mockReset();
	});

	it("loads annotations through workflow-data", async () => {
		const updatedAt = new Date("2026-07-03T12:00:00.000Z");
		workflowDataMock.getBenchmarkRunInstanceAnnotations.mockResolvedValue({
			status: "ok",
			mine: {
				verdict: "correct",
				reasoning: "Looks right",
				updatedAt,
			},
			counts: {
				correct: 1,
				incorrect: 0,
				partial: 0,
				unsure: 0,
			},
		});

		const response = (await GET({
			params: { runId: "run-1", instanceId: "sympy__sympy-20590" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			mine: {
				verdict: "correct",
				reasoning: "Looks right",
				updatedAt: updatedAt.toISOString(),
			},
			counts: {
				correct: 1,
				incorrect: 0,
				partial: 0,
				unsure: 0,
			},
		});
		expect(workflowDataMock.getBenchmarkRunInstanceAnnotations).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("upserts and deletes annotations through workflow-data", async () => {
		workflowDataMock.upsertBenchmarkRunInstanceAnnotation.mockResolvedValue({
			status: "ok",
		});
		workflowDataMock.deleteBenchmarkRunInstanceAnnotation.mockResolvedValue({
			status: "ok",
		});

		const postResponse = (await POST({
			request: new Request("http://localhost", {
				method: "POST",
				body: JSON.stringify({
					verdict: "partial",
					reasoning: "Needs another look",
				}),
			}),
			params: { runId: "run-1", instanceId: "sympy__sympy-20590" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never)) as Response;
		expect(postResponse.status).toBe(200);
		expect(await postResponse.json()).toEqual({ ok: true });
		expect(workflowDataMock.upsertBenchmarkRunInstanceAnnotation).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			projectId: "project-1",
			userId: "user-1",
			verdict: "partial",
			reasoning: "Needs another look",
		});

		const deleteResponse = (await DELETE({
			params: { runId: "run-1", instanceId: "sympy__sympy-20590" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never)) as Response;
		expect(deleteResponse.status).toBe(200);
		expect(await deleteResponse.json()).toEqual({ ok: true });
		expect(workflowDataMock.deleteBenchmarkRunInstanceAnnotation).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("keeps annotations route free of direct DB imports", () => {
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"[runId]/instances/[instanceId]/annotations/+server.ts",
			),
			"utf8",
		);

		expect(source).toContain("getBenchmarkRunInstanceAnnotations");
		expect(source).toContain("upsertBenchmarkRunInstanceAnnotation");
		expect(source).toContain("deleteBenchmarkRunInstanceAnnotation");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});
