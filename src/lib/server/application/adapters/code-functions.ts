import {
	createCodeFunction,
	deleteCodeFunction,
	getCodeFunction,
	listCodeFunctions,
	publishCodeFunction,
	updateCodeFunction,
} from "$lib/server/code-functions";
import { parseCodePreview } from "$lib/server/code-parser";
import type {
	CodeFunctionDetail,
	CodeFunctionManagementRepository,
	CodeFunctionSummary,
	SaveCodeFunctionCommand,
} from "$lib/server/application/code-function-management";
import type { CodeFunctionParsePreviewPort } from "$lib/server/application/code-function-parse-preview";

export class LegacyCodeFunctionManagementRepository
	implements CodeFunctionManagementRepository
{
	async list(userId: string): Promise<CodeFunctionSummary[]> {
		return listCodeFunctions(userId);
	}

	async get(id: string, userId: string): Promise<CodeFunctionDetail | null> {
		return getCodeFunction(id, userId);
	}

	async create(
		input: SaveCodeFunctionCommand,
		userId: string,
	): Promise<CodeFunctionDetail> {
		return createCodeFunction(input, userId);
	}

	async update(
		id: string,
		input: SaveCodeFunctionCommand,
		userId: string,
	): Promise<CodeFunctionDetail | null> {
		return updateCodeFunction(id, input, userId);
	}

	async delete(id: string, userId: string): Promise<boolean> {
		return deleteCodeFunction(id, userId);
	}

	async publish(id: string, userId: string): Promise<CodeFunctionDetail | null> {
		return publishCodeFunction(id, userId);
	}
}

export class LegacyCodeFunctionParsePreviewPort
	implements CodeFunctionParsePreviewPort
{
	async parse(input: {
		language: "typescript" | "python";
		source: string;
		entrypoint?: string;
		path?: string;
		supportingFiles?: Record<string, string>;
	}): Promise<unknown> {
		return parseCodePreview(input);
	}
}
