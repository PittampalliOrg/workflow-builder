import { env } from "$env/dynamic/private";
import type { PreviewDatabaseProvisioner } from "$lib/server/application/ports";
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

type DevPreviewWorkspaceSessionRecord = {
	workspaceRef: string;
	sandboxState: Record<string, unknown> | null;
};

type DevPreviewPersistSourceBundleInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
	nodeId?: string | null;
	iteration?: number | null;
	fileName?: string;
	bytes: Buffer;
	contentType?: string;
	meta?: {
		base?: string | null;
		head?: string | null;
		tier?: string | null;
		clonePath?: string | null;
		fileCount?: number | null;
		repoUrl?: string | null;
		repoSubdir?: string | null;
		syncPaths?: string[] | null;
		iteration?: number | null;
	};
};

export interface DevPreviewPersistence {
	upsertWorkflowWorkspaceSession(input: {
		workspaceRef: string;
		workflowExecutionId?: string | null;
		durableInstanceId?: string | null;
		name: string;
		rootPath: string;
		clonePath?: string | null;
		backend: "openshell" | "juicefs";
		enabledTools?: string[];
		status?: "active" | "cleaned" | "error";
		sandboxState?: Record<string, unknown> | null;
	}): Promise<{ workspaceRef: string }>;
	listWorkflowWorkspaceSessionsByExecutionId(input: {
		executionId: string;
		limit?: number;
	}): Promise<DevPreviewWorkspaceSessionRecord[]>;
	markWorkflowWorkspaceSessionCleaned(input: {
		workspaceRef: string;
	}): Promise<boolean>;
	getExecutionById(id: string): Promise<{
		id: string;
		userId: string;
		projectId: string | null;
	} | null>;
	persistSourceBundleArtifact(
		input: DevPreviewPersistSourceBundleInput,
	): Promise<{ id: string; fileId: string; bytes: number }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
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
	/**
	 * Provisioning mode (in-preview agentic dev loop, P1):
	 *  - "host-throwaway" (default): the legacy per-run preview on the host dev
	 *    cluster — a throwaway `preview_<id>` DB + (for the BFF) a separate dev URL.
	 *  - "preview-native": the dev pod runs INSIDE a Tier-2 vcluster preview and
	 *    reuses the preview's own DB/secrets (functional, serves HMR on its pod IP).
	 *    When `adopt` is also set it REPLACES the preview's prod Deployment (takes
	 *    its Service + scales it to 0) so the preview's existing URL serves edits.
	 */
	mode?: "host-throwaway" | "preview-native";
	/**
	 * Preview-native ADOPT (default true): take over the preview's Service + scale
	 * its prod Deployment to 0 so the preview URL serves the dev build — the right
	 * choice for a HUMAN interactive session watching that URL. Set FALSE for an
	 * ORCHESTRATED workflow (e.g. the GAN loop): the cutover scales the prod BFF the
	 * orchestrator is driving its own calls through (clone/dispatch) → in-flight
	 * RemoteDisconnected. With adopt=false the dev pod just serves HMR on its pod IP
	 * (the critic/generator use that IP), and the prod BFF stays up for the orchestrator.
	 */
	adopt?: boolean;
	/**
	 * Canonical origin to set on the dev pod (`ORIGIN` env), overriding the
	 * descriptor default. For a vcluster preview pass the preview's own HTTPS host
	 * (e.g. `https://wfb-<name>.tail286401.ts.net`) so auth/CSRF/cookies match the URL.
	 */
	origin?: string;
}

export interface TeardownDevPreviewParams {
	executionId: string;
	sandboxName?: string | null;
}

export interface TeardownDevPreviewResult {
	ok: boolean;
	sandboxName: string | null;
}

