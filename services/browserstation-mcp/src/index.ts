import "./otel.js";

import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import puppeteer, {
	type Browser,
	type ElementHandle,
	type Page,
} from "puppeteer-core";
import { z } from "zod";

const PORT = Number.parseInt(process.env.PORT || "3101", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BROWSERSTATION_BASE_URL = trimTrailingSlash(
	process.env.BROWSERSTATION_BASE_URL ||
		"http://browserstation.ray-system.svc.cluster.local:8050",
);
const BROWSERSTATION_API_KEY = process.env.BROWSERSTATION_API_KEY || "";
const BROWSERSTATION_REQUEST_TIMEOUT_MS = Number.parseInt(
	process.env.BROWSERSTATION_REQUEST_TIMEOUT_MS || "30000",
	10,
);
const BROWSERSTATION_READY_TIMEOUT_MS = Number.parseInt(
	process.env.BROWSERSTATION_READY_TIMEOUT_MS || "45000",
	10,
);
const IDLE_TTL_MS = Number.parseInt(
	process.env.BROWSERSTATION_IDLE_TTL_MS || "900000",
	10,
);
const CLEANUP_INTERVAL_MS = Number.parseInt(
	process.env.BROWSERSTATION_CLEANUP_INTERVAL_MS || "30000",
	10,
);
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HTTP_BASE_URL = trimTrailingSlash(
	process.env.DAPR_HTTP_BASE_URL || `http://127.0.0.1:${DAPR_HTTP_PORT}`,
);
const BROWSERSTATION_MCP_STATESTORE = (
	process.env.BROWSERSTATION_MCP_STATESTORE || ""
).trim();

const HANDLE_INDEX_KEY = "browserstation-mcp:handles";
const HANDLE_KEY_PREFIX = "browserstation-mcp:handle:";
const IDEMPOTENCY_KEY_PREFIX = "browserstation-mcp:idempotency:";

type JsonRecord = Record<string, unknown>;

type BrowserstationCreateResponse = {
	browser_id: string;
	proxy_url?: string;
};

type BrowserstationBrowserInfo = {
	browser_id: string;
	pod_ip: string;
	websocket_url?: string | null;
	chrome_ready: boolean;
};

type HandleRecord = {
	sessionHandle: string;
	browserId: string;
	ownerKey: string;
	idempotencyKey?: string;
	initialUrl?: string;
	createdAt: number;
	lastUsedAt: number;
};

type BrowserActionArgs = {
	session_handle: string;
	timeout_ms?: number;
};

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function now(): number {
	return Date.now();
}

function stateStoreEnabled(): boolean {
	return BROWSERSTATION_MCP_STATESTORE.length > 0;
}

function ensureStateStoreConfigured(): void {
	if (!stateStoreEnabled()) {
		throw new Error(
			"BROWSERSTATION_MCP_STATESTORE is required for stateless browserstation-mcp",
		);
	}
}

function handleKey(sessionHandle: string): string {
	return `${HANDLE_KEY_PREFIX}${sessionHandle}`;
}

function idempotencyKey(ownerKey: string, key: string): string {
	return `${IDEMPOTENCY_KEY_PREFIX}${encodeURIComponent(ownerKey)}:${encodeURIComponent(key)}`;
}

function sendJson(
	res: http.ServerResponse,
	status: number,
	data: unknown,
): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

function setCorsHeaders(res: http.ServerResponse): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "*");
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				const body = Buffer.concat(chunks).toString("utf-8");
				resolve(body ? JSON.parse(body) : undefined);
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

function textResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

function errorResult(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
	};
}

async function loadStateJson<T>(key: string): Promise<T | null> {
	ensureStateStoreConfigured();
	const response = await fetch(
		`${DAPR_HTTP_BASE_URL}/v1.0/state/${encodeURIComponent(BROWSERSTATION_MCP_STATESTORE)}/${encodeURIComponent(key)}`,
		{
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(BROWSERSTATION_REQUEST_TIMEOUT_MS),
		},
	);
	if (response.status === 204 || response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw new Error(`State GET failed (${response.status})`);
	}
	const text = await response.text();
	if (!text.trim()) {
		return null;
	}
	return JSON.parse(text) as T;
}

