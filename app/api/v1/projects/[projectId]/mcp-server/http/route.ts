import { resolveInternalMcpGatewayBaseUrl } from "@/lib/mcp-gateway/url";

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
]);

function forwardHeaders(headers: Headers): Headers {
	const out = new Headers();
	for (const [key, value] of headers.entries()) {
		if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
			continue;
		}
		out.set(key, value);
	}
	return out;
}

function buildGatewayUrl(projectId: string): string {
	const base = resolveInternalMcpGatewayBaseUrl();
	return `${base}/api/v1/projects/${encodeURIComponent(projectId)}/mcp-server/http`;
}

async function proxy(
	request: Request,
	projectId: string,
	method: "POST" | "OPTIONS",
): Promise<Response> {
	const body =
		method === "POST" ? await request.arrayBuffer().catch(() => null) : null;
	const response = await fetch(buildGatewayUrl(projectId), {
		method,
		headers: forwardHeaders(request.headers),
		body,
	});

	return new Response(response.body, {
		status: response.status,
		headers: forwardHeaders(response.headers),
	});
}

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	const { projectId } = await params;
	return proxy(request, projectId, "POST");
}

export async function OPTIONS(
	request: Request,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	const { projectId } = await params;
	return proxy(request, projectId, "OPTIONS");
}
