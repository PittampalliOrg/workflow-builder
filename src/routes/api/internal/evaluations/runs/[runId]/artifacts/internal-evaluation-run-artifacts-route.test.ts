import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationRuns: {
		recordArtifact: vi.fn(async () => ({
			success: true,
			artifact: { id: "artifact-1" },
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

import { POST } from "./+server";

describe("/api/internal/evaluations/runs/[runId]/artifacts route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps artifact recording behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("evaluationRuns.recordArtifact");
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates artifact recording", async () => {
		const body = { kind: "logs", content: "ok" };
		const request = new Request(
			"http://localhost/api/internal/evaluations/runs/run-1/artifacts",
			{ method: "POST", body: JSON.stringify(body) },
		);
		const response = await POST({
			request,
			params: { runId: "run-1" },
		} as never);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			success: true,
			artifact: { id: "artifact-1" },
		});
		expect(mocks.requireInternal).toHaveBeenCalledWith(request);
		expect(mocks.evaluationRuns.recordArtifact).toHaveBeenCalledWith({
			runId: "run-1",
			body,
		});
	});
});
