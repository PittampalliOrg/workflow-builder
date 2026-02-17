import "server-only";

import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "./index";
import {
	projectMembers,
	resourceModelProfiles,
	resourcePrompts,
	resourceSchemas,
	workflowResourceRefs,
	type NewWorkflowResourceRef,
} from "./schema";
import { generateId } from "@/lib/utils/id";

export type ResourceType =
	| "prompt"
	| "schema"
	| "model_profile"
	| "agent_profile";

export type ResourceListParams = {
	userId: string;
	projectId: string;
	includeDisabled?: boolean;
};

export type CreateResourcePromptInput = {
	name: string;
	description?: string | null;
	systemPrompt: string;
	userPrompt?: string | null;
	promptMode?: "system" | "system+user";
	metadata?: Record<string, unknown> | null;
	isEnabled?: boolean;
	projectId?: string | null;
};

export type UpdateResourcePromptInput = Partial<
	Omit<CreateResourcePromptInput, "projectId">
>;

export type CreateResourceSchemaInput = {
	name: string;
	description?: string | null;
	schema: unknown;
	schemaType?: "json-schema";
	metadata?: Record<string, unknown> | null;
	isEnabled?: boolean;
	projectId?: string | null;
};

export type UpdateResourceSchemaInput = Partial<
	Omit<CreateResourceSchemaInput, "projectId">
>;

export type CreateResourceModelProfileInput = {
	name: string;
	description?: string | null;
	model: { provider: string; name: string };
	defaultOptions?: Record<string, unknown> | null;
	maxTurns?: number | null;
	timeoutMinutes?: number | null;
	metadata?: Record<string, unknown> | null;
	isEnabled?: boolean;
	projectId?: string | null;
};

export type UpdateResourceModelProfileInput = Partial<
	Omit<CreateResourceModelProfileInput, "projectId">
>;

export type WorkflowResourceRefInput = {
	nodeId: string;
	resourceType: ResourceType;
	resourceId: string;
	resourceVersion: number | null;
};

async function isProjectMember(
	userId: string,
	projectId: string,
): Promise<boolean> {
	const row = await db.query.projectMembers.findFirst({
		where: and(
			eq(projectMembers.userId, userId),
			eq(projectMembers.projectId, projectId),
		),
	});
	return Boolean(row);
}

function validateProjectScope(
	inputProjectId: string | null | undefined,
	currentProjectId: string,
): string | null {
	if (!inputProjectId) {
		return null;
	}
	if (inputProjectId !== currentProjectId) {
		throw new Error("projectId must match current session project");
	}
	return inputProjectId;
}

function listScopeCondition<T extends { userId: unknown; projectId: unknown }>(
	table: T,
	userId: string,
	projectId: string,
) {
	return or(
		and(eq(table.userId as never, userId), isNull(table.projectId as never)),
		eq(table.projectId as never, projectId),
	);
}

async function assertCanReadResource(
	resourceProjectId: string | null,
	ownerId: string,
	userId: string,
	projectId: string,
): Promise<void> {
	if (!resourceProjectId) {
		if (ownerId !== userId) {
			throw new Error("Not found");
		}
		return;
	}

	if (resourceProjectId !== projectId) {
		throw new Error("Not found");
	}

	if (!(await isProjectMember(userId, resourceProjectId))) {
		throw new Error("Not found");
	}
}

function assertCanEditResource(
	resourceProjectId: string | null,
	ownerId: string,
	userId: string,
	projectId: string,
): void {
	if (!resourceProjectId) {
		if (ownerId !== userId) {
			throw new Error("Not found");
		}
		return;
	}

	if (resourceProjectId !== projectId || ownerId !== userId) {
		throw new Error("Forbidden");
	}
}

export async function listResourcePrompts(params: ResourceListParams) {
	const scopeCondition = listScopeCondition(
		resourcePrompts,
		params.userId,
		params.projectId,
	);
	const whereCondition = params.includeDisabled
		? scopeCondition
		: and(scopeCondition, eq(resourcePrompts.isEnabled, true));

	const rows = await db
		.select()
		.from(resourcePrompts)
		.where(whereCondition)
		.orderBy(desc(resourcePrompts.updatedAt));
	return rows;
}

