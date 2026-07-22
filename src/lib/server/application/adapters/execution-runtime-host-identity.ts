import type {
	WorkflowExecutionRuntimeHostIdentity,
	WorkflowExecutionRuntimeHostIdentityFactory,
} from "$lib/server/application/ports";
import { sessionHostAppId } from "$lib/server/sessions/agent-workflow-host";

export class AgentWorkflowExecutionRuntimeHostIdentityFactory
	implements WorkflowExecutionRuntimeHostIdentityFactory
{
	create(input: {
		executionId: string;
		purpose: "cli-workspace-command";
		helperSessionId: string;
		generationStartedAt: Date;
	}): WorkflowExecutionRuntimeHostIdentity {
		const runtimeAppId = sessionHostAppId(
			input.helperSessionId,
			input.generationStartedAt,
		);
		return {
			...input,
			runtimeAppId,
			runtimeInstanceId: input.executionId,
			runtimeSandboxName: `agent-host-${runtimeAppId}`,
			owned: true,
		};
	}
}