export async function provisionDevPreview(
	params: ProvisionDevPreviewParams,
	persistence?: DevPreviewPersistence,
	previewDatabases?: PreviewDatabaseProvisioner,
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

	const previewNative = params.mode === "preview-native";
	// Functional preview: provision the per-preview database first; its DATABASE_URL
	// is delivered to the pod via a per-preview Secret (serviceSecretEnv), and the
	// app self-migrates the empty DB on boot. Preview-native adopt SKIPS this — the
	// vcluster preview already has its OWN isolated, migrated DB, and the dev pod
	// reuses it via the preview's `workflow-builder-secrets` (envFrom).
	const previewEnv: Record<string, string> = { ...(descriptor.extraEnv ?? {}) };
	// Per-preview canonical origin. The descriptor's ORIGIN points at the HOST
	// standing preview; a vcluster preview is served at its own tailnet host, so the
	// caller can override ORIGIN to match the preview URL (auth/CSRF/cookie origin).
	if (params.origin) previewEnv.ORIGIN = params.origin;
	const serviceSecretEnv: Record<string, string> = {};
	if (descriptor.functional && !previewNative) {
		if (!previewDatabases) {
			throw new Error("Preview database provisioner not configured");
		}
		const { databaseUrl, sourceUrl } = await previewDatabases.provision({
			executionId: params.executionId,
		});
		serviceSecretEnv.DATABASE_URL = databaseUrl;
		// Source for the db-clone init container (pg_dump --schema-only | psql).
		if (sourceUrl) serviceSecretEnv.PREVIEW_SOURCE_DATABASE_URL = sourceUrl;
	}
	if (descriptor.pubsubName && !previewNative)
		previewEnv.PUBSUB_NAME = descriptor.pubsubName;

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
		...(descriptor.needsDapr ? { needsDapr: true } : {}),
		// Dapr-shadow env (PUBSUB_NAME=pubsub-dev / DAPR_CONFIG_STORE=disabled-dev) is a
		// HOST-only isolation hack. A preview-native pod runs REAL app-ids inside the
		// vcluster against its own `pubsub` component, so the shadow defaults would
		// point it at a non-existent `pubsub-dev` component → silently dead
		// subscriptions. Send false whenever preview-native (SEA also forces this
		// server-side); only the BFF descriptor opts out explicitly today, so the
		// orchestrator/coordinator would otherwise inherit the SEA default (true).
		...(previewNative || descriptor.applyDaprShadowDefaults === false
			? { applyDaprShadowDefaults: false }
			: {}),
		// Preview-native: always reuse the preview's own DB/secrets (skip throwaway).
		// ADOPT (replace the prod Deployment + take its Service + claim its app-id) is
		// opt-out: ON for a human interactive session (preview URL serves edits), OFF
		// for an orchestrated workflow (the cutover would disrupt the orchestrator's
		// own BFF calls) — there the dev pod just serves HMR on its pod IP.
		...(previewNative
			? {
					previewNative: true,
					...(params.adopt !== false
						? {
								adoptService: descriptor.adoptService ?? descriptor.service,
								adoptDeployment:
									descriptor.adoptDeployment ?? descriptor.service,
								...(descriptor.needsDapr
									? {
											daprAppId:
												descriptor.adoptDaprAppId ?? descriptor.service,
										}
									: {}),
								// HTTPS at the preview URL: co-locate the prod tls-terminator
								// sidecar so the prod LB (targetPort https-tls) serves this
								// adopted dev pod over HTTPS (else 502 — no https-tls endpoint).
								...(descriptor.adoptTlsTerminator
									? { adoptTlsTerminator: true }
									: {}),
							}
						: {}),
				}
			: {}),
		...(descriptor.envFrom ? { envFrom: descriptor.envFrom } : {}),
		...(Object.keys(serviceSecretEnv).length ? { serviceSecretEnv } : {}),
		...(Object.keys(previewEnv).length ? { env: previewEnv } : {}),
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
	await persistDevPreviewSession(info, persistence);
	return info;
}

