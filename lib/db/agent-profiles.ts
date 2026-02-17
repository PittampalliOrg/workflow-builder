import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { generateId } from "@/lib/utils/id";
import { db } from "./index";
import {
	agentCapabilityFacetVersions,
	agentExecutionFacetVersions,
	agentInstructionFacetVersions,
	agentInteractionFacetVersions,
	agentMemoryFacetVersions,
	agentModelFacetVersions,
	agentOutputFacetVersions,
	agentProfileAppliedHistory,
	agentProfileTemplateExamples,
	agentProfileTemplateVersions,
	agentProfileTemplates,
	agentToolPolicyFacetVersions,
	agents,
	type AgentModelSpec,
	type AgentToolRef,
	type ProfileCompatibilityWarning,
} from "./schema";

type AgentProfileModelConfig = Partial<AgentModelSpec> & {
	modelId?: string;
	modelSpec?: string;
	defaultOptions?: Record<string, unknown>;
};

type AgentProfileToolConfig = {
	tools?: Array<string | AgentToolRef>;
};

type AgentProfileExecutionConfig = {
	maxTurns?: number;
	timeoutMinutes?: number;
};

type AgentProfileInstructionConfig = {
	instructions?: string;
	systemPrompt?: string;
};

type AgentProfileMemoryConfig = {
	memoryConfig?: Record<string, unknown>;
};

type AgentProfileCapabilityConfig = {
	agentType?: string;
};

type AgentProfileInteractionConfig = {
	defaultOptions?: Record<string, unknown>;
};

type AgentProfileOutputConfig = {
	structuredOutput?: Record<string, unknown>;
	defaultOptions?: Record<string, unknown>;
};

export type AgentProfileSnapshot = {
	agentType: string;
	instructions: string;
	model: AgentModelSpec;
	tools: AgentToolRef[];
	maxTurns: number;
	timeoutMinutes: number;
	defaultOptions: Record<string, unknown> | null;
	memoryConfig: Record<string, unknown> | null;
};

export type ResolvedAgentProfile = {
	template: typeof agentProfileTemplates.$inferSelect;
	templateVersion: typeof agentProfileTemplateVersions.$inferSelect;
	snapshot: AgentProfileSnapshot;
	warnings: ProfileCompatibilityWarning[];
	examples: Array<typeof agentProfileTemplateExamples.$inferSelect>;
};

export type AgentProfileListItem = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	category: string | null;
	isEnabled: boolean;
	sortOrder: number;
	sourceRepoUrl: string | null;
	sourcePath: string | null;
	defaultVersion: number;
	snapshotPreview: {
		agentType: string;
		modelId: string;
		toolCount: number;
		maxTurns: number;
		timeoutMinutes: number;
	};
	warnings: ProfileCompatibilityWarning[];
};

function parseModelFromId(modelId: string): AgentModelSpec {
	const idx = modelId.indexOf("/");
	if (idx === -1) {
		return { provider: "openai", name: modelId };
	}
	return {
		provider: modelId.slice(0, idx),
		name: modelId.slice(idx + 1),
	};
}

function coerceWarnings(input: unknown): ProfileCompatibilityWarning[] {
	if (!Array.isArray(input)) return [];
	const warnings: ProfileCompatibilityWarning[] = [];
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		const obj = item as Record<string, unknown>;
		if (
			typeof obj.code !== "string" ||
			typeof obj.severity !== "string" ||
			typeof obj.message !== "string"
		) {
			continue;
		}
		warnings.push({
			code: obj.code,
			severity:
				obj.severity === "info" ||
				obj.severity === "warning" ||
				obj.severity === "error"
					? obj.severity
					: "warning",
			message: obj.message,
			field: typeof obj.field === "string" ? obj.field : undefined,
			suggestedAction:
				typeof obj.suggestedAction === "string"
					? obj.suggestedAction
					: undefined,
		});
	}
	return warnings;
}

function coerceObject(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return {};
	}
	return input as Record<string, unknown>;
}

function normalizeTools(input: unknown): AgentToolRef[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((item) => {
			if (typeof item === "string") {
				return { type: "workspace" as const, ref: item };
			}
			if (!item || typeof item !== "object") return null;
			const obj = item as Record<string, unknown>;
			if (typeof obj.ref !== "string") return null;
			const type =
				obj.type === "workspace" || obj.type === "mcp" || obj.type === "action"
					? obj.type
					: "workspace";
			return { type, ref: obj.ref };
		})
		.filter((item): item is AgentToolRef => item !== null);
}

