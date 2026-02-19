"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import {
	ModelSelector,
	type ModelOption,
} from "@/components/ai-elements/model-selector";
import {
	api,
	type AgentData,
	type AgentProfileListItemData,
	type CreateAgentBody,
	type ModelCatalogModelData,
	type ResourceModelProfileData,
	type ResourcePromptData,
	type ResourceSchemaData,
	type UpdateAgentBody,
} from "@/lib/api-client";
import { DEFAULT_MODEL_OPTIONS } from "@/lib/models/catalog-defaults";

const AGENT_TYPES = [
	{ value: "general", label: "General Purpose" },
	{ value: "code-assistant", label: "Code Assistant" },
	{ value: "research", label: "Research" },
	{ value: "planning", label: "Planning" },
	{ value: "custom", label: "Custom" },
] as const;

const AGENT_TOOLS = [
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"bash",
] as const;

function parseModelSpec(spec: string): { provider: string; name: string } {
	const idx = spec.indexOf("/");
	if (idx === -1) return { provider: "openai", name: spec };
	return { provider: spec.slice(0, idx), name: spec.slice(idx + 1) };
}

function formatModelSpec(model: { provider: string; name: string }): string {
	return `${model.provider}/${model.name}`;
}

type AgentEditorProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agent?: AgentData | null;
	onSave: (data: CreateAgentBody | UpdateAgentBody) => Promise<void>;
};

