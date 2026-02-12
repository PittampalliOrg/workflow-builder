"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Maximize2, Minimize2 } from "lucide-react";
import { useTheme } from "next-themes";

type ToolWidgetProps = {
	toolName: string;
	toolArgs: Record<string, unknown>;
	toolResult: { text: string };
	uiHtml: string;
	onSendMessage?: (text: string) => void;
};

/**
 * Renders an MCP App UI inside a sandboxed iframe.
 * Implements the MCP Apps JSON-RPC protocol for host↔guest communication.
 * Also supports the legacy postMessage protocol (weather dashboard).
 */
export function ToolWidget({
	toolName,
	toolArgs,
	toolResult,
	uiHtml,
	onSendMessage,
}: ToolWidgetProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [iframeHeight, setIframeHeight] = useState(400);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const { resolvedTheme } = useTheme();
	const initializedRef = useRef(false);

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			const data = event.data;
			if (!data) return;

			const iframe = iframeRef.current;
			if (!iframe || event.source !== iframe.contentWindow) return;

			// === JSON-RPC Protocol (new MCP Apps widgets) ===
			if (data.jsonrpc === "2.0") {
				// Handle initialize request from guest
				if (data.method === "ui/initialize" && data.id) {
					iframe.contentWindow?.postMessage(
						{
							jsonrpc: "2.0",
							id: data.id,
							result: {
								protocolVersion: "2025-03-26",
								hostInfo: {
									name: "workflow-builder-mcp-chat",
									version: "1.0.0",
								},
								capabilities: { openLinks: {}, logging: {} },
								hostContext: {
									theme: resolvedTheme === "dark" ? "dark" : "light",
									availableDisplayModes: ["inline", "fullscreen"],
								},
							},
						},
						"*",
					);
					return;
				}

				// Handle initialized notification → send tool data
				if (data.method === "ui/notifications/initialized") {
					if (!initializedRef.current) {
						initializedRef.current = true;
						iframe.contentWindow?.postMessage(
							{
								jsonrpc: "2.0",
								method: "ui/notifications/tool-input",
								params: { arguments: toolArgs },
							},
							"*",
						);
						iframe.contentWindow?.postMessage(
							{
								jsonrpc: "2.0",
								method: "ui/notifications/tool-result",
								params: {
									content: [{ type: "text", text: toolResult.text }],
								},
							},
							"*",
						);
					}
					return;
				}

				// Handle size change
				if (data.method === "ui/notifications/size-changed") {
					const { height } = data.params || {};
					if (height && typeof height === "number") {
						setIframeHeight(Math.min(Math.max(height, 100), 800));
					}
					return;
				}

				// Handle open link request
				if (data.method === "ui/open-link" && data.id) {
					const { url } = data.params || {};
					if (url) window.open(url, "_blank", "noopener,noreferrer");
					iframe.contentWindow?.postMessage(
						{ jsonrpc: "2.0", id: data.id, result: {} },
						"*",
					);
					return;
				}

				// Handle message request (inject into chat)
				if (data.method === "ui/message" && data.id) {
					const content = data.params?.content as
						| Array<{ type: string; text?: string }>
						| undefined;
					const text = content?.find((c) => c.type === "text")?.text;
					if (text && onSendMessage) onSendMessage(text);
					iframe.contentWindow?.postMessage(
						{ jsonrpc: "2.0", id: data.id, result: {} },
						"*",
					);
					return;
				}

				// Handle logging
				if (data.method === "notifications/message") {
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
								toolInput: toolArgs,
								toolOutput: { text: toolResult.text },
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
								toolInput: toolArgs,
								toolOutput: { text: toolResult.text },
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
				if (text && onSendMessage) onSendMessage(text);
				return;
			}
		},
		[toolArgs, toolResult, resolvedTheme, onSendMessage],
	);

	useEffect(() => {
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [handleMessage]);

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

	const content = (
		<Card
			className={
				isFullscreen ? "fixed inset-4 z-50 flex flex-col overflow-hidden" : ""
			}
		>
			<CardHeader className="flex flex-row items-center justify-between py-2 px-4">
				<Badge variant="outline" className="text-xs font-mono">
					{label}
				</Badge>
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6"
					onClick={() => setIsFullscreen(!isFullscreen)}
				>
					{isFullscreen ? (
						<Minimize2 className="h-3 w-3" />
					) : (
						<Maximize2 className="h-3 w-3" />
					)}
				</Button>
			</CardHeader>
			<CardContent className={`p-0 ${isFullscreen ? "flex-1" : ""}`}>
				<iframe
					ref={iframeRef}
					srcDoc={uiHtml}
					sandbox="allow-scripts"
					className="w-full border-0"
					style={{ height: isFullscreen ? "100%" : `${iframeHeight}px` }}
					title={`${label} widget`}
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