async function saveStateJson(key: string, value: unknown): Promise<void> {
	ensureStateStoreConfigured();
	const response = await fetch(
		`${DAPR_HTTP_BASE_URL}/v1.0/state/${encodeURIComponent(BROWSERSTATION_MCP_STATESTORE)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([{ key, value }]),
			signal: AbortSignal.timeout(BROWSERSTATION_REQUEST_TIMEOUT_MS),
		},
	);
	if (!response.ok) {
		throw new Error(`State POST failed (${response.status})`);
	}
}

async function deleteStateKey(key: string): Promise<void> {
	ensureStateStoreConfigured();
	const response = await fetch(
		`${DAPR_HTTP_BASE_URL}/v1.0/state/${encodeURIComponent(BROWSERSTATION_MCP_STATESTORE)}/${encodeURIComponent(key)}`,
		{
			method: "DELETE",
			signal: AbortSignal.timeout(BROWSERSTATION_REQUEST_TIMEOUT_MS),
		},
	);
	if (response.status === 404) {
		return;
	}
	if (!response.ok) {
		throw new Error(`State DELETE failed (${response.status})`);
	}
}

async function loadHandleIndex(): Promise<string[]> {
	const value = await loadStateJson<unknown>(HANDLE_INDEX_KEY);
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((entry) => String(entry || "").trim())
		.filter(Boolean);
}

async function saveHandleIndex(handles: string[]): Promise<void> {
	const uniqueHandles = [...new Set(handles.map((handle) => handle.trim()).filter(Boolean))];
	if (uniqueHandles.length === 0) {
		await deleteStateKey(HANDLE_INDEX_KEY);
		return;
	}
	await saveStateJson(HANDLE_INDEX_KEY, uniqueHandles);
}

async function addHandleToIndex(sessionHandle: string): Promise<void> {
	const handles = new Set(await loadHandleIndex());
	handles.add(sessionHandle);
	await saveHandleIndex([...handles]);
}

async function removeHandleFromIndex(sessionHandle: string): Promise<void> {
	const handles = new Set(await loadHandleIndex());
	handles.delete(sessionHandle);
	await saveHandleIndex([...handles]);
}

async function loadHandleRecord(
	sessionHandle: string,
): Promise<HandleRecord | null> {
	return loadStateJson<HandleRecord>(handleKey(sessionHandle));
}

async function saveHandleRecord(record: HandleRecord): Promise<void> {
	await saveStateJson(handleKey(record.sessionHandle), record);
	await addHandleToIndex(record.sessionHandle);
}

async function deleteHandleRecord(sessionHandle: string): Promise<void> {
	await deleteStateKey(handleKey(sessionHandle));
	await removeHandleFromIndex(sessionHandle);
}

async function loadHandleForIdempotency(
	ownerKey: string,
	key: string,
): Promise<string | null> {
	const value = await loadStateJson<unknown>(idempotencyKey(ownerKey, key));
	if (!value) {
		return null;
	}
	const sessionHandle = String(value).trim();
	return sessionHandle || null;
}

async function saveIdempotencyMapping(
	ownerKey: string,
	key: string,
	sessionHandle: string,
): Promise<void> {
	await saveStateJson(idempotencyKey(ownerKey, key), sessionHandle);
}

async function deleteIdempotencyMapping(
	ownerKey?: string,
	key?: string,
): Promise<void> {
	if (!ownerKey || !key) {
		return;
	}
	await deleteStateKey(idempotencyKey(ownerKey, key));
}

function browserstationHeaders(includeJson = false): HeadersInit {
	const headers: HeadersInit = {};
	if (BROWSERSTATION_API_KEY) {
		headers["X-API-Key"] = BROWSERSTATION_API_KEY;
	}
	if (includeJson) {
		headers["Content-Type"] = "application/json";
	}
	return headers;
}

async function browserstationRequest(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return fetch(`${BROWSERSTATION_BASE_URL}${path}`, {
		...init,
		headers: {
			...browserstationHeaders(init?.body !== undefined),
			...(init?.headers || {}),
		},
		signal: AbortSignal.timeout(BROWSERSTATION_REQUEST_TIMEOUT_MS),
	});
}

async function browserstationFetch<T>(
	path: string,
	init?: RequestInit,
): Promise<T> {
	const response = await browserstationRequest(path, init);
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Browserstation request failed (${response.status}): ${body || response.statusText}`,
		);
	}
	return (await response.json()) as T;
}

async function createBrowser(): Promise<BrowserstationCreateResponse> {
	return browserstationFetch<BrowserstationCreateResponse>("/browsers", {
		method: "POST",
		body: JSON.stringify({}),
	});
}

