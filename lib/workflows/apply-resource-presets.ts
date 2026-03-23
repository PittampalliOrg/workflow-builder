import type { WorkflowResourceRefInput } from "@/lib/db/resources";
import { resolveSandboxProfile } from "@/lib/agent-system/sandbox-profiles";

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

function parseConfigKeys(value: unknown): string[] | undefined {
	const raw = asNonEmptyString(value);
	if (!raw) return undefined;
	const keys = raw
		.split(/[\n,]/g)
		.map((part) => part.trim())
		.filter(Boolean);
	return keys.length > 0 ? [...new Set(keys)] : undefined;
}

function parseConfigMetadata(
	value: unknown,
): Record<string, string> | undefined {
	const raw = asNonEmptyString(value);
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		const metadata = Object.fromEntries(
			Object.entries(parsed)
				.map(([k, v]) =>
					typeof v === "string"
						? ([k.trim(), v.trim()] as const)
						: typeof v === "number" || typeof v === "boolean"
							? ([k.trim(), String(v)] as const)
							: null,
				)
				.filter((entry): entry is readonly [string, string] => Boolean(entry))
				.filter(([k, v]) => Boolean(k) && Boolean(v)),
		);
		return Object.keys(metadata).length > 0 ? metadata : undefined;
	} catch {
		return undefined;
	}
}

function parseRequestedVersion(
	config: Record<string, unknown>,
	agentProfileTemplateId: string,
): number | undefined {
	const agentProfileRef = asRecord(config.agentProfileRef);
	const pinnedTemplateId =
		agentProfileRef && typeof agentProfileRef.id === "string"
			? agentProfileRef.id
			: null;
	if (pinnedTemplateId !== agentProfileTemplateId) {
		return undefined;
	}
	const rawVersion = config.agentProfileTemplateVersion;
	if (typeof rawVersion === "number" && rawVersion > 0) {
		return rawVersion;
	}
	if (typeof rawVersion === "string") {
		const parsedVersion = Number.parseInt(rawVersion, 10);
		if (Number.isFinite(parsedVersion) && parsedVersion > 0) {
			return parsedVersion;
		}
	}
	return undefined;
}

function buildRuntimeConfiguration(config: Record<string, unknown>) {
	const configStoreName = asNonEmptyString(config.configStoreName);
	const configName = asNonEmptyString(config.configName);
	const configKeys = parseConfigKeys(config.configKeys);
	const configMetadata = parseConfigMetadata(config.configMetadata);
	return configStoreName
		? {
				storeName: configStoreName,
				...(configName ? { configName } : {}),
				...(configKeys ? { keys: configKeys } : {}),
				...(configMetadata ? { metadata: configMetadata } : {}),
			}
		: undefined;
}

function resolveDefaultDaprAgentProfile(input: {
	agentType: string;
	mode: string | null;
	explicitProfile: string | null;
}): string {
	if (input.explicitProfile) {
		return input.explicitProfile;
	}
	const normalizedType = input.agentType.trim().toLowerCase();
	if (normalizedType === "planning") {
		return "plan-only";
	}
	if (normalizedType === "research") {
		return "review";
	}
	return input.mode === "execute_direct" ? "implement" : "feature-delivery";
}

