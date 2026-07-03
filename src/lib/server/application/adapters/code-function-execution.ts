import { getCodeFunction } from "$lib/server/code-functions";
import { daprFetch, getFunctionRouterUrl } from "$lib/server/dapr-client";
import type {
	CodeFunctionExecutionRepository,
	FunctionRouterExecutionPayload,
	FunctionRouterExecutionPort,
} from "$lib/server/application/code-function-execution";

export class LegacyCodeFunctionExecutionRepository
	implements CodeFunctionExecutionRepository
{
	async getCodeFunction(id: string, userId: string) {
		const detail = await getCodeFunction(id, userId);
		if (!detail) return null;
		return {
			id: detail.id,
			name: detail.name,
			slug: detail.slug,
			version: detail.version,
			language: detail.language,
			entrypoint: detail.entrypoint,
			path: detail.path,
		};
	}
}

export class DaprFunctionRouterExecutionPort
	implements FunctionRouterExecutionPort
{
	async execute(input: {
		functionSlug: string;
		executionId: string;
		workflowId: string;
		nodeId: string;
		nodeName: string;
		input: Record<string, unknown>;
	}): Promise<{
		ok: boolean;
		status: number;
		payload: FunctionRouterExecutionPayload | null;
	}> {
		const response = await daprFetch(`${getFunctionRouterUrl()}/execute`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				function_slug: input.functionSlug,
				execution_id: input.executionId,
				workflow_id: input.workflowId,
				node_id: input.nodeId,
				node_name: input.nodeName,
				input: input.input,
			}),
		});
		const payload = (await response.json().catch(() => null)) as
			| FunctionRouterExecutionPayload
			| null;
		return {
			ok: response.ok,
			status: response.status,
			payload,
		};
	}
}
