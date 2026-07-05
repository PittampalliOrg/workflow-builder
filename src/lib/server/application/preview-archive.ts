import type {
	CreateWorkflowFileInput,
	PreviewArtifactSummary,
	PreviewExecutionSummary,
	PreviewReadProxyPort,
	PreviewRunTarget,
	WorkflowFileRecord,
} from "$lib/server/application/ports";

/**
 * E3: archive-on-teardown. A Tier-2 preview's DB — run history, transcripts,
 * source-bundle code versions — dies with the vcluster at teardown. When
 * PREVIEW_ARCHIVE_ON_TEARDOWN is on, the BFF teardown route calls this service
 * BEFORE issuing the SEA teardown:
 *
 *   1. Pull the preview's recent executions over the E2 read proxy.
 *   2. Pull each execution's `source-bundle` artifacts and copy any bundle NOT
 *      already promoted to a PR (no `metadata.promotion` marker) into the HOST
 *      Files API.
 *   3. Write a compact JSON run-summary file alongside them.
 *
 * Everything lands in the host `files` table under
 * `scopeId: "preview-archive:<name>"` (files carry no execution FK — a
 * preview's executions don't exist on the host, so `workflow_artifacts` rows
 * are not an option). Archive failures NEVER block teardown: the route treats
 * any failure as `archived: false` and proceeds.
 */

export const PREVIEW_ARCHIVE_SCHEMA = "wfb.preview-archive/v1";

export function previewArchiveScopeId(previewName: string): string {
	return `preview-archive:${previewName}`;
}

export type PreviewArchiveDeps = {
	proxy: PreviewReadProxyPort;
	listPreviews: () => Promise<PreviewRunTarget[]>;
	files: {
		createFile(
			input: CreateWorkflowFileInput,
		): Promise<{ file: WorkflowFileRecord; deduplicated: boolean }>;
	};
	/** Max executions pulled into the summary (proxy caps at 500). */
	executionLimit?: number;
	/** Max source bundles copied per archive. */
	bundleLimit?: number;
	/** Soft wall-clock budget — bundle copying stops once exceeded. */
	deadlineMs?: number;
	now?: () => Date;
};

export type PreviewArchivedBundle = {
	executionId: string;
	artifactId: string;
	/** HOST Files-API file id the bundle bytes were copied to. */
	fileId: string;
	sizeBytes: number;
	contentType: string | null;
};

export type PreviewArchiveResult = {
	archived: boolean;
	preview: string;
	reason?: string;
	summaryFileId?: string;
	executionCount?: number;
	bundleCount?: number;
	bundleErrors?: number;
	notes?: string[];
};

const DEFAULT_EXECUTION_LIMIT = 200;
const DEFAULT_BUNDLE_LIMIT = 20;
const DEFAULT_DEADLINE_MS = 45_000;

function isPromoted(artifact: PreviewArtifactSummary): boolean {
	return !!artifact.metadata && "promotion" in artifact.metadata;
}

function compactExecution(execution: PreviewExecutionSummary) {
	return {
		id: execution.id,
		workflowId: execution.workflowId,
		workflowName: execution.workflowName,
		status: execution.status,
		phase: execution.phase,
		error: execution.error,
		startedAt: execution.startedAt,
		completedAt: execution.completedAt,
		durationMs: execution.durationMs,
	};
}

export class ApplicationPreviewArchiveService {
	constructor(private readonly deps: PreviewArchiveDeps) {}

