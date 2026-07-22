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

export type SandboxProvisioner = (
	input: SandboxProvisionInput,
) => Promise<SandboxProvisionResult>;

export type SandboxProvisionRetryOptions = {
	attempts?: number;
	retryDelayMs?: number;
	provision?: SandboxProvisioner;
};

const DEFAULT_SANDBOX_PROVISION_ATTEMPTS = 2;
const DEFAULT_SANDBOX_PROVISION_RETRY_DELAY_MS = 500;

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
	const raw = (await res.json()) as Record<string, unknown>;
	const sandboxName = resolveSandboxName(raw);
	if (!sandboxName) {
		throw new Error(
			`workspace/profile response missing sandboxName: ${JSON.stringify(raw).slice(0, 300)}`,
		);
	}
	const workspaceRef = firstString(raw, [
		"workspaceRef",
		"workspace_ref",
	]);
	const rootPath = firstString(raw, ["rootPath", "root_path"]);
	return {
		sandboxName,
		workspaceRef,
		rootPath: rootPath ?? input.rootPath ?? "/sandbox",
	};
}

export async function provisionSessionSandboxWithRetry(
	input: SandboxProvisionInput,
	options: SandboxProvisionRetryOptions = {},
): Promise<SandboxProvisionResult> {
	const provision = options.provision ?? provisionSessionSandbox;
	const attempts = normalizeAttemptCount(
		options.attempts ?? DEFAULT_SANDBOX_PROVISION_ATTEMPTS,
	);
	const retryDelayMs = Math.max(
		0,
		options.retryDelayMs ?? DEFAULT_SANDBOX_PROVISION_RETRY_DELAY_MS,
	);
	let lastError: unknown;

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			return await provision(input);
		} catch (err) {
			lastError = err;
			if (attempt >= attempts || !isRetryableSandboxProvisionError(err)) {
				throw err;
			}
			console.warn(
				`[sandbox-provision] workspace/profile failed on attempt ${attempt}/${attempts}; retrying:`,
				describeSandboxProvisionError(err),
			);
			await sleep(retryDelayMs);
		}
	}

	throw lastError instanceof Error
		? lastError
		: new Error("Sandbox provisioning failed");
}

export function sandboxProvisionFailureMessage(err: unknown): string {
	return `OpenShell sandbox provisioning failed: ${describeSandboxProvisionError(err)}`;
}

export function describeSandboxProvisionError(err: unknown): string {
	const message =
		err instanceof Error
			? err.message
			: typeof err === "string"
				? err
				: (() => {
						try {
							return JSON.stringify(err);
						} catch {
							return String(err);
						}
					})();
	const trimmed = (message ?? "").replace(/\u0000/g, "").trim();
	return (trimmed || "Sandbox provisioning failed").slice(0, 1_000);
}

export function isRetryableSandboxProvisionError(err: unknown): boolean {
	const message = describeSandboxProvisionError(err).toLowerCase();
	return [
		"internal",
		"unavailable",
		"deadline_exceeded",
		"deadline exceeded",
		"timed out",
		"timeout",
		"fetch failed",
		"socket hang up",
		"econnreset",
		"other side closed",
		"transport",
		"stream closed",
		"rst_stream",
		"failed to decode protobuf",
		"502",
		"503",
		"504",
	].some((needle) => message.includes(needle));
}

function normalizeAttemptCount(attempts: number): number {
	if (!Number.isFinite(attempts)) return DEFAULT_SANDBOX_PROVISION_ATTEMPTS;
	return Math.max(1, Math.min(5, Math.floor(attempts)));
}

async function sleep(delayMs: number): Promise<void> {
	if (delayMs <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function firstString(
	obj: Record<string, unknown> | null | undefined,
	keys: string[],
): string | null {
	if (!obj) return null;
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return null;
}

/** Walk the common response shapes openshell-agent-runtime / function-router
 * emit — sandboxName can land at the root, nested under `sandbox`, nested
 * under `sandbox.details`, or nested under `result`. Mirrors
 * resolveSandboxName in function-router's execute.ts. */
function resolveSandboxName(
	payload: Record<string, unknown> | null | undefined,
): string | null {
	if (!payload) return null;
	const top = firstString(payload, [
		"sandboxName",
		"sandbox_name",
		"workspaceSandboxName",
	]);
	if (top) return top;
	const sandbox = payload.sandbox;
	if (sandbox && typeof sandbox === "object" && !Array.isArray(sandbox)) {
		const sb = sandbox as Record<string, unknown>;
		const fromSandbox = firstString(sb, ["sandboxName", "sandbox_name"]);
		if (fromSandbox) return fromSandbox;
		const details = sb.details;
		if (details && typeof details === "object" && !Array.isArray(details)) {
			const fromDetails = firstString(
				details as Record<string, unknown>,
				["sandboxName", "sandbox_name"],
			);
			if (fromDetails) return fromDetails;
		}
	}
	const result = payload.result;
	if (result && typeof result === "object" && !Array.isArray(result)) {
		return resolveSandboxName(result as Record<string, unknown>);
	}
	return null;
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
	try {
		await cleanupSessionSandboxStrict(executionId);
	} catch (err) {
		// Cleanup is best-effort; a stuck sandbox gets reaped by the
		// runtime's TTL/GC pass eventually. Log + move on.
		console.warn("[sandbox-cleanup] workspace/cleanup failed:", err);
	}
}

/**
 * Lifecycle-grade OpenShell cleanup. Unlike {@link cleanupSessionSandbox}, this
 * function rejects on an unconfirmed cleanup so the persisted stop intent stays
 * pending and the reconciler can retry instead of acknowledging a leaked
 * workspace.
 */
export async function cleanupSessionSandboxStrict(
	executionId: string,
): Promise<void> {
	const normalizedExecutionId = executionId.trim();
	if (!normalizedExecutionId) {
		throw new Error("workspace cleanup requires an executionId");
	}
	const url = `${getWorkspaceRuntimeUrl()}/api/workspaces/cleanup`;
	const res = await daprFetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ executionId: normalizedExecutionId }),
		maxRetries: 1,
	});
	if (res.ok) return;
	const detail = (await res.text().catch(() => "")).slice(0, 500);
	throw new Error(
		`openshell-agent-runtime workspace/cleanup failed (${res.status})${detail ? `: ${detail}` : ""}`,
	);
}
