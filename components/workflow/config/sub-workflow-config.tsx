"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";
import { workflowApi } from "@/lib/api-client";

type SubWorkflowConfigProps = {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
	currentWorkflowId?: string;
};

type WorkflowOption = {
	id: string;
	name: string;
	description?: string;
};

export function SubWorkflowConfig({
	config,
	onUpdateConfig,
	disabled,
	currentWorkflowId,
}: SubWorkflowConfigProps) {
	const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		workflowApi
			.getAll()
			.then((list) => {
				if (cancelled) return;
				const options = (list || [])
					.filter((w) => w.id !== currentWorkflowId)
					.map((w) => ({
						id: w.id,
						name: w.name || w.id,
						description: (w as Record<string, unknown>).description as
							| string
							| undefined,
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
				setWorkflows(options);
			})
			.catch(() => {
				if (!cancelled) setWorkflows([]);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [currentWorkflowId]);

	const handleWorkflowChange = (workflowId: string) => {
		onUpdateConfig("workflowId", workflowId);
		const selected = workflows.find((w) => w.id === workflowId);
		if (selected) {
			onUpdateConfig("workflowName", selected.name);
		}
	};

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="workflowId">Child Workflow</Label>
				<Select
					disabled={disabled || loading}
					onValueChange={handleWorkflowChange}
					value={(config.workflowId as string) || ""}
				>
					<SelectTrigger className="w-full" id="workflowId">
						<SelectValue
							placeholder={
								loading ? "Loading workflows..." : "Select a workflow"
							}
						/>
					</SelectTrigger>
					<SelectContent>
						{workflows.map((wf) => (
							<SelectItem key={wf.id} value={wf.id}>
								{wf.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-xs">
					Select an existing workflow to run as a child step. The child workflow
					will execute to completion before this node continues.
				</p>
			</div>

			<div className="space-y-2">
				<Label htmlFor="inputMapping">Input Mapping (JSON template)</Label>
				<TemplateBadgeTextarea
					disabled={disabled}
					id="inputMapping"
					onChange={(value) => onUpdateConfig("inputMapping", value)}
					placeholder={'{"key": "{{@nodeId:Label.field}}"}'}
					rows={4}
					value={(config.inputMapping as string) || ""}
				/>
				<p className="text-muted-foreground text-xs">
					JSON template sent as trigger data to the child workflow. Use {"{{"}
					{"}}"} syntax to reference upstream node outputs.
				</p>
			</div>
		</div>
	);
}