	/**
	 * Best-effort archive of one preview. Never throws for expected failure
	 * modes (unknown preview, unreachable preview, degraded artifact listing) —
	 * they resolve to `{ archived: false, reason }`. Unexpected throws are the
	 * caller's job to catch (the teardown route wraps this call).
	 */
	async archivePreview(input: {
		name: string;
		userId: string;
		projectId?: string | null;
	}): Promise<PreviewArchiveResult> {
		const name = input.name.trim();
		const deadline =
			Date.now() + (this.deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
		const previews = await this.deps.listPreviews();
		const target =
			previews.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
		if (!target) {
			return { archived: false, preview: name, reason: "preview-not-found" };
		}

		const list = await this.deps.proxy.listExecutions({
			target,
			limit: this.deps.executionLimit ?? DEFAULT_EXECUTION_LIMIT,
		});
		if (!list.ok) {
			return {
				archived: false,
				preview: name,
				reason: `executions-${list.reason}`,
				...(list.message ? { notes: [list.message] } : {}),
			};
		}
		const executions = list.data.executions;
		const notes: string[] = [];

		// Discover un-promoted source bundles (bounded, deadline-aware).
		const bundleLimit = this.deps.bundleLimit ?? DEFAULT_BUNDLE_LIMIT;
		const pending: Array<{ executionId: string; artifact: PreviewArtifactSummary }> = [];
		let artifactListingDegraded = false;
		for (const execution of executions) {
			if (pending.length >= bundleLimit || Date.now() > deadline) break;
			const artifacts = await this.deps.proxy.listExecutionArtifacts({
				target,
				executionId: execution.id,
				kind: "source-bundle",
			});
			if (!artifacts.ok) {
				// A preview app image that predates the internal artifacts GET fails
				// uniformly — record once and archive the run summary alone.
				artifactListingDegraded = true;
				notes.push(
					`artifact listing unavailable (${artifacts.reason}${artifacts.message ? `: ${artifacts.message}` : ""}) — bundles not archived`,
				);
				break;
			}
			for (const artifact of artifacts.data) {
				if (pending.length >= bundleLimit) break;
				if (!artifact.fileId) continue;
				if (isPromoted(artifact)) continue; // already durable as a PR
				pending.push({ executionId: execution.id, artifact });
			}
		}

		// Copy bundle blobs to the host Files API. createFile dedups on
		// (userId, scopeId, name, sha1), so re-archiving is idempotent.
		const copied: PreviewArchivedBundle[] = [];
		let bundleErrors = 0;
		for (const { executionId, artifact } of pending) {
			if (Date.now() > deadline) {
				notes.push("archive deadline reached — remaining bundles skipped");
				break;
			}
			const content = await this.deps.proxy.fetchFileContent({
				target,
				fileId: artifact.fileId as string,
			});
			if (!content.ok) {
				bundleErrors += 1;
				notes.push(
					`bundle ${artifact.id} fetch failed (${content.reason}${content.message ? `: ${content.message}` : ""})`,
				);
				continue;
			}
			try {
				const created = await this.deps.files.createFile({
					userId: input.userId,
					projectId: input.projectId ?? null,
					name: `preview-${name}/bundle-${artifact.id}.tar.gz`,
					purpose: "output",
					scopeId: previewArchiveScopeId(name),
					contentType:
						content.data.contentType ?? artifact.contentType ?? "application/gzip",
					bytes: content.data.bytes,
				});
				copied.push({
					executionId,
					artifactId: artifact.id,
					fileId: created.file.id,
					sizeBytes: content.data.bytes.byteLength,
					contentType: content.data.contentType ?? artifact.contentType ?? null,
				});
			} catch (err) {
				bundleErrors += 1;
				notes.push(
					`bundle ${artifact.id} store failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		if (executions.length === 0 && copied.length === 0) {
			// Nothing to preserve — don't leave an empty summary file behind.
			return {
				archived: true,
				preview: name,
				reason: "empty",
				executionCount: 0,
				bundleCount: 0,
				bundleErrors,
			};
		}

		const archivedAt = (this.deps.now?.() ?? new Date()).toISOString();
		const summary = {
			schema: PREVIEW_ARCHIVE_SCHEMA,
			preview: { name: target.name, pool: target.pool, url: target.url },
			archivedAt,
			executionsTotal: list.data.total,
			executions: executions.map(compactExecution),
			bundles: copied,
			bundleErrors,
			artifactListingDegraded,
			notes,
		};
		const summaryFile = await this.deps.files.createFile({
			userId: input.userId,
			projectId: input.projectId ?? null,
			name: `preview-${name}/run-summary-${archivedAt.replace(/[:.]/g, "-")}.json`,
			purpose: "output",
			scopeId: previewArchiveScopeId(name),
			contentType: "application/json",
			bytes: Buffer.from(JSON.stringify(summary, null, "\t")),
		});

		return {
			archived: true,
			preview: name,
			summaryFileId: summaryFile.file.id,
			executionCount: executions.length,
			bundleCount: copied.length,
			bundleErrors,
			...(notes.length ? { notes } : {}),
		};
	}
}
