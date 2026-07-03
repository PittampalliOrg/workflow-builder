export class ApplicationActionOptionsError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationActionOptionsError";
	}
}

export type ActionOptionsCatalogDetail = {
	id: string;
	slug: string;
	serviceId: string;
	providerId?: string | null;
	group: string;
	actionName?: string | null;
	entrypoint?: string | null;
	raw?: Record<string, unknown> | null;
	auth?: { required?: boolean } | null;
};

export type ActionOptionsCodeFunctionRef = {
	id: string;
	slug: string;
	version: string;
};

export type ActionOptionsConnection = {
	pieceName: string;
	value: unknown;
};

export type ActionOptionsHttpResult = {
	status: number;
	payload: unknown;
};

export type ActionOptionsUnavailableResult = {
	unavailable: true;
	message: string;
};

export type ActionOptionsActionCatalogReader = {
	getActionDetail(
		actionId: string,
		userId: string,
	): Promise<ActionOptionsCatalogDetail | null>;
};

export type ActionOptionsCodeFunctionPort = {
	getCodeFunction(
		codeFunctionId: string,
		userId: string,
	): Promise<ActionOptionsCodeFunctionRef | null>;
	fetchOptions(input: {
		userId: string;
		functionRef: ActionOptionsCodeFunctionRef;
		param: string;
		input: Record<string, unknown>;
		searchValue?: string;
	}): Promise<ActionOptionsHttpResult>;
};

export type ActionOptionsConnectionReader = {
	getDecryptedConnection(
		connectionExternalId: string,
	): Promise<ActionOptionsConnection | null>;
	normalizePieceName(pieceName: string | null | undefined): string;
};

export type ActionOptionsPieceClient = {
	fetchOptions(input: {
		pieceName: string;
		actionName: string;
		propertyName: string;
		auth: unknown;
		input: Record<string, unknown>;
		searchValue?: string;
	}): Promise<ActionOptionsHttpResult | ActionOptionsUnavailableResult>;
};

export class ApplicationActionOptionsService {
	constructor(
		private readonly deps: {
			actions: ActionOptionsActionCatalogReader;
			codeFunctions: ActionOptionsCodeFunctionPort;
			connections: ActionOptionsConnectionReader;
			pieces: ActionOptionsPieceClient;
		},
	) {}

	async getOptions(input: {
		actionId: string;
		userId: string;
		body: unknown;
		requestUrl: string;
		cookie: string;
	}): Promise<ActionOptionsHttpResult> {
		const body = isRecord(input.body) ? input.body : {};
		const field = parseField(body);
		if (!field) throw new ApplicationActionOptionsError(400, "param is required");

		const optionInput = isRecord(body.input) ? { ...body.input } : {};
		const searchValue = parseSearchValue(body);

		if (input.actionId.startsWith("code-function.")) {
			return this.getCodeFunctionOptions({
				actionId: input.actionId,
				userId: input.userId,
				field,
				optionInput,
				searchValue,
			});
		}

		return this.getActivePiecesOptions({
			actionId: input.actionId,
			userId: input.userId,
			field,
			body,
			optionInput,
			searchValue,
		});
	}

	private async getCodeFunctionOptions(input: {
		actionId: string;
		userId: string;
		field: string;
		optionInput: Record<string, unknown>;
		searchValue?: string;
	}): Promise<ActionOptionsHttpResult> {
		const codeFunctionId = input.actionId.slice("code-function.".length);
		const functionRef = await this.deps.codeFunctions.getCodeFunction(
			codeFunctionId,
			input.userId,
		);
		if (!functionRef) {
			throw new ApplicationActionOptionsError(404, "Code function not found");
		}

		return this.deps.codeFunctions.fetchOptions({
			userId: input.userId,
			functionRef,
			param: input.field,
			input: input.optionInput,
			searchValue: input.searchValue,
		});
	}

	private async getActivePiecesOptions(input: {
		actionId: string;
		userId: string;
		field: string;
		body: Record<string, unknown>;
		optionInput: Record<string, unknown>;
		searchValue?: string;
	}): Promise<ActionOptionsHttpResult> {
		const action = await this.deps.actions.getActionDetail(
			input.actionId,
			input.userId,
		);
		if (!action) {
			throw new ApplicationActionOptionsError(404, "Action not found");
		}
		if (action.serviceId !== "activepieces") {
			throw new ApplicationActionOptionsError(
				400,
				"Dynamic options are only implemented for Activepieces and code functions",
			);
		}

		const connectionExternalId = parseConnectionExternalId(
			input.body,
			input.optionInput,
		);
		if (action.auth?.required === true && !connectionExternalId) {
			return {
				status: 200,
				payload: {
					options: [],
					disabled: true,
					placeholder: "Select a connection first",
				},
			};
		}

		let auth: unknown = undefined;
		if (connectionExternalId) {
			const connection =
				await this.deps.connections.getDecryptedConnection(connectionExternalId);
			if (!connection) {
				throw new ApplicationActionOptionsError(404, "Connection not found");
			}
			if (
				action.providerId &&
				this.deps.connections.normalizePieceName(connection.pieceName) !==
					this.deps.connections.normalizePieceName(action.providerId)
			) {
				throw new ApplicationActionOptionsError(
					400,
					"Selected connection does not match this provider",
				);
			}
			auth = connection.value;
		}

		delete input.optionInput.auth;

		const raw = isRecord(action.raw) ? action.raw : {};
		const pieceName =
			stringValue(raw.pieceName) || action.providerId || action.group;
		const actionName =
			stringValue(raw.actionName) ||
			action.actionName ||
			action.entrypoint ||
			action.slug;

		const response = await this.deps.pieces.fetchOptions({
			pieceName,
			actionName,
			propertyName: input.field,
			auth,
			input: input.optionInput,
			searchValue: input.searchValue,
		});
		if ("unavailable" in response) {
			return warmingResponse(pieceName, response.message);
		}
		return response;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" && value.trim().length > 0 ? value : "";
}

function parseField(input: Record<string, unknown>): string {
	const param = stringValue(input.param).trim();
	if (param) return param;
	return stringValue(input.field).trim();
}

function parseSearchValue(input: Record<string, unknown>): string | undefined {
	const searchValue = stringValue(input.searchValue);
	if (searchValue) return searchValue;
	const legacySearchValue = stringValue(input.search_value);
	return legacySearchValue || undefined;
}

function parseConnectionExternalId(
	body: Record<string, unknown>,
	input: Record<string, unknown>,
): string | null {
	const explicit = stringValue(body.connectionExternalId).trim();
	if (explicit) return explicit;
	const authValue = input.auth;
	if (typeof authValue !== "string") return null;
	const match = authValue.match(/connections\['([^']+)'\]/);
	return match?.[1] || null;
}

function warmingResponse(piece: string, message: string): ActionOptionsHttpResult {
	return {
		status: 503,
		payload: {
			warming: true,
			options: [],
			error: `Piece service for "${piece}" is unavailable (possibly cold-starting): ${message}`,
		},
	};
}
