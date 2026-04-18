import { query } from '$app/server';
import { asc, eq, inArray, or } from 'drizzle-orm';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import { normalizeSandboxResponse } from '$lib/utils/sandbox-parse';
import { listAgentRuntimeSandboxes } from '$lib/server/agent-runtime-sandboxes';
import { db } from '$lib/server/db';
import { projects, sessions } from '$lib/server/db/schema';
import type { Sandbox } from '$lib/types/sandbox';

/**
 * Resolve owning-session metadata for the sandbox names in `names`.
 * Returns a map keyed by sandbox name → { sessionId, title, status, slug }.
 *
 * Both `workspace_sandbox_name` (per-session OpenShell `ws-*`) and the
 * shared `sandbox_name` (agent-runtime pod) are joined. Using a raw IN
 * (...) fragment so the query is stable across drizzle versions —
 * earlier attempts with `or(inArray, inArray)` returned empty rows.
 */
async function resolveSandboxSessions(
	names: string[],
): Promise<Map<string, NonNullable<Sandbox['session']>>> {
	const out = new Map<string, NonNullable<Sandbox['session']>>();
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
	console.log(
		'[sandbox-session-join] names=' +
			JSON.stringify(names) +
			' rows=' +
			rows.length,
	);

	// Last write wins when a sandbox is reused — gives the most recent owner.
	for (const r of rows) {
		const record = {
			id: r.id,
			title: r.title ?? null,
			status: r.status,
			workspaceSlug: r.externalId ?? 'default',
		};
		if (r.workspaceSandboxName) out.set(r.workspaceSandboxName, record);
		if (r.sandboxName) out.set(r.sandboxName, record);
	}
	return out;
}

export const getSandboxes = query(async (): Promise<Sandbox[]> => {
	const [openshellResult, runtimeResult] = await Promise.allSettled([
		openshellRuntimeFetch('/api/v1/sandboxes'),
		listAgentRuntimeSandboxes(),
	]);
	const openshellSandboxes =
		openshellResult.status === 'fulfilled' && openshellResult.value.ok
			? normalizeSandboxResponse(await openshellResult.value.json())
			: [];
	const runtimeSandboxes =
		runtimeResult.status === 'fulfilled' ? runtimeResult.value : [];

	const all: Sandbox[] = [...openshellSandboxes, ...runtimeSandboxes];
	if (all.length === 0) return all;

	const sessionsByName = await resolveSandboxSessions(all.map((s) => s.name));
	return all.map((s) => ({
		...s,
		session: sessionsByName.get(s.name) ?? null,
	}));
});
