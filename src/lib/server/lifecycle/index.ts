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
	shouldForceFinalizeCrossAppWedge,
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
	/**
	 * purge + force-delete state rows even if Dapr never confirmed terminal — the
	 * "byte-clean" re-run mode (the UI "Stop & reset"). This IS reachable by
	 * normal users (it's a per-run dev affordance), and that is safe because every
	 * stop route runs `isResourceInScope` before `stopDurableRun`, so the
	 * force-delete only touches the caller's own in-scope run, and the state-row
	 * purge is boundary-anchored (no sibling over-delete). It does not require
	 * admin — the audit's "gate to admin" suggestion would break Stop & reset.
	 */
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
	/**
	 * Set when a cooperative interrupt couldn't be delivered for a TRANSIENT reason
	 * (the session is live but the runtime raise hiccuped, e.g. a 5xx/flaky
	 * sidecar) — as opposed to "not running yet". Lets the route map it to a
	 * retryable 503 instead of a misleading 409.
	 */
	retryable?: boolean;
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

// Grace before confirmDurableStop force-finalizes the cross-app child wedge.
// The SW-interpreter parent runs a `durable/run` step via
// ctx.call_child_workflow(app_id=<per-session agent app-id>) — a cross-app-id
// sub-orchestration on a SEPARATE Dapr task hub. Dapr's recursive terminate is
// bounded to one task hub, so a bare terminate on the parent never applies while
// it awaits that child: the parent hangs RUNNING forever even though the cascade
// already terminated the child agent (no runaway compute — it's an idle zombie).
// Once the child is terminal/gone AND this grace has elapsed since the stop was
// requested (long enough for any normally-terminable parent to have applied the
// terminate the cascade issued), we force-delete the wedged parent's durable
// state rows directly — the same mechanism mode:"reset" uses. The grace is the
// safety that keeps us from force-cleaning a parent that's merely slow to
// terminate or legitimately progressing through a later same-task-hub node.
const WEDGE_FINALIZE_GRACE_MS = envSeconds(
	"LIFECYCLE_WEDGE_FINALIZE_GRACE_SECONDS",
	180,
	30,
	1800,
);

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
			// A 5xx (or transport) raise failure against a live session is transient
			// — distinct from "not running yet" (404/409). Surface it as retryable so
			// the route returns 503, not a misleading 409.
			const retryable = !r.ok && (r.status >= 500 || r.status === 0);
			return {
				confirmed: r.ok,
				notFound: false,
				requested: false,
				state: r.ok ? "confirmed" : "stopping",
				scope: resolved.scope,
				retryable,
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
	// Cooperative-first: when the caller doesn't specify a grace, give terminate/
	// purge/reset a short window so the cascade raises the cooperative cancel first
	// (the agent honors it at the next turn/tool boundary via the dapr-agent-py
	// cancel-key) and only force-terminates if it doesn't yield in time. Env-tunable;
	// 0 disables (pure force). Interrupt mode returns above and never reaches here.
	const defaultGraceMs = envSeconds("LIFECYCLE_TERMINATE_GRACE_SECONDS", 5, 0, 120);
	const graceMs = Math.max(0, opts.graceMs ?? defaultGraceMs);
	// Persist the durable stop-intent up front so the row reads "Stopping…" and the
	// terminal-status reaper can finalize it even if the in-request poll window
	// expires (e.g. a workflow blocked in a long activity).
	// The whole request/confirm contract (reaper priority pass + the cross-app
	// wedge finalize) keys off stop_requested_at, so a swallowed write here can
	// leave a wedged run permanently un-finalizable. Retry transient failures
	// before giving up, and surface a hard failure rather than silently proceeding.
	let stopIntentPersisted = false;
	let stopIntentError: string | undefined;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await resolved.markStopRequested(reason);
			stopIntentPersisted = true;
			break;
		} catch (err) {
			stopIntentError = err instanceof Error ? err.message : String(err);
			if (attempt < 3) await cascadeDeps.sleep(200 * attempt);
		}
	}
	steps.push({
		name: "mark-stop-requested",
		result: stopIntentPersisted ? "ok" : "failed",
		detail: stopIntentPersisted ? undefined : `intent NOT persisted: ${stopIntentError}`,
	});
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

/** Reap the per-session Sandbox CRs and flip the owning DB rows terminal. */
async function finalizeConfirmedStop(
	resolved: Awaited<ReturnType<typeof resolveDurableTarget>>,
	reason: string,
): Promise<{ state: "confirmed"; scope: DurableTargetScope | null }> {
	for (const name of resolved.sandboxNames) {
		try {
			await deleteKubernetesSandbox(name);
		} catch {
			/* best-effort reap; the sandbox-gc CronJob is the backstop */
		}
	}
	await resolved.finalizeDb(reason);
	return { state: "confirmed", scope: resolved.scope };
}

