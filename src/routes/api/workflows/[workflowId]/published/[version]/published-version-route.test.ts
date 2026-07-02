import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflow = {
		id: "wf-1",
		name: "Current",
		spec: {
			metadata: {
				publishedRuntime: {
					revisions: [
						{
							version: "pub_1",
							publishedAt: "2026-01-01T00:00:00.000Z",
							nodes: [{ id: "n1" }],
							edges: [],
							name: "First",
							description: "first version",
						},
						{
							version: "pub_2",
							publishedAt: "2026-01-02T00:00:00.000Z",
							nodes: [{ id: "n2" }],
							edges: [],
							name: "Second",
							description: "second version",
						},
					],
				},
			},
		},
	};
	const workflowData = {
		getWorkflowByRef: vi.fn(async () => workflow),
	};
	return { workflow, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
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
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
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
		expect(mocks.workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
	});

	it("returns a requested published revision", async () => {
		const response = (await GET(event({ params: { workflowId: "wf-1", version: "pub_1" } }) as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			version: "pub_1",
			definition: { name: "First" },
		});
	});

	it("returns 404 when the requested revision is missing", async () => {
		await expectHttpStatus(
			Promise.resolve(GET(event({ params: { workflowId: "wf-1", version: "missing" } }) as never)),
			404,
		);
	});
});
