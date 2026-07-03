// Live workflow-activity counter for an in-progress workflow execution.
//
// Endpoint contract:
//   GET /api/observability/workflows/<executionId>/activity-rate
//   → { lastMinute: { succeeded, failed, recoverable, total }, lastActivityAt }
//
// Driven by dapr_runtime_workflow_activity_operation_count (Counter, labeled by
// `status` + `dapr_app_id`). We resolve `dapr_app_id` from workflow-data's
// execution/session read model. When no session exists (headless workflow), the
// endpoint returns zeros so the UI can render a "—" placeholder without
// special-casing.

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
	queryCounterDelta,
	queryCounterLatestSample,
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

function zeroPayload(): ActivityRatePayload {
	return {
		dapr_app_id: null,
		windowSeconds: WINDOW_SECONDS,
		lastMinute: { succeeded: 0, failed: 0, recoverable: 0, total: 0 },
		lastActivityAt: null,
	};
}

async function resolveAgentAppId(executionId: string): Promise<string | null> {
	try {
		const target =
			await getApplicationAdapters().workflowData.resolveWorkflowActivityRateTarget({
				executionId,
			});
		return target?.daprAppId ?? null;
	} catch {
		return null;
	}
}

async function computePayload(executionId: string): Promise<ActivityRatePayload> {
	const agentAppId = await resolveAgentAppId(executionId);
	const now = new Date();
	const from = new Date(now.getTime() - WINDOW_SECONDS * 1000);
	const range = { from, to: now };

	if (!agentAppId) {
		return zeroPayload();
	}

	const filter = {
		cluster: METRICS_DEFAULT_CLUSTER,
		attribute: { dapr_app_id: agentAppId },
	};

	// Status enum values are lowercased on the wire (durabletask-go emits
	// `success` / `failed` / `recoverable` even though Dapr APIs use TitleCase).
	const METRIC = "dapr_runtime_workflow_activity_execution_count";
	const [succeeded, failed, recoverable, latest] = await Promise.all([
		queryCounterDelta(METRIC, range, {
			...filter,
			attribute: { ...filter.attribute, status: "success" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		queryCounterDelta(METRIC, range, {
			...filter,
			attribute: { ...filter.attribute, status: "failed" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		queryCounterDelta(METRIC, range, {
			...filter,
			attribute: { ...filter.attribute, status: "recoverable" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		queryCounterLatestSample(METRIC, range, filter).catch(() => null),
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
