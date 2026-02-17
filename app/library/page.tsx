"use client";

import { formatDistanceToNow } from "date-fns";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	ModelSelector,
	type ModelOption,
} from "@/components/ai-elements/model-selector";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
	api,
	type AgentProfileListItemData,
	type ModelCatalogModelData,
	type ResourceModelProfileData,
	type ResourcePromptData,
	type ResourceSchemaData,
} from "@/lib/api-client";
import { DEFAULT_MODEL_OPTIONS } from "@/lib/models/catalog-defaults";

type PromptDialogState = {
	open: boolean;
	editId: string | null;
	name: string;
	description: string;
	systemPrompt: string;
	userPrompt: string;
	promptMode: "system" | "system+user";
	isEnabled: boolean;
};

type SchemaDialogState = {
	open: boolean;
	editId: string | null;
	name: string;
	description: string;
	schemaJson: string;
	isEnabled: boolean;
};

type ModelProfileDialogState = {
	open: boolean;
	editId: string | null;
	name: string;
	description: string;
	modelId: string;
	defaultOptionsJson: string;
	maxTurns: string;
	timeoutMinutes: string;
	isEnabled: boolean;
};

const EMPTY_PROMPT: PromptDialogState = {
	open: false,
	editId: null,
	name: "",
	description: "",
	systemPrompt: "",
	userPrompt: "",
	promptMode: "system",
	isEnabled: true,
};

const EMPTY_SCHEMA: SchemaDialogState = {
	open: false,
	editId: null,
	name: "",
	description: "",
	schemaJson: "{}",
	isEnabled: true,
};

const EMPTY_MODEL_PROFILE: ModelProfileDialogState = {
	open: false,
	editId: null,
	name: "",
	description: "",
	modelId: "openai/gpt-4o",
	defaultOptionsJson: "{}",
	maxTurns: "",
	timeoutMinutes: "",
	isEnabled: true,
};

function parseModelSpec(spec: string): { provider: string; name: string } {
	const idx = spec.indexOf("/");
	if (idx === -1) return { provider: "openai", name: spec };
	return { provider: spec.slice(0, idx), name: spec.slice(idx + 1) };
}

