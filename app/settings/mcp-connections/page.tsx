"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsSubnav } from "@/components/settings/settings-subnav";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api-client";
import {
	McpConnectionSourceType,
	type McpConnection,
	type McpConnectionCatalogItem,
} from "@/lib/types/mcp-connection";

function statusBadge(status: string) {
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

export default function McpConnectionsSettingsPage() {
	const [loading, setLoading] = useState(true);
	const [catalog, setCatalog] = useState<McpConnectionCatalogItem[]>([]);
	const [connections, setConnections] = useState<McpConnection[]>([]);
	const [search, setSearch] = useState("");
	const [customName, setCustomName] = useState("");
	const [customUrl, setCustomUrl] = useState("");
	const [submittingCustom, setSubmittingCustom] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setLoading(true);
			const [catalogResult, connectionsResult] = await Promise.all([
				api.mcpConnection.catalog(),
				api.mcpConnection.list(),
			]);
			setCatalog(catalogResult.data);
			setConnections(connectionsResult.data);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to load MCP connections",
			);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const filteredCatalog = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return catalog;
		return catalog.filter(
			(item) =>
				item.displayName.toLowerCase().includes(q) ||
				item.pieceName.toLowerCase().includes(q),
		);
	}, [catalog, search]);

	const handleEnablePiece = async (pieceName: string) => {
		try {
			setBusyId(`enable:${pieceName}`);
			await api.mcpConnection.create({
				sourceType: McpConnectionSourceType.NIMBLE_PIECE,
				pieceName,
			});
			toast.success(`Enabled MCP for ${pieceName}`);
			await load();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to enable MCP server",
			);
		} finally {
			setBusyId(null);
		}
	};

	const handleSetStatus = async (
		connectionId: string,
		status: "ENABLED" | "DISABLED",
	) => {
		try {
			setBusyId(connectionId);
			await api.mcpConnection.setStatus(connectionId, status);
			await load();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update status",
			);
		} finally {
			setBusyId(null);
		}
	};

	const handleSync = async (connectionId: string) => {
		try {
			setBusyId(connectionId);
			await api.mcpConnection.sync(connectionId);
			await load();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to sync");
		} finally {
			setBusyId(null);
		}
	};

	const handleDelete = async (connectionId: string) => {
		const target = connections.find((conn) => conn.id === connectionId);
		if (target?.sourceType === McpConnectionSourceType.HOSTED_WORKFLOW) {
			toast.error("Hosted workflow MCP connection cannot be deleted");
			return;
		}
		try {
			setBusyId(connectionId);
			await api.mcpConnection.delete(connectionId);
			await load();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to delete");
		} finally {
			setBusyId(null);
		}
	};

	const handleCreateCustom = async () => {
		if (!customName.trim() || !customUrl.trim()) {
			toast.error("Custom name and URL are required");
			return;
		}
		try {
			setSubmittingCustom(true);
			await api.mcpConnection.create({
				sourceType: McpConnectionSourceType.CUSTOM_URL,
				displayName: customName.trim(),
				serverUrl: customUrl.trim(),
			});
			setCustomName("");
			setCustomUrl("");
			toast.success("Custom MCP connection added");
			await load();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to add custom MCP",
			);
		} finally {
			setSubmittingCustom(false);
		}
	};

	return (
		<div className="pointer-events-auto flex h-full flex-col bg-background">
			<div className="flex items-center gap-2 border-b px-6 py-4">
				<SidebarToggle />
				<div>
					<h1 className="font-semibold text-xl">MCP Connections</h1>
					<p className="text-muted-foreground text-sm">
						Manage project-scoped MCP servers separately from workflow app
						connections.
					</p>
				</div>
			</div>
			<SettingsSubnav />

			<div className="flex-1 space-y-8 overflow-auto p-6">
				<div className="space-y-3 rounded-md border p-4">
					<h2 className="font-medium">Add Custom MCP Server</h2>
					<div className="grid gap-3 md:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="custom-mcp-name">Display Name</Label>
							<Input
								id="custom-mcp-name"
								onChange={(event) => setCustomName(event.target.value)}
								placeholder="My Internal MCP"
								value={customName}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="custom-mcp-url">MCP URL</Label>
							<Input
								id="custom-mcp-url"
								onChange={(event) => setCustomUrl(event.target.value)}
								placeholder="http://mcp-service:3100/mcp"
								value={customUrl}
							/>
						</div>
					</div>
					<Button
						className="gap-2"
						disabled={submittingCustom}
						onClick={handleCreateCustom}
						type="button"
					>
						{submittingCustom ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Plus className="size-4" />
						)}
						Add Custom MCP
					</Button>
				</div>

				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<h2 className="font-medium">Piece MCP Catalog</h2>
						<Input
							className="w-72"
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search pieces..."
							value={search}
						/>
					</div>
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Piece</TableHead>
									<TableHead>Active App Connections</TableHead>
									<TableHead>OAuth App</TableHead>
									<TableHead>Runtime</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="w-[140px]" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{loading ? (
									<TableRow>
										<TableCell className="text-muted-foreground" colSpan={6}>
											Loading catalog...
										</TableCell>
									</TableRow>
								) : filteredCatalog.length === 0 ? (
									<TableRow>
										<TableCell className="text-muted-foreground" colSpan={6}>
											No pieces found
										</TableCell>
									</TableRow>
								) : (
									filteredCatalog.map((item) => (
										<TableRow key={item.pieceName}>
											<TableCell>
												<div className="flex items-center gap-2">
													{item.logoUrl ? (
														<img
															alt=""
															className="size-5 rounded"
															src={item.logoUrl}
														/>
													) : null}
													<div>
														<div className="font-medium text-sm">
															{item.displayName}
														</div>
														<div className="text-muted-foreground text-xs">
															{item.pieceName}
														</div>
													</div>
												</div>
											</TableCell>
											<TableCell>{item.activeConnectionCount}</TableCell>
											<TableCell>
												{item.oauthConfigured ? (
													<Badge variant="secondary">Configured</Badge>
												) : (
													<span className="text-muted-foreground text-xs">
														—
													</span>
												)}
											</TableCell>
											<TableCell>
												{item.runtimeAvailable ? (
													<Badge className="bg-emerald-500/10 text-emerald-600">
														Available
													</Badge>
												) : (
													<Badge variant="outline">Unknown</Badge>
												)}
											</TableCell>
											<TableCell>
												{item.enabled ? (
													<Badge className="bg-emerald-500/10 text-emerald-600">
														Enabled
													</Badge>
												) : (
													<Badge variant="secondary">Disabled</Badge>
												)}
											</TableCell>
											<TableCell className="text-right">
												{item.enabled ? (
													<Button
														disabled={
															!item.connectionId || busyId === item.connectionId
														}
														onClick={() =>
															item.connectionId
																? handleSetStatus(item.connectionId, "DISABLED")
																: undefined
														}
														size="sm"
														type="button"
														variant="outline"
													>
														Disable
													</Button>
												) : (
													<Button
														disabled={busyId === `enable:${item.pieceName}`}
														onClick={() => handleEnablePiece(item.pieceName)}
														size="sm"
														type="button"
													>
														Enable
													</Button>
												)}
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</div>

				<div className="space-y-3">
					<h2 className="font-medium">Managed MCP Connections</h2>
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Source</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Server URL</TableHead>
									<TableHead className="w-[180px] text-right">
										Actions
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{loading ? (
									<TableRow>
										<TableCell className="text-muted-foreground" colSpan={5}>
											Loading connections...
										</TableCell>
									</TableRow>
								) : connections.length === 0 ? (
									<TableRow>
										<TableCell className="text-muted-foreground" colSpan={5}>
											No MCP connections yet
										</TableCell>
									</TableRow>
								) : (
									connections.map((conn) => {
										const isHosted =
											conn.sourceType ===
											McpConnectionSourceType.HOSTED_WORKFLOW;
										return (
											<TableRow key={conn.id}>
												<TableCell className="font-medium">
													{conn.displayName}
												</TableCell>
												<TableCell>{conn.sourceType}</TableCell>
												<TableCell>{statusBadge(conn.status)}</TableCell>
												<TableCell className="font-mono text-xs">
													{conn.serverUrl ?? "—"}
												</TableCell>
												<TableCell className="text-right">
													<div className="flex justify-end gap-1">
														<Button
															disabled={busyId === conn.id}
															onClick={() => handleSync(conn.id)}
															size="icon"
															type="button"
															variant="ghost"
														>
															<RefreshCw className="size-4" />
														</Button>
														<Button
															disabled={busyId === conn.id}
															onClick={() =>
																handleSetStatus(
																	conn.id,
																	conn.status === "ENABLED"
																		? "DISABLED"
																		: "ENABLED",
																)
															}
															size="sm"
															type="button"
															variant="outline"
														>
															{conn.status === "ENABLED" ? "Disable" : "Enable"}
														</Button>
														<Button
															className="text-destructive"
															disabled={busyId === conn.id || isHosted}
															onClick={() => handleDelete(conn.id)}
															size="icon"
															title={
																isHosted
																	? "Hosted workflow MCP connection cannot be deleted"
																	: "Delete"
															}
															type="button"
															variant="ghost"
														>
															<Trash2 className="size-4" />
														</Button>
													</div>
												</TableCell>
											</TableRow>
										);
									})
								)}
							</TableBody>
						</Table>
					</div>
				</div>
			</div>
		</div>
	);
}