export async function createResourcePrompt(params: {
	userId: string;
	currentProjectId: string;
	input: CreateResourcePromptInput;
}) {
	const scopedProjectId = validateProjectScope(
		params.input.projectId,
		params.currentProjectId,
	);
	if (
		scopedProjectId &&
		!(await isProjectMember(params.userId, scopedProjectId))
	) {
		throw new Error("Forbidden");
	}

	const [created] = await db
		.insert(resourcePrompts)
		.values({
			id: generateId(),
			name: params.input.name,
			description: params.input.description ?? null,
			systemPrompt: params.input.systemPrompt,
			userPrompt: params.input.userPrompt ?? null,
			promptMode: params.input.promptMode ?? "system",
			metadata: params.input.metadata ?? null,
			isEnabled: params.input.isEnabled ?? true,
			version: 1,
			userId: params.userId,
			projectId: scopedProjectId,
		})
		.returning();

	return created;
}

export async function getResourcePromptByIdForRead(params: {
	id: string;
	userId: string;
	projectId: string;
}) {
	const row = await db.query.resourcePrompts.findFirst({
		where: eq(resourcePrompts.id, params.id),
	});
	if (!row) return null;
	await assertCanReadResource(
		row.projectId,
		row.userId,
		params.userId,
		params.projectId,
	);
	return row;
}

export async function updateResourcePromptById(params: {
	id: string;
	userId: string;
	projectId: string;
	input: UpdateResourcePromptInput;
}) {
	const existing = await db.query.resourcePrompts.findFirst({
		where: eq(resourcePrompts.id, params.id),
	});
	if (!existing) {
		throw new Error("Not found");
	}
	assertCanEditResource(
		existing.projectId,
		existing.userId,
		params.userId,
		params.projectId,
	);

	const [updated] = await db
		.update(resourcePrompts)
		.set({
			name: params.input.name ?? existing.name,
			description:
				params.input.description === undefined
					? existing.description
					: params.input.description,
			systemPrompt: params.input.systemPrompt ?? existing.systemPrompt,
			userPrompt:
				params.input.userPrompt === undefined
					? existing.userPrompt
					: params.input.userPrompt,
			promptMode: params.input.promptMode ?? existing.promptMode,
			metadata:
				params.input.metadata === undefined
					? existing.metadata
					: params.input.metadata,
			isEnabled:
				params.input.isEnabled === undefined
					? existing.isEnabled
					: params.input.isEnabled,
			version: existing.version + 1,
			updatedAt: new Date(),
		})
		.where(eq(resourcePrompts.id, params.id))
		.returning();

	return updated;
}

export async function deleteResourcePromptById(params: {
	id: string;
	userId: string;
	projectId: string;
}) {
	const existing = await db.query.resourcePrompts.findFirst({
		where: eq(resourcePrompts.id, params.id),
	});
	if (!existing) {
		return false;
	}
	assertCanEditResource(
		existing.projectId,
		existing.userId,
		params.userId,
		params.projectId,
	);
	const rows = await db
		.delete(resourcePrompts)
		.where(eq(resourcePrompts.id, params.id))
		.returning({ id: resourcePrompts.id });
	return rows.length > 0;
}

export async function listResourceSchemas(params: ResourceListParams) {
	const scopeCondition = listScopeCondition(
		resourceSchemas,
		params.userId,
		params.projectId,
	);
	const whereCondition = params.includeDisabled
		? scopeCondition
		: and(scopeCondition, eq(resourceSchemas.isEnabled, true));

	const rows = await db
		.select()
		.from(resourceSchemas)
		.where(whereCondition)
		.orderBy(desc(resourceSchemas.updatedAt));
	return rows;
}

