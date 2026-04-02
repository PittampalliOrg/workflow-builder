"use client";

import { Check, ChevronsUpDown, Github, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
	api,
	type AppConnection,
	type DynamicDropdownOption,
} from "@/lib/api-client";
import { AppConnectionStatus } from "@/lib/types/app-connection";
import { cn } from "@/lib/utils";
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
	description?: string;
	contextLabel?: string;
	emptyStateTitle?: string;
	emptyStateDescription?: string;
	submitLabel?: string;
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

function isGithubConnection(connection: AppConnection): boolean {
	return (
		connection.status === AppConnectionStatus.ACTIVE &&
		connection.pieceName.toLowerCase().includes("github")
	);
}

function resolveConnectionLabel(connection: AppConnection): string {
	const scope = connection.scope === "PLATFORM" ? "Platform" : "Project";
	return `${connection.displayName} (${scope})`;
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

type SearchablePickerProps = {
	fieldName: string;
	label: string;
	description: string;
	options: DynamicDropdownOption[];
	value: string;
	loading: boolean;
	disabled?: boolean;
	placeholder: string;
	error?: string | null;
	required?: boolean;
	onSelect: (nextValue: string) => void;
};

function SearchablePicker({
	fieldName,
	label,
	description,
	options,
	value,
	loading,
	disabled,
	placeholder,
	error,
	required = true,
	onSelect,
}: SearchablePickerProps) {
	const [open, setOpen] = useState(false);
	const selectedLabel =
		options.find((option) => option.value === value)?.label ?? value;

	return (
		<div className="space-y-2">
			<div className="space-y-1">
				<Label htmlFor={`trigger-input-${fieldName}`}>
					{label}
					{required ? <span className="ml-1 text-red-500">*</span> : null}
				</Label>
				<p className="text-muted-foreground text-xs">{description}</p>
			</div>
			<Popover onOpenChange={setOpen} open={open}>
				<PopoverTrigger asChild>
					<Button
						aria-expanded={open}
						className="w-full justify-between"
						disabled={disabled}
						id={`trigger-input-${fieldName}`}
						variant="outline"
					>
						<span className="truncate">{selectedLabel || placeholder}</span>
						{loading ? (
							<Loader2 className="size-4 animate-spin opacity-60" />
						) : (
							<ChevronsUpDown className="size-4 opacity-50" />
						)}
					</Button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					className="w-[var(--radix-popover-trigger-width)] p-0"
				>
					<Command shouldFilter>
						<CommandInput placeholder={`Search ${label.toLowerCase()}...`} />
						<CommandList>
							<CommandEmpty>No results found.</CommandEmpty>
							<CommandGroup>
								{options.map((option) => (
									<CommandItem
										key={option.value}
										onSelect={() => {
											onSelect(option.value);
											setOpen(false);
										}}
										value={`${option.label} ${option.value}`}
									>
										<Check
											className={cn(
												"mr-2 size-4",
												value === option.value ? "opacity-100" : "opacity-0",
											)}
										/>
										<span className="truncate">{option.label}</span>
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
			{error ? <p className="text-destructive text-xs">{error}</p> : null}
		</div>
	);
}

export function ManualTriggerInputOverlay({
	overlayId,
	onRun,
	fields,
	workflowName,
	triggerLabel,
	description,
	contextLabel,
	emptyStateTitle,
	emptyStateDescription,
	submitLabel,
}: ManualTriggerInputOverlayProps) {
	const { closeAll } = useOverlay();
	const [values, setValues] = useState<Record<string, string | boolean>>(() =>
		Object.fromEntries(
			fields.map((field) => [field.name, getDefaultDraftValue(field)]),
		),
	);
	const [showErrors, setShowErrors] = useState(false);
	const [githubConnections, setGithubConnections] = useState<AppConnection[]>(
		[],
	);
	const [selectedGithubConnectionId, setSelectedGithubConnectionId] = useState<
		string | null
	>(null);
	const [ownerOptions, setOwnerOptions] = useState<DynamicDropdownOption[]>([]);
	const [repoOptions, setRepoOptions] = useState<DynamicDropdownOption[]>([]);
	const [loadingGithubConnections, setLoadingGithubConnections] =
		useState(false);
	const [loadingOwners, setLoadingOwners] = useState(false);
	const [loadingRepos, setLoadingRepos] = useState(false);
	const [githubOptionsError, setGithubOptionsError] = useState<string | null>(
		null,
	);

	const validation = useMemo(
		() => buildInputResult(fields, values),
		[fields, values],
	);
	const githubRunForm = useMemo(() => {
		const names = new Set(fields.map((field) => field.name));
		return names.has("owner") && names.has("repo");
	}, [fields]);
	const hasGithubSelectors = githubRunForm && githubConnections.length > 0;
	const renderedFields = useMemo(
		() =>
			hasGithubSelectors
				? fields.filter(
						(field) => field.name !== "owner" && field.name !== "repo",
					)
				: fields,
		[fields, hasGithubSelectors],
	);

	const title = workflowName?.trim() ? `Run ${workflowName}` : "Run Workflow";

	useEffect(() => {
		if (!githubRunForm) {
			return;
		}

		let cancelled = false;
		const loadGithubConnections = async () => {
			setLoadingGithubConnections(true);
			setGithubOptionsError(null);
			try {
				const response = await api.appConnection.list({ limit: 100 });
				if (cancelled) {
					return;
				}
				const nextConnections = response.data.filter(isGithubConnection);
				setGithubConnections(nextConnections);
				setSelectedGithubConnectionId((current) => {
					if (
						current &&
						nextConnections.some(
							(connection) => connection.externalId === current,
						)
					) {
						return current;
					}
					return nextConnections[0]?.externalId ?? null;
				});
			} catch (error) {
				if (cancelled) {
					return;
				}
				setGithubOptionsError(
					error instanceof Error
						? error.message
						: "Failed to load GitHub connections.",
				);
			} finally {
				if (!cancelled) {
					setLoadingGithubConnections(false);
				}
			}
		};

		void loadGithubConnections();
		return () => {
			cancelled = true;
		};
	}, [githubRunForm]);

	useEffect(() => {
		if (!githubRunForm || !selectedGithubConnectionId) {
			setOwnerOptions([]);
			return;
		}

		let cancelled = false;
		const loadOwners = async () => {
			setLoadingOwners(true);
			setGithubOptionsError(null);
			try {
				const response = await api.builtin.getOptions({
					actionName: "dapr-swe/initialize",
					propertyName: "owner",
					connectionExternalId: selectedGithubConnectionId,
				});
				if (cancelled) {
					return;
				}
				setOwnerOptions(response.options);
				setValues((current) => {
					const currentOwner =
						typeof current.owner === "string" ? current.owner : "";
					if (
						currentOwner &&
						response.options.some((option) => option.value === currentOwner)
					) {
						return current;
					}
					const nextOwner = response.options[0]?.value ?? "";
					return {
						...current,
						owner: nextOwner,
						repo: "",
					};
				});
			} catch (error) {
				if (cancelled) {
					return;
				}
				setGithubOptionsError(
					error instanceof Error
						? error.message
						: "Failed to load GitHub owners.",
				);
				setOwnerOptions([]);
			} finally {
				if (!cancelled) {
					setLoadingOwners(false);
				}
			}
		};

		void loadOwners();
		return () => {
			cancelled = true;
		};
	}, [githubRunForm, selectedGithubConnectionId]);

	const selectedOwner =
		typeof values.owner === "string" ? values.owner.trim() : "";

	useEffect(() => {
		if (!githubRunForm || !selectedGithubConnectionId || !selectedOwner) {
			setRepoOptions([]);
			return;
		}

		let cancelled = false;
		const loadRepos = async () => {
			setLoadingRepos(true);
			setGithubOptionsError(null);
			try {
				const response = await api.builtin.getOptions({
					actionName: "dapr-swe/initialize",
					propertyName: "repo",
					connectionExternalId: selectedGithubConnectionId,
					input: { owner: selectedOwner },
				});
				if (cancelled) {
					return;
				}
				setRepoOptions(response.options);
				setValues((current) => {
					const currentRepo =
						typeof current.repo === "string" ? current.repo : "";
					if (
						currentRepo &&
						response.options.some((option) => option.value === currentRepo)
					) {
						return current;
					}
					return {
						...current,
						repo: response.options[0]?.value ?? "",
					};
				});
			} catch (error) {
				if (cancelled) {
					return;
				}
				setGithubOptionsError(
					error instanceof Error
						? error.message
						: "Failed to load repositories.",
				);
				setRepoOptions([]);
			} finally {
				if (!cancelled) {
					setLoadingRepos(false);
				}
			}
		};

		void loadRepos();
		return () => {
			cancelled = true;
		};
	}, [githubRunForm, selectedGithubConnectionId, selectedOwner]);

	const setFieldValue = (fieldName: string, value: string | boolean) =>
		setValues((current) => ({
			...current,
			[fieldName]: value,
		}));

	const renderStandardField = (field: McpInputProperty) => {
		const fieldError = showErrors ? validation.errors[field.name] : null;
		const value = values[field.name] ?? getDefaultDraftValue(field);
		const isJsonField = field.type === "ARRAY" || field.type === "OBJECT";
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
						<p className="text-muted-foreground text-xs">{field.description}</p>
					) : null}
				</div>

				{field.type === "BOOLEAN" ? (
					<div className="flex items-center gap-3 rounded-md border px-3 py-2">
						<Checkbox
							checked={Boolean(value)}
							id={`trigger-input-${field.name}`}
							onCheckedChange={(checked) =>
								setFieldValue(field.name, Boolean(checked))
							}
						/>
						<Label
							className="font-normal"
							htmlFor={`trigger-input-${field.name}`}
						>
							{field.description || `Set ${formatFieldLabel(field.name)}`}
						</Label>
					</div>
				) : isLongTextField ? (
					<Textarea
						id={`trigger-input-${field.name}`}
						onChange={(event) => setFieldValue(field.name, event.target.value)}
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
						onChange={(event) => setFieldValue(field.name, event.target.value)}
						placeholder={`Enter ${formatFieldLabel(field.name).toLowerCase()}`}
						type={field.type === "NUMBER" ? "number" : "date"}
						value={String(value)}
					/>
				)}

				{field.name === "feature_request" ? (
					<p className="text-xs font-medium text-foreground">
						Paste the feature description here when you run the workflow.
					</p>
				) : null}

				{fieldError ? (
					<p className="text-destructive text-xs">{fieldError}</p>
				) : null}
			</div>
		);
	};

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
					label: submitLabel ?? "Run Workflow",
					variant: "default",
					onClick: handleRun,
				},
				{ label: "Cancel", onClick: closeAll },
			]}
			description={
				description ??
				"Enter the workflow execution values for this run. Put the task details here, not in the node description."
			}
			overlayId={overlayId}
			title={title}
		>
			<div className="space-y-4">
				<div className="rounded-lg border border-blue-200 bg-blue-50/70 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/20">
					<p className="font-medium text-foreground">
						This form collects the per-run input for
						{contextLabel
							? ` ${contextLabel}`
							: triggerLabel
								? ` ${triggerLabel}`
								: " this workflow"}
						.
					</p>
					<p className="mt-1 text-muted-foreground">
						The Description field in the editor is only a static note on the
						canvas. It does not become agent input.
					</p>
				</div>

				{githubRunForm ? (
					<div className="space-y-4 rounded-lg border bg-muted/20 p-4">
						<div className="flex items-start gap-3">
							<div className="rounded-md border bg-background p-2">
								<Github className="size-4" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="font-medium text-foreground">
									Choose the GitHub target
								</p>
								<p className="text-muted-foreground text-xs">
									Repository details come from your authenticated GitHub
									connection so you do not need to type owner and repo names
									manually.
								</p>
							</div>
						</div>

						{githubConnections.length > 1 ? (
							<SearchablePicker
								description="Select which authenticated GitHub connection to use for repository lookup."
								fieldName="github-connection"
								label="GitHub Connection"
								loading={loadingGithubConnections}
								onSelect={(nextValue) => {
									setSelectedGithubConnectionId(nextValue);
									setValues((current) => ({ ...current, owner: "", repo: "" }));
								}}
								options={githubConnections.map((connection) => ({
									label: resolveConnectionLabel(connection),
									value: connection.externalId,
								}))}
								placeholder={
									loadingGithubConnections
										? "Loading GitHub connections..."
										: "Select a GitHub connection"
								}
								required={false}
								value={selectedGithubConnectionId ?? ""}
							/>
						) : null}

						{githubConnections.length === 0 && !loadingGithubConnections ? (
							<div className="rounded-md border border-dashed p-3 text-sm">
								<p className="font-medium text-foreground">
									No active GitHub connection found
								</p>
								<p className="mt-1 text-muted-foreground">
									Connect GitHub in Settings or Connections to unlock owner and
									repository pickers. You can still type values manually below.
								</p>
							</div>
						) : null}

						{githubOptionsError ? (
							<div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
								{githubOptionsError}
							</div>
						) : null}

						{hasGithubSelectors ? (
							<>
								<SearchablePicker
									description="GitHub owner or organization for the repository."
									disabled={
										!selectedGithubConnectionId || ownerOptions.length === 0
									}
									error={showErrors ? validation.errors.owner : null}
									fieldName="owner"
									label="Owner"
									loading={loadingOwners}
									onSelect={(nextValue) => {
										setValues((current) => ({
											...current,
											owner: nextValue,
											repo: "",
										}));
									}}
									options={ownerOptions}
									placeholder={
										loadingOwners
											? "Loading owners..."
											: "Select a GitHub owner"
									}
									value={selectedOwner}
								/>
								<SearchablePicker
									description="GitHub repository name to inspect and update."
									disabled={
										!selectedGithubConnectionId ||
										!selectedOwner ||
										repoOptions.length === 0
									}
									error={showErrors ? validation.errors.repo : null}
									fieldName="repo"
									label="Repository"
									loading={loadingRepos}
									onSelect={(nextValue) => setFieldValue("repo", nextValue)}
									options={repoOptions}
									placeholder={
										loadingRepos
											? "Loading repositories..."
											: selectedOwner
												? "Select a repository"
												: "Select an owner first"
									}
									value={typeof values.repo === "string" ? values.repo : ""}
								/>
							</>
						) : null}
					</div>
				) : null}

				{fields.length === 0 ? (
					<div className="rounded-lg border border-dashed p-4 text-sm">
						<p className="font-medium text-foreground">
							{emptyStateTitle ?? "No workflow inputs are configured."}
						</p>
						<p className="mt-1 text-muted-foreground">
							{emptyStateDescription ??
								"Add run input fields before starting this workflow."}
						</p>
					</div>
				) : (
					renderedFields.map((field) => renderStandardField(field))
				)}
			</div>
		</Overlay>
	);
}

export const DaprInputOverlay = ManualTriggerInputOverlay;
