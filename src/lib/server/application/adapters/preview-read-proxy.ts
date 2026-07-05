import { env } from "$env/dynamic/private";
import type {
	PreviewArtifactSummary,
	PreviewExecutionSummary,
	PreviewReadFailure,
	PreviewReadProxyPort,
	PreviewReadResult,
	PreviewRunTarget,
} from "$lib/server/application/ports";

/**
 * E2 read proxy — HTTP adapter from the HOST BFF to a preview BFF's internal
 * read APIs.
 *
 * AUTH: the host's own INTERNAL_API_TOKEN. runner.sh copies the host
 * `workflow-builder-secrets` Secret (including INTERNAL_API_TOKEN) verbatim
 * into every preview vcluster at provision, so the host token passes the
 * preview app's `requireInternal` guard — for existing previews too, with zero
 * per-preview key minting. (The deterministic `wfb_smoke_<name>` API keys were
 * considered and rejected: they are broader-powered admin user keys and the
 * v1 session-auth surface is wider than the internal read routes we need.)
 *
 * REACHABILITY: a vcluster's Services are synced onto the host cluster as
 * `<svc>-x-<namespace>-x-<vcluster>` in the `vcluster-<name>` namespace, so the
 * preview BFF is reachable in-cluster as
 * `http://workflow-builder-x-workflow-builder-x-<n>.vcluster-<n>.svc:3000`
 * (verified live on dev). A CLAIMED warm-pool member keeps its POOL-named
 * namespace/services (the alias is display-only), so the backing id is
 * `pool ?? name` — the same keying rule as the E1 feed streams. When the
 * composed service name would exceed the 63-char DNS label limit (the vcluster
 * syncer hash-truncates it unpredictably), fall back to the tailnet URL.
 */

const IN_CLUSTER_SERVICE_PREFIX = "workflow-builder-x-workflow-builder-x-";
const DNS_LABEL_MAX = 63;
const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_CONTENT_BYTES = 25 * 1024 * 1024; // Files-API upload cap.

function sanitizeBackingName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Resolve the base URL for a preview BFF: in-cluster synced Service first, tailnet fallback. */
export function previewApiBaseUrl(target: PreviewRunTarget): string | null {
	const backing = sanitizeBackingName(target.pool ?? target.name);
	if (backing) {
		const service = `${IN_CLUSTER_SERVICE_PREFIX}${backing}`;
		if (service.length <= DNS_LABEL_MAX) {
			return `http://${service}.vcluster-${backing}.svc.cluster.local:3000`;
		}
	}
	return target.url ? target.url.replace(/\/+$/, "") : null;
}

export type HttpPreviewReadProxyOptions = {
	/** Per-request timeout (ms). Short by design: reads degrade, never block. */
	timeoutMs?: number;
	/** Override the internal token (defaults to env INTERNAL_API_TOKEN). */
	token?: string;
	fetchImpl?: typeof fetch;
	maxContentBytes?: number;
};

function failure(
	reason: PreviewReadFailure["reason"],
	message?: string,
): PreviewReadFailure {
	return { ok: false, reason, ...(message ? { message } : {}) };
}

