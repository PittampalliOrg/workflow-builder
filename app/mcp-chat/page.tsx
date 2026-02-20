"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { MessageList } from "@/components/mcp-chat/message-list";
import {
	SlashCommandInput,
	type SlashEnabledServer,
} from "@/components/mcp-chat/slash-command-input";
import { ServerManager } from "@/components/mcp-chat/server-manager";
import type { SlashCommandScope } from "@/lib/mcp-chat/slash-command-types";
import { useMcpChat } from "@/lib/mcp-chat/use-mcp-chat";
import { api } from "@/lib/api-client";
import type {
	McpConnection,
	McpConnectionCatalogItem,
} from "@/lib/types/mcp-connection";
import {
	AlertCircle,
	BarChart3,
	CloudSun,
	Code2,
	Palette,
	RotateCcw,
	Sparkles,
	X,
} from "lucide-react";

const SUGGESTED_PROMPTS = [
	{
		label: "Weather Dashboard",
		prompt: "Show me the weather in Tokyo",
		icon: CloudSun,
		color: "text-sky-500",
		bgColor: "bg-sky-500/10",
	},
	{
		label: "Color Palette",
		prompt: "Generate a color palette based on #3B82F6",
		icon: Palette,
		color: "text-violet-500",
		bgColor: "bg-violet-500/10",
	},
	{
		label: "System Metrics",
		prompt:
			"Show me a dashboard with system metrics: CPU usage at 67%, Memory at 4.2GB, Response time at 145ms, and Active users at 1,247",
		icon: BarChart3,
		color: "text-emerald-500",
		bgColor: "bg-emerald-500/10",
	},
	{
		label: "Code Example",
		prompt: "Show me a TypeScript function that implements a debounce utility",
		icon: Code2,
		color: "text-amber-500",
		bgColor: "bg-amber-500/10",
	},
];

function parseServerTools(connection: McpConnection): {
	toolCount: number;
	tools: { name: string; description?: string }[];
} {
	const metadata = connection.metadata as Record<string, unknown> | null;
	const toolsFromMetadata: { name: string; description?: string }[] = [];

	const rawTools = metadata?.tools;
	if (Array.isArray(rawTools)) {
		for (const item of rawTools) {
			if (typeof item !== "object" || item === null) {
				continue;
			}
			const name = (item as { name?: unknown }).name;
			const description = (item as { description?: unknown }).description;
			if (typeof name !== "string" || !name.trim()) {
				continue;
			}
			toolsFromMetadata.push({
				name,
				description: typeof description === "string" ? description : undefined,
			});
		}
	}

	if (toolsFromMetadata.length === 0) {
		const rawToolNames = metadata?.toolNames;
		if (Array.isArray(rawToolNames)) {
			for (const item of rawToolNames) {
				if (typeof item === "string" && item.trim()) {
					toolsFromMetadata.push({ name: item });
				}
			}
		}
	}

	const rawToolCount = metadata?.toolCount;
	const metadataToolCount =
		typeof rawToolCount === "number" && Number.isFinite(rawToolCount)
			? rawToolCount
			: 0;
	return {
		toolCount: Math.max(metadataToolCount, toolsFromMetadata.length),
		tools: toolsFromMetadata,
	};
}

