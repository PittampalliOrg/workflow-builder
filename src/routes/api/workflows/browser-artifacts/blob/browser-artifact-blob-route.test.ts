import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowBrowserArtifacts = {
		getAsset: vi.fn(async () => ({
			status: "ok" as const,
			body: {
				storageRef: "ref-1",
				payloadBase64: "aGVsbG8=",
				contentType: "image/png",
				sizeBytes: 5,
			},
		})),
	};
	return { workflowBrowserArtifacts };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowBrowserArtifacts: mocks.workflowBrowserArtifacts,
	}),
}));

import { GET } from "./+server";

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("workflow browser artifact blob route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowBrowserArtifacts.getAsset.mockResolvedValue({
			status: "ok",
			body: {
				storageRef: "ref-1",
				payloadBase64: "aGVsbG8=",
				contentType: "image/png",
				sizeBytes: 5,
			},
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowBrowserArtifacts.getAsset");
		expect(source).not.toContain("$lib/server/browser-artifacts");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("streams browser artifact blob payloads", async () => {
		const response = (await GET({
			url: new URL("http://test/blob?executionId=exec-1&storageRef=ref-1"),
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never)) as Response;

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("hello");
		expect(mocks.workflowBrowserArtifacts.getAsset).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			storageRef: "ref-1",
			maxBytes: 50 * 1024 * 1024,
		});
	});

	it("404s when the scoped application service rejects the asset", async () => {
		mocks.workflowBrowserArtifacts.getAsset.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Browser artifact not found",
		} as never);

		await expectHttpStatus(
			Promise.resolve(
				GET({
					url: new URL("http://test/blob?executionId=exec-1&storageRef=ref-1"),
					locals: { session: { userId: "user-1", projectId: "project-1" } },
				} as never),
			),
			404,
		);
	});

	it("requires an authenticated user before resolving a storage ref", async () => {
		await expectHttpStatus(
			Promise.resolve(
				GET({
					url: new URL("http://test/blob?executionId=exec-1&storageRef=ref-1"),
					locals: {},
				} as never),
			),
			401,
		);
		expect(mocks.workflowBrowserArtifacts.getAsset).not.toHaveBeenCalled();
	});
});
