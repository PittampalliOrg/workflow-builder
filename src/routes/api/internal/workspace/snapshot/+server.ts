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
 * POST /api/internal/workspace/snapshot
 *
 * Node-boundary workspace snapshot (durability phase 3). Called by the orchestrator's
 * `snapshot_workspace_node` activity as each top-level node of a resumable run completes.
 * Proxies to sandbox-execution-api `/internal/cli-workspace/snapshots`, which starts a
 * short CoW-clone Job that snapshots the run's shared workspace into `.snapshots/<key>/<id>`.
 * Fire-and-forget on the caller side: returns immediately with the Job name (no polling).
 *
 * `?prune` proxies to the SEA prune endpoint: body { sharedWorkspaceKey, keep?, all? }.
 * Internal-token only.
 */
export const POST: RequestHandler = async ({ request, url }) => {
	requireInternal(request);
	const baseUrl = sandboxBaseUrl();
	const token =
		env.SANDBOX_EXECUTION_API_TOKEN ?? process.env.SANDBOX_EXECUTION_API_TOKEN ?? "";
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

	const isPrune = url.searchParams.has("prune");
	const key =
		typeof body.sharedWorkspaceKey === "string" ? body.sharedWorkspaceKey.trim() : "";
	if (!key) throw error(400, "sharedWorkspaceKey required");

	if (!baseUrl) {
		// No sandbox-execution-api configured (e.g. non-kueue backend) → nothing to do.
		return json({ ok: true, skipped: "no_sandbox_execution_api" });
	}

	const target = isPrune
		? `${baseUrl}/internal/cli-workspace/snapshots/prune`
		: `${baseUrl}/internal/cli-workspace/snapshots`;
	const payload: Record<string, unknown> = isPrune
		? {
				sharedWorkspaceKey: key,
				keep: Array.isArray(body.keep) ? body.keep : undefined,
				all: body.all === true,
				executionId: typeof body.executionId === "string" ? body.executionId : undefined,
			}
		: {
				sharedWorkspaceKey: key,
				snapshotId: typeof body.snapshotId === "string" ? body.snapshotId.trim() : "",
				executionId: typeof body.executionId === "string" ? body.executionId : undefined,
			};
	if (!isPrune && !payload.snapshotId) throw error(400, "snapshotId required");

	let res: Response;
	try {
		res = await fetch(target, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : "Failed to reach sandbox-execution-api");
	}
	const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) throw error(res.status, (out.detail as string) ?? "snapshot failed");
	return json({ ok: true, ...out });
};
