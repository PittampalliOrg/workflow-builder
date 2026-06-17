import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { agents, sessions } from "$lib/server/db/schema";
import { resolveAgentRef } from "$lib/server/agents/registry";
import {
	agentRuntimeDedicatedAppId,
	agentRuntimeInvokeTarget,
} from "$lib/server/agents/runtime-routing";
import { getSession } from "$lib/server/sessions/registry";
import {
	DEFAULT_RUNTIME_ID,
	getRuntimeDescriptor,
} from "$lib/server/agents/runtime-registry";

export type SessionRuntimeTarget = {
	appId: string;
	invokeTarget: string;
	runtimeSandboxName: string | null;
	source: "persisted" | "agent" | "legacy";
};

export async function resolveSessionRuntimeTarget(
	sessionId: string,
): Promise<SessionRuntimeTarget | null> {
	const session = await getSession(sessionId);
	if (!session) return null;
	if (session.runtimeAppId?.trim()) {
		return buildTarget({
			appId: session.runtimeAppId.trim(),
			runtimeSandboxName: session.runtimeSandboxName,
			source: "persisted",
		});
	}

	const agent = await resolveAgentRef({
		id: session.agentId,
		version: session.agentVersion ?? undefined,
	});
	if (agent) {
		return buildTarget({
			appId: agent.runtimeAppId ?? agentRuntimeDedicatedAppId(agent.slug),
			runtimeSandboxName: null,
			source: "agent",
		});
	}

	// Legacy fallback: the default runtime's app-id (== its registry id).
	return buildTarget({
		appId: DEFAULT_RUNTIME_ID,
		runtimeSandboxName: null,
		source: "legacy",
	});
}

export type SessionRuntimeDebugTarget = SessionRuntimeTarget & {
	agentSlug: string | null;
	/** The agent's configured runtime id (`agents.runtime`), used to look up
	 * the registry descriptor (e.g. for the interactive-terminal gate). */
	agentRuntime: string | null;
};

export async function resolveSessionRuntimeDebugTarget(
	sessionId: string,
	projectId?: string | null,
): Promise<SessionRuntimeDebugTarget | null> {
	if (!db) throw new Error("Database not configured");
	const conditions = [eq(sessions.id, sessionId)];
	if (projectId) conditions.push(eq(agents.projectId, projectId));
	const rows = await db
		.select({
			runtimeAppId: sessions.runtimeAppId,
			runtimeSandboxName: sessions.runtimeSandboxName,
			agentSlug: agents.slug,
			agentRuntime: agents.runtime,
			agentRuntimeAppId: agents.runtimeAppId,
		})
		.from(sessions)
		.innerJoin(agents, eq(agents.id, sessions.agentId))
		.where(and(...conditions))
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	const appId =
		row.runtimeAppId?.trim() ||
		row.agentRuntimeAppId?.trim() ||
		agentRuntimeDedicatedAppId(row.agentSlug);
	return {
		...buildTarget({
			appId,
			runtimeSandboxName: row.runtimeSandboxName ?? null,
			source: row.runtimeAppId?.trim() ? "persisted" : "agent",
		}),
		agentSlug: row.agentSlug,
		agentRuntime: row.agentRuntime ?? null,
	};
}

function buildTarget(params: {
	appId: string;
	runtimeSandboxName: string | null;
	source: SessionRuntimeTarget["source"];
}): SessionRuntimeTarget {
	return {
		appId: params.appId,
		invokeTarget: agentRuntimeInvokeTarget(params.appId),
		runtimeSandboxName: params.runtimeSandboxName,
		source: params.source,
	};
}

/**
 * True when a session's agent runs on an interactive-cli family runtime
 * (claude-code-cli / codex-cli / agy-cli).
 *
 * Resolves through the same descriptor the runtime-flags endpoint uses, so the
 * server-side decision matches the UI's `interactiveTerminal` gate exactly.
 */
export async function isInteractiveCliSession(
	sessionId: string,
): Promise<boolean> {
	const target = await resolveSessionRuntimeDebugTarget(sessionId);
	if (!target) return false;
	return getRuntimeDescriptor(target.agentRuntime)?.family === "interactive-cli";
}

// CLI adapters whose vendor CLI has a REAL native `/goal` harness (multi-turn
// loop + completion evaluator/marker). Antigravity's `/goal` is a thin command
// with no detectable completion, so agy has no native harness.
const NATIVE_GOAL_CLI_ADAPTERS = new Set(["claude-code", "codex"]);

/**
 * Goal-harness model (post-cutover): the EVALUATOR / BFF custom loop is the
 * DEFAULT for every runtime. The vendor CLI's native `/goal` is OPT-IN — chosen
 * only when the user prefixes the objective with `/goal ` AND the runtime
 * actually has a native harness (claude/codex). `GOAL_NATIVE_BY_DEFAULT=true`
 * restores the old descriptor-default (native for claude/codex) for rollback.
 */

/** Does this runtime have a native `/goal` harness *available*? (claude/codex
 *  interactive CLIs). This is a capability check — NOT "native is the default". */
export function runtimeHasNativeGoalHarness(
	descriptor: { family?: string; cliAdapter?: string } | null | undefined,
): boolean {
	return (
		descriptor?.family === "interactive-cli" &&
		!!descriptor.cliAdapter &&
		NATIVE_GOAL_CLI_ADAPTERS.has(descriptor.cliAdapter)
	);
}

/** Rollback switch: when true, claude/codex default back to native `/goal`. */
export function goalNativeByDefault(): boolean {
	return process.env.GOAL_NATIVE_BY_DEFAULT === "true";
}

/** The user explicitly asked for native `/goal` by prefixing the objective. */
export function goalObjectiveRequestsNative(objective: string): boolean {
	return /^\/goal(\s|$)/.test(objective.trimStart());
}

/** Strip a leading `/goal ` so the clean objective is reused in either mode. */
export function stripNativeGoalPrefix(objective: string): string {
	return objective.replace(/^\s*\/goal\s*/, "").trim();
}

/**
 * Single source of truth for the native-vs-evaluator decision, used by every
 * goal-setting surface (workflow bridge + one-off session API). Returns the
 * cleaned objective (prefix stripped) and whether to use the native harness.
 */
export function decideGoalHarness(
	rawObjective: string,
	hasNativeHarness: boolean,
): { native: boolean; objective: string } {
	const objective = stripNativeGoalPrefix(rawObjective);
	const native =
		hasNativeHarness &&
		(goalObjectiveRequestsNative(rawObjective) || goalNativeByDefault());
	return { native, objective };
}

/** Descriptor-based "is a native `/goal` harness available for this session?" —
 *  for the UI hint + the one-off goal API's set-time decision. Does NOT mean the
 *  session is currently in native mode (that's "no thread_goals row exists"). */
export async function sessionHasNativeGoalHarness(
	sessionId: string,
): Promise<boolean> {
	const target = await resolveSessionRuntimeDebugTarget(sessionId);
	if (!target) return false;
	return runtimeHasNativeGoalHarness(getRuntimeDescriptor(target.agentRuntime));
}
