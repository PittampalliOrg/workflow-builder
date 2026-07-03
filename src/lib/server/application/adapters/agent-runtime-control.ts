import {
	getAgentRuntimePod,
	getSandboxWarmPool,
	listSandboxWarmPools,
	setSandboxWarmPoolReplicas,
	sleepAgentRuntime,
	wakeAgentRuntime,
	type SandboxWarmPool,
} from "$lib/server/kube/client";
import type {
	AgentRuntimePodRecord,
	AgentRuntimeWakeResult,
	AgentRuntimeWarmPoolClient,
	AgentRuntimeWarmPoolRecord,
} from "$lib/server/application/ports";

export class KubernetesAgentRuntimeWarmPoolClient implements AgentRuntimeWarmPoolClient {
	async listWarmPools(namespace?: string): Promise<AgentRuntimeWarmPoolRecord[]> {
		const pools = await listSandboxWarmPools(namespace);
		return pools.map(toWarmPoolRecord);
	}

	async getWarmPool(
		name: string,
		namespace?: string,
	): Promise<AgentRuntimeWarmPoolRecord | null> {
		const pool = await getSandboxWarmPool(name, namespace);
		return pool ? toWarmPoolRecord(pool) : null;
	}

	async getRuntimePod(
		runtimeSlug: string,
		namespace?: string,
	): Promise<AgentRuntimePodRecord | null> {
		const pod = await getAgentRuntimePod(runtimeSlug, namespace);
		if (!pod) return null;
		return {
			name: pod.name,
			namespace: pod.namespace,
			containers: pod.containers,
		};
	}

	async wakeRuntime(
		runtimeSlug: string,
		timeoutMs: number,
		namespace?: string,
	): Promise<AgentRuntimeWakeResult> {
		return wakeAgentRuntime(runtimeSlug, timeoutMs, namespace);
	}

	async sleepRuntime(runtimeSlug: string, namespace?: string): Promise<void> {
		await sleepAgentRuntime(runtimeSlug, namespace);
	}

	async setWarmPoolReplicas(
		name: string,
		replicas: number,
		namespace?: string,
	): Promise<void> {
		await setSandboxWarmPoolReplicas(name, replicas, namespace);
	}
}

function toWarmPoolRecord(pool: SandboxWarmPool): AgentRuntimeWarmPoolRecord {
	return {
		name: pool.metadata.name,
		namespace: pool.metadata.namespace ?? "workflow-builder",
		labels: pool.metadata.labels ?? {},
		annotations: pool.metadata.annotations ?? {},
		desiredReplicas: pool.spec?.replicas ?? 0,
		replicas: pool.status?.replicas ?? 0,
		readyReplicas: pool.status?.readyReplicas ?? 0,
		sandboxTemplateRefName: pool.spec.sandboxTemplateRef.name,
	};
}