async function resolveTemplateVersion(templateId: string, version?: number) {
	if (version !== undefined) {
		return db.query.agentProfileTemplateVersions.findFirst({
			where: and(
				eq(agentProfileTemplateVersions.templateId, templateId),
				eq(agentProfileTemplateVersions.version, version),
			),
		});
	}

	const defaultRow = await db.query.agentProfileTemplateVersions.findFirst({
		where: and(
			eq(agentProfileTemplateVersions.templateId, templateId),
			eq(agentProfileTemplateVersions.isDefault, true),
		),
		orderBy: [desc(agentProfileTemplateVersions.version)],
	});
	if (defaultRow) return defaultRow;

	return db.query.agentProfileTemplateVersions.findFirst({
		where: eq(agentProfileTemplateVersions.templateId, templateId),
		orderBy: [desc(agentProfileTemplateVersions.version)],
	});
}

async function resolveFacetConfigs(
	templateVersion: typeof agentProfileTemplateVersions.$inferSelect,
) {
	const [
		instructionFacetVersion,
		modelFacetVersion,
		toolPolicyFacetVersion,
		memoryFacetVersion,
		executionFacetVersion,
		interactionFacetVersion,
		outputFacetVersion,
		capabilityFacetVersion,
	] = await Promise.all([
		templateVersion.instructionFacetVersionId
			? db.query.agentInstructionFacetVersions.findFirst({
					where: eq(
						agentInstructionFacetVersions.id,
						templateVersion.instructionFacetVersionId,
					),
				})
			: Promise.resolve(null),
		templateVersion.modelFacetVersionId
			? db.query.agentModelFacetVersions.findFirst({
					where: eq(
						agentModelFacetVersions.id,
						templateVersion.modelFacetVersionId,
					),
				})
			: Promise.resolve(null),
		templateVersion.toolPolicyFacetVersionId
			? db.query.agentToolPolicyFacetVersions.findFirst({
					where: eq(
						agentToolPolicyFacetVersions.id,
						templateVersion.toolPolicyFacetVersionId,
					),
				})
			: Promise.resolve(null),
		templateVersion.memoryFacetVersionId
			? db.query.agentMemoryFacetVersions.findFirst({
					where: eq(
						agentMemoryFacetVersions.id,
						templateVersion.memoryFacetVersionId,
					),
				})
			: Promise.resolve(null),
		templateVersion.executionFacetVersionId
			? db.query.agentExecutionFacetVersions.findFirst({
					where: eq(
						agentExecutionFacetVersions.id,
						templateVersion.executionFacetVersionId,
					),
				})
			: Promise.resolve(null),
		templateVersion.interactionFacetVersionId
			? db.query.agentInteractionFacetVersions.findFirst({
					where: eq(
						agentInteractionFacetVersions.id,
						templateVersion.interactionFacetVersionId,
					),
				})
			: Promise.resolve(null),
		templateVersion.outputFacetVersionId
			? db.query.agentOutputFacetVersions.findFirst({
					where: eq(
						agentOutputFacetVersions.id,
						templateVersion.outputFacetVersionId,
					),
				})
			: Promise.resolve(null),
		templateVersion.capabilityFacetVersionId
			? db.query.agentCapabilityFacetVersions.findFirst({
					where: eq(
						agentCapabilityFacetVersions.id,
						templateVersion.capabilityFacetVersionId,
					),
				})
			: Promise.resolve(null),
	]);

	return {
		instructionFacetVersion,
		modelFacetVersion,
		toolPolicyFacetVersion,
		memoryFacetVersion,
		executionFacetVersion,
		interactionFacetVersion,
		outputFacetVersion,
		capabilityFacetVersion,
	};
}

