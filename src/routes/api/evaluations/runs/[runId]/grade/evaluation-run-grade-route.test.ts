import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationRuns: {
		gradeRun: vi.fn(async () => ({ run: { id: "run-1" } })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ evaluationRuns: mocks.evaluationRuns }),
}));

import { POST } from "./+server";

describe("/api/evaluations/runs/[runId]/grade route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps grading behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("evaluationRuns.gradeRun");
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates grade requests", async () => {
		const response = await POST({
			params: { runId: "run-1" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			run: { id: "run-1" },
		});
		expect(mocks.evaluationRuns.gradeRun).toHaveBeenCalledWith({
			projectId: "project-1",
			runId: "run-1",
		});
	});
});
