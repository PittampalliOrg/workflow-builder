import type {
	AgentSkillRegistryEntry,
	AgentSkillStatus,
} from "$lib/agent-skill-presets";

export type AgentSkillMetadataInput = {
	name?: string;
	description?: string;
	source?: string;
	sourceRepo?: string;
	installSource?: string;
	skillName?: string;
	slug?: string;
	registryUrl?: string;
	sourceRef?: string;
	version?: string;
	status?: AgentSkillStatus;
	installAgent?: string;
};

export type AgentSkillSearchResult = AgentSkillRegistryEntry & {
	installs?: string;
};

export type CustomAgentSkillCreateRecord = {
	name: string;
	slug?: string;
	description?: string | null;
	whenToUse?: string | null;
	prompt: string;
	allowedTools?: string[];
	argumentHint?: string | null;
	model?: string | null;
	projectId: string;
	userId: string;
};

export type CustomAgentSkillUpdateRecord = {
	name?: string;
	description?: string | null;
	whenToUse?: string | null;
	prompt?: string;
	allowedTools?: string[];
	argumentHint?: string | null;
	model?: string | null;
	status?: AgentSkillStatus;
};

export type AgentSkillZipImportRecord = {
	zipBuffer: ArrayBuffer | Buffer;
	skillName: string;
	slug?: string;
	projectId: string;
	userId: string;
	status?: AgentSkillStatus;
	description?: string | null;
};

export interface AgentSkillRepository {
	listAgentSkills(options?: {
		includeDisabled?: boolean;
		projectId?: string | null;
	}): Promise<AgentSkillRegistryEntry[]>;
	createCustomSkill(
		input: CustomAgentSkillCreateRecord,
	): Promise<AgentSkillRegistryEntry>;
	updateCustomSkill(
		id: string,
		input: CustomAgentSkillUpdateRecord,
		opts: { userId: string; projectId: string },
	): Promise<AgentSkillRegistryEntry>;
	deleteCustomSkill(id: string, opts: { projectId: string }): Promise<boolean>;
	upsertAgentSkillMetadata(
		input: AgentSkillMetadataInput,
		userId: string,
	): Promise<AgentSkillRegistryEntry>;
	upsertCustomSkillFromZip(
		input: AgentSkillZipImportRecord,
	): Promise<AgentSkillRegistryEntry>;
	setAgentSkillStatus(
		idOrSlug: string,
		status: AgentSkillStatus,
	): Promise<AgentSkillRegistryEntry>;
	searchSkills(query: string): Promise<AgentSkillSearchResult[]>;
	canManageAgentSkills(userId: string, projectId?: string): Promise<boolean>;
}

export class AgentSkillServiceError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "AgentSkillServiceError";
	}
}

export class ApplicationAgentSkillService {
	constructor(private readonly repository: AgentSkillRepository) {}

	async list(input: {
		includeDisabled?: boolean;
		userId: string;
		projectId?: string | null;
	}) {
		const [skills, canManage] = await Promise.all([
			this.repository.listAgentSkills({
				includeDisabled: input.includeDisabled,
				projectId: input.projectId,
			}),
			this.repository.canManageAgentSkills(
				input.userId,
				input.projectId ?? undefined,
			),
		]);
		return { skills, canManage };
	}

	async get(input: {
		id: string;
		projectId?: string | null;
	}): Promise<AgentSkillRegistryEntry | null> {
		const skills = await this.repository.listAgentSkills({
			includeDisabled: true,
			projectId: input.projectId,
		});
		return (
			skills.find(
				(skill) =>
					skill.id === input.id ||
					skill.registryId === input.id ||
					skill.slug === input.id,
			) ?? null
		);
	}

	async createCustom(input: {
		body: Record<string, unknown>;
		userId: string;
		projectId?: string | null;
	}) {
		const projectId = this.requireProject(input.projectId);
		const name = typeof input.body.name === "string" ? input.body.name : "";
		const prompt = typeof input.body.prompt === "string" ? input.body.prompt : "";
		if (!name.trim()) throw new AgentSkillServiceError(400, "name is required");
		if (!prompt.trim()) throw new AgentSkillServiceError(400, "prompt is required");

		return this.repository.createCustomSkill({
			name,
			slug: stringField(input.body.slug),
			description: nullableString(input.body.description),
			whenToUse: nullableString(input.body.whenToUse),
			prompt,
			allowedTools: stringArray(input.body.allowedTools),
			argumentHint: nullableString(input.body.argumentHint),
			model: nullableString(input.body.model),
			projectId,
			userId: input.userId,
		});
	}

	async updateCustom(input: {
		id: string;
		body: Record<string, unknown>;
		userId: string;
		projectId?: string | null;
	}) {
		const projectId = this.requireProject(input.projectId);
		return this.repository.updateCustomSkill(
			input.id,
			{
				name: stringField(input.body.name),
				description: optionalNullableString(input.body.description),
				whenToUse: optionalNullableString(input.body.whenToUse),
				prompt: stringField(input.body.prompt),
				allowedTools: Array.isArray(input.body.allowedTools)
					? stringArray(input.body.allowedTools)
					: undefined,
				argumentHint: optionalNullableString(input.body.argumentHint),
				model: optionalNullableString(input.body.model),
				status: skillStatus(input.body.status),
			},
			{ userId: input.userId, projectId },
		);
	}

	async deleteCustom(input: { id: string; projectId?: string | null }) {
		return this.repository.deleteCustomSkill(input.id, {
			projectId: this.requireProject(input.projectId),
		});
	}

	async importRegistrySkill(input: {
		body: Record<string, unknown>;
		userId: string;
		projectId?: string | null;
	}) {
		await this.requireCanManage(input.userId, input.projectId);
		return this.repository.upsertAgentSkillMetadata(
			input.body as AgentSkillMetadataInput,
			input.userId,
		);
	}

	async importZip(input: {
		zipBuffer: ArrayBuffer | Buffer;
		skillName: string;
		slug?: string;
		status?: AgentSkillStatus;
		description?: string | null;
		userId: string;
		projectId?: string | null;
	}) {
		const projectId = this.requireProject(input.projectId);
		await this.requireCanManage(input.userId, projectId);
		return this.repository.upsertCustomSkillFromZip({
			zipBuffer: input.zipBuffer,
			skillName: input.skillName,
			slug: input.slug,
			projectId,
			userId: input.userId,
			status: input.status,
			description: input.description,
		});
	}

	async setStatus(input: {
		id: string;
		status: AgentSkillStatus;
		userId: string;
		projectId?: string | null;
	}) {
		await this.requireCanManage(input.userId, input.projectId);
		return this.repository.setAgentSkillStatus(input.id, input.status);
	}

	async search(input: { query: string }) {
		const query = input.query.trim();
		if (!query) return Promise.resolve([]);
		return this.repository.searchSkills(query);
	}

	private requireProject(projectId: string | null | undefined): string {
		if (!projectId) {
			throw new AgentSkillServiceError(400, "No active workspace");
		}
		return projectId;
	}

	private async requireCanManage(userId: string, projectId?: string | null) {
		const canManage = await this.repository.canManageAgentSkills(
			userId,
			projectId ?? undefined,
		);
		if (!canManage) throw new AgentSkillServiceError(403, "Forbidden");
	}
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function optionalNullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function skillStatus(value: unknown): AgentSkillStatus | undefined {
	return value === "ENABLED" || value === "DISABLED" || value === "DRAFT"
		? value
		: undefined;
}
