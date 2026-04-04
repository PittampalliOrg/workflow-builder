<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		AlertTriangle,
		Code2,
		FileJson,
		Loader2,
		Play,
		Plus,
		RefreshCw,
		Save,
		Trash2,
		Waypoints,
	} from 'lucide-svelte';

	type Language = 'typescript' | 'python';

	interface ParserParam {
		name: string;
		required: boolean;
		description?: string | null;
		default_value?: unknown;
		type: {
			kind: string;
			name?: string | null;
			nullable?: boolean;
			item_type?: unknown;
			properties?: Array<{
				name: string;
				type: unknown;
				required: boolean;
				description?: string | null;
			}>;
			variants?: unknown[];
			enum_values?: unknown[];
			resource_type?: string | null;
			original?: string | null;
		};
		schema: Record<string, unknown>;
	}

interface ParserModel {
	language: Language;
	entrypoint: string;
	is_async: boolean;
		imports: Array<{
			specifier: string;
			kind: 'local' | 'external';
			resolved_path?: string | null;
	}>;
	params: ParserParam[];
	dynamic_inputs?: Array<{
		name: string;
		handler: string;
		depends_on?: string[];
		search?: boolean;
	}>;
	return_type: Record<string, unknown>;
	schema: Record<string, unknown>;
	diagnostics: Array<{ severity: 'error' | 'warning'; message: string }>;
		capabilities: Record<string, boolean>;
	}

	interface SavedCodeFunctionSummary {
		id: string;
		name: string;
		slug: string;
		description: string | null;
		version: string;
		language: Language;
		entrypoint: string;
		path: string | null;
		updatedAt: string;
		latestPublishedVersion: string | null;
		lastPublishedAt: string | null;
	}

	interface CodeFunctionRevisionSummary {
		id: string;
		version: string;
		publishedAt: string;
	}

	interface SavedCodeFunctionDetail extends SavedCodeFunctionSummary {
		source: string;
		supportingFiles: Record<string, string>;
		sourceHash: string;
		model: ParserModel | null;
		revisions: CodeFunctionRevisionSummary[];
	}

	const starterSources: Record<Language, string> = {
		typescript: `export async function main(input: { name: string; retries?: number; mode: "dev" | "prod" }) {
  return {
    message: \`Hello, \${input.name}\`,
    retries: input.retries ?? 1,
    mode: input.mode
  };
}`,
		python: `from dataclasses import dataclass
from typing import Literal

@dataclass
class Input:
    name: str
    retries: int = 1
    mode: Literal["dev", "prod"] = "dev"

def main(input: Input):
    return {
        "message": f"Hello, {input.name}",
        "retries": input.retries,
        "mode": input.mode,
    }`,
	};

	let codeFunctionId = $state<string | null>(null);
	let savedFunctions = $state<SavedCodeFunctionSummary[]>([]);
	let savedFunctionsError = $state<string | null>(null);
	let loadingList = $state(false);
	let loadingDetail = $state(false);
	let saving = $state(false);
	let deleting = $state(false);
	let running = $state(false);
	let publishing = $state(false);

	let language = $state<Language>('typescript');
	let name = $state('Untitled TypeScript Function');
	let description = $state('');
	let entrypoint = $state('main');
	let path = $state('functions/example.ts');
	let source = $state(starterSources.typescript);
	let supportingFilesText = $state('{}');
	let revisions = $state<CodeFunctionRevisionSummary[]>([]);
	let model = $state<ParserModel | null>(null);
	let errorMessage = $state<string | null>(null);
	let saveMessage = $state<string | null>(null);
	let loading = $state(false);
	let initialized = $state(false);
	let bootstrapped = $state(false);
	let runInput = $state('{}');
	let runResult = $state<string | null>(null);
	let runError = $state<string | null>(null);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let requestToken = 0;

	function defaultName(nextLanguage: Language): string {
		return nextLanguage === 'typescript'
			? 'Untitled TypeScript Function'
			: 'Untitled Python Function';
	}

	function resetStarter(nextLanguage: Language) {
		language = nextLanguage;
		path = nextLanguage === 'typescript' ? 'functions/example.ts' : 'functions/example.py';
		source = starterSources[nextLanguage];
		entrypoint = 'main';
		model = null;
		errorMessage = null;
	}

	function createNewDraft(nextLanguage: Language = language) {
		codeFunctionId = null;
		name = defaultName(nextLanguage);
		description = '';
		saveMessage = null;
		runResult = null;
		runError = null;
		runInput = '{}';
		supportingFilesText = '{}';
		revisions = [];
		resetStarter(nextLanguage);
	}

	function applySavedFunction(detail: SavedCodeFunctionDetail) {
		codeFunctionId = detail.id;
		name = detail.name;
		description = detail.description ?? '';
		language = detail.language;
		entrypoint = detail.entrypoint;
		path = detail.path ?? '';
		source = detail.source;
		supportingFilesText = JSON.stringify(detail.supportingFiles || {}, null, 2);
		revisions = detail.revisions || [];
		model = detail.model;
		errorMessage = null;
		saveMessage = `Loaded ${detail.name}`;
		runResult = null;
		runError = null;
	}

	async function loadSavedFunctions() {
		loadingList = true;
		savedFunctionsError = null;
		try {
			const response = await fetch('/api/code-functions');
			const payload = (await response.json().catch(() => null)) as
				| { functions?: SavedCodeFunctionSummary[]; count?: number; message?: string; error?: string }
				| { message?: string; error?: string };

			if (!response.ok) {
				savedFunctionsError =
					(typeof payload === 'object' && payload && 'error' in payload && payload.error) ||
					(typeof payload === 'object' && payload && 'message' in payload && payload.message) ||
					`HTTP ${response.status}`;
				return;
			}

			savedFunctions =
				payload && typeof payload === 'object' && 'functions' in payload && Array.isArray(payload.functions)
					? payload.functions
					: [];
		} catch (err) {
			savedFunctionsError = err instanceof Error ? err.message : String(err);
		} finally {
			loadingList = false;
		}
	}

	async function loadSavedFunction(id: string) {
		loadingDetail = true;
		saveMessage = null;
		try {
			const response = await fetch(`/api/code-functions/${id}`);
			const payload = (await response.json().catch(() => null)) as
				| SavedCodeFunctionDetail
				| { message?: string; error?: string }
				| null;

			if (!response.ok || !payload || !('id' in payload)) {
				errorMessage =
					(payload && 'error' in payload && payload.error) ||
					(payload && 'message' in payload && payload.message) ||
					`HTTP ${response.status}`;
				return;
			}

			applySavedFunction(payload);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loadingDetail = false;
		}
	}

	function schedulePreview() {
		if (!initialized) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			void runPreview();
		}, 250);
	}

	async function runPreview() {
		const currentToken = ++requestToken;
		loading = true;
		errorMessage = null;
		try {
			let parsedSupportingFiles: Record<string, string> = {};
			try {
				parsedSupportingFiles = supportingFilesText.trim()
					? (JSON.parse(supportingFilesText) as Record<string, string>)
					: {};
			} catch {
				errorMessage = 'Supporting files must be valid JSON.';
				model = null;
				return;
			}
			const response = await fetch('/api/code-functions/parse-preview', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					language,
					source,
					entrypoint: entrypoint.trim() || undefined,
					path: path.trim() || undefined,
					supporting_files: parsedSupportingFiles,
				}),
			});
			const payload = (await response.json().catch(() => null)) as
				| { model?: ParserModel; error?: string }
				| null;

			if (currentToken !== requestToken) return;

			if (!response.ok) {
				errorMessage = payload?.error || `HTTP ${response.status}`;
				model = null;
				return;
			}

			model = payload?.model || null;
		} catch (err) {
			if (currentToken !== requestToken) return;
			errorMessage = err instanceof Error ? err.message : String(err);
			model = null;
		} finally {
			if (currentToken === requestToken) {
				loading = false;
			}
		}
	}

	async function saveFunction() {
		saving = true;
		saveMessage = null;
		errorMessage = null;
		try {
			let parsedSupportingFiles: Record<string, string> = {};
			try {
				parsedSupportingFiles = supportingFilesText.trim()
					? (JSON.parse(supportingFilesText) as Record<string, string>)
					: {};
			} catch {
				errorMessage = 'Supporting files must be valid JSON.';
				return;
			}

			const isUpdate = Boolean(codeFunctionId);
			const response = await fetch(
				codeFunctionId ? `/api/code-functions/${codeFunctionId}` : '/api/code-functions',
				{
					method: codeFunctionId ? 'PUT' : 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						name,
						description,
						language,
						entrypoint,
						path,
						source,
						supportingFiles: parsedSupportingFiles,
					}),
				},
			);

			const payload = (await response.json().catch(() => null)) as
				| SavedCodeFunctionDetail
				| { message?: string; error?: string }
				| null;

			if (!response.ok || !payload || !('id' in payload)) {
				errorMessage =
					(payload && 'error' in payload && payload.error) ||
					(payload && 'message' in payload && payload.message) ||
					`HTTP ${response.status}`;
				return;
			}

			applySavedFunction(payload);
			await loadSavedFunctions();
			saveMessage = isUpdate ? `Saved ${payload.name}` : `Created ${payload.name}`;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function publishFunction() {
		if (!codeFunctionId) {
			errorMessage = 'Save the code function before publishing it.';
			return;
		}

		publishing = true;
		saveMessage = null;
		errorMessage = null;
		try {
			const response = await fetch(`/api/code-functions/${codeFunctionId}/publish`, {
				method: 'POST',
			});
			const payload = (await response.json().catch(() => null)) as
				| SavedCodeFunctionDetail
				| { message?: string; error?: string }
				| null;

			if (!response.ok || !payload || !('id' in payload)) {
				errorMessage =
					(payload && 'error' in payload && payload.error) ||
					(payload && 'message' in payload && payload.message) ||
					`HTTP ${response.status}`;
				return;
			}

			applySavedFunction(payload);
			await loadSavedFunctions();
			saveMessage = `Published ${payload.name} as ${payload.latestPublishedVersion || payload.version}`;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			publishing = false;
		}
	}

	async function deleteFunction() {
		if (!codeFunctionId) return;
		if (!window.confirm(`Delete ${name}?`)) return;

		deleting = true;
		saveMessage = null;
		errorMessage = null;
		try {
			const response = await fetch(`/api/code-functions/${codeFunctionId}`, {
				method: 'DELETE',
			});
			const payload = (await response.json().catch(() => null)) as
				| { success?: boolean; id?: string; message?: string; error?: string }
				| null;

			if (!response.ok || !payload?.success) {
				errorMessage =
					payload?.error || payload?.message || `HTTP ${response.status}`;
				return;
			}

			const deletedName = name;
			createNewDraft(language);
			await loadSavedFunctions();
			saveMessage = `Deleted ${deletedName}`;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			deleting = false;
		}
	}

	async function executeFunction() {
		if (!codeFunctionId) {
			runError = 'Save the code function before running it.';
			return;
		}

		running = true;
		runError = null;
		runResult = null;

		let parsedInput: Record<string, unknown> = {};
		try {
			parsedInput = runInput.trim() ? (JSON.parse(runInput) as Record<string, unknown>) : {};
		} catch {
			runError = 'Run input must be valid JSON.';
			running = false;
			return;
		}

		try {
			const response = await fetch(`/api/code-functions/${codeFunctionId}/execute`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ input: parsedInput }),
			});

			const payload = (await response.json().catch(() => null)) as
				| { success?: boolean; data?: unknown; error?: string; routed_to?: string; duration_ms?: number }
				| { message?: string; error?: string }
				| null;

			if (!response.ok || !payload) {
				runError =
					(payload && 'error' in payload && payload.error) ||
					(payload && 'message' in payload && payload.message) ||
					`HTTP ${response.status}`;
				return;
			}

			if ('success' in payload && payload.success === false) {
				runError = payload.error || 'Execution failed';
				runResult = JSON.stringify(payload, null, 2);
				return;
			}

			runResult = JSON.stringify(payload, null, 2);
		} catch (err) {
			runError = err instanceof Error ? err.message : String(err);
		} finally {
			running = false;
		}
	}

	$effect(() => {
		if (bootstrapped) return;
		bootstrapped = true;
		void loadSavedFunctions();
	});

	$effect(() => {
		initialized = true;
		schedulePreview();
	});

	$effect(() => {
		language;
		entrypoint;
		path;
		source;
		schedulePreview();
	});

	$effect(() => {
		return () => {
			if (debounceTimer) clearTimeout(debounceTimer);
		};
	});
