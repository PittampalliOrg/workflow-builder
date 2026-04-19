<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Collapsible,
		CollapsibleContent,
		CollapsibleTrigger
	} from '$lib/components/ui/collapsible';
	import { Check, ChevronDown, ChevronRight, Copy, Package, Puzzle, Shield } from 'lucide-svelte';
	import type { AgentDetail } from '$lib/types/agents';

	interface Props {
		agent: AgentDetail;
	}
	const { agent }: Props = $props();

	const config = $derived(agent.config ?? {});
	const modelSpec = $derived((config as { modelSpec?: string }).modelSpec ?? null);
	const systemPrompt = $derived(
		String((config as { instructions?: string; systemPrompt?: string }).instructions ??
			(config as { systemPrompt?: string }).systemPrompt ?? '').trim(),
	);
	const mcpServers = $derived(
		(
			config as {
				mcpServers?: Array<{
					name?: string;
					url?: string;
					id?: string;
					server_name?: string;
					serverName?: string;
					displayName?: string;
				}>;
			}
		).mcpServers ?? [],
	);
	const builtinTools = $derived(
		(config as { builtinTools?: string[] }).builtinTools ?? [],
	);
	const skills = $derived(
		(config as { skills?: Array<{ name?: string; slug?: string; description?: string }> })
			.skills ?? [],
	);
	const toolPermissions = $derived(
		(config as { toolPermissions?: Record<string, string> }).toolPermissions ?? {},
	);

	let toolsOpen = $state(true);
	let skillsOpen = $state(true);
	let promptCopied = $state(false);

	async function copyPrompt() {
		try {
			await navigator.clipboard.writeText(systemPrompt);
			promptCopied = true;
			setTimeout(() => (promptCopied = false), 1400);
		} catch {
			/* clipboard blocked */
		}
	}
</script>

<div class="space-y-6">
	<!-- Model -->
	<section class="space-y-2">
		<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Model</h3>
		{#if modelSpec}
			<code class="inline-block rounded border bg-muted/40 px-2 py-1 text-xs font-mono">
				{modelSpec}
			</code>
		{:else}
			<p class="text-xs text-muted-foreground">No model configured.</p>
		{/if}
	</section>

	<!-- System prompt -->
	<section class="space-y-2">
		<div class="flex items-center justify-between">
			<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
				System prompt
			</h3>
			{#if systemPrompt}
				<Button variant="ghost" size="sm" class="h-6 gap-1 text-[11px]" onclick={copyPrompt}>
					{#if promptCopied}
						<Check class="size-3 text-green-500" /> Copied
					{:else}
						<Copy class="size-3" /> Copy
					{/if}
				</Button>
			{/if}
		</div>
		{#if systemPrompt}
			<pre class="max-h-[320px] overflow-y-auto whitespace-pre-wrap rounded border bg-muted/30 p-3 text-xs font-mono"><code
					>{systemPrompt}</code
				></pre>
		{:else}
			<p class="text-xs text-muted-foreground">No system prompt set.</p>
		{/if}
	</section>

	<!-- MCPs and tools -->
	<section class="space-y-2">
		<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
			MCPs and tools
		</h3>
		<div class="space-y-2">
			{#if builtinTools.length > 0}
				<Collapsible bind:open={toolsOpen}>
					<div class="rounded border bg-muted/20">
						<div class="flex items-center justify-between gap-2 px-3 py-2">
							<div class="flex min-w-0 items-center gap-2">
								<Package class="size-4 text-muted-foreground" />
								<span class="text-sm font-medium">Built-in tools</span>
								<code class="text-[10px] text-muted-foreground">agent_toolset</code>
							</div>
							<CollapsibleTrigger>
								{#snippet child({ props })}
									<Button {...props} variant="ghost" size="sm" class="h-7 gap-1 text-[11px]">
										Tool permissions
										<Badge variant="outline" class="text-[10px]">{builtinTools.length}</Badge>
										{#if toolsOpen}
											<ChevronDown class="size-3" />
										{:else}
											<ChevronRight class="size-3" />
										{/if}
									</Button>
								{/snippet}
							</CollapsibleTrigger>
						</div>
						<CollapsibleContent>
							<div class="border-t divide-y">
								{#each builtinTools as tool (tool)}
									<div class="flex items-center justify-between px-3 py-1.5 text-xs">
										<code class="text-[11px] text-foreground/90">{tool}</code>
										<Badge
											variant="outline"
											class="text-[10px] gap-1 bg-green-600/15 text-green-700 dark:text-green-400 border-transparent"
										>
											<Shield class="size-2.5" />
											{toolPermissions[tool] ?? 'Always allow'}
										</Badge>
									</div>
								{/each}
							</div>
						</CollapsibleContent>
					</div>
				</Collapsible>
			{/if}
			{#if mcpServers.length > 0}
				<div class="rounded border bg-muted/20 divide-y">
					{#each mcpServers as server, i (server.id ?? server.server_name ?? server.serverName ?? server.name ?? i)}
						{@const label =
							server.displayName ?? server.name ?? server.serverName ?? server.server_name ?? 'MCP server'}
						<div class="flex items-center gap-2 px-3 py-2 text-sm">
							<Package class="size-4 text-muted-foreground" />
							<span class="font-medium">{label}</span>
							{#if server.url}
								<code class="text-[10px] text-muted-foreground truncate flex-1">{server.url}</code>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
			{#if builtinTools.length === 0 && mcpServers.length === 0}
				<p class="text-xs text-muted-foreground">No tools configured.</p>
			{/if}
		</div>
	</section>

	<!-- Skills -->
	<section class="space-y-2">
		<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Skills</h3>
		{#if skills.length > 0}
			<Collapsible bind:open={skillsOpen}>
				<div class="rounded border bg-muted/20">
					<CollapsibleTrigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" class="h-auto w-full justify-between rounded-none px-3 py-2">
								<span class="flex items-center gap-2 text-sm font-medium">
									<Puzzle class="size-4 text-muted-foreground" />
									{skills.length} skill{skills.length === 1 ? '' : 's'}
								</span>
								{#if skillsOpen}
									<ChevronDown class="size-3" />
								{:else}
									<ChevronRight class="size-3" />
								{/if}
							</Button>
						{/snippet}
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div class="border-t divide-y">
							{#each skills as s (s.slug ?? s.name)}
								<div class="px-3 py-2 text-xs">
									<div class="font-mono text-[11px]">{s.slug ?? s.name}</div>
									{#if s.description}
										<div class="text-muted-foreground text-[11px]">{s.description}</div>
									{/if}
								</div>
							{/each}
						</div>
					</CollapsibleContent>
				</div>
			</Collapsible>
		{:else}
			<p class="text-xs text-muted-foreground">No skills configured.</p>
		{/if}
	</section>
</div>
