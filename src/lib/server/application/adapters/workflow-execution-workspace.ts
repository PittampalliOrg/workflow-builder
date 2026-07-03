import type { WorkflowExecutionWorkspacePort } from "$lib/server/application/ports";
import {
	listWorkspaceTree,
	readWorkspaceFile,
} from "$lib/server/workflows/juicefs-webdav";

export class JuiceFsWorkflowExecutionWorkspaceAdapter implements WorkflowExecutionWorkspacePort {
	listTree(instanceId: string) {
		return listWorkspaceTree(instanceId);
	}

	readFile(instanceId: string, relPath: string) {
		return readWorkspaceFile(instanceId, relPath);
	}
}
