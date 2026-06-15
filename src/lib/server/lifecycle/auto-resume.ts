/**
 * Auto-resume reconciler (Phase 2a) — recover a crashed interactive-cli session
 * WITHOUT a human clicking Resume.
 *
 * The lifecycle reaper observes sessions whose DB row is still non-terminal
 * while the backing sandbox/Dapr handle is already terminal/gone — i.e. a
 * NON-graceful exit (pod death, OOM, node failure, image-pin rollout). For the
 * CLI/JuiceFS family the conversation transcript is durable on a per-session
 * Postgres-backed JuiceFS subtree, so such a session can be auto-continued by
 * spawning a fresh pod that re-mounts the same subPath and runs `claude
 * --continue` (the same path manual Resume uses).
 *
 * This is gated behind a per-agent `autoResume` flag and a per-conversation
 * max-restart budget (derived from the resume lineage depth) so a
 * crash-looping session cannot respawn forever.
 *
 * `decideAutoResume` and `resolveAutoResumePolicy` are PURE (unit-tested);
 * `maybeAutoResumeSession` is the reaper-side integration that resolves the
 * agent, counts the lineage, decides, and (if eligible) spawns the continuation.
 */
import { isInteractiveCliRuntime } from "$lib/server/sessions/resume";

export const DEFAULT_MAX_AUTO_RESTARTS = 3;

export type AutoResumeRuntime = {
	family?: string;
	capabilities?: { interactiveTerminal?: boolean };
};

export type AutoResumeExit = {
	/** True when the session ended cleanly (clean end-of-turn / user stop). */
	graceful: boolean;
};

export type AutoResumeDecision = { shouldResume: boolean; reason: string };

/**
 * Pure decision: should the lifecycle reaper auto-spawn a continuation for this
 * dead session? Fires ONLY for an interactive-cli runtime that exited
 * non-gracefully, when the per-agent flag is on and the restart budget is not
 * yet exhausted.
 */
export function decideAutoResume(input: {
	runtime: AutoResumeRuntime | null | undefined;
	exit: AutoResumeExit;
	autoResumeEnabled: boolean;
	restartCount: number;
	maxRestarts: number;
}): AutoResumeDecision {
	if (!input.autoResumeEnabled) {
		return { shouldResume: false, reason: "auto_resume_disabled" };
	}
	if (!isInteractiveCliRuntime(input.runtime)) {
		return { shouldResume: false, reason: "not_interactive_cli" };
	}
	if (input.exit.graceful) {
		return { shouldResume: false, reason: "graceful_exit" };
	}
	const max = Number.isFinite(input.maxRestarts)
		? input.maxRestarts
		: DEFAULT_MAX_AUTO_RESTARTS;
	if (input.restartCount >= max) {
		return { shouldResume: false, reason: "restart_budget_exhausted" };
	}
	return { shouldResume: true, reason: "non_graceful_exit" };
}

/**
 * Read the per-agent auto-resume policy from the resolved agentConfig
 * (agentVersions.config JSONB). Opt-in: disabled unless `autoResume === true`.
 */
export function resolveAutoResumePolicy(
	agentConfig: Record<string, unknown> | null | undefined,
): { enabled: boolean; maxRestarts: number } {
	const cfg = (agentConfig ?? {}) as Record<string, unknown>;
	const enabled = cfg.autoResume === true;
	const rawMax = cfg.maxRestarts;
	const maxRestarts =
		typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 0
			? Math.floor(rawMax)
			: DEFAULT_MAX_AUTO_RESTARTS;
	return { enabled, maxRestarts };
}

/**
 * Count how many times this conversation has already been auto-resumed by
 * walking the `resumedFromSessionId` lineage back to its root. Bounded so a
 * cyclic/corrupt lineage can't loop. Pure over the injected getter.
 */
export async function countResumeLineageDepth(
	sessionId: string,
	getResumedFrom: (id: string) => Promise<string | null>,
	limit = 64,
): Promise<number> {
	let depth = 0;
	let cursor: string | null = sessionId;
	const seen = new Set<string>();
	while (cursor && depth < limit) {
		if (seen.has(cursor)) break;
		seen.add(cursor);
		const parent = await getResumedFrom(cursor);
		if (!parent) break;
		depth += 1;
		cursor = parent;
	}
	return depth;
}

// --- Integration (reaper-side; I/O) -----------------------------------------

export type AutoResumeSessionRow = {
	id: string;
	agentId: string;
	agentVersion: number | null;
	userId: string;
	projectId: string | null;
	title: string | null;
	resumedFromSessionId: string | null;
};

export type MaybeAutoResumeResult = {
	resumed: boolean;
	reason: string;
	newSessionId?: string;
};

export type AutoResumeDeps = {
	resolveAgent: (ref: {
		id: string;
		version?: number;
	}) => Promise<{ runtime: string; config: Record<string, unknown> } | null>;
	getRuntimeDescriptor: (runtime: string) => AutoResumeRuntime | null | undefined;
	getResumedFrom: (id: string) => Promise<string | null>;
	createSession: (input: {
		agentId: string;
		agentVersion?: number;
		userId: string;
		projectId: string | null;
		title?: string;
		resumedFromSessionId: string | null;
	}) => Promise<{ id: string }>;
	spawnSessionWorkflow: (sessionId: string) => Promise<unknown>;
};

/**
 * Reaper-side: for a dead (sandbox-gone) session, decide + (if eligible) spawn a
 * continuation. The exit is non-graceful by construction — a gracefully ended
 * session would already be `terminated` and not reach the reaper's stuck-session
 * purge. Best-effort: never throws into the reaper loop.
 */
export async function maybeAutoResumeSession(
	session: AutoResumeSessionRow,
	deps: AutoResumeDeps,
): Promise<MaybeAutoResumeResult> {
	try {
		const agent = await deps.resolveAgent({
			id: session.agentId,
			version: session.agentVersion ?? undefined,
		});
		if (!agent) return { resumed: false, reason: "agent_not_found" };
		const runtime = deps.getRuntimeDescriptor(agent.runtime);
		const policy = resolveAutoResumePolicy(agent.config);
		const restartCount = await countResumeLineageDepth(
			session.id,
			deps.getResumedFrom,
		);
		const decision = decideAutoResume({
			runtime,
			exit: { graceful: false },
			autoResumeEnabled: policy.enabled,
			restartCount,
			maxRestarts: policy.maxRestarts,
		});
		if (!decision.shouldResume) {
			return { resumed: false, reason: decision.reason };
		}
		const continuation = await deps.createSession({
			agentId: session.agentId,
			agentVersion: session.agentVersion ?? undefined,
			userId: session.userId,
			projectId: session.projectId,
			title: session.title ?? undefined,
			// Re-mount the SAME durable transcript subtree + launch `claude --continue`.
			resumedFromSessionId: session.id,
		});
		await deps.spawnSessionWorkflow(continuation.id);
		return { resumed: true, reason: decision.reason, newSessionId: continuation.id };
	} catch (err) {
		return {
			resumed: false,
			reason: `error:${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
