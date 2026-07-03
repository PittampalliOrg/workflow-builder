import type {
	WorkflowRuntimeStatusPort,
	WorkflowRuntimeStatusSnapshot,
} from "$lib/server/application/ports";
import { daprFetch, getOrchestratorUrl } from "$lib/server/dapr-client";

export class DaprWorkflowRuntimeStatusPort implements WorkflowRuntimeStatusPort {
	async getWorkflowStatus(instanceId: string): Promise<WorkflowRuntimeStatusSnapshot | null> {
		const orchestratorUrl = getOrchestratorUrl();
		const res = await daprFetch(
			`${orchestratorUrl}/api/v2/workflows/${instanceId}/status`,
			{ method: "GET", maxRetries: 1 },
		);
		if (!res.ok) return null;
		const runtime = (await res.json()) as Record<string, unknown>;
		return {
			runtimeStatus:
				typeof runtime.runtimeStatus === "string" ? runtime.runtimeStatus : null,
			phase: typeof runtime.phase === "string" ? runtime.phase : null,
			progress: typeof runtime.progress === "number" ? runtime.progress : null,
			currentNodeId:
				typeof runtime.currentNodeId === "string" ? runtime.currentNodeId : null,
			currentNodeName:
				typeof runtime.currentNodeName === "string"
					? runtime.currentNodeName
					: null,
			traceId: typeof runtime.traceId === "string" ? runtime.traceId : null,
			outputs: runtime.outputs ?? null,
			error: typeof runtime.error === "string" ? runtime.error : null,
			completedAt:
				typeof runtime.completedAt === "string" ? runtime.completedAt : null,
		};
	}
}
