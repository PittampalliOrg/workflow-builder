/**
 * Minimal streamable-http MCP client that talks to the per-agent
 * playwright-mcp sidecar via the in-cluster Service DNS. Used by the
 * Browser state panel to fetch screenshots, URL + title, and console
 * messages on behalf of the signed-in user.
 *
 * The MCP server sits at:
 *   http://agent-runtime-<slug>-mcp.<ns>.svc.cluster.local:3100/mcp
 *
 * MCP sessions are initialized once and cached for ~60s — the
 * per-tool-call initialize handshake otherwise doubles every poll's
 * wall-clock cost.
 */

const DEFAULT_AGENT_RUNTIME_NAMESPACE =
	process.env.AGENT_RUNTIME_NAMESPACE ?? 'openshell';

const SESSION_TTL_MS = 60_000;

type CachedSession = { sessionId: string; expiresAt: number };
const sessionCache = new Map<string, CachedSession>();

function mcpOrigin(slug: string): string {
	return `http://agent-runtime-${slug}-mcp.${DEFAULT_AGENT_RUNTIME_NAMESPACE}.svc.cluster.local:3100`;
}

async function postMcp(
	slug: string,
	body: unknown,
	sessionId?: string,
): Promise<{ sessionId?: string; text: string; status: number }> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
	};
	if (sessionId) headers['Mcp-Session-Id'] = sessionId;
	const res = await fetch(`${mcpOrigin(slug)}/mcp`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
	const text = await res.text();
	return {
		sessionId: res.headers.get('mcp-session-id') ?? undefined,
		text,
		status: res.status,
	};
}

/** Extract the `data: {...}` JSON payload from an SSE response. */
function parseSse(text: string): Record<string, unknown> | null {
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith('data:')) {
			try {
				return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
			} catch {
				return null;
			}
		}
	}
	return null;
}

async function initializeSession(slug: string): Promise<string> {
	const cached = sessionCache.get(slug);
	if (cached && cached.expiresAt > Date.now()) return cached.sessionId;

	const init = await postMcp(slug, {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-03-26',
			capabilities: {},
			clientInfo: { name: 'workflow-builder-bff', version: '1' },
		},
	});
	if (init.status !== 200 || !init.sessionId) {
		throw new Error(`MCP initialize failed for ${slug}: ${init.status}`);
	}
	// Fire-and-forget the initialized notification; don't wait for the
	// body.
	await postMcp(
		slug,
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		init.sessionId,
	);
	sessionCache.set(slug, { sessionId: init.sessionId, expiresAt: Date.now() + SESSION_TTL_MS });
	return init.sessionId;
}

async function callTool(
	slug: string,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
	const sessionId = await initializeSession(slug);
	const res = await postMcp(
		slug,
		{ jsonrpc: '2.0', id: Date.now() & 0xffff, method: 'tools/call', params: { name, arguments: args } },
		sessionId,
	);
	if (res.status === 404 || res.status === 400) {
		// Session expired server-side — drop the cache and retry once.
		sessionCache.delete(slug);
		const retrySessionId = await initializeSession(slug);
		const retry = await postMcp(
			slug,
			{ jsonrpc: '2.0', id: Date.now() & 0xffff, method: 'tools/call', params: { name, arguments: args } },
			retrySessionId,
		);
		return parseSse(retry.text);
	}
	return parseSse(res.text);
}

export type BrowserScreenshotResult = {
	jpeg: Buffer;
	/** Page URL and title if the caller also wants metadata. */
	pageUrl?: string;
	pageTitle?: string;
};

/** Returns a JPEG screenshot of the agent's current page. */
export async function takeScreenshot(slug: string): Promise<BrowserScreenshotResult | null> {
	const env = await callTool(slug, 'browser_take_screenshot', { type: 'jpeg' });
	if (!env) return null;
	const result = (env as { result?: { content?: Array<{ type?: string; data?: string }> } }).result;
	const part = result?.content?.find((c) => c?.type === 'image' && typeof c.data === 'string');
	if (!part?.data) return null;
	return { jpeg: Buffer.from(part.data, 'base64') };
}

export type BrowserStateResult = {
	pageUrl: string | null;
	pageTitle: string | null;
	consoleTail: Array<{ level: string; text: string }>;
};

/** Returns page URL + title (parsed from snapshot) and a short console tail. */
export async function getBrowserState(slug: string): Promise<BrowserStateResult | null> {
	// Minimal snapshot so we can grab URL + title cheaply. depth=1 keeps
	// the tree small (no per-element serialization).
	const snap = await callTool(slug, 'browser_snapshot', { depth: 1 });
	let pageUrl: string | null = null;
	let pageTitle: string | null = null;
	if (snap) {
		const text = extractToolText(snap);
		pageUrl = matchLine(text, /^-\s+Page URL:\s*(.+)$/m);
		pageTitle = matchLine(text, /^-\s+Page Title:\s*(.+)$/m);
	}

	const consoleTail: Array<{ level: string; text: string }> = [];
	const console = await callTool(slug, 'browser_console_messages', { level: 'info' });
	if (console) {
		const text = extractToolText(console);
		const lines = text.split(/\r?\n/);
		for (const line of lines.slice(-20)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('###')) continue;
			const m = trimmed.match(/^\[(\w+)\]\s+(.*)$/);
			if (m) consoleTail.push({ level: m[1].toLowerCase(), text: m[2] });
			else consoleTail.push({ level: 'info', text: trimmed });
		}
	}

	return { pageUrl, pageTitle, consoleTail };
}

function extractToolText(envelope: Record<string, unknown>): string {
	const result = (envelope as { result?: { content?: Array<{ type?: string; text?: string }> } }).result;
	const parts = result?.content ?? [];
	return parts
		.filter((p) => p?.type === 'text' && typeof p.text === 'string')
		.map((p) => p.text as string)
		.join('\n');
}

function matchLine(text: string, re: RegExp): string | null {
	const m = text.match(re);
	return m ? m[1].trim() : null;
}
