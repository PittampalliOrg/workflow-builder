import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { BUILTIN_AGENT_PROFILES } from "$lib/server/agent-profiles";
import {
	createAgent,
	listAgents,
	type CreateAgentInput,
} from "$lib/server/agents/registry";
import {
	createDefaultAgentConfig,
	type AgentConfig,
	type AgentRuntime,
} from "$lib/types/agents";
import { findTemplate } from "$lib/server/agent-templates/catalog";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const q = url.searchParams.get("q") ?? undefined;
	const tag = url.searchParams.get("tag") ?? undefined;
	const includeArchived = url.searchParams.get("includeArchived") === "true";
	const projectIdParam = url.searchParams.get("projectId");
	const projectId =
		projectIdParam === "null"
			? undefined
			: projectIdParam
				? projectIdParam
				: (locals.session.projectId ?? undefined);
	const agents = await listAgents({
		q,
		tag,
		includeArchived,
		projectId,
	});
	return json({ agents });
};

export const POST: RequestHandler = async ({ request, url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const templateSlug = url.searchParams.get("fromTemplate") ?? null;

	// Two template sources: (1) the new Quickstart template catalog (richer,
	// includes MCP server suggestions), (2) the legacy BUILTIN_AGENT_PROFILES
	// used by older `/agents/new` flows. Quickstart wins when the slug
	// matches there.
	const quickstartTemplate = templateSlug ? findTemplate(templateSlug) : null;
	const baseConfig = quickstartTemplate
		? quickstartTemplate.config
		: templateSlug
			? (applyBuiltinTemplate(templateSlug) ?? createDefaultAgentConfig())
			: createDefaultAgentConfig();
	const config = mergeConfig(baseConfig, body.config);
	const runtime = pickRuntime(body.runtime) ?? "dapr-agent-py";

	const input: CreateAgentInput = {
		slug: typeof body.slug === "string" ? body.slug : undefined,
		name:
			typeof body.name === "string" && body.name.trim()
				? body.name.trim()
				: "Untitled Agent",
		description: typeof body.description === "string" ? body.description : null,
		avatar: typeof body.avatar === "string" ? body.avatar : null,
		tags: Array.isArray(body.tags)
			? body.tags.map((t) => String(t))
			: undefined,
		runtime,
		sourceTemplateSlug: templateSlug,
		sourceTemplateVersion: templateSlug ? 1 : null,
		createdBy: locals.session.userId,
		projectId:
			typeof body.projectId === "string"
				? body.projectId
				: (locals.session.projectId ?? null),
		config,
	};

	const agent = await createAgent(input);
	return json({ agent }, { status: 201 });
};

function pickRuntime(value: unknown): AgentRuntime | undefined {
	if (value === "dapr-agent-py" || value === "dapr-agent-py-testing") {
		return value;
	}
	return undefined;
}

function applyBuiltinTemplate(slug: string): AgentConfig | null {
	const template = BUILTIN_AGENT_PROFILES.find(
		(p) => p.slug === slug || p.id === slug,
	);
	if (!template) return null;
	const defaults = createDefaultAgentConfig();
	return {
		...defaults,
		modelSpec: template.config.modelSpec,
		maxTurns: template.config.maxTurns ?? defaults.maxTurns,
		timeoutMinutes: template.config.timeoutMinutes ?? defaults.timeoutMinutes,
		builtinTools: template.config.builtinTools,
		mcpConnectionMode: template.config.mcpConnectionMode,
		mcpServers: template.config.mcpServers,
		skills: template.config.skills,
		runtimeOverridePolicy: template.config.runtimeOverridePolicy,
	};
}

function mergeConfig(base: AgentConfig, patch: unknown): AgentConfig {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
	return { ...base, ...(patch as Partial<AgentConfig>) };
}
