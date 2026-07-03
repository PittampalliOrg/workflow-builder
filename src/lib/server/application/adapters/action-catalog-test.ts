import { getActionCatalogDetail } from "$lib/server/action-catalog";
import { daprFetch } from "$lib/server/dapr-client";
import type {
	ActionCatalogHttpTestClient,
	ActionCatalogTestAction,
	ActionCatalogTestReader,
} from "$lib/server/application/action-catalog-test";

export class LocalActionCatalogTestReader implements ActionCatalogTestReader {
	async getActionDetail(
		actionId: string,
		userId: string,
	): Promise<ActionCatalogTestAction | null> {
		const action = await getActionCatalogDetail(actionId, userId);
		if (!action) return null;
		return {
			id: action.id,
			displayName: action.displayName,
			raw: action.raw ?? null,
			sw: {
				taskConfig: action.sw.taskConfig,
				definition: action.sw.definition,
			},
		};
	}
}

export class DaprActionCatalogHttpTestClient
	implements ActionCatalogHttpTestClient
{
	async execute(input: {
		uri: string;
		method: string;
		headers: Record<string, string>;
		body: unknown;
	}): Promise<{
		ok: boolean;
		status: number;
		payload: unknown;
	}> {
		const response = await daprFetch(input.uri, {
			method: input.method,
			headers: {
				"content-type": "application/json",
				...input.headers,
			},
			body: input.body === undefined ? undefined : JSON.stringify(input.body),
			maxRetries: 1,
		});

		return {
			ok: response.ok,
			status: response.status,
			payload: await response.json().catch(() => null),
		};
	}
}
