import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";
import {
	inspectDurableRun,
	stopDurableRun,
	type StopDurableRunMode,
} from "$lib/server/lifecycle";
import {
	ownsBenchmarkOrEvalRun,
	ownsBenchmarkOrEvalRunForSession,
} from "$lib/server/lifecycle/ownership";
import { isResourceInScope } from "$lib/server/workflows/project-scope";
import { pauseGoal } from "$lib/server/goals/repo";
import {
	cancelBenchmarkRun,
	getSwebenchCoordinatorUrl,
} from "$lib/server/benchmarks/service";
import {
	cancelEvaluationRun,
	getEvaluationCoordinatorUrl,
} from "$lib/server/evaluations/service";
import { daprFetch } from "$lib/server/dapr-client";

/**
 * POST /api/v1/lifecycle/bulk-stop
 *
 * Stop many durable runs in one request — the bulk fan-out behind the Fleet
 * view's multi-select. Each target routes through the SAME single-target
 * authorities as the per-primitive Stop/Cancel routes, so there is one vetted
 * stop path and no divergence:
 *   - session / workflowExecution -> Lifecycle Controller `stopDurableRun`
 *     (scope-checked, `coordinator_owned`-guarded, goal-paused on interrupt).
 *   - benchmarkRun -> `cancelBenchmarkRun` + coordinator cancel (single stop
 *     authority for benchmark/eval instances is the owning RUN).
 *   - evalRun -> `cancelEvaluationRun` + coordinator cancel.
 *
 * Mixed outcomes are expected (some confirmed, some still stopping, some
 * coordinator-owned), so this always returns HTTP 200 with a per-item
 * `results[]` and the client renders each row's outcome. The per-target
 * `status` mirrors what the single-target route would have returned
 * (200 confirmed / 202 stopping / 409 coordinator-owned / 404 not-found).
 */

const MODES = new Set<StopDurableRunMode>([
	"interrupt",
	"terminate",
	"purge",
	"reset",
]);

const TARGET_KINDS = new Set([
	"session",
	"workflowExecution",
	"benchmarkRun",
	"evalRun",
]);

type BulkTargetKind =
	| "session"
	| "workflowExecution"
	| "benchmarkRun"
	| "evalRun";

type BulkTarget = { kind: BulkTargetKind; id: string };

type BulkResult = {
	kind: BulkTargetKind;
	id: string;
	state:
		| "confirmed"
		| "stopping"
		| "cancelled"
		| "coordinator_owned"
		| "notFound"
		| "error";
	status: number;
	ok: boolean;
	ownedBy?: "benchmarkRun" | "evalRun";
	runId?: string;
	error?: string;
};

const MAX_TARGETS = 200;
const CONCURRENCY = 8;

/** Run async tasks with a bounded worker pool so a large batch of slow
 * purge-mode terminates can't open hundreds of concurrent Dapr cascades. */
async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const i = cursor++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Fire-and-forget the swebench/eval coordinator cancel, mirroring the
 * single-run cancel routes (best-effort; the DB row is already flipped). */