async function getBrowserInfo(
	browserId: string,
): Promise<BrowserstationBrowserInfo> {
	return browserstationFetch<BrowserstationBrowserInfo>(
		`/browsers/${encodeURIComponent(browserId)}`,
	);
}

async function getBrowserInfoMaybe(
	browserId: string,
): Promise<BrowserstationBrowserInfo | null> {
	const response = await browserstationRequest(
		`/browsers/${encodeURIComponent(browserId)}`,
	);
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Browserstation request failed (${response.status}): ${body || response.statusText}`,
		);
	}
	return (await response.json()) as BrowserstationBrowserInfo;
}

async function deleteBrowser(
	browserId: string,
	options?: { ignoreMissing?: boolean },
): Promise<void> {
	const response = await browserstationRequest(
		`/browsers/${encodeURIComponent(browserId)}`,
		{
			method: "DELETE",
		},
	);
	if (response.status === 404 && options?.ignoreMissing) {
		return;
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Browserstation request failed (${response.status}): ${body || response.statusText}`,
		);
	}
}

async function waitForBrowserReady(
	browserId: string,
	timeoutMs = BROWSERSTATION_READY_TIMEOUT_MS,
): Promise<BrowserstationBrowserInfo> {
	const started = now();
	let lastInfo: BrowserstationBrowserInfo | undefined;
	while (now() - started < timeoutMs) {
		lastInfo = await getBrowserInfo(browserId);
		if (lastInfo.chrome_ready && lastInfo.websocket_url) {
			return lastInfo;
		}
		await delay(1000);
	}
	throw new Error(
		`Browser ${browserId} did not become ready within ${timeoutMs}ms${lastInfo ? ` (chrome_ready=${String(lastInfo.chrome_ready)})` : ""}`,
	);
}

