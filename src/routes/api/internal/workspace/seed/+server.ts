import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";
import { requireInternal } from "$lib/server/internal-auth";

function sandboxBaseUrl(): string {
	return (env.SANDBOX_EXECUTION_API_URL ?? process.env.SANDBOX_EXECUTION_API_URL ?? "").replace(
		/\/$/,
		"",
	);
}

/**
 * POST /api/internal/workspace/seed
 *
 * Hermetic fork: START an async CoW-clone Job that seeds a fork's fresh JuiceFS workspace
 * from the source run's subPath. Called by the orchestrator's `seed_workspace` activity
 * (before the first resumed node) — it knows both keys. Proxies to sandbox-execution-api
 * `/internal/workspace/seed-data`, which returns IMMEDIATELY with a Job name; the
 * orchestrator then polls `?status` (below) until done. Internal-token only.
 * Body: { workspaceExecutionId, seedWorkspaceFrom, executionClass? }.
 */
export const POST: RequestHandler = async ({ request, url }) => {
	requireInternal(request);
	const baseUrl = sandboxBaseUrl();
	const token =
		env.SANDBOX_EXECUTION_API_TOKEN ?? process.env.SANDBOX_EXECUTION_API_TOKEN ?? "";

	// `?status` → poll an in-flight seed Job: body { job, namespace? }.
	if (url.searchParams.has("status")) {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const jobName = typeof body.job === "string" ? body.job.trim() : "";
		if (!jobName) throw error(400, "job required");
		if (!baseUrl) return json({ ok: true, done: true, succeeded: true, skipped: "no_sandbox_execution_api" });
		let res: Response;
		try {
			res = await fetch(`${baseUrl}/internal/workspace/seed-data/status`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify({ job: jobName, namespace: body.namespace }),
				signal: AbortSignal.timeout(20_000),
			});
		} catch (err) {
			throw error(502, err instanceof Error ? err.message : "Failed to reach sandbox-execution-api");
		}
		const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok) throw error(res.status, (payload.detail as string) ?? "seed status failed");
		return json({ ok: true, ...payload });
	}

	// Start a seed.
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const dest = typeof body.workspaceExecutionId === "string" ? body.workspaceExecutionId.trim() : "";
	const source = typeof body.seedWorkspaceFrom === "string" ? body.seedWorkspaceFrom.trim() : "";
	if (!dest || !source) {
		throw error(400, "workspaceExecutionId + seedWorkspaceFrom required");
	}
	if (!baseUrl) {
		// No sandbox-execution-api configured (e.g. non-kueue backend) → nothing to seed.
		return json({ ok: true, skipped: "no_sandbox_execution_api", done: true });
	}

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
			// Now returns immediately (just creates the Job).
			signal: AbortSignal.timeout(30_000),
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
