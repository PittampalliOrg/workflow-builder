export const INSTRUCTION_BUNDLE_SCHEMA_VERSION =
	"workflow-builder.instruction-bundle.v1";

export const CANONICAL_BUNDLE_TEMPLATE_NAME =
	"workflow-builder canonical bundle";

/**
 * Sentinel marking the split between the static (cacheable) prefix and the
 * dynamic per-turn tail in `rendered.system`. The Python anthropic adapter
 * looks for this string and, when found above its size threshold, builds a
 * sectioned `system: list[TextBlockParam]` with cache_control on the static
 * block. Mirrors claude-code-src/main/constants/prompts.ts:114-115.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

export type InstructionPersonaPreview = {
	systemPrompt?: unknown;
};

export type InstructionRuntimePreview = {
	cwd?: unknown;
	sandboxName?: unknown;
	skills?: unknown;
	hookContext?: unknown;
	platformSystemSections?: unknown;
	currentDate?: unknown;
	mcpInstructions?: unknown;
	compiledStaticPresetSections?: unknown;
	compiledDynamicPresetSections?: unknown;
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

function pushSection(parts: string[], title: string, body: string | string[]): void {
	const lines = Array.isArray(body)
		? body.map((line) => line.trim()).filter(Boolean)
		: [body.trim()].filter(Boolean);
	if (lines.length === 0) return;
	parts.push(`## ${title}\n${lines.join("\n")}`);
}

function renderStaticSections(input: {
	persona?: InstructionPersonaPreview | null;
	runtime?: InstructionRuntimePreview | null;
}): string[] {
	const persona = input.persona ?? {};
	const runtime = input.runtime ?? {};
	const parts: string[] = [];

	for (const section of cleanStringList(runtime.platformSystemSections)) {
		parts.push(section);
	}

	for (const section of cleanStringList(runtime.compiledStaticPresetSections)) {
		parts.push(section);
	}

	const systemPrompt = cleanString(persona.systemPrompt);
	if (systemPrompt) parts.push(systemPrompt);

	return parts;
}

function renderDynamicSections(input: {
	persona?: InstructionPersonaPreview | null;
	runtime?: InstructionRuntimePreview | null;
}): string[] {
	const runtime = input.runtime ?? {};
	const parts: string[] = [];

	for (const section of cleanStringList(runtime.compiledDynamicPresetSections)) {
		parts.push(section);
	}

	const runtimeLines: string[] = [];
	const cwd = cleanString(runtime.cwd);
	if (cwd) runtimeLines.push(`Working directory: ${cwd}`);
	const sandboxName = cleanString(runtime.sandboxName);
	if (sandboxName) runtimeLines.push(`OpenShell sandbox: ${sandboxName}`);
	const skills = cleanStringList(runtime.skills);
	if (skills.length) runtimeLines.push(`Configured skills: ${skills.join(", ")}`);
	pushSection(parts, "Runtime Context", runtimeLines);

	const hookContext = cleanString(runtime.hookContext);
	if (hookContext) pushSection(parts, "Hook Context", hookContext);

	const currentDate = cleanString(runtime.currentDate);
	if (currentDate) pushSection(parts, "Current Date", currentDate);

	const mcpInstructions = cleanStringList(runtime.mcpInstructions);
	if (mcpInstructions.length) {
		pushSection(parts, "MCP Server Instructions", mcpInstructions);
	}

	return parts;
}

export function renderInstructionSystemText(input: {
	persona?: InstructionPersonaPreview | null;
	runtime?: InstructionRuntimePreview | null;
}): string {
	const staticParts = renderStaticSections(input);
	const dynamicParts = renderDynamicSections(input);

	const staticText = staticParts.filter(Boolean).join("\n\n").trim();
	const dynamicText = dynamicParts.filter(Boolean).join("\n\n").trim();

	if (staticText && dynamicText) {
		return `${staticText}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${dynamicText}`;
	}
	return staticText || dynamicText;
}

export function buildOpenShellSystemPrompt(
	cwd: string = "/sandbox",
	sandboxName?: string | null,
): string {
	const envLines = [`Working directory: ${cwd || "/sandbox"}`];
	if (sandboxName?.trim()) envLines.push(`OpenShell sandbox: ${sandboxName.trim()}`);
	const envBlock = envLines.join("\n");

	return `You are dapr-agent-py, a Dapr DurableAgent that works inside an OpenShell sandbox.

<env>
${envBlock}
</env>

All file and command tools operate inside the active OpenShell sandbox, not inside the agent service container.

IMPORTANT -- Working directory:
- Your working directory is shown in the <env> block above.
- All tools resolve relative paths against the working directory. Use RELATIVE paths (e.g. "package.json", "src/app.html") — they automatically resolve to the correct location.
- Do NOT prefix paths with /sandbox/ — just use relative paths from the working directory.
- bash_run commands also execute in the working directory automatically.
- Treat /app as service implementation, not as a user workspace.

The sandbox is policy-governed, so filesystem and network access may be restricted. If a command fails, inspect the concise error and repair the smallest relevant issue before retrying.
`;
}
