import {
	browserAgentSandboxWarmPoolName,
	getAgentWorkflowHostPod as getKubernetesAgentWorkflowHostPod,
	getSandboxWarmPool,
	getSessionRuntimePod as getKubernetesSessionRuntimePod,
	kubeApiFetch,
} from "$lib/server/kube/client";
import {
	getPodResourceUsage,
	parseCpuToMillicores,
	parseMemoryToMiB,
} from "$lib/server/metrics/resources";
import {
	getRuntimeDescriptor,
	shellableContainers,
} from "$lib/server/agents/runtime-registry";
import type {
	SessionRuntimeComputeReadModel,
	SessionRuntimeDebugTarget,
	SessionRuntimeFlagsReadModel,
	SessionRuntimeCapabilityReader,
	SessionRuntimeStatusReader,
	SessionRuntimePodLocator,
	SessionRuntimePodTarget,
} from "$lib/server/application/ports";

const SHELLABLE_CONTAINERS = shellableContainers();
const NATIVE_GOAL_CLI_ADAPTERS = new Set(["claude-code", "codex"]);

function runtimeHasNativeGoalHarness(
	descriptor: { family?: string; cliAdapter?: string } | null | undefined,
): boolean {
	return (
		descriptor?.family === "interactive-cli" &&
		!!descriptor.cliAdapter &&
		NATIVE_GOAL_CLI_ADAPTERS.has(descriptor.cliAdapter)
	);
}

async function readPodRequests(
	podName: string,
	namespace: string,
): Promise<SessionRuntimeComputeReadModel["requests"]> {
	try {
		const res = await kubeApiFetch(
			`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}`,
		);
		if (!res.ok) return null;
		const body = (await res.json()) as {
			spec?: {
				containers?: Array<{
					resources?: { requests?: { cpu?: string; memory?: string } };
				}>;
			};
		};
		let cpu = 0;
		let mem = 0;
		for (const container of body.spec?.containers ?? []) {
			cpu += parseCpuToMillicores(container.resources?.requests?.cpu);
			mem += parseMemoryToMiB(container.resources?.requests?.memory);
		}
		return { cpuMillicores: Math.round(cpu), memoryMiB: Math.round(mem) };
	} catch {
		return null;
	}
}

export class KubernetesSessionRuntimeStatusReader
	implements
		SessionRuntimeStatusReader,
		SessionRuntimePodLocator,
		SessionRuntimeCapabilityReader
{
	async getSessionRuntimePod(
		target: Pick<SessionRuntimeDebugTarget, "appId" | "agentSlug">,
	): Promise<SessionRuntimePodTarget | null> {
		return getKubernetesSessionRuntimePod({
			runtimeAppId: target.appId,
			agentSlug: target.agentSlug,
		});
	}

	getAgentWorkflowHostPod(appId: string): Promise<SessionRuntimePodTarget | null> {
		return getKubernetesAgentWorkflowHostPod(appId);
	}

	isShellContainerAllowed(container: string): boolean {
		return SHELLABLE_CONTAINERS.has(container);
	}

	hasInteractiveTerminal(runtime: string | null): boolean {
		return getRuntimeDescriptor(runtime)?.capabilities?.interactiveTerminal === true;
	}

	async getSessionRuntimeCompute(
		target: SessionRuntimeDebugTarget,
	): Promise<SessionRuntimeComputeReadModel> {
		const pod = await this.getSessionRuntimePod(target);
		if (!pod?.name) {
			return { podName: null, usage: null, requests: null };
		}

		const [usage, requests] = await Promise.all([
			getPodResourceUsage(pod.name, pod.namespace),
			readPodRequests(pod.name, pod.namespace),
		]);
		return { podName: pod.name, usage, requests };
	}

	async getSessionRuntimeFlags(
		target: SessionRuntimeDebugTarget,
	): Promise<SessionRuntimeFlagsReadModel> {
		const pool = target.agentSlug
			? await getSandboxWarmPool(browserAgentSandboxWarmPoolName(target.agentSlug))
			: null;
		const desired = pool?.spec?.replicas ?? 0;
		const replicas = pool?.status?.replicas ?? 0;
		const ready = pool?.status?.readyReplicas ?? 0;
		let phase = !pool
			? "Unknown"
			: desired === 0 && replicas === 0
				? "Sleeping"
				: desired > 0 && ready >= desired
					? "Active"
					: desired > 0
						? "Starting"
						: "Unknown";

		let shellContainers: string[] = [];
		let browserSidecarEnabled = false;
		let browserMcpAvailable = false;
		const livePod = await this.getSessionRuntimePod(target);
		if (livePod) {
			if (!pool) phase = "Active";
			shellContainers = livePod.containers
				.filter((container) => container.ready && SHELLABLE_CONTAINERS.has(container.name))
				.map((container) => container.name);
			browserSidecarEnabled = livePod.containers.some(
				(container) => container.name === "playwright-mcp",
			);
			if (browserSidecarEnabled) {
				const chromiumReady = livePod.containers.some(
					(container) => container.name === "chromium" && container.ready,
				);
				const mcpReady = livePod.containers.some(
					(container) => container.name === "playwright-mcp" && container.ready,
				);
				browserMcpAvailable = chromiumReady && mcpReady;
			}
		}
		const shellAvailable = phase === "Active" && shellContainers.length > 0;
		const descriptor = getRuntimeDescriptor(target.agentRuntime);
		const interactiveTerminal = this.hasInteractiveTerminal(target.agentRuntime);
		const nativeGoalAvailable = runtimeHasNativeGoalHarness(descriptor);
		const cliLabel = interactiveTerminal
			? descriptor?.agentMetadataFramework ?? "Agent CLI"
			: null;

		return {
			agentSlug: target.agentSlug,
			runtimeAppId: target.appId,
			runtimeSandboxName: target.runtimeSandboxName,
			browserSidecarEnabled,
			browserMcpAvailable,
			shellAvailable,
			shellContainers,
			interactiveTerminal,
			nativeGoalAvailable,
			cliLabel,
			phase,
		};
	}
}
