import type { AgentConfig } from "$lib/types/agents";
import type {
	PromptArgumentDefinition,
	PromptPresetSummary,
	PromptTemplateMessage,
} from "$lib/types/prompt-presets";
import {
	CANONICAL_BUNDLE_TEMPLATE_NAME,
	renderInstructionSystemText,
} from "./instruction-bundle-renderer";

export type PromptVariable = {
	path: string;
	placeholder: string;
	label: string;
	description?: string;
	sample: string;
};

export type PromptVariableCategory = {
	id: string;
	label: string;
	variables: PromptVariable[];
};

export type PromptPreviewWarning = {
	source: string;
	variable?: string;
	message: string;
};

export type RenderedPromptMessage = PromptTemplateMessage & {
	content: string;
	originalContent: string;
	unresolvedVariables: string[];
	notSentInV1?: boolean;
};

export type PromptWorkbenchPreview = {
	audit: {
		agentId?: string;
		agentSlug?: string;
		agentName?: string;
		agentVersion?: number | null;
		configHash?: string | null;
		canonicalTemplateName: string;
		canonicalTemplateHash: string;
		instructionHash: string;
		presetId?: string;
		presetName?: string;
		presetVersion?: number;
		presetTemplateHash?: string;
		templateFormat: "mustache";
		sourceFields: string[];
	};
	presetMessages: RenderedPromptMessage[];
	systemMessage: string;
	chatHistoryPlaceholder: string;
	appendedUserMessage: string;
	appendedUserVariables: string[];
	warnings: PromptPreviewWarning[];
	variableCategories: PromptVariableCategory[];
	sources: Array<{ label: string; value: string }>;
};

export type PromptPreviewInput = {
	config: AgentConfig | Record<string, unknown>;
	agent?: {
		id?: string | null;
		slug?: string | null;
		name?: string | null;
		version?: number | null;
		configHash?: string | null;
	};
	runtime?: {
		cwd?: string | null;
		sandboxName?: string | null;
		environment?: string | null;
		skills?: string[];
		platformSystemSections?: string[];
		hookContext?: string | null;
	};
	workflow?: {
		id?: string | null;
		name?: string | null;
		nodePrompt?: string | null;
	};
	session?: {
		id?: string | null;
		runId?: string | null;
	};
	preset?: PromptPresetSummary | null;
	userPrompt?: string | null;
};

type RenderContext = Record<string, unknown>;

const MUSTACHE_VARIABLE_RE = /{{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*}}/g;

export function extractMustacheVariables(template: string): string[] {
	const found = new Set<string>();
	for (const match of template.matchAll(MUSTACHE_VARIABLE_RE)) {
		found.add(match[1]);
	}
	return [...found];
}

export function renderMustachePreview(
	template: string,
	context: RenderContext,
): { content: string; unresolvedVariables: string[] } {
	const unresolved = new Set<string>();
	const content = template.replace(MUSTACHE_VARIABLE_RE, (raw, path: string) => {
		const value = readPath(context, path);
		if (value === undefined || value === null || value === "") {
			unresolved.add(path);
			return raw;
		}
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}
		if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
		return JSON.stringify(value);
	});
	return { content, unresolvedVariables: [...unresolved] };
}

