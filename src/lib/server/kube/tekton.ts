import { env } from "$env/dynamic/private";
import { kubeApiFetch, kubeApiFetchFromKubeconfig } from "./client";

export type TektonPipelineRun = {
	apiVersion?: string;
	kind?: string;
	metadata?: {
		name?: string;
		namespace?: string;
		creationTimestamp?: string;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
	};
	spec?: Record<string, unknown>;
	status?: {
		conditions?: Array<{
			type?: string;
			status?: string;
			reason?: string;
			message?: string;
			lastTransitionTime?: string;
		}>;
		pipelineResults?: Array<{ name?: string; value?: string | string[] }>;
		results?: Array<{ name?: string; value?: string | string[] }>;
		startTime?: string;
		completionTime?: string;
	};
};

export type TektonCondition = NonNullable<
	NonNullable<TektonPipelineRun["status"]>["conditions"]
>[number];

export type TektonTaskRun = {
	apiVersion?: string;
	kind?: string;
	metadata?: {
		name?: string;
		namespace?: string;
		creationTimestamp?: string;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
	};
	spec?: Record<string, unknown>;
	status?: {
		conditions?: TektonCondition[];
		taskResults?: Array<{ name?: string; value?: string | string[] }>;
		results?: Array<{ name?: string; value?: string | string[] }>;
		startTime?: string;
		completionTime?: string;
		podName?: string;
		steps?: Array<{
			name?: string;
			container?: string;
			waiting?: Record<string, unknown>;
			running?: Record<string, unknown>;
			terminated?: Record<string, unknown>;
		}>;
	};
};

type TektonList<T> = {
	items?: T[];
};

export type TektonTargetCluster = "local" | "hub";

type TektonRequestOptions = {
	targetCluster?: TektonTargetCluster;
};

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readEnvString(name: string): string | null {
	return readString(env[name]) ?? readString(process.env[name]);
}

export function configuredHubTektonKubeconfig() {
	return {
		path:
			readEnvString("SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG") ??
			readEnvString("SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG_PATH") ??
			readEnvString("HUB_KUBECONFIG"),
		content:
			readEnvString("SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG_CONTENT") ??
			readEnvString("SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG_YAML"),
		context: readEnvString("SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG_CONTEXT"),
	};
}

export function hasConfiguredHubTektonKubeconfig(): boolean {
	const config = configuredHubTektonKubeconfig();
	return Boolean(config.path || config.content);
}

function tektonFetch(
	path: string,
	init: RequestInit & { retries?: number } = {},
	options: TektonRequestOptions = {},
): Promise<Response> {
	if (options.targetCluster !== "hub") return kubeApiFetch(path, init);
	const config = configuredHubTektonKubeconfig();
	if (!config.path && !config.content) {
		throw new Error(
			"hub Tekton kubeconfig is not configured; set SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG",
		);
	}
	return kubeApiFetchFromKubeconfig(path, init, {
		kubeconfigPath: config.path,
		kubeconfigContent: config.content,
		context: config.context,
	});
}

export async function createTektonPipelineRun(
	namespace: string,
	body: TektonPipelineRun,
	options: TektonRequestOptions = {},
): Promise<{ created: boolean; pipelineRun: TektonPipelineRun | null }> {
	const res = await tektonFetch(
		`/apis/tekton.dev/v1/namespaces/${encodeURIComponent(namespace)}/pipelineruns`,
		{
			method: "POST",
			body: JSON.stringify(body),
			retries: 1,
		},
		options,
	);
	if (res.status === 409) return { created: false, pipelineRun: null };
	if (!res.ok) {
		throw new Error(`create PipelineRun failed: ${res.status} ${await res.text()}`);
	}
	return {
		created: true,
		pipelineRun: (await res.json()) as TektonPipelineRun,
	};
}

export async function getTektonPipelineRun(
	namespace: string,
	name: string,
	options: TektonRequestOptions = {},
): Promise<TektonPipelineRun | null> {
	const res = await tektonFetch(
		`/apis/tekton.dev/v1/namespaces/${encodeURIComponent(namespace)}/pipelineruns/${encodeURIComponent(name)}`,
		{ retries: 1 },
		options,
	);
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`get PipelineRun ${namespace}/${name} failed: ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as TektonPipelineRun;
}

export async function listTektonTaskRunsForPipelineRun(
	namespace: string,
	pipelineRunName: string,
	options: TektonRequestOptions = {},
): Promise<TektonTaskRun[]> {
	const labelSelector = new URLSearchParams({
		labelSelector: `tekton.dev/pipelineRun=${pipelineRunName}`,
	});
	const res = await tektonFetch(
		`/apis/tekton.dev/v1/namespaces/${encodeURIComponent(namespace)}/taskruns?${labelSelector}`,
		{ retries: 1 },
		options,
	);
	if (res.status === 404) return [];
	if (!res.ok) {
		throw new Error(
			`list TaskRuns for PipelineRun ${namespace}/${pipelineRunName} failed: ${res.status} ${await res.text()}`,
		);
	}
	const body = (await res.json()) as TektonList<TektonTaskRun>;
	return Array.isArray(body.items) ? body.items : [];
}

export function tektonPipelineRunResults(
	pipelineRun: TektonPipelineRun | null | undefined,
): Record<string, string> {
	const rawResults = [
		...(pipelineRun?.status?.pipelineResults ?? []),
		...(pipelineRun?.status?.results ?? []),
	];
	const results: Record<string, string> = {};
	for (const result of rawResults) {
		if (!result?.name) continue;
		results[result.name] = Array.isArray(result.value)
			? result.value.join("\n")
			: String(result.value ?? "");
	}
	return results;
}

export function tektonTaskRunResults(
	taskRun: TektonTaskRun | null | undefined,
): Record<string, string> {
	const rawResults = [
		...(taskRun?.status?.taskResults ?? []),
		...(taskRun?.status?.results ?? []),
	];
	const results: Record<string, string> = {};
	for (const result of rawResults) {
		if (!result?.name) continue;
		results[result.name] = Array.isArray(result.value)
			? result.value.join("\n")
			: String(result.value ?? "");
	}
	return results;
}

export function tektonSucceededCondition(
	pipelineRun: TektonPipelineRun | null | undefined,
) {
	return pipelineRun?.status?.conditions?.find((condition) => condition.type === "Succeeded") ?? null;
}

export function tektonTaskRunSucceededCondition(
	taskRun: TektonTaskRun | null | undefined,
) {
	return taskRun?.status?.conditions?.find((condition) => condition.type === "Succeeded") ?? null;
}
