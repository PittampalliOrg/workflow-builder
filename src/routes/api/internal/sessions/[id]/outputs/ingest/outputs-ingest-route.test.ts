import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const sessionOwner = {
		id: "session-1",
		userId: "user-1",
		projectId: "project-1" as string | null,
	};
	const workflowData = {
		getSessionFileOwner: vi.fn(
			async (): Promise<typeof sessionOwner | null> => sessionOwner,
		),
		createWorkflowFile: vi.fn(async () => ({
			file: {
				id: "file-1",
				name: "answer.txt",
				purpose: "output",
				scopeId: "session-1",
				contentType: "text/plain" as string | null,
				sizeBytes: 5,
				sha1: "sha1",
				createdAt: "2026-07-02T00:00:00.000Z",
				archivedAt: null,
			},
			deduplicated: false,
		})),
	};
	const validateInternalToken = vi.fn(() => true);
	return { sessionOwner, validateInternalToken, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
}));

import { POST } from "./+server";

function event(body: unknown) {
	return {
		params: { id: "session-1" },
		request: new Request(
			"http://localhost/api/internal/sessions/session-1/outputs/ingest",
			{
				method: "POST",
				body: JSON.stringify(body),
				headers: { "Content-Type": "application/json" },
			},
		),
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

describe("internal session outputs ingest route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalToken.mockReturnValue(true);
		mocks.workflowData.getSessionFileOwner.mockResolvedValue(mocks.sessionOwner);
		mocks.workflowData.createWorkflowFile.mockResolvedValue({
			file: {
				id: "file-1",
				name: "answer.txt",
				purpose: "output",
				scopeId: "session-1",
				contentType: "text/plain" as string | null,
				sizeBytes: 5,
				sha1: "sha1",
				createdAt: "2026-07-02T00:00:00.000Z",
				archivedAt: null,
			},
			deduplicated: false,
		});
	});

	it("keeps output persistence behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.getSessionFileOwner");
		expect(source).toContain("workflowData.createWorkflowFile");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("createFile");
		expect(source).not.toContain("filePayloads");
	});

	it("requires the internal token", async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);

		await expectHttpStatus(Promise.resolve(POST(event({ files: [] }) as never)), 401);
		expect(mocks.workflowData.getSessionFileOwner).not.toHaveBeenCalled();
	});

	it("returns an empty result without resolving the session for empty uploads", async () => {
		const response = (await POST(event({ files: [] }) as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ created: [], errors: [] });
		expect(mocks.workflowData.getSessionFileOwner).not.toHaveBeenCalled();
	});

	it("returns 404 when the session is missing", async () => {
		mocks.workflowData.getSessionFileOwner.mockResolvedValueOnce(null);

		await expectHttpStatus(
			Promise.resolve(
				POST(
					event({
						files: [
							{
								name: "answer.txt",
								base64: Buffer.from("hello").toString("base64"),
							},
						],
					}) as never,
				),
			),
			404,
		);
		expect(mocks.workflowData.createWorkflowFile).not.toHaveBeenCalled();
	});

	it("creates output files with session ownership and tracks deduped files", async () => {
		mocks.workflowData.createWorkflowFile
			.mockResolvedValueOnce({
				file: {
					id: "file-1",
					name: "answer.txt",
					purpose: "output",
					scopeId: "session-1",
					contentType: "text/plain" as string | null,
					sizeBytes: 5,
					sha1: "sha1-a",
					createdAt: "2026-07-02T00:00:00.000Z",
					archivedAt: null,
				},
				deduplicated: false,
			})
			.mockResolvedValueOnce({
				file: {
					id: "file-2",
					name: "same.txt",
					purpose: "output",
					scopeId: "session-1",
					contentType: null,
					sizeBytes: 4,
					sha1: "sha1-b",
					createdAt: "2026-07-02T00:00:00.000Z",
					archivedAt: null,
				},
				deduplicated: true,
			});

		const response = (await POST(
			event({
				files: [
					{
						name: "answer.txt",
						contentType: "text/plain" as string | null,
						base64: Buffer.from("hello").toString("base64"),
					},
					{
						name: "same.txt",
						base64: Buffer.from("same").toString("base64"),
					},
				],
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			created: ["file-1"],
			deduplicated: ["file-2"],
			errors: [],
		});
		expect(mocks.workflowData.getSessionFileOwner).toHaveBeenCalledWith("session-1");
		expect(mocks.workflowData.createWorkflowFile).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			name: "answer.txt",
			purpose: "output",
			scopeId: "session-1",
			contentType: "text/plain",
			bytes: Buffer.from("hello"),
		});
	});

	it("keeps per-file errors without dropping valid files", async () => {
		mocks.workflowData.createWorkflowFile.mockRejectedValueOnce(new Error("store failed"));

		const response = (await POST(
			event({
				files: [
					{ name: "", base64: "abc" },
					{ name: "empty.txt", base64: "====" },
					{
						name: "will-fail.txt",
						base64: Buffer.from("payload").toString("base64"),
					},
				],
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			created: [],
			deduplicated: [],
			errors: [
				{ name: "<unnamed>", error: "missing name or base64" },
				{ name: "empty.txt", error: "empty file" },
				{ name: "will-fail.txt", error: "store failed" },
			],
		});
	});
});
