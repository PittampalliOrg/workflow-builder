<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Separator } from '$lib/components/ui/separator';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import * as Select from '$lib/components/ui/select';
	import * as Avatar from '$lib/components/ui/avatar';
	import {
		Table,
		TableBody,
		TableCell,
		TableHead,
		TableHeader,
		TableRow,
	} from '$lib/components/ui/table';
	import {
		AlertTriangle,
		Boxes,
		Clock3,
		Code2,
		RefreshCw,
		Search,
		Server,
		Workflow,
		Activity,
	} from 'lucide-svelte';
	import ActionTestDialog from '$lib/components/workflow/config/sw-action-test-dialog.svelte';
	import {
		createActionCatalogStore,
		type ActionCatalogSnapshot,
		type ActionCatalogItem,
	} from '$lib/stores/action-catalog.svelte';

	interface Props {
		snapshot: ActionCatalogSnapshot;
	}

	let { snapshot }: Props = $props();

	const catalog = createActionCatalogStore();
	let selectedKind = $state<'all' | 'callable' | 'inspect-only' | 'activities' | 'workflows' | 'functions'>(
		'all',
	);
	let searchText = $state('');
	let detailTab = $state('overview');
	let testDialogOpen = $state(false);
	let selectedProviderFilter = $state('all');
	let selectedCategoryFilter = $state('all');

	$effect(() => {
		catalog.replaceSnapshot(snapshot);
	});

	$effect(() => {
		catalog.query = searchText;
	});

	$effect(() => {
		catalog.activeTab = selectedKind;
	});

	$effect(() => {
		catalog.selectedProvider = selectedProviderFilter;
	});

	$effect(() => {
		catalog.selectedCategory = selectedCategoryFilter;
	});

	$effect(() => {
		const visible = catalog.filteredItems;
		const current = catalog.selectedItem;
		if (!current || !visible.some((item) => item.id === current.id)) {
			if (visible.length > 0) {
				catalog.selectItem(visible[0].id);
			}
		}
	});

	$effect(() => {
		if (catalog.selectedItem) {
			void catalog.loadDetail(fetch);
		}
	});

	async function refresh() {
		await catalog.refresh(fetch);
	}

	function selectItem(item: ActionCatalogItem) {
		catalog.selectItem(item.id);
		testDialogOpen = false;
	}

	function formatTimestamp(value: string): string {
		return new Date(value).toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	}

	function statusVariant(ready: boolean | null, visibility: string): 'default' | 'destructive' | 'outline' {
		if (visibility === 'inspect-only') return 'outline';
		return ready === false ? 'destructive' : 'default';
	}

	function sourceLabel(item: ActionCatalogItem): string {
		if (item.sourceKind === 'catalog') return item.pieceName === 'code-functions' ? 'Code' : 'Catalog';
		return 'Runtime';
	}

	function formatLabel(value: string | null): string {
		return (value || '')
			.split(/[-_\s]+/)
			.filter(Boolean)
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
			.join(' ');
	}

	function providerInitial(item: ActionCatalogItem): string {
		return (item.providerLabel || item.displayName || '?').trim().charAt(0).toUpperCase();
	}

	function lineCount(code: string | null): number {
		return code ? code.split('\n').length : 0;
	}

	const serviceCards = $derived(
		catalog.services.map((service) => ({
			service,
			activityCount: service.registeredActivities.length,
			workflowCount: service.registeredWorkflows.length,
		})),
	);

	const totals = $derived({
		all: catalog.items.length,
		callable: catalog.items.filter((item) => item.visibility === 'public-callable').length,
		inspectOnly: catalog.items.filter((item) => item.visibility === 'inspect-only').length,
		services: catalog.services.length,
		ready: catalog.services.filter((service) => service.ready).length,
	});

	const selected = $derived(catalog.selectedDetail);
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div class="min-w-0">
			<h1 class="text-sm font-semibold tracking-tight">Activity Explorer</h1>
			<p class="text-[10px] text-muted-foreground">
				{totals.all} actions · {totals.callable} callable · {totals.inspectOnly} inspect-only · {totals.services} services
			</p>
		</div>
		<Button variant="outline" size="sm" onclick={refresh} disabled={catalog.loading} title="Refresh catalog and runtime overlay">
			{#if catalog.loading}
				<RefreshCw size={14} class="animate-spin" />
			{:else}
				<RefreshCw size={14} />
			{/if}
			Refresh
		</Button>
	</header>

	<div class="border-b border-border px-6 py-4">
		<div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
			<div class="relative w-full max-w-xl">
				<Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
				<Input
					placeholder="Search activities, workflows, functions, services..."
					bind:value={searchText}
					class="pl-9"
				/>
			</div>

			<div class="flex flex-wrap items-center gap-2">
				<Select.Root type="single" value={selectedProviderFilter} onValueChange={(value) => (selectedProviderFilter = value)}>
					<Select.Trigger class="h-8 min-w-[180px] text-xs">
						{selectedProviderFilter === 'all'
							? 'All providers'
							: catalog.availableProviders.find((provider) => provider.id === selectedProviderFilter)?.label || 'Provider'}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="all">All providers</Select.Item>
						{#each catalog.availableProviders as provider (provider.id)}
							<Select.Item value={provider.id}>{provider.label}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<Select.Root type="single" value={selectedCategoryFilter} onValueChange={(value) => (selectedCategoryFilter = value)}>
					<Select.Trigger class="h-8 min-w-[160px] text-xs">
						{selectedCategoryFilter === 'all' ? 'All categories' : formatLabel(selectedCategoryFilter)}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="all">All categories</Select.Item>
						{#each catalog.availableCategories as category (category)}
							<Select.Item value={category}>{formatLabel(category)}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				{#if catalog.partialErrors.length > 0}
					<Badge variant="destructive" class="gap-1 text-[10px]">
						<AlertTriangle size={10} />
						{catalog.partialErrors.length} service{catalog.partialErrors.length > 1 ? 's' : ''} degraded
					</Badge>
				{/if}
				<Badge variant="secondary" class="gap-1 text-[10px]">
					<Server size={10} />
					{totals.ready}/{totals.services} ready
				</Badge>
				<Badge variant="outline" class="gap-1 text-[10px]">
					<Clock3 size={10} />
					{formatTimestamp(catalog.timestamp)}
				</Badge>
			</div>
		</div>

		<div class="mt-4 flex flex-wrap gap-2">
			<Tabs bind:value={selectedKind}>
				<TabsList class="flex h-auto flex-wrap gap-1 bg-transparent p-0">
					<TabsTrigger value="all">All</TabsTrigger>
					<TabsTrigger value="callable">Callable</TabsTrigger>
					<TabsTrigger value="inspect-only">Inspect-only</TabsTrigger>
					<TabsTrigger value="activities">Activities</TabsTrigger>
					<TabsTrigger value="workflows">Workflows</TabsTrigger>
					<TabsTrigger value="functions">Functions</TabsTrigger>
				</TabsList>
			</Tabs>
		</div>
	</div>

	{#if catalog.error && catalog.items.length === 0}
		<div class="flex flex-1 items-center justify-center px-6">
			<Card class="max-w-xl">
				<CardHeader>
					<CardTitle class="flex items-center gap-2 text-sm">
						<AlertTriangle size={16} class="text-destructive" />
						Failed to load actions
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p class="text-xs text-muted-foreground">{catalog.error}</p>
				</CardContent>
			</Card>
		</div>
	{:else}
		<div class="grid min-h-0 flex-1 gap-4 overflow-hidden px-6 py-4 lg:grid-cols-[minmax(0,1.1fr)_420px]">
			<div class="min-h-0 overflow-auto pr-1">
				<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
					<Card class="border-dashed">
						<CardHeader class="pb-2">
							<CardTitle class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
								Live services
							</CardTitle>
						</CardHeader>
						<CardContent class="space-y-2">
							{#each serviceCards as entry (entry.service.service)}
								<div class="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
									<div class="min-w-0">
										<p class="truncate text-xs font-medium">{entry.service.service}</p>
										<p class="text-[10px] text-muted-foreground">{entry.service.runtime}</p>
									</div>
									<div class="flex items-center gap-1.5">
										<Badge variant={entry.service.ready ? 'default' : 'destructive'} class="text-[9px]">
											{entry.service.ready ? 'Ready' : 'Down'}
										</Badge>
										<Badge variant="outline" class="text-[9px]">
											{entry.activityCount} A · {entry.workflowCount} W
										</Badge>
									</div>
								</div>
							{/each}
						</CardContent>
					</Card>

					<Card class="border-dashed">
						<CardHeader class="pb-2">
							<CardTitle class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
								Cutover view
							</CardTitle>
						</CardHeader>
						<CardContent class="space-y-2 text-xs text-muted-foreground">
							<p>This explorer is wired for the future unified action-catalog API and currently composes runtime introspection with catalog data.</p>
							<div class="flex flex-wrap gap-1.5">
								<Badge variant="secondary" class="text-[9px]">SW 1.0 compatible</Badge>
								<Badge variant="secondary" class="text-[9px]">parser-driven</Badge>
								<Badge variant="secondary" class="text-[9px]">runtime overlay</Badge>
							</div>
						</CardContent>
					</Card>
				</div>

				<Separator class="my-4" />

				<div class="space-y-2">
					{#each catalog.filteredItems as item (item.id)}
						<button
							class="w-full rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent/40 {catalog.selectedItem?.id === item.id ? 'ring-1 ring-primary' : ''}"
							onclick={() => selectItem(item)}
						>
							<div class="flex items-start gap-3">
								{#if item.providerIconUrl}
									<Avatar.Root class="h-9 w-9 rounded-md border border-border bg-background">
										<Avatar.Image src={item.providerIconUrl} alt={item.providerLabel || item.displayName} class="object-contain p-1" />
										<Avatar.Fallback class="rounded-md text-[10px] font-medium">
											{providerInitial(item)}
										</Avatar.Fallback>
									</Avatar.Root>
								{:else}
									<div class="rounded-md bg-muted p-2">
										{#if item.kind === 'dapr-workflow'}
											<Workflow size={14} />
										{:else if item.kind === 'dapr-activity'}
											<Activity size={14} />
										{:else}
											<Code2 size={14} />
										{/if}
									</div>
								{/if}
								<div class="min-w-0 flex-1">
									<div class="flex flex-wrap items-center gap-1.5">
										<p class="truncate text-sm font-medium">{item.displayName}</p>
										<Badge variant={statusVariant(item.ready, item.visibility)} class="text-[9px]">
											{item.visibility}
										</Badge>
										<Badge variant="outline" class="text-[9px]">{item.kind}</Badge>
										<Badge variant="secondary" class="text-[9px]">{sourceLabel(item)}</Badge>
									</div>
									<p class="mt-1 text-[10px] text-muted-foreground">
										<span class="font-mono">{item.service}</span>
										{#if item.description}
											<span> · {item.description}</span>
										{/if}
									</p>
									<div class="mt-2 flex flex-wrap items-center gap-1.5">
										{#if item.providerLabel}
											<Badge variant="outline" class="text-[9px]">{item.providerLabel}</Badge>
										{/if}
										{#if item.category}
											<Badge variant="outline" class="text-[9px]">{formatLabel(item.category)}</Badge>
										{/if}
										{#if item.language}
											<Badge variant="outline" class="text-[9px]">{item.language}</Badge>
										{/if}
										{#if item.entrypoint}
											<Badge variant="outline" class="text-[9px]">entry {item.entrypoint}</Badge>
										{/if}
										{#if item.sourceCode}
											<Badge variant="outline" class="text-[9px]">{lineCount(item.sourceCode)} lines</Badge>
										{/if}
										{#if item.warnings.length > 0}
											<Badge variant="destructive" class="text-[9px]">{item.warnings.length} warning{item.warnings.length > 1 ? 's' : ''}</Badge>
										{/if}
									</div>
								</div>
							</div>
						</button>
					{/each}

					{#if catalog.filteredItems.length === 0}
						<Card class="border-dashed">
							<CardContent class="py-10 text-center text-xs text-muted-foreground">
								No actions match the current filters.
							</CardContent>
						</Card>
					{/if}
				</div>
			</div>

			<aside class="min-h-0 overflow-auto rounded-lg border border-border bg-muted/20">
				{#if selected}
					<div class="space-y-4 p-4">
						<div>
							<div class="flex flex-wrap items-center gap-1.5">
								<h2 class="text-sm font-semibold">{selected.displayName}</h2>
								<Badge variant={statusVariant(selected.ready, selected.visibility)} class="text-[9px]">
									{selected.visibility}
								</Badge>
								<Badge variant="outline" class="text-[9px]">{selected.kind}</Badge>
								{#if selected.insertable}
									<Badge variant="secondary" class="text-[9px]">insertable</Badge>
								{:else}
									<Badge variant="outline" class="text-[9px]">inspect only</Badge>
								{/if}
							</div>
							<p class="mt-1 text-xs text-muted-foreground">{selected.description || 'No description available.'}</p>
						</div>

						<div class="flex flex-wrap gap-1.5">
							{#if selected.providerLabel}
								<Badge variant="secondary" class="text-[9px]">{selected.providerLabel}</Badge>
							{/if}
							{#if selected.category}
								<Badge variant="outline" class="text-[9px]">{formatLabel(selected.category)}</Badge>
							{/if}
							<Badge variant="secondary" class="text-[9px]">{selected.service}</Badge>
							{#if selected.runtime}
								<Badge variant="outline" class="text-[9px]">{selected.runtime}</Badge>
							{/if}
							{#if selected.language}
								<Badge variant="outline" class="text-[9px]">{selected.language}</Badge>
							{/if}
							<Badge variant="outline" class="text-[9px]">{selected.sourceKind}</Badge>
						</div>

						{#if selected.warnings.length > 0}
							<div class="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[10px] text-amber-700 dark:text-amber-400">
								{#each selected.warnings as warning}
									<p>{warning}</p>
								{/each}
							</div>
						{/if}

						<div class="flex flex-wrap gap-2">
							<Button variant="secondary" size="sm" onclick={() => (testDialogOpen = true)}>
								Test Action
							</Button>
						</div>

						<Tabs bind:value={detailTab} class="w-full">
							<TabsList class="grid w-full grid-cols-4">
								<TabsTrigger value="overview">Overview</TabsTrigger>
								<TabsTrigger value="schema">Schema</TabsTrigger>
								<TabsTrigger value="source">Source</TabsTrigger>
								<TabsTrigger value="raw">Raw</TabsTrigger>
							</TabsList>

							<TabsContent value="overview" class="mt-4 space-y-3">
								<Card>
									<CardContent class="p-0">
										<Table>
											<TableBody>
												<TableRow>
													<TableCell class="w-32 text-[10px] text-muted-foreground">Identifier</TableCell>
													<TableCell class="font-mono text-[10px]">{selected.id}</TableCell>
												</TableRow>
												<TableRow>
													<TableCell class="text-[10px] text-muted-foreground">Piece</TableCell>
													<TableCell class="text-[10px]">{selected.pieceName}</TableCell>
												</TableRow>
												<TableRow>
													<TableCell class="text-[10px] text-muted-foreground">Action</TableCell>
													<TableCell class="text-[10px]">{selected.actionName}</TableCell>
												</TableRow>
												<TableRow>
													<TableCell class="text-[10px] text-muted-foreground">Registered</TableCell>
													<TableCell class="text-[10px]">{selected.registered ? 'Yes' : 'No'}</TableCell>
												</TableRow>
												<TableRow>
													<TableCell class="text-[10px] text-muted-foreground">Ready</TableCell>
													<TableCell class="text-[10px]">{selected.ready === null ? 'Unknown' : selected.ready ? 'Yes' : 'No'}</TableCell>
												</TableRow>
											</TableBody>
										</Table>
									</CardContent>
								</Card>

								{#if selected.functionRef}
									<Card>
										<CardHeader class="pb-2">
											<CardTitle class="text-xs">Function Ref</CardTitle>
										</CardHeader>
										<CardContent class="pt-0">
											<pre class="overflow-auto rounded-md bg-background p-3 text-[10px]">{JSON.stringify(selected.functionRef, null, 2)}</pre>
										</CardContent>
									</Card>
								{/if}
							</TabsContent>

							<TabsContent value="schema" class="mt-4 space-y-3">
								<Card>
									<CardHeader class="pb-2">
										<CardTitle class="text-xs">Inputs</CardTitle>
									</CardHeader>
									<CardContent class="pt-0">
										{#if selected.rendered?.inputSchemaHtml}
											<div class="source-highlight overflow-auto rounded-md border border-border bg-background">
												{@html selected.rendered.inputSchemaHtml}
											</div>
										{:else}
											<pre class="overflow-auto rounded-md bg-background p-3 text-[10px]">{JSON.stringify(selected.inputSchema || selected.taskConfig?.input || {}, null, 2)}</pre>
										{/if}
									</CardContent>
								</Card>
								<Card>
									<CardHeader class="pb-2">
										<CardTitle class="text-xs">Outputs</CardTitle>
									</CardHeader>
									<CardContent class="pt-0">
										{#if selected.rendered?.outputSchemaHtml}
											<div class="source-highlight overflow-auto rounded-md border border-border bg-background">
												{@html selected.rendered.outputSchemaHtml}
											</div>
										{:else}
											<pre class="overflow-auto rounded-md bg-background p-3 text-[10px]">{JSON.stringify(selected.outputSchema || {}, null, 2)}</pre>
										{/if}
									</CardContent>
								</Card>
							</TabsContent>

							<TabsContent value="source" class="mt-4 space-y-3">
								{#if selected.sourceHtml}
									<Card>
										<CardContent class="overflow-auto p-0">
											<div class="source-highlight">{@html selected.sourceHtml}</div>
										</CardContent>
									</Card>
								{:else if selected.sourceCode}
									<Card>
										<CardContent class="p-0">
											<pre class="overflow-auto p-3 text-[10px] leading-relaxed">{selected.sourceCode}</pre>
										</CardContent>
									</Card>
								{:else}
									<Card>
										<CardContent class="py-8 text-center text-[10px] text-muted-foreground">
											No source available for this item.
										</CardContent>
									</Card>
								{/if}
							</TabsContent>

							<TabsContent value="raw" class="mt-4">
								<Card>
									<CardContent class="p-0">
										{#if selected.rendered?.rawHtml}
											<div class="source-highlight overflow-auto rounded-md bg-background">
												{@html selected.rendered.rawHtml}
											</div>
										{:else}
											<pre class="overflow-auto p-3 text-[10px] leading-relaxed">{JSON.stringify(selected, null, 2)}</pre>
										{/if}
									</CardContent>
								</Card>
							</TabsContent>
						</Tabs>

						{#if selected?.definition}
							<Separator />
							<Card>
								<CardHeader class="pb-2">
									<CardTitle class="text-xs">Definition</CardTitle>
								</CardHeader>
								<CardContent class="pt-0">
									{#if selected.rendered?.definitionHtml}
										<div class="source-highlight overflow-auto rounded-md border border-border bg-background">
											{@html selected.rendered.definitionHtml}
										</div>
									{:else}
										<pre class="overflow-auto rounded-md bg-background p-3 text-[10px]">{JSON.stringify(selected.definition, null, 2)}</pre>
									{/if}
								</CardContent>
							</Card>
						{/if}
					</div>
				{:else}
					<div class="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
						<div>
							<p class="font-medium text-foreground">Select an action to inspect it.</p>
							<p class="mt-1">The detail pane shows runtime status, source, schemas, and definition metadata.</p>
						</div>
					</div>
				{/if}
			</aside>
		</div>
	{/if}
</div>

<ActionTestDialog bind:open={testDialogOpen} action={selected} onClose={() => (testDialogOpen = false)} />

<style>
	:global(.source-highlight pre) {
		margin: 0;
		padding: 0.75rem 0.875rem !important;
		font-size: 11px !important;
		line-height: 1.55 !important;
		background: transparent !important;
		overflow: auto;
	}

	:global(.source-highlight code) {
		font-size: inherit !important;
		line-height: inherit !important;
	}

	:global(.source-highlight .line) {
		min-height: 1.2rem;
	}
</style>
