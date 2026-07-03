import { getApplicationAdapters } from "$lib/server/application";
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
	if (names.length === 0) return out;

	const owners =
		await getApplicationAdapters().workflowData.listSandboxSessionOwners({
			sandboxNames: names,
		});
	for (const owner of owners) {
		out.set(owner.sandboxName, {
			id: owner.id,
			title: owner.title,
			status: owner.status,
			workspaceSlug: owner.workspaceSlug,
		});
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
