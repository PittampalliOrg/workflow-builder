import { getApplicationAdapters } from "$lib/server/application";
import {
	getRuntimeDescriptor,
} from "$lib/server/agents/runtime-registry";
import { runtimeHasNativeGoalHarness } from "$lib/server/sessions/goal-harness";
export {
	decideGoalHarness,
	goalNativeByDefault,
	goalObjectiveRequestsNative,
	runtimeHasNativeGoalHarness,
	stripNativeGoalPrefix,
} from "$lib/server/sessions/goal-harness";

export type SessionRuntimeTarget = {
	appId: string;
	invokeTarget: string;
	runtimeSandboxName: string | null;
	source: "persisted" | "agent" | "legacy";
};

export async function resolveSessionRuntimeTarget(
	sessionId: string,
): Promise<SessionRuntimeTarget | null> {
	return getApplicationAdapters().workflowData.getSessionRuntimeTarget({
		sessionId,
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
	return getApplicationAdapters().workflowData.getSessionRuntimeDebugTarget({
		sessionId,
		projectId,
	});
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
