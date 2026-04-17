import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	archiveAgent,
	getAgent,
	updateAgent,
} from "$lib/server/agents/registry";
import type { AgentConfig, AgentRuntime } from "$lib/types/agents";

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
	const agent = await updateAgent(params.id, {
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
	if (!agent) return error(404, "Agent not found");
	return json({ agent });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await archiveAgent(params.id);
	if (!ok) return error(404, "Agent not found");
	return json({ archived: true });
};

function pickRuntime(value: unknown): AgentRuntime | undefined {
	if (value === "dapr-agent-py" || value === "dapr-agent-py-testing") {
		return value;
	}
	return undefined;
}
