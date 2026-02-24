import { type NextRequest, NextResponse } from "next/server";

/**
 * Proxy requests to the AIO sandbox pod.
 * /api/sandbox-aio/{podIp}/{rest...} → http://{podIp}:8080/{rest...}
 */

const AIO_PORT = 8080;

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ ip: string; path: string[] }> },
) {
	const { ip, path } = await params;
	return proxyToSandbox(request, ip, path);
}

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ ip: string; path: string[] }> },
) {
	const { ip, path } = await params;
	return proxyToSandbox(request, ip, path);
}

export async function PUT(
	request: NextRequest,
	{ params }: { params: Promise<{ ip: string; path: string[] }> },
) {
	const { ip, path } = await params;
	return proxyToSandbox(request, ip, path);
}

export async function DELETE(
	request: NextRequest,
	{ params }: { params: Promise<{ ip: string; path: string[] }> },
) {
	const { ip, path } = await params;
	return proxyToSandbox(request, ip, path);
}

async function proxyToSandbox(
	request: NextRequest,
	ip: string,
	pathSegments: string[],
) {
	// Validate IP format (basic check)
	if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
		return NextResponse.json({ error: "Invalid IP" }, { status: 400 });
	}

	const restPath = pathSegments.join("/");
	const url = new URL(request.url);
	const queryString = url.search;
	const targetUrl = `http://${ip}:${AIO_PORT}/${restPath}${queryString}`;

	try {
		const headers = new Headers();
		// Forward select headers
		for (const key of ["content-type", "accept", "authorization"]) {
			const val = request.headers.get(key);
			if (val) headers.set(key, val);
		}

		const fetchOptions: RequestInit = {
			method: request.method,
			headers,
		};

		if (request.method !== "GET" && request.method !== "HEAD") {
			fetchOptions.body = request.body;
			// @ts-expect-error -- Node fetch supports duplex
			fetchOptions.duplex = "half";
		}

		const upstream = await fetch(targetUrl, fetchOptions);

		// Stream response back
		const responseHeaders = new Headers();
		for (const [key, value] of upstream.headers.entries()) {
			// Skip hop-by-hop headers
			if (
				["transfer-encoding", "connection", "keep-alive"].includes(
					key.toLowerCase(),
				)
			) {
				continue;
			}
			responseHeaders.set(key, value);
		}

		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders,
		});
	} catch (err: any) {
		console.error(`[sandbox-aio proxy] ${targetUrl}:`, err.message);
		return NextResponse.json(
			{ error: "Sandbox proxy error", details: err.message },
			{ status: 502 },
		);
	}
}