function scheduleCoordinatorCancel(
	kind: "benchmarkRun" | "evalRun",
	runId: string,
): void {
	const token = env.INTERNAL_API_TOKEN;
	if (!token) return;
	void (async () => {
		try {
			const url =
				kind === "benchmarkRun"
					? `${getSwebenchCoordinatorUrl()}/api/v1/benchmark-runs/${runId}/cancel`
					: `${getEvaluationCoordinatorUrl()}/api/v1/evaluation-runs/${runId}/cancel`;
			const res = await daprFetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Internal-Token": token,
				},
				body: JSON.stringify({ reason: "cancelled by user (bulk)" }),
				maxRetries: 0,
				signal: AbortSignal.timeout(120_000),
			});
			if (!res.ok) {
				console.warn(
					`[bulk-stop] coordinator cancel failed for ${kind} ${runId}: ${res.status} ${await res.text()}`,
				);
			}
		} catch (err) {
			console.warn(
				`[bulk-stop] coordinator cancel failed for ${kind} ${runId}:`,
				err instanceof Error ? err.message : err,
			);
		}
	})();
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const session = locals.session;

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const mode: StopDurableRunMode =
		typeof body.mode === "string" && MODES.has(body.mode as StopDurableRunMode)
			? (body.mode as StopDurableRunMode)
			: "terminate";
	const reason = typeof body.reason === "string" ? body.reason : undefined;
	const graceMs = typeof body.graceMs === "number" ? body.graceMs : undefined;

	const rawTargets = Array.isArray(body.targets) ? body.targets : [];
	// Validate + dedupe by kind:id (a fleet selection can include the same
	// underlying run reached two ways; one stop is enough).
	const seen = new Set<string>();
	const targets: BulkTarget[] = [];
	for (const t of rawTargets) {
		if (!t || typeof t !== "object") continue;
		const kind = (t as { kind?: unknown }).kind;
		const id = (t as { id?: unknown }).id;
		if (typeof kind !== "string" || !TARGET_KINDS.has(kind)) continue;
		if (typeof id !== "string" || !id.trim()) continue;
		const key = `${kind}:${id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		targets.push({ kind: kind as BulkTargetKind, id: id.trim() });
	}

	if (targets.length === 0) {
		return error(400, "No valid targets provided");
	}
	if (targets.length > MAX_TARGETS) {
		return error(400, `Too many targets (max ${MAX_TARGETS})`);
	}

	const results = await mapPool(targets, CONCURRENCY, async (t): Promise<BulkResult> => {
		try {
			if (t.kind === "benchmarkRun" || t.kind === "evalRun") {
				if (!session.projectId) {
					return { ...t, state: "notFound", status: 404, ok: false };
				}
				if (t.kind === "benchmarkRun") {
					const run = await cancelBenchmarkRun(session.projectId, t.id, {
						terminalCleanup: "background",
					});
					if (!run) return { ...t, state: "notFound", status: 404, ok: false };
				} else {
					await cancelEvaluationRun(session.projectId, t.id);
				}
				scheduleCoordinatorCancel(t.kind, t.id);
				return { ...t, state: "cancelled", status: 200, ok: true };
			}

			// session | workflowExecution -> Lifecycle Controller
			const target = { kind: t.kind, id: t.id } as const;
			const inspected = await inspectDurableRun(target);
			if (inspected.notFound) {
				return { ...t, state: "notFound", status: 404, ok: false };
			}
			// Out-of-scope reads as not-found so cross-workspace existence isn't leaked.
			if (inspected.scope && !isResourceInScope(inspected.scope, session)) {
				return { ...t, state: "notFound", status: 404, ok: false };
			}
			const owner =
				t.kind === "session"
					? await ownsBenchmarkOrEvalRunForSession(t.id)
					: await ownsBenchmarkOrEvalRun(t.id);
			if (owner) {
				return {
					...t,
					state: "coordinator_owned",
					status: 409,
					ok: false,
					ownedBy: owner.kind,
					runId: owner.runId,
				};
			}
			if (mode === "interrupt" && t.kind === "session") {
				await pauseGoal(t.id).catch(() => {});
			}
			const r = await stopDurableRun(target, { mode, reason, graceMs });
			if (r.notFound) return { ...t, state: "notFound", status: 404, ok: false };
			const status =
				r.state === "confirmed" ? 200 : r.state === "stopping" ? 202 : 409;
			return { ...t, state: r.state, status, ok: r.confirmed };
		} catch (err) {
			return {
				...t,
				state: "error",
				status: 500,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});

	const summary = {
		total: results.length,
		confirmed: results.filter((r) => r.state === "confirmed").length,
		stopping: results.filter((r) => r.state === "stopping").length,
		cancelled: results.filter((r) => r.state === "cancelled").length,
		coordinatorOwned: results.filter((r) => r.state === "coordinator_owned").length,
		notFound: results.filter((r) => r.state === "notFound").length,
		failed: results.filter((r) => r.state === "error").length,
	};

	return json({ mode, results, summary });
};
