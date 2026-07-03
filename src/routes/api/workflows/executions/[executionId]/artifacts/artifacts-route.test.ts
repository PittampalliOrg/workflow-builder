import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const body = {
		artifacts: [
			{
				id: "artifact-1",
				workflowExecutionId: "exec-1",
				nodeId: "agent",
				slot: "primary",
				kind: "markdown",
				title: "Result",
				description: null,
				inlinePayload: { markdown: "done" },
				fileId: null,
				contentType: null,
				sizeBytes: null,
				metadata: null,
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
			},
		],
	};
	type ListArtifactsResult =
		| { status: "ok"; body: typeof body }
		| { status: "error"; httpStatus: number; message: string };
	const workflowExecutionArtifacts = {
		listArtifacts: vi.fn(
			async (): Promise<ListArtifactsResult> => ({ status: "ok", body }),
		),
	};
	return { body, workflowExecutionArtifacts };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionArtifacts: mocks.workflowExecutionArtifacts,
	}),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
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

describe("workflow execution artifacts route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowExecutionArtifacts.listArtifacts.mockResolvedValue({
			status: "ok",
			body: mocks.body,
		});
	});

	it("keeps the UI-facing route behind workflow execution artifact application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionArtifacts.listArtifacts");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns artifacts through the application service", async () => {
		const response = (await GET(event() as never)) as Response;
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			artifacts: [
				{
					id: "artifact-1",
					workflowExecutionId: "exec-1",
					kind: "markdown",
					title: "Result",
				},
			],
		});
		expect(mocks.workflowExecutionArtifacts.listArtifacts).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("hides artifacts when the execution is outside the active workspace", async () => {
		mocks.workflowExecutionArtifacts.listArtifacts.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});
