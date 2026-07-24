/**
 * Archive-on-terminal run bundles (durability phase 4) — PURE core.
 *
 * A run's full record decays fast: Dapr workflow history is purged 24h after
 * completion, ClickHouse OTLP spans expire at ~7d, and artifact/session bytes
 * live in the one unbacked Postgres. This reconciler, when enabled, snapshots a
 * terminal run into a single self-describing JSON bundle in object storage —
 * well before those TTLs — so the run stays inspectable indefinitely.
 *
 * This module is deps-injected and free of any DB / ClickHouse / object-store /
 * env import so the bundle assembly + sweep orchestration are exhaustively
 * unit-testable; the real wiring lives in `adapters/run-archive-deps.ts`.
 */

export const RUN_ARCHIVE_BUNDLE_VERSION = 1;

/** Artifacts at or below this size are inlined into the bundle (base64). */
export const ARTIFACT_INLINE_MAX_BYTES = 256 * 1024;

export const DEFAULT_ARCHIVE_BATCH_LIMIT = 25;
export const MAX_ARCHIVE_BATCH_LIMIT = 200;

/** Every part is best-effort — a missing/failed part is NOTED, never fatal. */
export type RunArchivePart = {
	included: boolean;
	count?: number;
	note?: string;
};

export type RunArchiveManifest = {
	version: number;
	executionId: string;
	workflowId: string;
	generatedAt: string;
	parts: {
		execution: RunArchivePart;
		sessions: RunArchivePart;
		sessionEvents: RunArchivePart;
		scriptCalls: RunArchivePart;
		artifacts: RunArchivePart;
		otlpSpans: RunArchivePart;
	};
};

export type ArchiveArtifact = {
	id: string;
	kind: string;
	title: string;
	slot: string | null;
	nodeId: string | null;
	contentType: string | null;
	sizeBytes: number | null;
	inlinePayload: unknown;
	metadata: Record<string, unknown> | null;
	fileId: string | null;
	createdAt: string;
	/** Populated by assembly when a small blob artifact's bytes were inlined. */
	payloadBase64?: string;
	payloadOmittedReason?: string;
};

export type RunArchiveBundle = {
	manifest: RunArchiveManifest;
	execution: Record<string, unknown> | null;
	sessions: Record<string, unknown>[];
	sessionEvents: Record<string, unknown>[];
	scriptCalls: Record<string, unknown>[];
	artifacts: ArchiveArtifact[];
	otlpSpans: unknown[];
};

/** Minimal execution shape the assembly needs; the full row is embedded verbatim. */
export type ArchiveExecutionRow = {
	id: string;
	workflowId: string;
	completedAt?: string | Date | null;
	startedAt?: string | Date | null;
	[key: string]: unknown;
};

