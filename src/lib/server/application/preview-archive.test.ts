import { describe, expect, it, vi } from "vitest";
import {
	ApplicationPreviewArchiveService,
	previewArchiveScopeId,
} from "$lib/server/application/preview-archive";
import type {
	CreateWorkflowFileInput,
	ListWorkflowFilesByScopePrefixFilter,
	PreviewReadProxyPort,
	WorkflowFileRecord,
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
	const store = new Map<string, { record: WorkflowFileRecord; bytes: Buffer }>();
	const createFile = vi.fn(async (input: CreateWorkflowFileInput) => {
		const record: WorkflowFileRecord = {
			id: `host-file-${++n}`,
			name: input.name,
			purpose: input.purpose,
			scopeId: input.scopeId ?? null,
			contentType: input.contentType ?? null,
			sizeBytes: input.bytes.byteLength,
			sha1: null,
			// Distinct, monotonically-increasing timestamps so "latest summary"
			// ordering is deterministic (files created within the same ms).
			createdAt: new Date(Date.UTC(2026, 6, 4) + n).toISOString(),
			archivedAt: null,
		};
		store.set(record.id, { record, bytes: input.bytes });
		return { file: record, deduplicated: false };
	});
	const listFilesByScopePrefix = vi.fn(
		async (filter: ListWorkflowFilesByScopePrefixFilter) =>
			[...store.values()]
				.map((entry) => entry.record)
				.filter((record) =>
					(record.scopeId ?? "").startsWith(filter.scopeIdPrefix),
				)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
	);
	const getFileContent = vi.fn(async (id: string) => {
		const entry = store.get(id);
		return entry ? { summary: entry.record, bytes: entry.bytes } : null;
	});
	return { createFile, listFilesByScopePrefix, getFileContent, store };
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

describe("ApplicationPreviewArchiveService.listArchivedPreviews", () => {
	it("groups archive files by scope into one item per preview", async () => {
		const proxy = fakeProxy();
		const files = fakeFiles();
		const service = new ApplicationPreviewArchiveService({
			proxy,
			listPreviews,
			files,
		});
		await service.archivePreview({ name: "myfeature", userId: "user-1" });

		const items = await service.listArchivedPreviews({ userId: "user-1" });
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			name: "myfeature",
			scopeId: previewArchiveScopeId("myfeature"),
			summaryCount: 1,
			bundleCount: 1,
			fileCount: 2,
		});
		expect(items[0].totalBytes).toBeGreaterThan(0);
		expect(items[0].lastArchivedAt).toBeTruthy();
		// A listing must never read bundle bytes.
		expect(files.getFileContent).not.toHaveBeenCalled();
	});

	it("returns an empty list when nothing is archived", async () => {
		const service = new ApplicationPreviewArchiveService({
			proxy: fakeProxy(),
			listPreviews,
			files: fakeFiles(),
		});
		expect(await service.listArchivedPreviews({ userId: "user-1" })).toEqual([]);
	});
});

describe("ApplicationPreviewArchiveService.getArchivedPreview", () => {
	it("parses the latest run-summary into executions + bundles", async () => {
		const files = fakeFiles();
		const service = new ApplicationPreviewArchiveService({
			proxy: fakeProxy(),
			listPreviews,
			files,
		});
		await service.archivePreview({ name: "myfeature", userId: "user-1" });

		const detail = await service.getArchivedPreview({
			name: "myfeature",
			userId: "user-1",
		});
		expect(detail.ok).toBe(true);
		if (!detail.ok) throw new Error("expected ok");
		expect(detail.executions.map((e) => e.id)).toEqual(["exec-1", "exec-2"]);
		expect(detail.bundles).toHaveLength(1);
		expect(detail.files).toHaveLength(2);
		expect(detail.executionsTotal).toBe(2);
	});

	it("does not match a different preview whose name shares a prefix", async () => {
		const files = fakeFiles();
		const service = new ApplicationPreviewArchiveService({
			proxy: fakeProxy(),
			listPreviews: async () => [
				{ name: "pr-4", url: null, pool: null },
				{ name: "pr-42", url: null, pool: null },
			],
			files,
		});
		await service.archivePreview({ name: "pr-4", userId: "user-1" });
		await service.archivePreview({ name: "pr-42", userId: "user-1" });

		const detail = await service.getArchivedPreview({
			name: "pr-4",
			userId: "user-1",
		});
		expect(detail.ok).toBe(true);
		// only pr-4's two files, not pr-42's
		expect(detail.files.every((f) => f.name.startsWith("preview-pr-4/"))).toBe(
			true,
		);
	});

	it("returns a not-found error state for an unknown preview", async () => {
		const service = new ApplicationPreviewArchiveService({
			proxy: fakeProxy(),
			listPreviews,
			files: fakeFiles(),
		});
		const detail = await service.getArchivedPreview({
			name: "ghost",
			userId: "user-1",
		});
		expect(detail).toMatchObject({ ok: false, reason: "not-found", files: [] });
	});

	it("returns a malformed error state (but keeps files) on a bad summary", async () => {
		const files = fakeFiles();
		await files.createFile({
			userId: "user-1",
			name: "preview-bad/run-summary-x.json",
			purpose: "output",
			scopeId: previewArchiveScopeId("bad"),
			contentType: "application/json",
			bytes: Buffer.from(JSON.stringify({ schema: "something/else" })),
		});
		const service = new ApplicationPreviewArchiveService({
			proxy: fakeProxy(),
			listPreviews,
			files,
		});
		const detail = await service.getArchivedPreview({
			name: "bad",
			userId: "user-1",
		});
		expect(detail.ok).toBe(false);
		if (detail.ok) throw new Error("expected error state");
		expect(detail.reason).toBe("malformed");
		expect(detail.files).toHaveLength(1);
	});

	it("returns a no-summary error state when only bundles exist", async () => {
		const files = fakeFiles();
		await files.createFile({
			userId: "user-1",
			name: "preview-nb/bundle-x.tar.gz",
			purpose: "output",
			scopeId: previewArchiveScopeId("nb"),
			contentType: "application/gzip",
			bytes: Buffer.from("bytes"),
		});
		const service = new ApplicationPreviewArchiveService({
			proxy: fakeProxy(),
			listPreviews,
			files,
		});
		const detail = await service.getArchivedPreview({
			name: "nb",
			userId: "user-1",
		});
		expect(detail).toMatchObject({ ok: false, reason: "no-summary" });
	});
});
