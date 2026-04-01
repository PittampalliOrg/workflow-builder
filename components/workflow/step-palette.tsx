"use client";

import type { LucideIcon } from "lucide-react";
import {
	BellRing,
	Clock3,
	GitBranch,
	GitFork,
	Globe,
	Headphones,
	Layers3,
	Play,
	Repeat,
	ShieldAlert,
	ShieldCheck,
	Variable,
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
	{ type: "call", label: "Call", icon: Globe, supportsInlineInsert: true },
	{ type: "set", label: "Set", icon: Variable, supportsInlineInsert: true },
	{
		type: "switch",
		label: "Switch",
		icon: GitBranch,
		supportsInlineInsert: true,
	},
	{ type: "wait", label: "Wait", icon: Clock3, supportsInlineInsert: true },
	{ type: "for", label: "For", icon: Repeat, supportsInlineInsert: true },
	{ type: "fork", label: "Fork", icon: GitFork, supportsInlineInsert: true },
	{ type: "try", label: "Try", icon: ShieldCheck, supportsInlineInsert: true },
	{ type: "run", label: "Run", icon: Play, supportsInlineInsert: true },
	{ type: "do", label: "Do", icon: Layers3, supportsInlineInsert: true },
	{ type: "emit", label: "Emit", icon: BellRing, supportsInlineInsert: true },
	{
		type: "listen",
		label: "Listen",
		icon: Headphones,
		supportsInlineInsert: true,
	},
	{
		type: "raise",
		label: "Raise",
		icon: ShieldAlert,
		supportsInlineInsert: true,
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
			<div className="mb-2 px-1 text-muted-foreground text-xs">
				Drag an SW task
			</div>
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
