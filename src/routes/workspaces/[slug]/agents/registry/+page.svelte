<script lang="ts">
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
	import JsonViewer from '$lib/components/workflow/execution/json-viewer.svelte';
	import { CircleAlert } from 'lucide-svelte';
	import { page } from '$app/state';

	const slug = $derived((page.params.slug as string) ?? 'default');

	type JsonRecord = Record<string, unknown>;

	type RegistryAgent = {
		id: string;
		name: string;
		team: string;
		registryStore: string;
		registryKey: string;
		schemaVersion: string | null;
		registeredAt: string | null;
		appId: string | null;
		type: string | null;
		framework: string | null;
		role: string | null;
		goal: string | null;
		instructions: string[];
		systemPrompt: string | null;
		maxIterations: number | null;
		toolChoice: string | null;
		orchestrator: boolean;
		pubsub: JsonRecord | null;
		memory: JsonRecord | null;
		llm: JsonRecord | null;
		tools: JsonRecord[];
		metadata: JsonRecord | null;
		raw: JsonRecord;
	};

	type AgentsResponse = {
		source: string;
		storeName: string;
		teams: string[];
		agents: RegistryAgent[];
		diagnostics: string[];
	};

	const emptyResponse: AgentsResponse = {
		source: 'dapr-agent-registry',
		storeName: 'agent-registry',
		teams: ['default'],
		agents: [],
		diagnostics: []
	};

	let response = $state<AgentsResponse>(emptyResponse);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let expandedId = $state<string | null>(null);

	let agents = $derived(response.agents);

	function formatDate(dateStr: string | null): string {
		if (!dateStr) return 'Unknown';
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return dateStr;

		return date.toLocaleString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function stringify(value: unknown): string {
		if (value === null || value === undefined) return 'None';
		if (typeof value === 'string') return value;
		return JSON.stringify(value, null, 2);
	}

	function recordValue(record: JsonRecord | null, key: string): string {
		if (!record || record[key] === undefined || record[key] === null) return 'None';
		return stringify(record[key]);
	}

	function toolName(tool: JsonRecord): string {
		return typeof tool.name === 'string' ? tool.name : 'Unnamed tool';
	}

	function toolDescription(tool: JsonRecord): string | null {
		return typeof tool.description === 'string' && tool.description.trim() ? tool.description : null;
	}

	function toggleExpand(id: string) {
		expandedId = expandedId === id ? null : id;
	}

	async function loadAgents() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/agents/registry');
			if (!res.ok) {
				errorMessage = `Failed to load Dapr agents (${res.status})`;
				return;
			}

			response = await res.json();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load Dapr agents';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		loadAgents();
	});
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div>
			<h1 class="text-sm font-semibold tracking-tight">Agents</h1>
			<p class="text-xs text-muted-foreground">
				{response.storeName} / {response.teams.join(', ')}
			</p>
		</div>
		<span class="text-sm text-muted-foreground">{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
	</header>

	<div class="flex-1 overflow-auto p-6">
		<div class="mx-auto max-w-6xl space-y-4">
			{#if errorMessage}
				<Alert variant="destructive">
					<CircleAlert class="size-4" />
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			{/if}

			{#if response.diagnostics.length > 0}
				<Alert>
					<CircleAlert class="size-4" />
					<AlertDescription>
						<div class="space-y-1">
							{#each response.diagnostics as diagnostic}
								<p>{diagnostic}</p>
							{/each}
						</div>
					</AlertDescription>
				</Alert>
			{/if}

			{#if loading}
				<div class="py-16 text-center text-sm text-muted-foreground">Loading Dapr agents...</div>
			{:else if agents.length === 0}
				<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-4 py-16 text-center">
					<h3 class="mb-1 text-base font-medium">No registered Dapr agents found</h3>
					<p class="max-w-xl text-sm text-muted-foreground">
						No entries were found in {response.storeName} for {response.teams.join(', ')}.
					</p>
				</div>
			{:else}
				<div class="grid gap-4">
					{#each agents as agent (agent.id)}
						<Card>
							<CardHeader>
								<button
									type="button"
									class="flex w-full items-start justify-between gap-4 text-left"
									onclick={() => toggleExpand(agent.id)}
								>
									<div class="min-w-0 flex-1 space-y-2">
										<div class="flex flex-wrap items-center gap-2">
											<CardTitle class="break-words text-base">{agent.name}</CardTitle>
											<Badge variant="outline">{agent.team}</Badge>
											{#if agent.type}
												<Badge variant="secondary">{agent.type}</Badge>
											{/if}
											{#if agent.orchestrator}
												<Badge>Orchestrator</Badge>
											{/if}
										</div>
										<CardDescription class="break-words">
											{agent.role ?? 'No role'}{agent.goal ? ` - ${agent.goal}` : ''}
										</CardDescription>
										<div class="flex flex-wrap gap-3 text-xs text-muted-foreground">
											<span>App ID: {agent.appId ?? 'Unknown'}</span>
											<span>Framework: {agent.framework ?? 'Unknown'}</span>
											<span>Registered: {formatDate(agent.registeredAt)}</span>
										</div>
									</div>
									<svg
										class="mt-1 h-5 w-5 shrink-0 text-muted-foreground transition-transform {expandedId === agent.id ? 'rotate-180' : ''}"
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
										stroke-width="2"
									>
										<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
									</svg>
								</button>
							</CardHeader>

							{#if expandedId === agent.id}
								<CardContent>
									<div class="grid gap-5">
										<section>
											<h2 class="mb-2 text-sm font-medium">Registry</h2>
											<div class="grid gap-2 rounded-md border border-border p-3 text-sm md:grid-cols-2">
												<div>
													<p class="text-xs text-muted-foreground">Store</p>
													<code class="break-all text-xs">{agent.registryStore}</code>
												</div>
												<div>
													<p class="text-xs text-muted-foreground">Key</p>
													<code class="break-all text-xs">{agent.registryKey}</code>
												</div>
												<div>
													<p class="text-xs text-muted-foreground">Schema</p>
													<span>{agent.schemaVersion ?? 'Unknown'}</span>
												</div>
												<div>
													<p class="text-xs text-muted-foreground">Max iterations</p>
													<span>{agent.maxIterations ?? 'None'}</span>
												</div>
											</div>
										</section>

										<section>
											<h2 class="mb-2 text-sm font-medium">Instructions</h2>
											{#if agent.instructions.length > 0}
												<ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
													{#each agent.instructions as instruction}
														<li>{instruction}</li>
													{/each}
												</ul>
											{:else}
												<p class="text-sm text-muted-foreground">None</p>
											{/if}
										</section>

										{#if agent.systemPrompt}
											<section>
												<h2 class="mb-2 text-sm font-medium">System Prompt</h2>
												<pre class="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{agent.systemPrompt}</pre>
											</section>
										{/if}

										<section class="grid gap-4 md:grid-cols-3">
											<div>
												<h2 class="mb-2 text-sm font-medium">Pub/Sub</h2>
												<div class="space-y-2 rounded-md border border-border p-3 text-sm">
													<p><span class="text-muted-foreground">Resource:</span> {recordValue(agent.pubsub, 'resource_name')}</p>
													<p><span class="text-muted-foreground">Agent topic:</span> {recordValue(agent.pubsub, 'agent_topic')}</p>
													<p><span class="text-muted-foreground">Broadcast:</span> {recordValue(agent.pubsub, 'broadcast_topic')}</p>
												</div>
											</div>
											<div>
												<h2 class="mb-2 text-sm font-medium">Memory</h2>
												<JsonViewer data={agent.memory} label="Memory" collapsed={false} />
											</div>
											<div>
												<h2 class="mb-2 text-sm font-medium">LLM</h2>
												<JsonViewer data={agent.llm} label="LLM" collapsed={false} />
											</div>
										</section>

										<section>
											<h2 class="mb-2 text-sm font-medium">Tools ({agent.tools.length})</h2>
											{#if agent.tools.length > 0}
												<div class="grid gap-2 md:grid-cols-2">
													{#each agent.tools as tool}
														<div class="rounded-md border border-border p-3">
															<p class="text-sm font-medium">{toolName(tool)}</p>
															{#if toolDescription(tool)}
																<p class="mt-1 text-sm text-muted-foreground">{toolDescription(tool)}</p>
															{/if}
															{#if tool.args}
																<div class="mt-2">
																	<JsonViewer data={tool.args} label="Args" collapsed={false} />
																</div>
															{/if}
														</div>
													{/each}
												</div>
											{:else}
												<p class="text-sm text-muted-foreground">None</p>
											{/if}
										</section>

										{#if agent.metadata}
											<section>
												<h2 class="mb-2 text-sm font-medium">Metadata</h2>
												<JsonViewer data={agent.metadata} label="Metadata" collapsed={false} />
											</section>
										{/if}

										<section>
											<h2 class="mb-2 text-sm font-medium">Raw Registry Record</h2>
											<JsonViewer data={agent.raw} label="Raw Registry Record" collapsed={false} />
										</section>
									</div>
								</CardContent>
							{/if}
						</Card>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
