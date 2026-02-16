"use client";

import { RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { ObservabilityEntityOption } from "@/lib/types/observability";

type TracesToolsProps = {
	entities: ObservabilityEntityOption[];
	selectedEntityId: string;
	search: string;
	from: string;
	to: string;
	isLoading?: boolean;
	onEntityIdChange: (value: string) => void;
	onSearchChange: (value: string) => void;
	onFromChange: (value: string) => void;
	onToChange: (value: string) => void;
	onReset: () => void;
	onRefresh: () => void;
};

export function TracesTools({
	entities,
	selectedEntityId,
	search,
	from,
	to,
	isLoading,
	onEntityIdChange,
	onSearchChange,
	onFromChange,
	onToChange,
	onReset,
	onRefresh,
}: TracesToolsProps) {
	return (
		<div className="flex flex-col gap-3 rounded-lg border bg-background p-4">
			<div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
				<div className="space-y-1">
					<p className="text-muted-foreground text-xs">Workflow</p>
					<Select onValueChange={onEntityIdChange} value={selectedEntityId}>
						<SelectTrigger className="w-full">
							<SelectValue placeholder="All workflows" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All workflows</SelectItem>
							{entities.map((entity) => (
								<SelectItem key={entity.id} value={entity.id}>
									{entity.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-1 lg:col-span-1">
					<p className="text-muted-foreground text-xs">Search</p>
					<Input
						onChange={(event) => onSearchChange(event.target.value)}
						placeholder="Trace, workflow, execution..."
						value={search}
					/>
				</div>

				<div className="space-y-1">
					<p className="text-muted-foreground text-xs">From</p>
					<Input
						onChange={(event) => onFromChange(event.target.value)}
						type="datetime-local"
						value={from}
					/>
				</div>

				<div className="space-y-1">
					<p className="text-muted-foreground text-xs">To</p>
					<Input
						onChange={(event) => onToChange(event.target.value)}
						type="datetime-local"
						value={to}
					/>
				</div>
			</div>

			<div className="flex items-center gap-2">
				<Button
					disabled={isLoading}
					onClick={onRefresh}
					size="sm"
					variant="outline"
				>
					<RefreshCw className="mr-2 h-4 w-4" />
					Refresh
				</Button>
				<Button
					disabled={isLoading}
					onClick={onReset}
					size="sm"
					variant="ghost"
				>
					<RotateCcw className="mr-2 h-4 w-4" />
					Reset
				</Button>
			</div>
		</div>
	);
}
