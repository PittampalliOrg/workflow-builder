import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationDatasets: {
		list: vi.fn(async () => ({ datasets: [{ id: "dataset-1" }] })),
		create: vi.fn(async () => ({ dataset: { id: "dataset-2" } })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		evaluationDatasets: mocks.evaluationDatasets,
	}),
}));

import { GET, POST } from "./+server";

describe("/api/evaluations/datasets route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps dataset CRUD behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("evaluationDatasets");
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
			datasets: [{ id: "dataset-1" }],
		});

		const body = { name: "Dataset" };
		const postResponse = await POST({
			request: new Request("http://localhost/api/evaluations/datasets", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(postResponse.status).toBe(201);
		await expect(postResponse.json()).resolves.toEqual({
			dataset: { id: "dataset-2" },
		});
		expect(mocks.evaluationDatasets.list).toHaveBeenCalledWith({
			projectId: "project-1",
		});
		expect(mocks.evaluationDatasets.create).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			body,
		});
	});
});
