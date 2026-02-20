"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
	CloudCog,
	ExternalLink,
	Loader2,
	RefreshCw,
	Server,
	Wrench,
} from "lucide-react";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-client";
import {
	McpConnectionSourceType,
	type McpConnection,
	type McpConnectionCatalogItem,
} from "@/lib/types/mcp-connection";

type ServerManagerProps = {
	connections: McpConnection[];
	catalog: McpConnectionCatalogItem[];
	loading: boolean;
	loadError: string | null;
	onRefresh: () => Promise<void>;
};

function sourceBadge(sourceType: McpConnection["sourceType"]) {
	if (sourceType === McpConnectionSourceType.HOSTED_WORKFLOW) {
		return <Badge variant="secondary">Hosted</Badge>;
	}
	if (sourceType === McpConnectionSourceType.NIMBLE_PIECE) {
		return <Badge variant="outline">Piece</Badge>;
	}
	return <Badge variant="outline">Custom</Badge>;
}

function statusBadge(status: McpConnection["status"]) {
	if (status === "ENABLED") {
		return (
			<Badge className="bg-emerald-500/10 text-emerald-600">Enabled</Badge>
		);
	}
	if (status === "ERROR") {
		return <Badge variant="destructive">Error</Badge>;
	}
	return <Badge variant="secondary">Disabled</Badge>;
}

