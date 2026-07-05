import { describe, expect, it, vi } from "vitest";
import {
	ApplicationPreviewArchiveService,
	previewArchiveScopeId,
} from "$lib/server/application/preview-archive";
import type {
	CreateWorkflowFileInput,
	PreviewReadProxyPort,
} from "$lib/server/application/ports";

const previews = [{ name: "myfeature", url: "https://wfb-myfeature.ts", pool: null }];

const executionRows = [
	{
		id: "exec-1",
		workflowId: "wf-1",
		workflowName: "Smoke",
		status: "success",
		phase: "done",
		progress: 100,
		error: null,
		startedAt: "2026-07-04T10:00:00.000Z",
		completedAt: "2026-07-04T10:00:30.000Z",
		durationMs: 30_000,
	},
	{
		id: "exec-2",
		workflowId: "wf-2",
		workflowName: "Dev session",
		status: "running",
		phase: "generate",
		progress: 40,
		error: null,
		startedAt: "2026-07-04T11:00:00.000Z",
		completedAt: null,
		durationMs: null,
	},
];

function fakeProxy(over: Partial<PreviewReadProxyPort> = {}): PreviewReadProxyPort {
	return {
		listExecutions: vi.fn(async () => ({
			ok: true as const,
			data: { executions: executionRows, total: 2 },
		})),
		getExecution: vi.fn(async () => ({ ok: true as const, data: {} })),
		listExecutionArtifacts: vi.fn(async ({ executionId }) => ({
			ok: true as const,
			data:
				executionId === "exec-1"
					? [
							{
								id: "art-unpromoted",
								executionId: "exec-1",
								kind: "source-bundle",
								title: "v1",
								fileId: "file-1",
								contentType: "application/gzip",
								sizeBytes: 128,
								metadata: { tier: "tar-overlay" },
								createdAt: "2026-07-04T10:00:10.000Z",
							},
							{
								id: "art-promoted",
								executionId: "exec-1",
								kind: "source-bundle",
								title: "v2",
								fileId: "file-2",
								contentType: "application/gzip",
								sizeBytes: 128,
								metadata: { promotion: { prUrl: "https://github.com/x/pr/1" } },
								createdAt: "2026-07-04T10:00:20.000Z",
							},
						]
					: [],
		})),
		fetchFileContent: vi.fn(async () => ({
			ok: true as const,
			data: { bytes: Buffer.from("bundle-bytes"), contentType: "application/gzip" },
		})),
		...over,
	};
}

function fakeFiles() {
	let n = 0;
	return {
		createFile: vi.fn(async (input: CreateWorkflowFileInput) => ({
			file: {
				id: `host-file-${++n}`,
				name: input.name,
				purpose: input.purpose,
				scopeId: input.scopeId ?? null,
				contentType: input.contentType ?? null,
				sizeBytes: input.bytes.byteLength,
				sha1: null,
				createdAt: new Date().toISOString(),
				archivedAt: null,
			},
			deduplicated: false,
		})),
	};
}

const listPreviews = async () => previews;