export default function McpChatPage() {
	const [input, setInput] = useState("");
	const [scopes, setScopes] = useState<SlashCommandScope[]>([]);
	const [connections, setConnections] = useState<McpConnection[]>([]);
	const [catalog, setCatalog] = useState<McpConnectionCatalogItem[]>([]);
	const [loadingServers, setLoadingServers] = useState(true);
	const [serversError, setServersError] = useState<string | null>(null);

	const enabledServers = useMemo<SlashEnabledServer[]>(() => {
		return connections
			.filter(
				(connection) =>
					connection.status === "ENABLED" && Boolean(connection.serverUrl),
			)
			.map((connection) => {
				const { toolCount, tools } = parseServerTools(connection);
				return {
					id: connection.id,
					name: connection.displayName,
					toolCount,
					tools,
				};
			});
	}, [connections]);

	const serverConfigs = useMemo(
		() =>
			connections
				.filter(
					(connection) =>
						connection.status === "ENABLED" && Boolean(connection.serverUrl),
				)
				.map((connection) => ({
					name: connection.displayName,
					url: connection.serverUrl as string,
				})),
		[connections],
	);

	const configsRef = useRef(serverConfigs);
	configsRef.current = serverConfigs;
	const scopesRef = useRef(scopes);
	scopesRef.current = scopes;

	const refreshMcpData = useCallback(async () => {
		try {
			setLoadingServers(true);
			setServersError(null);
			const [catalogResult, connectionsResult] = await Promise.all([
				api.mcpConnection.catalog(),
				api.mcpConnection.list(),
			]);
			setCatalog(catalogResult.data);
			setConnections(connectionsResult.data);
		} catch (error) {
			setServersError(
				error instanceof Error ? error.message : "Failed to load MCP servers",
			);
		} finally {
			setLoadingServers(false);
		}
	}, []);

	useEffect(() => {
		void refreshMcpData();
	}, [refreshMcpData]);

	const handleAddScope = useCallback((scope: SlashCommandScope) => {
		setScopes((prev) =>
			prev.some((entry) => entry.id === scope.id) ? prev : [...prev, scope],
		);
	}, []);

	const handleRemoveScope = useCallback((id: string) => {
		setScopes((prev) => prev.filter((entry) => entry.id !== id));
	}, []);

	const { messages, sendMessage, clearMessages, status, error, clearError } = useMcpChat(
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
		if (isLoading) return;
		const trimmed = input.trim();
		const hasScopes = scopesRef.current.length > 0;
		if (!trimmed && !hasScopes) return;
		const text =
			trimmed ||
			`Use the scoped tools: ${scopesRef.current.map((scope) => scope.label).join(", ")}`;
		setInput("");
		sendMessage({ text });
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

	const totalTools = enabledServers.reduce((sum, s) => sum + s.toolCount, 0);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-3 border-b px-4 py-3">
				<SidebarToggle />
				<Separator orientation="vertical" className="h-5" />
				<h1 className="text-lg font-semibold">MCP Chat</h1>

				{/* Server status indicator - hidden on mobile */}
				{!loadingServers && enabledServers.length > 0 && (
					<div className="hidden items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground sm:flex">
						<span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
						{enabledServers.length} server{enabledServers.length !== 1 ? "s" : ""}, {totalTools} tool{totalTools !== 1 ? "s" : ""}
					</div>
				)}

				<div className="flex-1" />
				<ServerManager
					catalog={catalog}
					connections={connections}
					loadError={serversError}
					loading={loadingServers}
					onRefresh={refreshMcpData}
				/>
				{messages.length > 0 && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={clearMessages}
								className="h-8 w-8 text-muted-foreground"
							>
								<RotateCcw className="h-3.5 w-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Clear conversation</TooltipContent>
					</Tooltip>
				)}
			</div>

			<div className="flex-1 overflow-y-auto px-4 py-6">
				{messages.length === 0 ? (
					<div className="mx-auto flex max-w-lg flex-col items-center justify-center gap-6 pt-12 text-center">
						<div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500/20 to-violet-500/20">
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
								{enabledServers.map((server) => (
									<Badge
										key={server.id}
										variant="outline"
										className="gap-1 text-xs"
									>
										<span className="h-1.5 w-1.5 rounded-full bg-green-500" />
										{server.name}
										{server.toolCount > 0 && ` (${server.toolCount} tools)`}
									</Badge>
								))}
							</div>
						)}
						<div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
							{SUGGESTED_PROMPTS.map((suggestion) => {
								const Icon = suggestion.icon;
								return (
									<button
										key={suggestion.label}
										type="button"
										onClick={() => handleSuggestedPrompt(suggestion.prompt)}
										className="group flex items-start gap-3 rounded-xl border bg-background p-3 text-left text-sm transition-all hover:border-foreground/10 hover:shadow-sm"
									>
										<div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${suggestion.bgColor}`}>
											<Icon className={`h-4 w-4 ${suggestion.color}`} />
										</div>
										<div className="min-w-0">
											<div className="mb-0.5 font-medium">{suggestion.label}</div>
											<div className="line-clamp-2 text-xs text-muted-foreground">
												{suggestion.prompt}
											</div>
										</div>
									</button>
								);
							})}
						</div>
						<p className="text-xs text-muted-foreground/60">
							Type <kbd className="rounded border border-border/40 px-1 py-0.5 font-mono text-[10px]">/</kbd> to scope tools, or just start typing
						</p>
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

			{error && (
				<div className="mx-auto w-full max-w-3xl px-4">
					<div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
						<AlertCircle className="h-4 w-4 shrink-0" />
						<span className="flex-1">{error}</span>
						<button
							type="button"
							onClick={clearError}
							className="shrink-0 rounded-sm p-0.5 hover:bg-destructive/20 transition-colors"
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
			)}

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
