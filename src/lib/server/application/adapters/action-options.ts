import { getActionCatalogDetail } from "$lib/server/action-catalog";
import { getCodeFunction } from "$lib/server/code-functions";
import {
	getDecryptedAppConnection,
	normalizePieceName,
} from "$lib/server/app-connections";
import { apPieceServiceUrl } from "$lib/server/activepieces/piece-service";
import { daprFetch } from "$lib/server/dapr-client";
import type {
	ActionOptionsActionCatalogReader,
	ActionOptionsCatalogDetail,
	ActionOptionsCodeFunctionPort,
	ActionOptionsConnectionReader,
	ActionOptionsHttpResult,
	ActionOptionsPieceClient,
	ActionOptionsUnavailableResult,
} from "$lib/server/application/action-options";

const OPTIONS_PROXY_TIMEOUT_MS = 30_000;

export class LocalActionOptionsCatalogReader
	implements ActionOptionsActionCatalogReader
{
	async getActionDetail(
		actionId: string,
		userId: string,
	): Promise<ActionOptionsCatalogDetail | null> {
		const action = await getActionCatalogDetail(actionId, userId);
		if (!action) return null;
		return {
			id: action.id,
			slug: action.slug,
			serviceId: action.serviceId,
			providerId: action.providerId ?? null,
			group: action.group,
			actionName: action.actionName ?? null,
			entrypoint: action.entrypoint ?? null,
			raw: action.raw ?? null,
			auth: action.auth ? { required: action.auth.required } : null,
		};
	}
}

export class LocalCodeFunctionOptionsPort implements ActionOptionsCodeFunctionPort {
	async getCodeFunction(codeFunctionId: string, userId: string) {
		const detail = await getCodeFunction(codeFunctionId, userId);
		if (!detail) return null;
		return {
			id: detail.id,
			slug: detail.slug,
			version: detail.version,
		};
	}

	async fetchOptions(input: {
		requestUrl: string;
		cookie: string;
		functionRef: { id: string; slug: string; version: string };
		param: string;
		input: Record<string, unknown>;
		searchValue?: string;
	}): Promise<ActionOptionsHttpResult> {
		const response = await fetch(
			new URL("/api/code-functions/options", input.requestUrl),
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: input.cookie,
				},
				body: JSON.stringify({
					functionRef: input.functionRef,
					param: input.param,
					input: input.input,
					searchValue: input.searchValue,
				}),
			},
		);
		return {
			status: response.status,
			payload: await response.json().catch(() => null),
		};
	}
}

export class WorkflowDataActionOptionsConnectionReader
	implements ActionOptionsConnectionReader
{
	async getDecryptedConnection(connectionExternalId: string) {
		const connection = await getDecryptedAppConnection(connectionExternalId);
		if (!connection) return null;
		return {
			pieceName: connection.pieceName,
			value: connection.value,
		};
	}

	normalizePieceName(pieceName: string | null | undefined): string {
		return normalizePieceName(pieceName);
	}
}

export class DaprPieceOptionsClient implements ActionOptionsPieceClient {
	async fetchOptions(input: {
		pieceName: string;
		actionName: string;
		propertyName: string;
		auth: unknown;
		input: Record<string, unknown>;
		searchValue?: string;
	}): Promise<ActionOptionsHttpResult | ActionOptionsUnavailableResult> {
		let response: Response;
		try {
			response = await daprFetch(`${apPieceServiceUrl(input.pieceName)}/options`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					pieceName: input.pieceName,
					actionName: input.actionName,
					propertyName: input.propertyName,
					auth: input.auth,
					input: input.input,
					searchValue: input.searchValue,
				}),
				maxRetries: 1,
				signal: AbortSignal.timeout(OPTIONS_PROXY_TIMEOUT_MS),
			});
		} catch (err) {
			return {
				unavailable: true,
				message: err instanceof Error ? err.message : String(err),
			};
		}

		if ([502, 503, 504].includes(response.status)) {
			const text = await response.text().catch(() => "");
			return {
				unavailable: true,
				message: text || `HTTP ${response.status}`,
			};
		}

		return {
			status: response.status,
			payload: await response.json().catch(() => null),
		};
	}
}
