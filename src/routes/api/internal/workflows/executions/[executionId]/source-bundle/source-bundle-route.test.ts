import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
	};
	const workflowData = {
		getExecutionById: vi.fn(async (): Promise<typeof execution | null> => execution),
		persistSourceBundleArtifact: vi.fn(async () => ({
			id: "artifact-1",
			fileId: "file-1",
			bytes: 12,
		})),
	};
	const requireInternal = vi.fn();
	return { execution, requireInternal, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { POST } from "./+server";

function event(body: unknown, overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		request: new Request(
			"http://localhost/api/internal/workflows/executions/exec-1/source-bundle",
			{
				method: "POST",
				body: JSON.stringify(body),
				headers: { "Content-Type": "application/json" },
			},
		),
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

describe("internal workflow execution source-bundle ingest route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.workflowData.persistSourceBundleArtifact.mockResolvedValue({
			id: "artifact-1",
			fileId: "file-1",
			bytes: 12,
		});
	});

	it("keeps source-bundle ingest behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("requireInternal");
		expect(source).toContain("workflowData.persistSourceBundleArtifact");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflowExecutions");
		expect(source).not.toContain("workflowArtifacts");
		expect(source).not.toContain("createFile");
		expect(source).not.toMatch(/import\s+\{[^}]*\bpersistSourceBundle\b/);
	});

	it("returns 404 when the execution is missing", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce(null);

		await expectHttpStatus(
			Promise.resolve(
				POST(event({ bundleBase64: Buffer.from("bundle").toString("base64") }) as never),
			),
			404,
		);
		expect(mocks.workflowData.persistSourceBundleArtifact).not.toHaveBeenCalled();
	});

	it("returns an empty result for decoded empty bytes before execution lookup", async () => {
		const response = (await POST(event({ bundleBase64: "====" }) as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, empty: true });
		expect(mocks.workflowData.getExecutionById).not.toHaveBeenCalled();
		expect(mocks.workflowData.persistSourceBundleArtifact).not.toHaveBeenCalled();
	});

	it("persists the source bundle with execution ownership and decoded bytes", async () => {
		const response = (await POST(
			event({
				bundleBase64: Buffer.from("bundle-bytes").toString("base64"),
				nodeId: "agent",
				fileName: "source.bundle",
				base: "base-sha",
				head: "head-sha",
				tier: "primary",
				clonePath: "/workspace/repo",
				fileCount: 7,
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			id: "artifact-1",
			fileId: "file-1",
			bytes: 12,
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");

		expect(mocks.workflowData.persistSourceBundleArtifact).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
				nodeId: "agent",
				fileName: "source.bundle",
				bytes: Buffer.from("bundle-bytes"),
				meta: {
					base: "base-sha",
					head: "head-sha",
					tier: "primary",
					clonePath: "/workspace/repo",
					fileCount: 7,
				},
			}),
		);
	});
});
