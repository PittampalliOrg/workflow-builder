import type {
	CodeFunctionExecutionDetail,
	CodeFunctionExecutionRepository,
	FunctionRouterExecutionPayload,
	FunctionRouterExecutionPort,
} from "$lib/server/application/code-function-execution";

export class ApplicationActionCatalogTestError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationActionCatalogTestError";
	}
}

export type ActionCatalogTestAction = {
	id: string;
	displayName: string;
	raw?: Record<string, unknown> | null;
	sw: {
		taskConfig?: Record<string, unknown> | null;
		definition?: Record<string, unknown> | null;
	};
};

export type ActionCatalogTestReader = {
	getActionDetail(
		actionId: string,
		userId: string,
	): Promise<ActionCatalogTestAction | null>;
};

export type ActionCatalogHttpTestClient = {
	execute(input: {
		uri: string;
		method: string;
		headers: Record<string, string>;
		body: unknown;
	}): Promise<{
		ok: boolean;
		status: number;
		payload: unknown;
	}>;
};

export type ActionCatalogTestExecutionIdGenerator = {
	nextExecutionId(): string;
};

export type ActionCatalogTestCapabilityReader = {
	actionAvailability(slug: string): {
		available: boolean;
		code: string;
		message: string | null;
	};
};

export class ApplicationActionCatalogTestService {
	constructor(
		private readonly deps: {
			actions: ActionCatalogTestReader;
			codeFunctions: CodeFunctionExecutionRepository;
			functionRouter: FunctionRouterExecutionPort;
			http: ActionCatalogHttpTestClient;
			ids: ActionCatalogTestExecutionIdGenerator;
			capabilities?: ActionCatalogTestCapabilityReader;
		},
	) {}

	async execute(input: {
		actionId: string;
		userId: string;
		body: unknown;
	}): Promise<FunctionRouterExecutionPayload> {
		const userInput = parseUserInput(input.body);

		if (input.actionId.startsWith("code-function.")) {
			return this.executeCodeFunction({
				codeFunctionId: input.actionId.slice("code-function.".length),
				userId: input.userId,
				userInput,
			});
		}

		const action = await this.deps.actions.getActionDetail(
			input.actionId,
			input.userId,
		);
		if (!action) {
			throw new ApplicationActionCatalogTestError(404, "Action not found");
		}

		const raw = isRecord(action.raw) ? action.raw : {};
		const taskConfig =
			(isRecord(raw.taskConfig) ? raw.taskConfig : null) ??
			(isRecord(action.sw.taskConfig) ? action.sw.taskConfig : null) ??
			(isRecord(raw.definition) ? raw.definition : null) ??
			(isRecord(action.sw.definition) ? action.sw.definition : null);

		if (!taskConfig) {
			throw new ApplicationActionCatalogTestError(
				400,
				"Action does not expose an executable taskConfig",
			);
		}

		const call = typeof taskConfig.call === "string" ? taskConfig.call.trim() : "";
		if (!call) {
			throw new ApplicationActionCatalogTestError(
				400,
				"Action taskConfig is missing call",
			);
		}

		const withConfig = mergeInputIntoWithConfig(
			isRecord(taskConfig.with) ? taskConfig.with : null,
			userInput,
		);

		if (!["http", "grpc", "openapi", "asyncapi"].includes(call)) {
			const withBody = isRecord(withConfig.body) ? withConfig.body : {};
			const executableInput = isRecord(withBody.input) ? withBody.input : userInput;
			return this.executeFunctionRouterAction({
				functionSlug: call,
				nodeId: action.id,
				nodeName: action.displayName,
				input: executableInput,
				connectionExternalId: parseConnectionExternalIdFromAuthTemplate(
					executableInput.auth,
				),
			});
		}

		if (call !== "http") {
			throw new ApplicationActionCatalogTestError(
				400,
				`Direct test execution for ${call} actions is not implemented`,
			);
		}

		return this.executeHttpAction(withConfig);
	}

