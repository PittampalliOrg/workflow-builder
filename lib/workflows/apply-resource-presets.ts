import {
	replaceWorkflowResourceRefs,
	resolveModelProfilePresetForUse,
	resolvePromptPresetForUse,
	resolveSchemaPresetForUse,
	type WorkflowResourceRefInput,
} from "@/lib/db/resources";

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export async function applyResourcePresetsToNodes(input: {
	nodes: unknown[];
	userId: string;
	projectId: string;
}): Promise<{ nodes: unknown[]; refs: WorkflowResourceRefInput[] }> {
	const clonedNodes = structuredClone(input.nodes);
	const refs: WorkflowResourceRefInput[] = [];

	for (const node of clonedNodes) {
		const nodeRecord = asRecord(node);
		if (!nodeRecord) continue;
		const nodeId = asNonEmptyString(nodeRecord.id);
		if (!nodeId) continue;

		const data = asRecord(nodeRecord.data);
		if (!data) continue;
		const config = asRecord(data.config);
		if (!config) continue;

		const instructionsPresetId = asNonEmptyString(config.instructionsPresetId);
		if (instructionsPresetId) {
			const preset = await resolvePromptPresetForUse({
				id: instructionsPresetId,
				userId: input.userId,
				projectId: input.projectId,
			});
			if (!preset) {
				throw new Error(`Prompt preset not found: ${instructionsPresetId}`);
			}
			config.instructions = preset.systemPrompt;
			config.instructionsPresetVersion = preset.version;
			config.instructionsPresetRef = {
				id: preset.id,
				name: preset.name,
				version: preset.version,
			};
			refs.push({
				nodeId,
				resourceType: "prompt",
				resourceId: preset.id,
				resourceVersion: preset.version,
			});
		}

		const schemaPresetId = asNonEmptyString(config.schemaPresetId);
		if (schemaPresetId) {
			const preset = await resolveSchemaPresetForUse({
				id: schemaPresetId,
				userId: input.userId,
				projectId: input.projectId,
			});
			if (!preset) {
				throw new Error(`Schema preset not found: ${schemaPresetId}`);
			}
			config.structuredOutputSchema = JSON.stringify(preset.schema);
			config.schemaPresetVersion = preset.version;
			config.schemaPresetRef = {
				id: preset.id,
				name: preset.name,
				version: preset.version,
			};
			refs.push({
				nodeId,
				resourceType: "schema",
				resourceId: preset.id,
				resourceVersion: preset.version,
			});
		}

		const modelProfileId = asNonEmptyString(config.modelProfileId);
		if (modelProfileId) {
			const profile = await resolveModelProfilePresetForUse({
				id: modelProfileId,
				userId: input.userId,
				projectId: input.projectId,
			});
			if (!profile) {
				throw new Error(`Model profile preset not found: ${modelProfileId}`);
			}
			config.model = `${profile.model.provider}/${profile.model.name}`;
			if (profile.maxTurns != null) {
				config.maxTurns = String(profile.maxTurns);
			}
			if (profile.timeoutMinutes != null) {
				config.timeoutMinutes = String(profile.timeoutMinutes);
			}
			config.modelProfileVersion = profile.version;
			config.modelProfileRef = {
				id: profile.id,
				name: profile.name,
				version: profile.version,
			};
			refs.push({
				nodeId,
				resourceType: "model_profile",
				resourceId: profile.id,
				resourceVersion: profile.version,
			});
		}
	}

	return { nodes: clonedNodes, refs };
}

export async function persistWorkflowResourceRefs(input: {
	workflowId: string;
	refs: WorkflowResourceRefInput[];
}) {
	await replaceWorkflowResourceRefs(input.workflowId, input.refs);
}