async function persistDevPreviewSession(
	info: DevPreviewInfo,
	persistence?: DevPreviewPersistence,
): Promise<void> {
	if (!persistence || !info.sandboxName) return;
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
		await persistence.upsertWorkflowWorkspaceSession({
			workspaceRef: info.sandboxName,
			workflowExecutionId: info.executionId,
			name: "dev-preview",
			rootPath: "/app",
			backend: "juicefs",
			enabledTools: [],
			status: "active",
			sandboxState: { details },
		});
	} catch (err) {
		// Best-effort: provisioning succeeded; persistence is for discovery/reaping.
		// Log at ERROR with the offending id — the common cause is a non-canonical
		// `workflowExecutionId` (a Dapr instance id) violating the FK to
		// workflow_executions.id, which otherwise leaves the run with a live pod but
		// no session row (capture/teardown then can't find it).
		console.error(
			`[dev-preview] failed to persist workspace session row (execId=${info.executionId}, ref=${info.sandboxName}):`,
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
	persistence?: DevPreviewPersistence,
): Promise<string | null> {
	if (explicit) return explicit;
	if (persistence) {
		const [row] = await persistence.listWorkflowWorkspaceSessionsByExecutionId({
			executionId,
			limit: 1,
		});
		if (row?.workspaceRef) return row.workspaceRef;
		const details = asRecord(asRecord(row?.sandboxState)?.details);
		if (typeof details?.sandboxName === "string") return details.sandboxName;
	}
	return null;
}

type DevPreviewDetails = {
	sandboxName: string | null;
	service: string | null;
	podIP: string | null;
	syncPort: number | null;
};

/** Pull the persisted dev-preview details (pod IP/port/service) for an execution. */
async function resolveDevPreviewDetails(
	executionId: string,
	persistence?: DevPreviewPersistence,
): Promise<DevPreviewDetails | null> {
	if (!persistence) return null;
	type DevDetails = {
		sandboxName?: string;
		service?: string;
		podIP?: string | null;
		syncPort?: number | null;
	};
	// A run can legitimately have MORE THAN ONE workspace_session row (e.g. an
	// early ensure that captured a null podIP plus the ready-pod row). Pick the
	// newest row that actually carries a podIP+syncPort, falling back to the
	// newest overall — newest-only would otherwise resolve to a stale podIP-null
	// row and make capture/teardown skip `no_dev_pod`.
	const rows = await persistence.listWorkflowWorkspaceSessionsByExecutionId({
		executionId,
		limit: 8,
	});
	if (rows.length === 0) return null;
	const detailsOf = (r: (typeof rows)[number]): DevDetails | undefined =>
		(asRecord(r.sandboxState)?.details as DevDetails | undefined);
	const chosen =
		rows.find((r) => {
			const d = detailsOf(r);
			return !!d?.podIP && typeof d.syncPort === "number";
		}) ?? rows[0];
	const details = detailsOf(chosen);
	return {
		sandboxName: details?.sandboxName ?? chosen.workspaceRef ?? null,
		service: details?.service ?? null,
		podIP: details?.podIP ?? null,
		syncPort: typeof details?.syncPort === "number" ? details.syncPort : null,
	};
}

/**
 * Durably persist the code a dev-pod-as-source run produced (in-preview GAN), so it
 * can be reconstructed into a PR (Promote). In dev-pod-as-source the edited code
 * lives ONLY on the dev pod behind `GET /__export` (a tar.gz of `syncPaths`); the
 * agent's `/sandbox/work` is empty, so the standard git-bundle producer captures
 * nothing. This pulls `/__export` from the live dev pod and stores it as a
 * `source-bundle` version with `tier:"tar-overlay"` + the base-repo context so
 * Promote can rebuild against the base (clone base + overlay syncPaths). Per-iteration
 * (distinct `iteration`) so any iteration's design is promotable. Best-effort.
 */
export async function captureDevPreviewSource(
	executionId: string,
	opts: { nodeId?: string | null; iteration?: number | null; sandboxName?: string | null } = {},
	persistence?: DevPreviewPersistence,
): Promise<{ ok: boolean; artifactId?: string; bytes?: number; skipped?: string }> {
	if (!persistence) return { ok: false, skipped: "no_persistence" };
	const label = `[dev-preview] capture exec=${executionId} node=${opts.nodeId ?? "?"} iter=${opts.iteration ?? "?"}`;
	try {
		// The snapshot node fires right after `generate`, which can race the
		// dev-preview session row being stamped with podIP/syncPort (the dev pod may
		// still be reporting ready). Retry resolution briefly before giving up so a
		// per-iteration capture isn't silently lost to a transient empty row.
		let details = await resolveDevPreviewDetails(executionId, persistence);
		for (let i = 0; i < 8 && (!details?.podIP || !details.syncPort); i++) {
			await new Promise((r) => setTimeout(r, 2000));
			details = await resolveDevPreviewDetails(executionId, persistence);
		}
		if (!details?.podIP || !details.syncPort) {
			console.warn(`${label} skip: no_dev_pod (podIP/syncPort unresolved after retries)`);
			return { ok: true, skipped: "no_dev_pod" };
		}
		const descriptor = resolveDevPreviewDescriptor(details.service);
		const syncPaths = descriptor.syncPaths?.length ? descriptor.syncPaths : ["src"];
		const token = (env.WFB_DEV_SYNC_TOKEN ?? process.env.WFB_DEV_SYNC_TOKEN ?? "").trim();
		const exportUrl = `http://${details.podIP}:${details.syncPort}/__export?paths=${encodeURIComponent(
			syncPaths.join(","),
		)}`;
		const resp = await fetch(exportUrl, {
			headers: token ? { "x-sync-token": token } : {},
			signal: AbortSignal.timeout(60_000),
		});
		if (!resp.ok) {
			console.warn(`${label} skip: export_http_${resp.status} (${exportUrl})`);
			return { ok: true, skipped: `export_http_${resp.status}` };
		}
		const bytes = Buffer.from(await resp.arrayBuffer());
		if (bytes.byteLength === 0) {
			console.warn(`${label} skip: empty export`);
			return { ok: true, skipped: "empty" };
		}
		if (bytes.byteLength > 25 * 1024 * 1024) {
			console.warn(`${label} skip: too_large (${bytes.byteLength}B)`);
			return { ok: true, skipped: "too_large" };
		}
		// Guard against a dev image that lacks the `/__export` plugin: it falls
		// through to the SvelteKit handler and returns the app HTML (not a gzip
		// tar). Persisting that would yield a useless "version" that Promote would
		// overlay as garbage — skip with a clear, diagnosable reason instead.
		if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
			const ctype = resp.headers.get("content-type") ?? "?";
			console.warn(
				`${label} skip: export_not_gzip (ctype=${ctype}, first2=${bytes[0]?.toString(16)},${bytes[1]?.toString(16)}, ${bytes.byteLength}B) — dev image likely predates /__export`,
			);
			return { ok: true, skipped: "export_not_gzip" };
		}

		const exec = await persistence.getExecutionById(executionId);
		if (!exec) return { ok: true, skipped: "no_execution" };

		const result = await persistence.persistSourceBundleArtifact({
			executionId,
			userId: exec.userId,
			projectId: exec.projectId ?? null,
			nodeId: opts.nodeId ?? "dev-preview",
			iteration: opts.iteration ?? null,
			fileName: `source-${executionId}-${opts.iteration ?? "final"}.tar.gz`,
			contentType: "application/gzip",
			bytes,
			meta: {
				tier: "tar-overlay",
				base: descriptor.baseBranch ?? "main",
				repoUrl: descriptor.repoUrl,
				repoSubdir: descriptor.repoSubdir,
				syncPaths,
				iteration: opts.iteration ?? null,
			},
		});
		console.info(`${label} captured ${result.bytes}B → artifact ${result.id}`);
		return { ok: true, artifactId: result.id, bytes: result.bytes };
	} catch (err) {
		console.warn(`${label} failed:`, err instanceof Error ? err.message : err);
		return { ok: false, skipped: "error" };
	}
}

