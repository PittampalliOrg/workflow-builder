import type { WorkflowWorkspaceSnapshotPort } from "$lib/server/application/ports";
import { createJuiceFsWebdavClient } from "$lib/server/workflows/juicefs-webdav";
import { resolveJuiceFsWebdavPassword } from "$lib/server/application/adapters/workflow-execution-workspace";

/**
 * Lists node-boundary workspace snapshots by reading the juicefs-webdav gateway
 * directly (`.snapshots/<key>/` under the wfbcli filesystem root). The BFF already
 * holds credentialed webdav access (the run-page Files tab uses the same gateway),
 * so the resume/fork path reads snapshots here rather than round-tripping through
 * sandbox-execution-api — one fewer hop and no second credential to provision. SEA
 * still owns snapshot CREATE/PRUNE (which require Jobs); this is a pure read.
 *
 * Never throws: any gateway error surfaces as an empty list so the resume path
 * falls back to end-state seeding instead of failing the fork.
 */
export class JuiceFsWorkflowWorkspaceSnapshotAdapter
	implements WorkflowWorkspaceSnapshotPort
{
	private readonly client;

	constructor(config: Record<string, string | undefined> = process.env) {
		this.client = createJuiceFsWebdavClient({
			baseUrl: config.JUICEFS_WEBDAV_URL,
			username: config.JUICEFS_WEBDAV_USER ?? "wfbwebdav",
			password: resolveJuiceFsWebdavPassword({
				password: config.JUICEFS_WEBDAV_PASSWORD,
				databaseUrl: config.DATABASE_URL,
			}),
		});
	}

	async listSnapshots(workspaceKey: string): Promise<string[]> {
		const key = (workspaceKey ?? "").trim();
		if (!key) return [];
		try {
			return await this.client.listSnapshots(key);
		} catch (err) {
			console.warn("[workspace-snapshots] webdav list failed:", err);
			return [];
		}
	}
}
