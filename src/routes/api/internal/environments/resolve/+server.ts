import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
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
		return json({ error: "Invalid or missing internal token" }, { status: 401 });
	}

	try {
		const { environment: env } =
			await getApplicationAdapters().environments.resolveRuntimeBySlug({
				slug: url.searchParams.get("slug"),
			});

		return json({
			id: env.id,
			slug: env.slug,
			version: env.version,
			imageTag: env.imageTag,
			imageSource: env.imageSource ?? "stored",
			imageResolutionWarning: env.imageResolutionWarning ?? null,
			baseEnvSlug: env.baseEnvSlug,
			sandboxMode: env.config.sandboxMode,
			keepAfterRun: env.config.keepAfterRun,
			ttlSeconds: env.config.ttlSeconds ?? null,
			networking: env.config.networking,
			capabilities: env.config.capabilities ?? [],
		});
	} catch (err) {
		const maybe = err as { status?: unknown; message?: unknown };
		const status = typeof maybe.status === "number" ? maybe.status : 500;
		const message =
			typeof maybe.message === "string"
				? maybe.message
				: "Failed to resolve environment";
		return json({ error: message }, { status });
	}
};
