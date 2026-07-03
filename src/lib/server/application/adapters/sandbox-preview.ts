import type { SandboxPreviewGatewayPort } from "$lib/server/application/ports";
import { openshellRuntimeFetch } from "$lib/server/openshell-runtime";
import { getExecutionSandboxPreviewInfo } from "$lib/server/workflows/sandbox-preview";

export class LegacySandboxPreviewGatewayPort
	implements SandboxPreviewGatewayPort
{
	getSandboxPreviewInfo(executionId: string) {
		return getExecutionSandboxPreviewInfo(executionId);
	}

	runtimeFetch(path: string, options?: RequestInit) {
		return openshellRuntimeFetch(path, options);
	}
}
