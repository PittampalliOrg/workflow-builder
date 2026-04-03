<script lang="ts">
	import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { CircleAlert } from 'lucide-svelte';

	type AgentModelSpec = {
		provider: string;
		name: string;
	};

	type AgentToolRef = {
		type: 'workspace' | 'mcp' | 'action';
		ref: string;
	};

	type Agent = {
		id: string;
		name: string;
		description: string | null;
		agentType: string;
		model: AgentModelSpec;
		tools: AgentToolRef[];
		maxTurns: number;
		isEnabled: boolean;
		isDefault: boolean;
		createdAt: string;
	};

	let agents = $state<Agent[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let expandedId = $state<string | null>(null);

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function toggleExpand(id: string) {
		expandedId = expandedId === id ? null : id;
	}

	async function loadAgents() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/agents');
			if (res.ok) {
				agents = await res.json();
			} else {
				errorMessage = 'Failed to load agents';
			}
		} catch {
			errorMessage = 'Failed to load agents';
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
		<h1 class="text-sm font-semibold tracking-tight">Agents</h1>
		<span class="text-sm text-muted-foreground">{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
	</header>
	<div class="flex-1 overflow-auto p-6">
		<div class="mx-auto max-w-5xl">
			{#if errorMessage}
				<Alert variant="destructive" class="mb-4">
					<CircleAlert class="size-4" />
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			{/if}

			{#if loading}
				<div class="py-16 text-center text-sm text-muted-foreground">Loading agents...</div>
			{:else if agents.length === 0}
				<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16">
					<svg class="mb-4 h-12 w-12 text-muted-foreground/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
					</svg>
					<h3 class="mb-1 text-base font-medium">No agents found</h3>
					<p class="text-sm text-muted-foreground">
						Agents will appear here when they are configured in the database.
					</p>
				</div>
			{:else}
				<div class="grid gap-4">
					{#each agents as agent (agent.id)}
						<Card>
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="cursor-pointer" onclick={() => toggleExpand(agent.id)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpand(agent.id); }} role="button" tabindex="0">
								<CardHeader>
									<div class="flex items-start justify-between">
										<div class="min-w-0 flex-1">
											<div class="flex items-center gap-2">
												<CardTitle class="text-base">{agent.name}</CardTitle>
												{#if agent.isDefault}
													<Badge variant="default">Default</Badge>
												{/if}
												{#if !agent.isEnabled}
													<Badge variant="secondary">Disabled</Badge>
												{/if}
												<Badge variant="outline">{agent.agentType}</Badge>
											</div>
											{#if agent.description}
												<CardDescription class="mt-1">{agent.description}</CardDescription>
											{/if}
										</div>
										<svg
											class="ml-2 h-5 w-5 shrink-0 text-muted-foreground transition-transform {expandedId === agent.id ? 'rotate-180' : ''}"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
											stroke-width="2"
										>
											<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
										</svg>
									</div>
									<div class="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
										<span class="flex items-center gap-1">
											<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
												<path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
											</svg>
											{agent.model.provider}/{agent.model.name}
										</span>
										<span class="flex items-center gap-1">
											<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
												<path stroke-linecap="round" stroke-linejoin="round" d="M11.42 15.17l-5.384-3.116A2 2 0 004 14v5a2 2 0 001.036 1.752l6 3.5a2 2 0 002.024-.088L19 20.5a2 2 0 001-1.732V14a2 2 0 00-2.036-1.754L11.42 15.17z" />
											</svg>
											{agent.tools.length} tool{agent.tools.length !== 1 ? 's' : ''}
										</span>
										<span>Created {formatDate(agent.createdAt)}</span>
									</div>
								</CardHeader>
							</div>

							{#if expandedId === agent.id}
								<CardContent>
									<div class="space-y-4">
										<!-- Model Details -->
										<div>
											<h4 class="mb-2 text-sm font-medium">Model</h4>
											<div class="rounded-md border border-border">
												<div class="flex items-center justify-between px-3 py-2">
													<span class="text-sm text-muted-foreground">Provider</span>
													<code class="rounded bg-muted px-2 py-0.5 text-xs">{agent.model.provider}</code>
												</div>
												<div class="flex items-center justify-between border-t border-border px-3 py-2">
													<span class="text-sm text-muted-foreground">Model</span>
													<code class="rounded bg-muted px-2 py-0.5 text-xs">{agent.model.name}</code>
												</div>
												<div class="flex items-center justify-between border-t border-border px-3 py-2">
													<span class="text-sm text-muted-foreground">Max Turns</span>
													<span class="text-sm">{agent.maxTurns}</span>
												</div>
											</div>
										</div>

										<!-- Tools -->
										{#if agent.tools.length > 0}
											<div>
												<h4 class="mb-2 text-sm font-medium">Tools ({agent.tools.length})</h4>
												<div class="flex flex-wrap gap-2">
													{#each agent.tools as tool}
														<Badge variant="outline">
															<span class="text-xs">{tool.type}: {tool.ref}</span>
														</Badge>
													{/each}
												</div>
											</div>
										{:else}
											<div>
												<h4 class="mb-2 text-sm font-medium">Tools</h4>
												<p class="text-sm text-muted-foreground">No tools configured.</p>
											</div>
										{/if}
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
