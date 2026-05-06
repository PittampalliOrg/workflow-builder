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
	for (const [key, value] of Object.entries(out)) {
		if (key === "actionType" || key === "integrationId" || key === "auth") {
			continue;
		}
		if (typeof value === "string" || value === undefined || value === null) {
			continue;
		}
		if (typeof value === "number" || typeof value === "boolean") {
			out[key] = String(value);
			continue;
		}
		if (typeof value === "object") {
			try {
				out[key] = JSON.stringify(value);
			} catch {
				out[key] = String(value);
			}
			continue;
		}
		out[key] = String(value);
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

	if (endpoint !== undefined) out.endpoint = endpoint;
	if (httpMethod !== undefined) out.httpMethod = httpMethod;
	if (httpHeaders !== undefined) out.httpHeaders = httpHeaders;
	if (httpBody !== undefined) out.httpBody = httpBody;
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

	return nodes.map((node) => {
		if (!isObject(node)) return node;
		const current = node as WorkflowNode;
		const data = current.data;
		if (!data || !isObject(data)) return node;

		const nodeType = data.type ?? current.type ?? "";
		if (nodeType !== "action" && current.type !== "action") return node;

		const config = data.config;
		if (!config || !isObject(config)) return node;

		let nextConfig = coerceConfigValuesToUiStrings(config);
		if (nextConfig.actionType === "system/http-request") {
			nextConfig = normalizeSystemHttpRequestConfig(nextConfig);
		}

		return {
			...node,
			data: {
				...data,
				config: nextConfig,
			},
		};
	}) as unknown as T;
}
