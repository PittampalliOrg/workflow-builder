"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  type RowSelectionState,
  useReactTable,
} from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import {
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type AppConnection, api, type PieceMetadata } from "@/lib/api-client";
import { AppConnectionStatus } from "@/lib/types/app-connection";
import { ConnectionStatusBadge } from "./connection-status-badge";
import { DeleteConnectionDialog } from "./delete-connection-dialog";
import { NewConnectionDialog } from "./new-connection-dialog";
import { RenameConnectionDialog } from "./rename-connection-dialog";

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
  const [piecesMap, setPiecesMap] = useState<Map<string, PieceMetadata>>(
    new Map()
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
    PieceMetadata | undefined
  >();

  const fetchConnections = useCallback(async () => {
    try {
      setLoading(true);
      const [connectionsResult, pieces] = await Promise.all([
        api.appConnection.list(),
        api.piece.list(),
      ]);

      const map = new Map<string, PieceMetadata>();
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
            aria-label="Select all"
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(value) =>
              table.toggleAllPageRowsSelected(!!value)
            }
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label="Select row"
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
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
                  alt={displayName}
                  className="h-6 w-6 rounded"
                  src={logoUrl}
                />
              ) : (
                <div className="flex h-6 w-6 items-center justify-center rounded bg-muted">
                  <Plug className="h-3 w-3 text-muted-foreground" />
                </div>
              )}
              <span className="font-medium text-sm">{displayName}</span>
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
          if (filterValue === "all") {
            return true;
          }
          return row.original.status === filterValue;
        },
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => {
          const date = new Date(row.original.createdAt);
          return (
            <span className="text-muted-foreground text-sm">
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
                <Button className="h-8 w-8 p-0" variant="ghost">
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
    [piecesMap]
  );

  const filteredData = useMemo(() => {
    let data = connections;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      data = data.filter(
        (c) =>
          c.displayName.toLowerCase().includes(q) ||
          (c.pieceDisplayName?.toLowerCase().includes(q) ?? false)
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
          {["1", "2", "3", "4", "5"].map((k) => (
            <Skeleton className="h-12 w-full" key={k} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-1 items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search connections..."
              value={searchQuery}
            />
          </div>
          <Select onValueChange={setStatusFilter} value={statusFilter}>
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
            <Button onClick={handleBulkDelete} size="sm" variant="destructive">
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
          <h3 className="font-medium text-lg">No connections yet</h3>
          <p className="mt-1 text-muted-foreground text-sm">
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
                            header.getContext()
                          )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow
                  data-state={row.getIsSelected() && "selected"}
                  key={row.id}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
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
        onOpenChange={(open) => {
          setNewDialogOpen(open);
          if (!open) {
            setReconnectPiece(undefined);
          }
        }}
        onSuccess={handleDialogSuccess}
        open={newDialogOpen}
        preselectedPiece={reconnectPiece}
      />
      <RenameConnectionDialog
        connectionId={renameDialog.id}
        currentName={renameDialog.name}
        onOpenChange={(open) => setRenameDialog((prev) => ({ ...prev, open }))}
        onSuccess={handleDialogSuccess}
        open={renameDialog.open}
      />
      <DeleteConnectionDialog
        connectionId={deleteDialog.id}
        connectionIds={deleteDialog.ids}
        connectionName={deleteDialog.name}
        onOpenChange={(open) => setDeleteDialog((prev) => ({ ...prev, open }))}
        onSuccess={handleDialogSuccess}
        open={deleteDialog.open}
      />
    </div>
  );
}
