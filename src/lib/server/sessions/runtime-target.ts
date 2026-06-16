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
 * (claude-code-cli / codex-cli / agy-cli). These runtimes drive their OWN
 * native `/goal` loop inside the vendor CLI, so the BFF custom goal-loop
 * driver + goal MCP auto-wire are bypassed for them — see
 * `src/lib/server/goals/goal-loop.ts` and the session goal API. Non-CLI
 * runtimes (dapr-agent-py, etc.) keep the custom goal loop.
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
// loop + completion evaluator/marker we can detect). Antigravity's `/goal` is a
// thin command with no detectable completion, so agy is driven by OUR
// codex-parity custom goal loop + goal MCP instead (like dapr-agent-py).
const NATIVE_GOAL_CLI_ADAPTERS = new Set(["claude-code", "codex"]);

/** Pure descriptor check: does this runtime drive its OWN native `/goal`?
 *  interactive-cli AND a native-goal adapter (claude-code/codex) — NOT agy. */
export function runtimeUsesNativeGoal(
	descriptor: { family?: string; cliAdapter?: string } | null | undefined,
): boolean {
	return (
		descriptor?.family === "interactive-cli" &&
		!!descriptor.cliAdapter &&
		NATIVE_GOAL_CLI_ADAPTERS.has(descriptor.cliAdapter)
	);
}

/** True when the session's goal should be driven by the vendor CLI's native
 *  `/goal` (claude/codex). False for agy + all non-CLI runtimes, which use the
 *  custom codex-parity BFF goal loop + goal MCP completion contract. */
export async function sessionUsesNativeGoal(sessionId: string): Promise<boolean> {
	const target = await resolveSessionRuntimeDebugTarget(sessionId);
	if (!target) return false;
	return runtimeUsesNativeGoal(getRuntimeDescriptor(target.agentRuntime));
}