function toIso(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toExecutionSummary(raw: Record<string, unknown>): PreviewExecutionSummary {
	const workflow =
		raw.workflow && typeof raw.workflow === "object"
			? (raw.workflow as Record<string, unknown>)
			: null;
	const startedAt = toIso(raw.startedAt);
	const completedAt = toIso(raw.completedAt);
	const durationMs =
		startedAt && completedAt
			? new Date(completedAt).getTime() - new Date(startedAt).getTime()
			: null;
	return {
		id: String(raw.id ?? ""),
		workflowId:
			typeof raw.workflowId === "string"
				? raw.workflowId
				: typeof workflow?.id === "string"
					? workflow.id
					: null,
		workflowName: typeof workflow?.name === "string" ? workflow.name : null,
		status: typeof raw.status === "string" ? raw.status : "unknown",
		phase: typeof raw.phase === "string" ? raw.phase : null,
		progress: typeof raw.progress === "number" ? raw.progress : null,
		error: typeof raw.error === "string" ? raw.error : null,
		startedAt,
		completedAt,
		durationMs,
	};
}

function toArtifactSummary(raw: Record<string, unknown>): PreviewArtifactSummary {
	return {
		id: String(raw.id ?? ""),
		executionId: String(raw.workflowExecutionId ?? raw.executionId ?? ""),
		kind: typeof raw.kind === "string" ? raw.kind : "unknown",
		title: typeof raw.title === "string" ? raw.title : null,
		fileId: typeof raw.fileId === "string" ? raw.fileId : null,
		contentType: typeof raw.contentType === "string" ? raw.contentType : null,
		sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : null,
		metadata:
			raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
				? (raw.metadata as Record<string, unknown>)
				: null,
		createdAt: toIso(raw.createdAt),
	};
}

export class HttpPreviewReadProxy implements PreviewReadProxyPort {
	constructor(private readonly options: HttpPreviewReadProxyOptions = {}) {}

	private token(): string {
		return (this.options.token ?? env.INTERNAL_API_TOKEN ?? "").trim();
	}

	private timeoutMs(): number {
		const raw = this.options.timeoutMs ?? Number(env.PREVIEW_READ_PROXY_TIMEOUT_MS ?? "");
		return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
	}

	private async request(
		target: PreviewRunTarget,
		path: string,
	): Promise<PreviewReadResult<Response>> {
		const base = previewApiBaseUrl(target);
		if (!base) return failure("unreachable", "no resolvable preview URL");
		const token = this.token();
		if (!token) return failure("unauthorized", "INTERNAL_API_TOKEN not configured");
		const doFetch = this.options.fetchImpl ?? fetch;
		let response: Response;
		try {
			response = await doFetch(`${base}${path}`, {
				headers: { "X-Internal-Token": token },
				signal: AbortSignal.timeout(this.timeoutMs()),
			});
		} catch (err) {
			return failure(
				"unreachable",
				err instanceof Error ? err.message : String(err),
			);
		}
		if (response.status === 401 || response.status === 403) {
			return failure("unauthorized", `preview returned HTTP ${response.status}`);
		}
		if (response.status === 404) {
			return failure("not-found", "preview returned HTTP 404");
		}
		if (!response.ok) {
			// 405 = the preview runs an app image that predates this internal route.
			return failure("bad-response", `preview returned HTTP ${response.status}`);
		}
		return { ok: true, data: response };
	}

	private async requestJson(
		target: PreviewRunTarget,
		path: string,
	): Promise<PreviewReadResult<Record<string, unknown>>> {
		const result = await this.request(target, path);
		if (!result.ok) return result;
		try {
			const body = (await result.data.json()) as unknown;
			if (!body || typeof body !== "object" || Array.isArray(body)) {
				return failure("bad-response", "preview returned a non-object body");
			}
			return { ok: true, data: body as Record<string, unknown> };
		} catch (err) {
			return failure(
				"bad-response",
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	async listExecutions(input: {
		target: PreviewRunTarget;
		limit?: number;
		status?: string | null;
	}): Promise<
		PreviewReadResult<{ executions: PreviewExecutionSummary[]; total: number }>
	> {
		const limit = Math.max(1, Math.min(input.limit ?? 25, 500));
		const params = new URLSearchParams({ limit: String(limit) });
		if (input.status?.trim()) params.set("status", input.status.trim());
		const result = await this.requestJson(
			input.target,
			`/api/internal/agent/workflows/executions?${params.toString()}`,
		);
		if (!result.ok) return result;
		const rows = Array.isArray(result.data.executions) ? result.data.executions : [];
		return {
			ok: true,
			data: {
				executions: rows
					.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
					.map(toExecutionSummary),
				total:
					typeof result.data.total === "number" ? result.data.total : rows.length,
			},
		};
	}

	async getExecution(input: {
		target: PreviewRunTarget;
		executionId: string;
	}): Promise<PreviewReadResult<Record<string, unknown>>> {
		const result = await this.requestJson(
			input.target,
			`/api/internal/workflow-data/executions/${encodeURIComponent(input.executionId)}`,
		);
		if (!result.ok) return result;
		const execution = result.data.execution;
		if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
			return failure("bad-response", "preview returned no execution body");
		}
		return { ok: true, data: execution as Record<string, unknown> };
	}

	async listExecutionArtifacts(input: {
		target: PreviewRunTarget;
		executionId: string;
		kind?: string | null;
	}): Promise<PreviewReadResult<PreviewArtifactSummary[]>> {
		const params = new URLSearchParams();
		if (input.kind?.trim()) params.set("kind", input.kind.trim());
		const query = params.size > 0 ? `?${params.toString()}` : "";
		const result = await this.requestJson(
			input.target,
			`/api/internal/workflow-data/executions/${encodeURIComponent(input.executionId)}/artifacts${query}`,
		);
		if (!result.ok) return result;
		const rows = Array.isArray(result.data.artifacts) ? result.data.artifacts : [];
		return {
			ok: true,
			data: rows
				.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
				.map(toArtifactSummary),
		};
	}

	async fetchFileContent(input: {
		target: PreviewRunTarget;
		fileId: string;
		maxBytes?: number;
	}): Promise<PreviewReadResult<{ bytes: Buffer; contentType: string | null }>> {
		const result = await this.request(
			input.target,
			`/api/internal/files/${encodeURIComponent(input.fileId)}/content`,
		);
		if (!result.ok) return result;
		const maxBytes = input.maxBytes ?? this.options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
		const declared = Number(result.data.headers.get("content-length") ?? "");
		if (Number.isFinite(declared) && declared > maxBytes) {
			return failure("bad-response", `content too large (${declared}B > ${maxBytes}B)`);
		}
		let bytes: Buffer;
		try {
			bytes = Buffer.from(await result.data.arrayBuffer());
		} catch (err) {
			return failure(
				"unreachable",
				err instanceof Error ? err.message : String(err),
			);
		}
		if (bytes.byteLength > maxBytes) {
			return failure(
				"bad-response",
				`content too large (${bytes.byteLength}B > ${maxBytes}B)`,
			);
		}
		return {
			ok: true,
			data: {
				bytes,
				contentType: result.data.headers.get("content-type"),
			},
		};
	}
}