export function buildPromptWorkbenchPreview(
	input: PromptPreviewInput,
): PromptWorkbenchPreview {
	const config = input.config ?? {};
	const latestPresetVersion = input.preset?.latestVersion ?? null;
	const variableCategories = buildPromptVariableCategories(input);
	const context = buildPreviewContext(input, variableCategories);

	const warnings: PromptPreviewWarning[] = [];
	const presetMessages =
		latestPresetVersion?.messages.map((message, index) => {
			const templateVariables = extractMustacheVariables(message.content);
			if (templateVariables.length > 0 && message.role !== "user") {
				warnings.push({
					source: `preset.messages[${index}].content`,
					variable: templateVariables[0],
					message:
						"Preset variables inside system/assistant messages are preview-only in v1. If runtime substitution is added later, keep dynamic values after the stable prompt prefix to preserve provider prompt-cache hits.",
				});
			}
			const rendered = renderMustachePreview(message.content, context);
			for (const variable of rendered.unresolvedVariables) {
				warnings.push({
					source: `preset.messages[${index}].content`,
					variable,
					message: `Missing preview value for {{${variable}}}; the placeholder is left unresolved.`,
				});
			}
			return {
				...message,
				content: rendered.content,
				originalContent: message.content,
				unresolvedVariables: rendered.unresolvedVariables,
				notSentInV1: true,
			};
		}) ?? [];

	const runtime = input.runtime ?? {};
	const systemMessage = renderInstructionSystemText({
		persona: config,
		runtime: {
			cwd: runtime.cwd ?? undefined,
			sandboxName: runtime.sandboxName ?? undefined,
			skills: runtime.skills ?? skillNames((config as Record<string, unknown>).skills),
			hookContext: runtime.hookContext ?? undefined,
			platformSystemSections: runtime.platformSystemSections ?? [],
		},
	});
	const appendedUserMessage = input.userPrompt ?? input.workflow?.nodePrompt ?? "";
	const systemVariables = extractMustacheVariables(systemMessage);
	if (systemVariables.length > 0) {
		warnings.push({
			source: "systemMessage",
			variable: systemVariables[0],
			message:
				"Variables in the canonical system message are not substituted at runtime in v1. Keep run-specific values out of this stable prefix so prompt caching remains effective.",
		});
	}
	if (runtime.cwd || runtime.sandboxName || runtime.environment) {
		warnings.push({
			source: "runtimeContext",
			message:
				"Runtime context is shown inside the canonical system preview. Values that change per run reduce prefix-cache reuse; prefer stable agent persona fields and put per-run detail in the appended user message.",
		});
	}
	const appendedUserVariables = extractMustacheVariables(appendedUserMessage);
	for (const variable of appendedUserVariables) {
		warnings.push({
			source: "appendedUserMessage",
			variable,
			message: `{{${variable}}} appears in the appended user message. Runtime templating is not applied in v1, so it will be sent literally.`,
		});
	}

	const canonicalTemplateHash = sha256Hex(
		canonicalJson({
			templateName: CANONICAL_BUNDLE_TEMPLATE_NAME,
			templateFormat: "jinja2",
			messages: [
				{ role: "system", content: systemMessage },
				{ placeholder: "chat_history" },
			],
		}),
	);
	const sourceFields = sourceFieldsForConfig(config);
	const instructionHash = sha256Hex(
		canonicalJson({
			agent: input.agent ?? {},
			sourceFields,
			systemMessage,
			appendedUserMessage,
			runtime: input.runtime ?? {},
			preset: latestPresetVersion
				? {
						id: input.preset?.id,
						version: latestPresetVersion.version,
						templateHash: latestPresetVersion.templateHash,
					}
				: null,
		}),
	);

	return {
		audit: {
			agentId: input.agent?.id ?? undefined,
			agentSlug: input.agent?.slug ?? undefined,
			agentName: input.agent?.name ?? undefined,
			agentVersion: input.agent?.version ?? null,
			configHash: input.agent?.configHash ?? null,
			canonicalTemplateName: CANONICAL_BUNDLE_TEMPLATE_NAME,
			canonicalTemplateHash,
			instructionHash,
			presetId: input.preset?.id,
			presetName: input.preset?.name,
			presetVersion: latestPresetVersion?.version,
			presetTemplateHash: latestPresetVersion?.templateHash,
			templateFormat: "mustache",
			sourceFields,
		},
		presetMessages,
		systemMessage,
		chatHistoryPlaceholder: "chat_history",
		appendedUserMessage,
		appendedUserVariables,
		warnings,
		variableCategories,
		sources: buildSources(input, sourceFields),
	};
}

export function applyPromptPresetToConfig(
	config: AgentConfig,
	preset: PromptPresetSummary,
): AgentConfig {
	const patch = agentConfigPatchFromPreset(preset);
	return { ...config, ...patch };
}

export function agentConfigPatchFromPreset(
	preset: PromptPresetSummary,
): Partial<AgentConfig> {
	const patch = preset.latestVersion?.metadata?.agentConfigPatch;
	if (patch && typeof patch === "object" && !Array.isArray(patch)) {
		return cleanPersonaPatch(patch as Record<string, unknown>);
	}

	const messages = preset.latestVersion?.messages ?? [];
	const firstSystem = messages.find((message) => message.role === "system");
	const firstUser = messages.find((message) => message.role === "user");
	const fallback: Partial<AgentConfig> = {};
	const systemText = firstSystem?.content.trim();
	const userText = firstUser?.content.trim();
	if (systemText && userText) {
		fallback.systemPrompt = `${systemText}\n\n${userText}`;
	} else if (systemText) {
		fallback.systemPrompt = systemText;
	} else if (userText) {
		fallback.systemPrompt = userText;
	}
	return fallback;
}