export type AssembleArchiveDeps = {
	loadLinkedSessions(
		executionId: string,
	): Promise<Array<{ id: string } & Record<string, unknown>>>;
	/** MUST return events sequence-ordered across the given sessions. */
	loadSessionEvents(sessionIds: string[]): Promise<Record<string, unknown>[]>;
	loadScriptCalls(executionId: string): Promise<Record<string, unknown>[]>;
	loadArtifacts(executionId: string): Promise<ArchiveArtifact[]>;
	loadArtifactFileBytes(fileId: string): Promise<Buffer | null>;
	/** OTLP spans for the run's trace; returns included:false when unconfigured. */
	loadTraceSpans(
		execution: ArchiveExecutionRow,
	): Promise<{ included: boolean; spans: unknown[]; note?: string }>;
};

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function toIso(value: string | Date | null | undefined): string | null {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Object key for a run's archive: `<yyyy-mm>/<executionId>.json`, partitioned by
 * completion month (falls back to `now` for a terminal-but-missing completedAt).
 */
export function archiveObjectKey(
	execution: ArchiveExecutionRow,
	now: Date = new Date(),
): string {
	const completed = toIso(execution.completedAt) ?? now.toISOString();
	const yyyymm = completed.slice(0, 7); // YYYY-MM
	return `${yyyymm}/${execution.id}.json`;
}

/**
 * Assemble the durable bundle for one terminal execution. Each part is gathered
 * independently and its outcome recorded in the manifest — a ClickHouse outage or
 * a missing session set degrades that ONE part to `included:false` with a note,
 * never aborts the whole archive.
 */
export async function assembleRunArchiveBundle(
	execution: ArchiveExecutionRow,
	deps: AssembleArchiveDeps,
	options: { now?: () => Date } = {},
): Promise<RunArchiveBundle> {
	const now = options.now ?? (() => new Date());
	const parts: RunArchiveManifest["parts"] = {
		execution: { included: true },
		sessions: { included: false },
		sessionEvents: { included: false },
		scriptCalls: { included: false },
		artifacts: { included: false },
		otlpSpans: { included: false },
	};

	let sessions: Record<string, unknown>[] = [];
	let sessionEvents: Record<string, unknown>[] = [];
	let scriptCalls: Record<string, unknown>[] = [];
	let artifacts: ArchiveArtifact[] = [];
	let otlpSpans: unknown[] = [];

	try {
		sessions = await deps.loadLinkedSessions(execution.id);
		parts.sessions = { included: true, count: sessions.length };
	} catch (err) {
		parts.sessions = { included: false, note: errText(err) };
	}

	try {
		const sessionIds = sessions.map((s) => String(s.id)).filter(Boolean);
		if (sessionIds.length > 0) {
			sessionEvents = await deps.loadSessionEvents(sessionIds);
		}
		parts.sessionEvents = { included: true, count: sessionEvents.length };
	} catch (err) {
		parts.sessionEvents = { included: false, note: errText(err) };
	}

	try {
		scriptCalls = await deps.loadScriptCalls(execution.id);
		parts.scriptCalls = { included: true, count: scriptCalls.length };
	} catch (err) {
		parts.scriptCalls = { included: false, note: errText(err) };
	}

	try {
		artifacts = await deps.loadArtifacts(execution.id);
		for (const artifact of artifacts) {
			// Inline only small blob artifacts that aren't already inline JSON.
			if (
				artifact.fileId &&
				artifact.inlinePayload == null &&
				(artifact.sizeBytes ?? 0) <= ARTIFACT_INLINE_MAX_BYTES
			) {
				try {
					const bytes = await deps.loadArtifactFileBytes(artifact.fileId);
					if (bytes && bytes.byteLength <= ARTIFACT_INLINE_MAX_BYTES) {
						artifact.payloadBase64 = bytes.toString("base64");
					} else if (bytes) {
						artifact.payloadOmittedReason = "exceeds_inline_cap";
					} else {
						artifact.payloadOmittedReason = "not_found";
					}
				} catch (err) {
					artifact.payloadOmittedReason = errText(err);
				}
			} else if (artifact.fileId && artifact.inlinePayload == null) {
				artifact.payloadOmittedReason = "exceeds_inline_cap";
			}
		}
		parts.artifacts = { included: true, count: artifacts.length };
	} catch (err) {
		parts.artifacts = { included: false, note: errText(err) };
	}

	try {
		const trace = await deps.loadTraceSpans(execution);
		otlpSpans = trace.spans;
		parts.otlpSpans = {
			included: trace.included,
			count: trace.spans.length,
			...(trace.note ? { note: trace.note } : {}),
		};
	} catch (err) {
		parts.otlpSpans = { included: false, note: errText(err) };
	}

	return {
		manifest: {
			version: RUN_ARCHIVE_BUNDLE_VERSION,
			executionId: execution.id,
			workflowId: execution.workflowId,
			generatedAt: now().toISOString(),
			parts,
		},
		execution,
		sessions,
		sessionEvents,
		scriptCalls,
		artifacts,
		otlpSpans,
	};
}

/** Serialize a bundle to the bytes written to object storage. */
export function serializeRunArchiveBundle(bundle: RunArchiveBundle): Buffer {
	return Buffer.from(JSON.stringify(bundle), "utf8");
}

export type RunArchiveSweepDeps = AssembleArchiveDeps & {
	listTerminalUnarchived(limit: number): Promise<ArchiveExecutionRow[]>;
	putArchive(key: string, body: Buffer): Promise<void>;
	markArchived(executionId: string): Promise<void>;
};

export type RunArchiveSweepOptions = {
	limit?: number;
	dryRun?: boolean;
	now?: () => Date;
};

export type RunArchiveSweepResult = {
	scanned: number;
	archived: string[];
	failed: Array<{ executionId: string; error: string }>;
	dryRun: boolean;
};

function clampLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit)) return DEFAULT_ARCHIVE_BATCH_LIMIT;
	return Math.max(1, Math.min(MAX_ARCHIVE_BATCH_LIMIT, Math.floor(limit as number)));
}

/**
 * One archive sweep: fetch a bounded batch of terminal-but-unarchived runs,
 * bundle + write each, and mark it archived on success. A per-run failure is
 * isolated (recorded, retried next scan) so one bad run never stalls the batch.
 */
export async function runRunArchiveSweep(
	deps: RunArchiveSweepDeps,
	options: RunArchiveSweepOptions = {},
): Promise<RunArchiveSweepResult> {
	const now = options.now ?? (() => new Date());
	const dryRun = options.dryRun ?? false;
	const limit = clampLimit(options.limit);
	const executions = await deps.listTerminalUnarchived(limit);

	const archived: string[] = [];
	const failed: RunArchiveSweepResult["failed"] = [];

	for (const execution of executions) {
		try {
			const bundle = await assembleRunArchiveBundle(execution, deps, { now });
			if (dryRun) {
				archived.push(execution.id);
				continue;
			}
			const key = archiveObjectKey(execution, now());
			await deps.putArchive(key, serializeRunArchiveBundle(bundle));
			await deps.markArchived(execution.id);
			archived.push(execution.id);
		} catch (err) {
			failed.push({ executionId: execution.id, error: errText(err) });
		}
	}

	return { scanned: executions.length, archived, failed, dryRun };
}
