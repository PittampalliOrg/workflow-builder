import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowExport = {
		getExport: vi.fn(),
		saveExport: vi.fn(),
	};
	return { workflowExport };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowExport: mocks.workflowExport }),
}));

import { GET, POST } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { workflowId: "wf-1" },
		url: new URL("http://localhost/api/workflows/wf-1/export?format=json"),
		request: new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ name: "Saved workflow" }),
		}),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("workflow export route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowExport.getExport.mockResolvedValue({
			status: "json",
			body: {
				source: "export const workflow = {};",
				supportingFiles: [],
				warnings: [],
				compositionGraph: { nodes: [] },
				workflowName: "example",
				filename: "example.ts",
				language: "typescript",
			},
		});
		mocks.workflowExport.saveExport.mockResolvedValue({
			status: "ok",
			body: {
				codeFunctionId: "fn-1",
				slug: "example-workflow",
				name: "Example (workflow)",
			},
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExport");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/workflows/code-emitter");
		expect(source).not.toContain("$lib/server/code-functions");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns emitted workflow JSON", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			source: "export const workflow = {};",
			workflowName: "example",
			filename: "example.ts",
			language: "typescript",
		});
		expect(mocks.workflowExport.getExport).toHaveBeenCalledWith({
			workflowId: "wf-1",
			session: { userId: "user-1", projectId: "project-1" },
			language: null,
			inlineFunctions: null,
			format: "json",
			download: null,
		});
	});

	it("saves emitted code as a code function", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			codeFunctionId: "fn-1",
			slug: "example-workflow",
			name: "Example (workflow)",
		});
		expect(mocks.workflowExport.saveExport).toHaveBeenCalledWith({
			workflowId: "wf-1",
			session: { userId: "user-1", projectId: "project-1" },
			language: null,
			inlineFunctions: null,
			body: { name: "Saved workflow" },
		});
	});

	it("passes application service errors through as route errors", async () => {
		mocks.workflowExport.getExport.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			body: "Workflow not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});
