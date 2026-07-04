import {
	createDefaultEnvironmentConfig,
	type EnvironmentConfig,
} from "$lib/types/environments";

export class ApplicationEnvironmentError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationEnvironmentError";
	}
}

export type EnvironmentListFilter = {
	q?: string;
	tag?: string;
	includeArchived?: boolean;
	projectId?: string;
};

export type EnvironmentCreateCommand = {
	slug?: string;
	name: string;
	description: string | null;
	avatar: string | null;
	tags?: string[];
	createdBy: string;
	projectId: string | null;
	baseEnvSlug?: string | null;
	config: EnvironmentConfig;
};

export type EnvironmentUpdateCommand = {
	name?: string;
	description?: string | null;
	avatar?: string | null;
	tags?: string[];
	config?: EnvironmentConfig;
	baseEnvSlug?: string | null;
	changelog?: string;
	publishedBy: string;
};

export type EnvironmentRepository = {
	list(filter: EnvironmentListFilter): Promise<unknown[]>;
	get(id: string): Promise<unknown | null>;
	create(input: EnvironmentCreateCommand): Promise<unknown>;
	update(id: string, input: EnvironmentUpdateCommand): Promise<unknown | null>;
	archive(id: string): Promise<boolean>;
	duplicate(
		id: string,
		input: { name?: string; createdBy: string; projectId: string | null },
	): Promise<unknown | null>;
	listVersions(id: string): Promise<unknown[]>;
	getVersion(id: string, version: number): Promise<unknown | null>;
	restoreVersion(
		id: string,
		version: number,
		userId: string,
	): Promise<unknown | null>;
	findUsages(id: string): Promise<unknown[]>;
	previewDockerfile(id: string): Promise<string | null>;
};

export type EnvironmentBackfillReport = {
	defaultEnvironmentCreated: boolean;
	defaultEnvironmentId: string;
	agentsLinked: number;
	totalAgents: number;
};

export type BuiltinSandboxImageRepairReport = {
	environmentName: string;
	scanned: number;
	updated: number;
	cleared: number;
};

export type EnvironmentMaintenanceRepository = {
	backfillDefaultEnvironment(): Promise<EnvironmentBackfillReport>;
	repairBuiltinSandboxEnvironmentImages(): Promise<BuiltinSandboxImageRepairReport>;
};

export class ApplicationEnvironmentService {
	constructor(
		private readonly repository: EnvironmentRepository,
		private readonly maintenanceRepository?: EnvironmentMaintenanceRepository,
	) {}

	async list(input: {
		query: URLSearchParams;
		sessionProjectId?: string | null;
	}): Promise<{ environments: unknown[] }> {
		const projectIdParam = input.query.get("projectId");
		const projectId =
			projectIdParam === "null"
				? undefined
				: projectIdParam
					? projectIdParam
					: (input.sessionProjectId ?? undefined);
		return {
			environments: await this.runRepositoryCall(() =>
				this.repository.list({
					q: input.query.get("q") ?? undefined,
					tag: input.query.get("tag") ?? undefined,
					includeArchived: input.query.get("includeArchived") === "true",
					projectId,
				}),
			),
		};
	}

	async create(input: {
		userId: string;
		sessionProjectId?: string | null;
		body: unknown;
	}): Promise<{ environment: unknown }> {
		const body = asRecord(input.body);
		const baseConfig = createDefaultEnvironmentConfig();
		const config = mergeConfig(baseConfig, body.config);
		return {
			environment: await this.runRepositoryCall(() =>
				this.repository.create({
					slug: typeof body.slug === "string" ? body.slug : undefined,
					name:
						typeof body.name === "string" && body.name.trim()
							? body.name.trim()
							: "Untitled Environment",
					description:
						typeof body.description === "string" ? body.description : null,
					avatar: typeof body.avatar === "string" ? body.avatar : null,
					tags: Array.isArray(body.tags)
						? body.tags.map((tag) => String(tag))
						: undefined,
					createdBy: input.userId,
					projectId:
						typeof body.projectId === "string"
							? body.projectId
							: (input.sessionProjectId ?? null),
					baseEnvSlug:
						typeof body.baseEnvSlug === "string" || body.baseEnvSlug === null
							? (body.baseEnvSlug as string | null)
							: undefined,
					config,
				}),
			),
		};
	}

	async get(input: { id: string }): Promise<{ environment: unknown }> {
		const environment = await this.runRepositoryCall(() =>
			this.repository.get(input.id),
		);
		if (!environment) throw new ApplicationEnvironmentError(404, "Environment not found");
		return { environment };
	}

