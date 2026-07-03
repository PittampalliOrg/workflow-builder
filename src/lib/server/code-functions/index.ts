import { PostgresCodeFunctionStore } from "$lib/server/application/adapters/code-functions";
import type { SaveCodeFunctionInput } from "$lib/server/code-functions/model";

export * from "$lib/server/code-functions/model";

function store() {
	return new PostgresCodeFunctionStore();
}

export function listCodeFunctions(userId?: string | null) {
	return store().listCodeFunctions(userId);
}

export function getCodeFunction(id: string, userId?: string | null) {
	return store().getCodeFunction(id, userId);
}

export function getCodeFunctionBySlugForUser(
	slug: string,
	userId?: string | null,
) {
	return store().getCodeFunctionBySlugForUser(slug, userId);
}

export function getCodeFunctionBySlug(
	slug: string,
	version: string,
	userId?: string | null,
) {
	return store().getCodeFunctionBySlug(slug, version, userId);
}

export function listCodeFunctionRevisions(
	codeFunctionId: string,
	userId?: string | null,
) {
	return store().listCodeFunctionRevisions(codeFunctionId, userId);
}

export function publishCodeFunction(id: string, userId?: string | null) {
	return store().publishCodeFunction(id, userId);
}

export function createCodeFunction(
	input: SaveCodeFunctionInput,
	userId?: string | null,
) {
	return store().createCodeFunction(input, userId);
}

export function updateCodeFunction(
	id: string,
	input: SaveCodeFunctionInput,
	userId?: string | null,
) {
	return store().updateCodeFunction(id, input, userId);
}

export function deleteCodeFunction(id: string, userId?: string | null) {
	return store().deleteCodeFunction(id, userId);
}

export async function listCodeFunctionsForCatalog(userId?: string | null) {
	const functions = await listCodeFunctions(userId);
	return functions.map((item) => ({
		name: item.slug,
		version: item.latestPublishedVersion || item.version,
		displayName: item.name,
		description: item.description || "",
		pieceName: "code-functions",
		actionName: item.entrypoint,
		sourceKind: "code" as const,
		codeFunctionId: item.id,
		language: item.language,
	}));
}
