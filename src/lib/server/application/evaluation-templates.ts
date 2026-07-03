export class ApplicationEvaluationTemplateError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationEvaluationTemplateError";
	}
}

export type CodeEvaluationSuiteSlug =
	| "humaneval-plus"
	| "mbpp-plus"
	| "bigcodebench";

export type EvaluationDatasetImportFormat = "jsonl" | "json" | "csv";

export type EvaluationTemplateRepository = {
	createSwebench(input: {
		projectId: string;
		userId: string;
		suiteSlug: string;
		name: string | null;
		description: string | null;
		instanceIds: unknown;
		rows?: unknown[];
	}): Promise<unknown>;
	createCodeEval(input: {
		projectId: string;
		userId: string;
		suiteSlug: CodeEvaluationSuiteSlug;
		name: string | null;
		description: string | null;
		graderAgentSlug: string | null;
		rows?: unknown[];
	}): Promise<unknown>;
};

export type EvaluationDatasetImportParser = {
	parse(content: string, format: EvaluationDatasetImportFormat): unknown[];
};

export type SwebenchSuiteCatalog = {
	listSuites(): unknown[];
};

export class ApplicationEvaluationTemplateService {
	constructor(
		private readonly deps: {
			templates: EvaluationTemplateRepository;
			imports: EvaluationDatasetImportParser;
			swebenchSuites: SwebenchSuiteCatalog;
		},
	) {}

	listSwebenchSuites(): { suites: unknown[] } {
		return { suites: this.deps.swebenchSuites.listSuites() };
	}

	async createSwebench(input: {
		projectId: string;
		userId: string;
		body: unknown;
	}): Promise<unknown> {
		const body = asRecord(input.body);
		return this.runTemplateCall(() =>
			this.deps.templates.createSwebench({
				projectId: input.projectId,
				userId: input.userId,
				suiteSlug: String(body.suiteSlug ?? "SWE-bench_Lite"),
				name: typeof body.name === "string" ? body.name : null,
				description:
					typeof body.description === "string" ? body.description : null,
				instanceIds: body.instanceIds,
				rows: this.rowsFromBody(body),
			}),
		);
	}

	async createCodeEval(input: {
		projectId: string;
		userId: string;
		suiteSlug: CodeEvaluationSuiteSlug;
		body: unknown;
	}): Promise<unknown> {
		const body = asRecord(input.body);
		return this.runTemplateCall(() =>
			this.deps.templates.createCodeEval({
				projectId: input.projectId,
				userId: input.userId,
				suiteSlug: input.suiteSlug,
				name: typeof body.name === "string" ? body.name : null,
				description:
					typeof body.description === "string" ? body.description : null,
				graderAgentSlug:
					typeof body.graderAgentSlug === "string"
						? body.graderAgentSlug
						: null,
				rows: this.rowsFromBody(body),
			}),
		);
	}

	private rowsFromBody(body: Record<string, unknown>): unknown[] | undefined {
		if (typeof body.content === "string" && body.content.trim()) {
			return this.deps.imports.parse(
				body.content,
				body.format === "json" || body.format === "csv"
					? body.format
					: "jsonl",
			);
		}
		return Array.isArray(body.rows) ? body.rows : undefined;
	}

	private async runTemplateCall<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (err) {
			throw toApplicationError(err);
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toApplicationError(err: unknown): ApplicationEvaluationTemplateError {
	if (err instanceof ApplicationEvaluationTemplateError) return err;
	const maybe = err as { status?: unknown; body?: unknown; message?: unknown };
	const status = typeof maybe.status === "number" ? maybe.status : 500;
	const message =
		isRecord(maybe.body) && typeof maybe.body.message === "string"
			? maybe.body.message
			: typeof maybe.message === "string"
				? maybe.message
				: String(err);
	return new ApplicationEvaluationTemplateError(status, message);
}
