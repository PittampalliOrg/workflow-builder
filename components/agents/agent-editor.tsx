"use client";

import { useMemo, useState } from "react";
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
import type { AgentData, CreateAgentBody, UpdateAgentBody } from "@/lib/api-client";

const AGENT_TYPES = [
	{ value: "general", label: "General Purpose" },
	{ value: "code-assistant", label: "Code Assistant" },
	{ value: "research", label: "Research" },
	{ value: "planning", label: "Planning" },
	{ value: "custom", label: "Custom" },
] as const;

const MODEL_LIST: ModelOption[] = [
	{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", provider: "openai" },
	{ id: "openai/gpt-5.2-codex", name: "GPT-5.2 Codex", provider: "openai" },
	{ id: "openai/gpt-4o", name: "GPT-4o", provider: "openai" },
	{ id: "openai/gpt-4o-mini", name: "GPT-4o mini", provider: "openai" },
	{ id: "openai/gpt-5.1-instant", name: "GPT-5.1 Instant", provider: "openai" },
	{ id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
	{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
	{ id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
	{ id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
	{ id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
];

const WORKSPACE_TOOLS = [
	"read_file",
	"write_file",
	"edit_file",
	"list_files",
	"delete_file",
	"mkdir",
	"file_stat",
	"execute_command",
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
		new Set(agent?.tools?.map((t) => t.ref) ?? WORKSPACE_TOOLS),
	);
	const [maxTurns, setMaxTurns] = useState(String(agent?.maxTurns ?? 50));
	const [timeoutMinutes, setTimeoutMinutes] = useState(
		String(agent?.timeoutMinutes ?? 30),
	);
	const [isDefault, setIsDefault] = useState(agent?.isDefault ?? false);
	const [saving, setSaving] = useState(false);

	// Build the models list: include the built-in list plus the current value if custom
	const models = useMemo(() => {
		const builtIn = [...MODEL_LIST];
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

	const handleSave = async () => {
		if (!name.trim() || !instructions.trim()) return;
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
				isDefault,
			};
			await onSave(body);
			onOpenChange(false);
		} finally {
			setSaving(false);
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
					<TabsList className="grid w-full grid-cols-4">
						<TabsTrigger value="general">General</TabsTrigger>
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
								onCheckedChange={(checked) =>
									setIsDefault(checked === true)
								}
							/>
							<Label htmlFor="agent-default" className="text-sm">
								Set as default agent
							</Label>
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
							<Label>Workspace Tools</Label>
							<p className="text-xs text-muted-foreground mb-2">
								Select which tools this agent can use
							</p>
							<div className="grid grid-cols-2 gap-2">
								{WORKSPACE_TOOLS.map((tool) => (
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
								onClick={() =>
									setSelectedTools(new Set(WORKSPACE_TOOLS))
								}
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
						disabled={saving || !name.trim() || !instructions.trim()}
					>
						{saving ? "Saving..." : isEdit ? "Update" : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
