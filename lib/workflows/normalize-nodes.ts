type WorkflowNode = {
	id?: string;
	type?: string;
	data?: {
		type?: string;
		config?: Record<string, unknown>;
	};
};

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function coerceConfigValuesToUiStrings(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...config };
	for (const [k, v] of Object.entries(out)) {
		// Known string fields.
		if (k === "actionType" || k === "integrationId" || k === "auth") {
			continue;
		}

		if (typeof v === "string") continue;
		if (v === undefined || v === null) continue;

		if (typeof v === "number" || typeof v === "boolean") {
			out[k] = String(v);
			continue;
		}

		if (typeof v === "object") {
			try {
				out[k] = JSON.stringify(v);
			} catch {
				out[k] = String(v);
			}
			continue;
		}

		out[k] = String(v);
	}
	return out;
}

function normalizeSystemHttpRequestConfig(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...config };

	const endpoint =
		typeof out.endpoint === "string"
			? out.endpoint
			: typeof out.url === "string"
				? out.url
				: undefined;
	const httpMethod =
		typeof out.httpMethod === "string"
			? out.httpMethod
			: typeof out.method === "string"
				? out.method
				: undefined;
	const httpHeaders =
		out.httpHeaders !== undefined ? out.httpHeaders : out.headers;
	const httpBody = out.httpBody !== undefined ? out.httpBody : out.body;

	// Write canonical keys used by the UI + runtime.
	if (endpoint !== undefined) out.endpoint = endpoint;
	if (httpMethod !== undefined) out.httpMethod = httpMethod;
	if (httpHeaders !== undefined) out.httpHeaders = httpHeaders;
	if (httpBody !== undefined) out.httpBody = httpBody;

	// Keep legacy keys too (harmless because runtime schemas strip unknown keys).
	if (out.url === undefined && typeof endpoint === "string") out.url = endpoint;
	if (out.method === undefined && typeof httpMethod === "string")
		out.method = httpMethod;
	if (out.headers === undefined && httpHeaders !== undefined)
		out.headers = httpHeaders;
	if (out.body === undefined && httpBody !== undefined) out.body = httpBody;

	return out;
}

export function normalizeWorkflowNodes<T>(nodes: T): T {
	if (!Array.isArray(nodes)) return nodes;

	const mapped = nodes.map((node) => {
		if (!isObject(node)) return node;
		const n = node as WorkflowNode;
		const data = n.data;
		if (!data || !isObject(data)) return node;

		const nodeType = data.type ?? n.type ?? "";
		if (nodeType !== "action" && n.type !== "action") return node;

		const config = data.config;
		if (!config || !isObject(config)) return node;

		// Keep UI stable: config renderers expect string values for most fields.
		// Runtime will parse JSON strings when needed.
		let nextConfig = coerceConfigValuesToUiStrings(config);

		const actionType =
			typeof nextConfig.actionType === "string" ? nextConfig.actionType : "";
		if (actionType === "system/http-request") {
			nextConfig = normalizeSystemHttpRequestConfig(nextConfig);
		}

		return {
			...node,
			data: {
				...data,
				config: nextConfig,
			},
		};
	});
	return mapped as unknown as T;
}
