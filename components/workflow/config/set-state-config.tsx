"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TemplateBadgeTextarea } from "@/components/ui/template-badge-textarea";
import { Plus, Trash2 } from "lucide-react";

type SetStateConfigProps = {
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: unknown) => void;
	disabled: boolean;
};

type SetStateEntry = {
	key: string;
	value: string;
};

function coerceValueToInputString(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value == null) {
		return "";
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function readSetStateEntries(config: Record<string, unknown>): SetStateEntry[] {
	const rawEntries = config.entries;
	if (Array.isArray(rawEntries)) {
		const entries = rawEntries
			.map((entry) => {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
					return null;
				}
				const record = entry as Record<string, unknown>;
				return {
					key:
						typeof record.key === "string"
							? record.key
							: String(record.key ?? ""),
					value: coerceValueToInputString(record.value),
				};
			})
			.filter((entry): entry is SetStateEntry => entry !== null);
		if (entries.length > 0) {
			return entries;
		}
	}

	const legacyKey =
		typeof config.key === "string" ? config.key : String(config.key ?? "");
	const legacyValue = coerceValueToInputString(config.value);
	if (legacyKey || legacyValue) {
		return [{ key: legacyKey, value: legacyValue }];
	}

	return [{ key: "", value: "" }];
}

export function SetStateConfig({
	config,
	onUpdateConfig,
	disabled,
}: SetStateConfigProps) {
	const entries = readSetStateEntries(config);

	const updateEntries = (nextEntries: SetStateEntry[]) => {
		onUpdateConfig("entries", nextEntries);
	};

	const updateEntry = (
		index: number,
		field: keyof SetStateEntry,
		nextValue: string,
	) => {
		updateEntries(
			entries.map((entry, entryIndex) =>
				entryIndex === index ? { ...entry, [field]: nextValue } : entry,
			),
		);
	};

	const addEntry = () => {
		updateEntries([...entries, { key: "", value: "" }]);
	};

	const removeEntry = (index: number) => {
		if (entries.length <= 1) {
			updateEntries([{ key: "", value: "" }]);
			return;
		}
		updateEntries(entries.filter((_, entryIndex) => entryIndex !== index));
	};

	return (
		<div className="space-y-4">
			<Label>State Entries</Label>
			<div className="space-y-3">
				{entries.map((entry, index) => (
					<div
						className="space-y-2 rounded-md border p-3"
						key={`entry-${index}`}
					>
						<div className="space-y-2">
							<Label htmlFor={`set-state-key-${index}`}>Key</Label>
							<Input
								disabled={disabled}
								id={`set-state-key-${index}`}
								onChange={(e) => updateEntry(index, "key", e.target.value)}
								placeholder="e.g. customerId"
								value={entry.key}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor={`set-state-value-${index}`}>Value</Label>
							<TemplateBadgeTextarea
								disabled={disabled}
								id={`set-state-value-${index}`}
								onChange={(value) => updateEntry(index, "value", value)}
								placeholder='e.g. {{@nodeId:Step.id}} or {"id":"{{@nodeId:Step.id}}"}'
								rows={4}
								value={entry.value}
							/>
						</div>
						<div className="flex justify-end">
							<Button
								disabled={disabled}
								onClick={() => removeEntry(index)}
								size="sm"
								type="button"
								variant="ghost"
							>
								<Trash2 className="mr-2 size-4" />
								Remove
							</Button>
						</div>
					</div>
				))}
			</div>
			<Button disabled={disabled} onClick={addEntry} size="sm" type="button">
				<Plus className="mr-2 size-4" />
				Add Key
			</Button>
			<p className="text-muted-foreground text-xs">
				Each key becomes available later as{" "}
				<span className="font-mono">{"{{state.yourKey}}"}</span>.
			</p>
		</div>
	);
}
