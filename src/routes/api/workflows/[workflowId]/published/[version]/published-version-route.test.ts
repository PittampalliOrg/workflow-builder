import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const body = {
		workflowId: "wf-1",
		version: "pub_2",
		publishedAt: "2026-01-02T00:00:00.000Z",
		definition: {
			name: "Second",
			description: "second version",
			nodes: [{ id: "n2" }],
			edges: [],
		},
		revisions: [
			{ version: "pub_1", publishedAt: "2026-01-01T00:00:00.000Z" },
			{ version: "pub_2", publishedAt: "2026-01-02T00:00:00.000Z" },
		],
	};
	const workflowDefinitionCommands = {
		getPublishedWorkflowVersion: vi.fn(),
	};
	return { body, workflowDefinitionCommands };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowDefinitionCommands: mocks.workflowDefinitionCommands,
	}),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { workflowId: "wf-1", version: "latest" },
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

describe("published workflow version route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowDefinitionCommands.getPublishedWorkflowVersion.mockResolvedValue({
			status: "ok",
			body: mocks.body,
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowDefinitionCommands.getPublishedWorkflowVersion");
		expect(source).not.toContain("publishedRuntime");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns the latest published revision", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			workflowId: "wf-1",
			version: "pub_2",
			publishedAt: "2026-01-02T00:00:00.000Z",
			definition: {
				name: "Second",
				description: "second version",
				nodes: [{ id: "n2" }],
				edges: [],
			},
			revisions: [
				{ version: "pub_1", publishedAt: "2026-01-01T00:00:00.000Z" },
				{ version: "pub_2", publishedAt: "2026-01-02T00:00:00.000Z" },
			],
		});
		expect(mocks.workflowDefinitionCommands.getPublishedWorkflowVersion).toHaveBeenCalledWith({
			workflowId: "wf-1",
			version: "latest",
		});
	});

	it("returns a requested published revision", async () => {
		mocks.workflowDefinitionCommands.getPublishedWorkflowVersion.mockResolvedValueOnce({
			status: "ok",
			body: { ...mocks.body, version: "pub_1", definition: { name: "First" } },
		});
		const response = (await GET(event({ params: { workflowId: "wf-1", version: "pub_1" } }) as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			version: "pub_1",
			definition: { name: "First" },
		});
	});

	it("returns 404 when the requested revision is missing", async () => {
		mocks.workflowDefinitionCommands.getPublishedWorkflowVersion.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			body: 'Version "missing" not found',
		});
		await expectHttpStatus(
			Promise.resolve(GET(event({ params: { workflowId: "wf-1", version: "missing" } }) as never)),
			404,
		);
	});
});
