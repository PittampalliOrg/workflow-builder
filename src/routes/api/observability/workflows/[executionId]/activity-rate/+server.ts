// Live workflow-activity counter for an in-progress workflow execution.
//
// Endpoint contract:
//   GET /api/observability/workflows/<executionId>/activity-rate
//   → { lastMinute: { succeeded, failed, recoverable, total }, lastActivityAt }
//
// Driven by dapr_runtime_workflow_activity_operation_count (Counter, labeled by
// `status` + `dapr_app_id`). We resolve `dapr_app_id` from the execution's
// linked session via sessionHostAppId(). When no session exists (headless
// workflow), the endpoint returns zeros so the UI can render a "—" placeholder
// without special-casing.

import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { workflowExecutions, sessions } from "$lib/server/db/schema";
import { sessionHostAppId } from "$lib/server/sessions/agent-workflow-host";
import {
	queryCounterDelta,
	queryGaugeLatest,
} from "$lib/server/otel/metrics";

const WINDOW_SECONDS = 60;
const METRICS_DEFAULT_CLUSTER = process.env.METRICS_DEFAULT_CLUSTER ?? "dev";

// In-process TTL cache: dedupes concurrent listeners on the same execution
// (the run-detail page polls every 3s; this cache prevents 20 visitors from
// hammering ClickHouse 20× per cycle).
type CacheEntry = { expiresAt: number; payload: ActivityRatePayload };
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 2_000;

type ActivityRatePayload = {
	dapr_app_id: string | null;
	windowSeconds: number;
	lastMinute: {
		succeeded: number;
		failed: number;
		recoverable: number;
		total: number;
	};
	lastActivityAt: string | null;
};

async function computePayload(executionId: string): Promise<ActivityRatePayload> {
	if (!db) {
		return {
			dapr_app_id: null,
			windowSeconds: WINDOW_SECONDS,
			lastMinute: { succeeded: 0, failed: 0, recoverable: 0, total: 0 },
			lastActivityAt: null,
		};
	}

	// Resolve the execution → session → agent dapr_app_id.
	const [exec] = await db
		.select({
			workflowSessionId: workflowExecutions.workflowSessionId,
		})
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);

	let agentAppId: string | null = null;
	if (exec?.workflowSessionId) {
		const [sessionRow] = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.id, exec.workflowSessionId))
			.limit(1);
		if (sessionRow?.id) {
			agentAppId = sessionHostAppId(sessionRow.id);
		}
	}

	const now = new Date();
	const from = new Date(now.getTime() - WINDOW_SECONDS * 1000);
	const range = { from, to: now };

	if (!agentAppId) {
		return {
			dapr_app_id: null,
			windowSeconds: WINDOW_SECONDS,
			lastMinute: { succeeded: 0, failed: 0, recoverable: 0, total: 0 },
			lastActivityAt: null,
		};
	}

	const filter = {
		cluster: METRICS_DEFAULT_CLUSTER,
		attribute: { dapr_app_id: agentAppId },
	};

	const [succeeded, failed, recoverable, latest] = await Promise.all([
		queryCounterDelta("dapr_runtime_workflow_activity_operation_count", range, {
			...filter,
			attribute: { ...filter.attribute, status: "Succeeded" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		queryCounterDelta("dapr_runtime_workflow_activity_operation_count", range, {
			...filter,
			attribute: { ...filter.attribute, status: "Failed" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		queryCounterDelta("dapr_runtime_workflow_activity_operation_count", range, {
			...filter,
			attribute: { ...filter.attribute, status: "Recoverable" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		// The "last activity timestamp" is approximated by the latest sample
		// time of any activity counter — gauge query gives us the most recent
		// TimeUnix without needing a separate ORDER BY query.
		queryGaugeLatest("dapr_runtime_workflow_activity_operation_count", range, filter).catch(
			() => null,
		),
	]);

	const succDelta = Math.round(succeeded.delta);
	const failDelta = Math.round(failed.delta);
	const recDelta = Math.round(recoverable.delta);

	return {
		dapr_app_id: agentAppId,
		windowSeconds: WINDOW_SECONDS,
		lastMinute: {
			succeeded: succDelta,
			failed: failDelta,
			recoverable: recDelta,
			total: succDelta + failDelta + recDelta,
		},
		lastActivityAt: latest ? latest.t.toISOString() : null,
	};
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { executionId } = params;
	if (!executionId) return error(400, "Missing executionId");

	const cached = CACHE.get(executionId);
	const nowMs = Date.now();
	if (cached && cached.expiresAt > nowMs) {
		return json(cached.payload);
	}

	const payload = await computePayload(executionId);
	CACHE.set(executionId, { expiresAt: nowMs + CACHE_TTL_MS, payload });

	// Best-effort cleanup of stale cache entries (keeps memory bounded under
	// long-running sessions). Skip when cache is small.
	if (CACHE.size > 64) {
		for (const [k, v] of CACHE) {
			if (v.expiresAt < nowMs - CACHE_TTL_MS * 10) CACHE.delete(k);
		}
	}

	return json(payload);
};
