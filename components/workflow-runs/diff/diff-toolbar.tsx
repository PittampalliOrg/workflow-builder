"use client";

import { Columns2, Rows2, ScanLine, StretchHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DiffContentMode, DiffViewMode } from "@/lib/diff/types";
import { cn } from "@/lib/utils";

interface DiffToolbarProps {
	viewMode: DiffViewMode;
	contentMode: DiffContentMode;
	onViewModeChange: (mode: DiffViewMode) => void;
	onContentModeChange: (mode: DiffContentMode) => void;
	className?: string;
}

export function DiffToolbar({
	viewMode,
	contentMode,
	onViewModeChange,
	onContentModeChange,
	className,
}: DiffToolbarProps) {
	return (
		<div className={cn("flex items-center gap-1", className)}>
			<TooltipProvider delayDuration={250}>
				<div className="flex items-center rounded-md border bg-muted/40 p-0.5">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								className={cn(
									"h-7 w-7 rounded-r-none p-0",
									viewMode === "unified" && "bg-secondary text-foreground",
								)}
								onClick={() => onViewModeChange("unified")}
								size="sm"
								variant="ghost"
							>
								<Rows2 className="h-3.5 w-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Unified view</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								className={cn(
									"h-7 w-7 rounded-l-none border-l p-0",
									viewMode === "split" && "bg-secondary text-foreground",
								)}
								onClick={() => onViewModeChange("split")}
								size="sm"
								variant="ghost"
							>
								<Columns2 className="h-3.5 w-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Split view</TooltipContent>
					</Tooltip>
				</div>

				<div className="h-5 w-px bg-border" />

				<div className="flex items-center rounded-md border bg-muted/40 p-0.5">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								className={cn(
									"h-7 w-7 rounded-r-none p-0",
									contentMode === "incremental" &&
										"bg-secondary text-foreground",
								)}
								onClick={() => onContentModeChange("incremental")}
								size="sm"
								variant="ghost"
							>
								<ScanLine className="h-3.5 w-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Changes only</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								className={cn(
									"h-7 w-7 rounded-l-none border-l p-0",
									contentMode === "full" && "bg-secondary text-foreground",
								)}
								onClick={() => onContentModeChange("full")}
								size="sm"
								variant="ghost"
							>
								<StretchHorizontal className="h-3.5 w-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Full file</TooltipContent>
					</Tooltip>
				</div>
			</TooltipProvider>
		</div>
	);
}
