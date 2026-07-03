import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const body = {
		artifacts: [
			{
				id: "bwf_1",
				workflowExecutionId: "exec-1",
				workflowId: "wf-1",
				nodeId: "browser",
				artifactType: "capture_flow_v1",
				artifactVersion: 1,
				status: "completed",
				manifestJson: {},
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			},
		],
	};
	type ListArtifactsResult =
		| { status: "ok"; body: typeof body }
		| { status: "error"; httpStatus: number; message: string };
	const workflowBrowserArtifacts = {
		listArtifacts: vi.fn(
			async (): Promise<ListArtifactsResult> => ({ status: "ok", body }),
		),
	};
	return { body, workflowBrowserArtifacts };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowBrowserArtifacts: mocks.workflowBrowserArtifacts,
	}),
}));

import { GET } from "./+server";

describe("workflow execution browser artifacts route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowBrowserArtifacts.listArtifacts.mockResolvedValue({
			status: "ok",
			body: mocks.body,
		});
	});

	it("keeps the route behind workflow browser artifact application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowBrowserArtifacts.listArtifacts");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("$lib/server/browser-artifacts");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("lists browser artifacts through the application service", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			artifacts: [{ id: "bwf_1", workflowExecutionId: "exec-1" }],
		});
		expect(mocks.workflowBrowserArtifacts.listArtifacts).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("requires an authenticated session", async () => {
		await expectHttpStatus(
			Promise.resolve(GET(event({ locals: { session: null } }) as never)),
			401,
		);
		expect(mocks.workflowBrowserArtifacts.listArtifacts).not.toHaveBeenCalled();
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowBrowserArtifacts.listArtifacts.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});

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
