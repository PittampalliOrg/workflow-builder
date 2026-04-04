import { env } from '$env/dynamic/private';

export type CodeParserLanguage = 'typescript' | 'python';

export interface CodeParserRequest {
	language: CodeParserLanguage;
	source: string;
	entrypoint?: string;
	path?: string;
	supportingFiles?: Record<string, string>;
}

export interface CodeParserDiagnostic {
	severity: 'error' | 'warning';
	message: string;
}

export interface CodeParserSemanticType {
	kind: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum' | 'union' | 'null' | 'unknown';
	name?: string | null;
	nullable?: boolean;
	item_type?: CodeParserSemanticType | null;
	properties?: Array<{
		name: string;
		type: CodeParserSemanticType;
		required: boolean;
		description?: string | null;
	}>;
	variants?: CodeParserSemanticType[];
	enum_values?: unknown[];
	resource_type?: string | null;
	original?: string | null;
}

export interface CodeParserParam {
	name: string;
	required: boolean;
	description?: string | null;
	default_value?: unknown;
	dynamic_input?: {
		name: string;
		handler: string;
		depends_on?: string[];
		search?: boolean;
	} | null;
	type: CodeParserSemanticType;
	schema: Record<string, unknown>;
}

export interface CodeParserModel {
	language: CodeParserLanguage;
	entrypoint: string;
	is_async: boolean;
	imports: Array<{
		specifier: string;
		kind: 'local' | 'external';
		resolved_path?: string | null;
	}>;
	params: CodeParserParam[];
	dynamic_inputs?: Array<{
		name: string;
		handler: string;
		depends_on?: string[];
		search?: boolean;
	}>;
	return_type: CodeParserSemanticType;
	schema: Record<string, unknown>;
	diagnostics: CodeParserDiagnostic[];
	capabilities: {
		has_enums: boolean;
		has_nested_objects: boolean;
		has_nullable_types: boolean;
		has_relative_imports: boolean;
		has_resource_types?: boolean;
		has_dynamic_inputs: boolean;
	};
}

export interface CodeParserResponse {
	model: CodeParserModel;
}

const DEFAULT_URL = 'http://code-parser.workflow-builder.svc.cluster.local:8080';

export function getCodeParserUrl(): string {
	const url =
		env.CODE_PARSER_URL ||
		env.CODE_FUNCTION_PARSER_URL ||
		DEFAULT_URL;

	if (url.startsWith('http://') || url.startsWith('https://')) {
		return url;
	}

	return `http://${url}`;
}

export async function parseCodePreview(request: CodeParserRequest): Promise<CodeParserModel> {
	const response = await fetch(`${getCodeParserUrl()}/parse/preview`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			language: request.language,
			source: request.source,
			entrypoint: request.entrypoint,
			path: request.path,
			supporting_files: request.supportingFiles ?? {},
		}),
	});

	const payload = (await response.json().catch(() => null)) as
		| CodeParserResponse
		| { error?: string }
		| null;

	if (!response.ok) {
		const errorMessage =
			payload && 'error' in payload && payload.error
				? payload.error
				: `HTTP ${response.status}`;
		throw new Error(errorMessage);
	}

	if (!payload || !('model' in payload) || !payload.model) {
		throw new Error('Parser service returned an invalid response');
	}

	return payload.model;
}
