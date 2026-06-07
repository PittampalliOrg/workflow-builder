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
import { deleteKubernetesSandbox } from "$lib/server/kube/client";
import { raiseSessionEvent } from "$lib/server/sessions/control";
import {
	createDaprCascadeDeps,
	type DurableCascadeResult,
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
	scope: DurableTargetScope | null;
	cascade?: DurableCascadeResult;
	steps: StopDurableRunStep[];
};

// One shared deps instance — generic Dapr-backed orchestrator + agent-runtime ops.
const cascadeDeps = createDaprCascadeDeps();

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
		return { confirmed: false, notFound: true, scope: null, steps: [] };
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
			return { confirmed: r.ok, notFound: false, scope: resolved.scope, steps };
		}
		for (const p of resolved.parentInstanceIds) {
			const r = await cascadeDeps.cancelParent?.(p, reason);
			steps.push({
				name: `interrupt:workflow:${p}`,
				result: r === "failed" ? "failed" : "ok",
				detail: r,
			});
		}
		return {
			confirmed: steps.every((s) => s.result !== "failed"),
			notFound: false,
			scope: resolved.scope,
			steps,
		};
	}

	const purge = opts.mode === "purge" || opts.mode === "reset";
	const graceMs = Math.max(0, opts.graceMs ?? 0);
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

	// Fail-closed: if the durable tree did not confirm terminal, leave DB rows +
	// sandboxes intact for a retry rather than lie about success.
	if (!cascade.allClosed) {
		return { confirmed: false, notFound: false, scope: resolved.scope, cascade, steps };
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

	return {
		confirmed: reapOk && dbOk,
		notFound: false,
		scope: resolved.scope,
		cascade,
		steps,
	};
}
