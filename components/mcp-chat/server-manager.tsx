"use client";

import { useState, useCallback } from "react";
import { useAtom } from "jotai";
import {
	mcpServersAtom,
	addServer,
	removeServer,
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
import { Server, Trash2, Plus, Loader2, Search } from "lucide-react";

type DiscoveredServer = {
	name: string;
	pieceName: string;
	url: string;
	connectionExternalId: string;
	healthy: boolean;
	toolCount: number;
	toolNames: string[];
};

export function ServerManager() {
	const [servers, setServers] = useAtom(mcpServersAtom);
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [testing, setTesting] = useState(false);
	const [addError, setAddError] = useState<string | null>(null);
	const [discovering, setDiscovering] = useState(false);
	const [discovered, setDiscovered] = useState<DiscoveredServer[]>([]);
	const [discoverError, setDiscoverError] = useState<string | null>(null);

	const handleAdd = useCallback(async () => {
		const trimmedUrl = url.trim();
		const trimmedName = name.trim() || new URL(trimmedUrl).hostname;

		if (!trimmedUrl) return;

		setTesting(true);
		setAddError(null);

		const id = addServer(setServers, {
			name: trimmedName,
			url: trimmedUrl,
		});

		updateServerStatus(setServers, id, "connecting");

		try {
			const res = await fetch("/api/mcp-chat/servers/test", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: trimmedUrl }),
			});

			const data = await res.json();

			if (!res.ok) {
				updateServerStatus(setServers, id, "error", {
					error: data.error || "Connection failed",
				});
				setAddError(data.error || "Connection failed");
			} else {
				updateServerStatus(setServers, id, "connected", {
					toolCount: data.tools.length,
					tools: data.tools,
				});
				setUrl("");
				setName("");
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Connection failed";
			updateServerStatus(setServers, id, "error", { error: msg });
			setAddError(msg);
		} finally {
			setTesting(false);
		}
	}, [url, name, setServers]);

	const handleDiscover = useCallback(async () => {
		setDiscovering(true);
		setDiscoverError(null);
		setDiscovered([]);

		try {
			const res = await fetch("/api/mcp-chat/servers/discover");
			const data = await res.json();

			if (!res.ok) {
				setDiscoverError(data.error || "Discovery failed");
				return;
			}

			// Filter out servers already added
			const existingUrls = new Set(servers.map((s) => s.url));
			const newServers = (data.servers as DiscoveredServer[]).filter(
				(s) => !existingUrls.has(s.url),
			);
			setDiscovered(newServers);
		} catch (err) {
			setDiscoverError(
				err instanceof Error ? err.message : "Discovery failed",
			);
		} finally {
			setDiscovering(false);
		}
	}, [servers]);

	const handleAddDiscovered = useCallback(
		(server: DiscoveredServer) => {
			const id = addServer(setServers, {
				name: server.name,
				url: server.url,
			});
			updateServerStatus(setServers, id, "connected", {
				toolCount: server.toolCount,
				tools: server.toolNames.map((n) => ({ name: n })),
			});
			setDiscovered((prev) => prev.filter((s) => s.url !== server.url));
		},
		[setServers],
	);

	const handleRemove = useCallback(
		(id: string) => {
			removeServer(setServers, id);
		},
		[setServers],
	);

	const handleToggle = useCallback(
		(id: string) => {
			toggleServer(setServers, id);
		},
		[setServers],
	);

	const enabledCount = servers.filter((s) => s.enabled).length;

	return (
		<Sheet>
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
			<SheetContent className="w-[400px] sm:w-[440px]">
				<SheetHeader>
					<SheetTitle>MCP Servers</SheetTitle>
				</SheetHeader>

				<div className="mt-6 space-y-6">
					{/* Discover Piece Servers */}
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-medium">Piece Servers</h3>
							<Button
								variant="outline"
								size="sm"
								onClick={handleDiscover}
								disabled={discovering}
								className="gap-1.5 text-xs"
							>
								{discovering ? (
									<Loader2 className="h-3 w-3 animate-spin" />
								) : (
									<Search className="h-3 w-3" />
								)}
								{discovering ? "Scanning..." : "Discover"}
							</Button>
						</div>
						{discoverError && (
							<p className="text-xs text-destructive">{discoverError}</p>
						)}
						{discovered.length > 0 && (
							<div className="space-y-2">
								{discovered.map((server) => (
									<div
										key={server.url}
										className="flex items-center justify-between rounded-lg border border-dashed bg-muted/50 p-2.5"
									>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
												<span className="text-sm font-medium truncate">
													{server.name}
												</span>
												<Badge
													variant="secondary"
													className="shrink-0 px-1.5 py-0 text-[10px]"
												>
													{server.toolCount} tools
												</Badge>
											</div>
										</div>
										<Button
											size="sm"
											variant="outline"
											onClick={() => handleAddDiscovered(server)}
											className="ml-2 gap-1 text-xs"
										>
											<Plus className="h-3 w-3" />
											Add
										</Button>
									</div>
								))}
							</div>
						)}
						{!discovering &&
							discovered.length === 0 &&
							discoverError === null && (
								<p className="text-xs text-muted-foreground">
									Click Discover to find piece MCP servers with active
									connections.
								</p>
							)}
					</div>

					{/* Manual Add Server Form */}
					<div className="space-y-3">
						<h3 className="text-sm font-medium">Add Custom Server</h3>
						<div className="space-y-2">
							<Input
								placeholder="Server URL (e.g. http://localhost:3001/mcp)"
								value={url}
								onChange={(e) => {
									setUrl(e.target.value);
									setAddError(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && url.trim()) handleAdd();
								}}
							/>
							<Input
								placeholder="Display name (optional)"
								value={name}
								onChange={(e) => setName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && url.trim()) handleAdd();
								}}
							/>
						</div>
						<Button
							onClick={handleAdd}
							disabled={!url.trim() || testing}
							size="sm"
							className="w-full gap-1.5"
						>
							{testing ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Plus className="h-3.5 w-3.5" />
							)}
							{testing ? "Connecting..." : "Add Server"}
						</Button>
						{addError && <p className="text-xs text-destructive">{addError}</p>}
					</div>

					{/* Server List */}
					{servers.length === 0 ? (
						<div className="py-8 text-center text-sm text-muted-foreground">
							No MCP servers configured.
							<br />
							Add one above or discover piece servers.
						</div>
					) : (
						<div className="space-y-3">
							<h3 className="text-sm font-medium">
								Active Servers ({servers.length})
							</h3>
							{servers.map((server) => (
								<div
									key={server.id}
									className="rounded-lg border bg-card p-3 space-y-2"
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
												<span className="text-sm font-medium truncate">
													{server.name}
												</span>
												{server.toolCount > 0 && (
													<Badge
														variant="secondary"
														className="shrink-0 px-1.5 py-0 text-[10px]"
													>
														{server.toolCount} tool
														{server.toolCount !== 1 ? "s" : ""}
													</Badge>
												)}
											</div>
											<p className="mt-0.5 truncate text-xs text-muted-foreground pl-4">
												{server.url}
											</p>
										</div>
										<div className="flex items-center gap-1.5 shrink-0">
											<Switch
												checked={server.enabled}
												onCheckedChange={() => handleToggle(server.id)}
											/>
											<Button
												variant="ghost"
												size="icon"
												className="h-7 w-7 text-muted-foreground hover:text-destructive"
												onClick={() => handleRemove(server.id)}
											>
												<Trash2 className="h-3.5 w-3.5" />
											</Button>
										</div>
									</div>
									{server.error && (
										<p className="text-xs text-destructive pl-4">
											{server.error}
										</p>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
