import type {
  SessionRuntimeHostRecoveryCleanupPort,
  SessionRuntimeHostRecoveryProviderPort,
} from "$lib/server/application/session-runtime-host-recovery";
import {
  activateAgentWorkflowHostGeneration,
  isAgentWorkflowHostAbsentError,
  recreateAgentWorkflowHostGeneration,
} from "$lib/server/sessions/agent-workflow-host";

/** Kubernetes/Sandbox provider for exact published runtime-host generations. */
export class AgentWorkflowHostRecoveryProviderAdapter implements SessionRuntimeHostRecoveryProviderPort {
  async activate(input: {
    runtimeAppId: string;
    runtimeSandboxName: string;
  }): Promise<"active" | "absent"> {
    try {
      await activateAgentWorkflowHostGeneration({
        agentAppId: input.runtimeAppId,
        sandboxName: input.runtimeSandboxName,
      });
      return "active";
    } catch (error) {
      if (isAgentWorkflowHostAbsentError(error)) return "absent";
      throw error;
    }
  }

  recreate(
    input: Parameters<SessionRuntimeHostRecoveryProviderPort["recreate"]>[0],
  ) {
    return recreateAgentWorkflowHostGeneration({
      agentAppId: input.runtimeAppId,
      sandboxName: input.runtimeSandboxName,
      launchSpec: input.launchSpec,
      sessionSecretEnv: input.sessionSecretEnv,
      traceContext: input.traceContext,
    });
  }
}

/** Keeps cleanup behind the recovery use case's narrow outbound port. */
export class SessionRuntimeHostRecoveryCleanupAdapter implements SessionRuntimeHostRecoveryCleanupPort {
  constructor(
    private readonly cleanupProvisioning: SessionRuntimeHostRecoveryCleanupPort["cleanup"],
  ) {}

  cleanup(
    input: Parameters<SessionRuntimeHostRecoveryCleanupPort["cleanup"]>[0],
  ) {
    return this.cleanupProvisioning(input);
  }
}
