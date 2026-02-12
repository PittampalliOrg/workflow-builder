"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";

type SetStateConfigProps = {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
};

export function SetStateConfig({
	config,
	onUpdateConfig,
	disabled,
}: SetStateConfigProps) {
	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="key">Key</Label>
				<Input
					disabled={disabled}
					id="key"
					onChange={(e) => onUpdateConfig("key", e.target.value)}
					placeholder="e.g. customerId"
					value={(config.key as string) || ""}
				/>
				<p className="text-muted-foreground text-xs">
					Accessible later via{" "}
					<span className="font-mono">{"{{state.key}}"}</span>.
				</p>
			</div>

			<div className="space-y-2">
				<Label htmlFor="value">Value</Label>
				<TemplateBadgeTextarea
					disabled={disabled}
					id="value"
					onChange={(value) => onUpdateConfig("value", value)}
					placeholder='e.g. {{@nodeId:Step.id}} or {"id":"{{@nodeId:Step.id}}"}'
					rows={6}
					value={(config.value as string) || ""}
				/>
			</div>
		</div>
	);
}
