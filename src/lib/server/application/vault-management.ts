export class ApplicationVaultError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationVaultError";
	}
}

export type VaultListFilter = {
	projectId?: string | null;
	q?: string;
	includeArchived?: boolean;
};

export type VaultRepository = {
	list(filter: VaultListFilter): Promise<unknown[]>;
	get(id: string): Promise<unknown | null>;
	create(input: {
		name: string;
		description: string | null;
		projectId: string | null;
		createdBy: string;
	}): Promise<unknown>;
	update(
		id: string,
		input: { name?: string; description?: string | null },
	): Promise<unknown | null>;
	archive(id: string): Promise<boolean>;
};

export class ApplicationVaultService {
	constructor(private readonly repository: VaultRepository) {}

	async list(input: {
		query: URLSearchParams;
		sessionProjectId?: string | null;
	}): Promise<{ vaults: unknown[] }> {
		const projectIdParam = input.query.get("projectId");
		const projectId =
			projectIdParam === "null"
				? null
				: projectIdParam
					? projectIdParam
					: input.sessionProjectId;
		return {
			vaults: await this.runRepositoryCall(() =>
				this.repository.list({
					q: input.query.get("q") ?? undefined,
					includeArchived: input.query.get("includeArchived") === "true",
					projectId,
				}),
			),
		};
	}

	async create(input: {
		userId: string;
		body: unknown;
	}): Promise<{ vault: unknown }> {
		const body = asRecord(input.body);
		const name =
			typeof body.name === "string" && body.name.trim()
				? body.name.trim()
				: "";
		if (!name) throw new ApplicationVaultError(400, "name is required");
		return {
			vault: await this.runRepositoryCall(() =>
				this.repository.create({
					name,
					description:
						typeof body.description === "string" ? body.description : null,
					projectId: typeof body.projectId === "string" ? body.projectId : null,
					createdBy: input.userId,
				}),
			),
		};
	}

	async get(input: { id: string }): Promise<{ vault: unknown }> {
		const vault = await this.runRepositoryCall(() =>
			this.repository.get(input.id),
		);
		if (!vault) throw new ApplicationVaultError(404, "Vault not found");
		return { vault };
	}

	async update(input: {
		id: string;
		body: unknown;
	}): Promise<{ vault: unknown }> {
		const body = asRecord(input.body);
		const vault = await this.runRepositoryCall(() =>
			this.repository.update(input.id, {
				name: typeof body.name === "string" ? body.name : undefined,
				description:
					typeof body.description === "string" || body.description === null
						? (body.description as string | null)
						: undefined,
			}),
		);
		if (!vault) throw new ApplicationVaultError(404, "Vault not found");
		return { vault };
	}

	async archive(input: { id: string }): Promise<{ archived: true }> {
		const archived = await this.runRepositoryCall(() =>
			this.repository.archive(input.id),
		);
		if (!archived) throw new ApplicationVaultError(404, "Vault not found");
		return { archived: true };
	}

	private async runRepositoryCall<T>(operation: () => Promise<T>): Promise<T> {
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

function toApplicationError(err: unknown): ApplicationVaultError {
	if (err instanceof ApplicationVaultError) return err;
	const maybe = err as { status?: unknown; body?: unknown; message?: unknown };
	const status = typeof maybe.status === "number" ? maybe.status : 500;
	const message =
		isRecord(maybe.body) && typeof maybe.body.message === "string"
			? maybe.body.message
			: typeof maybe.message === "string"
				? maybe.message
				: String(err);
	return new ApplicationVaultError(status, message);
}
