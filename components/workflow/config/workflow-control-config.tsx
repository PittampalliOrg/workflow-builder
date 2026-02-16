"use client";

import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";

type WorkflowControlConfigProps = {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
};

export function WorkflowControlConfig({
	config,
	onUpdateConfig,
	disabled,
}: WorkflowControlConfigProps) {
	const mode = String(config.mode || "stop").toLowerCase();

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="workflow-control-mode">Mode</Label>
				<Select
					disabled={disabled}
					onValueChange={(value) => onUpdateConfig("mode", value)}
					value={mode}
				>
					<SelectTrigger className="w-full" id="workflow-control-mode">
						<SelectValue placeholder="Select control mode" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="stop">Stop Workflow</SelectItem>
						<SelectItem value="continue">Continue Workflow</SelectItem>
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-xs">
					Use this explicit control step instead of action-output side channels.
				</p>
			</div>

			<div className="space-y-2">
				<Label htmlFor="workflow-control-reason">Reason (optional)</Label>
				<TemplateBadgeInput
					disabled={disabled}
					id="workflow-control-reason"
					onChange={(value) => onUpdateConfig("reason", value)}
					placeholder="e.g. MCP client already responded"
					value={String(config.reason || "")}
				/>
			</div>
		</div>
	);
}
