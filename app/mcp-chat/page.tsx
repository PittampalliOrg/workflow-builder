"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageList } from "@/components/mcp-chat/message-list";
import { SlashCommandInput } from "@/components/mcp-chat/slash-command-input";
import { ServerManager } from "@/components/mcp-chat/server-manager";
import type { SlashCommandScope } from "@/lib/mcp-chat/slash-command-types";
import { useMcpChat } from "@/lib/mcp-chat/use-mcp-chat";
import {
	mcpServerConfigsAtom,
	enabledMcpServersAtom,
	mcpServersAtom,
	updateServerStatus,
} from "@/lib/mcp-chat/mcp-servers-store";
import { RotateCcw, Sparkles } from "lucide-react";

const SUGGESTED_PROMPTS = [
	{
		label: "Weather Dashboard",
		prompt: "Show me the weather in Tokyo",
	},
	{
		label: "Color Palette",
		prompt: "Generate a color palette based on #3B82F6",
	},
	{
		label: "System Metrics",
		prompt:
			"Show me a dashboard with system metrics: CPU usage at 67%, Memory at 4.2GB, Response time at 145ms, and Active users at 1,247",
	},
	{
		label: "Code Example",
		prompt: "Show me a TypeScript function that implements a debounce utility",
	},
];

export default function McpChatPage() {
	const [input, setInput] = useState("");
	const [scopes, setScopes] = useState<SlashCommandScope[]>([]);

	const [servers, setServers] = useAtom(mcpServersAtom);
	const mcpServerConfigs = useAtomValue(mcpServerConfigsAtom);
	const enabledServers = useAtomValue(enabledMcpServersAtom);
	const configsRef = useRef(mcpServerConfigs);
	configsRef.current = mcpServerConfigs;
	const scopesRef = useRef(scopes);
	scopesRef.current = scopes;

	// Auto-reconnect enabled servers that have no tools (e.g. after page reload)
	useEffect(() => {
		const stale = servers.filter((s) => s.enabled && s.toolCount === 0);
		if (stale.length === 0) return;

		for (const server of stale) {
			updateServerStatus(setServers, server.id, "connecting");
			fetch("/api/mcp-chat/servers/test", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: server.url }),
			})
				.then((res) => res.json())
				.then((data) => {
					if (data.tools) {
						updateServerStatus(setServers, server.id, "connected", {
							toolCount: data.tools.length,
							tools: data.tools,
						});
					} else {
						updateServerStatus(setServers, server.id, "error", {
							error: data.error || "Failed to discover tools",
						});
					}
				})
				.catch(() => {
					updateServerStatus(setServers, server.id, "error", {
						error: "Connection failed",
					});
				});
		}
		// Run only once on mount
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const handleAddScope = useCallback((scope: SlashCommandScope) => {
		setScopes((prev) =>
			prev.some((s) => s.id === scope.id) ? prev : [...prev, scope],
		);
	}, []);

	const handleRemoveScope = useCallback((id: string) => {
		setScopes((prev) => prev.filter((s) => s.id !== id));
	}, []);

	const { messages, sendMessage, clearMessages, status, error } = useMcpChat(
		"/api/mcp-chat",
		{
			body: () => ({
				mcpServers: configsRef.current,
				slashScopes: scopesRef.current,
			}),
		},
	);

	const isLoading = status === "streaming" || status === "submitted";

	const handleSubmit = useCallback(() => {
		const trimmed = input.trim();
		if (!trimmed || isLoading) return;
		setInput("");
		sendMessage({ text: trimmed });
	}, [input, isLoading, sendMessage]);

	const handleSuggestedPrompt = useCallback(
		(prompt: string) => {
			setInput("");
			sendMessage({ text: prompt });
		},
		[sendMessage],
	);

	const handleWidgetMessage = useCallback(
		(text: string) => {
			sendMessage({ text });
		},
		[sendMessage],
	);

	return (
		<div className="flex h-full flex-col">
			{/* Header */}
			<div className="flex items-center gap-3 border-b px-4 py-3">
				<SidebarToggle />
				<div className="flex items-center gap-2">
					<h1 className="text-lg font-semibold">MCP Chat</h1>
					<Badge variant="secondary" className="text-xs">
						MCP Apps
					</Badge>
				</div>
				<div className="flex-1" />
				<ServerManager />
				{messages.length > 0 && (
					<Button
						variant="ghost"
						size="sm"
						onClick={clearMessages}
						className="text-xs text-muted-foreground"
					>
						<RotateCcw className="mr-1 h-3 w-3" />
						Clear
					</Button>
				)}
			</div>

			{/* Messages */}
			<div className="flex-1 overflow-y-auto px-4 py-6">
				{messages.length === 0 ? (
					<div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-6 pt-20 text-center">
						<div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
							<Sparkles className="h-8 w-8 text-primary" />
						</div>
						<div>
							<h2 className="mb-2 text-xl font-semibold">MCP Apps Chat</h2>
							<p className="text-sm text-muted-foreground">
								Chat with an AI that has access to interactive MCP tool widgets.
								Try one of the suggestions below to see rich tool UIs rendered
								inline.
							</p>
						</div>
						{enabledServers.length > 0 && (
							<div className="flex flex-wrap justify-center gap-2">
								{enabledServers.map((s) => (
									<Badge key={s.id} variant="outline" className="text-xs gap-1">
										<span className="h-1.5 w-1.5 rounded-full bg-green-500" />
										{s.name}
										{s.toolCount > 0 && ` (${s.toolCount} tools)`}
									</Badge>
								))}
							</div>
						)}
						<div className="grid w-full grid-cols-2 gap-3">
							{SUGGESTED_PROMPTS.map((sp) => (
								<button
									key={sp.label}
									type="button"
									onClick={() => handleSuggestedPrompt(sp.prompt)}
									className="rounded-xl border bg-background p-3 text-left text-sm transition-colors hover:bg-muted"
								>
									<div className="mb-1 font-medium">{sp.label}</div>
									<div className="line-clamp-2 text-xs text-muted-foreground">
										{sp.prompt}
									</div>
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="mx-auto max-w-3xl">
						<MessageList
							messages={messages}
							isLoading={isLoading}
							onSendMessage={handleWidgetMessage}
						/>
					</div>
				)}
			</div>

			{/* Error */}
			{error && (
				<div className="mx-auto w-full max-w-3xl px-4">
					<div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
						{error}
					</div>
				</div>
			)}

			{/* Input */}
			<div className="mx-auto w-full max-w-3xl px-4 pb-4">
				<SlashCommandInput
					value={input}
					onChange={setInput}
					onSubmit={handleSubmit}
					isDisabled={isLoading}
					placeholder="Type / for commands, or ask anything..."
					scopes={scopes}
					onAddScope={handleAddScope}
					onRemoveScope={handleRemoveScope}
					enabledServers={enabledServers}
				/>
			</div>
		</div>
	);
}
