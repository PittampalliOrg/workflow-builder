import type {
	CliPreviewGatewayPort,
	ExecutionPreviewBackend,
	WorkflowDataService,
} from "$lib/server/application/ports";
import {
	CLI_PREVIEW_DEFAULT_PORT,
	type CliPreviewDataPort,
	executionPreviewBackend,
	proxyCliPreview,
	resolveCliPreviewTarget,
	resolveExecutionCliPreviewTarget,
	startCliPreview,
} from "$lib/server/sessions/cli-preview";

export class LegacyCliPreviewGatewayPort implements CliPreviewGatewayPort {
	readonly defaultPort = CLI_PREVIEW_DEFAULT_PORT;

	constructor(
		private readonly previewData: Pick<
			WorkflowDataService,
			keyof CliPreviewDataPort
		>,
	) {}

	resolveSessionTarget(sessionId: string, projectId?: string | null) {
		return resolveCliPreviewTarget(
			sessionId,
			projectId ?? undefined,
			this.previewData,
		);
	}

	resolveExecutionTarget(
		executionId: string,
		projectId?: string | null,
		opts?: { readyBudgetSeconds?: number; provisionIfMissing?: boolean },
	) {
		return resolveExecutionCliPreviewTarget(
			executionId,
			projectId ?? undefined,
			this.previewData,
			opts,
		);
	}

	startPreview(
		podIP: string,
		opts: { cwd: string; port: number; previewCommand?: string },
	) {
		return startCliPreview(podIP, opts);
	}

	proxyPreview(input: {
		podIP: string;
		port: number;
		request: Request;
		restPath: string;
		search: string;
		proxyBasePath: string;
	}) {
		return proxyCliPreview(
			input.podIP,
			input.port,
			input.request,
			input.restPath,
			input.search,
			input.proxyBasePath,
		);
	}

	executionPreviewBackend(executionId: string): Promise<ExecutionPreviewBackend> {
		return executionPreviewBackend(executionId, this.previewData);
	}
}
