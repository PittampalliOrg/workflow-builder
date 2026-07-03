import {
	getCodeFunction,
	getCodeFunctionBySlug,
	type CodeFunctionDetail,
} from "$lib/server/code-functions";
import { daprFetch, getCodeRuntimeUrl } from "$lib/server/dapr-client";
import type {
	CodeFunctionOptionsDetail,
	CodeFunctionOptionsRepository,
	CodeFunctionOptionsRuntimeClient,
} from "$lib/server/application/code-function-options";

export class LegacyCodeFunctionOptionsRepository
	implements CodeFunctionOptionsRepository
{
	async getById(
		id: string,
		userId: string,
	): Promise<CodeFunctionOptionsDetail | null> {
		return mapDetail(await getCodeFunction(id, userId));
	}

	async getBySlug(
		slug: string,
		version: string,
		userId: string,
	): Promise<CodeFunctionOptionsDetail | null> {
		return mapDetail(await getCodeFunctionBySlug(slug, version, userId));
	}
}

export class DaprCodeFunctionOptionsRuntimeClient
	implements CodeFunctionOptionsRuntimeClient
{
	async fetchOptions(input: {
		language: string;
		source: string;
		handler: string;
		path?: string;
		supportingFiles: Record<string, string>;
		input: Record<string, unknown>;
		dependencies: string[];
		searchValue?: string;
	}): Promise<{
		ok: boolean;
		status: number;
		payload: unknown;
	}> {
		const response = await daprFetch(`${getCodeRuntimeUrl()}/options`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				language: input.language,
				source: input.source,
				handler: input.handler,
				path: input.path,
				supporting_files: input.supportingFiles,
				input: input.input,
				dependencies: input.dependencies,
				search_value: input.searchValue,
			}),
			maxRetries: 1,
		});

		return {
			ok: response.ok,
			status: response.status,
			payload: await response.json().catch(() => null),
		};
	}
}

function mapDetail(
	detail: CodeFunctionDetail | null,
): CodeFunctionOptionsDetail | null {
	if (!detail) return null;
	return {
		id: detail.id,
		slug: detail.slug,
		version: detail.version,
		latestPublishedVersion: detail.latestPublishedVersion,
		language: detail.language,
		source: detail.source,
		path: detail.path,
		supportingFiles: detail.supportingFiles || {},
		model: {
			language: detail.model.language,
			imports: detail.model.imports || [],
			dynamic_inputs: detail.model.dynamic_inputs || [],
		},
	};
}