export async function teardownDevPreview(
	params: TeardownDevPreviewParams,
	persistence?: DevPreviewPersistence,
	previewDatabases?: PreviewDatabaseProvisioner,
): Promise<TeardownDevPreviewResult> {
	// Capture a durable, promotable version of the produced code BEFORE the dev pod
	// is deleted (dev-pod-as-source code lives only behind /__export). Best-effort.
	await captureDevPreviewSource(
		params.executionId,
		{
			nodeId: "dev-preview",
			iteration: null,
		},
		persistence,
	);
	const baseUrl = sandboxExecutionApiUrl();
	const name = await resolveDevPreviewSandboxName(
		params.executionId,
		params.sandboxName,
		persistence,
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
	if (persistence) {
		try {
			await persistence.markWorkflowWorkspaceSessionCleaned({ workspaceRef: name });
		} catch {
			/* best-effort */
		}
	}
	// Drop the per-preview database (functional previews). Best-effort — IF NOT
	// EXISTS-safe, so harmless for UI-only previews that never created one.
	if (previewDatabases) {
		try {
			await previewDatabases.drop({ executionId: params.executionId });
		} catch (err) {
			console.warn(
				"[dev-preview] preview DB drop failed:",
				err instanceof Error ? err.message : err,
			);
		}
	}
	return { ok: true, sandboxName: name };
}