function buildSnapshot(params: {
	template: typeof agentProfileTemplates.$inferSelect;
	templateVersion: typeof agentProfileTemplateVersions.$inferSelect;
	facets: Awaited<ReturnType<typeof resolveFacetConfigs>>;
}): {
	snapshot: AgentProfileSnapshot;
	warnings: ProfileCompatibilityWarning[];
} {
	const { template, templateVersion, facets } = params;
	const instructionCfg = coerceObject(
		facets.instructionFacetVersion?.config,
	) as AgentProfileInstructionConfig;
	const modelCfg = coerceObject(
		facets.modelFacetVersion?.config,
	) as AgentProfileModelConfig;
	const toolCfg = coerceObject(
		facets.toolPolicyFacetVersion?.config,
	) as AgentProfileToolConfig;
	const memoryCfg = coerceObject(
		facets.memoryFacetVersion?.config,
	) as AgentProfileMemoryConfig;
	const executionCfg = coerceObject(
		facets.executionFacetVersion?.config,
	) as AgentProfileExecutionConfig;
	const interactionCfg = coerceObject(
		facets.interactionFacetVersion?.config,
	) as AgentProfileInteractionConfig;
	const outputCfg = coerceObject(
		facets.outputFacetVersion?.config,
	) as AgentProfileOutputConfig;
	const capabilityCfg = coerceObject(
		facets.capabilityFacetVersion?.config,
	) as AgentProfileCapabilityConfig;

	const instructions =
		typeof instructionCfg.instructions === "string"
			? instructionCfg.instructions
			: typeof instructionCfg.systemPrompt === "string"
				? instructionCfg.systemPrompt
				: template.description || "You are a helpful assistant.";

	let model: AgentModelSpec = { provider: "openai", name: "gpt-4o" };
	if (typeof modelCfg.modelSpec === "string") {
		model = parseModelFromId(modelCfg.modelSpec);
	} else if (typeof modelCfg.modelId === "string") {
		model = parseModelFromId(modelCfg.modelId);
	} else if (
		typeof modelCfg.provider === "string" &&
		typeof modelCfg.name === "string"
	) {
		model = { provider: modelCfg.provider, name: modelCfg.name };
	}

	const tools = normalizeTools(toolCfg.tools);
	const maxTurns =
		typeof executionCfg.maxTurns === "number" ? executionCfg.maxTurns : 50;
	const timeoutMinutes =
		typeof executionCfg.timeoutMinutes === "number"
			? executionCfg.timeoutMinutes
			: 30;

	const mergedDefaultOptions: Record<string, unknown> = {
		...coerceObject(modelCfg.defaultOptions),
		...coerceObject(interactionCfg.defaultOptions),
		...coerceObject(outputCfg.defaultOptions),
	};
	if (
		outputCfg.structuredOutput &&
		typeof outputCfg.structuredOutput === "object"
	) {
		mergedDefaultOptions.structuredOutput = outputCfg.structuredOutput;
	}

	const snapshot: AgentProfileSnapshot = {
		agentType:
			typeof capabilityCfg.agentType === "string"
				? capabilityCfg.agentType
				: "general",
		instructions,
		model,
		tools,
		maxTurns,
		timeoutMinutes,
		defaultOptions:
			Object.keys(mergedDefaultOptions).length > 0
				? mergedDefaultOptions
				: null,
		memoryConfig:
			memoryCfg.memoryConfig && typeof memoryCfg.memoryConfig === "object"
				? memoryCfg.memoryConfig
				: null,
	};

	const warnings = [
		...coerceWarnings(templateVersion.compatibility),
		...coerceWarnings(facets.instructionFacetVersion?.compatibility),
		...coerceWarnings(facets.modelFacetVersion?.compatibility),
		...coerceWarnings(facets.toolPolicyFacetVersion?.compatibility),
		...coerceWarnings(facets.memoryFacetVersion?.compatibility),
		...coerceWarnings(facets.executionFacetVersion?.compatibility),
		...coerceWarnings(facets.interactionFacetVersion?.compatibility),
		...coerceWarnings(facets.outputFacetVersion?.compatibility),
		...coerceWarnings(facets.capabilityFacetVersion?.compatibility),
	];

	return { snapshot, warnings };
}