export function createPresetPayloadFromConfig(input: {
	name: string;
	description?: string | null;
	config: AgentConfig;
	arguments?: PromptArgumentDefinition[];
	metadata?: Record<string, unknown>;
}): {
	name: string;
	description: string | null;
	messages: PromptTemplateMessage[];
	arguments: PromptArgumentDefinition[];
	templateFormat: "mustache";
	metadata: Record<string, unknown>;
} {
	const personaPatch = cleanPersonaPatch(input.config as Record<string, unknown>);
	const content = renderInstructionSystemText({ persona: personaPatch, runtime: {} });
	return {
		name: input.name,
		description: input.description ?? null,
		messages: [{ role: "system", content }],
		arguments: input.arguments ?? [],
		templateFormat: "mustache",
		metadata: {
			...(input.metadata ?? {}),
			agentConfigPatch: personaPatch,
		},
	};
}

export function templateHash(input: {
	messages: PromptTemplateMessage[];
	arguments?: PromptArgumentDefinition[];
	templateFormat?: "mustache";
}): string {
	return sha256Hex(
		canonicalJson({
			templateFormat: input.templateFormat ?? "mustache",
			arguments: input.arguments ?? [],
			messages: input.messages,
		}),
	);
}

function cleanPersonaPatch(
	value: Record<string, unknown>,
): Partial<AgentConfig> {
	const patch: Partial<AgentConfig> = {};
	const text = textValue(value.systemPrompt);
	if (text) patch.systemPrompt = text;
	return patch;
}

function sourceFieldsForConfig(config: AgentConfig | Record<string, unknown>): string[] {
	const fields: string[] = [];
	if (textValue((config as Record<string, unknown>).systemPrompt)) {
		fields.push("persona.systemPrompt");
	}
	return fields;
}

function buildSources(
	input: PromptPreviewInput,
	sourceFields: string[],
): Array<{ label: string; value: string }> {
	const sources = sourceFields.map((field) => ({
		label: field,
		value: input.agent?.id ?? "unsaved agent config",
	}));
	if (input.runtime?.cwd) sources.push({ label: "runtime.cwd", value: input.runtime.cwd });
	if (input.runtime?.sandboxName) {
		sources.push({ label: "runtime.sandboxName", value: input.runtime.sandboxName });
	}
	if (input.preset?.latestVersion) {
		sources.push({
			label: "promptPreset",
			value: `${input.preset.name} v${input.preset.latestVersion.version}`,
		});
	}
	sources.push({
		label: "user.prompt",
		value: input.workflow?.id ? "workflow-node" : "session",
	});
	return sources;
}

export function buildPromptVariableCategories(
	input: PromptPreviewInput,
): PromptVariableCategory[] {
	const agent = input.agent ?? {};
	const runtime = input.runtime ?? {};
	const workflow = input.workflow ?? {};
	const session = input.session ?? {};
	const presetArgs = input.preset?.latestVersion?.arguments ?? [];
	return [
		{
			id: "agent",
			label: "Agent",
			variables: [
				variable("agent.name", "Name", agent.name ?? "Code Reviewer"),
				variable("agent.slug", "Slug", agent.slug ?? "code-reviewer"),
				variable("agent.id", "ID", agent.id ?? "agent_preview"),
				variable("agent.version", "Version", agent.version ?? "1"),
				variable("agent.configHash", "Config hash", agent.configHash ?? "preview-config-hash"),
			],
		},
		{
			id: "runtime",
			label: "Runtime",
			variables: [
				variable("runtime.cwd", "cwd", runtime.cwd ?? "/sandbox"),
				variable("runtime.sandboxName", "Sandbox", runtime.sandboxName ?? "preview-sandbox"),
				variable("runtime.environment", "Environment", runtime.environment ?? "default"),
				variable(
					"runtime.skills",
					"Skills",
					(runtime.skills ?? ["reviewer", "shell"]).join(", "),
				),
			],
		},
		{
			id: "workflow",
			label: "Workflow Node",
			variables: [
				variable("workflow.nodePrompt", "Node prompt", workflow.nodePrompt ?? "Review this change."),
				variable("workflow.id", "Workflow ID", workflow.id ?? "workflow_preview"),
				variable("workflow.name", "Workflow name", workflow.name ?? "Preview workflow"),
			],
		},
		{
			id: "session",
			label: "Session / Run",
			variables: [
				variable("session.id", "Session ID", session.id ?? "session_preview"),
				variable("run.id", "Run ID", session.runId ?? "run_preview"),
			],
		},
		{
			id: "args",
			label: "Preset Arguments",
			variables: presetArgs.map((arg) =>
				variable(
					`args.${arg.name}`,
					arg.name,
					sampleForArgument(arg),
					arg.description,
				),
			),
		},
	].filter((category) => category.variables.length > 0);
}

