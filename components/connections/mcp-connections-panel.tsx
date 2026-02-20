"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api-client";
import {
	McpConnectionSourceType,
	type McpConnection,
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

export function McpConnectionsPanel() {
	const [rows, setRows] = useState<McpConnection[]>([]);
	const [loading, setLoading] = useState(true);
	const [busyId, setBusyId] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setLoading(true);
			const result = await api.mcpConnection.list();
			setRows(result.data);
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

	const onSetStatus = async (id: string, status: "ENABLED" | "DISABLED") => {
		try {
			setBusyId(id);
			await api.mcpConnection.setStatus(id, status);
			await load();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update status",
			);
		} finally {
			setBusyId(null);
		}
	};

	const onSync = async (id: string) => {
		try {
			setBusyId(id);
			await api.mcpConnection.sync(id);
			await load();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to sync");
		} finally {
			setBusyId(null);
		}
	};

	const onDelete = async (id: string) => {
		const target = rows.find((row) => row.id === id);
		if (target?.sourceType === McpConnectionSourceType.HOSTED_WORKFLOW) {
			toast.error("Hosted workflow MCP connection cannot be deleted");
			return;
		}
		try {
			setBusyId(id);
			await api.mcpConnection.delete(id);
			await load();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to delete");
		} finally {
			setBusyId(null);
		}
	};

	return (
		<div className="rounded-md border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Name</TableHead>
						<TableHead>Source</TableHead>
						<TableHead>Status</TableHead>
						<TableHead>Server URL</TableHead>
						<TableHead className="w-[220px] text-right">Actions</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{loading ? (
						<TableRow>
							<TableCell className="text-muted-foreground" colSpan={5}>
								Loading MCP connections...
							</TableCell>
						</TableRow>
					) : rows.length === 0 ? (
						<TableRow>
							<TableCell className="text-muted-foreground" colSpan={5}>
								No MCP connections. Add them in Settings &gt; MCP Connections.
							</TableCell>
						</TableRow>
					) : (
						rows.map((row) => {
							const isHosted =
								row.sourceType === McpConnectionSourceType.HOSTED_WORKFLOW;
							return (
								<TableRow key={row.id}>
									<TableCell className="font-medium">
										{row.displayName}
									</TableCell>
									<TableCell>{row.sourceType}</TableCell>
									<TableCell>{statusBadge(row.status)}</TableCell>
									<TableCell className="font-mono text-xs">
										{row.serverUrl ?? "—"}
									</TableCell>
									<TableCell className="text-right">
										<div className="flex justify-end gap-1">
											<Button
												disabled={busyId === row.id}
												onClick={() => onSync(row.id)}
												size="icon"
												type="button"
												variant="ghost"
											>
												<RefreshCw className="size-4" />
											</Button>
											<Button
												disabled={busyId === row.id}
												onClick={() =>
													onSetStatus(
														row.id,
														row.status === "ENABLED" ? "DISABLED" : "ENABLED",
													)
												}
												size="sm"
												type="button"
												variant="outline"
											>
												{row.status === "ENABLED" ? "Disable" : "Enable"}
											</Button>
											<Button
												className="text-destructive"
												disabled={busyId === row.id || isHosted}
												onClick={() => onDelete(row.id)}
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
	);
}