export async function createResourceSchema(params: {
	userId: string;
	currentProjectId: string;
	input: CreateResourceSchemaInput;
}) {
	const scopedProjectId = validateProjectScope(
		params.input.projectId,
		params.currentProjectId,
	);
	if (
		scopedProjectId &&
		!(await isProjectMember(params.userId, scopedProjectId))
	) {
		throw new Error("Forbidden");
	}

	const [created] = await db
		.insert(resourceSchemas)
		.values({
			id: generateId(),
			name: params.input.name,
			description: params.input.description ?? null,
			schema: params.input.schema,
			schemaType: params.input.schemaType ?? "json-schema",
			metadata: params.input.metadata ?? null,
			isEnabled: params.input.isEnabled ?? true,
			version: 1,
			userId: params.userId,
			projectId: scopedProjectId,
		})
		.returning();

	return created;
}

export async function getResourceSchemaByIdForRead(params: {
	id: string;
	userId: string;
	projectId: string;
}) {
	const row = await db.query.resourceSchemas.findFirst({
		where: eq(resourceSchemas.id, params.id),
	});
	if (!row) return null;
	await assertCanReadResource(
		row.projectId,
		row.userId,
		params.userId,
		params.projectId,
	);
	return row;
}

export async function updateResourceSchemaById(params: {
	id: string;
	userId: string;
	projectId: string;
	input: UpdateResourceSchemaInput;
}) {
	const existing = await db.query.resourceSchemas.findFirst({
		where: eq(resourceSchemas.id, params.id),
	});
	if (!existing) {
		throw new Error("Not found");
	}
	assertCanEditResource(
		existing.projectId,
		existing.userId,
		params.userId,
		params.projectId,
	);

	const [updated] = await db
		.update(resourceSchemas)
		.set({
			name: params.input.name ?? existing.name,
			description:
				params.input.description === undefined
					? existing.description
					: params.input.description,
			schema: params.input.schema ?? existing.schema,
			schemaType: params.input.schemaType ?? existing.schemaType,
			metadata:
				params.input.metadata === undefined
					? existing.metadata
					: params.input.metadata,
			isEnabled:
				params.input.isEnabled === undefined
					? existing.isEnabled
					: params.input.isEnabled,
			version: existing.version + 1,
			updatedAt: new Date(),
		})
		.where(eq(resourceSchemas.id, params.id))
		.returning();

	return updated;
}

export async function deleteResourceSchemaById(params: {
	id: string;
	userId: string;
	projectId: string;
}) {
	const existing = await db.query.resourceSchemas.findFirst({
		where: eq(resourceSchemas.id, params.id),
	});
	if (!existing) {
		return false;
	}
	assertCanEditResource(
		existing.projectId,
		existing.userId,
		params.userId,
		params.projectId,
	);
	const rows = await db
		.delete(resourceSchemas)
		.where(eq(resourceSchemas.id, params.id))
		.returning({ id: resourceSchemas.id });
	return rows.length > 0;
}

export async function listResourceModelProfiles(params: ResourceListParams) {
	const scopeCondition = listScopeCondition(
		resourceModelProfiles,
		params.userId,
		params.projectId,
	);
	const whereCondition = params.includeDisabled
		? scopeCondition
		: and(scopeCondition, eq(resourceModelProfiles.isEnabled, true));

	const rows = await db
		.select()
		.from(resourceModelProfiles)
		.where(whereCondition)
		.orderBy(desc(resourceModelProfiles.updatedAt));
	return rows;
}

export async function createResourceModelProfile(params: {
	userId: string;
	currentProjectId: string;
	input: CreateResourceModelProfileInput;
}) {
	const scopedProjectId = validateProjectScope(
		params.input.projectId,
		params.currentProjectId,
	);
	if (
		scopedProjectId &&
		!(await isProjectMember(params.userId, scopedProjectId))
	) {
		throw new Error("Forbidden");
	}

	const [created] = await db
		.insert(resourceModelProfiles)
		.values({
			id: generateId(),
			name: params.input.name,
			description: params.input.description ?? null,
			model: params.input.model,
			defaultOptions: params.input.defaultOptions ?? null,
			maxTurns: params.input.maxTurns ?? null,
			timeoutMinutes: params.input.timeoutMinutes ?? null,
			metadata: params.input.metadata ?? null,
			isEnabled: params.input.isEnabled ?? true,
			version: 1,
			userId: params.userId,
			projectId: scopedProjectId,
		})
		.returning();

	return created;
}