function buildPreviewContext(
	input: PromptPreviewInput,
	categories: PromptVariableCategory[],
): RenderContext {
	const context: RenderContext = {
		agent: {
			name: input.agent?.name ?? "Code Reviewer",
			slug: input.agent?.slug ?? "code-reviewer",
			id: input.agent?.id ?? "agent_preview",
			version: input.agent?.version ?? 1,
			configHash: input.agent?.configHash ?? "preview-config-hash",
		},
		runtime: {
			cwd: input.runtime?.cwd ?? "/sandbox",
			sandboxName: input.runtime?.sandboxName ?? "preview-sandbox",
			environment: input.runtime?.environment ?? "default",
			skills: (input.runtime?.skills ?? ["reviewer", "shell"]).join(", "),
		},
		workflow: {
			nodePrompt: input.workflow?.nodePrompt ?? input.userPrompt ?? "Review this change.",
			id: input.workflow?.id ?? "workflow_preview",
			name: input.workflow?.name ?? "Preview workflow",
		},
		session: {
			id: input.session?.id ?? "session_preview",
		},
		run: {
			id: input.session?.runId ?? "run_preview",
		},
		args: {},
	};
	const args = context.args as Record<string, string>;
	const argCategory = categories.find((category) => category.id === "args");
	for (const item of argCategory?.variables ?? []) {
		const name = item.path.replace(/^args\./, "");
		args[name] = item.sample;
		context[name] = item.sample;
	}
	return context;
}

function variable(
	path: string,
	label: string,
	sample: unknown,
	description?: string,
): PromptVariable {
	return {
		path,
		placeholder: `{{${path}}}`,
		label,
		description,
		sample: String(sample ?? ""),
	};
}

function sampleForArgument(arg: PromptArgumentDefinition): string {
	if (/repo|repository/i.test(arg.name)) return "PittampalliOrg/workflow-builder";
	if (/path|cwd|dir/i.test(arg.name)) return "src/lib";
	if (/ticket|issue/i.test(arg.name)) return "WB-123";
	if (/name/i.test(arg.name)) return "Preview name";
	return arg.required ? `${arg.name}_value` : `sample_${arg.name}`;
}

function readPath(value: unknown, path: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (Object.hasOwn(record, path)) return record[path];
	let current: unknown = record;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function skillNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return null;
			const record = item as Record<string, unknown>;
			return (
				textValue(record.name) ??
				textValue(record.skillName) ??
				textValue(record.skill_name) ??
				textValue(record.slug)
			);
		})
		.filter((name): name is string => Boolean(name));
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
		.filter(Boolean);
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		)) {
			if (item !== undefined) out[key] = canonicalize(item);
		}
		return out;
	}
	return value;
}

const SHA256_K = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Hex(input: string): string {
	const bytes = new TextEncoder().encode(input);
	const bitLength = bytes.length * 8;
	const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
	view.setUint32(paddedLength - 4, bitLength >>> 0);

	let h0 = 0x6a09e667;
	let h1 = 0xbb67ae85;
	let h2 = 0x3c6ef372;
	let h3 = 0xa54ff53a;
	let h4 = 0x510e527f;
	let h5 = 0x9b05688c;
	let h6 = 0x1f83d9ab;
	let h7 = 0x5be0cd19;
	const w = new Uint32Array(64);

	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 64; i += 1) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}

		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;

		for (let i = 0; i < 64; i += 1) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
			const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (s0 + maj) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
		h5 = (h5 + f) >>> 0;
		h6 = (h6 + g) >>> 0;
		h7 = (h7 + h) >>> 0;
	}

	return [h0, h1, h2, h3, h4, h5, h6, h7]
		.map((part) => part.toString(16).padStart(8, "0"))
		.join("");
}

function rotr(value: number, amount: number): number {
	return (value >>> amount) | (value << (32 - amount));
}