export async function listAgentProfileTemplates(params?: {
	includeDisabled?: boolean;
}): Promise<AgentProfileListItem[]> {
	const includeDisabled = params?.includeDisabled ?? false;
	const templates = await db
		.select()
		.from(agentProfileTemplates)
		.where(
			includeDisabled ? undefined : eq(agentProfileTemplates.isEnabled, true),
		)
		.orderBy(agentProfileTemplates.sortOrder, agentProfileTemplates.name);

	if (templates.length === 0) return [];

	const templateIds = templates.map((t) => t.id);
	const versions = await db
		.select()
		.from(agentProfileTemplateVersions)
		.where(inArray(agentProfileTemplateVersions.templateId, templateIds))
		.orderBy(
			agentProfileTemplateVersions.templateId,
			desc(agentProfileTemplateVersions.isDefault),
			desc(agentProfileTemplateVersions.version),
		);

	const preferredVersionByTemplate = new Map<
		string,
		typeof agentProfileTemplateVersions.$inferSelect
	>();
	for (const version of versions) {
		if (!preferredVersionByTemplate.has(version.templateId)) {
			preferredVersionByTemplate.set(version.templateId, version);
		}
	}

	const items: AgentProfileListItem[] = [];
	for (const template of templates) {
		const templateVersion = preferredVersionByTemplate.get(template.id);
		if (!templateVersion) continue;
		const facets = await resolveFacetConfigs(templateVersion);
		const { snapshot, warnings } = buildSnapshot({
			template,
			templateVersion,
			facets,
		});

		items.push({
			id: template.id,
			slug: template.slug,
			name: template.name,
			description: template.description,
			category: template.category,
			isEnabled: template.isEnabled,
			sortOrder: template.sortOrder,
			sourceRepoUrl: template.sourceRepoUrl,
			sourcePath: template.sourcePath,
			defaultVersion: templateVersion.version,
			snapshotPreview: {
				agentType: snapshot.agentType,
				modelId: `${snapshot.model.provider}/${snapshot.model.name}`,
				toolCount: snapshot.tools.length,
				maxTurns: snapshot.maxTurns,
				timeoutMinutes: snapshot.timeoutMinutes,
			},
			warnings,
		});
	}

	return items;
}

export async function getResolvedAgentProfileTemplate(params: {
	templateId: string;
	version?: number;
	includeDisabled?: boolean;
}): Promise<ResolvedAgentProfile | null> {
	const includeDisabled = params.includeDisabled ?? false;
	const whereCondition = includeDisabled
		? eq(agentProfileTemplates.id, params.templateId)
		: and(
				eq(agentProfileTemplates.id, params.templateId),
				eq(agentProfileTemplates.isEnabled, true),
			);
	const template = await db.query.agentProfileTemplates.findFirst({
		where: whereCondition,
	});
	if (!template) return null;

	const templateVersion = await resolveTemplateVersion(
		template.id,
		params.version,
	);
	if (!templateVersion) return null;

	const [facets, examples] = await Promise.all([
		resolveFacetConfigs(templateVersion),
		db
			.select()
			.from(agentProfileTemplateExamples)
			.where(eq(agentProfileTemplateExamples.templateId, template.id))
			.orderBy(desc(agentProfileTemplateExamples.updatedAt)),
	]);

	const { snapshot, warnings } = buildSnapshot({
		template,
		templateVersion,
		facets,
	});

	return {
		template,
		templateVersion,
		snapshot,
		warnings,
		examples,
	};
}

export async function applyAgentProfileToAgent(params: {
	agentId: string;
	userId: string;
	templateId: string;
	version?: number;
}): Promise<ResolvedAgentProfile | null> {
	const target = await db.query.agents.findFirst({
		where: and(eq(agents.id, params.agentId), eq(agents.userId, params.userId)),
	});
	if (!target) {
		throw new Error("Agent not found");
	}

	const resolved = await getResolvedAgentProfileTemplate({
		templateId: params.templateId,
		version: params.version,
		includeDisabled: false,
	});
	if (!resolved) return null;

	const now = new Date();
	const [updated] = await db
		.update(agents)
		.set({
			agentType: resolved.snapshot.agentType as
				| "general"
				| "code-assistant"
				| "research"
				| "planning"
				| "custom",
			instructions: resolved.snapshot.instructions,
			model: resolved.snapshot.model,
			tools: resolved.snapshot.tools,
			maxTurns: resolved.snapshot.maxTurns,
			timeoutMinutes: resolved.snapshot.timeoutMinutes,
			defaultOptions: resolved.snapshot.defaultOptions,
			memoryConfig: resolved.snapshot.memoryConfig,
			agentProfileTemplateId: resolved.template.id,
			agentProfileTemplateVersion: resolved.templateVersion.version,
			updatedAt: now,
		})
		.where(eq(agents.id, target.id))
		.returning({ id: agents.id });
	if (!updated) {
		throw new Error("Failed to apply profile");
	}

	await db.insert(agentProfileAppliedHistory).values({
		id: generateId(),
		agentId: target.id,
		templateId: resolved.template.id,
		templateVersion: resolved.templateVersion.version,
		appliedByUserId: params.userId,
		source: "ui",
		snapshot: {
			snapshot: resolved.snapshot,
			warnings: resolved.warnings,
		},
		createdAt: now,
	});

	return resolved;
}