function toWebSocketUrl(pathOrUrl: string): string {
	if (pathOrUrl.startsWith("ws://") || pathOrUrl.startsWith("wss://")) {
		return pathOrUrl;
	}
	const base = new URL(BROWSERSTATION_BASE_URL);
	const protocol = base.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${base.host}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

async function connectBrowser(
	browserId: string,
): Promise<{ browser: Browser; page: Page }> {
	const info = await waitForBrowserReady(browserId);
	if (!info.websocket_url) {
		throw new Error(`Browser ${browserId} does not expose a websocket URL`);
	}
	const browser = await puppeteer.connect({
		browserWSEndpoint: toWebSocketUrl(info.websocket_url),
		protocolTimeout: BROWSERSTATION_REQUEST_TIMEOUT_MS,
		defaultViewport: null,
	});
	const pages = await browser.pages();
	const page = pages[0] ?? (await browser.newPage());
	return { browser, page };
}

async function withBrowserPage<T>(
	browserId: string,
	fn: (page: Page) => Promise<T>,
): Promise<T> {
	const { browser, page } = await connectBrowser(browserId);
	try {
		return await fn(page);
	} finally {
		browser.disconnect();
	}
}

async function touchHandle(record: HandleRecord): Promise<HandleRecord> {
	const updated = {
		...record,
		lastUsedAt: now(),
	};
	await saveHandleRecord(updated);
	return updated;
}

async function cleanupHandleRecord(
	record: HandleRecord,
	reason: string,
): Promise<void> {
	try {
		await deleteBrowser(record.browserId, { ignoreMissing: true });
	} catch (error) {
		console.warn(
			`[browserstation-mcp] failed to close browser ${record.browserId} during ${reason}:`,
			error,
		);
	}
	await deleteHandleRecord(record.sessionHandle);
	await deleteIdempotencyMapping(record.ownerKey, record.idempotencyKey);
}

async function findHandleByBrowserId(
	browserId: string,
): Promise<HandleRecord | null> {
	const handles = await loadHandleIndex();
	for (const sessionHandle of handles) {
		const record = await loadHandleRecord(sessionHandle);
		if (record?.browserId === browserId) {
			return record;
		}
	}
	return null;
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function pageSummary(page: Page): Promise<JsonRecord> {
	const summary = await page.evaluate(() => {
		const buttons = Array.from(
			document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']"),
		)
			.slice(0, 20)
			.map((element) => ({
				text: (element.textContent || (element as HTMLInputElement).value || "")
					.trim()
					.slice(0, 200),
			}))
			.filter((item) => item.text);

		const links = Array.from(document.querySelectorAll("a[href]"))
			.slice(0, 20)
			.map((element) => ({
				text: (element.textContent || "").trim().slice(0, 200),
				href: (element as HTMLAnchorElement).href,
			}))
			.filter((item) => item.href);

		const inputs = Array.from(
			document.querySelectorAll("input, textarea, select"),
		)
			.slice(0, 20)
			.map((element) => ({
				tag: element.tagName.toLowerCase(),
				type: (element as HTMLInputElement).type || "",
				name: (element.getAttribute("name") || "").slice(0, 100),
				placeholder: (element.getAttribute("placeholder") || "").slice(0, 200),
			}));

		return {
			title: document.title,
			url: window.location.href,
			textExcerpt: (document.body?.innerText || "").slice(0, 4000),
			buttons,
			links,
			inputs,
		};
	});

	return {
		title: typeof summary.title === "string" ? summary.title : "",
		url: typeof summary.url === "string" ? summary.url : "",
		text_excerpt:
			typeof summary.textExcerpt === "string"
				? normalizeWhitespace(summary.textExcerpt)
				: "",
		buttons: Array.isArray(summary.buttons) ? summary.buttons : [],
		links: Array.isArray(summary.links) ? summary.links : [],
		inputs: Array.isArray(summary.inputs) ? summary.inputs : [],
	};
}

async function waitForText(
	page: Page,
	text: string,
	timeoutMs: number,
): Promise<void> {
	await page.waitForFunction(
		(expectedText) => {
			const bodyText = document.body?.innerText || "";
			return bodyText.includes(expectedText);
		},
		{ timeout: timeoutMs },
		text,
	);
}

async function queryElementByText(
	page: Page,
	text: string,
	timeoutMs: number,
): Promise<ElementHandle<Element>> {
	await waitForText(page, text, timeoutMs);
	const handle = await page.evaluateHandle((expectedText) => {
		const walker = document.createTreeWalker(
			document.body,
			NodeFilter.SHOW_ELEMENT,
		);
		while (walker.nextNode()) {
			const element = walker.currentNode as HTMLElement;
			const content = (element.innerText || element.textContent || "").trim();
			if (!content) continue;
			if (content.includes(expectedText)) return element;
		}
		return null;
	}, text);
	const element = handle.asElement();
	if (!element) {
		await handle.dispose();
		throw new Error(`Could not find an element containing text "${text}"`);
	}
	return element as ElementHandle<Element>;
}

async function lookupElement(args: {
	page: Page;
	selector?: string;
	text?: string;
	timeoutMs: number;
}): Promise<ElementHandle<Element>> {
	if (args.selector) {
		const element = await args.page.waitForSelector(args.selector, {
			visible: true,
			timeout: args.timeoutMs,
		});
		if (!element) {
			throw new Error(`Selector not found: ${args.selector}`);
		}
		return element as ElementHandle<Element>;
	}
	if (args.text) {
		return queryElementByText(args.page, args.text, args.timeoutMs);
	}
	throw new Error("Provide either selector or text");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
	const [a, b] = parts;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a >= 224
	);
}

function isPrivateIPv6(ip: string): boolean {
	const normalized = ip.toLowerCase();
	return (
		normalized === "::1" ||
		normalized === "::" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe80:")
	);
}

function isBlockedHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized.endsWith(".internal") ||
		normalized.endsWith(".svc") ||
		normalized.endsWith(".svc.cluster.local") ||
		normalized === "kubernetes.default.svc" ||
		normalized === "metadata.google.internal"
	);
}

async function assertSafeUrl(rawUrl: string): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}
	if (!["http:", "https:"].includes(parsed.protocol)) {
		throw new Error("Only http:// and https:// URLs are allowed");
	}
	if (!parsed.hostname || isBlockedHostname(parsed.hostname)) {
		throw new Error(`Blocked hostname: ${parsed.hostname || "(empty)"}`);
	}
	const ipVersion = net.isIP(parsed.hostname);
	if (ipVersion === 4 && isPrivateIPv4(parsed.hostname)) {
		throw new Error(`Blocked private IPv4 address: ${parsed.hostname}`);
	}
	if (ipVersion === 6 && isPrivateIPv6(parsed.hostname)) {
		throw new Error(`Blocked private IPv6 address: ${parsed.hostname}`);
	}
	if (!ipVersion) {
		const records = await dns.lookup(parsed.hostname, {
			all: true,
			verbatim: true,
		});
		for (const record of records) {
			if (record.family === 4 && isPrivateIPv4(record.address)) {
				throw new Error(
					`Blocked hostname resolving to private IPv4: ${parsed.hostname}`,
				);
			}
			if (record.family === 6 && isPrivateIPv6(record.address)) {
				throw new Error(
					`Blocked hostname resolving to private IPv6: ${parsed.hostname}`,
				);
			}
		}
	}
}

