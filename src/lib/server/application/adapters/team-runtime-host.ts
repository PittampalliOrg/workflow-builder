import type { TeamRuntimeHostPort } from "$lib/server/application/ports";
import {
  deleteSessionRuntimeExitedPods,
  getKubernetesSandbox,
  getSessionRuntimePodStatus,
  resumeSessionSandbox,
  sandboxDesiredRunning,
  suspendSessionSandbox,
} from "$lib/server/kube/client";
import { waitForAgentWorkflowHostAppReady } from "$lib/server/sessions/agent-workflow-host";

/** Kubernetes-backed teammate runtime host adapter. */
export class KubernetesTeamRuntimeHostAdapter implements TeamRuntimeHostPort {
  getPodStatus(input: { runtimeAppId: string }) {
    return getSessionRuntimePodStatus(input);
  }

  async getSandboxState(sandboxName: string) {
    const sandbox = await getKubernetesSandbox(sandboxName);
    if (!sandbox) return { presence: "absent" as const };
    return {
      presence: "present" as const,
      desiredRunning: sandboxDesiredRunning(sandbox),
    };
  }

  deleteExitedPods(input: { runtimeAppId: string }) {
    return deleteSessionRuntimeExitedPods(input);
  }

  suspend(sandboxName: string) {
    return suspendSessionSandbox(sandboxName);
  }

  resume(sandboxName: string) {
    return resumeSessionSandbox(sandboxName);
  }

  async waitUntilReady(input: {
    runtimeAppId: string;
    timeoutSeconds: number;
  }): Promise<void> {
    await waitForAgentWorkflowHostAppReady({
      agentAppId: input.runtimeAppId,
      timeoutSeconds: input.timeoutSeconds,
    });
  }
}
