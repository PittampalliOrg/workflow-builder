import { daprFetch, getWorkspaceRuntimeUrl } from "$lib/server/dapr-client";

export type SandboxProvisionResult = {
	sandboxName: string;
	workspaceRef: string | null;
	rootPath: string;
};

export type SandboxProvisionInput = {
	/** Logical scope id — use the session id for UI sessions so lifecycle
	 * matches and cleanup by execution id still works. */
	executionId: string;
	/** Human-readable label shown in the sandbox list. */
	name: string;
	/** Sandbox template slug: "base", "node-pnpm", "python", etc. Matches the
	 * catalog that openshell-agent-runtime accepts — `dapr-agent` and
	 * `dapr-agent-xlsx` are ours, anything else falls through to `base`. */
	sandboxTemplate?: string;
	/** TTL in seconds; 0 or undefined = keep until explicit cleanup. */
	ttlSeconds?: number;
	/** Root cwd inside the sandbox. Default `/sandbox`. */
	rootPath?: string;
	/** Keep the sandbox around after the first command completes. Always true
	 * for session sandboxes — they span many turns. */
	keepAfterRun?: boolean;
};

/**
 * Provision a per-session OpenShell sandbox via openshell-agent-runtime's
 * /api/workspaces/profile endpoint. Mirrors what the `workspace/profile`
 * workflow node does, but called directly from the BFF on UI session create
 * so agents spawned from `/sessions/new` also get a real sandbox for their
 * bash/file tools.
 *
 * Idempotent at the scope level: two calls with the same executionId return
 * the same sandbox (openshell-agent-runtime keys on executionId + name).
 * Safe to retry; safe to call on Dapr workflow replay.
 */
export async function provisionSessionSandbox(
	input: SandboxProvisionInput,
): Promise<SandboxProvisionResult> {
	const url = `${getWorkspaceRuntimeUrl()}/api/workspaces/profile`;
	const body = {
		executionId: input.executionId,
		name: input.name,
		rootPath: input.rootPath ?? "/sandbox",
		enabledTools: ["bash", "read", "write", "edit", "glob", "grep"],
		requireReadBeforeWrite: false,
		commandTimeoutMs: 120_000,
		sandboxTemplate: input.sandboxTemplate ?? "base",
		keepAfterRun: input.keepAfterRun ?? true,
		ttlSeconds: input.ttlSeconds ?? 0,
		// These fields are required by the orchestrator's call pattern even
		// outside a workflow context — openshell-agent-runtime uses them as
		// labels for observability, nothing more.
		workflowId: "ui-session",
		nodeId: input.executionId,
		nodeName: input.name,
	};
	const res = await daprFetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		maxRetries: 2,
	});
	if (!res.ok) {
		const detail = (await res.text()).slice(0, 500);
		throw new Error(
			`openshell-agent-runtime workspace/profile failed (${res.status}): ${detail}`,
		);
	}
	const data = (await res.json()) as {
		sandboxName?: string;
		workspaceRef?: string;
		rootPath?: string;
	};
	if (!data.sandboxName) {
		throw new Error(
			"workspace/profile response missing sandboxName",
		);
	}
	return {
		sandboxName: data.sandboxName,
		workspaceRef: data.workspaceRef ?? null,
		rootPath: data.rootPath ?? input.rootPath ?? "/sandbox",
	};
}

/**
 * Tear down a session sandbox. Called at session terminate so we don't leak
 * pods. Posts to openshell-agent-runtime's /api/workspaces/cleanup with the
 * same executionId we used at provision time.
 *
 * Safe to call multiple times; the runtime's cleanup endpoint is idempotent
 * on missing sandboxes (returns 200 with an "already cleaned" flag).
 */
export async function cleanupSessionSandbox(
	executionId: string,
): Promise<void> {
	const url = `${getWorkspaceRuntimeUrl()}/api/workspaces/cleanup`;
	try {
		const res = await daprFetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ executionId }),
			maxRetries: 1,
		});
		if (!res.ok) {
			console.warn(
				"[sandbox-cleanup] workspace/cleanup non-OK:",
				res.status,
				(await res.text()).slice(0, 300),
			);
		}
	} catch (err) {
		// Cleanup is best-effort; a stuck sandbox gets reaped by the
		// runtime's TTL/GC pass eventually. Log + move on.
		console.warn("[sandbox-cleanup] workspace/cleanup failed:", err);
	}
}
