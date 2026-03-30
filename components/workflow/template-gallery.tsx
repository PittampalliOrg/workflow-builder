"use client";

import {
	ArrowRight,
	Bot,
	Code2,
	Layers,
	Sparkles,
	Workflow,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import type { WorkflowNode, WorkflowNodeType } from "@/lib/workflow-store";
import { type TemplateInfo, workflowTemplates } from "@/lib/workflow-templates";
import { cn } from "@/lib/utils";

// ============================================================================
// Category Icons
// ============================================================================

function getCategoryIcon(category: string) {
	switch (category) {
		case "AI Coding":
			return <Code2 className="h-5 w-5" />;
		case "Agent":
			return <Bot className="h-5 w-5" />;
		default:
			return <Layers className="h-5 w-5" />;
	}
}

// ============================================================================
// Template Card
// ============================================================================

function TemplateCard({
	template,
	onSelect,
	isCreating,
}: {
	template: TemplateInfo;
	onSelect: (template: TemplateInfo) => void;
	isCreating: boolean;
}) {
	return (
		<div className="group relative flex h-full flex-col rounded-xl border bg-card/95 p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/30">
			<div className="mb-3 flex items-start justify-between gap-3">
				<div className="rounded-lg border bg-background p-2 text-primary">
					{getCategoryIcon(template.category)}
				</div>
				<span className="rounded-full border bg-background px-2 py-0.5 text-muted-foreground text-xs">
					{template.nodeCount} nodes
				</span>
			</div>
			<h3 className="mb-1 font-semibold text-foreground text-sm">
				{template.name}
			</h3>
			<p className="mb-4 flex-1 text-muted-foreground text-xs leading-relaxed">
				{template.description}
			</p>
			<div className="mb-3 flex flex-wrap gap-1">
				{template.tags.map((tag) => (
					<span
						className="rounded-md border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
						key={tag}
					>
						{tag}
					</span>
				))}
			</div>
			<Button
				className="w-full gap-2"
				disabled={isCreating}
				onClick={() => onSelect(template)}
				size="sm"
				variant="outline"
			>
				Use Template
				<ArrowRight className="h-3.5 w-3.5" />
			</Button>
		</div>
	);
}

// ============================================================================
// Template Gallery
// ============================================================================

type TemplateGalleryProps = {
	onWorkflowCreated?: (workflowId: string) => void;
	onStartBlank?: () => void;
};

export function TemplateGallery({
	onWorkflowCreated,
	onStartBlank,
}: TemplateGalleryProps) {
	const router = useRouter();
	const [creatingId, setCreatingId] = useState<string | null>(null);

	const handleSelect = useCallback(
		async (template: TemplateInfo) => {
			setCreatingId(template.id);
			try {
				const { nodes, edges } = template.build();
				const workflowNodes: WorkflowNode[] = nodes.map((node) => ({
					id: node.id,
					type: node.type,
					position: node.position,
					data: {
						label: node.label,
						description: node.description,
						type: node.type as WorkflowNodeType,
						config: node.config,
						status: "idle" as const,
					},
				}));
				const workflow = await api.workflow.create({
					name: template.name,
					description: template.description,
					nodes: workflowNodes,
					edges,
				});
				const id = workflow.id;
				if (id) {
					onWorkflowCreated?.(id);
					router.push(`/workflows/${id}`);
				}
			} catch (error) {
				console.error("Failed to create workflow from template:", error);
			} finally {
				setCreatingId(null);
			}
		},
		[onWorkflowCreated, router],
	);

	return (
		<div className="w-full max-w-5xl">
			<div className="mb-5 rounded-2xl border bg-card/95 p-5 shadow-sm">
				<div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
					<div className="space-y-2">
						<div className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-muted-foreground text-xs">
							<Sparkles className="h-3.5 w-3.5 text-primary" />
							Start a workflow
						</div>
						<div>
							<h1 className="font-semibold text-2xl tracking-tight">
								Choose a starting point
							</h1>
							<p className="max-w-2xl text-muted-foreground text-sm">
								Use a workflow template to bootstrap a common pattern, or start
								with a blank canvas and build the graph yourself.
							</p>
						</div>
					</div>
					<Button
						className="gap-2 self-start lg:self-auto"
						onClick={onStartBlank}
						size="sm"
						variant="secondary"
					>
						<Workflow className="h-4 w-4" />
						Start Blank
					</Button>
				</div>
			</div>
			<div
				className={cn(
					"grid gap-4",
					"grid-cols-1 lg:grid-cols-2 xl:grid-cols-3",
				)}
			>
				{workflowTemplates.map((template) => (
					<TemplateCard
						isCreating={creatingId === template.id}
						key={template.id}
						onSelect={handleSelect}
						template={template}
					/>
				))}
			</div>
		</div>
	);
}
