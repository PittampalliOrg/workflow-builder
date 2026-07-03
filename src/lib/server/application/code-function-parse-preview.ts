import type {
	CodeFunctionLanguage,
	SaveCodeFunctionCommand,
} from "$lib/server/application/code-function-management";

export class ApplicationCodeFunctionParsePreviewError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationCodeFunctionParsePreviewError";
	}
}

export type CodeFunctionParsePreviewPort = {
	parse(input: {
		language: CodeFunctionLanguage;
		source: string;
		entrypoint?: string;
		path?: string;
		supportingFiles?: Record<string, string>;
	}): Promise<unknown>;
};

export class ApplicationCodeFunctionParsePreviewService {
	constructor(private readonly parser: CodeFunctionParsePreviewPort) {}

	async parse(input: { body: unknown }): Promise<{ model: unknown }> {
		const command = parsePreviewCommand(input.body);
		try {
			return {
				model: await this.parser.parse({
					language: command.language,
					source: command.source,
					entrypoint: command.entrypoint || undefined,
					path: command.path || undefined,
					supportingFiles: command.supportingFiles || undefined,
				}),
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new ApplicationCodeFunctionParsePreviewError(502, message);
		}
	}
}

function parsePreviewCommand(body: unknown): SaveCodeFunctionCommand {
	const data = isRecord(body) ? body : null;
	if (!data) {
		throw new ApplicationCodeFunctionParsePreviewError(400, "Invalid JSON body");
	}
	if (!isLanguage(data.language)) {
		throw new ApplicationCodeFunctionParsePreviewError(
			400,
			"language must be typescript or python",
		);
	}
	if (typeof data.source !== "string" || data.source.trim().length === 0) {
		throw new ApplicationCodeFunctionParsePreviewError(400, "source is required");
	}

	return {
		name: "preview",
		description: null,
		language: data.language,
		entrypoint:
			typeof data.entrypoint === "string" && data.entrypoint.trim()
				? data.entrypoint.trim()
				: null,
		path:
			typeof data.path === "string" && data.path.trim()
				? data.path.trim()
				: null,
		source: data.source,
		supportingFiles:
			isRecord(data.supporting_files) || isRecord(data.supportingFiles)
				? stringRecord(
						(isRecord(data.supporting_files)
							? data.supporting_files
							: data.supportingFiles) as Record<string, unknown>,
					)
				: null,
	};
}

function isLanguage(value: unknown): value is CodeFunctionLanguage {
	return value === "typescript" || value === "python";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}