describe("ApplicationPreviewArchiveService", () => {
	it("archives run summary + un-promoted bundles to the host Files API", async () => {
		const proxy = fakeProxy();
		const files = fakeFiles();
		const service = new ApplicationPreviewArchiveService({ proxy, listPreviews, files });

		const result = await service.archivePreview({
			name: "myfeature",
			userId: "user-1",
			projectId: "project-1",
		});

		expect(result.archived).toBe(true);
		expect(result.executionCount).toBe(2);
		expect(result.bundleCount).toBe(1); // promoted bundle skipped
		expect(result.bundleErrors).toBe(0);
		expect(result.summaryFileId).toBe("host-file-2");

		// Bundle copy, then summary — both tagged with the preview scope.
		expect(files.createFile).toHaveBeenCalledTimes(2);
		const bundleCall = files.createFile.mock.calls[0][0];
		expect(bundleCall).toMatchObject({
			userId: "user-1",
			projectId: "project-1",
			purpose: "output",
			scopeId: previewArchiveScopeId("myfeature"),
			name: "preview-myfeature/bundle-art-unpromoted.tar.gz",
			contentType: "application/gzip",
		});
		const summaryCall = files.createFile.mock.calls[1][0];
		expect(summaryCall.scopeId).toBe("preview-archive:myfeature");
		expect(summaryCall.contentType).toBe("application/json");
		const summary = JSON.parse(summaryCall.bytes.toString());
		expect(summary.schema).toBe("wfb.preview-archive/v1");
		expect(summary.preview.name).toBe("myfeature");
		expect(summary.executions).toHaveLength(2);
		expect(summary.bundles).toEqual([
			expect.objectContaining({
				executionId: "exec-1",
				artifactId: "art-unpromoted",
				fileId: "host-file-1",
			}),
		]);
	});

	it("reports archived:false (and writes nothing) when the preview is unreachable", async () => {
		const proxy = fakeProxy({
			listExecutions: vi.fn(async () => ({
				ok: false as const,
				reason: "unreachable" as const,
				message: "timeout",
			})),
		});
		const files = fakeFiles();
		const service = new ApplicationPreviewArchiveService({ proxy, listPreviews, files });

		const result = await service.archivePreview({ name: "myfeature", userId: "u" });
		expect(result).toMatchObject({
			archived: false,
			reason: "executions-unreachable",
		});
		expect(files.createFile).not.toHaveBeenCalled();
	});

	it("reports archived:false for a preview SEA does not know", async () => {
		const files = fakeFiles();
		const service = new ApplicationPreviewArchiveService({
			proxy: fakeProxy(),
			listPreviews,
			files,
		});
		const result = await service.archivePreview({ name: "ghost", userId: "u" });
		expect(result).toMatchObject({ archived: false, reason: "preview-not-found" });
		expect(files.createFile).not.toHaveBeenCalled();
	});

	it("still archives the summary when artifact listing is unavailable (older preview image)", async () => {
		const proxy = fakeProxy({
			listExecutionArtifacts: vi.fn(async () => ({
				ok: false as const,
				reason: "bad-response" as const,
				message: "preview returned HTTP 405",
			})),
		});
		const files = fakeFiles();
		const service = new ApplicationPreviewArchiveService({ proxy, listPreviews, files });

		const result = await service.archivePreview({ name: "myfeature", userId: "u" });
		expect(result.archived).toBe(true);
		expect(result.bundleCount).toBe(0);
		expect(result.notes?.join(" ")).toContain("artifact listing unavailable");
		expect(files.createFile).toHaveBeenCalledTimes(1); // summary only
		const summary = JSON.parse(files.createFile.mock.calls[0][0].bytes.toString());
		expect(summary.artifactListingDegraded).toBe(true);
	});

	it("counts bundle fetch failures without failing the archive", async () => {
		const proxy = fakeProxy({
			fetchFileContent: vi.fn(async () => ({
				ok: false as const,
				reason: "unreachable" as const,
			})),
		});
		const files = fakeFiles();
		const service = new ApplicationPreviewArchiveService({ proxy, listPreviews, files });

		const result = await service.archivePreview({ name: "myfeature", userId: "u" });
		expect(result.archived).toBe(true);
		expect(result.bundleCount).toBe(0);
		expect(result.bundleErrors).toBe(1);
	});

	it("skips file creation entirely for an empty preview", async () => {
		const proxy = fakeProxy({
			listExecutions: vi.fn(async () => ({
				ok: true as const,
				data: { executions: [], total: 0 },
			})),
		});
		const files = fakeFiles();
		const service = new ApplicationPreviewArchiveService({ proxy, listPreviews, files });

		const result = await service.archivePreview({ name: "myfeature", userId: "u" });
		expect(result).toMatchObject({ archived: true, reason: "empty", executionCount: 0 });
		expect(files.createFile).not.toHaveBeenCalled();
	});

	it("stops copying bundles once the deadline is exceeded", async () => {
		const proxy = fakeProxy();
		const files = fakeFiles();
		const service = new ApplicationPreviewArchiveService({
			proxy,
			listPreviews,
			files,
			deadlineMs: -1, // already expired
		});
		const result = await service.archivePreview({ name: "myfeature", userId: "u" });
		expect(result.archived).toBe(true);
		expect(result.bundleCount).toBe(0);
		expect(proxy.fetchFileContent).not.toHaveBeenCalled();
	});
});
