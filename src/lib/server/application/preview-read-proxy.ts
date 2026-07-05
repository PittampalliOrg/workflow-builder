import type {
	PreviewExecutionSummary,
	PreviewReadProxyPort,
	PreviewReadResult,
	PreviewRunTarget,
} from "$lib/server/application/ports";

export type PreviewReadProxyDeps = {
	proxy: PreviewReadProxyPort;
	/** Lists active Tier-2 previews (name + url + backing pool member). */
	listPreviews: () => Promise<PreviewRunTarget[]>;
};

export type PreviewExecutionsReadModel = {
	preview: { name: string; url: string | null };
	result: PreviewReadResult<{
		executions: PreviewExecutionSummary[];
		total: number;
	}>;
};

export type PreviewExecutionDetailReadModel = {
	preview: { name: string; url: string | null };
	result: PreviewReadResult<Record<string, unknown>>;
};

/**
 * E2: read-only proxy service from the Dev hub to a preview BFF's run history.
 * Preview names are ALWAYS resolved against the SEA-provided preview list —
 * never used to build URLs directly — so a request can only ever reach a
 * known, active preview (no caller-controlled URL construction). Unknown
 * previews resolve to null (the route 404s); reachable-preview failures
 * degrade to a typed failure the UI renders as "preview unreachable".
 */
export class ApplicationPreviewReadProxyService {
	constructor(private readonly deps: PreviewReadProxyDeps) {}

	private async resolveTarget(name: string): Promise<PreviewRunTarget | null> {
		const wanted = name.trim().toLowerCase();
		if (!wanted) return null;
		const previews = await this.deps.listPreviews();
		return previews.find((p) => p.name.toLowerCase() === wanted) ?? null;
	}

	/** Recent executions inside one preview. Null = unknown preview (404). */
	async listPreviewExecutions(input: {
		name: string;
		limit?: number;
		status?: string | null;
	}): Promise<PreviewExecutionsReadModel | null> {
		const target = await this.resolveTarget(input.name);
		if (!target) return null;
		const result = await this.deps.proxy.listExecutions({
			target,
			limit: input.limit,
			status: input.status ?? null,
		});
		return { preview: { name: target.name, url: target.url }, result };
	}

	/** One execution's detail inside one preview. Null = unknown preview (404). */
	async getPreviewExecution(input: {
		name: string;
		executionId: string;
	}): Promise<PreviewExecutionDetailReadModel | null> {
		const target = await this.resolveTarget(input.name);
		if (!target) return null;
		const result = await this.deps.proxy.getExecution({
			target,
			executionId: input.executionId,
		});
		return { preview: { name: target.name, url: target.url }, result };
	}
}
