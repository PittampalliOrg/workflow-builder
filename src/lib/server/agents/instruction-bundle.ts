import { createHash } from "node:crypto";
import { canonicalJson } from "./config-hash";
import type { AgentConfig } from "$lib/types/agents";
import {
	CANONICAL_BUNDLE_TEMPLATE_NAME,
	INSTRUCTION_BUNDLE_SCHEMA_VERSION,
	SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
	buildOpenShellSystemPrompt,
	renderInstructionSystemText,
} from "$lib/agents/instruction-bundle-renderer";

export {
	CANONICAL_BUNDLE_TEMPLATE_NAME,
	INSTRUCTION_BUNDLE_SCHEMA_VERSION,
	SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
	buildOpenShellSystemPrompt,
	renderInstructionSystemText,
};

export type InstructionSource = {
	field: string;
	sourceType: "agent-profile" | "runtime" | "user";
	sourceId: string;
	overrideKind: "base" | "control" | "runtime";
};

export type InstructionBundle = {
	schemaVersion: typeof INSTRUCTION_BUNDLE_SCHEMA_VERSION;
	instructionHash: string;
	templateName: typeof CANONICAL_BUNDLE_TEMPLATE_NAME;
	templateHash: string;
	agent: {
		id?: string;
		version?: number;
		configHash?: string;
		slug?: string;
	};
	persona: {
		systemPrompt?: string;
	};
	runtime: {
		cwd?: string;
		sandboxName?: string;
		skills: string[];
		hookContext?: string;
		platformSystemSections: string[];
		currentDate?: string;
		mcpInstructions: string[];
		compiledStaticPresetSections: string[];
		compiledDynamicPresetSections: string[];
		cacheTtl: "5m" | "1h";
	};
	user: {
		prompt: string;
		source: "session" | "workflow-node";
	};
	sources: InstructionSource[];
	rendered: {
		system: string;
		user: string;
	};
};

type BuildInstructionBundleInput = {
	agentConfig: AgentConfig | Record<string, unknown> | null | undefined;
	prompt: string;
	promptSource: "session" | "workflow-node";
	agent?: {
		id?: string | null;
		version?: number | null;
		configHash?: string | null;
		slug?: string | null;
	};
	cwd?: string | null;
	sandboxName?: string | null;
	platformSystemSections?: string[];
	hookContext?: string | null;
	currentDate?: string | null;
	mcpInstructions?: string[];
	sourceId?: string;
};

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
		.filter(Boolean);
}

function skillName(item: unknown): string | null {
	if (!item || typeof item !== "object" || Array.isArray(item)) return null;
	const record = item as Record<string, unknown>;
	return (
		cleanString(record.name) ??
		cleanString(record.skillName) ??
		cleanString(record.skill_name) ??
		cleanString(record.slug) ??
		null
	);
}

function source(
	field: string,
	sourceId: string,
	sourceType: InstructionSource["sourceType"] = "agent-profile",
	overrideKind: InstructionSource["overrideKind"] = "base",
): InstructionSource {
	return { field, sourceType, sourceId, overrideKind };
}

export function bundleTemplateHash(systemText: string): string {
	return createHash("sha256")
		.update(
			canonicalJson({
				templateName: CANONICAL_BUNDLE_TEMPLATE_NAME,
				templateFormat: "jinja2",
				messages: [
					{ role: "system", content: systemText },
					{ placeholder: "chat_history" },
				],
			}),
		)
		.digest("hex");
}

