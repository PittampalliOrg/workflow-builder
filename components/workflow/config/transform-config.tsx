"use client";

import { Label } from "@/components/ui/label";
import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";

type TransformConfigProps = {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
};

export function TransformConfig({
	config,
	onUpdateConfig,
	disabled,
}: TransformConfigProps) {
	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="templateJson">Template (JSON)</Label>
				<TemplateBadgeTextarea
					disabled={disabled}
					id="templateJson"
					onChange={(value) => onUpdateConfig("templateJson", value)}
					placeholder='{\n  "id": "{{@nodeId:Step.id}}"\n}'
					rows={10}
					value={(config.templateJson as string) || ""}
				/>
				<p className="text-muted-foreground text-xs">
					Must be valid JSON after template resolution.
				</p>
			</div>
		</div>
	);
}
