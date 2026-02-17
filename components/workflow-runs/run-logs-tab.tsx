"use client";

import { useMemo } from "react";
import { SyntaxHighlightedJson } from "@/components/monitor/json-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { getRelativeTime } from "@/lib/utils/time";
import { ExecutionStatusBadge } from "./execution-status-badge";
import { RunDetailSheet } from "./run-detail-sheet";

type ExecutionLogItem = {
	id: string;
	nodeId: string;
	nodeName: string;
	nodeType: string;
	actionType?: string | null;
	status: "pending" | "running" | "success" | "error";
	input: unknown;
	output: unknown;
	error: string | null;
	startedAt: Date;
	completedAt: Date | null;
	duration: string | null;
};

type RunLogsTabProps = {
	logs: ExecutionLogItem[];
	selectedLogId: string | null;
	onSelectedLogIdChange: (id: string | null) => void;
};

function parseSafeJson(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

export function RunLogsTab({
	logs,
	selectedLogId,
	onSelectedLogIdChange,
}: RunLogsTabProps) {
	const selectedLog = useMemo(
		() => logs.find((log) => log.id === selectedLogId) ?? null,
		[logs, selectedLogId],
	);

	if (logs.length === 0) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				No logs found for this run.
			</div>
		);
	}

	return (
		<>
			<div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2">
				<p className="font-medium text-sm">
					Node Logs{" "}
					<span className="text-muted-foreground">({logs.length})</span>
				</p>
				<p className="hidden text-muted-foreground text-xs sm:block">
					Click a row to inspect input/output
				</p>
			</div>

			<div className="overflow-hidden rounded-md border bg-background">
				<div className="max-h-[340px] overflow-auto sm:max-h-[calc(100vh-17rem)]">
					<Table>
						<TableHeader className="sticky top-0 z-10 bg-background">
							<TableRow>
								<TableHead>Node</TableHead>
								<TableHead>Type</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Started</TableHead>
								<TableHead>Duration</TableHead>
								<TableHead>Error</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{logs.map((log) => (
								<TableRow
									className={cn(
										"cursor-pointer",
										selectedLogId === log.id && "bg-primary/10",
									)}
									key={log.id}
									onClick={() => onSelectedLogIdChange(log.id)}
								>
									<TableCell className="max-w-[320px] truncate">
										{log.nodeName || log.nodeId}
									</TableCell>
									<TableCell className="max-w-[240px] truncate">
										{log.actionType ?? log.nodeType}
									</TableCell>
									<TableCell>
										<ExecutionStatusBadge status={log.status} />
									</TableCell>
									<TableCell>
										<span title={new Date(log.startedAt).toLocaleString()}>
											{getRelativeTime(log.startedAt)}
										</span>
									</TableCell>
									<TableCell>{log.duration ?? "-"}</TableCell>
									<TableCell className="max-w-[360px] truncate text-destructive">
										{log.error ?? "-"}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</div>

			<RunDetailSheet
				description={
					selectedLog
						? `${selectedLog.nodeType} · ${selectedLog.status}`
						: undefined
				}
				onOpenChange={(open) => {
					if (!open) {
						onSelectedLogIdChange(null);
					}
				}}
				open={Boolean(selectedLog)}
				title={selectedLog?.nodeName ?? "Log details"}
			>
				{selectedLog ? (
					<div className="space-y-4">
						<div className="grid gap-3 text-sm sm:grid-cols-2">
							<div>
								<p className="text-muted-foreground text-xs">Node ID</p>
								<p className="font-mono">{selectedLog.nodeId}</p>
							</div>
							<div>
								<p className="text-muted-foreground text-xs">Action</p>
								<p>{selectedLog.actionType ?? "-"}</p>
							</div>
							<div>
								<p className="text-muted-foreground text-xs">Started</p>
								<p>{new Date(selectedLog.startedAt).toLocaleString()}</p>
							</div>
							<div>
								<p className="text-muted-foreground text-xs">Completed</p>
								<p>
									{selectedLog.completedAt
										? new Date(selectedLog.completedAt).toLocaleString()
										: "-"}
								</p>
							</div>
						</div>

						<Tabs className="w-full" defaultValue="input">
							<TabsList>
								<TabsTrigger value="input">Input</TabsTrigger>
								<TabsTrigger value="output">Output</TabsTrigger>
								<TabsTrigger value="error">Error</TabsTrigger>
							</TabsList>
							<TabsContent value="input">
								<div className="overflow-hidden rounded-lg border p-3">
									<SyntaxHighlightedJson
										data={parseSafeJson(selectedLog.input)}
									/>
								</div>
							</TabsContent>
							<TabsContent value="output">
								<div className="overflow-hidden rounded-lg border p-3">
									<SyntaxHighlightedJson
										data={parseSafeJson(selectedLog.output)}
									/>
								</div>
							</TabsContent>
							<TabsContent value="error">
								{selectedLog.error ? (
									<div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
										{selectedLog.error}
									</div>
								) : (
									<div className="rounded-md border p-3 text-muted-foreground text-sm">
										No error for this node execution.
									</div>
								)}
							</TabsContent>
						</Tabs>
					</div>
				) : null}
			</RunDetailSheet>
		</>
	);
}
