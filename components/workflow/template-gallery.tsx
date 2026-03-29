"use client";

import { ArrowRight, Bot, Code2, Layers } from "lucide-react";
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
		<div className="group relative flex flex-col rounded-lg border border-gray-700 bg-[#1e2433] p-4 transition-colors hover:border-teal-500/50 hover:bg-[#232a3b]">
			<div className="mb-3 flex items-start justify-between">
				<div className="rounded-md border border-gray-600 bg-gray-800 p-2 text-teal-400">
					{getCategoryIcon(template.category)}
				</div>
				<span className="rounded-full bg-gray-800 px-2 py-0.5 text-gray-500 text-xs">
					{template.nodeCount} nodes
				</span>
			</div>
			<h3 className="mb-1 font-semibold text-gray-200 text-sm">
				{template.name}
			</h3>
			<p className="mb-4 flex-1 text-gray-500 text-xs leading-relaxed">
				{template.description}
			</p>
			<div className="mb-3 flex flex-wrap gap-1">
				{template.tags.map((tag) => (
					<span
						className="rounded bg-gray-800 px-1.5 py-0.5 text-gray-500 text-[10px]"
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
};

export function TemplateGallery({ onWorkflowCreated }: TemplateGalleryProps) {
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
		<div>
			<div className="mb-4">
				<h2 className="font-semibold text-gray-200 text-lg">
					Workflow Templates
				</h2>
				<p className="text-gray-500 text-sm">
					Start with a pre-configured workflow pattern
				</p>
			</div>
			<div
				className={cn(
					"grid gap-4",
					"grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
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
