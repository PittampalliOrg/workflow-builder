"use client";

import type { LucideIcon } from "lucide-react";
import {
	Braces,
	Database,
	GitBranch,
	NotebookPen,
	Repeat,
	ShieldCheck,
	Sparkles,
	Timer,
	Workflow,
	Zap,
} from "lucide-react";
import type { WorkflowNodeType } from "@/lib/workflow-store";
import { cn } from "@/lib/utils";

export const WORKFLOW_NODE_TEMPLATE_MIME = "application/workflow-node-template";

export type StepTemplate = {
	type: WorkflowNodeType;
	label: string;
	icon: LucideIcon;
	supportsInlineInsert: boolean;
};

export const STEP_TEMPLATES: StepTemplate[] = [
	{ type: "action", label: "Action", icon: Zap, supportsInlineInsert: true },
	{
		type: "activity",
		label: "Activity",
		icon: Sparkles,
		supportsInlineInsert: true,
	},
	{ type: "timer", label: "Timer", icon: Timer, supportsInlineInsert: true },
	{
		type: "approval-gate",
		label: "Approval",
		icon: ShieldCheck,
		supportsInlineInsert: true,
	},
	{
		type: "loop-until",
		label: "Loop",
		icon: Repeat,
		supportsInlineInsert: true,
	},
	{
		type: "if-else",
		label: "If / Else",
		icon: GitBranch,
		supportsInlineInsert: false,
	},
	{
		type: "set-state",
		label: "Set State",
		icon: Database,
		supportsInlineInsert: true,
	},
	{
		type: "transform",
		label: "Transform",
		icon: Braces,
		supportsInlineInsert: true,
	},
	{
		type: "sub-workflow",
		label: "Sub-Workflow",
		icon: Workflow,
		supportsInlineInsert: true,
	},
	{
		type: "note",
		label: "Note",
		icon: NotebookPen,
		supportsInlineInsert: false,
	},
];

const STEP_TEMPLATE_TYPES = new Set<WorkflowNodeType>(
	STEP_TEMPLATES.map((template) => template.type),
);
const INLINE_INSERT_STEP_TYPES = new Set<WorkflowNodeType>(
	STEP_TEMPLATES.filter((template) => template.supportsInlineInsert).map(
		(template) => template.type,
	),
);

export function parseStepTemplateNodeType(
	value: string,
): WorkflowNodeType | null {
	return STEP_TEMPLATE_TYPES.has(value as WorkflowNodeType)
		? (value as WorkflowNodeType)
		: null;
}

export function supportsInlineInsertion(nodeType: WorkflowNodeType): boolean {
	return INLINE_INSERT_STEP_TYPES.has(nodeType);
}

type StepPaletteProps = {
	className?: string;
	disabled?: boolean;
	onDragStart?: (nodeType: WorkflowNodeType) => void;
	onDragEnd?: () => void;
	onSelectNodeType: (nodeType: WorkflowNodeType) => void;
};

export function StepPalette({
	className,
	disabled,
	onDragStart,
	onDragEnd,
	onSelectNodeType,
}: StepPaletteProps) {
	return (
		<div
			className={cn(
				"pointer-events-auto rounded-lg border bg-card/90 p-2 shadow-sm backdrop-blur-sm",
				className,
			)}
			data-testid="step-palette"
		>
			<div className="mb-2 px-1 text-muted-foreground text-xs">Drag a step</div>
			<div className="grid grid-cols-3 gap-1.5">
				{STEP_TEMPLATES.map((template) => {
					const Icon = template.icon;
					return (
						<button
							className={cn(
								"flex h-16 w-16 cursor-grab flex-col items-center justify-center gap-1 rounded-md border bg-background text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:cursor-grabbing",
								disabled && "cursor-not-allowed opacity-50",
							)}
							data-testid={`step-palette-item-${template.type}`}
							draggable={!disabled}
							key={template.type}
							onClick={() => {
								if (disabled) {
									return;
								}
								onSelectNodeType(template.type);
							}}
							onDragEnd={() => {
								onDragEnd?.();
							}}
							onDragStart={(event) => {
								if (disabled) {
									event.preventDefault();
									return;
								}
								onDragStart?.(template.type);
								event.dataTransfer.effectAllowed = "copy";
								event.dataTransfer.setData(
									WORKFLOW_NODE_TEMPLATE_MIME,
									template.type,
								);
								event.dataTransfer.setData("text/plain", template.type);
							}}
							title={template.label}
							type="button"
						>
							<Icon className="size-4" />
							<span className="text-[10px]">{template.label}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