export async function getResourceModelProfileByIdForRead(params: {
	id: string;
	userId: string;
	projectId: string;
}) {
	const row = await db.query.resourceModelProfiles.findFirst({
		where: eq(resourceModelProfiles.id, params.id),
	});
	if (!row) return null;
	await assertCanReadResource(
		row.projectId,
		row.userId,
		params.userId,
		params.projectId,
	);
	return row;
}

export async function updateResourceModelProfileById(params: {
	id: string;
	userId: string;
	projectId: string;
	input: UpdateResourceModelProfileInput;
}) {
	const existing = await db.query.resourceModelProfiles.findFirst({
		where: eq(resourceModelProfiles.id, params.id),
	});
	if (!existing) {
		throw new Error("Not found");
	}
	assertCanEditResource(
		existing.projectId,
		existing.userId,
		params.userId,
		params.projectId,
	);

	const [updated] = await db
		.update(resourceModelProfiles)
		.set({
			name: params.input.name ?? existing.name,
			description:
				params.input.description === undefined
					? existing.description
					: params.input.description,
			model: params.input.model ?? existing.model,
			defaultOptions:
				params.input.defaultOptions === undefined
					? existing.defaultOptions
					: params.input.defaultOptions,
			maxTurns:
				params.input.maxTurns === undefined
					? existing.maxTurns
					: params.input.maxTurns,
			timeoutMinutes:
				params.input.timeoutMinutes === undefined
					? existing.timeoutMinutes
					: params.input.timeoutMinutes,
			metadata:
				params.input.metadata === undefined
					? existing.metadata
					: params.input.metadata,
			isEnabled:
				params.input.isEnabled === undefined
					? existing.isEnabled
					: params.input.isEnabled,
			version: existing.version + 1,
			updatedAt: new Date(),
		})
		.where(eq(resourceModelProfiles.id, params.id))
		.returning();

	return updated;
}

export async function deleteResourceModelProfileById(params: {
	id: string;
	userId: string;
	projectId: string;
}) {
	const existing = await db.query.resourceModelProfiles.findFirst({
		where: eq(resourceModelProfiles.id, params.id),
	});
	if (!existing) {
		return false;
	}
	assertCanEditResource(
		existing.projectId,
		existing.userId,
		params.userId,
		params.projectId,
	);
	const rows = await db
		.delete(resourceModelProfiles)
		.where(eq(resourceModelProfiles.id, params.id))
		.returning({ id: resourceModelProfiles.id });
	return rows.length > 0;
}

export async function resolvePromptPresetForUse(params: {
	id: string;
	userId: string;
	projectId: string;
}) {
	return getResourcePromptByIdForRead(params);
}

export async function resolveSchemaPresetForUse(params: {
	id: string;
	userId: string;
	projectId: string;
}) {
	return getResourceSchemaByIdForRead(params);
}

export async function resolveModelProfilePresetForUse(params: {
	id: string;
	userId: string;
	projectId: string;
}) {
	return getResourceModelProfileByIdForRead(params);
}

export async function replaceWorkflowResourceRefs(
	workflowId: string,
	refs: WorkflowResourceRefInput[],
) {
	await db
		.delete(workflowResourceRefs)
		.where(eq(workflowResourceRefs.workflowId, workflowId));

	if (refs.length === 0) {
		return;
	}

	const now = new Date();
	const values: NewWorkflowResourceRef[] = refs.map((ref) => ({
		id: generateId(),
		workflowId,
		nodeId: ref.nodeId,
		resourceType: ref.resourceType,
		resourceId: ref.resourceId,
		resourceVersion: ref.resourceVersion,
		createdAt: now,
		updatedAt: now,
	}));

	await db.insert(workflowResourceRefs).values(values);
}
