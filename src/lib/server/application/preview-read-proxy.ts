import type {
	PreviewAccessPolicyPort,
	PreviewControlIdentity,
	PreviewDeploymentScopePort,
	PreviewExecutionSummary,
	PreviewReadProxyPort,
	PreviewReadResult,
	PreviewRunTarget,
} from "$lib/server/application/ports";
import { PreviewRuntimeIdentityChangedError } from "$lib/server/application/ports";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { PreviewDeploymentScopeDeniedError } from "$lib/server/application/preview-deployment-scope";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

export type PreviewReadProxyDeps = {
	proxy: PreviewReadProxyPort;
	access: PreviewAccessPolicyPort;
	scope: Pick<PreviewDeploymentScopePort, "isControlPlane">;
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
 * E2: read-only proxy service from the Dev control plane to a preview BFF's run
 * history. The application access policy returns the authoritative preview
 * record for the actor; this service derives the immutable target tuple from
 * that same record, so authorization and transport cannot observe different
 * generations. Adapter failures degrade to a typed result for presentation.
 */
export class ApplicationPreviewReadProxyService {
	constructor(private readonly deps: PreviewReadProxyDeps) {}

	private targetFromAuthorizedRecord(record: VclusterPreviewRecord): PreviewRunTarget {
		let identity: PreviewControlIdentity;
		try {
			identity = validatePreviewControlIdentity({
				previewName: record.name,
				environmentRequestId:
					typeof record.provenance?.requestId === "string"
						? record.provenance.requestId
						: "",
				environmentPlatformRevision: record.platformRevision ?? "",
				environmentSourceRevision: record.sourceRevision ?? "",
				catalogDigest: (record.catalogDigest ?? "") as `sha256:${string}`,
			});
		} catch {
			throw new PreviewRuntimeIdentityChangedError(
				"preview execution reads require a complete immutable identity",
			);
		}
		return {
			name: record.name,
			url: record.url,
			pool: record.pool,
			identity,
		};
	}

	private async authorizeTarget(input: { name: string; actorUserId: string }) {
		if (!this.deps.scope.isControlPlane()) {
			throw new PreviewDeploymentScopeDeniedError(
				"preview execution proxy reads are unavailable from a preview deployment",
			);
		}
		const access = await this.deps.access.authorize({
			name: input.name,
			actorUserId: input.actorUserId,
		});
		return this.targetFromAuthorizedRecord(access.preview);
	}

	/** Recent executions inside one authorized preview generation. */
	async listPreviewExecutions(input: {
		name: string;
		actorUserId: string;
		limit?: number;
		status?: string | null;
	}): Promise<PreviewExecutionsReadModel> {
		const target = await this.authorizeTarget(input);
		const result = await this.deps.proxy.listExecutions({
			target,
			limit: input.limit,
			status: input.status ?? null,
		});
		return { preview: { name: target.name, url: target.url }, result };
	}

	/** One execution's detail inside one authorized preview generation. */
	async getPreviewExecution(input: {
		name: string;
		actorUserId: string;
		executionId: string;
	}): Promise<PreviewExecutionDetailReadModel> {
		const target = await this.authorizeTarget(input);
		const result = await this.deps.proxy.getExecution({
			target,
			executionId: input.executionId,
		});
		return { preview: { name: target.name, url: target.url }, result };
	}
}
