import { kubeApiFetch } from "./client";

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

export async function createTektonPipelineRun(
	namespace: string,
	body: TektonPipelineRun,
): Promise<{ created: boolean; pipelineRun: TektonPipelineRun | null }> {
	const res = await kubeApiFetch(
		`/apis/tekton.dev/v1/namespaces/${encodeURIComponent(namespace)}/pipelineruns`,
		{
			method: "POST",
			body: JSON.stringify(body),
			retries: 1,
		},
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
): Promise<TektonPipelineRun | null> {
	const res = await kubeApiFetch(
		`/apis/tekton.dev/v1/namespaces/${encodeURIComponent(namespace)}/pipelineruns/${encodeURIComponent(name)}`,
		{ retries: 1 },
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
): Promise<TektonTaskRun[]> {
	const labelSelector = new URLSearchParams({
		labelSelector: `tekton.dev/pipelineRun=${pipelineRunName}`,
	});
	const res = await kubeApiFetch(
		`/apis/tekton.dev/v1/namespaces/${encodeURIComponent(namespace)}/taskruns?${labelSelector}`,
		{ retries: 1 },
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