/**
 * Confirm convergence of a previously-requested stop (the "stopping" → "confirmed"
 * transition). Re-checks every durable handle (parent + per-session agent
 * runtimes); once all are terminal/gone it reaps the Sandbox CRs and flips the DB
 * terminal — idempotent, so a status poll and the reaper can both call it safely.
 * Returns "stopping" while any handle is still live (no DB flip, no lie).
 *
 * Cross-app child wedge: a `durable/run` parent awaits a per-session agent child
 * on a SEPARATE Dapr task hub, which a bare terminate/purge can never bring
 * terminal (Dapr's recursive terminate is task-hub-bounded). The cascade already
 * terminated that child, so once every agent-runtime child is terminal/gone, the
 * parent is just an idle zombie. After {@link WEDGE_FINALIZE_GRACE_MS} since the
 * stop was requested we force-delete the wedged parent's durable state rows
 * (the mode:"reset" mechanism) and finalize — rather than poll "stopping" forever.
 */
export async function confirmDurableStop(
	target: DurableRunTarget,
): Promise<{ state: "confirmed" | "stopping" | "notFound"; scope: DurableTargetScope | null }> {
	const resolved = await resolveDurableTarget(target);
	if (resolved.notFound) return { state: "notFound", scope: null };
	const [parentClosedFlags, agentClosedFlags] = await Promise.all([
		Promise.all(
			resolved.parentInstanceIds.map((id) =>
				isInstanceClosed(() => cascadeDeps.getParentStatus(id)),
			),
		),
		Promise.all(
			resolved.agentRuntimeTargets.map((t) =>
				isInstanceClosed(() => cascadeDeps.getAgentRuntimeStatus(t.runtimeAppId, t.instanceId)),
			),
		),
	]);
	const parentClosed = parentClosedFlags.every(Boolean);
	const agentClosed = agentClosedFlags.every(Boolean);
	if (parentClosed && agentClosed) {
		return finalizeConfirmedStop(resolved, "stop confirmed");
	}

	// Cross-app child wedge: a still-RUNNING parent that is parked at a durable/run
	// node whose agent child is already DB-terminated (the cascade stopped it; no
	// runaway compute) but which a bare terminate/purge can never bring terminal.
	// We force-finalize ONLY on positive evidence — the parent's live currentNodeId
	// matches a terminated child's node — gated by the grace. This deliberately
	// will NOT fire for a parent that moved on to a later non-agent node (node
	// won't match) nor a still-booting sandbox (its session isn't DB-terminated, so
	// its node isn't listed) — the two false-positives a coarse boolean allowed.
	let wedged = false;
	if (!parentClosed && resolved.terminatedChildNodes.length > 0) {
		const nowMs = Date.now();
		for (let i = 0; i < resolved.parentInstanceIds.length; i++) {
			if (parentClosedFlags[i]) continue;
			const node =
				(await cascadeDeps.getParentCurrentNode?.(resolved.parentInstanceIds[i])) ?? null;
			if (
				shouldForceFinalizeCrossAppWedge({
					stopRequestedAt: resolved.stopRequestedAt,
					nowMs,
					graceMs: WEDGE_FINALIZE_GRACE_MS,
					parentCurrentNode: node,
					terminatedChildNodes: resolved.terminatedChildNodes,
					activeChildNodes: resolved.activeChildNodes,
				})
			) {
				wedged = true;
				break;
			}
		}
	}
	if (wedged) {
		console.warn(
			`confirmDurableStop: cross-app child wedge on ${target.kind} ${target.id} — ` +
				`agent child terminal but parent(s) [${resolved.parentInstanceIds.join(", ")}] ` +
				`stuck RUNNING; force-deleting parent durable state and finalizing`,
		);
		try {
			await cascadeDeps.purgeStateRows?.(
				resolved.parentInstanceIds,
				resolved.agentRuntimeTargets,
				resolved.statePurgeInstanceIds,
			);
		} catch (err) {
			console.warn(
				"confirmDurableStop: force state-row purge of wedged parent failed:",
				err instanceof Error ? err.message : err,
			);
		}
		const finalized = await finalizeConfirmedStop(
			resolved,
			"stop confirmed (cross-app wedge force-finalized)",
		);
		// Now that the state rows are gone the Dapr purge will 404 — best-effort.
		// Keep this after the DB finalize so a slow/unhealthy orchestrator purge
		// cannot leave an already-stopped child run stuck in "running".
		for (const id of resolved.parentInstanceIds) {
			try {
				await cascadeDeps.purgeParent(id);
			} catch {
				/* best-effort */
			}
		}
		return finalized;
	}

	return { state: "stopping", scope: resolved.scope };
}
