import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	AgentConfigValidationError,
	archiveAgent,
	getAgent,
	updateAgent,
} from "$lib/server/agents/registry";
import type { AgentConfig, AgentRuntime } from "$lib/types/agents";
import { listRuntimeIds } from "$lib/server/agents/runtime-registry";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const agent = await getAgent(params.id);
	if (!agent) return error(404, "Agent not found");
	return json({ agent });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const runtime = pickRuntime(body.runtime);
	let agent;
	try {
		agent = await updateAgent(params.id, {
			name: typeof body.name === "string" ? body.name : undefined,
			description:
				typeof body.description === "string" || body.description === null
					? (body.description as string | null)
					: undefined,
			avatar:
				typeof body.avatar === "string" || body.avatar === null
					? (body.avatar as string | null)
					: undefined,
			tags: Array.isArray(body.tags)
				? body.tags.map((t) => String(t))
				: undefined,
			runtime,
			environmentId:
				typeof body.environmentId === "string" || body.environmentId === null
					? (body.environmentId as string | null)
					: undefined,
			environmentVersion:
				typeof body.environmentVersion === "number" ||
				body.environmentVersion === null
					? (body.environmentVersion as number | null)
					: undefined,
			defaultVaultIds: Array.isArray(body.defaultVaultIds)
				? body.defaultVaultIds.map((v) => String(v))
				: undefined,
			config:
				body.config && typeof body.config === "object"
					? (body.config as AgentConfig)
					: undefined,
			changelog:
				typeof body.changelog === "string" ? body.changelog : undefined,
			publishedBy: locals.session.userId,
		});
	} catch (e) {
		if (e instanceof AgentConfigValidationError) return error(400, e.message);
		throw e;
	}
	if (!agent) return error(404, "Agent not found");
	return json({ agent });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await archiveAgent(params.id);
	if (!ok) return error(404, "Agent not found");
	return json({ archived: true });
};

// Registry-driven (parity with the create path): any registered runtime id is
// a valid agent runtime, incl. the interactive-cli family.
function pickRuntime(value: unknown): AgentRuntime | undefined {
	if (typeof value === "string" && listRuntimeIds().includes(value)) {
		return value as AgentRuntime;
	}
	return undefined;
}
