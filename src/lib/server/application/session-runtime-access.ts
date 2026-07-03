import type {
	SessionRuntimeCapabilityReader,
	SessionRuntimePodLocator,
	WorkflowDataService,
} from "$lib/server/application/ports";

export type SessionRuntimeAccessInput = {
	sessionId: string;
	userId: string;
	projectId?: string | null;
};

export type SessionShellResolveInput = SessionRuntimeAccessInput & {
	container: string;
};

export type SessionRuntimeAccessResult =
	| {
			status: "ok";
			body: Record<string, unknown>;
	  }
	| {
			status: "error";
			httpStatus: number;
			message: string;
	  };

export class ApplicationSessionRuntimeAccessService {
	constructor(
		private readonly deps: {
			workflowData: Pick<WorkflowDataService, "getSessionRuntimeDebugTarget">;
			pods: SessionRuntimePodLocator;
			capabilities: SessionRuntimeCapabilityReader;
		},
	) {}

	async resolveShell(
		input: SessionShellResolveInput,
	): Promise<SessionRuntimeAccessResult> {
		if (!this.deps.capabilities.isShellContainerAllowed(input.container)) {
			return runtimeAccessError(400, "Invalid container");
		}

		const target = await this.deps.workflowData.getSessionRuntimeDebugTarget({
			sessionId: input.sessionId,
			projectId: input.projectId ?? null,
			userId: input.userId,
		});
		if (!target) {
			return runtimeAccessError(404, "Session not found in workspace");
		}

		const pod = await this.deps.pods.getSessionRuntimePod({
			appId: target.appId,
			agentSlug: target.agentSlug,
		});
		if (!pod) return runtimeAccessError(503, "Agent pod not running");
		if (
			!pod.containers.some(
				(container) => container.name === input.container && container.ready,
			)
		) {
			return runtimeAccessError(
				503,
				`${input.container} container not ready`,
			);
		}

		return {
			status: "ok",
			body: {
				pod: pod.name,
				namespace: pod.namespace,
				container: input.container,
			},
		};
	}

	async resolveCliTerminal(
		input: SessionRuntimeAccessInput,
	): Promise<SessionRuntimeAccessResult> {
		const target = await this.deps.workflowData.getSessionRuntimeDebugTarget({
			sessionId: input.sessionId,
			projectId: input.projectId ?? null,
			userId: input.userId,
		});
		if (!target) {
			return runtimeAccessError(404, "Session not found in workspace");
		}

		if (!this.deps.capabilities.hasInteractiveTerminal(target.agentRuntime)) {
			return runtimeAccessError(
				409,
				"Session runtime does not expose an interactive terminal",
			);
		}

		const pod = await this.deps.pods.getAgentWorkflowHostPod(target.appId);
		if (!pod?.podIP) return runtimeAccessError(503, "Agent pod not running");

		return { status: "ok", body: { podIp: pod.podIP, port: 8002 } };
	}
}

function runtimeAccessError(
	httpStatus: number,
	message: string,
): SessionRuntimeAccessResult {
	return { status: "error", httpStatus, message };
}
