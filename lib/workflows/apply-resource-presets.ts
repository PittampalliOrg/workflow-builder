import {
	replaceWorkflowResourceRefs,
	type WorkflowResourceRefInput,
} from "@/lib/db/resources";
import { getResolvedAgentProfileTemplate } from "@/lib/db/agent-profiles";

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
	void input.userId;
	void input.projectId;
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
		if (asNonEmptyString(config.actionType) !== "durable/run") {
			continue;
		}

		const agentProfileTemplateId = asNonEmptyString(
			config.agentProfileTemplateId,
		);
		if (!agentProfileTemplateId) {
			throw new Error(
				`Durable run node ${nodeId} is missing agentProfileTemplateId`,
			);
		}

		let requestedVersion: number | undefined;
		const agentProfileRef = asRecord(config.agentProfileRef);
		const pinnedTemplateId =
			agentProfileRef && typeof agentProfileRef.id === "string"
				? agentProfileRef.id
				: null;
		if (pinnedTemplateId === agentProfileTemplateId) {
			const rawVersion = config.agentProfileTemplateVersion;
			if (typeof rawVersion === "number" && rawVersion > 0) {
				requestedVersion = rawVersion;
			} else if (typeof rawVersion === "string") {
				const parsedVersion = Number.parseInt(rawVersion, 10);
				if (Number.isFinite(parsedVersion) && parsedVersion > 0) {
					requestedVersion = parsedVersion;
				}
			}
		}

		const resolvedProfile = await getResolvedAgentProfileTemplate({
			templateId: agentProfileTemplateId,
			version: requestedVersion,
			includeDisabled: false,
		});
		if (!resolvedProfile) {
			throw new Error(
				`Agent profile template not found: ${agentProfileTemplateId}`,
			);
		}

		const modelSpec = `${resolvedProfile.snapshot.model.provider}/${resolvedProfile.snapshot.model.name}`;
		const toolNames = resolvedProfile.snapshot.tools.map((tool) => tool.ref);

		config.agentProfileTemplateVersion =
			resolvedProfile.templateVersion.version;
		config.agentProfileRef = {
			id: resolvedProfile.template.id,
			slug: resolvedProfile.template.slug,
			name: resolvedProfile.template.name,
			version: resolvedProfile.templateVersion.version,
		};
		config.agentConfig = {
			name: resolvedProfile.template.name,
			instructions: resolvedProfile.snapshot.instructions,
			modelSpec,
			maxTurns: resolvedProfile.snapshot.maxTurns,
			timeoutMinutes: resolvedProfile.snapshot.timeoutMinutes,
			tools: toolNames,
		};
		config.model = modelSpec;
		config.maxTurns = String(resolvedProfile.snapshot.maxTurns);
		config.timeoutMinutes = String(resolvedProfile.snapshot.timeoutMinutes);

		delete config.agentId;
		delete config.instructionsPresetId;
		delete config.instructionsPresetVersion;
		delete config.instructionsPresetRef;
		delete config.schemaPresetId;
		delete config.schemaPresetVersion;
		delete config.schemaPresetRef;
		delete config.modelProfileId;
		delete config.modelProfileVersion;
		delete config.modelProfileRef;
		delete config.instructions;
		delete config.tools;
		delete config.structuredOutputSchema;

		refs.push({
			nodeId,
			resourceType: "agent_profile",
			resourceId: resolvedProfile.template.id,
			resourceVersion: resolvedProfile.templateVersion.version,
		});
	}

	return { nodes: clonedNodes, refs };
}

export async function persistWorkflowResourceRefs(input: {
	workflowId: string;
	refs: WorkflowResourceRefInput[];
}) {
	await replaceWorkflowResourceRefs(input.workflowId, input.refs);
}
