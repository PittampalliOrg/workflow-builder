/**
 * Resolve a GitHub token for workflow-driven CLI sessions + cliWorkspace steps.
 *
 * Picks the first ACTIVE github app-connection (else the first) and extracts the
 * bearer/token value from its decrypted SCM Authorization header. Used to inject
 * GITHUB_TOKEN into interactive-cli pods so `git clone`/`git push`/PR-open
 * commands authenticate against private repos. Fail-open: returns null on any
 * error so a missing/unconfigured connection never hard-blocks a run.
 */
import { env } from "$env/dynamic/private";
import { listAppConnections } from "$lib/server/app-connections";
import { getScmConnection } from "$lib/server/scm-connections";

/** Pod-level PAT fallback (from `workflow-builder-secrets`, key `GITHUB_TOKEN`). */
function envGithubToken(): string | null {
	const t = (env.GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
	return t || null;
}

export async function resolveWorkflowGithubToken(): Promise<string | null> {
	try {
		const conns = await listAppConnections({ pieceName: "github" });
		const chosen = conns.find((c) => c.status === "ACTIVE") ?? conns[0];
		if (chosen) {
			const scm = await getScmConnection(chosen.externalId);
			const token = (scm?.headers?.Authorization ?? "")
				.replace(/^Bearer\s+/i, "")
				.replace(/^token\s+/i, "")
				.trim();
			if (token) return token;
		}
	} catch {
		/* fall through to the env PAT */
	}
	// No usable app-connection (e.g. a Tier-2 preview's fresh DB has none) → fall
	// back to the BFF process PAT. The preview's `workflow-builder-secrets` carries
	// `GITHUB_TOKEN` (staged verbatim) and the BFF envFroms it, so promote works
	// in-preview without an app-connection.
	return envGithubToken();
}
