import { json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

/**
 * POST /api/internal/agent-runtimes/reap-idle
 *
 * Idle-reaper for the upstream `SandboxWarmPool`-backed agents (browser/
 * Playwright). For every pool with `spec.replicas > 0`, query the DB for
 * any session of the same agent slug that's either currently `running` or
 * has been touched within `idleTtlSeconds`. If none, patch the pool's
 * replicas back to 0.
 *
 * Driven by the `agent-runtime-idle-reaper` CronJob (every 5 min). Auth via
 * `INTERNAL_API_TOKEN` like the rest of the internal control-plane endpoints.
 */

function idleTtlSeconds(): number {
	const raw = (
		env.AGENT_RUNTIME_IDLE_TTL_SECONDS ??
		process.env.AGENT_RUNTIME_IDLE_TTL_SECONDS ??
		"1800"
	).trim();
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 60) return 1800;
	return Math.min(86_400, parsed);
}

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);

	const ttlSeconds = idleTtlSeconds();
	const namespace =
		env.AGENT_RUNTIME_NAMESPACE ??
		process.env.AGENT_RUNTIME_NAMESPACE ??
		"workflow-builder";

	return json(
		await getApplicationAdapters().agentRuntimeControl.reapIdle({
			namespace,
			ttlSeconds,
		}),
	);
};
