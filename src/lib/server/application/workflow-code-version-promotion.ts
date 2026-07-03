import type {
	SourceBundlePromotionGatePort,
	SourceBundlePromotionMode,
	SourceBundlePromotionRunnerPort,
	WorkflowDataService,
} from "$lib/server/application/ports";

export type WorkflowCodeVersionPromotionInput = {
	executionId: string;
	artifactId: string;
	userId: string;
	projectId?: string | null;
	body: unknown;
};

export type WorkflowCodeVersionPromotionResult =
	| {
			status: "ok";
			body: Record<string, unknown>;
			httpStatus?: number;
	  }
	| { status: "error"; httpStatus: number; message: string };

const SOURCE_BUNDLE_KIND = "source-bundle";

export class ApplicationWorkflowCodeVersionPromotionService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				| "getScopedExecutionById"
				| "getWorkflowArtifactForExecution"
				| "updateWorkflowArtifactMetadata"
			>;
			promotionGate: SourceBundlePromotionGatePort;
			runner: SourceBundlePromotionRunnerPort;
			now?: () => Date;
		},
	) {}

	async promote(
		input: WorkflowCodeVersionPromotionInput,
	): Promise<WorkflowCodeVersionPromotionResult> {
		const execution = await this.deps.workflowData.getScopedExecutionById({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (!execution) return promotionError(404, "Execution not found");

		const artifact = await this.deps.workflowData.getWorkflowArtifactForExecution({
			executionId: input.executionId,
			artifactId: input.artifactId,
		});
		if (!artifact || artifact.kind !== SOURCE_BUNDLE_KIND || !artifact.fileId) {
			return promotionError(404, "Source-bundle version not found");
		}

		const body = asRecord(input.body);
		const executionInput = execution.input ?? {};
		const payload = asRecord(artifact.inlinePayload);
		const tier = typeof payload.tier === "string" && payload.tier ? payload.tier : "full";
		const repo =
			normalizeRepo(body.repo) ??
			normalizeRepo(payload.repoUrl) ??
			normalizeRepo(executionInput.repoUrl);
		if (!repo) {
			return promotionError(
				400,
				"Target repo could not be resolved — pass { repo: 'owner/name' }",
			);
		}

		const base =
			readNonEmptyString(body.base) ??
			readNonEmptyString(payload.base) ??
			readNonEmptyString(executionInput.repoRef) ??
			"main";
		const mode: SourceBundlePromotionMode = body.mode === "branch" ? "branch" : "pr";
		const promotionGate = this.deps.promotionGate.evaluatePromotionGate({
			mode,
			artifactPayload: payload,
			executionOutput: execution.output,
			summaryOutput: execution.summaryOutput,
		});
		if (!promotionGate.allowed) {
			return {
				status: "ok",
				httpStatus: 409,
				body: {
					ok: false,
					error: "promotion_gate_failed",
					promotionGate,
				},
			};
		}

		const title =
			readNonEmptyString(body.title) ?? "Promoted change (workflow-builder)";
		const repoSubdir = normalizeRepoSubdir(payload.repoSubdir);
		const syncPaths = normalizeSyncPaths(payload.syncPaths);
		const result = await this.deps.runner.promoteSourceBundle({
			executionId: input.executionId,
			fileId: artifact.fileId,
			repo,
			base,
			mode,
			title,
			tier,
			repoSubdir,
			syncPaths,
		});

		if (result.status === "unavailable") {
			return promotionError(502, result.message);
		}
		if (result.status === "command_error") {
			return {
				status: "ok",
				httpStatus: 502,
				body: {
					ok: false,
					error: result.error,
					output: result.output.slice(0, 2000),
				},
			};
		}

		if (result.prUrl || result.branch) {
			const promotion = {
				prUrl: result.prUrl,
				branch: result.branch,
				mode,
				repo,
				base,
				promotedAt: (this.deps.now?.() ?? new Date()).toISOString(),
				promotedBy: input.userId,
			};
			await this.deps.workflowData.updateWorkflowArtifactMetadata({
				executionId: input.executionId,
				artifactId: input.artifactId,
				metadata: { ...(artifact.metadata ?? {}), promotion },
			});
		}

		return {
			status: "ok",
			body: {
				ok: true,
				mode,
				repo,
				base,
				tier,
				promotionGate,
				prUrl: result.prUrl,
				branch: result.branch,
				prError: result.prError,
				output: result.output.slice(0, 2000),
			},
		};
	}
}

function normalizeRepo(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	const repo = raw
		.trim()
		.replace(/^git@github\.com:/, "")
		.replace(/^https?:\/\/github\.com\//, "")
		.replace(/\.git$/, "")
		.replace(/^\/+|\/+$/g, "");
	return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

function normalizeRepoSubdir(raw: unknown): string {
	const value = readNonEmptyString(raw);
	if (!value || value === ".") return "";
	return value.replace(/^\/+|\/+$/g, "");
}

function normalizeSyncPaths(raw: unknown): string[] {
	if (!Array.isArray(raw)) return ["src"];
	const paths = raw.filter((path): path is string => Boolean(readNonEmptyString(path)));
	return paths.length ? paths : ["src"];
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function promotionError(
	httpStatus: number,
	message: string,
): WorkflowCodeVersionPromotionResult {
	return { status: "error", httpStatus, message };
}
