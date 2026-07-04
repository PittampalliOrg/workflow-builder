import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationDatasets: {
		importRows: vi.fn(async () => ({
			rows: [{ id: "row-1" }],
			imported: 1,
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		evaluationDatasets: mocks.evaluationDatasets,
	}),
}));

import { POST } from "./+server";

describe("/api/evaluations/datasets/[datasetId]/import route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps dataset import behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("evaluationDatasets.importRows");
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates JSON import requests", async () => {
		const response = await POST({
			request: new Request(
				"http://localhost/api/evaluations/datasets/dataset-1/import",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						format: "json",
						content: "[{\"input\":{\"prompt\":\"one\"}}]",
					}),
				},
			),
			params: { datasetId: "dataset-1" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			rows: [{ id: "row-1" }],
			imported: 1,
		});
		expect(mocks.evaluationDatasets.importRows).toHaveBeenCalledWith({
			projectId: "project-1",
			datasetId: "dataset-1",
			format: "json",
			content: "[{\"input\":{\"prompt\":\"one\"}}]",
		});
	});
});
