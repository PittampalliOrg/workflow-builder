import { env } from "$env/dynamic/private";
import { desc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { workflowWorkspaceSessions } from "$lib/server/db/schema";
import {
	resolveDevPreviewDescriptor,
	resolveDevPreviewImage,
} from "$lib/server/workflows/dev-preview-registry";

/**
 * Per-run ephemeral dev-server preview (P2).
 *
 * A workflow run provisions its OWN throwaway `vite dev` Sandbox via the
 * privileged `sandbox-execution-api` (`/internal/dev-preview`), so the
 * unprivileged agent never needs kube creds. The agent then `/__sync`-pushes its
 * edited source to the returned pod IP and the Playwright critic inspects the
 * same pod IP — devspace's image-replace + dev-server model, realized
 * cluster-natively. Torn down on run end (explicit teardown + the Sandbox's own
 * `shutdownTime` backstop + the sandbox-gc CronJob).
 */

export interface DevPreviewInfo {
	sandboxName: string;
	executionId: string;
	service: string;
	podIP: string | null;
	port: number;
	syncPort: number;
	url: string | null;
	/** Agent /__sync target (pod-IP:syncPort/__sync). */
	syncUrl: string | null;
	/** Human-browsable per-service tailnet URL. */
	browseUrl: string | null;
	/** Subdir + globs the agent should tar + push on sync. */
	repoUrl: string;
	repoSubdir: string;
	syncPaths: string[];
	ready: boolean;
	status: string;
	/** Dapr-shadow: this preview runs a daprd sidecar (isolated app-id). */
	needsDapr: boolean;
	/** The isolated Dapr app-id (own task hub), when needsDapr. */
	daprAppId: string | null;
}

function sandboxExecutionApiUrl(): string | null {
	const raw = (
		env.SANDBOX_EXECUTION_API_URL ??
		env.HOST_EXECUTION_API_URL ??
		process.env.SANDBOX_EXECUTION_API_URL ??
		process.env.HOST_EXECUTION_API_URL ??
		""
	).trim();
	return raw ? raw.replace(/\/+$/, "") : null;
}

function internalToken(): string {
	return env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";
}

export interface ProvisionDevPreviewParams {
	executionId: string;
	/** Logical service id (resolved via the dev-preview registry). Default workflow-builder. */
	service?: string | null;
	syncToken?: string | null;
	timeoutSeconds?: number | null;
	waitReadySeconds?: number;
	/** Image override (else the descriptor's env-pinned/fallback image). */
	image?: string | null;
	executionClass?: string;
}

export async function provisionDevPreview(
	params: ProvisionDevPreviewParams,
): Promise<DevPreviewInfo> {
	const baseUrl = sandboxExecutionApiUrl();
	if (!baseUrl) {
		throw new Error("SANDBOX_EXECUTION_API_URL not configured");
	}
	const descriptor = resolveDevPreviewDescriptor(params.service);
	const image =
		params.image ||
		resolveDevPreviewImage(descriptor, { ...process.env, ...env });
	const token = internalToken();
	const requestBody: Record<string, unknown> = {
		executionId: params.executionId,
		executionClass: params.executionClass ?? "dev-preview",
		service: descriptor.service,
		image,
		port: descriptor.port,
		healthPath: descriptor.healthPath,
		workdir: descriptor.workdir,
		syncMode: descriptor.syncMode,
		syncPort: descriptor.syncPort,
		...(descriptor.needsDapr
			? {
					needsDapr: true,
					...(descriptor.pubsubName
						? { env: { PUBSUB_NAME: descriptor.pubsubName } }
						: {}),
				}
			: {}),
		...(params.syncToken ? { syncToken: params.syncToken } : {}),
		...(params.timeoutSeconds == null
			? {}
			: { timeoutSeconds: params.timeoutSeconds }),
		...(params.waitReadySeconds == null
			? {}
			: { waitReadySeconds: params.waitReadySeconds }),
	};
	const response = await fetch(`${baseUrl}/internal/dev-preview`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(requestBody),
	});
	const body = (await response.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	if (!response.ok) {
		const detail =
			typeof body.detail === "string"
				? body.detail
				: `dev-preview provision failed (HTTP ${response.status})`;
		throw new Error(detail);
	}
	const info: DevPreviewInfo = {
		sandboxName: String(body.sandboxName ?? ""),
		executionId: params.executionId,
		service: descriptor.service,
		podIP: typeof body.podIP === "string" ? body.podIP : null,
		port: typeof body.port === "number" ? body.port : descriptor.port,
		syncPort:
			typeof body.syncPort === "number" ? body.syncPort : descriptor.syncPort,
		url: typeof body.url === "string" ? body.url : null,
		syncUrl: typeof body.syncUrl === "string" ? body.syncUrl : null,
		browseUrl: `http://${descriptor.tailnetHost}`,
		repoUrl: descriptor.repoUrl,
		repoSubdir: descriptor.repoSubdir,
		syncPaths: descriptor.syncPaths,
		ready: body.ready === true,
		status: typeof body.status === "string" ? body.status : "queued",
		needsDapr: body.needsDapr === true,
		daprAppId: typeof body.daprAppId === "string" ? body.daprAppId : null,
	};
	await persistDevPreviewSession(info);
	return info;
}

async function persistDevPreviewSession(info: DevPreviewInfo): Promise<void> {
	if (!db || !info.sandboxName) return;
	const details = {
		kind: "dev-preview",
		sandboxName: info.sandboxName,
		name: info.sandboxName,
		service: info.service,
		podIP: info.podIP,
		port: info.port,
		syncPort: info.syncPort,
		url: info.url,
		syncUrl: info.syncUrl,
		browseUrl: info.browseUrl,
		needsDapr: info.needsDapr,
		daprAppId: info.daprAppId,
		ready: info.ready,
		executionId: info.executionId,
		provider: "agent-sandbox-dev-preview",
	};
	try {
		await db
			.insert(workflowWorkspaceSessions)
			.values({
				workspaceRef: info.sandboxName,
				workflowExecutionId: info.executionId,
				name: "dev-preview",
				rootPath: "/app",
				backend: "juicefs",
				enabledTools: [],
				status: "active",
				sandboxState: { details },
			})
			.onConflictDoUpdate({
				target: workflowWorkspaceSessions.workspaceRef,
				set: {
					workflowExecutionId: info.executionId,
					status: "active",
					sandboxState: { details },
					updatedAt: new Date(),
					lastAccessedAt: new Date(),
					cleanedAt: null,
				},
			});
	} catch (err) {
		// Best-effort: provisioning succeeded; persistence is for discovery/reaping.
		console.warn(
			"[dev-preview] failed to persist workspace session row:",
			err instanceof Error ? err.message : err,
		);
	}
}

/**
 * Resolve the dev-preview Sandbox name for an execution (from the persisted row
 * if present, else the deterministic name the service uses).
 */
async function resolveDevPreviewSandboxName(
	executionId: string,
	explicit?: string | null,
): Promise<string | null> {
	if (explicit) return explicit;
	if (db) {
		const [row] = await db
			.select({
				workspaceRef: workflowWorkspaceSessions.workspaceRef,
				sandboxState: workflowWorkspaceSessions.sandboxState,
			})
			.from(workflowWorkspaceSessions)
			.where(eq(workflowWorkspaceSessions.workflowExecutionId, executionId))
			.orderBy(desc(workflowWorkspaceSessions.createdAt))
			.limit(1);
		if (row?.workspaceRef) return row.workspaceRef;
		const details = (row?.sandboxState as { details?: { sandboxName?: string } })
			?.details;
		if (details?.sandboxName) return details.sandboxName;
	}
	return null;
}

export async function teardownDevPreview(params: {
	executionId: string;
	sandboxName?: string | null;
}): Promise<{ ok: boolean; sandboxName: string | null }> {
	const baseUrl = sandboxExecutionApiUrl();
	const name = await resolveDevPreviewSandboxName(
		params.executionId,
		params.sandboxName,
	);
	if (!name) return { ok: true, sandboxName: null };
	const token = internalToken();
	if (baseUrl) {
		try {
			await fetch(
				`${baseUrl}/internal/dev-preview/${encodeURIComponent(name)}`,
				{
					method: "DELETE",
					headers: token ? { Authorization: `Bearer ${token}` } : {},
				},
			);
		} catch (err) {
			console.warn(
				"[dev-preview] teardown request failed:",
				err instanceof Error ? err.message : err,
			);
		}
	}
	if (db) {
		try {
			await db
				.update(workflowWorkspaceSessions)
				.set({ status: "cleaned", cleanedAt: new Date(), updatedAt: new Date() })
				.where(eq(workflowWorkspaceSessions.workspaceRef, name));
		} catch {
			/* best-effort */
		}
	}
	return { ok: true, sandboxName: name };
}