function resolveConfiguredModel(
	config: Record<string, unknown>,
	fallbackModel: string,
): string {
	return asNonEmptyString(config.model) ?? fallbackModel;
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
		const actionType = asNonEmptyString(config.actionType);
		if (
			actionType !== "durable/run" &&
			actionType !== "dapr-agent/run" &&
			actionType !== "openshell-langgraph/run"
		) {
			continue;
		}

		const agentProfileTemplateId = asNonEmptyString(
			config.agentProfileTemplateId,
		);
		if (!agentProfileTemplateId) {
			if (actionType === "durable/run") {
				throw new Error(
					`Durable run node ${nodeId} is missing agentProfileTemplateId`,
				);
			}
			continue;
		}

		const { getResolvedAgentProfileTemplate } = await import(
			"@/lib/db/agent-profiles"
		);
		const resolvedProfile = await getResolvedAgentProfileTemplate({
			templateId: agentProfileTemplateId,
			version: parseRequestedVersion(config, agentProfileTemplateId),
			includeDisabled: false,
		});
		if (!resolvedProfile) {
			throw new Error(
				`Agent profile template not found: ${agentProfileTemplateId}`,
			);
		}

		const modelSpec = `${resolvedProfile.snapshot.model.provider}/${resolvedProfile.snapshot.model.name}`;
		const toolNames = resolvedProfile.snapshot.tools.map((tool) => tool.ref);
		const configuration = buildRuntimeConfiguration(config);
		const sandboxProfileRef =
			resolvedProfile.snapshot.preferredSandboxProfile ??
			resolvedProfile.snapshot.preferredExecutionProfile;
		const sandboxProfile = resolveSandboxProfile(sandboxProfileRef);

		config.agentProfileTemplateVersion =
			resolvedProfile.templateVersion.version;
		config.agentProfileRef = {
			id: resolvedProfile.template.id,
			slug: resolvedProfile.template.slug,
			name: resolvedProfile.template.name,
			version: resolvedProfile.templateVersion.version,
		};
		if (
			actionType === "dapr-agent/run" ||
			actionType === "openshell-langgraph/run"
		) {
			const mode = asNonEmptyString(config.mode) ?? "plan_mode";
			const existingInstructions = asNonEmptyString(config.instructionsOverlay);
			const selectedModel = resolveConfiguredModel(config, modelSpec);
			config.engine = asNonEmptyString(config.engine) ?? "langgraph";
			config.profile = resolveDefaultDaprAgentProfile({
				agentType: resolvedProfile.snapshot.agentType,
				mode,
				explicitProfile: asNonEmptyString(config.profile),
			});
			config.instructionsOverlay = existingInstructions
				? `${resolvedProfile.snapshot.instructions}\n\nAdditional workflow instructions:\n${existingInstructions}`
				: resolvedProfile.snapshot.instructions;
			config.model = selectedModel;
			config.maxTurns =
				asNonEmptyString(config.maxTurns) ??
				String(resolvedProfile.snapshot.maxTurns);
			config.timeoutMinutes =
				asNonEmptyString(config.timeoutMinutes) ??
				String(resolvedProfile.snapshot.timeoutMinutes);
			if (!asNonEmptyString(config.tools)) {
				config.tools = JSON.stringify(toolNames);
			}
			config.agentConfig = {
				name: resolvedProfile.template.name,
				instructions: resolvedProfile.snapshot.instructions,
				modelSpec: selectedModel,
				maxTurns: resolvedProfile.snapshot.maxTurns,
				timeoutMinutes: resolvedProfile.snapshot.timeoutMinutes,
				tools: toolNames,
				requiredCapabilities: resolvedProfile.snapshot.requiredCapabilities,
				preferredExecutionProfile:
					resolvedProfile.snapshot.preferredExecutionProfile,
				preferredSandboxProfile: sandboxProfileRef,
				workspaceBackend: sandboxProfile?.backend ?? null,
				...(configuration ? { configuration } : {}),
			};
			if (!config.requiredCapabilities) {
				config.requiredCapabilities =
					resolvedProfile.snapshot.requiredCapabilities;
			}
			if (!config.preferredExecutionProfile) {
				config.preferredExecutionProfile =
					resolvedProfile.snapshot.preferredExecutionProfile;
			}
			if (!config.preferredSandboxProfile) {
				config.preferredSandboxProfile = sandboxProfileRef;
			}
			if (!config.workspaceBackend && sandboxProfile?.backend) {
				config.workspaceBackend = sandboxProfile.backend;
			}
		} else {
			config.agentConfig = {
				name: resolvedProfile.template.name,
				instructions: resolvedProfile.snapshot.instructions,
				modelSpec,
				maxTurns: resolvedProfile.snapshot.maxTurns,
				timeoutMinutes: resolvedProfile.snapshot.timeoutMinutes,
				tools: toolNames,
				requiredCapabilities: resolvedProfile.snapshot.requiredCapabilities,
				preferredExecutionProfile:
					resolvedProfile.snapshot.preferredExecutionProfile,
				preferredSandboxProfile: sandboxProfileRef,
				workspaceBackend: sandboxProfile?.backend ?? null,
				...(configuration ? { configuration } : {}),
			};
			config.model = modelSpec;
			config.maxTurns = String(resolvedProfile.snapshot.maxTurns);
			config.timeoutMinutes = String(resolvedProfile.snapshot.timeoutMinutes);
		}

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
		if (
			actionType !== "dapr-agent/run" &&
			actionType !== "openshell-langgraph/run"
		) {
			delete config.tools;
		}
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
	const { replaceWorkflowResourceRefs } = await import("@/lib/db/resources");
	await replaceWorkflowResourceRefs(input.workflowId, input.refs);
}
