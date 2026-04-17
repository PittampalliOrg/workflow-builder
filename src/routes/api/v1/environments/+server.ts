import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	createEnvironment,
	listEnvironments,
	type CreateEnvironmentInput,
} from "$lib/server/environments/registry";
import {
	createDefaultEnvironmentConfig,
	type EnvironmentConfig,
} from "$lib/types/environments";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const q = url.searchParams.get("q") ?? undefined;
	const tag = url.searchParams.get("tag") ?? undefined;
	const includeArchived = url.searchParams.get("includeArchived") === "true";
	const environments = await listEnvironments({ q, tag, includeArchived });
	return json({ environments });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;

	const baseConfig = createDefaultEnvironmentConfig();
	const config = mergeConfig(baseConfig, body.config);

	const input: CreateEnvironmentInput = {
		slug: typeof body.slug === "string" ? body.slug : undefined,
		name:
			typeof body.name === "string" && body.name.trim()
				? body.name.trim()
				: "Untitled Environment",
		description: typeof body.description === "string" ? body.description : null,
		avatar: typeof body.avatar === "string" ? body.avatar : null,
		tags: Array.isArray(body.tags)
			? body.tags.map((t) => String(t))
			: undefined,
		createdBy: locals.session.userId,
		config,
	};

	const environment = await createEnvironment(input);
	return json({ environment }, { status: 201 });
};

function mergeConfig(base: EnvironmentConfig, patch: unknown): EnvironmentConfig {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
	return { ...base, ...(patch as Partial<EnvironmentConfig>) };
}
