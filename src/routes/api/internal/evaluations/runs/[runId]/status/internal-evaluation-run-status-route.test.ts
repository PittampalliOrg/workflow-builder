import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationRuns: {
		getInternalStatus: vi.fn(async () => ({ run: { id: "run-1" } })),
		markStatus: vi.fn(async () => ({
			success: true,
			run: { id: "run-1", status: "running" },
		})),
	},
	requireInternal: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ evaluationRuns: mocks.evaluationRuns }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { GET, POST } from "./+server";

describe("/api/internal/evaluations/runs/[runId]/status route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps run status behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("evaluationRuns.getInternalStatus");
		expect(source).toContain("evaluationRuns.markStatus");
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates status reads and updates", async () => {
		const request = new Request(
			"http://localhost/api/internal/evaluations/runs/run-1/status",
			{ method: "GET" },
		);
		const getResponse = await GET({
			request,
			params: { runId: "run-1" },
		} as never);
		expect(getResponse.status).toBe(200);
		await expect(getResponse.json()).resolves.toEqual({ run: { id: "run-1" } });

		const body = { status: "running" };
		const postRequest = new Request(
			"http://localhost/api/internal/evaluations/runs/run-1/status",
			{ method: "POST", body: JSON.stringify(body) },
		);
		const postResponse = await POST({
			request: postRequest,
			params: { runId: "run-1" },
		} as never);
		expect(postResponse.status).toBe(200);
		await expect(postResponse.json()).resolves.toEqual({
			success: true,
			run: { id: "run-1", status: "running" },
		});
		expect(mocks.evaluationRuns.getInternalStatus).toHaveBeenCalledWith({
			runId: "run-1",
		});
		expect(mocks.evaluationRuns.markStatus).toHaveBeenCalledWith({
			runId: "run-1",
			body,
		});
	});
});