function fmt(iso: string): string {
	return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

export default function LibraryPage() {
	const [loading, setLoading] = useState(true);
	const [prompts, setPrompts] = useState<ResourcePromptData[]>([]);
	const [schemas, setSchemas] = useState<ResourceSchemaData[]>([]);
	const [modelProfiles, setModelProfiles] = useState<
		ResourceModelProfileData[]
	>([]);
	const [catalogModels, setCatalogModels] = useState<ModelCatalogModelData[]>(
		[],
	);
	const [agentProfiles, setAgentProfiles] = useState<
		AgentProfileListItemData[]
	>([]);
	const [promptDialog, setPromptDialog] =
		useState<PromptDialogState>(EMPTY_PROMPT);
	const [schemaDialog, setSchemaDialog] =
		useState<SchemaDialogState>(EMPTY_SCHEMA);
	const [modelDialog, setModelDialog] =
		useState<ModelProfileDialogState>(EMPTY_MODEL_PROFILE);
	const [saving, setSaving] = useState(false);

	const reload = useCallback(async () => {
		setLoading(true);
		try {
			const [promptRows, schemaRows, profileRows, modelRows, agentProfileRows] =
				await Promise.all([
					api.resource.prompts.list(),
					api.resource.schemas.list(),
					api.resource.modelProfiles.list(),
					api.resource.models.list(),
					api.resource.agentProfiles.list(),
				]);
			setPrompts(promptRows);
			setSchemas(schemaRows);
			setModelProfiles(profileRows);
			setCatalogModels(modelRows);
			setAgentProfiles(agentProfileRows);
		} catch (error) {
			console.error("Failed to load library resources:", error);
			toast.error("Failed to load library resources");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		reload();
	}, [reload]);

	const promptTitle = useMemo(
		() => (promptDialog.editId ? "Edit Prompt Preset" : "New Prompt Preset"),
		[promptDialog.editId],
	);
	const schemaTitle = useMemo(
		() => (schemaDialog.editId ? "Edit Schema Preset" : "New Schema Preset"),
		[schemaDialog.editId],
	);
	const modelTitle = useMemo(
		() => (modelDialog.editId ? "Edit Model Profile" : "New Model Profile"),
		[modelDialog.editId],
	);
	const modelOptions = useMemo<ModelOption[]>(
		() =>
			catalogModels.length > 0
				? catalogModels.map((model) => ({
						id: model.modelId,
						name: model.displayName,
						provider: model.iconKey || model.providerId,
						description: model.description || undefined,
					}))
				: [...DEFAULT_MODEL_OPTIONS],
		[catalogModels],
	);
	const selectedModel = useMemo<ModelOption | null>(() => {
		if (!modelDialog.modelId.trim()) return null;
		return (
			modelOptions.find((model) => model.id === modelDialog.modelId) ?? {
				id: modelDialog.modelId,
				name: modelDialog.modelId,
				provider: parseModelSpec(modelDialog.modelId).provider,
			}
		);
	}, [modelDialog.modelId, modelOptions]);

	const savePrompt = async () => {
		if (!promptDialog.name.trim() || !promptDialog.systemPrompt.trim()) return;
		setSaving(true);
		try {
			const payload = {
				name: promptDialog.name.trim(),
				description: promptDialog.description.trim() || null,
				systemPrompt: promptDialog.systemPrompt,
				userPrompt: promptDialog.userPrompt.trim() || null,
				promptMode: promptDialog.promptMode,
				metadata: null,
				isEnabled: promptDialog.isEnabled,
				projectId: null,
			};
			if (promptDialog.editId) {
				await api.resource.prompts.update(promptDialog.editId, payload);
				toast.success("Prompt preset updated");
			} else {
				await api.resource.prompts.create(payload);
				toast.success("Prompt preset created");
			}
			setPromptDialog(EMPTY_PROMPT);
			await reload();
		} catch (error) {
			toast.error("Failed to save prompt preset");
		} finally {
			setSaving(false);
		}
	};

	const saveSchema = async () => {
		if (!schemaDialog.name.trim()) return;
		let parsedSchema: unknown;
		try {
			parsedSchema = JSON.parse(schemaDialog.schemaJson);
		} catch {
			toast.error("Schema JSON is invalid");
			return;
		}

		setSaving(true);
		try {
			const payload = {
				name: schemaDialog.name.trim(),
				description: schemaDialog.description.trim() || null,
				schema: parsedSchema,
				schemaType: "json-schema" as const,
				metadata: null,
				isEnabled: schemaDialog.isEnabled,
				projectId: null,
			};
			if (schemaDialog.editId) {
				await api.resource.schemas.update(schemaDialog.editId, payload);
				toast.success("Schema preset updated");
			} else {
				await api.resource.schemas.create(payload);
				toast.success("Schema preset created");
			}
			setSchemaDialog(EMPTY_SCHEMA);
			await reload();
		} catch (error) {
			toast.error("Failed to save schema preset");
		} finally {
			setSaving(false);
		}
	};

	const saveModelProfile = async () => {
		if (!modelDialog.name.trim() || !modelDialog.modelId.trim()) {
			return;
		}
		const parsedModel = parseModelSpec(modelDialog.modelId.trim());

		let parsedDefaultOptions: Record<string, unknown> | null = null;
		if (modelDialog.defaultOptionsJson.trim()) {
			try {
				parsedDefaultOptions = JSON.parse(
					modelDialog.defaultOptionsJson,
				) as Record<string, unknown>;
			} catch {
				toast.error("Default options JSON is invalid");
				return;
			}
		}

		setSaving(true);
		try {
			const payload = {
				name: modelDialog.name.trim(),
				description: modelDialog.description.trim() || null,
				model: {
					provider: parsedModel.provider,
					name: parsedModel.name,
				},
				defaultOptions: parsedDefaultOptions,
				maxTurns: modelDialog.maxTurns
					? Number.parseInt(modelDialog.maxTurns, 10)
					: null,
				timeoutMinutes: modelDialog.timeoutMinutes
					? Number.parseInt(modelDialog.timeoutMinutes, 10)
					: null,
				metadata: null,
				isEnabled: modelDialog.isEnabled,
				projectId: null,
			};
			if (modelDialog.editId) {
				await api.resource.modelProfiles.update(modelDialog.editId, payload);
				toast.success("Model profile updated");
			} else {
				await api.resource.modelProfiles.create(payload);
				toast.success("Model profile created");
			}
			setModelDialog(EMPTY_MODEL_PROFILE);
			await reload();
		} catch (error) {
			toast.error("Failed to save model profile");
		} finally {
			setSaving(false);
		}
	};

	const deletePrompt = async (id: string) => {
		try {
			await api.resource.prompts.delete(id);
			toast.success("Prompt preset deleted");
			await reload();
		} catch {
			toast.error("Failed to delete prompt preset");
		}
	};

	const deleteSchema = async (id: string) => {
		try {
			await api.resource.schemas.delete(id);
			toast.success("Schema preset deleted");
			await reload();
		} catch {
			toast.error("Failed to delete schema preset");
		}
	};

	const deleteModelProfile = async (id: string) => {
		try {
			await api.resource.modelProfiles.delete(id);
			toast.success("Model profile deleted");
			await reload();
		} catch {
			toast.error("Failed to delete model profile");
		}
	};

	return (
		<div className="pointer-events-auto mx-auto max-w-6xl p-6">
			<div className="mb-6">
				<h1 className="font-semibold text-2xl">Library</h1>
				<p className="text-muted-foreground text-sm">
					Manage reusable prompts, schemas, model profiles, and agent profiles.
				</p>
			</div>

			<Tabs defaultValue="prompts" className="space-y-4">
				<TabsList>
					<TabsTrigger value="prompts">Prompts</TabsTrigger>
					<TabsTrigger value="schemas">Schemas</TabsTrigger>
					<TabsTrigger value="models">Model Profiles</TabsTrigger>
					<TabsTrigger value="agent-profiles">Agent Profiles</TabsTrigger>
				</TabsList>

				<TabsContent value="prompts" className="space-y-4">
					<div className="flex justify-end">
						<Button
							onClick={() => setPromptDialog({ ...EMPTY_PROMPT, open: true })}
						>
							<Plus className="mr-2 size-4" />
							New Prompt Preset
						</Button>
					</div>
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Version</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Updated</TableHead>
									<TableHead className="w-[120px]" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{loading ? (
									<TableRow>
										<TableCell colSpan={5}>Loading...</TableCell>
									</TableRow>
								) : prompts.length === 0 ? (
									<TableRow>
										<TableCell colSpan={5}>No prompt presets yet.</TableCell>
									</TableRow>
								) : (
									prompts.map((row) => (
										<TableRow key={row.id}>
											<TableCell>{row.name}</TableCell>
											<TableCell>v{row.version}</TableCell>
											<TableCell>
												{row.isEnabled ? "Enabled" : "Disabled"}
											</TableCell>
											<TableCell>{fmt(row.updatedAt)}</TableCell>
											<TableCell>
												<div className="flex gap-1">
													<Button
														size="icon"
														variant="ghost"
														onClick={() =>
															setPromptDialog({
																open: true,
																editId: row.id,
																name: row.name,
																description: row.description || "",
																systemPrompt: row.systemPrompt,
																userPrompt: row.userPrompt || "",
																promptMode: row.promptMode,
																isEnabled: row.isEnabled,
															})
														}
													>
														<Pencil className="size-4" />
													</Button>
													<Button
														size="icon"
														variant="ghost"
														onClick={() => deletePrompt(row.id)}
													>
														<Trash2 className="size-4" />
													</Button>
												</div>
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</TabsContent>

				<TabsContent value="schemas" className="space-y-4">
					<div className="flex justify-end">
						<Button
							onClick={() => setSchemaDialog({ ...EMPTY_SCHEMA, open: true })}
						>
							<Plus className="mr-2 size-4" />
							New Schema Preset
						</Button>
					</div>
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Version</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Updated</TableHead>
									<TableHead className="w-[120px]" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{loading ? (
									<TableRow>
										<TableCell colSpan={5}>Loading...</TableCell>
									</TableRow>
								) : schemas.length === 0 ? (
									<TableRow>
										<TableCell colSpan={5}>No schema presets yet.</TableCell>
									</TableRow>
								) : (
									schemas.map((row) => (
										<TableRow key={row.id}>
											<TableCell>{row.name}</TableCell>
											<TableCell>v{row.version}</TableCell>
											<TableCell>
												{row.isEnabled ? "Enabled" : "Disabled"}
											</TableCell>
											<TableCell>{fmt(row.updatedAt)}</TableCell>
											<TableCell>
												<div className="flex gap-1">
													<Button
														size="icon"
														variant="ghost"
														onClick={() =>
															setSchemaDialog({
																open: true,
																editId: row.id,
																name: row.name,
																description: row.description || "",
																schemaJson: JSON.stringify(
																	row.schema ?? {},
																	null,
																	2,
																),
																isEnabled: row.isEnabled,
															})
														}
													>
														<Pencil className="size-4" />
													</Button>
													<Button
														size="icon"
														variant="ghost"
														onClick={() => deleteSchema(row.id)}
													>
														<Trash2 className="size-4" />
													</Button>
												</div>
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</TabsContent>

				<TabsContent value="models" className="space-y-4">
					<div className="flex justify-end">
						<Button
							onClick={() =>
								setModelDialog({ ...EMPTY_MODEL_PROFILE, open: true })
							}
						>
							<Plus className="mr-2 size-4" />
							New Model Profile
						</Button>
					</div>
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Model</TableHead>
									<TableHead>Version</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Updated</TableHead>
									<TableHead className="w-[120px]" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{loading ? (
									<TableRow>
										<TableCell colSpan={6}>Loading...</TableCell>
									</TableRow>
								) : modelProfiles.length === 0 ? (
									<TableRow>
										<TableCell colSpan={6}>No model profiles yet.</TableCell>
									</TableRow>
								) : (
									modelProfiles.map((row) => (
										<TableRow key={row.id}>
											<TableCell>{row.name}</TableCell>
											<TableCell>
												<code className="text-xs">
													{row.model.provider}/{row.model.name}
												</code>
											</TableCell>
											<TableCell>v{row.version}</TableCell>
											<TableCell>
												{row.isEnabled ? "Enabled" : "Disabled"}
											</TableCell>
											<TableCell>{fmt(row.updatedAt)}</TableCell>
											<TableCell>
												<div className="flex gap-1">
													<Button
														size="icon"
														variant="ghost"
														onClick={() =>
															setModelDialog({
																open: true,
																editId: row.id,
																name: row.name,
																description: row.description || "",
																modelId: `${row.model.provider}/${row.model.name}`,
																defaultOptionsJson: JSON.stringify(
																	row.defaultOptions ?? {},
																	null,
																	2,
																),
																maxTurns: row.maxTurns
																	? String(row.maxTurns)
																	: "",
																timeoutMinutes: row.timeoutMinutes
																	? String(row.timeoutMinutes)
																	: "",
																isEnabled: row.isEnabled,
															})
														}
													>
														<Pencil className="size-4" />
													</Button>
													<Button
														size="icon"
														variant="ghost"
														onClick={() => deleteModelProfile(row.id)}
													>
														<Trash2 className="size-4" />
													</Button>
												</div>
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</TabsContent>

				<TabsContent value="agent-profiles" className="space-y-4">
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Category</TableHead>
									<TableHead>Profile Version</TableHead>
									<TableHead>Preview Model</TableHead>
									<TableHead>Warnings</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{loading ? (
									<TableRow>
										<TableCell colSpan={5}>Loading...</TableCell>
									</TableRow>
								) : agentProfiles.length === 0 ? (
									<TableRow>
										<TableCell colSpan={5}>No agent profiles yet.</TableCell>
									</TableRow>
								) : (
									agentProfiles.map((profile) => (
										<TableRow key={profile.id}>
											<TableCell>{profile.name}</TableCell>
											<TableCell>{profile.category ?? "General"}</TableCell>
											<TableCell>v{profile.defaultVersion}</TableCell>
											<TableCell>
												<code className="text-xs">
													{profile.snapshotPreview.modelId}
												</code>
											</TableCell>
											<TableCell>{profile.warnings.length}</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</TabsContent>
			</Tabs>

			<Dialog
				open={promptDialog.open}
				onOpenChange={(open) => setPromptDialog((prev) => ({ ...prev, open }))}
			>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>{promptTitle}</DialogTitle>
					</DialogHeader>
					<div className="space-y-3">
						<div>
							<Label htmlFor="prompt-name">Name</Label>
							<Input
								id="prompt-name"
								value={promptDialog.name}
								onChange={(e) =>
									setPromptDialog((prev) => ({ ...prev, name: e.target.value }))
								}
							/>
						</div>
						<div>
							<Label htmlFor="prompt-description">Description</Label>
							<Input
								id="prompt-description"
								value={promptDialog.description}
								onChange={(e) =>
									setPromptDialog((prev) => ({
										...prev,
										description: e.target.value,
									}))
								}
							/>
						</div>
						<div>
							<Label htmlFor="prompt-mode">Prompt Mode</Label>
							<Select
								value={promptDialog.promptMode}
								onValueChange={(value) =>
									setPromptDialog((prev) => ({
										...prev,
										promptMode: value as "system" | "system+user",
									}))
								}
							>
								<SelectTrigger id="prompt-mode">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="system">System</SelectItem>
									<SelectItem value="system+user">System + User</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div>
							<Label htmlFor="system-prompt">System Prompt</Label>
							<Textarea
								id="system-prompt"
								rows={6}
								value={promptDialog.systemPrompt}
								onChange={(e) =>
									setPromptDialog((prev) => ({
										...prev,
										systemPrompt: e.target.value,
									}))
								}
							/>
						</div>
						<div>
							<Label htmlFor="user-prompt">User Prompt (optional)</Label>
							<Textarea
								id="user-prompt"
								rows={3}
								value={promptDialog.userPrompt}
								onChange={(e) =>
									setPromptDialog((prev) => ({
										...prev,
										userPrompt: e.target.value,
									}))
								}
							/>
						</div>
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setPromptDialog(EMPTY_PROMPT)}
						>
							Cancel
						</Button>
						<Button
							onClick={savePrompt}
							disabled={
								saving ||
								!promptDialog.name.trim() ||
								!promptDialog.systemPrompt.trim()
							}
						>
							{saving ? "Saving..." : "Save"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={schemaDialog.open}
				onOpenChange={(open) => setSchemaDialog((prev) => ({ ...prev, open }))}
			>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>{schemaTitle}</DialogTitle>
					</DialogHeader>
					<div className="space-y-3">
						<div>
							<Label htmlFor="schema-name">Name</Label>
							<Input
								id="schema-name"
								value={schemaDialog.name}
								onChange={(e) =>
									setSchemaDialog((prev) => ({ ...prev, name: e.target.value }))
								}
							/>
						</div>
						<div>
							<Label htmlFor="schema-description">Description</Label>
							<Input
								id="schema-description"
								value={schemaDialog.description}
								onChange={(e) =>
									setSchemaDialog((prev) => ({
										...prev,
										description: e.target.value,
									}))
								}
							/>
						</div>
						<div>
							<Label htmlFor="schema-json">JSON Schema</Label>
							<Textarea
								id="schema-json"
								rows={10}
								value={schemaDialog.schemaJson}
								onChange={(e) =>
									setSchemaDialog((prev) => ({
										...prev,
										schemaJson: e.target.value,
									}))
								}
							/>
						</div>
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setSchemaDialog(EMPTY_SCHEMA)}
						>
							Cancel
						</Button>
						<Button
							onClick={saveSchema}
							disabled={saving || !schemaDialog.name.trim()}
						>
							{saving ? "Saving..." : "Save"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={modelDialog.open}
				onOpenChange={(open) => setModelDialog((prev) => ({ ...prev, open }))}
			>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>{modelTitle}</DialogTitle>
					</DialogHeader>
					<div className="space-y-3">
						<div>
							<Label htmlFor="profile-name">Name</Label>
							<Input
								id="profile-name"
								value={modelDialog.name}
								onChange={(e) =>
									setModelDialog((prev) => ({ ...prev, name: e.target.value }))
								}
							/>
						</div>
						<div>
							<Label htmlFor="profile-description">Description</Label>
							<Input
								id="profile-description"
								value={modelDialog.description}
								onChange={(e) =>
									setModelDialog((prev) => ({
										...prev,
										description: e.target.value,
									}))
								}
							/>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="col-span-2">
								<Label>Model</Label>
								<ModelSelector
									models={modelOptions}
									selectedModel={selectedModel}
									onModelChange={(model) =>
										setModelDialog((prev) => ({
											...prev,
											modelId: model.id,
										}))
									}
									placeholder="Select model"
								/>
							</div>
							<div className="col-span-2">
								<Label htmlFor="profile-model-id">
									Custom Model ID (provider/model)
								</Label>
								<Input
									id="profile-model-id"
									value={modelDialog.modelId}
									onChange={(e) =>
										setModelDialog((prev) => ({
											...prev,
											modelId: e.target.value,
										}))
									}
									placeholder="openai/gpt-4o"
								/>
							</div>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div>
								<Label htmlFor="profile-max-turns">Max Turns (optional)</Label>
								<Input
									id="profile-max-turns"
									type="number"
									value={modelDialog.maxTurns}
									onChange={(e) =>
										setModelDialog((prev) => ({
											...prev,
											maxTurns: e.target.value,
										}))
									}
								/>
							</div>
							<div>
								<Label htmlFor="profile-timeout">
									Timeout Minutes (optional)
								</Label>
								<Input
									id="profile-timeout"
									type="number"
									value={modelDialog.timeoutMinutes}
									onChange={(e) =>
										setModelDialog((prev) => ({
											...prev,
											timeoutMinutes: e.target.value,
										}))
									}
								/>
							</div>
						</div>
						<div>
							<Label htmlFor="profile-default-options">
								Default Options (JSON)
							</Label>
							<Textarea
								id="profile-default-options"
								rows={8}
								value={modelDialog.defaultOptionsJson}
								onChange={(e) =>
									setModelDialog((prev) => ({
										...prev,
										defaultOptionsJson: e.target.value,
									}))
								}
							/>
						</div>
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setModelDialog(EMPTY_MODEL_PROFILE)}
						>
							Cancel
						</Button>
						<Button
							onClick={saveModelProfile}
							disabled={
								saving ||
								!modelDialog.name.trim() ||
								!modelDialog.modelId.trim()
							}
						>
							{saving ? "Saving..." : "Save"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
