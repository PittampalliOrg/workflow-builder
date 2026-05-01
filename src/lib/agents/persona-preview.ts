function cleanString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
		.filter(Boolean);
}

function pushSection(parts: string[], title: string, value: string | string[]): void {
	const lines = Array.isArray(value)
		? value.map((line) => line.trim()).filter(Boolean)
		: [value.trim()].filter(Boolean);
	if (lines.length > 0) parts.push(`## ${title}\n${lines.join("\n")}`);
}

export function formatAgentPersonaPreview(config: Record<string, unknown>): string {
	const parts: string[] = [];
	const systemPrompt = cleanString(config.systemPrompt);
	if (systemPrompt) pushSection(parts, "System Prompt", systemPrompt);

	const role = cleanString(config.role);
	if (role) pushSection(parts, "Role", role);

	const goal = cleanString(config.goal);
	if (goal) pushSection(parts, "Goal", goal);

	const instructions = cleanStringList(config.instructions);
	if (instructions.length) {
		pushSection(
			parts,
			"Instructions",
			instructions.map((item) => `- ${item}`),
		);
	}

	const style = cleanStringList(config.styleGuidelines);
	if (style.length) {
		pushSection(
			parts,
			"Style",
			style.map((item) => `- ${item}`),
		);
	}

	return parts.join("\n\n").trim();
}