function normalizeOwnerKey(ownerKey?: string): string {
	return ownerKey?.trim() || "global";
}

function normalizeOpenIdempotencyKey(args: {
	initial_url?: string;
	idempotency_key?: string;
}): string {
	const explicit = args.idempotency_key?.trim();
	if (explicit) {
		return explicit;
	}
	return args.initial_url?.trim() ? `initial_url:${args.initial_url.trim()}` : "open";
}

async function resolveHandle(
	sessionHandle: string,
): Promise<HandleRecord> {
	const record = await loadHandleRecord(sessionHandle.trim());
	if (!record) {
		throw new Error(`Session handle not found: ${sessionHandle}`);
	}
	return touchHandle(record);
}

async function resolveReusedOpen(
	ownerKey: string,
	openKey: string,
	timeoutMs: number,
): Promise<HandleRecord | null> {
	const existingHandle = await loadHandleForIdempotency(ownerKey, openKey);
	if (!existingHandle) {
		return null;
	}
	const record = await loadHandleRecord(existingHandle);
	if (!record) {
		await deleteIdempotencyMapping(ownerKey, openKey);
		return null;
	}
	const browserInfo = await getBrowserInfoMaybe(record.browserId);
	if (!browserInfo) {
		return {
			...record,
			browserId: "",
		};
	}
	await waitForBrowserReady(record.browserId, timeoutMs);
	return touchHandle(record);
}

async function upsertHandleBrowser(
	record: HandleRecord,
	browserId: string,
): Promise<HandleRecord> {
	const updated: HandleRecord = {
		...record,
		browserId,
		lastUsedAt: now(),
	};
	await saveHandleRecord(updated);
	if (updated.idempotencyKey) {
		await saveIdempotencyMapping(
			updated.ownerKey,
			updated.idempotencyKey,
			updated.sessionHandle,
		);
	}
	return updated;
}

async function createOrReuseHandle(args: {
	initial_url?: string;
	idempotency_key?: string;
	owner_key?: string;
	timeout_ms?: number;
}): Promise<{
	record: HandleRecord;
	reused: boolean;
	initialState?: JsonRecord;
}> {
	if (args.initial_url) {
		await assertSafeUrl(args.initial_url);
	}
	const ownerKey = normalizeOwnerKey(args.owner_key);
	const openKey = normalizeOpenIdempotencyKey(args);
	const timeoutMs = args.timeout_ms || BROWSERSTATION_READY_TIMEOUT_MS;
	const reused = await resolveReusedOpen(ownerKey, openKey, timeoutMs);

	if (reused && reused.browserId) {
		return { record: reused, reused: true };
	}

	const sessionHandle = reused?.sessionHandle || randomUUID();
	const createdAt = reused?.createdAt || now();
	const created = await createBrowser();
	const recordBase: HandleRecord = {
		sessionHandle,
		browserId: created.browser_id,
		ownerKey,
		idempotencyKey: openKey,
		initialUrl: args.initial_url?.trim(),
		createdAt,
		lastUsedAt: now(),
	};

	try {
		let initialState: JsonRecord | undefined;
		if (args.initial_url) {
			initialState = await withBrowserPage(created.browser_id, async (page) => {
				await page.goto(args.initial_url!, {
					timeout: timeoutMs,
					waitUntil: "domcontentloaded",
				});
				return pageSummary(page);
			});
		}
		const persisted = await upsertHandleBrowser(recordBase, created.browser_id);
		return { record: persisted, reused: false, initialState };
	} catch (error) {
		await deleteBrowser(created.browser_id, { ignoreMissing: true }).catch(
			() => undefined,
		);
		throw error;
	}
}

