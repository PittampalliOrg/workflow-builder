import { and, eq, ne, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import { sessions } from "$lib/server/db/schema";

export type SandboxActiveGuard = {
	/** A still-active (non-terminal) session is backed by this sandbox name. */
	active: boolean;
	/** Scope of the backing session (for CMA enforcement), null if none. */
	scope: { projectId: string | null; userId: string } | null;
};

/**
 * Is the named sandbox the runtime/workspace sandbox of a still-active (non-terminal)
 * session? Deleting such a Sandbox CR out-of-band yanks the pod from under a live
 * `session_workflow` — the DB↔Dapr divergence the lifecycle SSOT exists to prevent.
 *
 * The per-session route `DELETE /api/v1/sessions/[id]/sandbox` enforces this guard
 * by session id; the standalone `/api/sandboxes/*` surface has no session id, so it
 * must look the session up by sandbox NAME instead. Returns the backing session's
 * scope so the caller can also enforce CMA scope.
 */
export async function activeSessionForSandboxName(
	name: string,
): Promise<SandboxActiveGuard> {
	const trimmed = (name ?? "").trim();
	if (!db || !trimmed) return { active: false, scope: null };
	const [row] = await db
		.select({ projectId: sessions.projectId, userId: sessions.userId })
		.from(sessions)
		.where(
			and(
				ne(sessions.status, "terminated"),
				or(
					eq(sessions.runtimeSandboxName, trimmed),
					eq(sessions.workspaceSandboxName, trimmed),
				),
			),
		)
		.limit(1);
	if (!row) return { active: false, scope: null };
	return { active: true, scope: { projectId: row.projectId ?? null, userId: row.userId } };
}
