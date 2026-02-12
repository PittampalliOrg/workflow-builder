"use client";

import { Label } from "@/components/ui/label";
import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";

type NoteConfigProps = {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
};

export function NoteConfig({
	config,
	onUpdateConfig,
	disabled,
}: NoteConfigProps) {
	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="text">Note</Label>
				<TemplateBadgeTextarea
					disabled={disabled}
					id="text"
					onChange={(value) => onUpdateConfig("text", value)}
					placeholder="Write a note for yourself or your team. Notes do not execute."
					rows={6}
					value={(config.text as string) || ""}
				/>
			</div>
		</div>
	);
}