function createMcpServer() {
	const server = new McpServer({
		name: "browserstation-mcp",
		version: "1.0.0",
	});

	(server as any).registerTool(
		"browser_open_session",
		{
			title: "Open Browser Session",
			description:
				"Create a new Browserstation-backed Chromium session and optionally navigate to an initial URL.",
			inputSchema: {
				initial_url: z
					.string()
					.url()
					.optional()
					.describe("Optional initial URL to open after the browser starts."),
				idempotency_key: z
					.string()
					.optional()
					.describe(
						"Optional idempotency key. Requests with the same owner_key and idempotency_key reuse the same durable handle.",
					),
				owner_key: z
					.string()
					.optional()
					.describe(
						"Optional logical owner scope for idempotency. Defaults to a global scope.",
					),
				timeout_ms: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Optional readiness timeout override in milliseconds."),
			},
		},
		async (args: {
			initial_url?: string;
			idempotency_key?: string;
			owner_key?: string;
			timeout_ms?: number;
		}) => {
			try {
				const result = await createOrReuseHandle(args);
				return textResult({
					session_handle: result.record.sessionHandle,
					browser_id: result.record.browserId,
					owner_key: result.record.ownerKey,
					idempotency_key: result.record.idempotencyKey,
					reused: result.reused,
					initial_state: result.initialState,
				});
			} catch (error) {
				return errorResult(
					`Failed to open Browserstation session: ${(error as Error).message}`,
				);
			}
		},
	);

	(server as any).registerTool(
		"browser_close_session",
		{
			title: "Close Browser Session",
			description: "Close a Browserstation browser session and release its worker.",
			inputSchema: {
				session_handle: z
					.string()
					.optional()
					.describe("Durable browser session handle returned from browser_open_session."),
				browser_id: z
					.string()
					.uuid()
					.optional()
					.describe("Optional direct Browserstation browser_id for compatibility/debugging."),
			},
		},
		async (args: { session_handle?: string; browser_id?: string }) => {
			try {
				let record: HandleRecord | null = null;
				if (args.session_handle?.trim()) {
					record = await loadHandleRecord(args.session_handle.trim());
				} else if (args.browser_id?.trim()) {
					record = await findHandleByBrowserId(args.browser_id.trim());
				}

				if (record) {
					await cleanupHandleRecord(record, "explicit close");
					return textResult({
						session_handle: record.sessionHandle,
						browser_id: record.browserId,
						status: "closed",
					});
				}

				if (args.browser_id?.trim()) {
					await deleteBrowser(args.browser_id.trim(), { ignoreMissing: true });
					return textResult({
						browser_id: args.browser_id.trim(),
						status: "closed",
					});
				}

				throw new Error("Provide session_handle or browser_id");
			} catch (error) {
				return errorResult(
					`Failed to close Browserstation session: ${(error as Error).message}`,
				);
			}
		},
	);

	(server as any).registerTool(
		"browser_navigate",
		{
			title: "Navigate Browser",
			description: "Navigate an existing browser session to a new URL.",
			inputSchema: {
				session_handle: z
					.string()
					.describe("Durable browser session handle returned from browser_open_session."),
				url: z.string().url().describe("Destination URL."),
				timeout_ms: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Optional navigation timeout."),
			},
		},
		async (args: BrowserActionArgs & { url: string }) => {
			try {
				await assertSafeUrl(args.url);
				const record = await resolveHandle(args.session_handle);
				const result = await withBrowserPage(record.browserId, async (page) => {
					await page.goto(args.url, {
						timeout: args.timeout_ms || BROWSERSTATION_REQUEST_TIMEOUT_MS,
						waitUntil: "domcontentloaded",
					});
					return pageSummary(page);
				});
				return textResult({
					session_handle: record.sessionHandle,
					browser_id: record.browserId,
					...result,
				});
			} catch (error) {
				return errorResult(
					`Browser navigation failed: ${(error as Error).message}`,
				);
			}
		},
	);

	(server as any).registerTool(
		"browser_snapshot",
		{
			title: "Snapshot Browser Page",
			description:
				"Return a structured summary of the current page including title, URL, visible text excerpt, links, buttons, and form fields.",
			inputSchema: {
				session_handle: z
					.string()
					.describe("Durable browser session handle returned from browser_open_session."),
			},
		},
		async (args: BrowserActionArgs) => {
			try {
				const record = await resolveHandle(args.session_handle);
				const result = await withBrowserPage(record.browserId, pageSummary);
				return textResult({
					session_handle: record.sessionHandle,
					browser_id: record.browserId,
					...result,
				});
			} catch (error) {
				return errorResult(
					`Browser snapshot failed: ${(error as Error).message}`,
				);
			}
		},
	);

	(server as any).registerTool(
		"browser_click",
		{
			title: "Click Element",
			description:
				"Click an element in the current page by CSS selector or visible text.",
			inputSchema: {
				session_handle: z
					.string()
					.describe("Durable browser session handle returned from browser_open_session."),
				selector: z
					.string()
					.optional()
					.describe("CSS selector for the element to click."),
				text: z
					.string()
					.optional()
					.describe("Visible text contained by the element to click."),
				timeout_ms: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Optional element wait timeout."),
			},
		},
		async (
			args: BrowserActionArgs & {
				selector?: string;
				text?: string;
			},
		) => {
			try {
				const record = await resolveHandle(args.session_handle);
				const timeoutMs = args.timeout_ms || BROWSERSTATION_REQUEST_TIMEOUT_MS;
				const result = await withBrowserPage(record.browserId, async (page) => {
					const element = await lookupElement({
						page,
						selector: args.selector,
						text: args.text,
						timeoutMs,
					});
					await element.click();
					await page.waitForNetworkIdle({ idleTime: 500, timeout: timeoutMs }).catch(
						() => undefined,
					);
					return pageSummary(page);
				});
				return textResult({
					session_handle: record.sessionHandle,
					browser_id: record.browserId,
					...result,
				});
			} catch (error) {
				return errorResult(`Browser click failed: ${(error as Error).message}`);
			}
		},
	);

	(server as any).registerTool(
		"browser_type",
		{
			title: "Type Into Element",
			description:
				"Type text into an input, textarea, or editable element identified by CSS selector.",
			inputSchema: {
				session_handle: z
					.string()
					.describe("Durable browser session handle returned from browser_open_session."),
				selector: z.string().describe("CSS selector for the target input."),
				text: z.string().describe("Text to type into the element."),
				clear: z
					.boolean()
					.optional()
					.describe("Whether to clear the field before typing."),
				submit: z
					.boolean()
					.optional()
					.describe("Whether to press Enter after typing."),
				timeout_ms: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Optional element wait timeout."),
			},
		},
		async (
			args: BrowserActionArgs & {
				selector: string;
				text: string;
				clear?: boolean;
				submit?: boolean;
			},
		) => {
			try {
				const record = await resolveHandle(args.session_handle);
				const timeoutMs = args.timeout_ms || BROWSERSTATION_REQUEST_TIMEOUT_MS;
				const result = await withBrowserPage(record.browserId, async (page) => {
					const element = await lookupElement({
						page,
						selector: args.selector,
						timeoutMs,
					});
					await element.click({ clickCount: 1 });
					if (args.clear !== false) {
						await page.keyboard.down("Control");
						await page.keyboard.press("KeyA");
						await page.keyboard.up("Control");
						await page.keyboard.press("Backspace");
					}
					await page.type(args.selector, args.text);
					if (args.submit) {
						await page.keyboard.press("Enter");
					}
					await page.waitForNetworkIdle({ idleTime: 500, timeout: timeoutMs }).catch(
						() => undefined,
					);
					return pageSummary(page);
				});
				return textResult({
					session_handle: record.sessionHandle,
					browser_id: record.browserId,
					...result,
				});
			} catch (error) {
				return errorResult(`Browser type failed: ${(error as Error).message}`);
			}
		},
	);

	(server as any).registerTool(
		"browser_wait_for",
		{
			title: "Wait For Page Condition",
			description:
				"Wait for a selector or visible text to appear in the current page.",
			inputSchema: {
				session_handle: z
					.string()
					.describe("Durable browser session handle returned from browser_open_session."),
				selector: z
					.string()
					.optional()
					.describe("CSS selector to wait for."),
				text: z
					.string()
					.optional()
					.describe("Visible text to wait for."),
				timeout_ms: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Optional wait timeout."),
			},
		},
		async (
			args: BrowserActionArgs & {
				selector?: string;
				text?: string;
			},
		) => {
			try {
				const record = await resolveHandle(args.session_handle);
				const timeoutMs = args.timeout_ms || BROWSERSTATION_REQUEST_TIMEOUT_MS;
				const result = await withBrowserPage(record.browserId, async (page) => {
					if (args.selector) {
						await page.waitForSelector(args.selector, {
							visible: true,
							timeout: timeoutMs,
						});
					} else if (args.text) {
						await waitForText(page, args.text, timeoutMs);
					} else {
						throw new Error("Provide selector or text");
					}
					return pageSummary(page);
				});
				return textResult({
					session_handle: record.sessionHandle,
					browser_id: record.browserId,
					...result,
				});
			} catch (error) {
				return errorResult(
					`Browser wait_for failed: ${(error as Error).message}`,
				);
			}
		},
	);

	(server as any).registerTool(
		"browser_screenshot",
		{
			title: "Capture Screenshot",
			description:
				"Capture a PNG or JPEG screenshot of the current browser page.",
			inputSchema: {
				session_handle: z
					.string()
					.describe("Durable browser session handle returned from browser_open_session."),
				full_page: z
					.boolean()
					.optional()
					.describe("Capture the full scrollable page instead of only the viewport."),
				type: z
					.enum(["png", "jpeg"])
					.optional()
					.describe("Screenshot format."),
			},
		},
		async (
			args: BrowserActionArgs & {
				full_page?: boolean;
				type?: "png" | "jpeg";
			},
		) => {
			try {
				const record = await resolveHandle(args.session_handle);
				const imageType = args.type || "png";
				const payload = await withBrowserPage(record.browserId, async (page) => {
					const summary = await pageSummary(page);
					const bytes = await page.screenshot({
						fullPage: args.full_page !== false,
						type: imageType,
					});
					return { summary, bytes: Buffer.from(bytes), imageType };
				});
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									session_handle: record.sessionHandle,
									browser_id: record.browserId,
									...payload.summary,
								},
								null,
								2,
							),
						},
						{
							type: "image" as const,
							data: payload.bytes.toString("base64"),
							mimeType: imageType === "jpeg" ? "image/jpeg" : "image/png",
						},
					],
				};
			} catch (error) {
				return errorResult(
					`Browser screenshot failed: ${(error as Error).message}`,
				);
			}
		},
	);

	return server;
}