</script>

<svelte:head>
	<title>Code Functions</title>
</svelte:head>

<div class="min-h-full bg-[radial-gradient(circle_at_top_left,rgba(110,168,254,0.18),transparent_28%),radial-gradient(circle_at_top_right,rgba(45,212,191,0.16),transparent_26%),linear-gradient(180deg,rgba(2,6,23,0.02),transparent_34%)]">
	<div class="mx-auto flex w-full max-w-[1760px] flex-col gap-6 p-6">
		<div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
			<div class="flex flex-col gap-2">
				<div class="flex items-center gap-2">
					<Code2 size={18} />
					<h1 class="text-xl font-semibold tracking-tight">Code Functions</h1>
					<Badge variant="secondary" class="text-[10px]">TS / Python registry</Badge>
				</div>
				<p class="max-w-3xl text-sm text-muted-foreground">
					Author parser-backed code functions, persist their semantic model, and inspect the generated schema before you connect them to the wider workflow system.
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<Button variant="outline" size="sm" onclick={() => runPreview()} disabled={loading}>
					{#if loading}
						<Loader2 size={14} class="animate-spin" />
					{:else}
						<Play size={14} />
					{/if}
					Parse
				</Button>
				<Button variant="default" size="sm" onclick={saveFunction} disabled={saving || deleting}>
					{#if saving}
						<Loader2 size={14} class="animate-spin" />
					{:else}
						<Save size={14} />
					{/if}
					Save
				</Button>
				<Button variant="outline" size="sm" onclick={() => createNewDraft()}>
					<Plus size={14} />
					New
				</Button>
				<Button
					variant="secondary"
					size="sm"
					onclick={publishFunction}
					disabled={!codeFunctionId || publishing || saving || deleting}
				>
					{#if publishing}
						<Loader2 size={14} class="animate-spin" />
					{:else}
						<RefreshCw size={14} />
					{/if}
					Publish
				</Button>
				<Button
					variant="secondary"
					size="sm"
					onclick={executeFunction}
					disabled={!codeFunctionId || running || saving || deleting}
				>
					{#if running}
						<Loader2 size={14} class="animate-spin" />
					{:else}
						<Play size={14} />
					{/if}
					Run
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onclick={deleteFunction}
					disabled={!codeFunctionId || deleting || saving}
				>
					{#if deleting}
						<Loader2 size={14} class="animate-spin" />
					{:else}
						<Trash2 size={14} />
					{/if}
					Delete
				</Button>
			</div>
		</div>

		<div class="grid gap-6 xl:grid-cols-[280px_minmax(0,1.1fr)_minmax(420px,0.8fr)]">
			<Card class="border-border/70 bg-card/90 shadow-sm backdrop-blur-sm">
				<CardHeader class="pb-3">
					<CardTitle class="flex items-center justify-between gap-3 text-sm">
						<span>Saved Functions</span>
						<Button variant="ghost" size="sm" onclick={() => loadSavedFunctions()} disabled={loadingList}>
							{#if loadingList}
								<Loader2 size={14} class="animate-spin" />
							{:else}
								<RefreshCw size={14} />
							{/if}
						</Button>
					</CardTitle>
				</CardHeader>
				<CardContent class="space-y-3">
					{#if savedFunctionsError}
						<div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
							{savedFunctionsError}
						</div>
					{/if}

					<div class="rounded-lg border border-border/70 p-3">
						<p class="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Draft</p>
						<p class="mt-1 text-sm font-medium">{name}</p>
						<p class="text-xs text-muted-foreground">
							{codeFunctionId
								? `${language} · ${entrypoint}${savedFunctions.find((item) => item.id === codeFunctionId)?.latestPublishedVersion ? ` · ${savedFunctions.find((item) => item.id === codeFunctionId)?.latestPublishedVersion}` : ''}`
								: 'Unsaved'}
						</p>
					</div>

					<div class="max-h-[620px] space-y-2 overflow-auto pr-1">
						{#if !loadingList && savedFunctions.length === 0}
							<p class="rounded-lg border border-dashed border-border/70 p-3 text-xs text-muted-foreground">
								No saved code functions yet.
							</p>
						{/if}

						{#each savedFunctions as item}
							<button
								class={`w-full rounded-lg border p-3 text-left transition-colors ${
									codeFunctionId === item.id
										? 'border-primary/40 bg-primary/5'
										: 'border-border/70 hover:bg-accent/40'
								}`}
								onclick={() => loadSavedFunction(item.id)}
								disabled={loadingDetail}
							>
								<div class="flex items-start justify-between gap-2">
									<div class="min-w-0 flex-1">
										<p class="truncate text-sm font-medium">{item.name}</p>
										<p class="mt-1 text-[11px] text-muted-foreground">
											{item.language} · {item.entrypoint}
										</p>
									</div>
									<div class="flex flex-col items-end gap-1">
										<Badge variant="secondary" class="text-[10px]">{item.version}</Badge>
										{#if item.latestPublishedVersion}
											<Badge variant="outline" class="text-[10px]">{item.latestPublishedVersion}</Badge>
										{/if}
									</div>
								</div>
								{#if item.description}
									<p class="mt-2 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
								{/if}
							</button>
						{/each}
					</div>
				</CardContent>
			</Card>

			<Card class="border-border/70 bg-card/90 shadow-sm backdrop-blur-sm">
				<CardHeader class="pb-3">
					<CardTitle class="text-sm">Source</CardTitle>
				</CardHeader>
				<CardContent class="space-y-4">
					<div class="grid gap-3 md:grid-cols-2">
						<div class="space-y-1.5">
							<label class="text-xs font-medium text-muted-foreground" for="code-function-name">Name</label>
							<Input id="code-function-name" bind:value={name} placeholder="Untitled TypeScript Function" />
						</div>
						<div class="space-y-1.5">
							<label class="text-xs font-medium text-muted-foreground" for="code-function-language">Language</label>
							<NativeSelect
								id="code-function-language"
								bind:value={language}
								onchange={() => createNewDraft(language)}
							>
								<option value="typescript">TypeScript</option>
								<option value="python">Python</option>
							</NativeSelect>
						</div>
					</div>

					<div class="space-y-1.5">
						<label class="text-xs font-medium text-muted-foreground" for="code-function-description">Description</label>
						<Textarea
							id="code-function-description"
							bind:value={description}
							class="min-h-[84px] text-sm"
							placeholder="Describe what this function does."
						/>
					</div>

					<div class="grid gap-3 md:grid-cols-2">
						<div class="space-y-1.5">
							<label class="text-xs font-medium text-muted-foreground" for="code-function-entrypoint">Entrypoint</label>
							<Input id="code-function-entrypoint" bind:value={entrypoint} placeholder="main" />
						</div>
						<div class="space-y-1.5">
							<label class="text-xs font-medium text-muted-foreground" for="code-function-path">Path</label>
							<Input id="code-function-path" bind:value={path} placeholder="functions/example.ts" />
						</div>
					</div>

					<div class="space-y-1.5">
						<label class="text-xs font-medium text-muted-foreground" for="code-function-source">Source</label>
						<Textarea
							id="code-function-source"
							bind:value={source}
							class="min-h-[560px] font-mono text-[12px] leading-5"
							spellcheck="false"
						/>
					</div>

					<div class="space-y-1.5">
						<label class="text-xs font-medium text-muted-foreground" for="code-function-supporting-files">Supporting Files JSON</label>
						<Textarea
							id="code-function-supporting-files"
							bind:value={supportingFilesText}
							class="min-h-[160px] font-mono text-[11px] leading-5"
							spellcheck="false"
							placeholder={`{"lib/helpers.ts":"export const helper = () => 'ok';"}`}
						/>
						<div class="rounded-md border border-border/60 bg-muted/30 p-3 text-[11px] text-muted-foreground">
							<p>Use `supportingFiles` for local imports and add metadata directives in comments when needed.</p>
							<p class="mt-1 font-mono">
								// @wf-resource connection github
							</p>
							<p class="mt-1 font-mono">
								// @wf-dynamic-options calendar list_calendars dependsOn=connection
							</p>
						</div>
					</div>
				</CardContent>
			</Card>

			<div class="space-y-4">
				<Card class="border-border/70 bg-card/90 shadow-sm backdrop-blur-sm">
					<CardHeader class="pb-3">
						<CardTitle class="flex items-center justify-between gap-3 text-sm">
							<span>Preview</span>
							<div class="flex items-center gap-2">
								{#if loading || loadingDetail}
									<Badge variant="secondary" class="gap-1 text-[10px]">
										<Loader2 size={10} class="animate-spin" />
										{loadingDetail ? 'Loading' : 'Parsing'}
									</Badge>
								{:else if model}
									<Badge variant="default" class="text-[10px]">Ready</Badge>
								{:else if errorMessage}
									<Badge variant="destructive" class="gap-1 text-[10px]">
										<AlertTriangle size={10} />
										Error
									</Badge>
								{/if}
							</div>
						</CardTitle>
					</CardHeader>
					<CardContent class="space-y-4">
						{#if saveMessage}
							<div class="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
								{saveMessage}
							</div>
						{/if}

						{#if errorMessage}
							<div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
								{errorMessage}
							</div>
						{/if}

						{#if model}
							<div class="grid gap-3 sm:grid-cols-2">
								<div class="rounded-lg border border-border/70 p-3">
									<p class="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Entrypoint</p>
									<p class="mt-1 text-sm font-medium">{model.entrypoint}</p>
									<p class="text-xs text-muted-foreground">{model.language} · {model.is_async ? 'async' : 'sync'}</p>
								</div>
								<div class="rounded-lg border border-border/70 p-3">
									<p class="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Capabilities</p>
									<div class="mt-2 flex flex-wrap gap-1.5">
										{#each Object.entries(model.capabilities).filter(([, value]) => value) as [capability]}
											<Badge variant="secondary" class="text-[10px]">{capability.replaceAll('_', ' ')}</Badge>
										{/each}
									</div>
								</div>
							</div>

							<div class="space-y-2">
								<div class="flex items-center gap-2 text-xs font-medium">
									<Waypoints size={14} />
									Parameters
								</div>
								<div class="space-y-2">
									{#each model.params as param}
										<div class="rounded-lg border border-border/70 p-3">
											<div class="flex items-start justify-between gap-3">
												<div>
													<p class="text-sm font-medium">{param.name}</p>
													<p class="text-xs text-muted-foreground">
														{param.type.kind}{param.type.nullable ? ' nullable' : ''}{param.required ? ' · required' : ' · optional'}
													</p>
												</div>
												{#if param.default_value !== undefined}
													<Badge variant="outline" class="text-[10px]">default: {JSON.stringify(param.default_value)}</Badge>
												{/if}
											</div>
											{#if param.description}
												<p class="mt-2 text-xs text-muted-foreground">{param.description}</p>
											{/if}
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</CardContent>
				</Card>

				<Card class="border-border/70 bg-card/90 shadow-sm backdrop-blur-sm">
					<CardHeader class="pb-3">
						<CardTitle class="flex items-center gap-2 text-sm">
							<FileJson size={14} />
							Schema, Imports, Diagnostics
						</CardTitle>
					</CardHeader>
					<CardContent class="space-y-4">
						<div class="space-y-2">
							<p class="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Generated schema</p>
							<pre class="max-h-56 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-3 text-[11px] leading-5"><code>{model ? JSON.stringify(model.schema, null, 2) : '{}'}</code></pre>
						</div>
						<div class="space-y-2">
							<p class="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Published revisions</p>
							{#if revisions.length > 0}
								<div class="flex flex-wrap gap-1.5">
									{#each revisions as revision}
										<Badge variant="outline" class="text-[10px]">
											{revision.version}
										</Badge>
									{/each}
								</div>
							{:else}
								<p class="text-xs text-muted-foreground">No published revisions yet.</p>
							{/if}
						</div>
						<div class="space-y-2">
							<p class="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Imports</p>
							{#if model?.imports?.length}
								<div class="space-y-1.5">
									{#each model.imports as item}
										<div class="rounded-md border border-border/70 px-3 py-2 text-xs">
											<div class="flex items-center justify-between gap-3">
												<span class="font-medium">{item.specifier}</span>
												<Badge variant={item.kind === 'local' ? 'secondary' : 'outline'} class="text-[10px]">{item.kind}</Badge>
											</div>
											{#if item.resolved_path}
												<p class="mt-1 text-[10px] text-muted-foreground">{item.resolved_path}</p>
											{/if}
										</div>
									{/each}
								</div>
							{:else}
								<p class="text-xs text-muted-foreground">No imports detected.</p>
							{/if}
						</div>
						<div class="space-y-2">
							<p class="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Diagnostics</p>
							{#if model?.diagnostics?.length}
								<div class="space-y-1.5">
									{#each model.diagnostics as diag}
										<div class="rounded-md border border-border/70 px-3 py-2 text-xs">
											<span class="mr-2 font-medium">{diag.severity}</span>
											{diag.message}
										</div>
									{/each}
								</div>
							{:else}
								<p class="text-xs text-muted-foreground">No diagnostics.</p>
							{/if}
						</div>
					</CardContent>
				</Card>

				<Card class="border-border/70 bg-card/90 shadow-sm backdrop-blur-sm">
					<CardHeader class="pb-3">
						<CardTitle class="text-sm">Run</CardTitle>
					</CardHeader>
					<CardContent class="space-y-4">
						<p class="text-xs text-muted-foreground">
							Run the saved function through the same internal `function-router` path used by workflows.
						</p>
						<div class="space-y-1.5">
							<label class="text-xs font-medium text-muted-foreground" for="code-function-run-input">Input JSON</label>
							<Textarea
								id="code-function-run-input"
								bind:value={runInput}
								class="min-h-[140px] font-mono text-[12px] leading-5"
								spellcheck="false"
								placeholder={`{"name":"Ada","mode":"dev"}`}
							/>
						</div>
						{#if runError}
							<div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
								{runError}
							</div>
						{/if}
						<div class="space-y-1.5">
							<label class="text-xs font-medium text-muted-foreground" for="code-function-run-result">Result</label>
							<pre id="code-function-run-result" class="max-h-64 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-3 text-[11px] leading-5"><code>{runResult || '{}'}</code></pre>
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	</div>
</div>
