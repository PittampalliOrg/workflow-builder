import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { resolveEnvironmentBySlug } from "$lib/server/environments/registry";
import { validateInternalToken } from "$lib/server/internal-auth";

/**
 * Workspace-agnostic environment resolver for the openshell-agent-runtime.
 *
 * The Python pod used to carry hardcoded `DEFAULT_SANDBOX_TEMPLATE_IMAGES` +
 * `SANDBOX_TEMPLATE_CAPABILITIES` dicts. Post-collapse, the BFF owns this
 * lookup: given an env slug, return the concrete imageTag + capabilities +
 * networking so the runtime can spawn the right sandbox.
 *
 * Authenticated via INTERNAL_API_TOKEN (same pattern as the connection
 * decrypt path). Builtins are global — no project scoping needed.
 */
export const GET: RequestHandler = async ({ url, request }) => {
	if (!validateInternalToken(request)) {
		return error(401, "Invalid or missing internal token");
	}
	const slug = url.searchParams.get("slug")?.trim();
	if (!slug) return error(400, "slug query param required");

	const env = await resolveEnvironmentBySlug(slug);
	if (!env) return error(404, `Environment "${slug}" not found`);

	return json({
		id: env.id,
		slug: env.slug,
		version: env.version,
		imageTag: env.imageTag,
		baseEnvSlug: env.baseEnvSlug,
		sandboxMode: env.config.sandboxMode,
		keepAfterRun: env.config.keepAfterRun,
		ttlSeconds: env.config.ttlSeconds ?? null,
		networking: env.config.networking,
		capabilities: env.config.capabilities ?? [],
	});
};
