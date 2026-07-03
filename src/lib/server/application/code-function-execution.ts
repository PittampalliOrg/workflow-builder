export class ApplicationCodeFunctionExecutionError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationCodeFunctionExecutionError";
	}
}

export type CodeFunctionExecutionDetail = {
	id: string;
	name: string;
	slug: string;
	version: string;
	language: string;
	entrypoint: string;
	path: string | null;
};

export type FunctionRouterExecutionPayload = {
	success?: boolean;
	data?: unknown;
	error?: string;
	routed_to?: string;
	duration_ms?: number;
};

export type CodeFunctionExecutionRepository = {
	getCodeFunction(
		id: string,
		userId: string,
	): Promise<CodeFunctionExecutionDetail | null>;
};

export type FunctionRouterExecutionPort = {
	execute(input: {
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
	}>;
};

export type CodeFunctionExecutionIdGenerator = {
	nextExecutionId(codeFunctionId: string): string;
};

export class ApplicationCodeFunctionExecutionService {
	constructor(
		private readonly deps: {
			codeFunctions: CodeFunctionExecutionRepository;
			functionRouter: FunctionRouterExecutionPort;
			ids: CodeFunctionExecutionIdGenerator;
		},
	) {}

	async execute(input: {
		id: string;
		userId: string;
		body: unknown;
	}): Promise<FunctionRouterExecutionPayload> {
		const detail = await this.deps.codeFunctions.getCodeFunction(
			input.id,
			input.userId,
		);
		if (!detail) {
			throw new ApplicationCodeFunctionExecutionError(
				404,
				"Code function not found",
			);
		}

		const userInput = parseUserInput(input.body);
		const executionId = this.deps.ids.nextExecutionId(detail.id);
		const response = await this.deps.functionRouter.execute({
			functionSlug: `code/${detail.slug}`,
			executionId,
			workflowId: "code-function-preview",
			nodeId: `code-function-${detail.id}`,
			nodeName: detail.name,
			input: {
				functionRef: {
					id: detail.id,
					slug: detail.slug,
					version: detail.version,
				},
				body: {
					input: userInput,
					metadata: {
						sourceKind: "code",
						codeFunctionId: detail.id,
						slug: detail.slug,
						version: detail.version,
						language: detail.language,
						entrypoint: detail.entrypoint,
						path: detail.path,
					},
				},
			},
		});

		if (!response.ok || !response.payload) {
			throw new ApplicationCodeFunctionExecutionError(
				response.status || 502,
				response.payload?.error ||
					`Function router returned HTTP ${response.status}`,
			);
		}

		return response.payload;
	}
}

export class DateCodeFunctionExecutionIdGenerator
	implements CodeFunctionExecutionIdGenerator
{
	nextExecutionId(codeFunctionId: string): string {
		return `code-preview-${codeFunctionId}-${Date.now()}`;
	}
}

function parseUserInput(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== "object" || Array.isArray(body)) return {};
	const input = (body as Record<string, unknown>).input;
	return input && typeof input === "object" && !Array.isArray(input)
		? { ...(input as Record<string, unknown>) }
		: {};
}
