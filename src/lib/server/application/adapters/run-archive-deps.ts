/**
 * Real wiring for the archive-on-terminal reconciler (durability phase 4).
 *
 * Routes (the Dapr Job callback `POST /job/run-archive` + the internal ops
 * endpoint) and the boot scheduler reach the sweep through the
 * `run-archive-service` barrel, never this adapter directly (dependency-cruiser
 * `routes-no-adapters`). The pure bundle/sweep logic is in
 * `../run-archive.ts`; this module supplies the Postgres, ClickHouse, and
 * object-store side effects + the Dapr Jobs scheduling, and is env-gated so it is
 * a complete no-op until the object store is configured AND WFB_RUN_ARCHIVE_ENABLED.
 */
import { timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { db as defaultDb } from "$lib/server/db";
import {
	sessionEvents,
	sessions,
	workflowArtifacts,
	workflowExecutions,
	workflowScriptCalls,
} from "$lib/server/db/schema";
import { daprFetch, getDaprSidecarUrl } from "$lib/server/dapr-client";
import {
	extractExecutionTraceIds,
	findCorrelatedTraceIds,
	getMultiTraceSpans,
	isClickHouseConfigured,
} from "$lib/server/otel/clickhouse";
import { createObjectStoreClient } from "$lib/server/storage/object-store";
import {
	getObjectStoreConfig,
	isRunArchiveActive,
} from "$lib/server/storage/object-store-config";
import { PostgresWorkflowFileStore } from "$lib/server/application/adapters/postgres";
import {
	DEFAULT_ARCHIVE_BATCH_LIMIT,
	runRunArchiveSweep,
	type ArchiveArtifact,
	type ArchiveExecutionRow,
	type RunArchiveSweepDeps,
	type RunArchiveSweepResult,
} from "$lib/server/application/run-archive";

const TERMINAL_STATUSES = ["success", "error", "cancelled"] as const;

function readEnv(name: string): string {
	return (env[name] ?? process.env[name] ?? "").trim();
}

function readInt(name: string, fallback: number): number {
	const parsed = Number.parseInt(readEnv(name), 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/** Best-effort gather of every traceId associated with a run. */
async function resolveExecutionTraceIds(
	execution: ArchiveExecutionRow,
): Promise<string[]> {
	const ids = new Set<string>();
	if (typeof execution.primaryTraceId === "string" && execution.primaryTraceId) {
		ids.add(execution.primaryTraceId);
	}
	for (const id of extractExecutionTraceIds(execution.output)) ids.add(id);
	try {
		const correlated = await findCorrelatedTraceIds(
			(execution.startedAt as string | Date) ?? new Date(),
			(execution.completedAt as string | Date | null) ?? null,
			[...ids],
		);
		for (const id of correlated) ids.add(id);
	} catch {
		// findCorrelatedTraceIds already swallows its own errors; guard anyway.
	}
	return [...ids];
}

function buildSweepDeps(): RunArchiveSweepDeps {
	const db = defaultDb;
	if (!db) throw new Error("Database not configured");
	const config = getObjectStoreConfig();
	const connection = config.connection;
	if (!connection) throw new Error("object store not configured");
	const archiveClient = createObjectStoreClient(
		connection,
		config.runArchiveBucket,
	);
	const fileStore = new PostgresWorkflowFileStore(db);

	return {
		async listTerminalUnarchived(limit) {
			const rows = await db
				.select()
				.from(workflowExecutions)
				.where(
					and(
						inArray(workflowExecutions.status, [...TERMINAL_STATUSES]),
						isNull(workflowExecutions.archivedAt),
					),
				)
				.orderBy(desc(workflowExecutions.completedAt))
				.limit(limit);
			return rows as unknown as ArchiveExecutionRow[];
		},
		async loadLinkedSessions(executionId) {
			const rows = await db
				.select()
				.from(sessions)
				.where(eq(sessions.workflowExecutionId, executionId));
			return rows as unknown as Array<{ id: string } & Record<string, unknown>>;
		},
		async loadSessionEvents(sessionIds) {
			if (sessionIds.length === 0) return [];
			const rows = await db
				.select()
				.from(sessionEvents)
				.where(inArray(sessionEvents.sessionId, sessionIds))
				.orderBy(asc(sessionEvents.sessionId), asc(sessionEvents.sequence));
			return rows as unknown as Record<string, unknown>[];
		},
		async loadScriptCalls(executionId) {
			const rows = await db
				.select()
				.from(workflowScriptCalls)
				.where(eq(workflowScriptCalls.workflowExecutionId, executionId))
				.orderBy(asc(workflowScriptCalls.seq));
			return rows as unknown as Record<string, unknown>[];
		},
		async loadArtifacts(executionId) {
			const rows = await db
				.select()
				.from(workflowArtifacts)
				.where(eq(workflowArtifacts.workflowExecutionId, executionId))
				.orderBy(asc(workflowArtifacts.createdAt));
			return rows.map(
				(row): ArchiveArtifact => ({
					id: row.id,
					kind: row.kind,
					title: row.title,
					slot: row.slot ?? null,
					nodeId: row.nodeId ?? null,
					contentType: row.contentType ?? null,
					sizeBytes: row.sizeBytes ?? null,
					inlinePayload: row.inlinePayload ?? null,
					metadata: row.metadata ?? null,
					fileId: row.fileId ?? null,
					createdAt: row.createdAt.toISOString(),
				}),
			);
		},
		async loadArtifactFileBytes(fileId) {
			const content = await fileStore.getFileContent(fileId);
			return content?.bytes ?? null;
		},
		async loadTraceSpans(execution) {
			if (!isClickHouseConfigured()) {
				return { included: false, spans: [], note: "clickhouse_not_configured" };
			}
			const traceIds = await resolveExecutionTraceIds(execution);
			if (traceIds.length === 0) {
				return { included: true, spans: [], note: "no_trace_ids" };
			}
			const spans = await getMultiTraceSpans(traceIds);
			return { included: true, spans };
		},
		async putArchive(key, body) {
			await archiveClient.putObject(key, body, {
				contentType: "application/json",
			});
		},
		async markArchived(executionId) {
			await db
				.update(workflowExecutions)
				.set({ archivedAt: new Date() })
				.where(eq(workflowExecutions.id, executionId));
		},
	};
}

export type RunRunArchiveResult =
	| (RunArchiveSweepResult & { skipped?: undefined })
	| { skipped: string };

/**
 * The single sweep entry both tick surfaces call. No-ops (`skipped:"disabled"`)
 * unless the object store is configured AND WFB_RUN_ARCHIVE_ENABLED=true.
 */
export async function runRunArchive(
	overrides: { dryRun?: boolean; limit?: number } = {},
): Promise<RunRunArchiveResult> {
	if (!isRunArchiveActive(getObjectStoreConfig())) {
		return { skipped: "disabled" };
	}
	const deps = buildSweepDeps();
	const limit = overrides.limit ?? readInt("WFB_RUN_ARCHIVE_BATCH_LIMIT", DEFAULT_ARCHIVE_BATCH_LIMIT);
	return runRunArchiveSweep(deps, { limit, dryRun: overrides.dryRun });
}

export const RUN_ARCHIVE_JOB_NAME = "run-archive";

/**
 * Schedule the recurring archive sweep on the BFF's own Dapr sidecar (Dapr Jobs
 * API — durable, replica-deduplicated). Runs frequently (default @every 5m) so
 * bundles land well before Dapr's 24h workflow-history purge and ClickHouse's
 * ~7d span TTL. No-op unless the archive feature is active. Mirrors the
 * session-reconciler job scheduler (token-authenticated callback, overwrite
 * upsert, bounded background retry).
 */
export async function scheduleRunArchiveJob(): Promise<void> {
	if (!isRunArchiveActive(getObjectStoreConfig())) {
		console.log("[run-archive] Dapr Job not scheduled (feature disabled)");
		return;
	}
	const token = readEnv("INTERNAL_API_TOKEN");
	const schedule = readEnv("WFB_RUN_ARCHIVE_SCHEDULE") || "@every 5m";
	const body = JSON.stringify({
		schedule,
		dueTime: readEnv("WFB_RUN_ARCHIVE_DUE_TIME") || "1m",
		data: { archive: true, ...(token ? { token } : {}) },
		overwrite: true,
	});
	const attempts = 5;
	const spacingMs = 20_000;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const res = await daprFetch(
				`${getDaprSidecarUrl()}/v1.0/jobs/${RUN_ARCHIVE_JOB_NAME}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
					maxRetries: 0,
					signal: AbortSignal.timeout(5_000),
				},
			);
			if (res.ok) {
				console.log(
					`[run-archive] scheduled Dapr Job '${RUN_ARCHIVE_JOB_NAME}' (${schedule})`,
				);
				return;
			}
			console.warn(
				`[run-archive] Dapr Job schedule non-OK ${res.status} (attempt ${attempt}/${attempts})`,
			);
		} catch (err) {
			console.warn(
				`[run-archive] Dapr Job schedule attempt ${attempt}/${attempts} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
		if (attempt < attempts) {
			await new Promise((resolve) => setTimeout(resolve, spacingMs));
		}
	}
	console.error(
		`[run-archive] Dapr Job schedule FAILED after ${attempts} attempts — archiving will not tick on this pod. Check daprd/Scheduler health.`,
	);
}

/** Authenticate a Dapr Job callback by the token carried in its payload. */
export function authenticateRunArchiveJobPayload(body: unknown): boolean {
	const expected = readEnv("INTERNAL_API_TOKEN");
	if (!expected) return true;
	const record = (body ?? {}) as Record<string, unknown>;
	const data = (record.data ?? {}) as Record<string, unknown>;
	const candidate =
		(typeof record.token === "string" && record.token) ||
		(typeof data.token === "string" && data.token) ||
		"";
	if (!candidate) return false;
	const a = Buffer.from(candidate);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
