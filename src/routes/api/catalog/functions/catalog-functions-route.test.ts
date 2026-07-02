import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const readModel = {
		functions: [
			{
				name: "summarize",
				version: "2",
				displayName: "Summarize",
				description: "Summarize text",
				pieceName: "code-functions",
				actionName: "handler",
				sourceKind: "code",
				codeFunctionId: "code-fn-1",
				language: "typescript",
			},
		],
		count: 1,
		error: null,
	};
	const workflowData = {
		listCatalogFunctions: vi.fn(async () => readModel),
	};
	return { readModel, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

describe("catalog functions route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps catalog function reads behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.listCatalogFunctions");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("listPieceCatalogFunctions");
		expect(source).not.toContain("toCodeCatalogFunction");
		expect(source).not.toContain("codeFunctions");
	});

	it("passes session user to workflow-data and returns the read model", async () => {
		const response = (await GET({
			locals: { session: { userId: "user-1" } },
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual(mocks.readModel);
		expect(mocks.workflowData.listCatalogFunctions).toHaveBeenCalledWith({
			userId: "user-1",
		});
	});

	it("passes null user id for anonymous requests", async () => {
		const response = (await GET({
			locals: { session: null },
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual(mocks.readModel);
		expect(mocks.workflowData.listCatalogFunctions).toHaveBeenCalledWith({
			userId: null,
		});
	});
});
