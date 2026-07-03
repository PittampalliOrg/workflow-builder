import type { SandboxPreviewGatewayPort } from "$lib/server/application/ports";
import { openshellRuntimeFetch } from "$lib/server/openshell-runtime";
import { getExecutionSandboxPreviewInfo } from "$lib/server/workflows/sandbox-preview";
import {
	buildRuntimePreviewPath,
	getExecutionWorkspaceRoute,
} from "$lib/server/workflows/runtime-preview-url";

export class LegacySandboxPreviewGatewayPort
	implements SandboxPreviewGatewayPort
{
	getSandboxPreviewInfo(executionId: string) {
		return getExecutionSandboxPreviewInfo(executionId);
	}

	getExecutionWorkspaceRoute(executionId: string) {
		return getExecutionWorkspaceRoute(executionId);
	}

	buildRuntimePreviewPath(
		executionId: string,
		workspaceSlug: string,
		search?: string,
	) {
		return buildRuntimePreviewPath(executionId, workspaceSlug, search);
	}

	runtimeFetch(path: string, options?: RequestInit) {
		return openshellRuntimeFetch(path, options);
	}
}
