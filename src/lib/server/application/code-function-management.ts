export class ApplicationCodeFunctionManagementError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationCodeFunctionManagementError";
	}
}

export type CodeFunctionLanguage = "typescript" | "python";

export type SaveCodeFunctionCommand = {
	name: string;
	description: string | null;
	language: CodeFunctionLanguage;
	entrypoint: string | null;
	path: string | null;
	source: string;
	supportingFiles: Record<string, string> | null;
};

export type CodeFunctionRevisionSummary = {
	id: string;
	version: string;
	publishedAt: string;
};

export type CodeFunctionSummary = {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	version: string;
	language: CodeFunctionLanguage;
	entrypoint: string;
	path: string | null;
	updatedAt: string;
	createdAt: string;
	isEnabled: boolean;
	hasDiagnostics: boolean;
	latestPublishedVersion: string | null;
	lastPublishedAt: string | null;
	role?: string;
	compositionGraph?: unknown;
};

export type CodeFunctionDetail = CodeFunctionSummary & {
	source: string;
	supportingFiles: Record<string, string>;
	sourceHash: string;
	model: unknown;
	revisions: CodeFunctionRevisionSummary[];
};

export type CodeFunctionManagementRepository = {
	list(userId: string): Promise<CodeFunctionSummary[]>;
	get(id: string, userId: string): Promise<CodeFunctionDetail | null>;
	create(
		input: SaveCodeFunctionCommand,
		userId: string,
	): Promise<CodeFunctionDetail>;
	update(
		id: string,
		input: SaveCodeFunctionCommand,
		userId: string,
	): Promise<CodeFunctionDetail | null>;
	delete(id: string, userId: string): Promise<boolean>;
	publish(id: string, userId: string): Promise<CodeFunctionDetail | null>;
};

export class ApplicationCodeFunctionManagementService {
	constructor(private readonly repository: CodeFunctionManagementRepository) {}

	async list(input: { userId: string }): Promise<CodeFunctionSummary[]> {
		return this.runRepositoryCall(() => this.repository.list(input.userId));
	}

	async get(input: { id: string; userId: string }): Promise<CodeFunctionDetail> {
		const item = await this.runRepositoryCall(() =>
			this.repository.get(input.id, input.userId),
		);
		if (!item) {
			throw new ApplicationCodeFunctionManagementError(
				404,
				"Code function not found",
			);
		}
		return item;
	}

	async create(input: {
		userId: string;
		body: unknown;
	}): Promise<CodeFunctionDetail> {
		const command = parseSaveCommand(input.body);
		return this.runRepositoryCall(() =>
			this.repository.create(command, input.userId),
		);
	}

	async update(input: {
		id: string;
		userId: string;
		body: unknown;
	}): Promise<CodeFunctionDetail> {
		const command = parseSaveCommand(input.body);
		const item = await this.runRepositoryCall(() =>
			this.repository.update(input.id, command, input.userId),
		);
		if (!item) {
			throw new ApplicationCodeFunctionManagementError(
				404,
				"Code function not found",
			);
		}
		return item;
	}

	async delete(input: { id: string; userId: string }): Promise<{ success: true }> {
		const deleted = await this.runRepositoryCall(() =>
			this.repository.delete(input.id, input.userId),
		);
		if (!deleted) {
			throw new ApplicationCodeFunctionManagementError(
				404,
				"Code function not found",
			);
		}
		return { success: true };
	}

	async publish(input: {
		id: string;
		userId: string;
	}): Promise<CodeFunctionDetail> {
		const item = await this.runRepositoryCall(() =>
			this.repository.publish(input.id, input.userId),
		);
		if (!item) {
			throw new ApplicationCodeFunctionManagementError(
				404,
				"Code function not found",
			);
		}
		return item;
	}

	private async runRepositoryCall<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (err) {
			if (err instanceof ApplicationCodeFunctionManagementError) {
				throw err;
			}
			const message = err instanceof Error ? err.message : String(err);
			if (message === "Database not configured") {
				throw new ApplicationCodeFunctionManagementError(503, message);
			}
			if (message === "Unauthorized") {
				throw new ApplicationCodeFunctionManagementError(401, message);
			}
			throw new ApplicationCodeFunctionManagementError(502, message);
		}
	}
}

function parseSaveCommand(body: unknown): SaveCodeFunctionCommand {
	const data = isRecord(body) ? body : null;
	if (
		!data ||
		!isLanguage(data.language) ||
		typeof data.source !== "string" ||
		typeof data.name !== "string"
	) {
		throw new ApplicationCodeFunctionManagementError(
			400,
			"name, language, and source are required",
		);
	}

	if (data.name.trim().length === 0 || data.source.trim().length === 0) {
		throw new ApplicationCodeFunctionManagementError(
			400,
			"name and source must not be empty",
		);
	}

	return {
		name: data.name,
		description: typeof data.description === "string" ? data.description : null,
		language: data.language,
		entrypoint: typeof data.entrypoint === "string" ? data.entrypoint : null,
		path: typeof data.path === "string" ? data.path : null,
		source: data.source,
		supportingFiles: isRecord(data.supportingFiles)
			? stringRecord(data.supportingFiles)
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