async function reconcilePersistedHandles(): Promise<{
	activeHandleCount: number;
}> {
	const handles = await loadHandleIndex();
	let activeHandleCount = 0;
	for (const sessionHandle of handles) {
		const record = await loadHandleRecord(sessionHandle);
		if (!record) {
			await removeHandleFromIndex(sessionHandle);
			continue;
		}
		if (now() - record.lastUsedAt >= IDLE_TTL_MS) {
			await cleanupHandleRecord(record, "idle timeout");
			continue;
		}
		const info = await getBrowserInfoMaybe(record.browserId);
		if (!info) {
			await deleteHandleRecord(record.sessionHandle);
			await deleteIdempotencyMapping(record.ownerKey, record.idempotencyKey);
			continue;
		}
		activeHandleCount += 1;
	}
	return { activeHandleCount };
}

function startCleanupLoop(): void {
	setInterval(() => {
		void reconcilePersistedHandles().catch((error) => {
			console.warn("[browserstation-mcp] cleanup sweep failed:", error);
		});
	}, CLEANUP_INTERVAL_MS).unref();
}

async function handleMcpPost(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const body = await parseBody(req);
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	const server = createMcpServer();
	await server.connect(transport);

	try {
		await transport.handleRequest(req, res, body);
	} finally {
		await transport.close().catch(() => undefined);
		await server.close().catch(() => undefined);
	}
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	setCorsHeaders(res);
	const url = req.url ?? "/";
	const method = req.method ?? "GET";

	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	if (url === "/health" && method === "GET") {
		const reconcile = await reconcilePersistedHandles();
		sendJson(res, 200, {
			service: "browserstation-mcp",
			browserstationBaseUrl: BROWSERSTATION_BASE_URL,
			daprHttpBaseUrl: DAPR_HTTP_BASE_URL,
			stateStore: BROWSERSTATION_MCP_STATESTORE,
			activeHandles: reconcile.activeHandleCount,
		});
		return;
	}

	if (url === "/mcp") {
		if (method === "POST") {
			await handleMcpPost(req, res);
			return;
		}
		res.writeHead(405);
		res.end("Method Not Allowed");
		return;
	}

	res.writeHead(404);
	res.end("Not Found");
}

async function main(): Promise<void> {
	ensureStateStoreConfigured();
	await reconcilePersistedHandles();
	startCleanupLoop();

	const httpServer = http.createServer(async (req, res) => {
		try {
			await handleRequest(req, res);
		} catch (error) {
			console.error("[browserstation-mcp] unhandled error:", error);
			if (!res.headersSent) {
				sendJson(res, 500, { error: "Internal Server Error" });
			}
		}
	});

	httpServer.listen(PORT, HOST, () => {
		console.log(
			`[browserstation-mcp] listening on http://${HOST}:${PORT} (browserstation=${BROWSERSTATION_BASE_URL}, dapr=${DAPR_HTTP_BASE_URL})`,
		);
	});
}

main().catch((error) => {
	console.error("[browserstation-mcp] fatal startup error:", error);
	process.exit(1);
});
