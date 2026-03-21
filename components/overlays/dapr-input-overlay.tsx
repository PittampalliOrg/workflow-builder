"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { McpInputProperty } from "@/lib/mcp/types";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

export type ManualTriggerWorkflowInput = Record<string, unknown>;

type ManualTriggerInputOverlayProps = OverlayComponentProps<{
	onRun: (input: ManualTriggerWorkflowInput) => void;
	fields: McpInputProperty[];
	workflowName?: string;
	triggerLabel?: string;
}>;

function getDefaultDraftValue(field: McpInputProperty): string | boolean {
	return field.type === "BOOLEAN" ? false : "";
}

function formatFieldLabel(name: string): string {
	return name
		.split(/[_-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function parseFieldValue(
	field: McpInputProperty,
	draftValue: string | boolean,
): { value?: unknown; error?: string } {
	if (field.type === "BOOLEAN") {
		return { value: Boolean(draftValue) };
	}

	const rawValue = typeof draftValue === "string" ? draftValue : "";
	if (!rawValue.trim()) {
		return { value: "" };
	}

	if (field.type === "TEXT" || field.type === "DATE") {
		return { value: rawValue };
	}

	if (field.type === "NUMBER") {
		const numericValue = Number(rawValue);
		if (!Number.isFinite(numericValue)) {
			return { error: `${field.name} must be a valid number.` };
		}
		return { value: numericValue };
	}

	try {
		const parsed = JSON.parse(rawValue) as unknown;
		if (field.type === "ARRAY" && !Array.isArray(parsed)) {
			return { error: `${field.name} must be a JSON array.` };
		}
		if (
			field.type === "OBJECT" &&
			(!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		) {
			return { error: `${field.name} must be a JSON object.` };
		}
		return { value: parsed };
	} catch {
		return {
			error:
				field.type === "ARRAY"
					? `${field.name} must be valid JSON array syntax.`
					: `${field.name} must be valid JSON object syntax.`,
		};
	}
}

function buildInputResult(
	fields: McpInputProperty[],
	values: Record<string, string | boolean>,
): {
	input: ManualTriggerWorkflowInput;
	errors: Record<string, string>;
} {
	const input: ManualTriggerWorkflowInput = {};
	const errors: Record<string, string> = {};

	for (const field of fields) {
		const parsed = parseFieldValue(
			field,
			values[field.name] ?? getDefaultDraftValue(field),
		);
		const value = parsed.value;
		const isEmpty =
			value === "" ||
			value === undefined ||
			value === null ||
			(Array.isArray(value) && value.length === 0);

		if (field.required && isEmpty) {
			errors[field.name] = `${field.name} is required.`;
			continue;
		}
		if (parsed.error) {
			errors[field.name] = parsed.error;
			continue;
		}
		if (!isEmpty) {
			input[field.name] = value;
		}
	}

	return { input, errors };
}

export function ManualTriggerInputOverlay({
	overlayId,
	onRun,
	fields,
	workflowName,
	triggerLabel,
}: ManualTriggerInputOverlayProps) {
	const { closeAll } = useOverlay();
	const [values, setValues] = useState<Record<string, string | boolean>>(() =>
		Object.fromEntries(
			fields.map((field) => [field.name, getDefaultDraftValue(field)]),
		),
	);
	const [showErrors, setShowErrors] = useState(false);

	const validation = useMemo(
		() => buildInputResult(fields, values),
		[fields, values],
	);

	const title = workflowName?.trim() ? `Run ${workflowName}` : "Run Workflow";

	const handleRun = () => {
		setShowErrors(true);
		if (Object.keys(validation.errors).length > 0) {
			toast.error("Fill in the run inputs before starting the workflow.");
			return;
		}
		closeAll();
		onRun(validation.input);
	};

	return (
		<Overlay
			actions={[
				{
					label: "Run Workflow",
					variant: "default",
					onClick: handleRun,
				},
				{ label: "Cancel", onClick: closeAll },
			]}
			description="Enter the Manual Trigger values for this run. Put the feature request here, not in the node description."
			overlayId={overlayId}
			title={title}
		>
			<div className="space-y-4">
				<div className="rounded-lg border border-blue-200 bg-blue-50/70 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/20">
					<p className="font-medium text-foreground">
						This form is the per-run input for the
						{triggerLabel ? ` ${triggerLabel}` : " Manual Trigger"} node.
					</p>
					<p className="mt-1 text-muted-foreground">
						The Description field in the editor is only a static note on the
						canvas. It does not become agent input.
					</p>
				</div>

				{fields.length === 0 ? (
					<div className="rounded-lg border border-dashed p-4 text-sm">
						<p className="font-medium text-foreground">
							No Manual Trigger inputs are configured.
						</p>
						<p className="mt-1 text-muted-foreground">
							Add fields in the Manual Trigger node under Run Form Inputs if
							this workflow should ask for values before execution.
						</p>
					</div>
				) : (
					fields.map((field) => {
						const fieldError = showErrors
							? validation.errors[field.name]
							: null;
						const value = values[field.name] ?? getDefaultDraftValue(field);
						const isJsonField =
							field.type === "ARRAY" || field.type === "OBJECT";
						const isLongTextField = field.type === "TEXT" || isJsonField;

						return (
							<div className="space-y-2" key={field.name}>
								<div className="space-y-1">
									<Label htmlFor={`trigger-input-${field.name}`}>
										{formatFieldLabel(field.name)}
										{field.required ? (
											<span className="ml-1 text-red-500">*</span>
										) : null}
									</Label>
									{field.description ? (
										<p className="text-muted-foreground text-xs">
											{field.description}
										</p>
									) : null}
								</div>

								{field.type === "BOOLEAN" ? (
									<div className="flex items-center gap-3 rounded-md border px-3 py-2">
										<Checkbox
											checked={Boolean(value)}
											id={`trigger-input-${field.name}`}
											onCheckedChange={(checked) =>
												setValues((current) => ({
													...current,
													[field.name]: Boolean(checked),
												}))
											}
										/>
										<Label
											className="font-normal"
											htmlFor={`trigger-input-${field.name}`}
										>
											{field.description ||
												`Set ${formatFieldLabel(field.name)}`}
										</Label>
									</div>
								) : isLongTextField ? (
									<Textarea
										id={`trigger-input-${field.name}`}
										onChange={(event) =>
											setValues((current) => ({
												...current,
												[field.name]: event.target.value,
											}))
										}
										placeholder={
											isJsonField
												? field.type === "ARRAY"
													? '["item-one", "item-two"]'
													: '{"key":"value"}'
												: field.name === "feature_request"
													? "Describe the feature, bug fix, or task for this run."
													: `Enter ${formatFieldLabel(field.name).toLowerCase()}`
										}
										rows={isJsonField ? 6 : 8}
										value={String(value)}
									/>
								) : (
									<Input
										id={`trigger-input-${field.name}`}
										onChange={(event) =>
											setValues((current) => ({
												...current,
												[field.name]: event.target.value,
											}))
										}
										placeholder={`Enter ${formatFieldLabel(field.name).toLowerCase()}`}
										type={field.type === "NUMBER" ? "number" : "date"}
										value={String(value)}
									/>
								)}

								{field.name === "feature_request" ? (
									<p className="text-xs font-medium text-foreground">
										Paste the feature description here when you run the
										workflow.
									</p>
								) : null}

								{fieldError ? (
									<p className="text-destructive text-xs">{fieldError}</p>
								) : null}
							</div>
						);
					})
				)}
			</div>
		</Overlay>
	);
}

export const DaprInputOverlay = ManualTriggerInputOverlay;
