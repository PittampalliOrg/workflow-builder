/**
 * The vetted lifecycle controller.
 *
 * `stopDurableRun` is the single server-side entry point for stopping any
 * durable run (a workflow execution, an agent session, or an evaluation run)
 * and — for purge/reset — leaving nothing behind that breaks the next run. It
 * is fail-closed: it only flips DB rows terminal / reaps sandboxes once the
 * durable tree is confirmed closed, and otherwise reports `confirmed:false` so
 * callers (HTTP 409) and the user can retry.
 *
 * Every user-facing "stop" surface should route through this. See
 * docs/workflow-lifecycle-termination.md.
 */
import { env } from "$env/dynamic/private";
import { deleteKubernetesSandbox } from "$lib/server/kube/client";
import { raiseSessionEvent } from "$lib/server/sessions/control";
import {
	createDaprCascadeDeps,
	DURABLE_RUNTIME_MISSING_STATUS,
	type DurableCascadeResult,
	isTerminalDurableRuntimeStatus,
	runDurableCascade,
} from "./cascade";
import {
	type DurableRunTarget,
	type DurableTargetScope,
	resolveDurableTarget,
} from "./resolvers";

export type { DurableRunTarget, DurableTargetScope } from "./resolvers";

export type StopDurableRunMode =
	/** Cooperative pause: ask the agent to halt at a safe boundary. No purge, no DB flip, no reap. */
	| "interrupt"
	/** Terminate the durable tree (graceful then forceful). No purge. */
	| "terminate"
	/** Terminate + purge durable state + reap Sandbox CRs + flip DB terminal. */
	| "purge"
	/** purge + force-delete state rows even if Dapr never confirmed terminal. */
	| "reset";

export type StopDurableRunStep = {
	name: string;
	result: "ok" | "skipped" | "failed" | "partial";
	detail?: string;
};

export type StopDurableRunOptions = {
	mode: StopDurableRunMode;
	reason?: string;
	/** Graceful cooperative-cancel wait before forceful terminate (ms). 0 = skip graceful. */
	graceMs?: number;
};

export type StopDurableRunResult = {
	confirmed: boolean;
	notFound: boolean;
	/** True once the durable stop-intent was persisted (terminate/purge/reset). */
	requested: boolean;
	/**
	 * confirmed — durable tree terminal AND DB finalized/sandboxes reaped.
	 * stopping — stop requested + intent persisted, converging asynchronously
	 *   (the in-request poll window expired or finalize is pending); the reaper
	 *   / a status poll will finalize once Dapr is terminal. Maps to HTTP 202.
	 * notFound — no such durable run.
	 */
	state: "confirmed" | "stopping" | "notFound";
	scope: DurableTargetScope | null;
	cascade?: DurableCascadeResult;
	steps: StopDurableRunStep[];
};

// One shared deps instance — generic Dapr-backed orchestrator + agent-runtime ops.
// Timing is env-tunable: the in-request poll window cannot fully cover a workflow
// blocked in a long activity (terminate applies only when the activity yields), so
// operators can widen it; the persisted stop-intent + the terminal-status reaper
// converge the tail regardless.
function envSeconds(name: string, fallbackS: number, minS: number, maxS: number): number {
	const raw = env[name] ?? process.env[name];
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
	const s = Number.isFinite(n) ? n : fallbackS;
	return Math.max(minS, Math.min(maxS, s)) * 1000;
}
const cascadeDeps = createDaprCascadeDeps({
	waitMs: envSeconds("LIFECYCLE_CASCADE_WAIT_SECONDS", 90, 5, 1800),
	waitPollMs: envSeconds("LIFECYCLE_CASCADE_POLL_SECONDS", 1, 1, 30),
	requestTimeoutMs: envSeconds("LIFECYCLE_CASCADE_REQUEST_TIMEOUT_SECONDS", 20, 1, 120),
});

/**
 * Resolve a target's auth scope + whether its durable run is still active,
 * without performing any stop action. Used to enforce CMA scope and to block
 * destructive delete/archive while a run is live.
 */
export async function inspectDurableRun(target: DurableRunTarget): Promise<{
	notFound: boolean;
	active: boolean;
	scope: DurableTargetScope | null;
}> {
	const resolved = await resolveDurableTarget(target);
	return {
		notFound: resolved.notFound,
		active: !resolved.notFound && resolved.dbActive,
		scope: resolved.scope,
	};
}

