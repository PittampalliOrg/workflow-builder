"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type ColumnDef,
	type ColumnFiltersState,
	type RowSelectionState,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	useReactTable,
} from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import {
	MoreHorizontal,
	Plus,
	Search,
	RefreshCw,
	Pencil,
	Trash2,
	Plug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
	api,
	type AppConnection,
	type PieceMetadataSummary,
} from "@/lib/api-client";
import { AppConnectionStatus } from "@/lib/types/app-connection";
import { ConnectionStatusBadge } from "./connection-status-badge";
import { NewConnectionDialog } from "./new-connection-dialog";
import { RenameConnectionDialog } from "./rename-connection-dialog";
import { DeleteConnectionDialog } from "./delete-connection-dialog";

type ConnectionRow = AppConnection & {
	pieceDisplayName?: string;
	pieceLogoUrl?: string;
};

export function ConnectionsTable() {
	const [connections, setConnections] = useState<ConnectionRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [searchQuery, setSearchQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
	const [piecesMap, setPiecesMap] = useState<Map<string, PieceMetadataSummary>>(
		new Map(),
	);

	// Dialog states
	const [newDialogOpen, setNewDialogOpen] = useState(false);
	const [renameDialog, setRenameDialog] = useState<{
		open: boolean;
		id: string;
		name: string;
	}>({ open: false, id: "", name: "" });
	const [deleteDialog, setDeleteDialog] = useState<{
		open: boolean;
		id?: string;
		name?: string;
		ids?: string[];
	}>({ open: false });
	const [reconnectPiece, setReconnectPiece] = useState<
		PieceMetadataSummary | undefined
	>();

	const fetchConnections = useCallback(async () => {
		try {
			setLoading(true);
			const [connectionsResult, pieces] = await Promise.all([
				api.appConnection.list(),
				api.piece.list(),
			]);

			const map = new Map<string, PieceMetadataSummary>();
			for (const piece of pieces) {
				map.set(piece.name, piece);
			}
			setPiecesMap(map);

			const rows: ConnectionRow[] = connectionsResult.data.map((conn) => {
				const piece = map.get(conn.pieceName);
				return {
					...conn,
					pieceDisplayName: piece?.displayName ?? conn.pieceName,
					pieceLogoUrl: piece?.logoUrl,
				};
			});

			setConnections(rows);
		} catch (error) {
			console.error("Failed to fetch connections:", error);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchConnections();
	}, [fetchConnections]);

	const columns: ColumnDef<ConnectionRow>[] = useMemo(
		() => [
			{
				id: "select",
				header: ({ table }) => (
					<Checkbox
						checked={
							table.getIsAllPageRowsSelected() ||
							(table.getIsSomePageRowsSelected() && "indeterminate")
						}
						onCheckedChange={(value) =>
							table.toggleAllPageRowsSelected(!!value)
						}
						aria-label="Select all"
					/>
				),
				cell: ({ row }) => (
					<Checkbox
						checked={row.getIsSelected()}
						onCheckedChange={(value) => row.toggleSelected(!!value)}
						aria-label="Select row"
					/>
				),
				enableSorting: false,
				enableHiding: false,
				size: 40,
			},
			{
				accessorKey: "pieceName",
				header: "App",
				cell: ({ row }) => {
					const logoUrl = row.original.pieceLogoUrl;
					const displayName = row.original.pieceDisplayName;
					return (
						<div className="flex items-center gap-2">
							{logoUrl ? (
								<img
									src={logoUrl}
									alt={displayName}
									className="h-6 w-6 rounded"
								/>
							) : (
								<div className="flex h-6 w-6 items-center justify-center rounded bg-muted">
									<Plug className="h-3 w-3 text-muted-foreground" />
								</div>
							)}
							<span className="text-sm font-medium">{displayName}</span>
						</div>
					);
				},
			},
			{
				accessorKey: "displayName",
				header: "Name",
				cell: ({ row }) => (
					<span className="text-sm">{row.original.displayName}</span>
				),
			},
			{
				accessorKey: "status",
				header: "Status",
				cell: ({ row }) => (
					<ConnectionStatusBadge
						status={row.original.status as AppConnectionStatus}
					/>
				),
				filterFn: (row, _id, filterValue) => {
					if (filterValue === "all") return true;
					return row.original.status === filterValue;
				},
			},
			{
				accessorKey: "createdAt",
				header: "Created",
				cell: ({ row }) => {
					const date = new Date(row.original.createdAt);
					return (
						<span className="text-sm text-muted-foreground">
							{formatDistanceToNow(date, { addSuffix: true })}
						</span>
					);
				},
			},
			{
				id: "actions",
				cell: ({ row }) => {
					const conn = row.original;
					return (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" className="h-8 w-8 p-0">
									<MoreHorizontal className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={() => {
										const piece = piecesMap.get(conn.pieceName);
										setReconnectPiece(piece);
										setNewDialogOpen(true);
									}}
								>
									<RefreshCw className="mr-2 h-4 w-4" />
									Reconnect
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() =>
										setRenameDialog({
											open: true,
											id: conn.id,
											name: conn.displayName,
										})
									}
								>
									<Pencil className="mr-2 h-4 w-4" />
									Rename
								</DropdownMenuItem>
								<DropdownMenuItem
									className="text-destructive"
									onClick={() =>
										setDeleteDialog({
											open: true,
											id: conn.id,
											name: conn.displayName,
										})
									}
								>
									<Trash2 className="mr-2 h-4 w-4" />
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					);
				},
				size: 50,
			},
		],
		[piecesMap],
	);

	const filteredData = useMemo(() => {
		let data = connections;
		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			data = data.filter(
				(c) =>
					c.displayName.toLowerCase().includes(q) ||
					(c.pieceDisplayName?.toLowerCase().includes(q) ?? false),
			);
		}
		if (statusFilter !== "all") {
			data = data.filter((c) => c.status === statusFilter);
		}
		return data;
	}, [connections, searchQuery, statusFilter]);

	const table = useReactTable({
		data: filteredData,
		columns,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		onRowSelectionChange: setRowSelection,
		state: { rowSelection },
		getRowId: (row) => row.id,
	});

	const selectedIds = Object.keys(rowSelection);
	const hasSelection = selectedIds.length > 0;

	const handleBulkDelete = () => {
		setDeleteDialog({ open: true, ids: selectedIds });
	};

	const handleDialogSuccess = () => {
		setRowSelection({});
		fetchConnections();
	};

	if (loading) {
		return (
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<Skeleton className="h-10 w-64" />
					<Skeleton className="h-10 w-36" />
				</div>
				<div className="space-y-2">
					{Array.from({ length: 5 }).map((_, i) => (
						<Skeleton key={i} className="h-12 w-full" />
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* Toolbar */}
			<div className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-2 flex-1">
					<div className="relative max-w-sm flex-1">
						<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							placeholder="Search connections..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-9"
						/>
					</div>
					<Select value={statusFilter} onValueChange={setStatusFilter}>
						<SelectTrigger className="w-[140px]">
							<SelectValue placeholder="Status" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All Status</SelectItem>
							<SelectItem value={AppConnectionStatus.ACTIVE}>Active</SelectItem>
							<SelectItem value={AppConnectionStatus.ERROR}>Error</SelectItem>
							<SelectItem value={AppConnectionStatus.MISSING}>
								Missing
							</SelectItem>
						</SelectContent>
					</Select>
					{hasSelection && (
						<Button variant="destructive" size="sm" onClick={handleBulkDelete}>
							<Trash2 className="mr-2 h-4 w-4" />
							Delete ({selectedIds.length})
						</Button>
					)}
				</div>
				<Button
					onClick={() => {
						setReconnectPiece(undefined);
						setNewDialogOpen(true);
					}}
				>
					<Plus className="mr-2 h-4 w-4" />
					New Connection
				</Button>
			</div>

			{/* Table */}
			{filteredData.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16">
					<Plug className="mb-4 h-12 w-12 text-muted-foreground/50" />
					<h3 className="text-lg font-medium">No connections yet</h3>
					<p className="mt-1 text-sm text-muted-foreground">
						Connect your apps and services to use them in workflows.
					</p>
					<Button
						className="mt-4"
						onClick={() => {
							setReconnectPiece(undefined);
							setNewDialogOpen(true);
						}}
					>
						<Plus className="mr-2 h-4 w-4" />
						Add your first connection
					</Button>
				</div>
			) : (
				<div className="rounded-md border">
					<Table>
						<TableHeader>
							{table.getHeaderGroups().map((headerGroup) => (
								<TableRow key={headerGroup.id}>
									{headerGroup.headers.map((header) => (
										<TableHead key={header.id}>
											{header.isPlaceholder
												? null
												: flexRender(
														header.column.columnDef.header,
														header.getContext(),
													)}
										</TableHead>
									))}
								</TableRow>
							))}
						</TableHeader>
						<TableBody>
							{table.getRowModel().rows.map((row) => (
								<TableRow
									key={row.id}
									data-state={row.getIsSelected() && "selected"}
								>
									{row.getVisibleCells().map((cell) => (
										<TableCell key={cell.id}>
											{flexRender(
												cell.column.columnDef.cell,
												cell.getContext(),
											)}
										</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}

			{/* Dialogs */}
			<NewConnectionDialog
				open={newDialogOpen}
				onOpenChange={(open) => {
					setNewDialogOpen(open);
					if (!open) setReconnectPiece(undefined);
				}}
				onSuccess={handleDialogSuccess}
				preselectedPiece={reconnectPiece}
			/>
			<RenameConnectionDialog
				open={renameDialog.open}
				onOpenChange={(open) => setRenameDialog((prev) => ({ ...prev, open }))}
				connectionId={renameDialog.id}
				currentName={renameDialog.name}
				onSuccess={handleDialogSuccess}
			/>
			<DeleteConnectionDialog
				open={deleteDialog.open}
				onOpenChange={(open) => setDeleteDialog((prev) => ({ ...prev, open }))}
				connectionId={deleteDialog.id}
				connectionName={deleteDialog.name}
				connectionIds={deleteDialog.ids}
				onSuccess={handleDialogSuccess}
			/>
		</div>
	);
}
