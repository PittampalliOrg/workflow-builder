<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Table, TableHeader, TableBody, TableRow, TableHead, TableCell
	} from '$lib/components/ui/table';
	import { Separator } from '$lib/components/ui/separator';
	import { Input } from '$lib/components/ui/input';
	import { Loader2, RefreshCw, Server, Boxes, CircleDot, CheckCircle2, XCircle, ChevronDown, ChevronRight, Code, Search, X } from 'lucide-svelte';

	interface NormalizedActivity {
		name: string;
		service: string;
		source: string;
		sourceCode?: string | null;
		sourceHtml?: string | null;
		doc?: string | null;
	}

	interface NormalizedWorkflow {
		name: string;
		version: string | null;
		aliases: string[];
		isLatest: boolean;
		service: string;
		source: string;
	}

	interface ServiceIntrospection {
		service: string;
		version: string;
		runtime: string;
		ready: boolean;
		features: string[];
		registeredWorkflows: NormalizedWorkflow[];
		registeredActivities: NormalizedActivity[];
		additional: Record<string, unknown>;
	}

	interface IntrospectResponse {
		timestamp: string;
		services: ServiceIntrospection[];
		allActivities: NormalizedActivity[];
		allWorkflows: NormalizedWorkflow[];
		partialErrors: { serviceId: string; error: string }[];
	}

	let { data } = $props();

	let introspection = $derived(data.introspection as IntrospectResponse | null);
	let loadError = $derived(data.error as string | null);
	let refreshing = $state(false);
	let expandedServices: Set<string> = $state(new Set());
	let expandedCode: Set<string> = $state(new Set());
	let search = $state('');

	function matchesSearch(act: NormalizedActivity): boolean {
		if (!search) return true;
		const q = search.toLowerCase();
		return act.name.toLowerCase().includes(q)
			|| (act.doc?.toLowerCase().includes(q) ?? false)
			|| act.service.toLowerCase().includes(q);
	}

	function filteredActivities(activities: NormalizedActivity[]): NormalizedActivity[] {
		if (!search) return activities;
		return activities.filter(matchesSearch);
	}

	// Auto-expand all services when data first arrives
	$effect(() => {
		if (introspection && expandedServices.size === 0) {
			expandedServices = new Set(introspection.services.map((s) => s.service));
		}
	});

	async function refresh() {
		refreshing = true;
		try {
			await fetch('/api/runtime/introspect?refresh=true');
			await invalidate('app:runtime-introspect');
		} finally {
			refreshing = false;
		}
	}

	function toggleService(serviceId: string) {
		const next = new Set(expandedServices);
		if (next.has(serviceId)) {
			next.delete(serviceId);
		} else {
			next.add(serviceId);
		}
		expandedServices = next;
	}

	function toggleCode(key: string) {
		const next = new Set(expandedCode);
		if (next.has(key)) {
			next.delete(key);
		} else {
			next.add(key);
		}
		expandedCode = next;
	}

	function formatTimestamp(ts: string): string {
		return new Date(ts).toLocaleString('en-US', {
			month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
		});
	}

	function lineCount(code: string): number {
		return code.split('\n').length;
	}
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div class="flex items-center gap-3">
			<h1 class="text-sm font-semibold tracking-tight">Runtime</h1>
			{#if introspection}
				<span class="text-[10px] text-muted-foreground">
					{introspection.allActivities.length} activities &middot; {introspection.allWorkflows.length} workflows &middot; {introspection.services.length} services
				</span>
			{/if}
		</div>
		<Button variant="outline" size="sm" onclick={refresh} disabled={refreshing} title="Bypass cache and fetch live data">
			{#if refreshing}
				<Loader2 size={14} class="animate-spin" />
			{:else}
				<RefreshCw size={14} />
			{/if}
			Refresh
		</Button>
	</header>

	<div class="flex-1 overflow-auto p-6">
		{#if loadError && !introspection}
			<div class="flex flex-col items-center justify-center py-16 text-center">
				<div class="rounded-full bg-destructive/10 p-4 mb-4">
					<XCircle size={24} class="text-destructive" />
				</div>
				<h2 class="text-sm font-medium">Failed to load runtime data</h2>
				<p class="mt-1 text-xs text-muted-foreground max-w-sm">{loadError}</p>
				<Button class="mt-4" size="sm" onclick={refresh}>
					<RefreshCw size={14} />
					Retry
				</Button>
			</div>
		{:else if introspection}
			<div class="space-y-6">
				<!-- Partial errors banner -->
				{#if introspection.partialErrors.length > 0}
					<div class="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
						<p class="text-xs font-medium text-destructive">
							{introspection.partialErrors.length} service{introspection.partialErrors.length > 1 ? 's' : ''} unreachable
						</p>
						{#each introspection.partialErrors as err}
							<p class="mt-1 text-[10px] text-muted-foreground">
								<span class="font-mono">{err.serviceId}</span> &mdash; {err.error}
							</p>
						{/each}
					</div>
				{/if}

				<!-- Timestamp -->
				<p class="text-[10px] text-muted-foreground">
					Last fetched: {formatTimestamp(introspection.timestamp)}
				</p>

				<!-- Per-service cards -->
				{#each introspection.services as svc (svc.service)}
					<div class="rounded-lg border border-border">
						<!-- Service header -->
						<button
							class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/30 transition-colors rounded-t-lg"
							onclick={() => toggleService(svc.service)}
						>
							{#if expandedServices.has(svc.service)}
								<ChevronDown size={14} class="text-muted-foreground shrink-0" />
							{:else}
								<ChevronRight size={14} class="text-muted-foreground shrink-0" />
							{/if}
							<Server size={14} class="shrink-0 text-muted-foreground" />
							<span class="text-xs font-semibold">{svc.service}</span>
							<Badge variant={svc.ready ? 'default' : 'destructive'} class="text-[9px]">
								{svc.ready ? 'Ready' : 'Not Ready'}
							</Badge>
							<span class="text-[10px] text-muted-foreground">v{svc.version}</span>
							<span class="text-[10px] text-muted-foreground">&middot; {svc.runtime}</span>
							<span class="ml-auto text-[10px] text-muted-foreground">
								{svc.registeredActivities.length} activities &middot; {svc.registeredWorkflows.length} workflows
							</span>
						</button>

						{#if expandedServices.has(svc.service)}
							<Separator />
							<div class="p-4 space-y-4">
								<!-- Features -->
								{#if svc.features.length > 0}
									<div>
										<h3 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Features</h3>
										<div class="flex flex-wrap gap-1.5">
											{#each svc.features as feature}
												<Badge variant="secondary" class="text-[9px]">{feature}</Badge>
											{/each}
										</div>
									</div>
								{/if}

								<!-- Registered Workflows -->
								{#if svc.registeredWorkflows.length > 0}
									<div>
										<h3 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
											Workflows ({svc.registeredWorkflows.length})
										</h3>
										<Table>
											<TableHeader>
												<TableRow>
													<TableHead>Name</TableHead>
													<TableHead>Version</TableHead>
													<TableHead>Aliases</TableHead>
													<TableHead>Latest</TableHead>
												</TableRow>
											</TableHeader>
											<TableBody>
												{#each svc.registeredWorkflows as wf, i (svc.service + '/' + wf.name + '/' + (wf.version || i))}
													<TableRow>
														<TableCell class="font-mono text-xs">{wf.name}</TableCell>
														<TableCell class="text-xs text-muted-foreground">{wf.version || '—'}</TableCell>
														<TableCell>
															{#if wf.aliases.length > 0}
																<div class="flex flex-wrap gap-1">
																	{#each wf.aliases as alias}
																		<Badge variant="outline" class="text-[9px]">{alias}</Badge>
																	{/each}
																</div>
															{:else}
																<span class="text-xs text-muted-foreground">—</span>
															{/if}
														</TableCell>
														<TableCell>
															{#if wf.isLatest}
																<CheckCircle2 size={12} class="text-green-500" />
															{/if}
														</TableCell>
													</TableRow>
												{/each}
											</TableBody>
										</Table>
									</div>
								{/if}

								<!-- Registered Activities -->
								{#if svc.registeredActivities.length > 0}
									{@const filtered = filteredActivities(svc.registeredActivities)}
									<div>
										<div class="flex items-center justify-between mb-2">
											<h3 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
												Activities ({filtered.length}{search ? ` / ${svc.registeredActivities.length}` : ''})
											</h3>
											<div class="relative w-52">
												<Search size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
												<Input
													placeholder="Filter activities..."
													bind:value={search}
													class="h-7 pl-7 pr-7 text-xs"
												/>
												{#if search}
													<button
														class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
														onclick={() => { search = ''; }}
													>
														<X size={12} />
													</button>
												{/if}
											</div>
										</div>
										{#if filtered.length === 0}
											<p class="text-[10px] text-muted-foreground py-2">No activities matching "{search}"</p>
										{/if}
										<div class="space-y-1">
											{#each filtered as act, i (svc.service + '/' + act.name + '/' + i)}
												{@const codeKey = svc.service + '/' + act.name}
												<div class="rounded-md border border-border/50">
													<button
														class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/20 transition-colors"
														onclick={() => { if (act.sourceCode) toggleCode(codeKey); }}
													>
														{#if act.sourceCode}
															{#if expandedCode.has(codeKey)}
																<ChevronDown size={10} class="text-muted-foreground shrink-0" />
															{:else}
																<ChevronRight size={10} class="text-muted-foreground shrink-0" />
															{/if}
														{:else}
															<CircleDot size={10} class="shrink-0 text-muted-foreground" />
														{/if}
														<span class="font-mono text-[11px]">{act.name}</span>
														{#if act.doc}
															<span class="text-[10px] text-muted-foreground truncate">&mdash; {act.doc.split('\n')[0]}</span>
														{/if}
														{#if act.sourceCode}
															<span class="ml-auto flex items-center gap-1 text-[9px] text-muted-foreground">
																<Code size={9} />
																{lineCount(act.sourceCode)} lines
															</span>
														{/if}
													</button>
													{#if act.sourceCode && expandedCode.has(codeKey)}
														<div class="border-t border-border/50 source-highlight">
															{#if act.sourceHtml}
																{@html act.sourceHtml}
															{:else}
																<pre class="overflow-x-auto p-3 text-[10px] leading-relaxed"><code>{act.sourceCode}</code></pre>
															{/if}
														</div>
													{/if}
												</div>
											{/each}
										</div>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}

				<!-- All Activities summary table -->
				{#if introspection.allActivities.length > 0}
					{@const filteredAll = filteredActivities(introspection.allActivities)}
					<div>
						<h2 class="text-xs font-semibold mb-3 flex items-center gap-2">
							<Boxes size={14} />
							All Registered Activities ({filteredAll.length}{search ? ` / ${introspection.allActivities.length}` : ''})
						</h2>
						{#if filteredAll.length === 0}
							<p class="text-xs text-muted-foreground py-4">No activities matching "{search}"</p>
						{:else}
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Activity</TableHead>
									<TableHead>Service</TableHead>
									<TableHead>Source</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{#each filteredAll as act, i (act.service + '/' + act.name + '/' + i)}
									<TableRow>
										<TableCell>
											<span class="font-mono text-xs">{act.name}</span>
											{#if act.doc}
												<p class="text-[10px] text-muted-foreground mt-0.5">{act.doc.split('\n')[0]}</p>
											{/if}
										</TableCell>
										<TableCell>
											<Badge variant="outline" class="text-[9px]">{act.service}</Badge>
										</TableCell>
										<TableCell>
											{#if act.sourceCode}
												<Badge variant="secondary" class="text-[9px]">
													<Code size={9} class="mr-1" />
													{lineCount(act.sourceCode)} lines
												</Badge>
											{:else}
												<span class="text-[10px] text-muted-foreground">—</span>
											{/if}
										</TableCell>
									</TableRow>
								{/each}
							</TableBody>
						</Table>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	:global(.source-highlight pre) {
		margin: 0;
		padding: 0.75rem;
		font-size: 10px;
		line-height: 1.6;
		overflow-x: auto;
		border-radius: 0;
	}
	:global(.source-highlight code) {
		font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
	}
</style>