export function buildInstructionBundle(
	input: BuildInstructionBundleInput,
): InstructionBundle {
	const config = (input.agentConfig ?? {}) as Record<string, unknown>;
	const sourceId = input.sourceId ?? input.agent?.id ?? "agent-profile";
	const persona = {
		systemPrompt: cleanString(config.systemPrompt),
	};
	const cacheTtl: "5m" | "1h" =
		config.cacheTtl === "1h" ? "1h" : "5m";
	const runtime = {
		cwd: cleanString(input.cwd),
		sandboxName: cleanString(input.sandboxName),
		skills: Array.isArray(config.skills)
			? config.skills.map(skillName).filter((name): name is string => Boolean(name))
			: [],
		hookContext: cleanString(input.hookContext),
		platformSystemSections: cleanStringList(input.platformSystemSections),
		currentDate: cleanString(input.currentDate),
		mcpInstructions: cleanStringList(input.mcpInstructions),
		// Resolved by the BFF's compilePromptStack() before bundle build —
		// the agent profile carries these as plain strings to dapr-agent-py.
		compiledStaticPresetSections: cleanStringList(config.compiledStaticPresetSections),
		compiledDynamicPresetSections: cleanStringList(config.compiledDynamicPresetSections),
		// Anthropic ephemeral cache TTL — defaults to '5m'. '1h' is meaningful
		// for long-running Dapr durable agents that span >5min between turns.
		cacheTtl,
	};
	const sources: InstructionSource[] = [];
	if (persona.systemPrompt) sources.push(source("persona.systemPrompt", sourceId));
	if (runtime.cwd) sources.push(source("runtime.cwd", "runtime", "runtime", "runtime"));
	if (runtime.sandboxName) {
		sources.push(source("runtime.sandboxName", "runtime", "runtime", "runtime"));
	}
	if (runtime.skills.length) {
		sources.push(source("runtime.skills", "agentConfig.skills", "runtime", "runtime"));
	}
	if (runtime.currentDate) {
		sources.push(source("runtime.currentDate", "runtime", "runtime", "runtime"));
	}
	if (runtime.mcpInstructions.length) {
		sources.push(source("runtime.mcpInstructions", "mcp-clients", "runtime", "runtime"));
	}
	if (runtime.compiledStaticPresetSections.length) {
		sources.push(
			source(
				"runtime.compiledStaticPresetSections",
				"prompt-workbench",
				"runtime",
				"runtime",
			),
		);
	}
	if (runtime.compiledDynamicPresetSections.length) {
		sources.push(
			source(
				"runtime.compiledDynamicPresetSections",
				"prompt-workbench",
				"runtime",
				"runtime",
			),
		);
	}
	// cacheTtl always emits a source — default '5m' is just as significant
	// as an explicit '1h' for cost-analysis audit.
	sources.push(
		source(
			"runtime.cacheTtl",
			config.cacheTtl === "5m" || config.cacheTtl === "1h" ? sourceId : "default",
			"runtime",
			"runtime",
		),
	);
	sources.push(
		source(
			"user.prompt",
			input.promptSource,
			"user",
			input.promptSource === "workflow-node" ? "runtime" : "control",
		),
	);

	const base: Omit<
		InstructionBundle,
		"instructionHash" | "templateName" | "templateHash" | "rendered"
	> = {
		schemaVersion: INSTRUCTION_BUNDLE_SCHEMA_VERSION,
		agent: {
			...(input.agent?.id ? { id: input.agent.id } : {}),
			...(typeof input.agent?.version === "number"
				? { version: input.agent.version }
				: {}),
			...(input.agent?.configHash ? { configHash: input.agent.configHash } : {}),
			...(input.agent?.slug ? { slug: input.agent.slug } : {}),
		},
		persona,
		runtime,
		user: {
			prompt: input.prompt,
			source: input.promptSource,
		},
		sources,
	};
	const rendered = {
		system: renderInstructionSystemText(base),
		user: input.prompt,
	};
	const templateHash = bundleTemplateHash(rendered.system);
	const baseWithTemplate: Omit<InstructionBundle, "instructionHash" | "rendered"> = {
		...base,
		templateName: CANONICAL_BUNDLE_TEMPLATE_NAME,
		templateHash,
	};
	const instructionHash = createHash("sha256")
		.update(canonicalJson({ ...baseWithTemplate, rendered }))
		.digest("hex");
	return {
		...baseWithTemplate,
		instructionHash,
		rendered,
	};
}