	private async executeCodeFunction(input: {
		codeFunctionId: string;
		userId: string;
		userInput: Record<string, unknown>;
	}): Promise<FunctionRouterExecutionPayload> {
		const detail = await this.deps.codeFunctions.getCodeFunction(
			input.codeFunctionId,
			input.userId,
		);
		if (!detail) {
			throw new ApplicationActionCatalogTestError(
				404,
				"Code function not found",
			);
		}
		return this.executeCodeFunctionDetail(detail, input.userInput);
	}

	private executeCodeFunctionDetail(
		detail: CodeFunctionExecutionDetail,
		userInput: Record<string, unknown>,
	): Promise<FunctionRouterExecutionPayload> {
		return this.executeFunctionRouterAction({
			functionSlug: `code/${detail.slug}`,
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
	}

	private async executeFunctionRouterAction(input: {
		functionSlug: string;
		nodeId: string;
		nodeName: string;
		input: Record<string, unknown>;
		connectionExternalId?: string | null;
	}): Promise<FunctionRouterExecutionPayload> {
		const availability = this.deps.capabilities?.actionAvailability(
			input.functionSlug,
		);
		if (availability && !availability.available) {
			throw new ApplicationActionCatalogTestError(
				409,
				`${availability.code}: ${availability.message ?? `${input.functionSlug} is unavailable`}`,
			);
		}
		const response = await this.deps.functionRouter.execute({
			functionSlug: input.functionSlug,
			executionId: this.deps.ids.nextExecutionId(),
			workflowId: "action-catalog-test",
			nodeId: input.nodeId,
			nodeName: input.nodeName,
			input: input.input,
			connectionExternalId: input.connectionExternalId,
			maxRetries: 1,
		});

		if (!response.ok || !response.payload) {
			throw new ApplicationActionCatalogTestError(
				response.status || 502,
				response.payload?.error ||
					`Function router returned HTTP ${response.status}`,
			);
		}

		return response.payload;
	}

	private async executeHttpAction(
		withConfig: Record<string, unknown>,
	): Promise<FunctionRouterExecutionPayload> {
		const endpoint = isRecord(withConfig.endpoint) ? withConfig.endpoint : {};
		const uri = typeof endpoint.uri === "string" ? endpoint.uri.trim() : "";
		if (!uri) {
			throw new ApplicationActionCatalogTestError(
				400,
				"HTTP action is missing endpoint.uri",
			);
		}

		const method =
			typeof withConfig.method === "string" ? withConfig.method.toUpperCase() : "POST";
		const response = await this.deps.http.execute({
			uri,
			method,
			headers: parseHeaders(withConfig.headers),
			body:
				method === "GET" || method === "HEAD" ? undefined : withConfig.body ?? {},
		});

		if (!response.ok) {
			throw new ApplicationActionCatalogTestError(
				response.status || 502,
				`HTTP action returned ${response.status}`,
			);
		}

		return {
			success: true,
			data: response.payload,
			duration_ms: 0,
		};
	}
}

export class DateActionCatalogTestExecutionIdGenerator
	implements ActionCatalogTestExecutionIdGenerator
{
	nextExecutionId(): string {
		return `action-test-${Date.now()}`;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseUserInput(body: unknown): Record<string, unknown> {
	if (!isRecord(body)) return {};
	const input = body.input;
	return isRecord(input) ? { ...input } : {};
}

function parseConnectionExternalIdFromAuthTemplate(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const match = value.match(/connections\['([^']+)'\]/);
	return match?.[1] || null;
}

function mergeInputIntoWithConfig(
	withConfig: Record<string, unknown> | null | undefined,
	input: Record<string, unknown>,
): Record<string, unknown> {
	const base = isRecord(withConfig) ? withConfig : {};
	const body = isRecord(base.body) ? { ...base.body } : {};
	const existingInput = isRecord(body.input) ? body.input : {};

	return {
		...base,
		body: {
			...body,
			input: {
				...existingInput,
				...input,
			},
		},
	};
}

function parseHeaders(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] =>
				typeof entry[0] === "string" && typeof entry[1] === "string",
		),
	);
}
