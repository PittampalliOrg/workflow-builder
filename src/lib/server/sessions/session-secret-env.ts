import { error } from "@sveltejs/kit";
import { getUserCliCredential } from "$lib/server/users/cli-credentials";
import { resolveWorkflowGithubToken } from "$lib/server/workflows/github-token";
import type { RuntimeDescriptor } from "$lib/server/agents/runtime-registry";

/**
 * Resolve the per-session secret env for a workflow-driven agent session.
 *
 * Shared by the workflow→session bridge (`ensure-for-workflow`) AND identity-bound
 * prewarm (`prewarm.ts`) so a prewarmed CLI pod is created with a BYTE-IDENTICAL
 * credential Secret to the one the real spawn would create — the per-session
 * Secret is baked at Sandbox creation and adoption does NOT re-write it, so any
 * divergence would leave the adopted pod with stale/missing creds.
 *
 * For non-interactive runtimes (dapr-agent-py: model creds are LLM-gateway-side)
 * this returns null. For interactive-cli runtimes it injects ONLY the runtime's
 * `cliAuth.envVar` (the user's linked subscription token) + a best-effort
 * GITHUB_TOKEN for git remotes — never ANTHROPIC_API_KEY (the CLI-billing
 * invariant is preserved by construction). Throws HTTP 412 when the user has no
 * linked / a stale credential (callers in the request path surface it; prewarm
 * swallows it best-effort and lets the real spawn surface the 412).
 */
export async function resolveWorkflowSessionSecretEnv(params: {
	userId: string;
	runtimeDescriptor: RuntimeDescriptor | undefined | null;
}): Promise<Record<string, string> | null> {
	const descriptor = params.runtimeDescriptor;
	const cliAuth = descriptor?.capabilities?.interactiveTerminal
		? descriptor.cliAuth
		: undefined;
	if (!cliAuth) return null;
	const runtimeId = descriptor?.id ?? "unknown-runtime";
	const { provider, envVar, setupCommand, credentialKind } = cliAuth;
	if (!envVar) {
		throw error(
			500,
			`Runtime "${runtimeId}" cliAuth.credentialKind=${credentialKind} requires an envVar`,
		);
	}
	const setupHint = setupCommand
		? `run \`${setupCommand}\` locally`
		: "see the runtime docs";
	if (credentialKind === "device_login") {
		throw error(
			412,
			`Runtime "${runtimeId}" requires an interactive device-code login and cannot run as an automated workflow step. Link a reusable CLI credential first (${setupHint}).`,
		);
	}
	const credential = await getUserCliCredential(params.userId, provider);
	if (!credential) {
		throw error(
			412,
			`No ${provider} CLI credential linked for this user. Add one under Settings -> CLI tokens (${setupHint}) before using "${runtimeId}" in a workflow.`,
		);
	}
	if (
		credentialKind !== "file_bundle" &&
		credential.expiresAt &&
		credential.expiresAt.getTime() < Date.now()
	) {
		throw error(
			412,
			`The linked ${provider} CLI credential has expired. Re-enroll under Settings -> CLI tokens (${setupHint}) before using "${runtimeId}" in a workflow.`,
		);
	}
	const secretEnv: Record<string, string> = { [envVar]: credential.token };
	// Auto-inject the user's GitHub token so cli coding workflows can clone a
	// private repo + push/open a PR from inside the agent's /sandbox/work (the cli
	// pod has no other way to get an authenticated git remote, and a cliWorkspace
	// clone can't run before any cli pod exists). GITHUB_TOKEN is a git credential,
	// NOT the LLM key — the ANTHROPIC_API_KEY exclusion is unaffected. Best-effort;
	// absent when the user has no GitHub connection.
	const ghToken = await resolveWorkflowGithubToken();
	if (ghToken) secretEnv.GITHUB_TOKEN = ghToken;
	return secretEnv;
}
