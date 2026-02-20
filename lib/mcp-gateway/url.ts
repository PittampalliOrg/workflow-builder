const MCP_GATEWAY_PATH_TEMPLATE =
	"/api/v1/projects/%PROJECT_ID%/mcp-server/http";

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	return trimTrailingSlash(trimmed);
}

export function resolvePublicMcpGatewayBaseUrl(params?: {
	request?: Request;
	fallbackOrigin?: string;
}): string | null {
	const explicit =
		normalizeBaseUrl(process.env.MCP_GATEWAY_BASE_URL) ??
		normalizeBaseUrl(process.env.NEXT_PUBLIC_MCP_GATEWAY_BASE_URL) ??
		normalizeBaseUrl(process.env.NEXT_PUBLIC_APP_URL);
	if (explicit) {
		return explicit;
	}

	const fallback =
		normalizeBaseUrl(params?.fallbackOrigin) ??
		(params?.request ? new URL(params.request.url).origin : null);
	return fallback ? trimTrailingSlash(fallback) : null;
}

export function buildHostedMcpServerUrl(
	projectId: string,
	params?: {
		request?: Request;
		fallbackOrigin?: string;
	},
): string | null {
	const baseUrl = resolvePublicMcpGatewayBaseUrl(params);
	if (!baseUrl) {
		return null;
	}
	return `${baseUrl}${MCP_GATEWAY_PATH_TEMPLATE.replace(
		"%PROJECT_ID%",
		encodeURIComponent(projectId),
	)}`;
}

export function resolveInternalMcpGatewayBaseUrl(): string {
	return (
		normalizeBaseUrl(process.env.MCP_GATEWAY_INTERNAL_URL) ??
		"http://mcp-gateway.workflow-builder.svc.cluster.local:8080"
	);
}