function getToolCount(connection: McpConnection): number {
	const metadata = connection.metadata as Record<string, unknown> | null;
	const raw = metadata?.toolCount;
	return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function sortManagedConnections(left: McpConnection, right: McpConnection) {
	const order = (row: McpConnection) =>
		row.sourceType === McpConnectionSourceType.HOSTED_WORKFLOW ? 0 : 1;
	const bySource = order(left) - order(right);
	if (bySource !== 0) {
		return bySource;
	}
	return left.displayName.localeCompare(right.displayName);
}

export function ServerManager({
	connections,
	catalog,
	loading,
	loadError,
	onRefresh,
}: ServerManagerProps) {
	const [busyId, setBusyId] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const sortedConnections = useMemo(
		() => [...connections].sort(sortManagedConnections),
		[connections],
	);
	const enableableCatalog = useMemo(
		() =>
			catalog
				.filter((item) => !item.enabled && item.hasActiveConnections)
				.sort((left, right) => {
					if (right.activeConnectionCount !== left.activeConnectionCount) {
						return right.activeConnectionCount - left.activeConnectionCount;
					}
					return left.displayName.localeCompare(right.displayName);
				}),
		[catalog],
	);

	const enabledCount = connections.filter(
		(row) => row.status === "ENABLED",
	).length;
	const errorCount = connections.filter((row) => row.status === "ERROR").length;

	const handleRefresh = useCallback(async () => {
		setActionError(null);
		await onRefresh();
	}, [onRefresh]);

	const handleEnablePiece = useCallback(
		async (pieceName: string) => {
			try {
				setBusyId(`enable:${pieceName}`);
				setActionError(null);
				const created = await api.mcpConnection.create({
					sourceType: McpConnectionSourceType.NIMBLE_PIECE,
					pieceName,
				});
				await api.mcpConnection.sync(created.id);
				await onRefresh();
			} catch (error) {
				setActionError(
					error instanceof Error ? error.message : "Failed to enable piece MCP",
				);
			} finally {
				setBusyId(null);
			}
		},
		[onRefresh],
	);

	const handleToggle = useCallback(
		async (row: McpConnection) => {
			try {
				setBusyId(row.id);
				setActionError(null);
				const nextStatus = row.status === "ENABLED" ? "DISABLED" : "ENABLED";
				await api.mcpConnection.setStatus(row.id, nextStatus);
				await onRefresh();
			} catch (error) {
				setActionError(
					error instanceof Error
						? error.message
						: "Failed to update connection status",
				);
			} finally {
				setBusyId(null);
			}
		},
		[onRefresh],
	);

	const handleSync = useCallback(
		async (connectionId: string) => {
			try {
				setBusyId(`sync:${connectionId}`);
				setActionError(null);
				await api.mcpConnection.sync(connectionId);
				await onRefresh();
			} catch (error) {
				setActionError(
					error instanceof Error ? error.message : "Failed to sync",
				);
			} finally {
				setBusyId(null);
			}
		},
		[onRefresh],
	);

	return (
		<Sheet
			onOpenChange={(open) => {
				if (open) {
					void handleRefresh();
				}
			}}
		>
			<SheetTrigger asChild>
				<Button variant="outline" size="sm" className="gap-1.5 text-xs">
					<span className="relative">
						<Server className="h-3.5 w-3.5" />
						<span
							className={cn(
								"absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-background",
								errorCount > 0
									? "bg-destructive"
									: enabledCount > 0
										? "bg-emerald-500"
										: "bg-muted-foreground/40",
							)}
						/>
					</span>
					<span className="hidden sm:inline">Servers</span>
					{enabledCount > 0 && (
						<Badge
							variant="secondary"
							className="ml-0.5 px-1.5 py-0 text-[10px]"
						>
							{enabledCount}
						</Badge>
					)}
					{errorCount > 0 && (
						<Badge className="bg-destructive text-[10px]">{errorCount}</Badge>
					)}
				</Button>
			</SheetTrigger>

			<SheetContent className="w-[440px] sm:w-[520px]">
				<SheetHeader>
					<SheetTitle>MCP Servers</SheetTitle>
				</SheetHeader>

				<div className="mt-6 space-y-6">
					<div className="flex items-center justify-between gap-2">
						<div className="text-xs text-muted-foreground">
							Project-level MCP connections used by MCP Chat.
						</div>
						<Button
							variant="outline"
							size="sm"
							className="gap-1.5 text-xs"
							onClick={() => void handleRefresh()}
							disabled={loading}
						>
							{loading ? (
								<Loader2 className="h-3 w-3 animate-spin" />
							) : (
								<RefreshCw className="h-3 w-3" />
							)}
							Refresh
						</Button>
					</div>

					{(loadError || actionError) && (
						<p className="text-xs text-destructive">
							{actionError ?? loadError}
						</p>
					)}

					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-medium">
								Managed Servers ({sortedConnections.length})
							</h3>
							<Button
								asChild
								size="sm"
								variant="ghost"
								className="gap-1 text-xs"
							>
								<Link href="/settings/mcp-connections">
									Manage Details
									<ExternalLink className="h-3 w-3" />
								</Link>
							</Button>
						</div>
						{loading ? (
							<p className="text-xs text-muted-foreground">
								Loading servers...
							</p>
						) : sortedConnections.length === 0 ? (
							<div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
								No managed MCP servers yet.
							</div>
						) : (
							<div className="space-y-2">
								{sortedConnections.map((row) => {
									const isBusy =
										busyId === row.id || busyId === `sync:${row.id}`;
									const toolCount = getToolCount(row);
									return (
										<div
											key={row.id}
											className="space-y-2 rounded-lg border p-3"
										>
											<div className="flex items-start justify-between gap-3">
												<div className="min-w-0 flex-1">
													<div className="flex flex-wrap items-center gap-2">
														<div className="truncate text-sm font-medium">
															{row.displayName}
														</div>
														{sourceBadge(row.sourceType)}
														{statusBadge(row.status)}
													</div>
													<p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
														{row.serverUrl ?? "No server URL yet"}
													</p>
													<div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
														<span>{toolCount} tools</span>
														{row.lastSyncAt && (
															<span>
																Synced{" "}
																{new Date(row.lastSyncAt).toLocaleString()}
															</span>
														)}
													</div>
												</div>
												<div className="flex shrink-0 items-center gap-1">
													<Tooltip>
														<TooltipTrigger asChild>
															<div>
																<Switch
																	checked={row.status === "ENABLED"}
																	disabled={isBusy}
																	onCheckedChange={() => void handleToggle(row)}
																/>
															</div>
														</TooltipTrigger>
														<TooltipContent side="top">
															{row.status === "ENABLED" ? "Disable server" : "Enable server"}
														</TooltipContent>
													</Tooltip>
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																variant="ghost"
																size="icon"
																className="h-7 w-7"
																disabled={isBusy}
																onClick={() => void handleSync(row.id)}
															>
																{busyId === `sync:${row.id}` ? (
																	<Loader2 className="h-3.5 w-3.5 animate-spin" />
																) : (
																	<RefreshCw className="h-3.5 w-3.5" />
																)}
															</Button>
														</TooltipTrigger>
														<TooltipContent side="top">Sync tools</TooltipContent>
													</Tooltip>
												</div>
											</div>
											{row.lastError && (
												<p className="text-xs text-destructive">
													{row.lastError}
												</p>
											)}
										</div>
									);
								})}
							</div>
						)}
					</div>

					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<CloudCog className="h-4 w-4 text-muted-foreground" />
							<h3 className="text-sm font-medium">Available to Enable</h3>
						</div>
						{loading ? (
							<p className="text-xs text-muted-foreground">
								Loading catalog...
							</p>
						) : enableableCatalog.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								No additional pieces with active app connections are available.
							</p>
						) : (
							<div className="space-y-2">
								{enableableCatalog.map((item) => (
									<div
										key={item.pieceName}
										className="flex items-center justify-between rounded-lg border border-dashed bg-muted/40 p-2.5"
									>
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm font-medium">
												{item.displayName}
											</div>
											<div className="flex items-center gap-2 text-xs text-muted-foreground">
												<Wrench className="h-3 w-3" />
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
											{busyId === `enable:${item.pieceName}` ? (
												<Loader2 className="h-3 w-3 animate-spin" />
											) : null}
											Enable
										</Button>
									</div>
								))}
							</div>
						)}
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}
