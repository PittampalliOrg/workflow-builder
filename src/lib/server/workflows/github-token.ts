/**
 * Resolve a GitHub token for workflow-driven CLI sessions + cliWorkspace steps.
 *
 * Picks the first ACTIVE github app-connection (else the first) and extracts the
 * bearer/token value from its decrypted SCM Authorization header. Used to inject
 * GITHUB_TOKEN into interactive-cli pods so `git clone`/`git push`/PR-open
 * commands authenticate against private repos. Fail-open: returns null on any
 * error so a missing/unconfigured connection never hard-blocks a run.
 */
import { listAppConnections } from "$lib/server/app-connections";
import { getScmConnection } from "$lib/server/scm-connections";

export async function resolveWorkflowGithubToken(): Promise<string | null> {
	try {
		const conns = await listAppConnections({ pieceName: "github" });
		const chosen = conns.find((c) => c.status === "ACTIVE") ?? conns[0];
		if (!chosen) return null;
		const scm = await getScmConnection(chosen.externalId);
		const token = (scm?.headers?.Authorization ?? "")
			.replace(/^Bearer\s+/i, "")
			.replace(/^token\s+/i, "")
			.trim();
		return token || null;
	} catch {
		return null;
	}
}
