export const DEFAULT_EXPOSED_TOOLS = Object.freeze([
	"agent_browser_open",
	"agent_browser_snapshot",
	"agent_browser_click",
	"agent_browser_fill",
	"agent_browser_type",
	"agent_browser_press",
	"agent_browser_hover",
	"agent_browser_select",
	"agent_browser_highlight",
	"agent_browser_scroll",
	"agent_browser_back",
	"agent_browser_wait_for_selector",
	"agent_browser_wait_for_load",
	"agent_browser_screenshot",
	"agent_browser_get_text",
	"agent_browser_get_url",
	"agent_browser_get_title",
	"agent_browser_pdf",
	"agent_browser_console",
	"agent_browser_errors",
	"agent_browser_close",
]);

const EXTERNAL_TOOL_ARGUMENT_KEYS = Object.freeze({
	agent_browser_open: ["url"],
	agent_browser_snapshot: ["interactive", "compact", "depth"],
	agent_browser_click: ["selector"],
	agent_browser_fill: ["selector", "text"],
	agent_browser_type: ["selector", "text"],
	agent_browser_press: ["key"],
	agent_browser_hover: ["selector"],
	agent_browser_select: ["selector", "value"],
	agent_browser_highlight: ["selector"],
	agent_browser_scroll: ["selector", "direction", "amount"],
	agent_browser_back: [],
	agent_browser_wait_for_selector: ["selector", "state", "timeoutMs"],
	agent_browser_wait_for_load: ["state", "timeoutMs"],
	agent_browser_screenshot: ["selector", "fullPage", "format", "quality"],
	agent_browser_get_text: ["selector"],
	agent_browser_get_url: [],
	agent_browser_get_title: [],
	agent_browser_pdf: ["format"],
	agent_browser_console: [],
	agent_browser_errors: [],
	agent_browser_close: [],
});

/** Operator configuration may narrow, but never broaden, the public surface. */
export function resolveExposedTools(configured) {
	const requested = String(configured ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	const selected = requested.length ? requested : DEFAULT_EXPOSED_TOOLS;
	const curated = new Set(DEFAULT_EXPOSED_TOOLS);
	return [...new Set(selected.filter((name) => curated.has(name)))];
}

export function isExternallyCallableTool(name, exposedTools, bridgeTools = []) {
	return exposedTools.includes(name) || bridgeTools.includes(name);
}

export function sanitizeAllowlistedArguments(args, allowedKeys) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return {};
	const sanitized = {};
	for (const key of allowedKeys) {
		if (Object.hasOwn(args, key)) sanitized[key] = args[key];
	}
	return sanitized;
}

/** Rebuild external call arguments without child-owned session plumbing. */
export function sanitizeExternalToolArguments(name, args) {
	return sanitizeAllowlistedArguments(
		args,
		EXTERNAL_TOOL_ARGUMENT_KEYS[name] ?? [],
	);
}

/** Show exactly the same argument surface that tools/call accepts. */
export function pruneExternalToolDefinition(tool) {
	const schema = tool?.inputSchema ?? {};
	const allowed = new Set(EXTERNAL_TOOL_ARGUMENT_KEYS[tool?.name] ?? []);
	const properties = Object.fromEntries(
		Object.entries(schema.properties ?? {}).filter(([key]) => allowed.has(key)),
	);
	const required = (schema.required ?? []).filter((key) => allowed.has(key));
	return {
		...tool,
		inputSchema: {
			type: "object",
			properties,
			...(required.length ? { required } : {}),
			additionalProperties: false,
		},
	};
}

export function inlineImage(result) {
	const image = (result?.content || []).find(
		(part) =>
			part &&
			part.type === "image" &&
			typeof part.data === "string" &&
			part.data.length > 0,
	);
	return image
		? { data: image.data, mime: image.mimeType || "image/png" }
		: null;
}

/** Keep MCP image blocks structured so a vision-capable model receives pixels. */
export function preserveMultimodalToolResult(result) {
	return result;
}