	async update(input: {
		id: string;
		userId: string;
		body: unknown;
	}): Promise<{ environment: unknown }> {
		const body = asRecord(input.body);
		const environment = await this.runRepositoryCall(() =>
			this.repository.update(input.id, {
				name: typeof body.name === "string" ? body.name : undefined,
				description:
					typeof body.description === "string" || body.description === null
						? (body.description as string | null)
						: undefined,
				avatar:
					typeof body.avatar === "string" || body.avatar === null
						? (body.avatar as string | null)
						: undefined,
				tags: Array.isArray(body.tags)
					? body.tags.map((tag) => String(tag))
					: undefined,
				config: isRecord(body.config)
					? (body.config as EnvironmentConfig)
					: undefined,
				baseEnvSlug:
					typeof body.baseEnvSlug === "string" || body.baseEnvSlug === null
						? (body.baseEnvSlug as string | null)
						: undefined,
				changelog:
					typeof body.changelog === "string" ? body.changelog : undefined,
				publishedBy: input.userId,
			}),
		);
		if (!environment) throw new ApplicationEnvironmentError(404, "Environment not found");
		return { environment };
	}

	async archive(input: { id: string }): Promise<{ archived: true }> {
		const archived = await this.runRepositoryCall(() =>
			this.repository.archive(input.id),
		);
		if (!archived) throw new ApplicationEnvironmentError(404, "Environment not found");
		return { archived: true };
	}

	async duplicate(input: {
		id: string;
		userId: string;
		sessionProjectId?: string | null;
		body: unknown;
	}): Promise<{ environment: unknown }> {
		const body = asRecord(input.body);
		const environment = await this.runRepositoryCall(() =>
			this.repository.duplicate(input.id, {
				name: typeof body.name === "string" ? body.name : undefined,
				createdBy: input.userId,
				projectId: input.sessionProjectId ?? null,
			}),
		);
		if (!environment) throw new ApplicationEnvironmentError(404, "Environment not found");
		return { environment };
	}

	async listVersions(input: { id: string }): Promise<{ versions: unknown[] }> {
		return {
			versions: await this.runRepositoryCall(() =>
				this.repository.listVersions(input.id),
			),
		};
	}

	async getVersion(input: {
		id: string;
		versionParam: string;
	}): Promise<unknown> {
		const version = parseVersion(input.versionParam);
		const result = await this.runRepositoryCall(() =>
			this.repository.getVersion(input.id, version),
		);
		if (!result) throw new ApplicationEnvironmentError(404, "Version not found");
		return result;
	}

	async restoreVersion(input: {
		id: string;
		versionParam: string;
		userId: string;
	}): Promise<{ environment: unknown }> {
		const version = parseVersion(input.versionParam);
		const environment = await this.runRepositoryCall(() =>
			this.repository.restoreVersion(input.id, version, input.userId),
		);
		if (!environment) throw new ApplicationEnvironmentError(404, "Version not found");
		return { environment };
	}

	async usages(input: { id: string }): Promise<{
		usages: unknown[];
		totalAgents: number;
	}> {
		const usages = await this.runRepositoryCall(() =>
			this.repository.findUsages(input.id),
		);
		return { usages, totalAgents: usages.length };
	}

	async dockerfilePreview(input: { id: string }): Promise<{ dockerfile: string }> {
		const dockerfile = await this.runRepositoryCall(() =>
			this.repository.previewDockerfile(input.id),
		);
		if (!dockerfile) throw new ApplicationEnvironmentError(404, "Environment not found");
		return { dockerfile };
	}

	async backfillDefault(): Promise<{ report: EnvironmentBackfillReport }> {
		if (!this.maintenanceRepository) {
			throw new ApplicationEnvironmentError(500, "Environment maintenance is not configured");
		}
		return {
			report: await this.runRepositoryCall(() =>
				this.maintenanceRepository!.backfillDefaultEnvironment(),
			),
		};
	}

	async repairBuiltinSandboxImages(): Promise<{ report: BuiltinSandboxImageRepairReport }> {
		if (!this.maintenanceRepository) {
			throw new ApplicationEnvironmentError(500, "Environment maintenance is not configured");
		}
		return {
			report: await this.runRepositoryCall(() =>
				this.maintenanceRepository!.repairBuiltinSandboxEnvironmentImages(),
			),
		};
	}

	private async runRepositoryCall<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (err) {
			throw toApplicationError(err);
		}
	}
}

function mergeConfig(base: EnvironmentConfig, patch: unknown): EnvironmentConfig {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
	return { ...base, ...(patch as Partial<EnvironmentConfig>) };
}

function parseVersion(value: string): number {
	const version = Number.parseInt(value, 10);
	if (!Number.isFinite(version) || version <= 0) {
		throw new ApplicationEnvironmentError(400, "Invalid version");
	}
	return version;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toApplicationError(err: unknown): ApplicationEnvironmentError {
	if (err instanceof ApplicationEnvironmentError) return err;
	const maybe = err as { status?: unknown; body?: unknown; message?: unknown };
	const status = typeof maybe.status === "number" ? maybe.status : 500;
	const message =
		isRecord(maybe.body) && typeof maybe.body.message === "string"
			? maybe.body.message
			: typeof maybe.message === "string"
				? maybe.message
				: String(err);
	return new ApplicationEnvironmentError(status, message);
}