export function AgentEditor({
	open,
	onOpenChange,
	agent,
	onSave,
}: AgentEditorProps) {
	const isEdit = !!agent;

	const [name, setName] = useState(agent?.name ?? "");
	const [description, setDescription] = useState(agent?.description ?? "");
	const [agentType, setAgentType] = useState(agent?.agentType ?? "general");
	const [instructions, setInstructions] = useState(agent?.instructions ?? "");
	const [modelSpec, setModelSpec] = useState(
		agent ? formatModelSpec(agent.model) : "openai/gpt-4o",
	);
	const [selectedTools, setSelectedTools] = useState<Set<string>>(
		new Set(agent?.tools?.map((t) => t.ref) ?? AGENT_TOOLS),
	);
	const [maxTurns, setMaxTurns] = useState(String(agent?.maxTurns ?? 50));
	const [timeoutMinutes, setTimeoutMinutes] = useState(
		String(agent?.timeoutMinutes ?? 30),
	);
	const [isDefault, setIsDefault] = useState(agent?.isDefault ?? false);
	const [instructionsPresetId, setInstructionsPresetId] = useState(
		agent?.instructionsPresetId ?? "",
	);
	const [schemaPresetId, setSchemaPresetId] = useState(
		agent?.schemaPresetId ?? "",
	);
	const [modelProfileId, setModelProfileId] = useState(
		agent?.modelProfileId ?? "",
	);
	const [agentProfileTemplateId, setAgentProfileTemplateId] = useState(
		agent?.agentProfileTemplateId ?? "",
	);
	const [defaultOptions, setDefaultOptions] = useState<Record<
		string,
		unknown
	> | null>(agent?.defaultOptions ?? null);
	const [memoryConfig, setMemoryConfig] = useState<Record<
		string,
		unknown
	> | null>(agent?.memoryConfig ?? null);
	const [profileWarnings, setProfileWarnings] = useState<string[]>([]);
	const [applyingProfile, setApplyingProfile] = useState(false);
	const [promptPresets, setPromptPresets] = useState<ResourcePromptData[]>([]);
	const [schemaPresets, setSchemaPresets] = useState<ResourceSchemaData[]>([]);
	const [modelProfiles, setModelProfiles] = useState<
		ResourceModelProfileData[]
	>([]);
	const [agentProfiles, setAgentProfiles] = useState<
		AgentProfileListItemData[]
	>([]);
	const [catalogModels, setCatalogModels] = useState<ModelCatalogModelData[]>(
		[],
	);
	const [saving, setSaving] = useState(false);

	// Build the models list: include the built-in list plus the current value if custom
	const models = useMemo(() => {
		const builtIn: ModelOption[] =
			catalogModels.length > 0
				? catalogModels.map((model) => ({
						id: model.modelId,
						name: model.displayName,
						provider: model.iconKey || model.providerId,
						description: model.description || undefined,
					}))
				: [...DEFAULT_MODEL_OPTIONS];
		// If the current modelSpec isn't in the list, add it as a custom entry
		if (modelSpec && !builtIn.some((m) => m.id === modelSpec)) {
			const parsed = parseModelSpec(modelSpec);
			builtIn.unshift({
				id: modelSpec,
				name: `${parsed.name} (custom)`,
				provider: parsed.provider,
			});
		}
		return builtIn;
	}, [modelSpec]);

	const selectedModel = useMemo<ModelOption | null>(() => {
		if (!modelSpec) return null;
		return (
			models.find((m) => m.id === modelSpec) ?? {
				id: modelSpec,
				name: modelSpec,
				provider: parseModelSpec(modelSpec).provider,
			}
		);
	}, [modelSpec, models]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;

		(async () => {
			try {
				const [prompts, schemas, profiles, models, templateProfiles] =
					await Promise.all([
						api.resource.prompts.list(),
						api.resource.schemas.list(),
						api.resource.modelProfiles.list(),
						api.resource.models.list(),
						api.resource.agentProfiles.list(),
					]);
				if (cancelled) return;
				setPromptPresets(prompts.filter((p) => p.isEnabled));
				setSchemaPresets(schemas.filter((s) => s.isEnabled));
				setModelProfiles(profiles.filter((p) => p.isEnabled));
				setCatalogModels(models);
				setAgentProfiles(templateProfiles.filter((p) => p.isEnabled));
			} catch (error) {
				console.error("Failed to load resource presets:", error);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [open]);

	const handleSave = async () => {
		if (!name.trim() || (!instructions.trim() && !instructionsPresetId)) return;
		setSaving(true);
		try {
			const body: CreateAgentBody = {
				name: name.trim(),
				description: description.trim() || undefined,
				agentType,
				instructions: instructions.trim(),
				model: parseModelSpec(modelSpec),
				tools: [...selectedTools].map((ref) => ({
					type: "workspace" as const,
					ref,
				})),
				maxTurns: parseInt(maxTurns, 10) || 50,
				timeoutMinutes: parseInt(timeoutMinutes, 10) || 30,
				defaultOptions: defaultOptions ?? undefined,
				memoryConfig: memoryConfig ?? undefined,
				isDefault,
				instructionsPresetId: instructionsPresetId || null,
				schemaPresetId: schemaPresetId || null,
				modelProfileId: modelProfileId || null,
				agentProfileTemplateId: agentProfileTemplateId || null,
			};
			await onSave(body);
			onOpenChange(false);
		} finally {
			setSaving(false);
		}
	};

	const applyAgentProfileTemplate = async (templateId: string) => {
		if (!templateId) {
			setProfileWarnings([]);
			setAgentProfileTemplateId("");
			return;
		}

		setApplyingProfile(true);
		try {
			const preview = await api.resource.agentProfiles.preview(templateId);
			setAgentProfileTemplateId(templateId);
			setAgentType(preview.snapshot.agentType);
			setInstructions(preview.snapshot.instructions);
			setModelSpec(formatModelSpec(preview.snapshot.model));
			setSelectedTools(new Set(preview.snapshot.tools.map((tool) => tool.ref)));
			setMaxTurns(String(preview.snapshot.maxTurns));
			setTimeoutMinutes(String(preview.snapshot.timeoutMinutes));
			setDefaultOptions(preview.snapshot.defaultOptions);
			setMemoryConfig(preview.snapshot.memoryConfig);
			setProfileWarnings(preview.warnings.map((warning) => warning.message));
		} catch (error) {
			console.error("Failed to preview agent profile template:", error);
			setProfileWarnings(["Failed to load selected agent profile template"]);
		} finally {
			setApplyingProfile(false);
		}
	};

	const toggleTool = (tool: string) => {
		setSelectedTools((prev) => {
			const next = new Set(prev);
			if (next.has(tool)) next.delete(tool);
			else next.add(tool);
			return next;
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit Agent" : "Create Agent"}</DialogTitle>
				</DialogHeader>

				<Tabs defaultValue="general" className="mt-2">
					<TabsList className="grid w-full grid-cols-5">
						<TabsTrigger value="general">General</TabsTrigger>
						<TabsTrigger value="presets">Presets</TabsTrigger>
						<TabsTrigger value="model">Model</TabsTrigger>
						<TabsTrigger value="tools">Tools</TabsTrigger>
						<TabsTrigger value="execution">Execution</TabsTrigger>
					</TabsList>

					<TabsContent value="general" className="space-y-4 mt-4">
						<div className="space-y-2">
							<Label htmlFor="agent-name">Name</Label>
							<Input
								id="agent-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="My Code Assistant"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="agent-description">Description</Label>
							<Input
								id="agent-description"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="A helpful agent for code tasks"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="agent-type">Type</Label>
							<Select value={agentType} onValueChange={setAgentType}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{AGENT_TYPES.map((t) => (
										<SelectItem key={t.value} value={t.value}>
											{t.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="agent-instructions">Instructions</Label>
							<Textarea
								id="agent-instructions"
								value={instructions}
								onChange={(e) => setInstructions(e.target.value)}
								placeholder="You are a development assistant..."
								rows={8}
							/>
						</div>
						<div className="flex items-center gap-2">
							<Checkbox
								id="agent-default"
								checked={isDefault}
								onCheckedChange={(checked) => setIsDefault(checked === true)}
							/>
							<Label htmlFor="agent-default" className="text-sm">
								Set as default agent
							</Label>
						</div>
					</TabsContent>

					<TabsContent value="presets" className="space-y-4 mt-4">
						<div className="space-y-2">
							<Label htmlFor="agent-profile-template">
								Agent Profile Template
							</Label>
							<Select
								disabled={applyingProfile}
								value={agentProfileTemplateId || "__none__"}
								onValueChange={(value) =>
									applyAgentProfileTemplate(value === "__none__" ? "" : value)
								}
							>
								<SelectTrigger id="agent-profile-template">
									<SelectValue placeholder="Select agent profile template" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="__none__">None</SelectItem>
									{agentProfiles.map((profile) => (
										<SelectItem key={profile.id} value={profile.id}>
											{profile.name} (v{profile.defaultVersion})
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{profileWarnings.length > 0 ? (
								<div className="rounded-md border border-amber-400/40 bg-amber-50/60 p-2 text-amber-900 text-xs dark:bg-amber-950/20 dark:text-amber-200">
									{profileWarnings.join(" ")}
								</div>
							) : null}
						</div>
						<div className="space-y-2">
							<Label htmlFor="agent-prompt-preset">Prompt Preset</Label>
							<Select
								value={instructionsPresetId || "__none__"}
								onValueChange={(value) => {
									const next = value === "__none__" ? "" : value;
									setInstructionsPresetId(next);
									const selected = promptPresets.find((p) => p.id === next);
									if (selected && !instructions.trim()) {
										setInstructions(selected.systemPrompt);
									}
								}}
							>
								<SelectTrigger id="agent-prompt-preset">
									<SelectValue placeholder="Select prompt preset" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="__none__">None</SelectItem>
									{promptPresets.map((preset) => (
										<SelectItem key={preset.id} value={preset.id}>
											{preset.name} (v{preset.version})
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="agent-schema-preset">Schema Preset</Label>
							<Select
								value={schemaPresetId || "__none__"}
								onValueChange={(value) =>
									setSchemaPresetId(value === "__none__" ? "" : value)
								}
							>
								<SelectTrigger id="agent-schema-preset">
									<SelectValue placeholder="Select schema preset" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="__none__">None</SelectItem>
									{schemaPresets.map((preset) => (
										<SelectItem key={preset.id} value={preset.id}>
											{preset.name} (v{preset.version})
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="agent-model-profile">Model Profile</Label>
							<Select
								value={modelProfileId || "__none__"}
								onValueChange={(value) =>
									setModelProfileId(value === "__none__" ? "" : value)
								}
							>
								<SelectTrigger id="agent-model-profile">
									<SelectValue placeholder="Select model profile" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="__none__">None</SelectItem>
									{modelProfiles.map((profile) => (
										<SelectItem key={profile.id} value={profile.id}>
											{profile.name} (v{profile.version})
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</TabsContent>

					<TabsContent value="model" className="space-y-4 mt-4">
						<div className="space-y-2">
							<Label>Model</Label>
							<ModelSelector
								models={models}
								selectedModel={selectedModel}
								onModelChange={(m) => setModelSpec(m.id)}
								placeholder="Select a model"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="agent-model-custom">
								Custom Model (provider/model)
							</Label>
							<Input
								id="agent-model-custom"
								value={modelSpec}
								onChange={(e) => setModelSpec(e.target.value)}
								placeholder="openai/gpt-4o"
							/>
							<p className="text-xs text-muted-foreground">
								Pick from the dropdown or type a custom spec in
								&quot;provider/model&quot; format
							</p>
						</div>
					</TabsContent>

					<TabsContent value="tools" className="space-y-4 mt-4">
						<div className="space-y-2">
							<Label>Agent Tools</Label>
							<p className="text-xs text-muted-foreground mb-2">
								Select which opencode tools this agent can use
							</p>
							<div className="grid grid-cols-2 gap-2">
								{AGENT_TOOLS.map((tool) => (
									<div key={tool} className="flex items-center gap-2">
										<Checkbox
											id={`tool-${tool}`}
											checked={selectedTools.has(tool)}
											onCheckedChange={() => toggleTool(tool)}
										/>
										<Label
											htmlFor={`tool-${tool}`}
											className="text-sm font-mono"
										>
											{tool}
										</Label>
									</div>
								))}
							</div>
						</div>
						<div className="flex gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => setSelectedTools(new Set(AGENT_TOOLS))}
							>
								Select All
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setSelectedTools(new Set())}
							>
								Clear All
							</Button>
						</div>
					</TabsContent>

					<TabsContent value="execution" className="space-y-4 mt-4">
						<div className="space-y-2">
							<Label htmlFor="agent-max-turns">Max Turns</Label>
							<Input
								id="agent-max-turns"
								type="number"
								value={maxTurns}
								onChange={(e) => setMaxTurns(e.target.value)}
								min={1}
								max={500}
							/>
							<p className="text-xs text-muted-foreground">
								Maximum number of LLM/tool iterations per run
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="agent-timeout">Timeout (minutes)</Label>
							<Input
								id="agent-timeout"
								type="number"
								value={timeoutMinutes}
								onChange={(e) => setTimeoutMinutes(e.target.value)}
								min={1}
								max={480}
							/>
							<p className="text-xs text-muted-foreground">
								Maximum time before the agent run is terminated
							</p>
						</div>
					</TabsContent>
				</Tabs>

				<DialogFooter className="mt-4">
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={handleSave}
						disabled={
							saving ||
							!name.trim() ||
							(!instructions.trim() && !instructionsPresetId)
						}
					>
						{saving ? "Saving..." : isEdit ? "Update" : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
