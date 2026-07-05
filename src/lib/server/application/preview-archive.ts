import type {
	CreateWorkflowFileInput,
	ListWorkflowFilesByScopePrefixFilter,
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
export const PREVIEW_ARCHIVE_SCOPE_PREFIX = "preview-archive:";

export function previewArchiveScopeId(previewName: string): string {
	return `${PREVIEW_ARCHIVE_SCOPE_PREFIX}${previewName}`;
}

export type PreviewArchiveDeps = {
	proxy: PreviewReadProxyPort;
	listPreviews: () => Promise<PreviewRunTarget[]>;
	files: {
		createFile(
			input: CreateWorkflowFileInput,
		): Promise<{ file: WorkflowFileRecord; deduplicated: boolean }>;
		listFilesByScopePrefix(
			filter: ListWorkflowFilesByScopePrefixFilter,
		): Promise<WorkflowFileRecord[]>;
		getFileContent(
			id: string,
		): Promise<{ summary: WorkflowFileRecord; bytes: Buffer } | null>;
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

/** One archived preview scope, summarised from its file metadata alone (no
 * bundle bytes read — see `getArchivedPreview` for the parsed detail). */
export type ArchivedPreviewListItem = {
	name: string;
	scopeId: string;
	/** Most-recent file createdAt across the scope (ISO). */
	lastArchivedAt: string;
	summaryCount: number;
	bundleCount: number;
	fileCount: number;
	totalBytes: number;
};

/** A file that lives under an archive scope (for raw download links). */
export type ArchivedPreviewFile = {
	id: string;
	name: string;
	contentType: string | null;
	sizeBytes: number;
	createdAt: string;
	kind: "summary" | "bundle" | "other";
};

export type ArchivedPreviewExecution = {
	id: string;
	workflowId: string | null;
	workflowName: string | null;
	status: string | null;
	phase: string | null;
	error: string | null;
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
};

export type ArchivedPreviewDetail =
	| {
			ok: true;
			name: string;
			scopeId: string;
			archivedAt: string;
			pool: string | null;
			url: string | null;
			executionsTotal: number | null;
			executions: ArchivedPreviewExecution[];
			bundles: PreviewArchivedBundle[];
			artifactListingDegraded: boolean;
			notes: string[];
			files: ArchivedPreviewFile[];
	  }
	| {
			ok: false;
			name: string;
			scopeId: string;
			/** `not-found` = no files for the scope; `no-summary` = files exist but
			 * no run-summary; `malformed` = summary present but unparseable / wrong
			 * schema. Files are still returned (when any) for raw downloads. */
			reason: "not-found" | "no-summary" | "malformed";
			message?: string;
			files: ArchivedPreviewFile[];
	  };

function classifyArchiveFile(name: string): ArchivedPreviewFile["kind"] {
	if (name.includes("/run-summary-") && name.endsWith(".json")) return "summary";
	if (name.includes("/bundle-")) return "bundle";
	return "other";
}

function toArchivedPreviewFile(record: WorkflowFileRecord): ArchivedPreviewFile {
	return {
		id: record.id,
		name: record.name,
		contentType: record.contentType,
		sizeBytes: record.sizeBytes,
		createdAt: record.createdAt,
		kind: classifyArchiveFile(record.name),
	};
}

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

	/**
	 * List every archived-preview scope for a user, summarised from file
	 * metadata alone (no bundle bytes read — a listing must stay cheap). One
	 * item per `preview-archive:<name>` scope, newest first.
	 */
	async listArchivedPreviews(input: {
		userId: string;
		limit?: number;
	}): Promise<ArchivedPreviewListItem[]> {
		const records = await this.deps.files.listFilesByScopePrefix({
			userId: input.userId,
			scopeIdPrefix: PREVIEW_ARCHIVE_SCOPE_PREFIX,
			purpose: "output",
			limit: input.limit,
		});
		const groups = new Map<string, WorkflowFileRecord[]>();
		for (const record of records) {
			if (!record.scopeId) continue;
			const group = groups.get(record.scopeId);
			if (group) group.push(record);
			else groups.set(record.scopeId, [record]);
		}
		const items: ArchivedPreviewListItem[] = [];
		for (const [scopeId, group] of groups) {
			let summaryCount = 0;
			let bundleCount = 0;
			let totalBytes = 0;
			let lastArchivedAt = "";
			for (const file of group) {
				const kind = classifyArchiveFile(file.name);
				if (kind === "summary") summaryCount += 1;
				else if (kind === "bundle") bundleCount += 1;
				totalBytes += file.sizeBytes;
				if (file.createdAt > lastArchivedAt) lastArchivedAt = file.createdAt;
			}
			items.push({
				name: scopeId.slice(PREVIEW_ARCHIVE_SCOPE_PREFIX.length),
				scopeId,
				lastArchivedAt,
				summaryCount,
				bundleCount,
				fileCount: group.length,
				totalBytes,
			});
		}
		items.sort((a, b) => b.lastArchivedAt.localeCompare(a.lastArchivedAt));
		return items;
	}

	/**
	 * Detail for one archived preview: the latest run-summary parsed into an
	 * executions table + bundle links. A missing/unparseable/wrong-schema summary
	 * resolves to a typed error state (never throws) so the route can render the
	 * raw file list for recovery. Only the small summary JSON is read — bundle
	 * bytes are downloaded on demand via the Files API.
	 */
	async getArchivedPreview(input: {
		name: string;
		userId: string;
	}): Promise<ArchivedPreviewDetail> {
		const name = input.name.trim();
		const scopeId = previewArchiveScopeId(name);
		// Prefix query then exact-scope filter so `pr-4` never matches `pr-42`.
		const records = (
			await this.deps.files.listFilesByScopePrefix({
				userId: input.userId,
				scopeIdPrefix: scopeId,
				purpose: "output",
			})
		).filter((record) => record.scopeId === scopeId);
		const files = records.map(toArchivedPreviewFile);
		if (records.length === 0) {
			return { ok: false, name, scopeId, reason: "not-found", files };
		}

		const summaryRecord = records
			.filter((record) => classifyArchiveFile(record.name) === "summary")
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
		if (!summaryRecord) {
			return { ok: false, name, scopeId, reason: "no-summary", files };
		}

		const content = await this.deps.files.getFileContent(summaryRecord.id);
		if (!content) {
			return {
				ok: false,
				name,
				scopeId,
				reason: "malformed",
				message: "summary file content unavailable",
				files,
			};
		}
		const parsed = parseArchiveSummary(content.bytes);
		if (!parsed.ok) {
			return {
				ok: false,
				name,
				scopeId,
				reason: "malformed",
				message: parsed.message,
				files,
			};
		}
		const summary = parsed.summary;
		return {
			ok: true,
			name,
			scopeId,
			archivedAt: summary.archivedAt ?? summaryRecord.createdAt,
			pool: summary.pool,
			url: summary.url,
			executionsTotal: summary.executionsTotal,
			executions: summary.executions,
			bundles: summary.bundles,
			artifactListingDegraded: summary.artifactListingDegraded,
			notes: summary.notes,
			files,
		};
	}
}

type ParsedArchiveSummary = {
	archivedAt: string | null;
	pool: string | null;
	url: string | null;
	executionsTotal: number | null;
	executions: ArchivedPreviewExecution[];
	bundles: PreviewArchivedBundle[];
	artifactListingDegraded: boolean;
	notes: string[];
};

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coerceExecution(value: unknown): ArchivedPreviewExecution | null {
	if (!value || typeof value !== "object") return null;
	const e = value as Record<string, unknown>;
	if (typeof e.id !== "string") return null;
	return {
		id: e.id,
		workflowId: str(e.workflowId),
		workflowName: str(e.workflowName),
		status: str(e.status),
		phase: str(e.phase),
		error: str(e.error),
		startedAt: str(e.startedAt),
		completedAt: str(e.completedAt),
		durationMs: num(e.durationMs),
	};
}

function coerceBundle(value: unknown): PreviewArchivedBundle | null {
	if (!value || typeof value !== "object") return null;
	const b = value as Record<string, unknown>;
	if (typeof b.fileId !== "string") return null;
	return {
		executionId: str(b.executionId) ?? "",
		artifactId: str(b.artifactId) ?? "",
		fileId: b.fileId,
		sizeBytes: num(b.sizeBytes) ?? 0,
		contentType: str(b.contentType),
	};
}

/** Validate + defensively coerce a run-summary JSON. Wrong schema, non-object,
 * or invalid JSON → `{ ok:false, message }`. */
function parseArchiveSummary(
	bytes: Buffer,
):
	| { ok: true; summary: ParsedArchiveSummary }
	| { ok: false; message: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(bytes.toString("utf8"));
	} catch (err) {
		return {
			ok: false,
			message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (!raw || typeof raw !== "object") {
		return { ok: false, message: "summary is not an object" };
	}
	const obj = raw as Record<string, unknown>;
	if (obj.schema !== PREVIEW_ARCHIVE_SCHEMA) {
		return { ok: false, message: `unexpected schema: ${String(obj.schema)}` };
	}
	const preview =
		obj.preview && typeof obj.preview === "object"
			? (obj.preview as Record<string, unknown>)
			: {};
	return {
		ok: true,
		summary: {
			archivedAt: str(obj.archivedAt),
			pool: str(preview.pool),
			url: str(preview.url),
			executionsTotal: num(obj.executionsTotal),
			executions: Array.isArray(obj.executions)
				? obj.executions
						.map(coerceExecution)
						.filter((e): e is ArchivedPreviewExecution => e !== null)
				: [],
			bundles: Array.isArray(obj.bundles)
				? obj.bundles
						.map(coerceBundle)
						.filter((b): b is PreviewArchivedBundle => b !== null)
				: [],
			artifactListingDegraded: obj.artifactListingDegraded === true,
			notes: Array.isArray(obj.notes)
				? obj.notes.filter((n): n is string => typeof n === "string")
				: [],
		},
	};
}
