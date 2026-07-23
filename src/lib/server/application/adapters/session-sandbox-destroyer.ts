import { env } from "$env/dynamic/private";
import type {
	SessionSandboxDeleteResult,
	SessionSandboxDestroyer,
} from "$lib/server/application/ports";
import { openshellRuntimeFetch } from "$lib/server/openshell-runtime";

type SandboxExecutionApiConfig = {
	baseUrl: string;
	token: string;
};

type RuntimeSandboxDeleteOptions = Readonly<{
	timeoutMs?: number;
}>;

const DEFAULT_SANDBOX_DELETE_TIMEOUT_MS = 8_000;

function sandboxExecutionApiConfig(): SandboxExecutionApiConfig | null {
	const baseUrl = (
		env.SANDBOX_EXECUTION_API_URL ??
		env.HOST_EXECUTION_API_URL ??
		process.env.SANDBOX_EXECUTION_API_URL ??
		process.env.HOST_EXECUTION_API_URL ??
		""
	).trim();
	if (!baseUrl) return null;
	const token = (
		env.SANDBOX_EXECUTION_API_TOKEN ??
		env.HOST_EXECUTION_API_TOKEN ??
		process.env.SANDBOX_EXECUTION_API_TOKEN ??
		process.env.HOST_EXECUTION_API_TOKEN ??
		""
	).trim();
	return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

function runtimeAgentAppId(sandboxName: string): string | null {
	const normalized = sandboxName.trim();
	if (!normalized.startsWith("agent-host-")) return null;
	const agentAppId = normalized.slice("agent-host-".length);
	return agentAppId || null;
}

function deleteError(
	name: string,
	kind: "runtime" | "workspace",
	error: unknown,
): SessionSandboxDeleteResult {
	return {
		name,
		kind,
		status: "error",
		error: error instanceof Error ? error.message : String(error),
	};
}

/**
 * Infrastructure adapter for session Sandbox teardown.
 *
 * Runtime hosts are owned by sandbox-execution-api, whose service account has
 * the Sandbox RBAC and can verify foreground deletion. OpenShell workspaces use
 * their independent runtime API. Callers consume one port and never need either
 * provider's transport or authorization details.
 */
export class SandboxExecutionApiSessionSandboxDestroyer
	implements SessionSandboxDestroyer
{
	constructor(
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly resolveConfig: () => SandboxExecutionApiConfig | null =
			sandboxExecutionApiConfig,
		private readonly defaultRequestTimeoutMs = DEFAULT_SANDBOX_DELETE_TIMEOUT_MS,
	) {}

	private async fetchJsonWithTimeout(
		url: string,
		init: RequestInit,
		requestTimeoutMs: number,
	): Promise<{
		response: Response;
		body: Record<string, unknown>;
	}> {
		const timeoutMs = Math.max(1, Math.trunc(requestTimeoutMs));
		const controller = new AbortController();
		const timeoutError = new Error(
			`sandbox-execution-api request timed out after ${timeoutMs}ms`,
		);
		let timedOut = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				timedOut = true;
				reject(timeoutError);
				controller.abort(timeoutError);
			}, timeoutMs);
		});
		try {
			const requestPromise = (async () => {
				const response = await this.fetchImpl(url, {
					...init,
					signal: controller.signal,
				});
				const rawBody = await response.text();
				let body: Record<string, unknown> = {};
				if (rawBody) {
					try {
						body = JSON.parse(rawBody) as Record<string, unknown>;
					} catch {
						body = {};
					}
				}
				return { response, body };
			})();
			return await Promise.race([
				requestPromise,
				timeoutPromise,
			]);
		} catch (error) {
			// abort() can make an abort-aware fetch reject before Promise.race
			// observes timeoutPromise. Normalize either winner to one contract.
			if (timedOut) throw timeoutError;
			throw error;
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	async deleteRuntimeSandbox(
		name: string,
		options: RuntimeSandboxDeleteOptions = {},
	): Promise<SessionSandboxDeleteResult> {
		const normalized = name.trim();
		const agentAppId = runtimeAgentAppId(normalized);
		if (!agentAppId) {
			return deleteError(
				normalized || name,
				"runtime",
				"runtime Sandbox name must start with agent-host-",
			);
		}
		try {
			const config = this.resolveConfig();
			if (!config) {
				throw new Error("SANDBOX_EXECUTION_API_URL is not configured");
			}
			const { response, body } = await this.fetchJsonWithTimeout(
				`${config.baseUrl}/api/v1/agent-workflow-hosts/${encodeURIComponent(agentAppId)}`,
				{
					method: "DELETE",
					headers: config.token
						? { Authorization: `Bearer ${config.token}` }
						: {},
				},
				options.timeoutMs ?? this.defaultRequestTimeoutMs,
			);
			if (!response.ok) {
				throw new Error(
					(typeof body.detail === "string" && body.detail) ||
						`sandbox-execution-api HTTP ${response.status}`,
				);
			}
			if (
				body.agentAppId !== agentAppId ||
				body.sandboxName !== normalized
			) {
				throw new Error(
					"sandbox-execution-api returned a mismatched cleanup receipt",
				);
			}
			if (body.outcome === "deleted") {
				return { name: normalized, kind: "runtime", status: "deleted" };
			}
			if (body.outcome === "not-found") {
				return { name: normalized, kind: "runtime", status: "missing" };
			}
			throw new Error(
				(typeof body.message === "string" && body.message) ||
					`unexpected sandbox-execution-api outcome ${JSON.stringify(body.outcome ?? null)}`,
			);
		} catch (error) {
			return deleteError(normalized, "runtime", error);
		}
	}

	async deleteWorkspaceSandbox(
		name: string,
	): Promise<SessionSandboxDeleteResult> {
		const normalized = name.trim();
		if (!normalized) {
			return deleteError(name, "workspace", "workspace Sandbox name is required");
		}
		try {
			const response = await openshellRuntimeFetch(
				`/api/v1/sandboxes/${encodeURIComponent(normalized)}`,
				{ method: "DELETE" },
			);
			if (response.ok) {
				return { name: normalized, kind: "workspace", status: "deleted" };
			}
			const detail = await response.text().catch(() => "");
			if (
				response.status === 404 ||
				detail.toLowerCase().includes("sandbox not found")
			) {
				return { name: normalized, kind: "workspace", status: "missing" };
			}
			return deleteError(
				normalized,
				"workspace",
				detail.slice(0, 500) || response.statusText || `HTTP ${response.status}`,
			);
		} catch (error) {
			return deleteError(normalized, "workspace", error);
		}
	}
}
