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

export function inlineImage(result) {
	const image = (result?.content || []).find(
		(part) =>
			part && part.type === "image" && typeof part.data === "string" && part.data.length > 0,
	);
	return image ? { data: image.data, mime: image.mimeType || "image/png" } : null;
}

/** Keep MCP image blocks structured so a vision-capable model receives pixels. */
export function preserveMultimodalToolResult(result) {
	return result;
}
