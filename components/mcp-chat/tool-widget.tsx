"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Maximize2, Minimize2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useTheme } from "next-themes";

type ToolWidgetProps = {
	toolName: string;
	toolArgs: Record<string, unknown>;
	toolResult: { text: string };
	uiHtml: string;
	serverUrl?: string;
	onSendMessage?: (text: string) => void;
};

/**
 * Renders an MCP App UI inside a sandboxed iframe.
 * Implements the MCP Apps JSON-RPC protocol for host↔guest communication.
 * Also supports the legacy postMessage protocol (weather dashboard).
 *
 * The message handler is registered in useEffect, which correctly handles
 * React Strict Mode's mount/unmount/remount cycle. The srcDoc iframe's
 * scripts always execute asynchronously after useEffect fires, so no
 * race condition is possible.
 */
export function ToolWidget({
	toolName,
	toolArgs,
	toolResult,
	uiHtml,
	serverUrl,
	onSendMessage,
}: ToolWidgetProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [iframeHeight, setIframeHeight] = useState(400);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [iframeLoaded, setIframeLoaded] = useState(false);
	const { resolvedTheme } = useTheme();
	const initializedRef = useRef(false);

	// Store latest props in refs so the handler always has current values
	const toolArgsRef = useRef(toolArgs);
	const toolResultRef = useRef(toolResult);
	const resolvedThemeRef = useRef(resolvedTheme);
	const serverUrlRef = useRef(serverUrl);
	const onSendMessageRef = useRef(onSendMessage);
	toolArgsRef.current = toolArgs;
	toolResultRef.current = toolResult;
	resolvedThemeRef.current = resolvedTheme;
	serverUrlRef.current = serverUrl;
	onSendMessageRef.current = onSendMessage;

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			const data = event.data;
			if (!data || typeof data !== "object") return;

			const iframe = iframeRef.current;
			if (!iframe) return;

			// Sandboxed iframes (without allow-same-origin) have opaque
			// contentWindow refs. Use both source check and origin check.
			const isFromIframe =
				event.source === iframe.contentWindow ||
				event.origin === "null"; // Sandboxed iframes have "null" origin

			if (!isFromIframe) return;

			// === JSON-RPC Protocol (MCP Apps widgets) ===
			if (data.jsonrpc === "2.0") {
				if (data.method === "ui/initialize" && data.id != null) {
					iframe.contentWindow?.postMessage(
						{
							jsonrpc: "2.0",
							id: data.id,
							result: {
								protocolVersion: "2026-01-26",
								hostInfo: {
									name: "workflow-builder-mcp-chat",
									version: "1.0.0",
								},
								hostCapabilities: {
									openLinks: {},
									logging: {},
									serverTools: {},
								},
								hostContext: {
									theme:
										resolvedThemeRef.current === "dark"
											? "dark"
											: "light",
									availableDisplayModes: [
										"inline",
										"fullscreen",
									],
								},
							},
						},
						"*",
					);
					return;
				}

				if (data.method === "ui/notifications/initialized") {
					if (!initializedRef.current) {
						initializedRef.current = true;
						iframe.contentWindow?.postMessage(
							{
								jsonrpc: "2.0",
								method: "ui/notifications/tool-input",
								params: {
									arguments: toolArgsRef.current,
								},
							},
							"*",
						);
						iframe.contentWindow?.postMessage(
							{
								jsonrpc: "2.0",
								method: "ui/notifications/tool-result",
								params: {
									content: [
										{
											type: "text",
											text: toolResultRef.current.text,
										},
									],
								},
							},
							"*",
						);
					}
					return;
				}

				if (data.method === "ui/notifications/size-changed") {
					const { height } = data.params || {};
					if (height && typeof height === "number") {
						setIframeHeight(
							Math.min(Math.max(height, 100), 800),
						);
					}
					return;
				}

				if (data.method === "ui/open-link" && data.id) {
					const { url } = data.params || {};
					if (url)
						window.open(url, "_blank", "noopener,noreferrer");
					iframe.contentWindow?.postMessage(
						{ jsonrpc: "2.0", id: data.id, result: {} },
						"*",
					);
					return;
				}

				if (data.method === "ui/message" && data.id) {
					const content = data.params?.content as
						| Array<{ type: string; text?: string }>
						| undefined;
					const text = content?.find(
						(c) => c.type === "text",
					)?.text;
					if (text && onSendMessageRef.current)
						onSendMessageRef.current(text);
					iframe.contentWindow?.postMessage(
						{ jsonrpc: "2.0", id: data.id, result: {} },
						"*",
					);
					return;
				}

				if (data.method === "tools/call" && data.id) {
					if (!serverUrlRef.current) {
						iframe.contentWindow?.postMessage(
							{
								jsonrpc: "2.0",
								id: data.id,
								error: {
									code: -1,
									message:
										"Server URL not available for tool proxy",
								},
							},
							"*",
						);
						return;
					}
					const { name, arguments: toolCallArgs } =
						data.params ?? {};
					if (name) {
						fetch("/api/mcp-chat/tools/call", {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								serverUrl: serverUrlRef.current,
								toolName: name,
								arguments: toolCallArgs ?? {},
							}),
						})
							.then((r) => r.json())
							.then((result) => {
								iframe.contentWindow?.postMessage(
									{
										jsonrpc: "2.0",
										id: data.id,
										result,
									},
									"*",
								);
							})
							.catch((err) => {
								iframe.contentWindow?.postMessage(
									{
										jsonrpc: "2.0",
										id: data.id,
										error: {
											code: -1,
											message: err.message,
										},
									},
									"*",
								);
							});
					}
					return;
				}

				if (data.method === "notifications/message") {
					return;
				}

				if (data.method === "notifications/cancelled") {
					return;
				}

				return;
			}

			// === Legacy Protocol (weather dashboard compat) ===
			if (data.type === "ui-lifecycle-iframe-ready") {
				if (!initializedRef.current) {
					initializedRef.current = true;
				}
				iframe.contentWindow?.postMessage(
					{
						type: "ui-lifecycle-iframe-render-data",
						payload: {
							renderData: {
								toolInput: toolArgsRef.current,
								toolOutput: {
									text: toolResultRef.current.text,
								},
							},
						},
					},
					"*",
				);
				return;
			}

			if (data.type === "ui-request-render-data") {
				iframe.contentWindow?.postMessage(
					{
						type: "ui-lifecycle-iframe-render-data",
						payload: {
							renderData: {
								toolInput: toolArgsRef.current,
								toolOutput: {
									text: toolResultRef.current.text,
								},
							},
						},
					},
					"*",
				);
				return;
			}

			if (data.type === "ui-size-change") {
				const { height } = data.payload || {};
				if (height && typeof height === "number") {
					setIframeHeight(Math.min(Math.max(height, 100), 800));
				}
				return;
			}

			if (data.type === "link") {
				const url = data.payload?.url;
				if (url) window.open(url, "_blank", "noopener,noreferrer");
				return;
			}

			if (data.type === "prompt") {
				const text = data.payload?.prompt;
				if (text && onSendMessageRef.current)
					onSendMessageRef.current(text);
				return;
			}
		},
		[], // Stable - all mutable state accessed via refs
	);

	// Register message listener in useEffect (handles Strict Mode properly)
	useEffect(() => {
		window.addEventListener("message", handleMessage);
		return () => {
			window.removeEventListener("message", handleMessage);
		};
	}, [handleMessage]);

	// Escape key to close fullscreen
	useEffect(() => {
		if (!isFullscreen) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") setIsFullscreen(false);
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [isFullscreen]);

	// Send theme updates to initialized widgets
	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe || !initializedRef.current) return;
		iframe.contentWindow?.postMessage(
			{
				jsonrpc: "2.0",
				method: "ui/notifications/host-context-changed",
				params: { theme: resolvedTheme === "dark" ? "dark" : "light" },
			},
			"*",
		);
	}, [resolvedTheme]);

	const label = toolName.replace(/_/g, " ").replace(/\b\w/g, (c) =>
		c.toUpperCase(),
	);

	const argCount = Object.keys(toolArgs).length;

	const content = (
		<Card
			className={
				isFullscreen
					? "fixed inset-4 z-50 flex flex-col overflow-hidden"
					: ""
			}
		>
			<CardHeader className="flex flex-row items-center justify-between py-2 px-4">
				<div className="flex items-center gap-2">
					<Badge variant="outline" className="text-xs font-mono">
						{label}
					</Badge>
					{argCount > 0 && (
						<Badge
							variant="secondary"
							className="text-[10px] px-1.5 py-0"
						>
							{argCount} arg{argCount !== 1 ? "s" : ""}
						</Badge>
					)}
				</div>
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6"
					onClick={() => setIsFullscreen(!isFullscreen)}
					title={
						isFullscreen
							? "Exit fullscreen (Esc)"
							: "Fullscreen (Esc to close)"
					}
				>
					{isFullscreen ? (
						<Minimize2 className="h-3 w-3" />
					) : (
						<Maximize2 className="h-3 w-3" />
					)}
				</Button>
			</CardHeader>
			<CardContent
				className={`p-0 relative ${isFullscreen ? "flex-1" : ""}`}
			>
				{!iframeLoaded && (
					<div className="absolute inset-0 p-4 space-y-3">
						<Skeleton className="h-6 w-2/3" />
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-4/5" />
						<Skeleton className="h-32 w-full" />
						<Skeleton className="h-4 w-1/2" />
					</div>
				)}
				<iframe
					ref={iframeRef}
					srcDoc={uiHtml}
					sandbox="allow-scripts allow-same-origin"
					className={`w-full border-0 transition-opacity duration-200 ${iframeLoaded ? "opacity-100" : "opacity-0"}`}
					style={{
						height: isFullscreen ? "100%" : `${iframeHeight}px`,
					}}
					title={`${label} widget`}
					onLoad={() => setIframeLoaded(true)}
				/>
			</CardContent>
		</Card>
	);

	if (isFullscreen) {
		return (
			<>
				<div
					className="fixed inset-0 z-40 bg-black/50"
					onClick={() => setIsFullscreen(false)}
					onKeyDown={() => {}}
					role="presentation"
				/>
				{content}
			</>
		);
	}

	return content;
}
