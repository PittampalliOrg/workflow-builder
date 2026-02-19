"use client";

import { NodeResizer, type NodeProps } from "@xyflow/react";
import { useSetAtom } from "jotai";
import { Check, Layers, Pencil } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
	pushHistorySnapshotAtom,
	type WorkflowNodeData,
	updateNodeDataAtom,
} from "@/lib/workflow-store";

type GroupNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

export const GroupNode = memo(
	({ data, selected, id, width, height }: GroupNodeProps) => {
		const updateNodeData = useSetAtom(updateNodeDataAtom);
		const pushHistorySnapshot = useSetAtom(pushHistorySnapshotAtom);
		const [isEditingLabel, setIsEditingLabel] = useState(false);
		const [labelDraft, setLabelDraft] = useState(data?.label || "Group");
		const [isResizing, setIsResizing] = useState(false);
		const [resizePreview, setResizePreview] = useState<{
			width: number;
			height: number;
		} | null>(null);
		const currentLabel = (data?.label || "Group").trim() || "Group";
		const displayWidth = Math.round(resizePreview?.width ?? width ?? 0);
		const displayHeight = Math.round(resizePreview?.height ?? height ?? 0);
		const description = data?.description || "Grouped steps";

		useEffect(() => {
			if (!isEditingLabel) {
				setLabelDraft(currentLabel);
			}
		}, [currentLabel, isEditingLabel]);

		const commitLabel = useCallback(() => {
			const nextLabel = labelDraft.trim() || "Group";
			setLabelDraft(nextLabel);
			setIsEditingLabel(false);
			if (nextLabel !== currentLabel) {
				updateNodeData({ id, data: { label: nextLabel } });
			}
		}, [currentLabel, id, labelDraft, updateNodeData]);

		const startEditing = useCallback(() => {
			setIsEditingLabel(true);
		}, []);

		const cancelEditing = useCallback(() => {
			setLabelDraft(currentLabel);
			setIsEditingLabel(false);
		}, [currentLabel]);

		return (
			<div
				className={cn(
					"relative h-full w-full rounded-xl border border-dashed bg-card/20 backdrop-blur-[1px] transition-all duration-150 ease-out",
					selected
						? "border-primary shadow-[0_0_0_1px_hsl(var(--primary))]"
						: "border-border/80",
				)}
				data-testid={`group-node-${id}`}
			>
				<NodeResizer
					handleClassName="h-2.5 w-2.5 border-border bg-background"
					isVisible={selected}
					lineClassName="border-border/70"
					minHeight={180}
					minWidth={260}
					onResize={(_event, params) => {
						setResizePreview({
							width: params.width,
							height: params.height,
						});
					}}
					onResizeEnd={(_event, params) => {
						setResizePreview({
							width: params.width,
							height: params.height,
						});
						setIsResizing(false);
					}}
					onResizeStart={(_event, params) => {
						pushHistorySnapshot();
						setIsResizing(true);
						setResizePreview({
							width: params.width,
							height: params.height,
						});
					}}
				/>

				<div
					className="absolute inset-x-3 top-3 flex items-center gap-2 rounded-md border border-border/60 bg-card/80 px-3 py-2"
					onDoubleClick={(event) => {
						event.stopPropagation();
						startEditing();
					}}
					onPointerDown={(event) => {
						if (isEditingLabel) {
							event.stopPropagation();
						}
					}}
				>
					<div className="rounded-md border border-border/70 bg-background/60 p-1.5">
						<Layers
							className="size-4 text-muted-foreground"
							strokeWidth={1.8}
						/>
					</div>
					<div className="min-w-0 flex-1">
						{isEditingLabel ? (
							<Input
								autoFocus
								className="nodrag h-7 px-2 font-medium text-sm"
								data-testid={`group-node-label-input-${id}`}
								onBlur={commitLabel}
								onChange={(event) => setLabelDraft(event.target.value)}
								onClick={(event) => event.stopPropagation()}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										commitLabel();
									}
									if (event.key === "Escape") {
										event.preventDefault();
										cancelEditing();
									}
								}}
								value={labelDraft}
							/>
						) : (
							<button
								className="nodrag w-full truncate text-left font-medium text-sm leading-none"
								data-testid={`group-node-label-${id}`}
								onClick={(event) => {
									event.stopPropagation();
								}}
								onDoubleClick={(event) => {
									event.stopPropagation();
									startEditing();
								}}
								type="button"
							>
								{currentLabel}
							</button>
						)}
						<p className="mt-1 truncate text-muted-foreground text-xs">
							{description}
						</p>
					</div>
					{selected && (
						<Button
							className="nodrag h-7 w-7 shrink-0 p-0"
							onClick={(event) => {
								event.stopPropagation();
								if (isEditingLabel) {
									commitLabel();
									return;
								}
								startEditing();
							}}
							size="icon"
							type="button"
							variant="ghost"
						>
							{isEditingLabel ? (
								<Check className="size-3.5" strokeWidth={2} />
							) : (
								<Pencil className="size-3.5" strokeWidth={2} />
							)}
						</Button>
					)}
				</div>
				{selected && displayWidth > 0 && displayHeight > 0 && (
					<div
						className={cn(
							"pointer-events-none absolute right-3 bottom-3 rounded-md border border-border/70 bg-card/85 px-2 py-1 font-medium text-[10px] text-muted-foreground",
							isResizing && "border-primary/60 text-foreground",
						)}
						data-testid={`group-node-size-${id}`}
					>
						{displayWidth} x {displayHeight}
					</div>
				)}
			</div>
		);
	},
);

GroupNode.displayName = "GroupNode";
