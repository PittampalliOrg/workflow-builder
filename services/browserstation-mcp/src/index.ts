import "./otel.js";

import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
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

type SessionState = {
	transport: StreamableHTTPServerTransport;
	activeBrowserId?: string;
	ownedBrowserIds: Set<string>;
	lastUsedAt: number;
};

const sessions = new Map<string, SessionState>();

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
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
	res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
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

function touchSession(state: SessionState): void {
	state.lastUsedAt = Date.now();
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

async function browserstationFetch<T>(
	path: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetch(`${BROWSERSTATION_BASE_URL}${path}`, {
		...init,
		headers: {
			...browserstationHeaders(init?.body !== undefined),
			...(init?.headers || {}),
		},
		signal: AbortSignal.timeout(BROWSERSTATION_REQUEST_TIMEOUT_MS),
	});
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

async function deleteBrowser(browserId: string): Promise<void> {
	await browserstationFetch(`/browsers/${encodeURIComponent(browserId)}`, {
		method: "DELETE",
	});
}

async function waitForBrowserReady(
	browserId: string,
	timeoutMs = BROWSERSTATION_READY_TIMEOUT_MS,
): Promise<BrowserstationBrowserInfo> {
	const started = Date.now();
	let lastInfo: BrowserstationBrowserInfo | undefined;
	while (Date.now() - started < timeoutMs) {
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
): Promise<{ browser: Browser; page: Page; wsUrl: string }> {
	const info = await waitForBrowserReady(browserId);
	if (!info.websocket_url) {
		throw new Error(`Browser ${browserId} does not expose a websocket URL`);
	}
	const wsUrl = toWebSocketUrl(info.websocket_url);
	const browser = await puppeteer.connect({
		browserWSEndpoint: wsUrl,
		protocolTimeout: BROWSERSTATION_REQUEST_TIMEOUT_MS,
		defaultViewport: null,
	});
	const pages = await browser.pages();
	const page = pages[0] ?? (await browser.newPage());
	return { browser, page, wsUrl };
}

async function withBrowserPage<T>(
	state: SessionState,
	browserId: string,
	fn: (page: Page) => Promise<T>,
): Promise<T> {
	touchSession(state);
	const { browser, page } = await connectBrowser(browserId);
	try {
		return await fn(page);
	} finally {
		browser.disconnect();
	}
}

function resolveBrowserId(
	state: SessionState,
	requestedBrowserId?: string,
): string {
	const browserId = requestedBrowserId?.trim() || state.activeBrowserId;
	if (!browserId) {
		throw new Error(
			"No browser_id provided and no active session browser is available",
		);
	}
	state.activeBrowserId = browserId;
	return browserId;
}

async function cleanupSession(
	sessionId: string,
	state: SessionState,
	reason: string,
): Promise<void> {
	const ownedIds = [...state.ownedBrowserIds];
	state.ownedBrowserIds.clear();
	state.activeBrowserId = undefined;
	for (const browserId of ownedIds) {
		try {
			await deleteBrowser(browserId);
		} catch (error) {
			console.warn(
				`[browserstation-mcp] failed to close browser ${browserId} during ${reason}:`,
				error,
			);
		}
	}
	sessions.delete(sessionId);
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

function createMcpServer(state: SessionState) {
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
				timeout_ms: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Optional readiness timeout override in milliseconds."),
			},
		},
		async (args: { initial_url?: string; timeout_ms?: number }) => {
			try {
				if (args.initial_url) {
					await assertSafeUrl(args.initial_url);
				}
				const created = await createBrowser();
				const browserId = created.browser_id;
				state.activeBrowserId = browserId;
				state.ownedBrowserIds.add(browserId);
				touchSession(state);

				let initialState: JsonRecord | undefined;
				if (args.initial_url) {
					initialState = await withBrowserPage(state, browserId, async (page) => {
						await page.goto(args.initial_url!, {
							timeout: args.timeout_ms || BROWSERSTATION_READY_TIMEOUT_MS,
							waitUntil: "domcontentloaded",
						});
						return pageSummary(page);
					});
				}

				return textResult({
					browser_id: browserId,
					initial_state: initialState,
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
				browser_id: z
					.string()
					.uuid()
					.optional()
					.describe("Optional Browserstation browser_id. Defaults to the active session browser."),
			},
		},
		async (args: { browser_id?: string }) => {
			try {
				const browserId = resolveBrowserId(state, args.browser_id);
				await deleteBrowser(browserId);
				state.ownedBrowserIds.delete(browserId);
				if (state.activeBrowserId === browserId) {
					state.activeBrowserId = undefined;
				}
				touchSession(state);
				return textResult({ browser_id: browserId, status: "closed" });
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
				browser_id: z
					.string()
					.uuid()
					.optional()
					.describe("Optional Browserstation browser_id. Defaults to the active session browser."),
				url: z.string().url().describe("Destination URL."),
				timeout_ms: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Optional navigation timeout."),
			},
		},
		async (args: { browser_id?: string; url: string; timeout_ms?: number }) => {
			try {
				await assertSafeUrl(args.url);
				const browserId = resolveBrowserId(state, args.browser_id);
				const result = await withBrowserPage(state, browserId, async (page) => {
					await page.goto(args.url, {
						timeout: args.timeout_ms || BROWSERSTATION_REQUEST_TIMEOUT_MS,
						waitUntil: "domcontentloaded",
					});
					return pageSummary(page);
				});
				return textResult({ browser_id: browserId, ...result });
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
				browser_id: z
					.string()
					.uuid()
					.optional()
					.describe("Optional Browserstation browser_id. Defaults to the active session browser."),
			},
		},
		async (args: { browser_id?: string }) => {
			try {
				const browserId = resolveBrowserId(state, args.browser_id);
				const result = await withBrowserPage(state, browserId, pageSummary);
				return textResult({ browser_id: browserId, ...result });
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
				browser_id: z
					.string()
					.uuid()
					.optional()
					.describe("Optional Browserstation browser_id. Defaults to the active session browser."),
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
		async (args: {
			browser_id?: string;
			selector?: string;
			text?: string;
			timeout_ms?: number;
		}) => {
			try {
				const browserId = resolveBrowserId(state, args.browser_id);
				const timeoutMs = args.timeout_ms || BROWSERSTATION_REQUEST_TIMEOUT_MS;
				const result = await withBrowserPage(state, browserId, async (page) => {
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
				return textResult({ browser_id: browserId, ...result });
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
				browser_id: z
					.string()
					.uuid()
					.optional()
					.describe("Optional Browserstation browser_id. Defaults to the active session browser."),
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
		async (args: {
			browser_id?: string;
			selector: string;
			text: string;
			clear?: boolean;
			submit?: boolean;
			timeout_ms?: number;
		}) => {
			try {
				const browserId = resolveBrowserId(state, args.browser_id);
				const timeoutMs = args.timeout_ms || BROWSERSTATION_REQUEST_TIMEOUT_MS;
				const result = await withBrowserPage(state, browserId, async (page) => {
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
				return textResult({ browser_id: browserId, ...result });
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
				browser_id: z
					.string()
					.uuid()
					.optional()
					.describe("Optional Browserstation browser_id. Defaults to the active session browser."),
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
		async (args: {
			browser_id?: string;
			selector?: string;
			text?: string;
			timeout_ms?: number;
		}) => {
			try {
				const browserId = resolveBrowserId(state, args.browser_id);
				const timeoutMs = args.timeout_ms || BROWSERSTATION_REQUEST_TIMEOUT_MS;
				const result = await withBrowserPage(state, browserId, async (page) => {
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
				return textResult({ browser_id: browserId, ...result });
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
				browser_id: z
					.string()
					.uuid()
					.optional()
					.describe("Optional Browserstation browser_id. Defaults to the active session browser."),
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
		async (args: {
			browser_id?: string;
			full_page?: boolean;
			type?: "png" | "jpeg";
		}) => {
			try {
				const browserId = resolveBrowserId(state, args.browser_id);
				const imageType = args.type || "png";
				const payload = await withBrowserPage(state, browserId, async (page) => {
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
								{ browser_id: browserId, ...payload.summary },
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

	return server.server;
}

async function handleMcpPost(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	let transport: StreamableHTTPServerTransport;
	const body = await parseBody(req);

	if (sessionId && sessions.has(sessionId)) {
		transport = sessions.get(sessionId)!.transport;
		touchSession(sessions.get(sessionId)!);
	} else if (!sessionId && isInitializeRequest(body)) {
		const sessionState: SessionState = {
			transport: undefined as unknown as StreamableHTTPServerTransport,
			ownedBrowserIds: new Set<string>(),
			lastUsedAt: Date.now(),
		};

		transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (sid) => {
				sessionState.transport = transport;
				sessions.set(sid, sessionState);
				console.log(`[browserstation-mcp] session initialized: ${sid}`);
			},
		});

		transport.onclose = () => {
			if (!transport.sessionId) return;
			void cleanupSession(transport.sessionId, sessionState, "session close");
			console.log(
				`[browserstation-mcp] session closed: ${transport.sessionId}`,
			);
		};

		const server = createMcpServer(sessionState);
		await server.connect(transport);
	} else {
		sendJson(res, 400, {
			error: { message: "Bad Request: No valid session ID provided" },
		});
		return;
	}

	await transport.handleRequest(req, res, body);
}

async function handleMcpGet(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	if (!sessionId || !sessions.has(sessionId)) {
		sendJson(res, 404, { error: "Session not found" });
		return;
	}
	const state = sessions.get(sessionId)!;
	touchSession(state);
	await state.transport.handleRequest(req, res);
}

async function handleMcpDelete(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	if (!sessionId || !sessions.has(sessionId)) {
		sendJson(res, 404, { error: "Session not found" });
		return;
	}
	const state = sessions.get(sessionId)!;
	touchSession(state);
	await state.transport.handleRequest(req, res);
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
		sendJson(res, 200, {
			service: "browserstation-mcp",
			browserstationBaseUrl: BROWSERSTATION_BASE_URL,
			activeSessions: sessions.size,
		});
		return;
	}

	if (url === "/mcp") {
		if (method === "POST") {
			await handleMcpPost(req, res);
			return;
		}
		if (method === "GET") {
			await handleMcpGet(req, res);
			return;
		}
		if (method === "DELETE") {
			await handleMcpDelete(req, res);
			return;
		}
		res.writeHead(405);
		res.end("Method Not Allowed");
		return;
	}

	res.writeHead(404);
	res.end("Not Found");
}

function startIdleCleanupLoop(): void {
	setInterval(() => {
		const now = Date.now();
		for (const [sessionId, state] of sessions.entries()) {
			if (now - state.lastUsedAt < IDLE_TTL_MS) continue;
			console.warn(
				`[browserstation-mcp] idle timeout for session ${sessionId}; cleaning up owned browsers`,
			);
			void cleanupSession(sessionId, state, "idle timeout");
		}
	}, CLEANUP_INTERVAL_MS).unref();
}

async function main(): Promise<void> {
	startIdleCleanupLoop();

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
			`[browserstation-mcp] listening on http://${HOST}:${PORT} (browserstation=${BROWSERSTATION_BASE_URL})`,
		);
	});
}

main().catch((error) => {
	console.error("[browserstation-mcp] fatal startup error:", error);
	process.exit(1);
});
