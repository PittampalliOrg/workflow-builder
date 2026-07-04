import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationDefinitions: {
		list: vi.fn(async () => ({ evaluations: [{ id: "eval-1" }] })),
		create: vi.fn(async () => ({ evaluation: { id: "eval-2" } })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		evaluationDefinitions: mocks.evaluationDefinitions,
	}),
}));

import { GET, POST } from "./+server";

describe("/api/evaluations/evals route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps evaluation definition commands behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("evaluationDefinitions");
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates list and create requests", async () => {
		const getResponse = await GET({
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(getResponse.status).toBe(200);
		await expect(getResponse.json()).resolves.toEqual({
			evaluations: [{ id: "eval-1" }],
		});

		const body = { name: "Quality Gate", datasetId: "dataset-1" };
		const postResponse = await POST({
			request: new Request("http://localhost/api/evaluations/evals", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(postResponse.status).toBe(201);
		await expect(postResponse.json()).resolves.toEqual({
			evaluation: { id: "eval-2" },
		});
		expect(mocks.evaluationDefinitions.list).toHaveBeenCalledWith({
			projectId: "project-1",
		});
		expect(mocks.evaluationDefinitions.create).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			body,
		});
	});
});
