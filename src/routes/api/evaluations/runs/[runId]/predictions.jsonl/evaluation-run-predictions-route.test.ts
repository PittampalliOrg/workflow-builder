import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationRuns: {
		buildPredictionsJsonl: vi.fn(async () => "{\"id\":\"one\"}\n"),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ evaluationRuns: mocks.evaluationRuns }),
}));

import { GET } from "./+server";

describe("/api/evaluations/runs/[runId]/predictions.jsonl route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps predictions export behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("evaluationRuns.buildPredictionsJsonl");
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates predictions export requests", async () => {
		const response = await GET({
			params: { runId: "run-1" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("{\"id\":\"one\"}\n");
		expect(response.headers.get("content-type")).toContain("application/jsonl");
		expect(mocks.evaluationRuns.buildPredictionsJsonl).toHaveBeenCalledWith({
			projectId: "project-1",
			runId: "run-1",
		});
	});
});
