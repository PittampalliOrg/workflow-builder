/**
 * Session classification for the dedicated Sessions list (Track 2). One pure
 * function so the list page, the kind filter, and the session-detail badge all
 * agree on what a session "is". Four kinds, most-specific-first:
 *
 *   dev         — a Microservice dev-session run (workflowId resolves to the
 *                 `microservice-dev-session` template; see workflow-data.ts
 *                 `getDevPreviewHubReadModel`). Checked first because a dev
 *                 session is also a workflow session.
 *   experiment  — a forked/tweaked agent (slug `exp-…`), matching the
 *                 session-detail right-rail badge.
 *   workflow    — spawned by a workflow run (has a workflow execution).
 *   interactive — a direct session (the default).
 */
export type SessionKind = "interactive" | "workflow" | "experiment" | "dev";

/** The dev-session workflow template id (mirrors the private constant in
 * workflow-data.ts). A project-forked dev workflow resolves to a distinct id,
 * so callers pass that resolved id too — either match classifies as dev. */
export const DEV_SESSION_WORKFLOW_ID = "microservice-dev-session";

export type SessionKindInput = {
	workflowId?: string | null;
	workflowExecutionId?: string | null;
	agentSlug?: string | null;
};

export function classifySessionKind(
	session: SessionKindInput,
	devWorkflowId?: string | null,
): SessionKind {
	const workflowId = session.workflowId ?? null;
	if (
		workflowId &&
		(workflowId === DEV_SESSION_WORKFLOW_ID ||
			(devWorkflowId != null && workflowId === devWorkflowId))
	) {
		return "dev";
	}
	if (session.agentSlug?.startsWith("exp-")) {
		return "experiment";
	}
	if (session.workflowExecutionId || workflowId) {
		return "workflow";
	}
	return "interactive";
}

export const SESSION_KINDS: readonly SessionKind[] = [
	"interactive",
	"workflow",
	"experiment",
	"dev",
] as const;

export function isSessionKind(value: string): value is SessionKind {
	return (SESSION_KINDS as readonly string[]).includes(value);
}
