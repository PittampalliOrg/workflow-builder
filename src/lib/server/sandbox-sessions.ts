import { asc, eq, inArray, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import { projects, sessions } from "$lib/server/db/schema";
import type { Sandbox } from "$lib/types/sandbox";

/**
 * Resolve the owning session for each sandbox name.
 *
 * Joins sessions where `workspace_sandbox_name` or `sandbox_name` matches
 * any name in the batch, returning a map keyed by the sandbox name. For
 * shared runtime pods (e.g. `dapr-agent-py`) that back many sessions the
 * last-write-wins rule picks the most-recently-updated session.
 */
export async function resolveSandboxSessions(
	names: string[],
): Promise<Map<string, NonNullable<Sandbox["session"]>>> {
	const out = new Map<string, NonNullable<Sandbox["session"]>>();
	if (!db || names.length === 0) return out;

	const rows = await db
		.select({
			id: sessions.id,
			title: sessions.title,
			status: sessions.status,
			workspaceSandboxName: sessions.workspaceSandboxName,
			sandboxName: sessions.sandboxName,
			externalId: projects.externalId,
		})
		.from(sessions)
		.leftJoin(projects, eq(projects.id, sessions.projectId))
		.where(
			or(
				inArray(sessions.workspaceSandboxName, names),
				inArray(sessions.sandboxName, names),
			),
		)
		.orderBy(asc(sessions.updatedAt));

	for (const r of rows) {
		const record = {
			id: r.id,
			title: r.title ?? null,
			status: r.status,
			workspaceSlug: r.externalId ?? "default",
		};
		if (r.workspaceSandboxName) out.set(r.workspaceSandboxName, record);
		if (r.sandboxName) out.set(r.sandboxName, record);
	}
	return out;
}

/** Attach `session` to each sandbox based on the joined lookup. */
export async function attachSandboxSessions(
	sandboxes: Sandbox[],
): Promise<Sandbox[]> {
	if (sandboxes.length === 0) return sandboxes;
	const byName = await resolveSandboxSessions(sandboxes.map((s) => s.name));
	return sandboxes.map((s) => ({ ...s, session: byName.get(s.name) ?? null }));
}
