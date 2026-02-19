"use client";

import { useCallback, useState } from "react";
import { useAtom } from "jotai";
import {
	mcpServersAtom,
	setServersFromManaged,
	toggleServer,
	updateServerStatus,
} from "@/lib/mcp-chat/mcp-servers-store";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
	Server,
	Trash2,
	Plus,
	Loader2,
	RefreshCw,
	Wrench,
	CloudCog,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { McpConnectionSourceType } from "@/lib/types/mcp-connection";

type DiscoveredServer = {
	id: string;
	name: string;
	pieceName: string;
	url: string;
	healthy: boolean;
	enabled: boolean;
	toolCount: number;
	toolNames: string[];
	status: string;
};

export function ServerManager() {
	const [servers, setServers] = useAtom(mcpServersAtom);
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [loading, setLoading] = useState(false);
	const [catalogLoading, setCatalogLoading] = useState(false);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [serverError, setServerError] = useState<string | null>(null);
	const [catalog, setCatalog] = useState<
		Array<{
			pieceName: string;
			displayName: string;
			activeConnectionCount: number;
			enabled: boolean;
		}>
	>([]);
	const [busyId, setBusyId] = useState<string | null>(null);

	const refreshManagedServers = useCallback(async () => {
		setLoading(true);
		setServerError(null);
		try {
			const res = await fetch("/api/mcp-chat/servers/discover");
			const data = (await res.json()) as {
				servers: DiscoveredServer[];
				error?: string;
			};
			if (!res.ok) {
				throw new Error(data.error || "Failed to discover servers");
			}

			setServersFromManaged(
				setServers,
				data.servers.map((server) => ({
					connectionId: server.id,
					name: server.name,
					url: server.url,
					toolCount: server.toolCount,
					toolNames: server.toolNames,
					enabled: server.enabled && Boolean(server.url),
				})),
			);
		} catch (error) {
			setServerError(
				error instanceof Error ? error.message : "Failed to load MCP servers",
			);
		} finally {
			setLoading(false);
		}
	}, [setServers]);

	const refreshCatalog = useCallback(async () => {
		setCatalogLoading(true);
		setCatalogError(null);
		try {
			const result = await api.mcpConnection.catalog();
			setCatalog(
				result.data
					.filter((item) => !item.enabled && item.hasActiveConnections)
					.map((item) => ({
						pieceName: item.pieceName,
						displayName: item.displayName,
						activeConnectionCount: item.activeConnectionCount,
						enabled: item.enabled,
					})),
			);
		} catch (error) {
			setCatalogError(
				error instanceof Error ? error.message : "Failed to load catalog",
			);
		} finally {
			setCatalogLoading(false);
		}
	}, []);

	const refreshAll = useCallback(async () => {
		await Promise.all([refreshManagedServers(), refreshCatalog()]);
	}, [refreshManagedServers, refreshCatalog]);

	const handleEnablePiece = useCallback(
		async (pieceName: string) => {
			try {
				setBusyId(`enable:${pieceName}`);
				await api.mcpConnection.create({
					sourceType: McpConnectionSourceType.NIMBLE_PIECE,
					pieceName,
				});
				await refreshAll();
			} catch (error) {
				setCatalogError(
					error instanceof Error ? error.message : "Failed to enable piece MCP",
				);
			} finally {
				setBusyId(null);
			}
		},
		[refreshAll],
	);

	const handleAddCustom = useCallback(async () => {
		const trimmedUrl = url.trim();
		const trimmedName = name.trim();
		if (!(trimmedUrl && trimmedName)) {
			return;
		}

		try {
			setBusyId("add-custom");
			await api.mcpConnection.create({
				sourceType: McpConnectionSourceType.CUSTOM_URL,
				displayName: trimmedName,
				serverUrl: trimmedUrl,
			});
			setUrl("");
			setName("");
			await refreshManagedServers();
		} catch (error) {
			setServerError(
				error instanceof Error ? error.message : "Failed to add custom server",
			);
		} finally {
			setBusyId(null);
		}
	}, [name, refreshManagedServers, url]);

	const handleRemove = useCallback(
		async (id: string) => {
			try {
				setBusyId(id);
				await api.mcpConnection.delete(id);
				await refreshAll();
			} catch (error) {
				setServerError(
					error instanceof Error ? error.message : "Failed to remove server",
				);
			} finally {
				setBusyId(null);
			}
		},
		[refreshAll],
	);

	const handleToggle = useCallback(
		async (id: string, enabled: boolean) => {
			toggleServer(setServers, id);
			try {
				await api.mcpConnection.setStatus(id, enabled ? "DISABLED" : "ENABLED");
				await refreshAll();
			} catch (error) {
				updateServerStatus(setServers, id, "error", {
					error:
						error instanceof Error
							? error.message
							: "Failed to update server status",
				});
			}
		},
		[refreshAll, setServers],
	);

	const handleSync = useCallback(
		async (id: string) => {
			try {
				setBusyId(id);
				await api.mcpConnection.sync(id);
				await refreshAll();
			} catch (error) {
				setServerError(
					error instanceof Error ? error.message : "Failed to sync",
				);
			} finally {
				setBusyId(null);
			}
		},
		[refreshAll],
	);

	const enabledCount = servers.filter((s) => s.enabled).length;

	return (
		<Sheet
			onOpenChange={(open) => {
				if (open) {
					void refreshAll();
				}
			}}
		>
			<SheetTrigger asChild>
				<Button variant="outline" size="sm" className="gap-1.5 text-xs">
					<Server className="h-3.5 w-3.5" />
					Servers
					{enabledCount > 0 && (
						<Badge
							variant="secondary"
							className="ml-0.5 px-1.5 py-0 text-[10px]"
						>
							{enabledCount}
						</Badge>
					)}
				</Button>
			</SheetTrigger>
			<SheetContent className="w-[420px] sm:w-[460px]">
				<SheetHeader>
					<SheetTitle>MCP Servers</SheetTitle>
				</SheetHeader>

				<div className="mt-6 space-y-6">
					<div className="flex items-center justify-end">
						<Button
							variant="outline"
							size="sm"
							className="gap-1.5 text-xs"
							onClick={() => void refreshAll()}
							disabled={loading || catalogLoading}
						>
							{loading || catalogLoading ? (
								<Loader2 className="h-3 w-3 animate-spin" />
							) : (
								<RefreshCw className="h-3 w-3" />
							)}
							Refresh
						</Button>
					</div>

					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<CloudCog className="h-4 w-4 text-muted-foreground" />
							<h3 className="text-sm font-medium">Enable Piece MCP</h3>
						</div>
						{catalogError && (
							<p className="text-xs text-destructive">{catalogError}</p>
						)}
						{catalogLoading ? (
							<p className="text-xs text-muted-foreground">
								Loading catalog...
							</p>
						) : catalog.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								No additional pieces with active app connections to enable.
							</p>
						) : (
							<div className="space-y-2">
								{catalog.slice(0, 10).map((item) => (
									<div
										key={item.pieceName}
										className="flex items-center justify-between rounded-lg border border-dashed bg-muted/40 p-2.5"
									>
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm font-medium">
												{item.displayName}
											</div>
											<div className="text-xs text-muted-foreground">
												{item.activeConnectionCount} active connection
												{item.activeConnectionCount === 1 ? "" : "s"}
											</div>
										</div>
										<Button
											size="sm"
											variant="outline"
											onClick={() => void handleEnablePiece(item.pieceName)}
											disabled={busyId === `enable:${item.pieceName}`}
											className="ml-2 gap-1 text-xs"
										>
											<Plus className="h-3 w-3" />
											Enable
										</Button>
									</div>
								))}
							</div>
						)}
					</div>

					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<Wrench className="h-4 w-4 text-muted-foreground" />
							<h3 className="text-sm font-medium">Add Custom Server</h3>
						</div>
						<Input
							placeholder="Display name"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
						<Input
							placeholder="Server URL (e.g. http://svc:3100/mcp)"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
						/>
						<Button
							onClick={() => void handleAddCustom()}
							disabled={busyId === "add-custom" || !(name.trim() && url.trim())}
							size="sm"
							className="w-full gap-1.5"
						>
							{busyId === "add-custom" ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Plus className="h-3.5 w-3.5" />
							)}
							Add Server
						</Button>
						{serverError && (
							<p className="text-xs text-destructive">{serverError}</p>
						)}
					</div>

					<div className="space-y-3">
						<h3 className="text-sm font-medium">
							Managed Servers ({servers.length})
						</h3>
						{loading ? (
							<p className="text-xs text-muted-foreground">
								Loading servers...
							</p>
						) : servers.length === 0 ? (
							<div className="py-6 text-center text-sm text-muted-foreground">
								No MCP servers enabled.
							</div>
						) : (
							servers.map((server) => (
								<div
									key={server.id}
									className="space-y-2 rounded-lg border p-3"
								>
									<div className="flex items-start justify-between gap-2">
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span
													className={`h-2 w-2 shrink-0 rounded-full ${
														server.status === "connected"
															? "bg-green-500"
															: server.status === "error"
																? "bg-red-500"
																: server.status === "connecting"
																	? "bg-yellow-500 animate-pulse"
																	: "bg-gray-400"
													}`}
												/>
												<span className="truncate text-sm font-medium">
													{server.name}
												</span>
												{server.toolCount > 0 && (
													<Badge
														variant="secondary"
														className="shrink-0 px-1.5 py-0 text-[10px]"
													>
														{server.toolCount} tool
														{server.toolCount === 1 ? "" : "s"}
													</Badge>
												)}
											</div>
											<p className="mt-0.5 truncate pl-4 text-xs text-muted-foreground">
												{server.url}
											</p>
										</div>
										<div className="flex shrink-0 items-center gap-1">
											<Switch
												checked={server.enabled}
												onCheckedChange={() =>
													void handleToggle(server.id, server.enabled)
												}
											/>
											<Button
												variant="ghost"
												size="icon"
												className="h-7 w-7"
												disabled={busyId === server.id}
												onClick={() => void handleSync(server.id)}
											>
												<RefreshCw className="h-3.5 w-3.5" />
											</Button>
											<Button
												variant="ghost"
												size="icon"
												className="h-7 w-7 text-muted-foreground hover:text-destructive"
												disabled={busyId === server.id}
												onClick={() => void handleRemove(server.id)}
											>
												<Trash2 className="h-3.5 w-3.5" />
											</Button>
										</div>
									</div>
									{server.error && (
										<p className="pl-4 text-xs text-destructive">
											{server.error}
										</p>
									)}
								</div>
							))
						)}
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}
