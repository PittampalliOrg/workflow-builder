"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type LogEntry = {
	time: string;
	message: string;
	type: "info" | "success" | "warn" | "error";
};

export default function McpAppsPage() {
	const [connected, setConnected] = useState(false);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [location, setLocation] = useState("San Francisco");
	const [toolResult, setToolResult] = useState<string | null>(null);
	const [uiHtml, setUiHtml] = useState<string | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [tools, setTools] = useState<string[]>([]);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const logEndRef = useRef<HTMLDivElement>(null);
	// Keep an SSE abort controller so we can close the GET stream on disconnect
	const sseAbortRef = useRef<AbortController | null>(null);

	const addLog = useCallback(
		(message: string, type: LogEntry["type"] = "info") => {
			setLogs((prev) => [
				...prev,
				{ time: new Date().toLocaleTimeString(), message, type },
			]);
		},
		[],
	);

	// Auto-scroll log
	useEffect(() => {
		logEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [logs]);

	// Listen for postMessage events from the iframe
	useEffect(() => {
		function handleMessage(event: MessageEvent) {
			const data = event.data;
			if (!data || !data.type) return;

			addLog(`iframe -> host: ${data.type}`, "info");

			switch (data.type) {
				case "notify":
					addLog(`Notification: ${data.payload?.message ?? ""}`, "success");
					break;
				case "link":
					addLog(`Link: ${data.payload?.url ?? ""}`, "info");
					break;
				case "prompt":
					addLog(`Prompt: ${data.payload?.prompt ?? ""}`, "info");
					break;
				case "intent":
					addLog(
						`Intent: ${data.payload?.intent ?? ""} params=${JSON.stringify(data.payload?.params ?? {})}`,
						"info",
					);
					break;
				case "ui-size-change":
					addLog(
						`Size change: ${data.payload?.width}x${data.payload?.height}`,
						"info",
					);
					break;
				case "tool":
					addLog(
						`Tool call: ${data.payload?.toolName} params=${JSON.stringify(data.payload?.params ?? {})}`,
						"info",
					);
					break;
				case "ui-lifecycle-iframe-ready":
					addLog("iframe is ready", "success");
					// Send render data with tool input/output
					iframeRef.current?.contentWindow?.postMessage(
						{
							type: "ui-lifecycle-iframe-render-data",
							payload: {
								renderData: {
									toolInput: { location },
									toolOutput: toolResult ? { text: toolResult } : undefined,
								},
							},
						},
						"*",
					);
					break;
				case "ui-request-render-data":
					iframeRef.current?.contentWindow?.postMessage(
						{
							type: "ui-lifecycle-iframe-render-data",
							payload: {
								renderData: {
									toolInput: { location },
									toolOutput: toolResult ? { text: toolResult } : undefined,
								},
							},
						},
						"*",
					);
					break;
			}
		}
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [addLog, location, toolResult]);

	/** Send a JSON-RPC request to the MCP server */
	async function mcpRequest(
		method: string,
		params?: Record<string, unknown>,
		sid?: string | null,
	): Promise<{ result: Record<string, unknown>; sessionId: string | null }> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		const effectiveSid = sid ?? sessionId;
		if (effectiveSid) {
			headers["Mcp-Session-Id"] = effectiveSid;
		}

		const body = {
			jsonrpc: "2.0",
			id: Date.now(),
			method,
			params: params ?? {},
		};

		const res = await fetch("/api/mcp-apps", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		const newSid = res.headers.get("Mcp-Session-Id");

		const contentType = res.headers.get("content-type") ?? "";

		if (contentType.includes("text/event-stream")) {
			// Parse SSE response to extract the JSON-RPC result
			const text = await res.text();
			const lines = text.split("\n");
			let result: Record<string, unknown> = {};
			for (const line of lines) {
				if (line.startsWith("data: ")) {
					try {
						const parsed = JSON.parse(line.slice(6));
						if (parsed.result !== undefined) {
							result = parsed.result;
						} else if (parsed.error) {
							throw new Error(parsed.error.message ?? "MCP error");
						}
					} catch {
						// skip non-JSON data lines
					}
				}
			}
			return { result, sessionId: newSid };
		}

		if (!res.ok) {
			const errText = await res.text();
			throw new Error(`MCP error ${res.status}: ${errText}`);
		}

		const json = await res.json();
		if (json.error) {
			throw new Error(json.error.message ?? "MCP error");
		}
		return { result: json.result ?? json, sessionId: newSid };
	}

	async function handleConnect() {
		try {
			addLog("Connecting to MCP server...", "info");

			// 1. Initialize
			const initResp = await mcpRequest("initialize", {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "mcp-apps-demo-page", version: "1.0.0" },
			});

			const sid = initResp.sessionId;
			if (sid) setSessionId(sid);
			addLog(`Session: ${sid ?? "none"}`, "success");

			// 2. Send initialized notification (no response expected)
			const notifHeaders: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (sid) notifHeaders["Mcp-Session-Id"] = sid;

			await fetch("/api/mcp-apps", {
				method: "POST",
				headers: notifHeaders,
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "notifications/initialized",
				}),
			});

			addLog("Sent initialized notification", "info");

			// 3. List tools
			const toolsResp = await mcpRequest("tools/list", {}, sid);
			const toolList =
				(toolsResp.result as { tools?: { name: string }[] }).tools?.map(
					(t) => t.name,
				) ?? [];
			setTools(toolList);
			addLog(`Tools: ${toolList.join(", ")}`, "success");

			setConnected(true);

			// 4. Open SSE stream for server-to-client messages
			if (sid) {
				const abort = new AbortController();
				sseAbortRef.current = abort;
				fetch("/api/mcp-apps", {
					method: "GET",
					headers: { "Mcp-Session-Id": sid, Accept: "text/event-stream" },
					signal: abort.signal,
				}).catch(() => {
					/* SSE closed */
				});
			}
		} catch (err) {
			addLog(`Connect failed: ${(err as Error).message}`, "error");
		}
	}

	async function handleDisconnect() {
		if (!sessionId) return;
		try {
			sseAbortRef.current?.abort();
			sseAbortRef.current = null;

			await fetch("/api/mcp-apps", {
				method: "DELETE",
				headers: { "Mcp-Session-Id": sessionId },
			});
			addLog("Disconnected", "info");
		} catch {
			// best effort
		}
		setConnected(false);
		setSessionId(null);
		setTools([]);
		setUiHtml(null);
		setToolResult(null);
	}

	async function handleCallTool() {
		if (!connected) return;
		try {
			addLog(`Calling weather_dashboard(location="${location}")`, "info");

			// Call the tool
			const resp = await mcpRequest("tools/call", {
				name: "weather_dashboard",
				arguments: { location },
			});

			const content = (
				resp.result as { content?: { type: string; text?: string }[] }
			).content;
			const textContent = content?.find((c) => c.type === "text")?.text;
			if (textContent) {
				setToolResult(textContent);
				addLog(`Tool result: ${textContent}`, "success");
			}

			// Fetch the UI resource
			addLog("Fetching UI resource...", "info");
			const resResp = await mcpRequest("resources/read", {
				uri: "ui://weather-server/dashboard-template",
			});

			const contents = (
				resResp.result as { contents?: { text?: string; uri?: string }[] }
			).contents;
			const html = contents?.[0]?.text;
			if (html) {
				setUiHtml(html);
				addLog("UI resource loaded, rendering iframe", "success");
			} else {
				addLog("No HTML content in resource response", "warn");
			}
		} catch (err) {
			addLog(`Tool call failed: ${(err as Error).message}`, "error");
		}
	}

	return (
		<div className="container mx-auto py-6">
			{/* Header */}
			<div className="mb-6 flex items-center gap-3">
				<SidebarToggle />
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">MCP Apps</h1>
					<p className="text-sm text-muted-foreground">
						MCP-UI + ext-apps interactive demo
					</p>
				</div>
			</div>

			{/* Controls */}
			<Card className="mb-6">
				<CardHeader className="pb-3">
					<div className="flex items-center justify-between">
						<div>
							<CardTitle className="text-base">MCP Server Connection</CardTitle>
							<CardDescription>
								Connect to the embedded MCP server, call tools, and render UI
							</CardDescription>
						</div>
						<Badge variant={connected ? "default" : "secondary"}>
							{connected ? "Connected" : "Disconnected"}
						</Badge>
					</div>
				</CardHeader>
				<CardContent>
					<div className="flex items-center gap-3">
						<Input
							placeholder="Location"
							value={location}
							onChange={(e) => setLocation(e.target.value)}
							className="max-w-xs"
						/>
						{!connected ? (
							<Button onClick={handleConnect}>Connect</Button>
						) : (
							<>
								<Button onClick={handleCallTool} disabled={tools.length === 0}>
									Call Tool
								</Button>
								<Button variant="outline" onClick={handleDisconnect}>
									Disconnect
								</Button>
							</>
						)}
					</div>
					{tools.length > 0 && (
						<div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
							<span>Available tools:</span>
							{tools.map((t) => (
								<Badge key={t} variant="outline" className="font-mono text-xs">
									{t}
								</Badge>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Two-column layout */}
			<div className="grid gap-6 lg:grid-cols-2">
				{/* Left: iframe */}
				<Card>
					<CardHeader className="pb-3">
						<CardTitle className="text-base">UI Resource (iframe)</CardTitle>
						<CardDescription>
							Rendered from the MCP server&apos;s UI resource
						</CardDescription>
					</CardHeader>
					<CardContent>
						{uiHtml ? (
							<iframe
								ref={iframeRef}
								srcDoc={uiHtml}
								sandbox="allow-scripts allow-same-origin"
								className="h-[600px] w-full rounded-lg border"
								title="MCP Apps Dashboard"
							/>
						) : (
							<div className="flex h-[600px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
								{connected
									? 'Click "Call Tool" to load the dashboard'
									: 'Click "Connect" to start'}
							</div>
						)}
					</CardContent>
				</Card>

				{/* Right: event log */}
				<Card>
					<CardHeader className="pb-3">
						<div className="flex items-center justify-between">
							<div>
								<CardTitle className="text-base">Event Log</CardTitle>
								<CardDescription>
									MCP protocol messages and iframe postMessage events
								</CardDescription>
							</div>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setLogs([])}
								className="text-xs"
							>
								Clear
							</Button>
						</div>
					</CardHeader>
					<CardContent>
						<div className="h-[600px] overflow-y-auto rounded-lg bg-muted/50 p-3 font-mono text-xs">
							{logs.length === 0 && (
								<div className="text-muted-foreground">No events yet</div>
							)}
							{logs.map((entry, i) => (
								<div
									key={i}
									className={
										entry.type === "success"
											? "text-green-600 dark:text-green-400"
											: entry.type === "warn"
												? "text-yellow-600 dark:text-yellow-400"
												: entry.type === "error"
													? "text-red-600 dark:text-red-400"
													: "text-muted-foreground"
									}
								>
									<span className="mr-2 opacity-60">{entry.time}</span>
									{entry.message}
								</div>
							))}
							<div ref={logEndRef} />
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
