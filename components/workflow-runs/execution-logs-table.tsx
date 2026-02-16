"use client";

import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { getRelativeTime } from "@/lib/utils/time";
import { ExecutionStatusBadge } from "./execution-status-badge";

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

type ExecutionLogsTableProps = {
	logs: ExecutionLogItem[];
};

export function ExecutionLogsTable({ logs }: ExecutionLogsTableProps) {
	if (logs.length === 0) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				No logs found for this run.
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-lg border bg-background">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Node</TableHead>
						<TableHead>Type</TableHead>
						<TableHead>Action</TableHead>
						<TableHead>Status</TableHead>
						<TableHead>Started</TableHead>
						<TableHead>Duration</TableHead>
						<TableHead>Error</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{logs.map((log) => (
						<TableRow key={log.id}>
							<TableCell className="max-w-[260px] truncate">
								{log.nodeName || log.nodeId}
							</TableCell>
							<TableCell>{log.nodeType}</TableCell>
							<TableCell className="max-w-[240px] truncate">
								{log.actionType ?? "-"}
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
							<TableCell className="max-w-[320px] truncate text-destructive">
								{log.error ?? "-"}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
