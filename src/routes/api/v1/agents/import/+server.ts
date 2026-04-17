import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createAgent } from "$lib/server/agents/registry";
import { parseAgentMarkdown } from "$lib/server/agents/markdown";
import { listEnvironments } from "$lib/server/environments/registry";
import { listVaults } from "$lib/server/vaults/registry";

/**
 * Import an agent from a `.md` file with YAML frontmatter. Request body:
 *   { source: "---\nname: ...\n---\nBody..." }
 *
 * Resolves `environment` (by slug or id) and `vaults` (by id) on the host,
 * attaching to the created agent. Failures are non-fatal: an unresolved
 * environment/vault is dropped with a warning in the response.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const source = typeof body.source === "string" ? body.source : "";
	if (!source) return error(400, "source (markdown) is required");

	let parsed: ReturnType<typeof parseAgentMarkdown>;
	try {
		parsed = parseAgentMarkdown(source);
	} catch (err) {
		return error(
			400,
			err instanceof Error ? err.message : "Failed to parse markdown",
		);
	}

	const warnings: string[] = [];

	let environmentId: string | undefined;
	let environmentVersion: number | undefined;
	if (parsed.environmentRef) {
		const envs = await listEnvironments({ includeArchived: false });
		const match =
			envs.find((e) => e.id === parsed.environmentRef) ??
			envs.find((e) => e.slug === parsed.environmentRef);
		if (match) {
			environmentId = match.id;
			environmentVersion = match.currentVersion ?? undefined;
		} else {
			warnings.push(`environment '${parsed.environmentRef}' not found; skipped`);
		}
	}

	let vaultIds: string[] = [];
	if (parsed.vaultRefs && parsed.vaultRefs.length > 0) {
		const vaults = await listVaults({ includeArchived: false });
		const byId = new Set(vaults.map((v) => v.id));
		const byName = new Map(vaults.map((v) => [v.name, v.id]));
		for (const ref of parsed.vaultRefs) {
			if (byId.has(ref)) {
				vaultIds.push(ref);
			} else if (byName.has(ref)) {
				vaultIds.push(byName.get(ref)!);
			} else {
				warnings.push(`vault '${ref}' not found; skipped`);
			}
		}
	}

	const agent = await createAgent({
		name: parsed.name,
		description: parsed.description ?? null,
		config: parsed.config,
		runtime: parsed.runtime ?? "dapr-agent-py",
		environmentId: environmentId ?? null,
		environmentVersion: environmentVersion ?? null,
		defaultVaultIds: vaultIds,
		createdBy: locals.session.userId,
	});

	return json({ agent, warnings }, { status: 201 });
};
