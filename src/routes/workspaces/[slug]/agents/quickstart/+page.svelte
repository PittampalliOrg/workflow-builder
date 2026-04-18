<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import {
		Check,
		Code,
		Copy,
		FileCode,
		Play,
		Search,
		Send,
		Sparkles,
		Wand2
	} from 'lucide-svelte';
	import { page } from '$app/state';

	const slug = $derived((page.params.slug as string) ?? 'default');

	type TemplateSummary = {
		slug: string;
		name: string;
		description: string;
		providerIcons: string[];
		highlights: string[];
		mcpServerCount: number;
		model: string | null;
		systemPrompt?: string;
		tools?: string[];
		skills?: string[];
	};
	type PreviewTab = 'yaml' | 'json';

	const steps = [
		{ slug: 'agent', label: 'Create agent', description: 'POST /v1/agents' },
		{ slug: 'environment', label: 'Configure environment', description: 'Sandbox + networking' },
		{ slug: 'session', label: 'Start session', description: 'POST /v1/sessions' },
		{ slug: 'integrate', label: 'Integrate', description: 'Wire into your app' }
	];

	let activeStep = $state<'agent' | 'environment' | 'session' | 'integrate'>('agent');
	let templates = $state<TemplateSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');
	let selected = $state<TemplateSummary | null>(null);
	let agentName = $state('');
	let describePrompt = $state('');
	let creating = $state(false);
	let previewTab = $state<PreviewTab>('yaml');
	let previewCopied = $state(false);

	function templateYaml(t: TemplateSummary): string {
		const tools = t.tools?.length ? t.tools : ['agent_toolset_20260401'];
		const skills = t.skills?.length ? t.skills : [];
		const mcp = t.mcpServerCount > 0 ? `<${t.mcpServerCount} MCP server(s)>` : '';
		return [
			`name: ${agentName.trim() || t.name}`,
			`description: ${t.description}`,
			`model: ${t.model ?? 'claude-sonnet-4-6'}`,
			`system: |`,
			...(t.systemPrompt ?? 'You are a general-purpose agent that can research, write code, run commands, and use connected tools to complete the user\'s task end to end.')
				.split('\n')
				.map((l) => `  ${l}`),
			`mcp_servers: ${mcp ? `[${mcp}]` : '[]'}`,
			`tools:`,
			...tools.map((tt) => `  - type: ${tt}`),
			`skills: ${skills.length ? `[${skills.map((s) => `"${s}"`).join(', ')}]` : '[]'}`
		].join('\n');
	}

	function templateJson(t: TemplateSummary): string {
		return JSON.stringify(
			{
				name: agentName.trim() || t.name,
				description: t.description,
				model: t.model ?? 'claude-sonnet-4-6',
				system:
					t.systemPrompt ??
					"You are a general-purpose agent that can research, write code, run commands, and use connected tools to complete the user's task end to end.",
				mcp_servers: t.mcpServerCount > 0 ? [`<${t.mcpServerCount} MCP server(s)>`] : [],
				tools: (t.tools?.length ? t.tools : ['agent_toolset_20260401']).map((type) => ({
					type
				})),
				skills: t.skills ?? []
			},
			null,
			2
		);
	}

	async function copyPreview() {
		if (!selected) return;
		const text = previewTab === 'yaml' ? templateYaml(selected) : templateJson(selected);
		try {
			await navigator.clipboard.writeText(text);
			previewCopied = true;
			setTimeout(() => (previewCopied = false), 1400);
		} catch {
			/* clipboard blocked */
		}
	}

	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return templates;
		return templates.filter((t) =>
			`${t.name} ${t.description}`.toLowerCase().includes(q)
		);
	});

	async function load() {
		loading = true;
		try {
			const res = await fetch('/api/v1/agents/templates');
			if (!res.ok) {
				errorMessage = `Failed to load templates (${res.status})`;
				return;
			}
			const data = (await res.json()) as { templates: TemplateSummary[] };
			templates = data.templates ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function createFromTemplate(template: TemplateSummary) {
		creating = true;
		errorMessage = null;
		try {
			const name = agentName.trim() || template.name;
			const res = await fetch(
				`/api/agents?fromTemplate=${encodeURIComponent(template.slug)}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name })
				}
			);
			if (!res.ok) {
				errorMessage = `Create failed (${res.status})`;
				return;
			}
			const { agent } = await res.json();
			goto(`/workspaces/${slug}/agents/${agent.id}`);
		} finally {
			creating = false;
		}
	}

	async function createBlank() {
		creating = true;
		errorMessage = null;
		try {
			const name = agentName.trim() || 'Untitled Agent';
			const res = await fetch('/api/agents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!res.ok) {
				errorMessage = `Create failed (${res.status})`;
				return;
			}
			const { agent } = await res.json();
			goto(`/workspaces/${slug}/agents/${agent.id}`);
		} finally {
			creating = false;
		}
	}

	function iconLabel(slug: string): string {
		const map: Record<string, string> = {
			notion: '📝',
			slack: '💬',
			sentry: '🐛',
			linear: '◣',
			github: '🐙',
			asana: '🎯',
			intercom: '💭',
			atlassian: '🧭',
			amplitude: '📊'
		};
		return map[slug] ?? '🔌';
	}

	onMount(load);
</script>

<div class="flex flex-col min-h-screen">
	<div class="border-b bg-muted/30 px-6 py-2 flex items-center gap-1 text-xs text-muted-foreground">
		<a href="/workspaces/{slug}/agents" class="hover:text-foreground">Agents</a>
		<span class="text-muted-foreground/60">/</span>
		<span class="text-foreground">Quickstart</span>
	</div>
	<header class="border-b px-6 py-4">
		<h1 class="text-2xl font-semibold">Agent Quickstart</h1>
		<p class="text-sm text-muted-foreground mt-1">
			Create your first Managed Agent. Pick a template or describe what you want to build.
		</p>
	</header>

	<div class="flex-1 grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6 p-6 max-w-7xl mx-auto w-full">
		<!-- Stepper -->
		<aside class="space-y-1">
			{#each steps as step, i}
				{@const isActive = activeStep === step.slug}
				{@const isComplete = steps.findIndex((s) => s.slug === activeStep) > i}
				<button
					type="button"
					class="w-full text-left rounded-md p-3 flex items-start gap-3 transition-colors {isActive
						? 'bg-accent'
						: isComplete
							? 'hover:bg-muted/50'
							: 'opacity-60'}"
					onclick={() => (activeStep = step.slug as typeof activeStep)}
				>
					<div
						class="size-6 rounded-full flex items-center justify-center text-xs shrink-0 {isComplete
							? 'bg-primary text-primary-foreground'
							: isActive
								? 'border-2 border-primary bg-background text-primary'
								: 'border bg-muted text-muted-foreground'}"
					>
						{#if isComplete}
							<Check class="size-3" />
						{:else}
							{i + 1}
						{/if}
					</div>
					<div class="min-w-0">
						<div class="text-sm font-medium">{step.label}</div>
						<div class="text-[11px] text-muted-foreground font-mono">
							{step.description}
						</div>
					</div>
				</button>
			{/each}
		</aside>

		<!-- Main content -->
		<main class="space-y-6 min-w-0">
			{#if errorMessage}
				<Alert variant="destructive">
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			{/if}

			{#if activeStep === 'agent'}
				<!-- Describe + templates -->
				<section class="space-y-6">
					<div>
						<h2 class="text-xl font-semibold">What do you want to build?</h2>
						<p class="text-sm text-muted-foreground mt-1">
							Describe your agent, or start with a template.
						</p>
					</div>

					<Card>
						<CardContent class="p-4">
							<form
								class="flex items-center gap-2"
								onsubmit={(e) => {
									e.preventDefault();
									// AI-describe hook — stub for now; wire to /api/ai-assistant in a future pass
									if (describePrompt.trim()) {
										agentName = describePrompt.slice(0, 40);
										activeStep = 'environment';
									}
								}}
							>
								<Wand2 class="size-4 text-muted-foreground shrink-0" />
								<Textarea
									rows={2}
									placeholder="e.g. an agent that reads our GitHub issues and drafts Linear tickets…"
									bind:value={describePrompt}
									class="flex-1 border-0 shadow-none focus-visible:ring-0 resize-none"
								/>
								<Button type="submit" disabled={!describePrompt.trim()}>
									<Send class="size-4" /> Send
								</Button>
							</form>
						</CardContent>
					</Card>

					<div class="flex items-center gap-4">
						<div class="h-px flex-1 bg-border"></div>
						<span class="text-xs text-muted-foreground uppercase tracking-wide">
							or browse templates
						</span>
						<div class="h-px flex-1 bg-border"></div>
					</div>

					<div class="flex items-center gap-3">
						<div class="relative flex-1">
							<Search class="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
							<Input
								placeholder="Search templates"
								class="pl-9"
								bind:value={search}
							/>
						</div>
						<div class="flex-1">
							<Input
								placeholder="Agent name (optional)"
								bind:value={agentName}
							/>
						</div>
					</div>

					{#if loading}
						<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
							{#each Array(6) as _, i (i)}
								<Skeleton class="h-36" />
							{/each}
						</div>
					{:else}
						<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
							{#each filtered as template (template.slug)}
								<Card
									class="cursor-pointer hover:border-primary transition-colors {selected?.slug ===
									template.slug
										? 'border-primary ring-1 ring-primary'
										: ''}"
								>
									<button
										type="button"
										class="text-left w-full h-full"
										onclick={() => (selected = template)}
										ondblclick={() => createFromTemplate(template)}
									>
										<CardHeader class="pb-2">
											<div class="flex items-start justify-between gap-2">
												<CardTitle class="text-sm">{template.name}</CardTitle>
												<div class="flex gap-0.5">
													{#each template.providerIcons as provider}
														<span
															class="size-5 rounded bg-muted flex items-center justify-center text-[10px]"
															title={provider}
														>
															{iconLabel(provider)}
														</span>
													{/each}
												</div>
											</div>
											<CardDescription class="text-xs line-clamp-2">
												{template.description}
											</CardDescription>
										</CardHeader>
										<CardContent class="pt-0 flex items-center gap-2 text-[10px] text-muted-foreground">
											{#if template.mcpServerCount > 0}
												<Badge variant="outline" class="text-[10px]">
													{template.mcpServerCount} MCP
												</Badge>
											{/if}
											{#if template.model}
												<span class="font-mono truncate">{template.model}</span>
											{/if}
										</CardContent>
									</button>
								</Card>
							{/each}
						</div>
					{/if}

					{#if selected}
						<Card class="border-primary">
							<CardHeader>
								<div class="flex items-start justify-between gap-3">
									<div class="min-w-0 flex-1">
										<CardTitle class="text-base flex items-center gap-2">
											{selected.name}
											<Badge variant="outline" class="text-[10px]">Template</Badge>
										</CardTitle>
										<CardDescription>{selected.description}</CardDescription>
									</div>
									<Button
										onclick={() => createFromTemplate(selected!)}
										disabled={creating}
									>
										{creating ? 'Creating…' : 'Use this template'}
									</Button>
								</div>
							</CardHeader>
							<CardContent class="space-y-4">
								<div>
									<div class="text-[11px] font-medium text-muted-foreground uppercase mb-1">
										What you get
									</div>
									<ul class="text-sm space-y-1">
										{#each selected.highlights as h}
											<li class="flex items-start gap-2">
												<span class="text-primary">•</span>
												<span>{h}</span>
											</li>
										{/each}
									</ul>
								</div>

								<div>
									<div class="flex items-center justify-between mb-1.5">
										<div class="inline-flex rounded-md border bg-muted/30 p-0.5">
											<button
												type="button"
												class="px-2.5 py-0.5 text-[11px] rounded {previewTab === 'yaml' ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
												onclick={() => (previewTab = 'yaml')}
											>
												YAML
											</button>
											<button
												type="button"
												class="px-2.5 py-0.5 text-[11px] rounded {previewTab === 'json' ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
												onclick={() => (previewTab = 'json')}
											>
												JSON
											</button>
										</div>
										<Button
											variant="ghost"
											size="sm"
											class="h-6 text-[11px] gap-1"
											onclick={copyPreview}
										>
											{#if previewCopied}
												<Check class="size-3" /> Copied
											{:else}
												<Copy class="size-3" /> Copy
											{/if}
										</Button>
									</div>
									<pre class="bg-muted rounded p-3 text-[11px] overflow-x-auto font-mono max-h-[320px]"><code>{previewTab === 'yaml' ? templateYaml(selected) : templateJson(selected)}</code></pre>
								</div>

								<div class="flex gap-2 pt-1">
									<Button
										variant="outline"
										onclick={createBlank}
										disabled={creating}
									>
										Start blank instead
									</Button>
								</div>
							</CardContent>
						</Card>
					{/if}
				</section>
			{:else if activeStep === 'environment'}
				<Card>
					<CardHeader>
						<CardTitle class="text-base flex items-center gap-2">
							<FileCode class="size-4" /> Configure environment
						</CardTitle>
						<CardDescription>
							Pick the sandbox template + networking policy your agent's tools run inside.
						</CardDescription>
					</CardHeader>
					<CardContent class="space-y-3">
						<p class="text-sm text-muted-foreground">
							Environments are reusable across agents. If you have one already, the agent editor
							lets you attach it. Otherwise:
						</p>
						<div class="flex gap-2">
							<Button variant="outline" onclick={() => goto(`/workspaces/${slug}/environments`)}>
								Browse environments
							</Button>
							<Button onclick={() => goto(`/workspaces/${slug}/environments/new`)}>
								Create environment
							</Button>
						</div>
					</CardContent>
				</Card>
			{:else if activeStep === 'session'}
				<Card>
					<CardHeader>
						<CardTitle class="text-base flex items-center gap-2">
							<Play class="size-4" /> Start a session
						</CardTitle>
						<CardDescription>
							Sessions are one run of an agent — multi-turn, streamed events, archivable.
						</CardDescription>
					</CardHeader>
					<CardContent class="space-y-3">
						<p class="text-sm text-muted-foreground">
							Once your agent + environment are ready, start your first session.
						</p>
						<div class="flex gap-2">
							<Button onclick={() => goto(`/workspaces/${slug}/sessions/new`)}>
								<Play class="size-4" /> New session
							</Button>
						</div>
					</CardContent>
				</Card>
			{:else if activeStep === 'integrate'}
				<Card>
					<CardHeader>
						<CardTitle class="text-base flex items-center gap-2">
							<Code class="size-4" /> Integrate into your app
						</CardTitle>
						<CardDescription>
							Wire the session API into your app. Minimal cURL:
						</CardDescription>
					</CardHeader>
					<CardContent>
						<pre class="bg-muted rounded p-3 text-[11px] overflow-x-auto whitespace-pre-wrap font-mono">{`# 1. Create a session
curl -X POST $BASE/api/v1/sessions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $API_KEY" \\
  -d '{"agentId":"agent_abc","initialMessage":"Start the job"}'

# 2. Stream events
curl -N $BASE/api/v1/sessions/$SESSION_ID/events/stream \\
  -H "Authorization: Bearer $API_KEY"

# 3. Send follow-up messages
curl -X POST $BASE/api/v1/sessions/$SESSION_ID/events \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $API_KEY" \\
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"…"}]}]}'`}</pre>
					</CardContent>
				</Card>
			{/if}

			<!-- Stepper nav -->
			<div class="flex justify-between pt-4 border-t">
				<Button
					variant="ghost"
					disabled={activeStep === 'agent'}
					onclick={() => {
						const idx = steps.findIndex((s) => s.slug === activeStep);
						if (idx > 0) activeStep = steps[idx - 1].slug as typeof activeStep;
					}}
				>
					← Back
				</Button>
				<Button
					variant="ghost"
					disabled={activeStep === 'integrate'}
					onclick={() => {
						const idx = steps.findIndex((s) => s.slug === activeStep);
						if (idx < steps.length - 1) activeStep = steps[idx + 1].slug as typeof activeStep;
					}}
				>
					Next →
				</Button>
			</div>
		</main>
	</div>
</div>
