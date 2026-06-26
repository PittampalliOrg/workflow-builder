import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";
import { requireInternal } from "$lib/server/internal-auth";

/**
 * POST /api/internal/workspace/seed
 *
 * Hermetic fork: seed a fork's fresh JuiceFS workspace from the source run's subPath.
 * Called by the orchestrator's `seed_workspace` activity (before the first resumed
 * node) — it knows both keys. Proxies to sandbox-execution-api `/internal/workspace/
 * seed-data`, which runs a synchronous copy Job. Internal-token only.
 * Body: { workspaceExecutionId, seedWorkspaceFrom, executionClass? }.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const dest = typeof body.workspaceExecutionId === "string" ? body.workspaceExecutionId.trim() : "";
	const source = typeof body.seedWorkspaceFrom === "string" ? body.seedWorkspaceFrom.trim() : "";
	if (!dest || !source) {
		throw error(400, "workspaceExecutionId + seedWorkspaceFrom required");
	}

	const baseUrl = (
		env.SANDBOX_EXECUTION_API_URL ??
		process.env.SANDBOX_EXECUTION_API_URL ??
		""
	).replace(/\/$/, "");
	if (!baseUrl) {
		// No sandbox-execution-api configured (e.g. non-kueue backend) → nothing to seed.
		return json({ ok: true, skipped: "no_sandbox_execution_api" });
	}
	const token = env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";

	let res: Response;
	try {
		res = await fetch(`${baseUrl}/internal/workspace/seed-data`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({
				workspaceExecutionId: dest,
				seedWorkspaceFrom: source,
				executionClass: typeof body.executionClass === "string" ? body.executionClass : undefined,
			}),
			// seed-data waits for the copy Job synchronously.
			signal: AbortSignal.timeout(150_000),
		});
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : "Failed to reach sandbox-execution-api");
	}
	const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		throw error(res.status, (payload.detail as string) ?? "seed failed");
	}
	return json({ ok: true, ...payload });
};
