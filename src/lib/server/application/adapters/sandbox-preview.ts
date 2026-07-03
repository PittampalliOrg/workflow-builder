import type {
	SandboxPreviewGatewayPort,
	WorkflowDataService,
} from "$lib/server/application/ports";
import { openshellRuntimeFetch } from "$lib/server/openshell-runtime";
import { getExecutionSandboxPreviewInfo } from "$lib/server/workflows/sandbox-preview";

export class LegacySandboxPreviewGatewayPort
	implements SandboxPreviewGatewayPort
{
	constructor(
		private readonly data: Pick<
			WorkflowDataService,
			"getExecutionById" | "listWorkflowWorkspaceSessionsByExecutionId"
		>,
	) {}

	getSandboxPreviewInfo(executionId: string) {
		return getExecutionSandboxPreviewInfo(executionId, this.data);
	}

	runtimeFetch(path: string, options?: RequestInit) {
		return openshellRuntimeFetch(path, options);
	}
}
