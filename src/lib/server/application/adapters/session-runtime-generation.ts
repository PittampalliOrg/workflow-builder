import type {
  SessionRuntimeProvisioningGeneration,
  StaleSessionRuntimeProvisioningTarget,
} from "$lib/server/application/ports";
import { sessionRuntimeGenerationInstanceId } from "$lib/server/application/session-runtime-identity";
import { rotateAgentWorkflowHostLaunchSpecGeneration } from "$lib/server/sessions/agent-workflow-host";

/** Infrastructure adapter for provider-specific runtime generation identities. */
export function createSessionRuntimeProvisioningReplacement(input: {
  current: StaleSessionRuntimeProvisioningTarget;
  startedAt: Date;
}): SessionRuntimeProvisioningGeneration {
  const { current, startedAt } = input;
  const durableInstanceId = sessionRuntimeGenerationInstanceId(
    current.sessionId,
    startedAt,
  );
  if (!durableInstanceId) {
    throw new Error(
      "stale runtime target has an invalid replacement generation",
    );
  }
  if (!current.runtimeHostOwned) {
    return {
      runtimeAppId: current.runtimeAppId,
      durableInstanceId,
      runtimeSandboxName: current.runtimeSandboxName,
      runtimeHostOwned: false,
      runtimeHostLaunchSpec: current.runtimeHostLaunchSpec,
    };
  }
  const runtimeSandboxName = current.runtimeSandboxName?.trim();
  if (!runtimeSandboxName || !current.runtimeHostLaunchSpec) {
    throw new Error("owned stale runtime target is missing its launch recipe");
  }
  const replacement = rotateAgentWorkflowHostLaunchSpecGeneration({
    sessionId: current.sessionId,
    currentAgentAppId: current.runtimeAppId,
    currentSandboxName: runtimeSandboxName,
    provisioningStartedAt: startedAt,
    launchSpec: current.runtimeHostLaunchSpec,
  });
  return {
    runtimeAppId: replacement.agentAppId,
    durableInstanceId,
    runtimeSandboxName: replacement.sandboxName,
    runtimeHostOwned: true,
    runtimeHostLaunchSpec: replacement.launchSpec,
  };
}