export async function stopDurableRun(
	target: DurableRunTarget,
	opts: StopDurableRunOptions,
): Promise<StopDurableRunResult> {
	const resolved = await resolveDurableTarget(target);
	if (resolved.notFound) {
		return {
			confirmed: false,
			notFound: true,
			requested: false,
			state: "notFound",
			scope: null,
			steps: [],
		};
	}
	const reason = opts.reason?.trim() || "Stopped by user";
	const steps: StopDurableRunStep[] = [];

	// Cooperative interrupt: ask the agent to halt the current turn at a safe
	// boundary. Never force/purge/reap. For sessions this preserves the exact
	// `user.interrupt` wire shape the runtime already understands.
	if (opts.mode === "interrupt") {
		if (target.kind === "session") {
			const r = await raiseSessionEvent(target.id, "session.user_events", {
				events: [{ type: "user.interrupt" }],
			});
			steps.push({
				name: "interrupt:session",
				result: r.ok ? "ok" : "failed",
				detail: r.error,
			});
			return {
				confirmed: r.ok,
				notFound: false,
				requested: false,
				state: r.ok ? "confirmed" : "stopping",
				scope: resolved.scope,
				steps,
			};
		}
		for (const p of resolved.parentInstanceIds) {
			const r = await cascadeDeps.cancelParent?.(p, reason);
			steps.push({
				name: `interrupt:workflow:${p}`,
				result: r === "failed" ? "failed" : "ok",
				detail: r,
			});
		}
		const ok = steps.every((s) => s.result !== "failed");
		return {
			confirmed: ok,
			notFound: false,
			requested: false,
			state: ok ? "confirmed" : "stopping",
			scope: resolved.scope,
			steps,
		};
	}

	const purge = opts.mode === "purge" || opts.mode === "reset";
	const graceMs = Math.max(0, opts.graceMs ?? 0);
	// Persist the durable stop-intent up front so the row reads "Stopping…" and the
	// terminal-status reaper can finalize it even if the in-request poll window
	// expires (e.g. a workflow blocked in a long activity).
	try {
		await resolved.markStopRequested(reason);
	} catch (err) {
		steps.push({
			name: "mark-stop-requested",
			result: "failed",
			detail: err instanceof Error ? err.message : String(err),
		});
	}
	const cascade = await runDurableCascade({
		parentInstanceIds: resolved.parentInstanceIds,
		agentRuntimeTargets: resolved.agentRuntimeTargets,
		statePurgeInstanceIds: resolved.statePurgeInstanceIds,
		reason,
		purge,
		purgeGraceMs: 0,
		forceStatePurgeOnUnclosed: opts.mode === "reset",
		gracefulCancellationEnabled: graceMs > 0,
		gracefulCancellationWaitMs: graceMs,
		deps: cascadeDeps,
	});
	steps.push({
		name: "durable-cascade",
		result: cascade.allClosed ? "ok" : "partial",
		detail: `parentClosed=${cascade.parentClosed} agentRuntimeClosed=${cascade.agentRuntimeClosed} purged=${purge}`,
	});

	// Not confirmed terminal in-request — e.g. a workflow blocked in a long
	// activity that only applies `terminate` once the activity yields (minutes
	// later). We still never flip DB rows / reap sandboxes until Dapr is confirmed
	// terminal (no lying about success), BUT the stop-intent is persisted and the
	// cascade keeps converging; the terminal-status reaper (or a status poll)
	// finalizes once Dapr reports terminal. Report "stopping" (HTTP 202), not a
	// hard 409 that leaves the row stale forever.
	if (!cascade.allClosed) {
		return {
			confirmed: false,
			notFound: false,
			requested: true,
			state: "stopping",
			scope: resolved.scope,
			cascade,
			steps,
		};
	}

	let reapOk = true;
	if (purge) {
		for (const name of resolved.sandboxNames) {
			try {
				const result = await deleteKubernetesSandbox(name);
				steps.push({ name: `reap-sandbox:${name}`, result: "ok", detail: result });
			} catch (err) {
				reapOk = false;
				steps.push({
					name: `reap-sandbox:${name}`,
					result: "failed",
					detail: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	let dbOk = true;
	try {
		await resolved.finalizeDb(reason);
		steps.push({ name: "finalize-db", result: "ok" });
	} catch (err) {
		dbOk = false;
		steps.push({
			name: "finalize-db",
			result: "failed",
			detail: err instanceof Error ? err.message : String(err),
		});
	}

	const confirmed = reapOk && dbOk;
	return {
		confirmed,
		notFound: false,
		requested: true,
		// reap/finalize failures are transient bookkeeping — keep "stopping" so the
		// reaper retries the finalize rather than declaring permanent success.
		state: confirmed ? "confirmed" : "stopping",
		scope: resolved.scope,
		cascade,
		steps,
	};
}

async function isInstanceClosed(getStatus: () => Promise<unknown>): Promise<boolean> {
	try {
		const s = await getStatus();
		return s === DURABLE_RUNTIME_MISSING_STATUS || isTerminalDurableRuntimeStatus(s);
	} catch {
		return false; // unknown -> not yet closed
	}
}

/**
 * Confirm convergence of a previously-requested stop (the "stopping" → "confirmed"
 * transition). Re-checks every durable handle (parent + per-session agent
 * runtimes); once all are terminal/gone it reaps the Sandbox CRs and flips the DB
 * terminal — idempotent, so a status poll and the reaper can both call it safely.
 * Returns "stopping" while any handle is still live (no DB flip, no lie).
 */
export async function confirmDurableStop(
	target: DurableRunTarget,
): Promise<{ state: "confirmed" | "stopping" | "notFound"; scope: DurableTargetScope | null }> {
	const resolved = await resolveDurableTarget(target);
	if (resolved.notFound) return { state: "notFound", scope: null };
	const checks = [
		...resolved.parentInstanceIds.map(
			(id) => () => isInstanceClosed(() => cascadeDeps.getParentStatus(id)),
		),
		...resolved.agentRuntimeTargets.map(
			(t) => () =>
				isInstanceClosed(() => cascadeDeps.getAgentRuntimeStatus(t.runtimeAppId, t.instanceId)),
		),
	];
	const closed = (await Promise.all(checks.map((f) => f()))).every(Boolean);
	if (!closed) return { state: "stopping", scope: resolved.scope };
	for (const name of resolved.sandboxNames) {
		try {
			await deleteKubernetesSandbox(name);
		} catch {
			/* best-effort reap; the sandbox-gc CronJob is the backstop */
		}
	}
	await resolved.finalizeDb("stop confirmed");
	return { state: "confirmed", scope: resolved.scope };
}
